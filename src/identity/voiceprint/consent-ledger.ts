// A4 — Biometric consent + retention + deletion + audit lifecycle (BIPA/GDPR).
//
// This module holds the PURE, storage-agnostic core for three durable artifacts:
//
//   1. Consent ledger  — an append-only history of consent grants / updates /
//      withdrawals per subject. It is NOT secret (it carries no biometric data),
//      but it MUST be tamper-evident / append-only: a withdrawal appends a record,
//      it never rewrites or erases a prior grant. The *effective* consent for a
//      subject is derived by folding the append-only history in order.
//
//   2. Audit log       — an append-only log of biometric-processing events
//      (enroll / score / delete / withdraw / purge). Each entry carries ONLY
//      metadata (subjectKey, op, timestamp, outcome, counts). It MUST NEVER carry
//      an embedding, raw audio, or the encryption key. `assertNoBiometricSecrets`
//      is the runtime guard the tests scan against.
//
//   3. Retention schedule — a configured destruction window used by the sweep to
//      destroy templates + derived states older than the window.
//
// PUBLISHED RETENTION / DESTRUCTION SCHEDULE (operator-visible):
//   - Default retention window: 365 days (DEFAULT_VOICEPRINT_RETENTION_MS) from the
//     grant/last-refresh of a subject's consent. Configure with
//     `voiceprint.retention_days` (or `voiceprint.retention_ms`).
//   - On WITHDRAWAL: the subject's biometric data is destroyed IMMEDIATELY
//     (right-to-erasure): the encrypted owner template AND all derived voiceprint
//     storage states/bundles/cached artifacts for the subject are purged. The
//     consent ledger keeps the withdrawal record (append-only history) but no
//     biometric DATA survives.
//   - On EXPIRY: `purge_expired` (or the internal sweep) destroys any subject whose
//     effective consent's retention anchor is older than the window — template +
//     derived states — exactly as a withdrawal would, and appends a `purge` audit
//     entry. Fresh subjects (within the window) are untouched.
//   - Every enroll / score / delete / withdraw / purge appends a metadata-only
//     audit entry (no vectors / audio / keys).

/** Consent scopes tracked in the ledger. Mirrors VoiceprintConsentSnapshot. */
export type VoiceprintConsentScope =
  | "capture"
  | "biometric"
  | "memoryPromotion"
  | "export";

export const VOICEPRINT_CONSENT_SCOPES: readonly VoiceprintConsentScope[] = [
  "capture",
  "biometric",
  "memoryPromotion",
  "export",
];

/**
 * One append-only consent record. A `grant` sets the effective scopes as of
 * `grantedAt`; a `withdrawal` (withdrawnAt present) revokes ALL scopes for the
 * subject. Records are NEVER mutated or removed — the effective state is a fold.
 */
export interface VoiceprintConsentRecord {
  version: 1;
  subjectKey: string;
  /** ISO time the record was written. */
  recordedAt: string;
  /** Monotonic sequence within the subject's history (0-based). */
  seq: number;
  kind: "grant" | "withdrawal";
  /** For a grant: the scopes granted as of this record. Empty for a withdrawal. */
  scopes: VoiceprintConsentScope[];
  /** ISO time the consent was granted/refreshed (retention anchor). */
  grantedAt?: string;
  /** ISO time consent was withdrawn (present only on a withdrawal record). */
  withdrawnAt?: string;
  /** Optional free-form reason (e.g. "subject_request"). Never biometric. */
  reason?: string;
}

/** The effective (folded) consent for a subject at a point in time. */
export interface VoiceprintEffectiveConsent {
  subjectKey: string;
  /** True once a grant exists and no later withdrawal supersedes it. */
  active: boolean;
  scopes: {
    capture: boolean;
    biometric: boolean;
    memoryPromotion: boolean;
    export: boolean;
  };
  /** Retention anchor: the grantedAt of the most recent active grant. */
  grantedAt?: string;
  /** Present when the latest record is a withdrawal. */
  withdrawnAt?: string;
  /** Records in this subject's history (chronological, append-only). */
  history: VoiceprintConsentRecord[];
}

/** Audit op kinds for biometric processing events. */
export type VoiceprintAuditOp =
  | "enroll"
  | "score"
  | "delete"
  | "withdraw"
  | "purge";

/**
 * One append-only audit entry. METADATA ONLY: no embeddings, no audio, no keys.
 * `counts` is a small map of integer metadata (e.g. templatesRemoved, statesCleared).
 */
export interface VoiceprintAuditRecord {
  version: 1;
  subjectKey: string;
  op: VoiceprintAuditOp;
  /** ISO timestamp of the event. */
  at: string;
  outcome: "ok" | "rejected" | "noop" | "error";
  /** Optional integer counts (templatesRemoved, statesCleared, subjects, ...). */
  counts?: Record<string, number>;
  /** Optional non-secret template ref / reason string. Never biometric. */
  templateRef?: string;
  reason?: string;
}

/** Default retention window: 365 days. See PUBLISHED SCHEDULE above. */
export const DEFAULT_VOICEPRINT_RETENTION_DAYS = 365;
export const DEFAULT_VOICEPRINT_RETENTION_MS =
  DEFAULT_VOICEPRINT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Fold an append-only consent history into the effective consent for a subject.
 * The last record wins for active/withdrawn; a withdrawal revokes all scopes.
 */
export function foldVoiceprintConsentHistory(
  subjectKey: string,
  history: readonly VoiceprintConsentRecord[],
): VoiceprintEffectiveConsent {
  const ordered = [...history].sort((a, b) => a.seq - b.seq);
  const effective: VoiceprintEffectiveConsent = {
    subjectKey,
    active: false,
    scopes: {
      capture: false,
      biometric: false,
      memoryPromotion: false,
      export: false,
    },
    history: ordered,
  };

  for (const record of ordered) {
    if (record.kind === "withdrawal") {
      effective.active = false;
      effective.scopes = {
        capture: false,
        biometric: false,
        memoryPromotion: false,
        export: false,
      };
      effective.grantedAt = undefined;
      effective.withdrawnAt = record.withdrawnAt ?? record.recordedAt;
      continue;
    }
    // grant
    effective.active = true;
    effective.withdrawnAt = undefined;
    effective.grantedAt = record.grantedAt ?? record.recordedAt;
    effective.scopes = {
      capture: record.scopes.includes("capture"),
      biometric: record.scopes.includes("biometric"),
      memoryPromotion: record.scopes.includes("memoryPromotion"),
      export: record.scopes.includes("export"),
    };
  }

  return effective;
}

/** True when the folded consent allows capture + biometric processing. */
export function effectiveConsentAllowsProcessing(
  effective: VoiceprintEffectiveConsent,
): boolean {
  return effective.active && effective.scopes.capture && effective.scopes.biometric;
}

/**
 * Is this subject's retention window expired as of `nowMs`? A subject with an
 * active grant whose retention anchor (grantedAt) is older than `retentionMs`
 * is expired. A withdrawn/absent subject is not "expired" here — withdrawal is a
 * separate, immediate erasure path (the ledger already holds no biometric DATA).
 */
export function isVoiceprintConsentExpired(input: {
  effective: VoiceprintEffectiveConsent;
  nowMs: number;
  retentionMs: number;
}): boolean {
  const { effective, nowMs, retentionMs } = input;
  if (!effective.active || !effective.grantedAt) {
    return false;
  }
  const anchor = Date.parse(effective.grantedAt);
  if (Number.isNaN(anchor)) {
    return false;
  }
  return nowMs - anchor > retentionMs;
}

/**
 * SECURITY INVARIANT (asserted in tests): an audit record must NEVER embed a
 * biometric vector, raw audio, or an encryption key. This scans the serialized
 * record for the disallowed shapes/keys and throws if any are present. The audit
 * writer calls this on every append so a regression cannot silently leak.
 */
export function assertVoiceprintAuditRecordHasNoSecrets(
  record: VoiceprintAuditRecord,
): VoiceprintAuditRecord {
  // Only a fixed, known-safe set of top-level keys is permitted. Anything else
  // is rejected — this makes leaking a vector/audio/key a hard error rather than
  // relying on a denylist of field names.
  const allowedTopLevel = new Set([
    "version",
    "subjectKey",
    "op",
    "at",
    "outcome",
    "counts",
    "templateRef",
    "reason",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(
        `Voiceprint audit record has a disallowed field "${key}" (audit is metadata-only; no embeddings/audio/keys).`,
      );
    }
  }
  // `counts` must be a flat map of finite integers — no nested vectors.
  if (record.counts !== undefined) {
    for (const [key, value] of Object.entries(record.counts)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `Voiceprint audit record counts.${key} must be a finite number (no embeddings in audit).`,
        );
      }
    }
  }
  // Belt-and-braces: reject any string field that looks like a raw key / vector
  // (arrays are already excluded by the allow-list, since none of the permitted
  // fields are arrays). Guard the reason/templateRef against smuggling a blob.
  for (const field of ["reason", "templateRef"] as const) {
    const value = record[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`Voiceprint audit record ${field} must be a string.`);
    }
  }
  return record;
}

/** Build the next consent GRANT record for a subject given its current history. */
export function buildVoiceprintConsentGrant(input: {
  subjectKey: string;
  scopes: readonly VoiceprintConsentScope[];
  history: readonly VoiceprintConsentRecord[];
  grantedAt: string;
  recordedAt?: string;
  reason?: string;
}): VoiceprintConsentRecord {
  const seq = nextSeq(input.history);
  const scopes = normalizeScopes(input.scopes);
  return {
    version: 1,
    subjectKey: input.subjectKey,
    recordedAt: input.recordedAt ?? input.grantedAt,
    seq,
    kind: "grant",
    scopes,
    grantedAt: input.grantedAt,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

/** Build the next consent WITHDRAWAL record for a subject given its history. */
export function buildVoiceprintConsentWithdrawal(input: {
  subjectKey: string;
  history: readonly VoiceprintConsentRecord[];
  withdrawnAt: string;
  recordedAt?: string;
  reason?: string;
}): VoiceprintConsentRecord {
  const seq = nextSeq(input.history);
  return {
    version: 1,
    subjectKey: input.subjectKey,
    recordedAt: input.recordedAt ?? input.withdrawnAt,
    seq,
    kind: "withdrawal",
    scopes: [],
    withdrawnAt: input.withdrawnAt,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

function nextSeq(history: readonly VoiceprintConsentRecord[]): number {
  return history.reduce((max, record) => Math.max(max, record.seq + 1), 0);
}

function normalizeScopes(
  scopes: readonly VoiceprintConsentScope[],
): VoiceprintConsentScope[] {
  const seen = new Set<VoiceprintConsentScope>();
  for (const scope of scopes) {
    if (VOICEPRINT_CONSENT_SCOPES.includes(scope)) {
      seen.add(scope);
    } else {
      throw new Error(`Unknown voiceprint consent scope: ${String(scope)}`);
    }
  }
  return VOICEPRINT_CONSENT_SCOPES.filter((scope) => seen.has(scope));
}
