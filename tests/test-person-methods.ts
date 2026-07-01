import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPeople,
  confirmCandidate,
  identifyCurrentFrame,
  listPeople,
  rejectCandidate,
  recallPerson,
  resetDefaultPersonServiceForTests,
  updatePersonProfile,
} from "../src/gateway/person-methods.js";
import { resetConfigDir, setConfigDir } from "../src/storage/config.js";
import {
  InMemoryPersonCandidateReviewStore,
  InMemoryPersonStore,
  PersonService,
  PERSON_MODEL_TOOL_NAMES,
  PERSON_RPC_METHODS,
  type LegacyDeepFaceProfile,
  type LegacyPersonRepository,
  personToolForName,
} from "../src/identity/person/index.js";

const RAW_PEOPLE = [
  {
    id: "p-sarah",
    name: "Sarah",
    embeddings: [[0.1, 0.2, 0.3]],
    facts: ["climber", "runs a coffee startup"],
    recaps: [{ summary: "Talked about seed round.", at: "2026-06-20T10:00:00.000Z" }],
    thumbnail: "/9j/4AAQSkZJRgABAQ==",
    created_at: "2026-06-19T10:00:00.000Z",
    last_seen_at: "2026-06-21T10:00:00.000Z",
  },
  {
    id: "p-unknown",
    name: "Unknown",
    facts: ["not promoted"],
    recaps: [{ summary: "not promoted" }],
  },
];

function stubDeepFaceFetch(
  handler: (path: string, body: Record<string, unknown>) => Response | Promise<Response>,
): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    return handler(path, body);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("person tool contract", () => {
  test("names model-facing tools and gateway RPC methods explicitly", () => {
    expect(PERSON_MODEL_TOOL_NAMES).toEqual([
      "identify_person",
      "list_people",
      "recall_person",
      "update_person_profile",
      "confirm_identity_candidate",
      "reject_identity_candidate",
    ]);
    expect(PERSON_RPC_METHODS).toEqual([
      "person.identify_current_frame",
      "person.list",
      "person.recall",
      "person.update_profile",
      "person.confirm_candidate",
      "person.reject_candidate",
      "person.clear",
    ]);
    expect(personToolForName("update_person_profile").parameters.properties).toHaveProperty("facts");
    expect(personToolForName("confirm_identity_candidate").parameters.required).toEqual(["candidate_id", "name"]);
    expect(personToolForName("confirm_identity_candidate").parameters.properties).toHaveProperty("person_id");
    expect(personToolForName("reject_identity_candidate").parameters.required).toEqual(["candidate_id"]);
  });
});

describe("person.* gateway methods over legacy DeepFace", () => {
  let restore = () => {};
  let testConfigDir: string | undefined;

  beforeEach(() => {
    testConfigDir = mkdtempSync(join(tmpdir(), "hawky-person-methods-"));
    setConfigDir(testConfigDir);
    resetDefaultPersonServiceForTests();
  });

  afterEach(() => {
    restore();
    restore = () => {};
    resetDefaultPersonServiceForTests();
    resetConfigDir();
    if (testConfigDir) {
      rmSync(testConfigDir, { recursive: true, force: true });
      testConfigDir = undefined;
    }
  });

  test("person.list returns compact people by default and filters Unknown profiles", async () => {
    restore = stubDeepFaceFetch((path) => {
      expect(path).toBe("/people");
      return Response.json({ people: RAW_PEOPLE });
    });

    const result = await listPeople();
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(result.people.map((person) => person.name)).toEqual(["Sarah"]);
    expect(result.people[0].facts).toEqual(["climber", "runs a coffee startup"]);
    expect(result.people[0].lastRecap).toBe("Talked about seed round.");
    expect(result.people[0].structured).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("0.1");
    expect(JSON.stringify(result)).not.toContain("not promoted");
  });

  test("person.list includes structured records only when explicitly requested", async () => {
    restore = stubDeepFaceFetch(() => Response.json({ people: RAW_PEOPLE }));

    const result = await listPeople({ include_structured: true });
    expect(result.available).toBe(true);
    expect(result.people[0].structured?.profile?.displayName).toBe("Sarah");
    expect(result.people[0].structured?.facts[0].origin).toBe("legacy_unverified");
  });

  test("person.list can include legacy Unknown candidates for management UIs", async () => {
    restore = stubDeepFaceFetch(() => Response.json({ people: RAW_PEOPLE }));

    const result = await listPeople({ include_candidates: true });
    expect(result.available).toBe(true);
    expect(result.people.map((person) => person.id)).toEqual(["p-sarah"]);
    expect(result.candidates?.length).toBe(1);
    expect(result.candidates?.[0]?.candidateType).toBe("unknown_face");
    expect(result.candidates?.[0]?.metadata.deepfaceProfileId).toBe("p-unknown");
    expect(result.candidates?.[0]?.legacyRefs[0]?.profileId).toBe("p-unknown");
  });

  test("person.recall finds a person by exact or partial name", async () => {
    restore = stubDeepFaceFetch(() => Response.json({ people: RAW_PEOPLE }));

    const exact = await recallPerson({ name: "Sarah" });
    expect(exact.found).toBe(true);
    if (exact.found) {
      expect(exact.person.id).toBe("p-sarah");
      expect(exact.person.structured).toBeUndefined();
    }

    const partial = await recallPerson({ name: "sar" });
    expect(partial.found).toBe(true);

    const missing = await recallPerson({ name: "Mina" });
    expect(missing).toEqual({ ok: true, found: false });
  });

  test("person.identify_current_frame returns a face identity signal for a known person", async () => {
    restore = stubDeepFaceFetch((path, body) => {
      expect(path).toBe("/identify");
      expect(body.image_base64).toBe("abc");
      return Response.json({
        ok: true,
        found: true,
        person: RAW_PEOPLE[0],
        similarity: 0.91,
      });
    });

    const result = await identifyCurrentFrame({
      image_base64: "abc",
      session_key: "realtime:session-1",
    });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.person.name).toBe("Sarah");
      expect(result.person.structured).toBeUndefined();
      expect(result.identity_signal?.subject).toEqual({ type: "person", personId: "p-sarah" });
      expect(result.identity_signal?.confidence).toBe(0.91);
      expect(result.identity_signal?.allowedUses.promoteMemory).toBe(false);
    }
  });

  test("person.identify_current_frame returns a candidate for legacy Unknown matches without promoting them", async () => {
    restore = stubDeepFaceFetch(() =>
      Response.json({
        ok: true,
        found: true,
        person: RAW_PEOPLE[1],
        similarity: 0.88,
      }),
    );

    const result = await identifyCurrentFrame({ image_base64: "abc" });
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("candidate_like_legacy_unknown");
      expect(result.candidate_id).toBe(result.candidate?.id);
      expect(result.candidate?.candidateType).toBe("unknown_face");
      expect(result.candidate?.modalities).toEqual(["face"]);
      expect(result.candidate?.confidence).toBe(0.88);
      expect(result.candidate?.allowedUses.profilePromotion).toBe(false);
      expect(result.candidate?.metadata.deepfaceProfileId).toBe("p-unknown");
      expect(result.candidate?.legacyRefs[0]?.profileId).toBe("p-unknown");
      expect(JSON.stringify(result)).not.toContain("\"person\"");
    }
  });

  test("person.update_profile syncs only the display name through the DeepFace compatibility endpoint", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    restore = stubDeepFaceFetch((path, body) => {
      calls.push({ path, body });
      if (path === "/people") {
        return Response.json({ people: RAW_PEOPLE });
      }
      expect(path).toBe("/update");
      return Response.json({
        ok: true,
        person: {
          ...RAW_PEOPLE[0],
          name: "Sarah Chen",
          facts: ["legacy should not be canonical"],
          recaps: [],
        },
      });
    });

    const result = await updatePersonProfile({
      id: "p-sarah",
      name: "Sarah Chen",
      facts: ["studies robotics"],
      recap: "Talked about mapping.",
    });
    expect(result.person.name).toBe("Sarah Chen");
    expect(result.person.facts).toContain("studies robotics");
    expect(result.person.structured).toBeUndefined();
    expect(calls).toEqual([
      { path: "/people", body: {} },
      {
        path: "/update",
        body: {
          person_id: "p-sarah",
          name: "Sarah Chen",
          facts: null,
          recap: null,
        },
      },
    ]);
  });

  test("person.update_profile includes structured records only when explicitly requested", async () => {
    restore = stubDeepFaceFetch((path) => {
      if (path === "/people") {
        return Response.json({ people: RAW_PEOPLE });
      }
      throw new Error(`unexpected DeepFace call: ${path}`);
    });

    const result = await updatePersonProfile({
      id: "p-sarah",
      facts: ["studies robotics"],
      include_structured: true,
    });
    expect(result.person.structured?.facts.every((fact) => fact.review.state === "unreviewed")).toBe(true);
  });

  test("person.update_profile writes new facts and recaps to the TypeScript person store", async () => {
    const reviewStore = new InMemoryPersonCandidateReviewStore();
    const personStore = new InMemoryPersonStore();
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      update: (input) => {
        updates.push(input);
        return {
          ...RAW_PEOPLE[0],
          name: input.name ?? "Sarah",
          facts: ["legacy should not be canonical"],
          recaps: [],
        };
      },
    }), reviewStore, {
      personStore,
      now: () => "2026-06-27T12:00:00.000Z",
    });

    const result = await updatePersonProfile({
      id: "p-sarah",
      name: "Sarah Chen",
      facts: ["studies robotics"],
      recap: "Talked about mapping.",
      session_key: "realtime:session-1",
      include_structured: true,
    }, service);

    expect(result.person.name).toBe("Sarah Chen");
    expect(result.person.facts).toContain("studies robotics");
    expect(result.person.structured?.facts.find((fact) => fact.text === "studies robotics")?.source).toBe("tool");
    expect(result.person.structured?.facts.find((fact) => fact.text === "studies robotics")?.sourceSession?.sessionKey).toBe("realtime:session-1");
    expect(result.person.structured?.recaps.map((recap) => recap.summary)).toContain("Talked about mapping.");
    expect(personStore.getProfile("p-sarah")?.displayName).toBe("Sarah Chen");
    expect(personStore.listFacts("p-sarah").map((fact) => fact.text)).toContain("studies robotics");
    expect(updates).toEqual([
      {
        personId: "p-sarah",
        name: "Sarah Chen",
      },
    ]);
  });

  test("person.clear resets the TypeScript person store, review ledger, and legacy face index", async () => {
    const reviewStore = new InMemoryPersonCandidateReviewStore();
    const personStore = new InMemoryPersonStore();
    let legacyClears = 0;
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      clear: () => {
        legacyClears += 1;
        return { removed: 2 };
      },
    }), reviewStore, {
      personStore,
      now: () => "2026-06-27T12:00:00.000Z",
    });

    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();
    await updatePersonProfile({
      id: "p-sarah",
      facts: ["studies robotics"],
      recap: "Talked about mapping.",
    }, service);
    await rejectCandidate({
      candidate_id: candidateId,
      reason: "not a person to remember",
    }, service);

    expect(personStore.listProfiles().length).toBe(1);
    expect(personStore.listFacts().length).toBeGreaterThan(0);
    expect(personStore.listCandidates().length).toBe(1);
    expect(personStore.listTombstones().length).toBe(2);
    expect(reviewStore.list().length).toBe(1);

    const result = await clearPeople({ session_key: "realtime:session-1" }, service);

    expect(result.ok).toBe(true);
    expect(result.cleared.profiles).toBe(1);
    expect(result.cleared.candidates).toBe(1);
    expect(result.cleared.tombstones).toBe(2);
    expect(result.cleared.candidate_reviews).toBe(1);
    expect(result.cleared.legacy_face_profiles).toBe(2);
    expect(result.legacy).toEqual({ ok: true, removed: 2 });
    expect(legacyClears).toBe(1);
    expect(personStore.listProfiles()).toEqual([]);
    expect(personStore.listFacts()).toEqual([]);
    expect(personStore.listRecaps()).toEqual([]);
    expect(personStore.listCandidates()).toEqual([]);
    expect(personStore.listTombstones()).toEqual([]);
    expect(reviewStore.list()).toEqual([]);
  });

  test("person.clear preserves local people when the legacy face index cannot be cleared", async () => {
    const reviewStore = new InMemoryPersonCandidateReviewStore();
    const personStore = new InMemoryPersonStore();
    let legacyClears = 0;
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      clear: () => {
        legacyClears += 1;
        return { ok: false, error: "DeepFace service HTTP 500." };
      },
    }), reviewStore, {
      personStore,
      now: () => "2026-06-27T12:00:00.000Z",
    });

    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();
    await updatePersonProfile({
      id: "p-sarah",
      facts: ["studies robotics"],
      recap: "Talked about mapping.",
    }, service);
    await rejectCandidate({
      candidate_id: candidateId,
      reason: "not a person to remember",
    }, service);

    await expect(clearPeople({ session_key: "realtime:session-1" }, service))
      .rejects.toThrow(/Legacy face index clear failed/);

    expect(legacyClears).toBe(1);
    expect(personStore.listProfiles().length).toBe(1);
    expect(personStore.listFacts().length).toBeGreaterThan(0);
    expect(personStore.listRecaps().length).toBeGreaterThan(0);
    expect(personStore.listCandidates().length).toBe(1);
    expect(personStore.getTombstone(candidateId!)?.review.state).toBe("rejected");
    expect(personStore.getTombstone("p-unknown")?.review.state).toBe("rejected");
    expect(reviewStore.list().length).toBe(1);
  });

  test("person.update_profile can create a named profile from a frame without creating Unknown", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    restore = stubDeepFaceFetch((path, body) => {
      calls.push({ path, body });
      if (path === "/identify") {
        return Response.json({ ok: true, found: false });
      }
      if (path === "/enroll") {
        return Response.json({
          ok: true,
          person: {
            id: "p-mina",
            name: "Mina",
            facts: [],
            recaps: [],
          },
        });
      }
      expect(path).toBe("/update");
      return Response.json({
        ok: true,
        person: {
          id: "p-mina",
          name: "Mina",
          facts: ["designs robots"],
          recaps: [],
        },
      });
    });

    const result = await updatePersonProfile({
      name: "Mina",
      image_base64: "frame",
      facts: ["designs robots"],
    });

    expect(result.person.id).toBe("p-mina");
    expect(calls[0]).toEqual({
      path: "/identify",
      body: { image_base64: "frame" },
    });
    expect(calls[1]).toEqual({
      path: "/enroll",
      body: { image_base64: "frame", name: "Mina", person_id: null },
    });
    expect(calls[2].body).toMatchObject({ person_id: "p-mina", name: "Mina" });
    expect(JSON.stringify(calls)).not.toContain("Unknown");
  });

  test("person.update_profile refuses to rename an unconfirmed frame-matched candidate", async () => {
    const store = new InMemoryPersonCandidateReviewStore();
    const enrolls: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      identify: {
        found: true,
        person: RAW_PEOPLE[1],
        similarity: 0.86,
      },
      enroll: (input) => {
        enrolls.push(input);
        return { id: "p-should-not-enroll", name: input.name, facts: [], recaps: [] };
      },
      update: (input) => {
        updates.push(input);
        return { ...RAW_PEOPLE[1], name: input.name ?? "Morgan" };
      },
    }), store);

    await expect(updatePersonProfile({
      name: "Morgan",
      image_base64: "frame",
    }, service)).rejects.toThrow(/unconfirmed identity candidate/);

    expect(enrolls).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("person.update_profile refuses direct writes to an unconfirmed candidate profile id", async () => {
    const store = new InMemoryPersonCandidateReviewStore();
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      update: (input) => {
        updates.push(input);
        return { ...RAW_PEOPLE[1], name: input.name ?? "Morgan" };
      },
    }), store);

    await expect(updatePersonProfile({
      id: "p-unknown",
      name: "Morgan",
    }, service)).rejects.toThrow(/unconfirmed identity candidate/);

    expect(updates).toEqual([]);
  });

  test("person.update_profile refuses to re-enroll a rejected frame-matched candidate", async () => {
    const store = new InMemoryPersonCandidateReviewStore();
    const enrolls: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      identify: {
        found: true,
        person: RAW_PEOPLE[1],
        similarity: 0.86,
      },
      enroll: (input) => {
        enrolls.push(input);
        return { id: "p-should-not-enroll", name: input.name, facts: [], recaps: [] };
      },
    }), store);
    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();

    await rejectCandidate({
      candidate_id: candidateId,
      reason: "not a person to remember",
    }, service);
    await expect(updatePersonProfile({
      name: "Morgan",
      image_base64: "frame",
    }, service)).rejects.toThrow(/rejected or suppressed identity candidate/);

    expect(enrolls).toEqual([]);
  });

  test("person.update_profile refuses direct writes to a rejected candidate profile id", async () => {
    const store = new InMemoryPersonCandidateReviewStore();
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      update: (input) => {
        updates.push(input);
        return { ...RAW_PEOPLE[1], name: input.name ?? "Morgan" };
      },
    }), store);
    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();

    await rejectCandidate({
      candidate_id: candidateId,
      reason: "not a person to remember",
    }, service);
    await expect(updatePersonProfile({
      id: "p-unknown",
      name: "Morgan",
    }, service)).rejects.toThrow(/rejected or suppressed identity candidate/);

    expect(updates).toEqual([]);
  });

  test("person.reject_candidate tombstones stale legacy ids in the TypeScript person store", async () => {
    const reviewStore = new InMemoryPersonCandidateReviewStore();
    const personStore = new InMemoryPersonStore();
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      identify: {
        found: true,
        person: RAW_PEOPLE[1],
        similarity: 0.83,
      },
      update: (input) => {
        updates.push(input);
        return { ...RAW_PEOPLE[1], name: input.name ?? "Morgan" };
      },
    }), reviewStore, {
      personStore,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();

    await rejectCandidate({
      candidate_id: candidateId,
      reason: "not a person to remember",
      session_key: "realtime:session-1",
    }, service);

    expect(personStore.getTombstone(candidateId!)?.review.state).toBe("rejected");
    expect(personStore.getTombstone("p-unknown")?.review.state).toBe("rejected");
    await expect(updatePersonProfile({
      id: "p-unknown",
      name: "Morgan",
    }, service)).rejects.toThrow(/rejected, suppressed, or deleted/);

    const afterIdentify = await identifyCurrentFrame({ image_base64: "abc" }, service);
    expect(afterIdentify.found).toBe(false);
    if (!afterIdentify.found) {
      expect(afterIdentify.reason).toBe("candidate_rejected");
      expect(afterIdentify.no_enroll).toBe(true);
    }
    expect(updates).toEqual([]);
  });

  test("person.confirm_candidate promotes a legacy Unknown candidate through the person service boundary", async () => {
    const store = new InMemoryPersonCandidateReviewStore();
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      update: (input) => {
        updates.push(input);
        return {
          ...RAW_PEOPLE[1],
          name: "Morgan",
          facts: [],
          recaps: [],
        };
      },
    }), store, { now: () => "2026-06-27T12:00:00.000Z" });

    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();

    const result = await confirmCandidate({
      candidate_id: candidateId,
      name: "Morgan",
      session_key: "realtime:session-1",
    }, service);

    expect(result.ok).toBe(true);
    expect(result.person?.id).toBe("p-unknown");
    expect(result.person?.name).toBe("Morgan");
    expect(result.candidate.review.state).toBe("confirmed");
    expect(result.candidate.allowedUses.profilePromotion).toBe(true);
    expect(updates).toEqual([
      {
        personId: "p-unknown",
        name: "Morgan",
      },
    ]);
    const stored = store.get(candidateId!);
    expect(stored?.review.state).toBe("confirmed");
    expect(stored?.promotedPersonId).toBe("p-unknown");
    expect(stored?.sourceSession?.sessionKey).toBe("realtime:session-1");
  });

  test("person.identify_current_frame resolves confirmed candidates from the TypeScript store when DeepFace stays Unknown", async () => {
    const reviewStore = new InMemoryPersonCandidateReviewStore();
    const personStore = new InMemoryPersonStore();
    const updates: Array<Record<string, unknown>> = [];
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      identify: {
        found: true,
        person: RAW_PEOPLE[1],
        similarity: 0.91,
      },
      update: (input) => {
        updates.push(input);
        return RAW_PEOPLE[1];
      },
    }), reviewStore, {
      personStore,
      now: () => "2026-06-27T12:00:00.000Z",
    });

    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();

    const confirmed = await confirmCandidate({
      candidate_id: candidateId,
      name: "Morgan",
      session_key: "realtime:session-1",
    }, service);
    expect(confirmed.person?.name).toBe("Morgan");
    expect(updates).toEqual([
      {
        personId: "p-unknown",
        name: "Morgan",
      },
    ]);

    const afterList = await listPeople({ include_candidates: true }, service);
    expect(afterList.people.map((person) => person.name).sort()).toEqual(["Morgan", "Sarah"]);
    expect(afterList.candidates).toEqual([]);

    const afterIdentify = await identifyCurrentFrame({
      image_base64: "abc",
      session_key: "realtime:session-1",
    }, service);
    expect(afterIdentify.found).toBe(true);
    if (afterIdentify.found) {
      expect(afterIdentify.person).toMatchObject({ id: "p-unknown", name: "Morgan" });
      expect(afterIdentify.identity_signal?.subject).toEqual({ type: "person", personId: "p-unknown" });
    }
  });

  test("person.reject_candidate suppresses a legacy Unknown candidate from future list and identify results", async () => {
    const store = new InMemoryPersonCandidateReviewStore();
    const service = new PersonService(fakeLegacyPersonRepository({
      people: RAW_PEOPLE,
      identify: {
        found: true,
        person: RAW_PEOPLE[1],
        similarity: 0.83,
      },
    }), store, { now: () => "2026-06-27T12:00:00.000Z" });

    const listed = await listPeople({ include_candidates: true }, service);
    const candidateId = listed.candidates?.[0]?.id;
    expect(candidateId).toBeTruthy();

    const rejected = await rejectCandidate({
      candidate_id: candidateId,
      reason: "not a person to remember",
      session_key: "realtime:session-1",
    }, service);
    expect(rejected.candidate.review.state).toBe("rejected");
    expect(store.get(candidateId!)?.review.reason).toBe("not a person to remember");

    const afterList = await listPeople({ include_candidates: true }, service);
    expect(afterList.candidates).toEqual([]);

    const afterIdentify = await identifyCurrentFrame({ image_base64: "abc" }, service);
    expect(afterIdentify.found).toBe(false);
    if (!afterIdentify.found) {
      expect(afterIdentify.reason).toBe("candidate_rejected");
      expect(afterIdentify.candidate_id).toBe(candidateId);
      expect(afterIdentify.suppressed).toBe(true);
      expect(afterIdentify.no_enroll).toBe(true);
      expect(afterIdentify.candidate).toBeUndefined();
    }
  });
});

function fakeLegacyPersonRepository(options: {
  people?: unknown[];
  identify?: { found: false } | { found: true; person: LegacyDeepFaceProfile; similarity?: number };
  update?: (input: {
    personId: string;
    name?: string | null;
  }) => Record<string, unknown>;
  enroll?: (input: {
    imageBase64: string;
    name: string;
    personId?: string | null;
  }) => Record<string, unknown>;
  clear?: () => { removed?: number } | { ok: false; error: string };
}): LegacyPersonRepository {
  return {
    async identify() {
      const identify = options.identify;
      if (!identify || !identify.found) return { ok: true, found: false };
      return {
        ok: true,
        found: true,
        person: identify.person,
        similarity: identify.similarity,
      };
    },
    async listPeople() {
      return { ok: true, people: options.people ?? [] };
    },
    async enroll(input) {
      const person = options.enroll?.(input);
      if (person) {
        return { ok: true, person: person as LegacyDeepFaceProfile };
      }
      return {
        ok: true,
        person: {
          id: "p-enrolled",
          name: input.name,
          facts: [],
          recaps: [],
        },
      };
    },
    async update(input) {
      const person = options.update?.(input) ?? {
        id: input.personId,
        name: input.name ?? "Updated",
        facts: [],
        recaps: [],
      };
      return { ok: true, person: person as LegacyDeepFaceProfile };
    },
    async clearPeople() {
      const result = options.clear?.();
      if (result && "ok" in result && result.ok === false) {
        return { ok: false, error: result.error };
      }
      return { ok: true, removed: result?.removed ?? 0 };
    },
  };
}
