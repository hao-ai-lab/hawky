import { describe, expect, test } from "bun:test";
import {
  buildIdentityCandidate,
  buildPersonFact,
  buildPersonProfile,
  buildPersonRecap,
} from "../src/identity/person/contracts.js";
import { InMemoryPersonStore } from "../src/identity/person/store.js";
import {
  buildPersonMemorySnapshot,
  formatPersonMemorySnapshotForPrompt,
  memoryCandidateSubjectsFromSnapshot,
} from "../src/memory/person-snapshot.js";

const SESSION = "realtime/person";
const OTHER_SESSION = "realtime/other";

describe("PersonMemorySnapshot", () => {
  test("includes only touched confirmed people and reviewed memory-readable facts", () => {
    const store = new InMemoryPersonStore();
    store.putProfile(buildPersonProfile({
      id: "person_kevin",
      displayName: "Kevin",
      source: "manual",
      sourceSession: { sessionKey: SESSION },
      confidence: 1,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    store.putFact(buildPersonFact({
      id: "fact_confirmed",
      personId: "person_kevin",
      text: "Kevin prefers short updates.",
      origin: "manual",
      source: "manual",
      sourceSession: { sessionKey: OTHER_SESSION },
      confidence: 0.95,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    store.putFact(buildPersonFact({
      id: "fact_unreviewed",
      personId: "person_kevin",
      text: "Kevin might like espresso.",
      origin: "memory_distill",
      source: "memory_distill",
      sourceSession: { sessionKey: SESSION },
      confidence: 0.6,
      review: { state: "unreviewed" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    store.putRecap(buildPersonRecap({
      id: "recap_confirmed",
      personId: "person_kevin",
      summary: "Kevin works on identity plumbing.",
      origin: "manual",
      source: "manual",
      sourceSession: { sessionKey: OTHER_SESSION },
      confidence: 0.9,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    store.putProfile(buildPersonProfile({
      id: "person_unrelated",
      displayName: "Unrelated",
      source: "manual",
      sourceSession: { sessionKey: OTHER_SESSION },
      confidence: 1,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));

    const snapshot = buildPersonMemorySnapshot(store, { sessionKey: SESSION });

    expect(snapshot.people.map((person) => person.id)).toEqual(["person_kevin"]);
    expect(snapshot.people[0].facts.map((fact) => fact.id)).toEqual(["fact_confirmed"]);
    expect(snapshot.people[0].recaps.map((recap) => recap.id)).toEqual(["recap_confirmed"]);
    expect(formatPersonMemorySnapshotForPrompt(snapshot)).toContain("Kevin prefers short updates");
    expect(formatPersonMemorySnapshotForPrompt(snapshot)).not.toContain("espresso");
    expect(formatPersonMemorySnapshotForPrompt(snapshot)).not.toContain("Unrelated");
  });

  test("keeps unconfirmed identity candidates quarantined and out of people", () => {
    const store = new InMemoryPersonStore();
    store.putCandidate(buildIdentityCandidate({
      id: "cand_face_unknown",
      candidateType: "unknown_face",
      modalities: ["face"],
      label: "unknown face",
      source: "face_service",
      sourceSession: { sessionKey: SESSION },
      confidence: 0.72,
      review: { state: "unreviewed" },
    }));

    const snapshot = buildPersonMemorySnapshot(store, { sessionKey: SESSION });
    const prompt = formatPersonMemorySnapshotForPrompt(snapshot);

    expect(snapshot.people).toEqual([]);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0].quarantined).toBe(true);
    expect(prompt).toContain("Quarantined identity candidates");
    expect(prompt).toContain("do not write durable memories");
    expect(memoryCandidateSubjectsFromSnapshot(snapshot)).toEqual([
      { type: "person_candidate", id: "cand_face_unknown", label: "unknown face" },
    ]);
  });

  test("matches realtime slash and colon session-key aliases", () => {
    const store = new InMemoryPersonStore();
    store.putProfile(buildPersonProfile({
      id: "person_kevin",
      displayName: "Kevin",
      source: "manual",
      sourceSession: { sessionKey: "realtime:main" },
      confidence: 1,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    store.putFact(buildPersonFact({
      id: "fact_alias",
      personId: "person_kevin",
      text: "Kevin prefers short updates.",
      origin: "manual",
      source: "manual",
      evidenceRefs: [{ type: "transcript", sessionKey: "realtime:main" }],
      confidence: 0.95,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));
    store.putCandidate(buildIdentityCandidate({
      id: "cand_face_alias",
      candidateType: "unknown_face",
      modalities: ["face"],
      label: "unknown face",
      source: "face_service",
      sourceSession: { sessionKey: "realtime:main" },
      confidence: 0.72,
      review: { state: "unreviewed" },
    }));

    const snapshot = buildPersonMemorySnapshot(store, { sessionKey: "realtime/main" });

    expect(snapshot.people.map((person) => person.id)).toEqual(["person_kevin"]);
    expect(snapshot.people[0].facts.map((fact) => fact.id)).toEqual(["fact_alias"]);
    expect(snapshot.candidates.map((candidate) => candidate.id)).toEqual(["cand_face_alias"]);
  });

  test("does not expose confirmed profiles unless memoryDistillRead is allowed", () => {
    const store = new InMemoryPersonStore();
    store.putProfile(buildPersonProfile({
      id: "person_display_only",
      displayName: "Display Only",
      source: "manual",
      sourceSession: { sessionKey: SESSION },
      confidence: 1,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: false },
    }));
    store.putFact(buildPersonFact({
      id: "fact_display_only",
      personId: "person_display_only",
      text: "Display-only person has a reviewed fact.",
      origin: "manual",
      source: "manual",
      sourceSession: { sessionKey: SESSION },
      confidence: 0.9,
      review: { state: "confirmed", reviewer: "owner" },
      allowedUses: { profileDisplay: true, memoryDistillRead: true },
    }));

    const snapshot = buildPersonMemorySnapshot(store, { sessionKey: SESSION });

    expect(snapshot.people).toEqual([]);
    expect(formatPersonMemorySnapshotForPrompt(snapshot)).toBe("");
  });
});
