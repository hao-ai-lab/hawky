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
  DEFAULT_VOICEPRINT_RETENTION_MS,
  foldVoiceprintConsentHistory,
  type VoiceprintAuditRecord,
  type VoiceprintConsentRecord,
  type VoiceprintEffectiveConsent,
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
 * The lifecycle bundle wired into the gateway. `enforceConsentLedger` controls
 * whether enroll/score consult the PERSISTED ledger (restrict-only). It defaults
 * to false so existing behavior is unchanged unless a caller opts in.
 */
export interface VoiceprintLifecycle {
  consentLedger: VoiceprintConsentLedgerStore;
  auditLog: VoiceprintAuditLogStore;
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
  voiceprint?: { retention_days?: number; retention_ms?: number };
}): VoiceprintLifecycle {
  const retentionMs = resolveRetentionMs(config.voiceprint);
  return {
    consentLedger: createFileVoiceprintConsentLedger(),
    auditLog: createFileVoiceprintAuditLog(),
    retentionMs,
    enforceConsentLedger: false,
  };
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
  } = {},
): VoiceprintLifecycle {
  return {
    consentLedger: createInMemoryVoiceprintConsentLedger(),
    auditLog: createInMemoryVoiceprintAuditLog(),
    retentionMs: options.retentionMs ?? DEFAULT_VOICEPRINT_RETENTION_MS,
    enforceConsentLedger: options.enforceConsentLedger ?? false,
  };
}
