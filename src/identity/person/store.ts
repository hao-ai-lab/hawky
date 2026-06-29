import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../storage/config.js";
import {
  assertIdentityCandidate,
  assertPersonFact,
  assertPersonProfile,
  assertPersonRecap,
  type IdentityCandidate,
  type PersonFact,
  type PersonProfile,
  type PersonRecap,
} from "./contracts.js";
import {
  assertPersonTombstone,
  type PersonTombstone,
} from "./tombstone.js";

const PERSON_STORE_FILE_MODE = 0o600;

export interface PersonStore {
  getProfile(id: string): PersonProfile | undefined;
  listProfiles(): PersonProfile[];
  putProfile(profile: PersonProfile): PersonProfile;

  getFact(id: string): PersonFact | undefined;
  listFacts(personId?: string): PersonFact[];
  putFact(fact: PersonFact): PersonFact;

  getRecap(id: string): PersonRecap | undefined;
  listRecaps(personId?: string): PersonRecap[];
  putRecap(recap: PersonRecap): PersonRecap;

  getCandidate(id: string): IdentityCandidate | undefined;
  listCandidates(): IdentityCandidate[];
  putCandidate(candidate: IdentityCandidate): IdentityCandidate;

  getTombstone(subjectId: string): PersonTombstone | undefined;
  listTombstones(): PersonTombstone[];
  putTombstone(tombstone: PersonTombstone): PersonTombstone;

  clear(): PersonStoreClearResult;
}

export interface PersonStoreClearResult {
  profiles: number;
  facts: number;
  recaps: number;
  candidates: number;
  tombstones: number;
}

type PersonStoreRecord =
  | PersonProfile
  | PersonFact
  | PersonRecap
  | IdentityCandidate
  | PersonTombstone;

function clonePersonStoreRecord<T extends PersonStoreRecord>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

export class InMemoryPersonStore implements PersonStore {
  private profiles = new Map<string, PersonProfile>();
  private facts = new Map<string, PersonFact>();
  private recaps = new Map<string, PersonRecap>();
  private candidates = new Map<string, IdentityCandidate>();
  private tombstones = new Map<string, PersonTombstone>();

  getProfile(id: string): PersonProfile | undefined {
    const profile = this.profiles.get(id);
    return profile ? clonePersonStoreRecord(profile) : undefined;
  }

  listProfiles(): PersonProfile[] {
    return [...this.profiles.values()].map(clonePersonStoreRecord);
  }

  putProfile(profile: PersonProfile): PersonProfile {
    assertPersonProfile(profile);
    const stored = clonePersonStoreRecord(profile);
    this.profiles.set(stored.id, stored);
    return clonePersonStoreRecord(stored);
  }

  getFact(id: string): PersonFact | undefined {
    const fact = this.facts.get(id);
    return fact ? clonePersonStoreRecord(fact) : undefined;
  }

  listFacts(personId?: string): PersonFact[] {
    const facts = [...this.facts.values()];
    const matches = personId ? facts.filter((fact) => fact.personId === personId) : facts;
    return matches.map(clonePersonStoreRecord);
  }

  putFact(fact: PersonFact): PersonFact {
    assertPersonFact(fact);
    const stored = clonePersonStoreRecord(fact);
    this.facts.set(stored.id, stored);
    return clonePersonStoreRecord(stored);
  }

  getRecap(id: string): PersonRecap | undefined {
    const recap = this.recaps.get(id);
    return recap ? clonePersonStoreRecord(recap) : undefined;
  }

  listRecaps(personId?: string): PersonRecap[] {
    const recaps = [...this.recaps.values()];
    const matches = personId ? recaps.filter((recap) => recap.personId === personId) : recaps;
    return matches.map(clonePersonStoreRecord);
  }

  putRecap(recap: PersonRecap): PersonRecap {
    assertPersonRecap(recap);
    const stored = clonePersonStoreRecord(recap);
    this.recaps.set(stored.id, stored);
    return clonePersonStoreRecord(stored);
  }

  getCandidate(id: string): IdentityCandidate | undefined {
    const candidate = this.candidates.get(id);
    return candidate ? clonePersonStoreRecord(candidate) : undefined;
  }

  listCandidates(): IdentityCandidate[] {
    return [...this.candidates.values()].map(clonePersonStoreRecord);
  }

  putCandidate(candidate: IdentityCandidate): IdentityCandidate {
    assertIdentityCandidate(candidate);
    const stored = clonePersonStoreRecord(candidate);
    this.candidates.set(stored.id, stored);
    return clonePersonStoreRecord(stored);
  }

  getTombstone(subjectId: string): PersonTombstone | undefined {
    const tombstone = this.tombstones.get(subjectId);
    return tombstone ? clonePersonStoreRecord(tombstone) : undefined;
  }

  listTombstones(): PersonTombstone[] {
    return [...this.tombstones.values()].map(clonePersonStoreRecord);
  }

  putTombstone(tombstone: PersonTombstone): PersonTombstone {
    assertPersonTombstone(tombstone);
    const stored = clonePersonStoreRecord(tombstone);
    this.tombstones.set(stored.subjectId, stored);
    return clonePersonStoreRecord(stored);
  }

  clear(): PersonStoreClearResult {
    const result = {
      profiles: this.profiles.size,
      facts: this.facts.size,
      recaps: this.recaps.size,
      candidates: this.candidates.size,
      tombstones: this.tombstones.size,
    };
    this.profiles.clear();
    this.facts.clear();
    this.recaps.clear();
    this.candidates.clear();
    this.tombstones.clear();
    return result;
  }
}

export class FilePersonStore implements PersonStore {
  constructor(private readonly dirPath: string = defaultPersonStoreDir()) {}

  getProfile(id: string): PersonProfile | undefined {
    return this.readProfiles().find((profile) => profile.id === id);
  }

  listProfiles(): PersonProfile[] {
    return this.readProfiles();
  }

  putProfile(profile: PersonProfile): PersonProfile {
    assertPersonProfile(profile);
    this.upsert("people.json", profile, (candidate) => candidate.id, assertPersonProfile);
    return profile;
  }

  getFact(id: string): PersonFact | undefined {
    return this.readFacts().find((fact) => fact.id === id);
  }

  listFacts(personId?: string): PersonFact[] {
    const facts = this.readFacts();
    return personId ? facts.filter((fact) => fact.personId === personId) : facts;
  }

  putFact(fact: PersonFact): PersonFact {
    assertPersonFact(fact);
    this.upsert("person-facts.json", fact, (candidate) => candidate.id, assertPersonFact);
    return fact;
  }

  getRecap(id: string): PersonRecap | undefined {
    return this.readRecaps().find((recap) => recap.id === id);
  }

  listRecaps(personId?: string): PersonRecap[] {
    const recaps = this.readRecaps();
    return personId ? recaps.filter((recap) => recap.personId === personId) : recaps;
  }

  putRecap(recap: PersonRecap): PersonRecap {
    assertPersonRecap(recap);
    this.upsert("person-recaps.json", recap, (candidate) => candidate.id, assertPersonRecap);
    return recap;
  }

  getCandidate(id: string): IdentityCandidate | undefined {
    return this.readCandidates().find((candidate) => candidate.id === id);
  }

  listCandidates(): IdentityCandidate[] {
    return this.readCandidates();
  }

  putCandidate(candidate: IdentityCandidate): IdentityCandidate {
    assertIdentityCandidate(candidate);
    this.upsert("person-candidates.json", candidate, (item) => item.id, assertIdentityCandidate);
    return candidate;
  }

  getTombstone(subjectId: string): PersonTombstone | undefined {
    return this.readTombstones().find((tombstone) => tombstone.subjectId === subjectId);
  }

  listTombstones(): PersonTombstone[] {
    return this.readTombstones();
  }

  putTombstone(tombstone: PersonTombstone): PersonTombstone {
    assertPersonTombstone(tombstone);
    this.upsert("person-tombstones.json", tombstone, (item) => item.subjectId, assertPersonTombstone);
    return tombstone;
  }

  clear(): PersonStoreClearResult {
    const result = {
      profiles: this.safeRecordCount("people.json", assertPersonProfile),
      facts: this.safeRecordCount("person-facts.json", assertPersonFact),
      recaps: this.safeRecordCount("person-recaps.json", assertPersonRecap),
      candidates: this.safeRecordCount("person-candidates.json", assertIdentityCandidate),
      tombstones: this.safeRecordCount("person-tombstones.json", assertPersonTombstone),
    };
    rmSync(this.dirPath, { recursive: true, force: true });
    return result;
  }

  private readProfiles(): PersonProfile[] {
    return this.readRecords("people.json", assertPersonProfile);
  }

  private readFacts(): PersonFact[] {
    return this.readRecords("person-facts.json", assertPersonFact);
  }

  private readRecaps(): PersonRecap[] {
    return this.readRecords("person-recaps.json", assertPersonRecap);
  }

  private readCandidates(): IdentityCandidate[] {
    return this.readRecords("person-candidates.json", assertIdentityCandidate);
  }

  private readTombstones(): PersonTombstone[] {
    return this.readRecords("person-tombstones.json", assertPersonTombstone);
  }

  private upsert<T>(
    fileName: string,
    record: T,
    key: (record: T) => string,
    assertRecord: (value: unknown) => asserts value is T,
  ): void {
    const records = this.readRecords(fileName, assertRecord);
    const id = key(record);
    const index = records.findIndex((candidate) => key(candidate) === id);
    if (index >= 0) {
      records[index] = record;
    } else {
      records.push(record);
    }
    this.writeRecords(fileName, records);
  }

  private readRecords<T>(
    fileName: string,
    assertRecord: (value: unknown) => asserts value is T,
  ): T[] {
    const filePath = join(this.dirPath, fileName);
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<PersonStoreRecordFile<T>>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error(`Invalid person store file at ${filePath}.`);
    }
    return parsed.records.map((record) => {
      assertRecord(record);
      return record;
    });
  }

  private safeRecordCount<T>(
    fileName: string,
    assertRecord: (value: unknown) => asserts value is T,
  ): number {
    try {
      return this.readRecords(fileName, assertRecord).length;
    } catch {
      return 0;
    }
  }

  private writeRecords<T>(fileName: string, records: T[]): void {
    mkdirSync(this.dirPath, { recursive: true });
    const filePath = join(this.dirPath, fileName);
    const file: PersonStoreRecordFile<T> = {
      version: 1,
      updatedAt: new Date().toISOString(),
      records,
    };
    atomicWriteJson(filePath, file);
  }
}

interface PersonStoreRecordFile<T> {
  version: 1;
  updatedAt: string;
  records: T[];
}

export function defaultPersonStoreDir(): string {
  return join(getConfigDir(), "state", "person-store");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: PERSON_STORE_FILE_MODE,
    });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, PERSON_STORE_FILE_MODE);
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
}
