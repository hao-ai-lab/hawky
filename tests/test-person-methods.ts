import { afterEach, describe, expect, test } from "bun:test";
import {
  identifyCurrentFrame,
  listPeople,
  recallPerson,
  updatePersonProfile,
} from "../src/gateway/person-methods.js";
import {
  PERSON_MODEL_TOOL_NAMES,
  PERSON_RPC_METHODS,
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
    ]);
    expect(personToolForName("update_person_profile").parameters.properties).toHaveProperty("facts");
  });
});

describe("person.* gateway methods over legacy DeepFace", () => {
  let restore = () => {};

  afterEach(() => restore());

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

  test("person.update_profile writes through DeepFace compatibility endpoint", async () => {
    restore = stubDeepFaceFetch((path, body) => {
      expect(path).toBe("/update");
      expect(body).toEqual({
        person_id: "p-sarah",
        name: "Sarah Chen",
        facts: ["studies robotics"],
        recap: "Talked about mapping.",
      });
      return Response.json({
        ok: true,
        person: {
          ...RAW_PEOPLE[0],
          name: "Sarah Chen",
          facts: ["climber", "runs a coffee startup", "studies robotics"],
          recaps: [
            ...(RAW_PEOPLE[0].recaps as Array<{ summary: string; at: string }>),
            { summary: "Talked about mapping.", at: "2026-06-27T00:00:00.000Z" },
          ],
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
  });

  test("person.update_profile includes structured records only when explicitly requested", async () => {
    restore = stubDeepFaceFetch(() =>
      Response.json({
        ok: true,
        person: {
          ...RAW_PEOPLE[0],
          facts: ["climber", "studies robotics"],
        },
      }),
    );

    const result = await updatePersonProfile({
      id: "p-sarah",
      facts: ["studies robotics"],
      include_structured: true,
    });
    expect(result.person.structured?.facts.every((fact) => fact.review.state === "unreviewed")).toBe(true);
  });

  test("person.update_profile can create a named profile from a frame without creating Unknown", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    restore = stubDeepFaceFetch((path, body) => {
      calls.push({ path, body });
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
      path: "/enroll",
      body: { image_base64: "frame", name: "Mina", person_id: null },
    });
    expect(calls[1].body).toMatchObject({ person_id: "p-mina", name: "Mina" });
    expect(JSON.stringify(calls)).not.toContain("Unknown");
  });
});
