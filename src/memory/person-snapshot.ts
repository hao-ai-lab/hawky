import type { EvidenceRef, ReviewState, SourceSessionRef } from "../identity/core/index.js";
import {
  personFactCanBeReadByMemoryDistill,
  personRecapCanBeReadByMemoryDistill,
  type IdentityCandidate,
  type PersonFact,
  type PersonProfile,
  type PersonRecap,
} from "../identity/person/contracts.js";
import type { PersonStore } from "../identity/person/store.js";
import type { MemoryCandidateSubject } from "./candidate.js";

export interface PersonMemorySnapshot {
  sessionKey?: string;
  people: PersonMemorySnapshotPerson[];
  candidates: PersonMemorySnapshotCandidate[];
  counts: {
    profilesScanned: number;
    factsScanned: number;
    recapsScanned: number;
    candidatesScanned: number;
  };
}

export interface PersonMemorySnapshotPerson {
  id: string;
  displayName: string;
  aliases: string[];
  confidence: number;
  reviewState: ReviewState;
  facts: PersonMemorySnapshotFact[];
  recaps: PersonMemorySnapshotRecap[];
}

export interface PersonMemorySnapshotFact {
  id: string;
  text: string;
  confidence: number;
  sensitivity: PersonFact["sensitivity"];
  sourceSession?: SourceSessionRef;
  evidenceRefs: EvidenceRef[];
}

export interface PersonMemorySnapshotRecap {
  id: string;
  summary: string;
  confidence: number;
  sourceSession?: SourceSessionRef;
  evidenceRefs: EvidenceRef[];
}

export interface PersonMemorySnapshotCandidate {
  id: string;
  label?: string;
  candidateType: IdentityCandidate["candidateType"];
  modalities: IdentityCandidate["modalities"];
  confidence: number;
  reviewState: ReviewState;
  sourceSession?: SourceSessionRef;
  evidenceRefs: EvidenceRef[];
  quarantined: true;
}

export function buildPersonMemorySnapshot(
  store: PersonStore,
  input: { sessionKey?: string } = {},
): PersonMemorySnapshot {
  const sessionKey = input.sessionKey?.trim() || undefined;
  const profiles = store.listProfiles();
  const facts = store.listFacts();
  const recaps = store.listRecaps();
  const candidates = store.listCandidates();

  const touchedPersonIds = new Set<string>();
  for (const profile of profiles) {
    if (matchesSession(profile.sourceSession, profile.evidenceRefs, sessionKey)) {
      touchedPersonIds.add(profile.id);
    }
  }
  for (const fact of facts) {
    if (matchesSession(fact.sourceSession, fact.evidenceRefs, sessionKey)) {
      touchedPersonIds.add(fact.personId);
    }
  }
  for (const recap of recaps) {
    if (matchesSession(recap.sourceSession, recap.evidenceRefs, sessionKey)) {
      touchedPersonIds.add(recap.personId);
    }
  }
  for (const candidate of candidates) {
    if (matchesSession(candidate.sourceSession, candidate.evidenceRefs, sessionKey)) {
      const promotedPersonId = stringMetadata(candidate.metadata.promotedPersonId);
      if (candidate.review.state === "confirmed" && promotedPersonId) {
        touchedPersonIds.add(promotedPersonId);
      }
    }
  }

  const factsByPerson = new Map<string, PersonMemorySnapshotFact[]>();
  for (const fact of facts) {
    if (!touchedPersonIds.has(fact.personId)) continue;
    if (!personFactCanBeReadByMemoryDistill(fact)) continue;
    const bucket = factsByPerson.get(fact.personId) ?? [];
    bucket.push({
      id: fact.id,
      text: fact.text,
      confidence: fact.confidence,
      sensitivity: fact.sensitivity,
      sourceSession: fact.sourceSession,
      evidenceRefs: fact.evidenceRefs,
    });
    factsByPerson.set(fact.personId, bucket);
  }

  const recapsByPerson = new Map<string, PersonMemorySnapshotRecap[]>();
  for (const recap of recaps) {
    if (!touchedPersonIds.has(recap.personId)) continue;
    if (!personRecapCanBeReadByMemoryDistill(recap)) continue;
    const bucket = recapsByPerson.get(recap.personId) ?? [];
    bucket.push({
      id: recap.id,
      summary: recap.summary,
      confidence: recap.confidence,
      sourceSession: recap.sourceSession,
      evidenceRefs: recap.evidenceRefs,
    });
    recapsByPerson.set(recap.personId, bucket);
  }

  const people = profiles
    .filter((profile) => touchedPersonIds.has(profile.id))
    .filter(profileCanBeReadByMemoryDistill)
    .map((profile): PersonMemorySnapshotPerson => ({
      id: profile.id,
      displayName: profile.displayName,
      aliases: profile.aliases,
      confidence: profile.confidence,
      reviewState: profile.review.state,
      facts: sortById(factsByPerson.get(profile.id) ?? []),
      recaps: sortById(recapsByPerson.get(profile.id) ?? []),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));

  const snapshotCandidates = candidates
    .filter((candidate) => matchesSession(candidate.sourceSession, candidate.evidenceRefs, sessionKey))
    .filter((candidate) => !isTerminalOrConfirmed(candidate.review.state))
    .map((candidate): PersonMemorySnapshotCandidate => ({
      id: candidate.id,
      label: candidate.label,
      candidateType: candidate.candidateType,
      modalities: candidate.modalities,
      confidence: candidate.confidence,
      reviewState: candidate.review.state,
      sourceSession: candidate.sourceSession,
      evidenceRefs: candidate.evidenceRefs,
      quarantined: true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    sessionKey,
    people,
    candidates: snapshotCandidates,
    counts: {
      profilesScanned: profiles.length,
      factsScanned: facts.length,
      recapsScanned: recaps.length,
      candidatesScanned: candidates.length,
    },
  };
}

export function formatPersonMemorySnapshotForPrompt(snapshot: PersonMemorySnapshot): string {
  if (snapshot.people.length === 0 && snapshot.candidates.length === 0) return "";

  const lines: string[] = [
    "----- BOUNDED PERSON SNAPSHOT -----",
    `Session: ${snapshot.sessionKey ?? "unknown"}`,
    "Rules:",
    "- Use confirmed people/facts below only as context.",
    "- Quarantined identity candidates are not confirmed people; do not write durable memories about who they are.",
  ];

  if (snapshot.people.length > 0) {
    lines.push("", "Confirmed people touched in this session:");
    for (const person of snapshot.people) {
      lines.push(`- ${person.displayName} (${person.id}, confidence ${person.confidence.toFixed(2)})`);
      for (const fact of person.facts.slice(0, 8)) {
        lines.push(`  - reviewed fact: ${fact.text}`);
      }
      for (const recap of person.recaps.slice(0, 3)) {
        lines.push(`  - reviewed recap: ${recap.summary}`);
      }
    }
  }

  if (snapshot.candidates.length > 0) {
    lines.push("", "Quarantined identity candidates touched in this session:");
    for (const candidate of snapshot.candidates) {
      const label = candidate.label ? ` label=${candidate.label}` : "";
      lines.push(
        `- ${candidate.id}${label} type=${candidate.candidateType} modalities=${candidate.modalities.join(",")} confidence=${candidate.confidence.toFixed(2)} review=${candidate.reviewState}`,
      );
    }
  }

  return lines.join("\n");
}

export function memoryCandidateSubjectsFromSnapshot(snapshot: PersonMemorySnapshot): MemoryCandidateSubject[] {
  const subjects: MemoryCandidateSubject[] = [];
  for (const person of snapshot.people) {
    subjects.push({ type: "confirmed_person", id: person.id, label: person.displayName });
  }
  for (const candidate of snapshot.candidates) {
    subjects.push({ type: "person_candidate", id: candidate.id, label: candidate.label });
  }
  return subjects.length > 0 ? subjects : [{ type: "unknown" }];
}

function matchesSession(
  sourceSession: SourceSessionRef | undefined,
  evidenceRefs: EvidenceRef[],
  sessionKey: string | undefined,
): boolean {
  if (!sessionKey) return true;
  const aliases = sessionKeyAliases(sessionKey);
  if (sourceSession?.sessionKey && aliases.has(sourceSession.sessionKey)) return true;
  return evidenceRefs.some((ref) =>
    (ref.sessionKey !== undefined && aliases.has(ref.sessionKey))
    || (ref.sourceSession?.sessionKey !== undefined && aliases.has(ref.sourceSession.sessionKey))
  );
}

function sessionKeyAliases(sessionKey: string): Set<string> {
  const aliases = new Set<string>();
  aliases.add(sessionKey);
  aliases.add(sessionKey.replaceAll("/", ":"));
  aliases.add(sessionKey.replaceAll(":", "/"));
  return aliases;
}

function profileCanBeReadByMemoryDistill(profile: PersonProfile): boolean {
  return profile.state === "active"
    && profile.review.state === "confirmed"
    && profile.allowedUses.profileDisplay
    && profile.allowedUses.memoryDistillRead;
}

function isTerminalOrConfirmed(state: ReviewState): boolean {
  return state === "confirmed"
    || state === "rejected"
    || state === "suppressed"
    || state === "expired"
    || state === "deleted";
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}
