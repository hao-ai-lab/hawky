import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "../storage/config.js";
import type {
  EvidenceRef,
  IsoTime,
  RecordId,
  RetentionClass,
  ReviewRecord,
  SourceSessionRef,
} from "../identity/core/index.js";

export const MEMORY_CANDIDATE_SCHEMA_VERSION = 1 as const;

export const MEMORY_CANDIDATE_SUBJECT_TYPES = [
  "owner",
  "confirmed_person",
  "person_candidate",
  "project",
  "workspace",
  "unknown",
] as const;
export type MemoryCandidateSubjectType = (typeof MEMORY_CANDIDATE_SUBJECT_TYPES)[number];

export interface MemoryCandidateSubject {
  type: MemoryCandidateSubjectType;
  id?: RecordId;
  label?: string;
}

export interface MemoryCandidateAllowedUses {
  reviewDisplay: boolean;
  memorySearch: boolean;
  contextExport: boolean;
  durableMemory: boolean;
}

export interface MemoryCandidate {
  schemaVersion: typeof MEMORY_CANDIDATE_SCHEMA_VERSION;
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  text: string;
  source: "memory_distill" | "manual" | "import" | "other";
  sourceSession?: SourceSessionRef;
  evidenceRefs: EvidenceRef[];
  subjects: MemoryCandidateSubject[];
  confidence: number;
  sensitivity: "public" | "private" | "sensitive";
  retention: RetentionClass;
  review: ReviewRecord;
  quarantineReason?: "unconfirmed_identity_candidate" | "unreviewed_identity_signal" | "policy_unavailable";
  allowedUses: MemoryCandidateAllowedUses;
  metadata: Record<string, unknown>;
}

export interface MemoryCandidateStore {
  get(id: string): MemoryCandidate | undefined;
  list(): MemoryCandidate[];
  put(candidate: MemoryCandidate): MemoryCandidate;
  clear(): number;
}

export function makeMemoryCandidateAllowedUses(
  overrides: Partial<MemoryCandidateAllowedUses> = {},
): MemoryCandidateAllowedUses {
  return {
    reviewDisplay: true,
    memorySearch: false,
    contextExport: false,
    durableMemory: false,
    ...overrides,
  };
}

export function buildMemoryCandidate(input: {
  id?: RecordId;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  text: string;
  source?: MemoryCandidate["source"];
  sourceSession?: SourceSessionRef;
  evidenceRefs?: EvidenceRef[];
  subjects?: MemoryCandidateSubject[];
  confidence?: number;
  sensitivity?: MemoryCandidate["sensitivity"];
  retention?: RetentionClass;
  review?: ReviewRecord;
  quarantineReason?: MemoryCandidate["quarantineReason"];
  allowedUses?: Partial<MemoryCandidateAllowedUses>;
  metadata?: Record<string, unknown>;
}): MemoryCandidate {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const evidenceRefs = input.evidenceRefs ?? [];
  const subjects = input.subjects ?? [{ type: "unknown" }];
  const candidate: MemoryCandidate = {
    schemaVersion: MEMORY_CANDIDATE_SCHEMA_VERSION,
    id: input.id ?? `mcand_${stableHash([
      input.source ?? "memory_distill",
      input.sourceSession?.sessionKey ?? "",
      input.text.trim().toLowerCase(),
      subjects,
    ])}`,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    text: input.text,
    source: input.source ?? "memory_distill",
    sourceSession: input.sourceSession,
    evidenceRefs,
    subjects,
    confidence: input.confidence ?? 0.5,
    sensitivity: input.sensitivity ?? "private",
    retention: input.retention ?? "durable",
    review: input.review ?? { state: "unreviewed" },
    quarantineReason: input.quarantineReason,
    allowedUses: makeMemoryCandidateAllowedUses(input.allowedUses),
    metadata: input.metadata ?? {},
  };
  assertMemoryCandidate(candidate);
  return candidate;
}

export class InMemoryMemoryCandidateStore implements MemoryCandidateStore {
  private records = new Map<string, MemoryCandidate>();

  get(id: string): MemoryCandidate | undefined {
    return this.records.get(id);
  }

  list(): MemoryCandidate[] {
    return [...this.records.values()];
  }

  put(candidate: MemoryCandidate): MemoryCandidate {
    assertMemoryCandidate(candidate);
    this.records.set(candidate.id, candidate);
    return candidate;
  }

  clear(): number {
    const count = this.records.size;
    this.records.clear();
    return count;
  }
}

export class FileMemoryCandidateStore implements MemoryCandidateStore {
  constructor(private readonly filePath: string = defaultMemoryCandidateStorePath()) {}

  get(id: string): MemoryCandidate | undefined {
    return this.list().find((candidate) => candidate.id === id);
  }

  list(): MemoryCandidate[] {
    if (!existsSync(this.filePath)) return [];
    const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<MemoryCandidateFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error(`Invalid memory candidate store at ${this.filePath}.`);
    }
    return parsed.records.map((record) => {
      assertMemoryCandidate(record);
      return record;
    });
  }

  put(candidate: MemoryCandidate): MemoryCandidate {
    assertMemoryCandidate(candidate);
    const records = this.list();
    const index = records.findIndex((item) => item.id === candidate.id);
    if (index >= 0) records[index] = candidate;
    else records.push(candidate);
    atomicWriteJson(this.filePath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      records,
    } satisfies MemoryCandidateFile);
    return candidate;
  }

  clear(): number {
    const count = this.list().length;
    try {
      unlinkSync(this.filePath);
    } catch {
      // File may not exist.
    }
    return count;
  }
}

interface MemoryCandidateFile {
  version: 1;
  updatedAt: IsoTime;
  records: MemoryCandidate[];
}

export function defaultMemoryCandidateStorePath(): string {
  return join(getConfigDir(), "state", "memory-candidates.json");
}

export function assertMemoryCandidate(value: unknown): asserts value is MemoryCandidate {
  const candidate = record(value, "MemoryCandidate");
  if (candidate.schemaVersion !== MEMORY_CANDIDATE_SCHEMA_VERSION) {
    throw new Error("MemoryCandidate schemaVersion is invalid.");
  }
  requireNonEmptyString(candidate.id, "id");
  requireNonEmptyString(candidate.createdAt, "createdAt");
  requireNonEmptyString(candidate.updatedAt, "updatedAt");
  requireNonEmptyString(candidate.text, "text");
  requireOneOf(candidate.source, ["memory_distill", "manual", "import", "other"] as const, "source");
  requireOneOf(candidate.sensitivity, ["public", "private", "sensitive"] as const, "sensitivity");
  requireConfidence(candidate.confidence, "confidence");
  validateReview(candidate.review);
  const evidenceRefs = candidate.evidenceRefs;
  const sourceSession = candidate.sourceSession;
  validateSourceSession(sourceSession);
  validateEvidenceRefs(evidenceRefs);
  if (Array.isArray(evidenceRefs) && evidenceRefs.length === 0 && sourceSession === undefined) {
    throw new Error("MemoryCandidate requires evidenceRefs or sourceSession.");
  }
  validateSubjects(candidate.subjects);
  validateAllowedUses(candidate.allowedUses);
  if (candidate.quarantineReason !== undefined) {
    requireOneOf(
      candidate.quarantineReason,
      ["unconfirmed_identity_candidate", "unreviewed_identity_signal", "policy_unavailable"] as const,
      "quarantineReason",
    );
  }
  record(candidate.metadata, "metadata");
}

function validateSubjects(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("MemoryCandidate subjects must be a non-empty array.");
  }
  for (const [index, item] of value.entries()) {
    const subject = record(item, `subjects[${index}]`);
    requireOneOf(subject.type, MEMORY_CANDIDATE_SUBJECT_TYPES, `subjects[${index}].type`);
    if (subject.id !== undefined) requireNonEmptyString(subject.id, `subjects[${index}].id`);
    if (subject.label !== undefined) requireNonEmptyString(subject.label, `subjects[${index}].label`);
  }
}

function validateAllowedUses(value: unknown): void {
  const allowedUses = record(value, "allowedUses");
  for (const key of ["reviewDisplay", "memorySearch", "contextExport", "durableMemory"] as const) {
    if (typeof allowedUses[key] !== "boolean") {
      throw new Error(`MemoryCandidate allowedUses.${key} must be boolean.`);
    }
  }
  if (allowedUses.durableMemory && !allowedUses.reviewDisplay) {
    throw new Error("MemoryCandidate durableMemory requires reviewDisplay.");
  }
}

function validateEvidenceRefs(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("MemoryCandidate evidenceRefs must be an array.");
  for (const [index, item] of value.entries()) {
    const ref = record(item, `evidenceRefs[${index}]`);
    if (!hasInspectableEvidenceRef(ref)) {
      throw new Error(`MemoryCandidate evidenceRefs[${index}] requires an inspectable source pointer.`);
    }
  }
}

function validateReview(value: unknown): void {
  const review = record(value, "review");
  requireOneOf(
    review.state,
    ["unreviewed", "confirmed", "rejected", "suppressed", "expired", "deleted"] as const,
    "review.state",
  );
}

function validateSourceSession(value: unknown): void {
  if (value === undefined) return;
  const session = record(value, "sourceSession");
  requireNonEmptyString(session.sessionKey, "sourceSession.sessionKey");
}

function hasInspectableEvidenceRef(ref: Record<string, unknown>): boolean {
  return typeof ref.id === "string"
    || typeof ref.artifactId === "string"
    || typeof ref.sessionKey === "string"
    || typeof ref.transcriptItemId === "string"
    || typeof ref.frameId === "string"
    || typeof ref.uri === "string"
    || ref.sourceSession !== undefined;
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`MemoryCandidate ${label} is required.`);
  }
}

function requireConfidence(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`MemoryCandidate ${label} must be between 0 and 1.`);
  }
}

function requireOneOf<T extends readonly string[]>(value: unknown, allowed: T, label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`MemoryCandidate ${label} is invalid.`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Non-fatal on platforms that do not support chmod.
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}
