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
import { getConfigDir } from "../../storage/config.js";
import {
  assertIdentityCandidate,
  PERSON_RECORD_SCHEMA_VERSION,
  type IdentityCandidate,
} from "./contracts.js";
import type { ReviewRecord, SourceSessionRef } from "../core/index.js";

const PERSON_CANDIDATE_REVIEW_FILE_MODE = 0o600;

export interface PersonCandidateReviewRecord {
  schemaVersion: typeof PERSON_RECORD_SCHEMA_VERSION;
  candidateId: string;
  createdAt: string;
  updatedAt: string;
  candidate: IdentityCandidate;
  review: ReviewRecord;
  promotedPersonId?: string;
  sourceSession?: SourceSessionRef;
  metadata: Record<string, unknown>;
}

export interface PersonCandidateReviewStoreFile {
  version: 1;
  updatedAt: string;
  records: PersonCandidateReviewRecord[];
}

export interface PersonCandidateReviewStore {
  get(candidateId: string): PersonCandidateReviewRecord | undefined;
  list(): PersonCandidateReviewRecord[];
  put(record: PersonCandidateReviewRecord): PersonCandidateReviewRecord;
  clear(): number;
}

export class InMemoryPersonCandidateReviewStore implements PersonCandidateReviewStore {
  private records = new Map<string, PersonCandidateReviewRecord>();

  get(candidateId: string): PersonCandidateReviewRecord | undefined {
    return this.records.get(candidateId);
  }

  list(): PersonCandidateReviewRecord[] {
    return [...this.records.values()];
  }

  put(record: PersonCandidateReviewRecord): PersonCandidateReviewRecord {
    assertPersonCandidateReviewRecord(record);
    this.records.set(record.candidateId, record);
    return record;
  }

  clear(): number {
    const removed = this.records.size;
    this.records.clear();
    return removed;
  }
}

export class FilePersonCandidateReviewStore implements PersonCandidateReviewStore {
  private cache: PersonCandidateReviewStoreFile | undefined;

  constructor(private readonly filePath: string = defaultPersonCandidateReviewStorePath()) {}

  get(candidateId: string): PersonCandidateReviewRecord | undefined {
    return this.load().records.find((record) => record.candidateId === candidateId);
  }

  list(): PersonCandidateReviewRecord[] {
    return [...this.load().records];
  }

  put(record: PersonCandidateReviewRecord): PersonCandidateReviewRecord {
    assertPersonCandidateReviewRecord(record);
    const file = this.load();
    const index = file.records.findIndex((candidate) => candidate.candidateId === record.candidateId);
    if (index >= 0) {
      file.records[index] = record;
    } else {
      file.records.push(record);
    }
    this.save(file);
    return record;
  }

  clear(): number {
    const removed = this.load().records.length;
    this.save({
      version: 1,
      updatedAt: new Date().toISOString(),
      records: [],
    });
    return removed;
  }

  private load(): PersonCandidateReviewStoreFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {
        version: 1,
        updatedAt: new Date().toISOString(),
        records: [],
      };
      return this.cache;
    }

    const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<PersonCandidateReviewStoreFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error(`Invalid person candidate review store at ${this.filePath}.`);
    }
    const records = parsed.records.map((record) => {
      assertPersonCandidateReviewRecord(record);
      return record;
    });
    this.cache = {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      records,
    };
    return this.cache;
  }

  private save(file: PersonCandidateReviewStoreFile): void {
    file.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf-8",
        mode: PERSON_CANDIDATE_REVIEW_FILE_MODE,
      });
      renameSync(tmp, this.filePath);
      try {
        chmodSync(this.filePath, PERSON_CANDIDATE_REVIEW_FILE_MODE);
      } catch {
        // Non-fatal on platforms that do not support chmod.
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup after a failed atomic write.
      }
      throw error;
    }
    this.cache = file;
  }
}

export function defaultPersonCandidateReviewStorePath(): string {
  return join(getConfigDir(), "state", "person-candidates.json");
}

export function buildPersonCandidateReviewRecord(input: {
  candidate: IdentityCandidate;
  review: ReviewRecord;
  now?: string;
  existing?: PersonCandidateReviewRecord;
  promotedPersonId?: string;
  sourceSession?: SourceSessionRef;
  metadata?: Record<string, unknown>;
}): PersonCandidateReviewRecord {
  const now = input.now ?? new Date().toISOString();
  const record: PersonCandidateReviewRecord = {
    schemaVersion: PERSON_RECORD_SCHEMA_VERSION,
    candidateId: input.candidate.id,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    candidate: input.candidate,
    review: input.review,
    promotedPersonId: input.promotedPersonId,
    sourceSession: input.sourceSession,
    metadata: input.metadata ?? {},
  };
  assertPersonCandidateReviewRecord(record);
  return record;
}

export function assertPersonCandidateReviewRecord(value: unknown): asserts value is PersonCandidateReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PersonCandidateReviewRecord must be an object.");
  }
  const record = value as Partial<PersonCandidateReviewRecord>;
  if (record.schemaVersion !== PERSON_RECORD_SCHEMA_VERSION) {
    throw new Error("PersonCandidateReviewRecord schemaVersion must be 1.");
  }
  if (typeof record.candidateId !== "string" || record.candidateId.trim().length === 0) {
    throw new Error("PersonCandidateReviewRecord candidateId is required.");
  }
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) {
    throw new Error("PersonCandidateReviewRecord createdAt is required.");
  }
  if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) {
    throw new Error("PersonCandidateReviewRecord updatedAt is required.");
  }
  assertIdentityCandidate(record.candidate);
  if (!record.review || typeof record.review !== "object" || Array.isArray(record.review)) {
    throw new Error("PersonCandidateReviewRecord review is required.");
  }
  if (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) {
    throw new Error("PersonCandidateReviewRecord metadata must be an object.");
  }
}
