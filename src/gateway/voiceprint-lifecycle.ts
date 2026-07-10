// A4 — Persistent stores for the voiceprint biometric consent/audit lifecycle.
//
// These mirror the file-store pattern already used for the encrypted template and
// the derived storage snapshot (atomic temp+rename, 0600 mode). They are ADDITIVE
// and INERT by default: the default stores are in-memory no-op-on-disk, so wiring
// them changes NOTHING for existing call sites until a caller opts in by passing a
// configured (file-backed) lifecycle to `registerVoiceprintMethods`.
//
// Consent records and audit records are NOT secret (they carry no biometric data),
// but they are APPEND-ONLY / tamper-evident: the file stores only ever append, and
// the in-memory stores expose no mutate/delete of prior records.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "../storage/config.js";
import {
  assertVoiceprintAuditRecordHasNoSecrets,
  assertVoiceprintScoreTelemetryHasNoSecrets,
  aggregateVoiceprintScoreTelemetry,
  DEFAULT_VOICEPRINT_RETENTION_MS,
  foldVoiceprintConsentHistory,
  type VoiceprintAuditRecord,
  type VoiceprintConsentRecord,
  type VoiceprintEffectiveConsent,
  type VoiceprintScoreTelemetryAggregate,
  type VoiceprintScoreTelemetryRecord,
} from "../identity/voiceprint/index.js";

const LIFECYCLE_FILE_MODE = 0o600;

/**
 * Append-only consent ledger store. Reads fold into an effective consent; writes
 * only ever append a record (never mutate/remove history).
 */
export interface VoiceprintConsentLedgerStore {
  /** All records for a subject, chronological (append order). */
  history(subjectKey: string): VoiceprintConsentRecord[];
  /** Folded effective consent for a subject. */
  effective(subjectKey: string): VoiceprintEffectiveConsent;
  /** Append one record. Returns the persisted record. */
  append(record: VoiceprintConsentRecord): VoiceprintConsentRecord;
  /** Every subjectKey that has any consent history. */
  subjectKeys(): string[];
}

/** Append-only audit log store. */
export interface VoiceprintAuditLogStore {
  /** Append one metadata-only audit record. Rejects records carrying secrets. */
  append(record: VoiceprintAuditRecord): VoiceprintAuditRecord;
  /** Read the audit log (optionally filtered to one subject). */
  read(subjectKey?: string): VoiceprintAuditRecord[];
}

/**
 * A7 privacy-safe scoring-DECISION telemetry sink. Distinct from the A4 audit log:
 * it records the scalar SCORE + decision + threshold + model per scoring decision so
 * operators can watch decision drift and build a score DISTRIBUTION (the raw material
 * for A10 threshold calibration). Every record is guarded by
 * `assertVoiceprintScoreTelemetryHasNoSecrets` (no vectors/audio/keys) on write AND
 * read. The DEFAULT sink is a NO-OP/in-memory-non-persisting sink so wiring it changes
 * nothing for existing call sites (telemetry OFF by default).
 */
export interface VoiceprintScoreTelemetrySink {
  /** True when this sink actually records (the default no-op sink is false). */
  readonly enabled: boolean;
  /** Record one scoring-decision telemetry record. Rejects records carrying secrets. */
  record(record: VoiceprintScoreTelemetryRecord): void;
  /** Read recorded telemetry (optionally filtered to one opaque sessionRef). */
  read(sessionRef?: string): VoiceprintScoreTelemetryRecord[];
  /** Per-decision-class histograms + counts for the session (or all). */
  aggregate(sessionRef?: string): VoiceprintScoreTelemetryAggregate;
}

/**
 * The lifecycle bundle wired into the gateway. `enforceConsentLedger` controls
 * whether enroll/score consult the PERSISTED ledger (restrict-only). It defaults
 * to false so existing behavior is unchanged unless a caller opts in.
 */
export interface VoiceprintLifecycle {
  consentLedger: VoiceprintConsentLedgerStore;
  auditLog: VoiceprintAuditLogStore;
  /** A7 scoring-decision telemetry sink. Defaults to a no-op (OFF) sink. */
  scoreTelemetry: VoiceprintScoreTelemetrySink;
  retentionMs: number;
  /**
   * When true, enroll_owner/score_turns require the subject's PERSISTED effective
   * consent to allow capture+biometric (in addition to config/inline consent,
   * which may only further-restrict). When false (default), the ledger is passive:
   * it records/audits but does not gate.
   */
  enforceConsentLedger: boolean;
}

// ── In-memory stores (default; inert on disk) ───────────────────────────────

export function createInMemoryVoiceprintConsentLedger(
  initial: readonly VoiceprintConsentRecord[] = [],
): VoiceprintConsentLedgerStore {
  const bySubject = new Map<string, VoiceprintConsentRecord[]>();
  for (const record of initial) {
    appendTo(bySubject, record);
  }
  return {
    history(subjectKey) {
      return [...(bySubject.get(subjectKey) ?? [])];
    },
    effective(subjectKey) {
      return foldVoiceprintConsentHistory(subjectKey, bySubject.get(subjectKey) ?? []);
    },
    append(record) {
      return appendTo(bySubject, record);
    },
    subjectKeys() {
      return [...bySubject.keys()];
    },
  };
}

export function createInMemoryVoiceprintAuditLog(
  initial: readonly VoiceprintAuditRecord[] = [],
): VoiceprintAuditLogStore {
  const records: VoiceprintAuditRecord[] = [];
  for (const record of initial) {
    records.push(assertVoiceprintAuditRecordHasNoSecrets(record));
  }
  return {
    append(record) {
      const safe = assertVoiceprintAuditRecordHasNoSecrets(record);
      records.push(safe);
      return safe;
    },
    read(subjectKey) {
      const all = records.map((record) => ({ ...record }));
      return subjectKey === undefined
        ? all
        : all.filter((record) => record.subjectKey === subjectKey);
    },
  };
}

// ── A7 score-telemetry sinks ─────────────────────────────────────────────────

/**
 * DEFAULT sink: a NO-OP. `enabled` is false, `record` drops the record on the
 * floor, and reads return empty. This makes telemetry OFF by default: wiring the
 * lifecycle in changes nothing and records NOTHING until an operator opts in. It
 * STILL runs the no-secrets guard on `record` so a mis-shaped record is rejected
 * loudly even when nothing is persisted (a leak must never be silently swallowed).
 */
export function createNoopVoiceprintScoreTelemetrySink(): VoiceprintScoreTelemetrySink {
  return {
    enabled: false,
    record(record) {
      assertVoiceprintScoreTelemetryHasNoSecrets(record);
    },
    read() {
      return [];
    },
    aggregate() {
      return aggregateVoiceprintScoreTelemetry([]);
    },
  };
}

/**
 * In-memory RECORDING sink (opt-in). Retains raw records (which carry no vector)
 * and can aggregate them into per-decision-class histograms. Non-persisting.
 */
export function createInMemoryVoiceprintScoreTelemetrySink(
  initial: readonly VoiceprintScoreTelemetryRecord[] = [],
): VoiceprintScoreTelemetrySink {
  const records: VoiceprintScoreTelemetryRecord[] = [];
  for (const record of initial) {
    records.push(assertVoiceprintScoreTelemetryHasNoSecrets(record));
  }
  const filtered = (sessionRef?: string) =>
    sessionRef === undefined
      ? records.map((record) => ({ ...record }))
      : records.filter((record) => record.sessionRef === sessionRef).map((r) => ({ ...r }));
  return {
    enabled: true,
    record(record) {
      records.push(assertVoiceprintScoreTelemetryHasNoSecrets(record));
    },
    read(sessionRef) {
      return filtered(sessionRef);
    },
    aggregate(sessionRef) {
      return aggregateVoiceprintScoreTelemetry(filtered(sessionRef));
    },
  };
}

interface ScoreTelemetryFile {
  version: 1;
  records: VoiceprintScoreTelemetryRecord[];
}

export function defaultVoiceprintScoreTelemetryPath(): string {
  return join(getConfigDir(), "state", "voiceprint", "score-telemetry.json");
}

/**
 * File-backed RECORDING sink (opt-in, append-only JSONL-style). Round-trips through
 * the same atomic temp+rename 0600 writer as the audit log, and RE-VALIDATES every
 * record with the no-secrets guard on read (so a tampered file that smuggled a
 * vector is rejected, not loaded).
 */
export function createFileVoiceprintScoreTelemetrySink(
  options: { filePath?: string } = {},
): VoiceprintScoreTelemetrySink {
  const filePath = options.filePath ?? defaultVoiceprintScoreTelemetryPath();
  const readAll = (sessionRef?: string) => {
    const all = loadScoreTelemetry(filePath).records;
    return sessionRef === undefined
      ? all
      : all.filter((record) => record.sessionRef === sessionRef);
  };
  return {
    enabled: true,
    record(record) {
      const safe = assertVoiceprintScoreTelemetryHasNoSecrets(record);
      const file = loadScoreTelemetry(filePath);
      file.records.push(safe);
      writeLifecycleFile(filePath, file);
    },
    read(sessionRef) {
      return readAll(sessionRef);
    },
    aggregate(sessionRef) {
      return aggregateVoiceprintScoreTelemetry(readAll(sessionRef));
    },
  };
}

function loadScoreTelemetry(filePath: string): ScoreTelemetryFile {
  if (!existsSync(filePath)) {
    return { version: 1, records: [] };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ScoreTelemetryFile>;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error(`Invalid voiceprint score telemetry file at ${filePath}.`);
  }
  // Defense in depth: reject a tampered file that smuggled a vector/audio/key.
  for (const record of parsed.records) {
    assertVoiceprintScoreTelemetryHasNoSecrets(record);
  }
  return { version: 1, records: parsed.records };
}

function appendTo(
  bySubject: Map<string, VoiceprintConsentRecord[]>,
  record: VoiceprintConsentRecord,
): VoiceprintConsentRecord {
  const list = bySubject.get(record.subjectKey) ?? [];
  list.push(record);
  bySubject.set(record.subjectKey, list);
  return record;
}

// ── File-backed stores (opt-in; append-only JSONL) ──────────────────────────

interface ConsentLedgerFile {
  version: 1;
  records: VoiceprintConsentRecord[];
}

interface AuditLogFile {
  version: 1;
  records: VoiceprintAuditRecord[];
}

export function defaultVoiceprintConsentLedgerPath(): string {
  return join(getConfigDir(), "state", "voiceprint", "consent-ledger.json");
}

export function defaultVoiceprintAuditLogPath(): string {
  return join(getConfigDir(), "state", "voiceprint", "audit-log.json");
}

export function createFileVoiceprintConsentLedger(
  options: { filePath?: string } = {},
): VoiceprintConsentLedgerStore {
  const filePath = options.filePath ?? defaultVoiceprintConsentLedgerPath();
  return {
    history(subjectKey) {
      return loadConsentLedger(filePath).records.filter(
        (record) => record.subjectKey === subjectKey,
      );
    },
    effective(subjectKey) {
      return foldVoiceprintConsentHistory(
        subjectKey,
        loadConsentLedger(filePath).records.filter(
          (record) => record.subjectKey === subjectKey,
        ),
      );
    },
    append(record) {
      const file = loadConsentLedger(filePath);
      // Append-only: never rewrite an existing record.
      file.records.push(record);
      writeLifecycleFile(filePath, file);
      return record;
    },
    subjectKeys() {
      return [
        ...new Set(loadConsentLedger(filePath).records.map((record) => record.subjectKey)),
      ];
    },
  };
}

export function createFileVoiceprintAuditLog(
  options: { filePath?: string } = {},
): VoiceprintAuditLogStore {
  const filePath = options.filePath ?? defaultVoiceprintAuditLogPath();
  return {
    append(record) {
      const safe = assertVoiceprintAuditRecordHasNoSecrets(record);
      const file = loadAuditLog(filePath);
      file.records.push(safe);
      writeLifecycleFile(filePath, file);
      return safe;
    },
    read(subjectKey) {
      const all = loadAuditLog(filePath).records;
      return subjectKey === undefined
        ? all
        : all.filter((record) => record.subjectKey === subjectKey);
    },
  };
}

function loadConsentLedger(filePath: string): ConsentLedgerFile {
  if (!existsSync(filePath)) {
    return { version: 1, records: [] };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ConsentLedgerFile>;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error(`Invalid voiceprint consent ledger file at ${filePath}.`);
  }
  return { version: 1, records: parsed.records };
}

function loadAuditLog(filePath: string): AuditLogFile {
  if (!existsSync(filePath)) {
    return { version: 1, records: [] };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AuditLogFile>;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error(`Invalid voiceprint audit log file at ${filePath}.`);
  }
  // Defense in depth: reject a tampered file that smuggled a secret into audit.
  for (const record of parsed.records) {
    assertVoiceprintAuditRecordHasNoSecrets(record);
  }
  return { version: 1, records: parsed.records };
}

function writeLifecycleFile(filePath: string, file: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: LIFECYCLE_FILE_MODE,
    });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, LIFECYCLE_FILE_MODE);
    } catch {
      // Non-fatal on platforms without chmod.
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup after a failed atomic write.
    }
    throw error;
  }
}

// ── Lifecycle assembly ──────────────────────────────────────────────────────

/**
 * Resolve the durable, file-backed lifecycle for the gateway. Consent + audit are
 * persisted under the config root (mirroring the encrypted-template file pattern),
 * but the ledger is NON-ENFORCING (`enforceConsentLedger: false`) so wiring this in
 * production changes NOTHING for existing enroll/score call sites — it only records
 * and audits. Enforcement + the retention window can be tuned via config in a
 * follow-up without touching this default's (safe) posture.
 *
 * PUBLISHED RETENTION / DESTRUCTION SCHEDULE: see the header of
 * `identity/voiceprint/consent-ledger.ts`. Default window = 365 days.
 */
export function resolveVoiceprintLifecycleFromConfig(config: {
  voiceprint?: {
    retention_days?: number;
    retention_ms?: number;
    telemetry?: { enabled?: boolean; sink_path?: string };
  };
}): VoiceprintLifecycle {
  const retentionMs = resolveRetentionMs(config.voiceprint);
  return {
    consentLedger: createFileVoiceprintConsentLedger(),
    auditLog: createFileVoiceprintAuditLog(),
    // A7 telemetry: OFF by default. Only an explicit `telemetry.enabled: true`
    // activates a recording sink (file-backed under the config root); otherwise the
    // no-op sink records nothing, leaving scoring behavior unchanged.
    scoreTelemetry: resolveVoiceprintScoreTelemetrySinkFromConfig(config.voiceprint?.telemetry),
    retentionMs,
    enforceConsentLedger: false,
  };
}

/**
 * Resolve the A7 telemetry sink from config. DEFAULT (unconfigured or
 * `enabled !== true`) is the NO-OP sink: telemetry is inert. When enabled, a
 * file-backed sink is used (at `sink_path` if set, else the default path under the
 * config root).
 */
export function resolveVoiceprintScoreTelemetrySinkFromConfig(
  telemetry: { enabled?: boolean; sink_path?: string } | undefined,
): VoiceprintScoreTelemetrySink {
  if (telemetry?.enabled !== true) {
    return createNoopVoiceprintScoreTelemetrySink();
  }
  return createFileVoiceprintScoreTelemetrySink(
    telemetry.sink_path ? { filePath: telemetry.sink_path } : {},
  );
}

function resolveRetentionMs(
  voiceprint: { retention_days?: number; retention_ms?: number } | undefined,
): number {
  const ms = voiceprint?.retention_ms;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    return ms;
  }
  const days = voiceprint?.retention_days;
  if (typeof days === "number" && Number.isFinite(days) && days > 0) {
    return days * 24 * 60 * 60 * 1000;
  }
  return DEFAULT_VOICEPRINT_RETENTION_MS;
}

/**
 * Default lifecycle: in-memory stores, ledger NOT enforced. Passing this (or
 * omitting a lifecycle entirely) leaves enroll/score behavior unchanged.
 */
export function createInMemoryVoiceprintLifecycle(
  options: {
    retentionMs?: number;
    enforceConsentLedger?: boolean;
    /**
     * A7 telemetry sink override. Defaults to the NO-OP sink so telemetry is OFF
     * by default (scoring works unchanged and NOTHING is recorded). Pass
     * `createInMemoryVoiceprintScoreTelemetrySink()` to opt into recording.
     */
    scoreTelemetry?: VoiceprintScoreTelemetrySink;
  } = {},
): VoiceprintLifecycle {
  return {
    consentLedger: createInMemoryVoiceprintConsentLedger(),
    auditLog: createInMemoryVoiceprintAuditLog(),
    scoreTelemetry: options.scoreTelemetry ?? createNoopVoiceprintScoreTelemetrySink(),
    retentionMs: options.retentionMs ?? DEFAULT_VOICEPRINT_RETENTION_MS,
    enforceConsentLedger: options.enforceConsentLedger ?? false,
  };
}
