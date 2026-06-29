// =============================================================================
// E2E: shared person RPC contract over a real gateway WebSocket
//
// Exercises the path used by iOS/web realtime clients:
//
//   WebSocket client -> GatewayServer -> person.* RPC -> PersonService
//      -> legacy DeepFace-compatible repository + candidate review store
//
// The legacy repository is in-memory so the test is hermetic: no real DeepFace
// service and no writes to the user's ~/.haoclaw state.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { registerPersonMethods } from "../src/gateway/person-methods.js";
import { registerPeopleMethods } from "../src/gateway/people-methods.js";
import type { ResponseFrame } from "../src/gateway/protocol.js";
import {
  InMemoryPersonCandidateReviewStore,
  PersonService,
  type LegacyDeepFaceProfile,
  type LegacyPersonRepository,
} from "../src/identity/person/index.js";

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

let reqId = 0;
async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<ResponseFrame> {
  const id = `person-e2e-${++reqId}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function connectAndHandshake(port: number, sessionKey: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", {
    version: "person-e2e",
    platform: "web-ios",
    sessionKey,
  });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  expect((res.payload as { methods?: string[] }).methods).toEqual(expect.arrayContaining([
    "person.identify_current_frame",
    "person.confirm_candidate",
    "person.reject_candidate",
  ]));
  return ws;
}

function okPayload<T>(frame: ResponseFrame): T {
  expect(frame.ok).toBe(true);
  return frame.payload as T;
}

class E2ELegacyPersonRepository implements LegacyPersonRepository {
  readonly updates: Array<{
    personId: string;
    name?: string | null;
  }> = [];
  readonly enrolls: Array<{
    imageBase64: string;
    name: string;
    personId?: string | null;
  }> = [];

  identifyProfileId = "p-unknown";
  private people = new Map<string, LegacyDeepFaceProfile>();

  constructor(seed: LegacyDeepFaceProfile[]) {
    for (const person of seed) {
      const id = typeof person.id === "string" ? person.id : "";
      if (id) this.people.set(id, structuredClone(person));
    }
  }

  async identify() {
    const person = this.people.get(this.identifyProfileId);
    if (!person) return { ok: true as const, found: false as const };
    return {
      ok: true as const,
      found: true as const,
      person: structuredClone(person),
      similarity: 0.91,
    };
  }

  async listPeople() {
    return {
      ok: true as const,
      people: [...this.people.values()].map((person) => structuredClone(person)),
    };
  }

  async enroll(input: { imageBase64: string; name: string; personId?: string | null }) {
    this.enrolls.push(structuredClone(input));
    const id = input.personId ?? `p-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const existing = this.people.get(id) ?? { id, name: input.name, facts: [], recaps: [] };
    const next = {
      ...existing,
      id,
      name: input.name,
    };
    this.people.set(id, next);
    return { ok: true as const, person: structuredClone(next) };
  }

  async update(input: {
    personId: string;
    name?: string | null;
  }) {
    this.updates.push(structuredClone(input));
    const existing = this.people.get(input.personId);
    if (!existing) return { ok: false as const, code: "NOT_FOUND" as const, error: "Missing legacy profile." };

    const next: LegacyDeepFaceProfile = {
      ...existing,
      name: input.name ?? existing.name,
    };
    this.people.set(input.personId, next);
    return { ok: true as const, person: structuredClone(next) };
  }
}

const SEED_PEOPLE: LegacyDeepFaceProfile[] = [
  {
    id: "p-sarah",
    name: "Sarah",
    facts: ["runs a coffee startup"],
    recaps: [{ summary: "Talked about seed round.", at: "2026-06-20T10:00:00.000Z" }],
  },
  {
    id: "p-unknown",
    name: "Unknown",
    facts: ["must not promote before review"],
    recaps: [{ summary: "must not promote before review" }],
  },
];

let server: GatewayServer;
let port: number;
let repo: E2ELegacyPersonRepository;
let reviewStore: InMemoryPersonCandidateReviewStore;
let personService: PersonService;

beforeEach(() => {
  resetGatewayState();
  server = new GatewayServer();
  port = getTestPort();
  repo = new E2ELegacyPersonRepository(SEED_PEOPLE);
  reviewStore = new InMemoryPersonCandidateReviewStore();
  personService = new PersonService(repo, reviewStore, { now: () => "2026-06-27T12:00:00.000Z" });
  registerPersonMethods(server, personService);
  registerPeopleMethods(server, personService);
  server.start(port);
});

afterEach(async () => {
  await server.stop(2000);
  resetGatewayState();
});

describe("E2E: person.* candidate review RPCs", () => {
  test("blocks frame-based profile updates for unconfirmed candidates", async () => {
    const ws = await connectAndHandshake(port, "e2e:person:update-gate");
    try {
      const update = await sendRequest(ws, "person.update_profile", {
        name: "Morgan",
        image_base64: "frame",
        session_key: "e2e:person:update-gate",
      });

      expect(update.ok).toBe(false);
      expect(update.error?.code).toBe("INVALID_REQUEST");
      expect(update.error?.message).toMatch(/unconfirmed identity candidate/);
      expect(repo.enrolls).toEqual([]);
      expect(repo.updates).toEqual([]);
    } finally {
      ws.close();
    }
  });

  test("blocks explicit profile-id updates for unconfirmed candidates", async () => {
    const ws = await connectAndHandshake(port, "e2e:person:update-id-gate");
    try {
      const update = await sendRequest(ws, "person.update_profile", {
        id: "p-unknown",
        name: "Morgan",
        session_key: "e2e:person:update-id-gate",
      });

      expect(update.ok).toBe(false);
      expect(update.error?.code).toBe("INVALID_REQUEST");
      expect(update.error?.message).toMatch(/unconfirmed identity candidate/);
      expect(repo.enrolls).toEqual([]);
      expect(repo.updates).toEqual([]);
    } finally {
      ws.close();
    }
  });

  test("promotes a legacy Unknown candidate over WebSocket, then identifies it as a named person", async () => {
    const ws = await connectAndHandshake(port, "e2e:person:confirm");
    try {
      const listed = okPayload<{ people: unknown[]; candidates?: Array<{ id: string }> }>(
        await sendRequest(ws, "person.list", { include_candidates: true }),
      );
      expect(listed.people).toHaveLength(1);
      expect(listed.candidates).toHaveLength(1);
      const candidateId = listed.candidates![0].id;

      const confirmed = okPayload<{
        candidate: { id: string; review: { state: string }; allowedUses: { profilePromotion: boolean } };
        person: { id: string; name: string };
      }>(
        await sendRequest(ws, "person.confirm_candidate", {
          candidate_id: candidateId,
          name: "Morgan",
          reason: "user said this is Morgan",
          session_key: "e2e:person:confirm",
        }),
      );

      expect(confirmed.person).toMatchObject({ id: "p-unknown", name: "Morgan" });
      expect(confirmed.candidate.review.state).toBe("confirmed");
      expect(confirmed.candidate.allowedUses.profilePromotion).toBe(true);
      expect(reviewStore.get(candidateId)?.promotedPersonId).toBe("p-unknown");
      expect(reviewStore.get(candidateId)?.sourceSession?.sessionKey).toBe("e2e:person:confirm");
      expect(repo.updates).toEqual([
        {
          personId: "p-unknown",
          name: "Morgan",
        },
      ]);

      const afterList = okPayload<{ people: Array<{ id: string; name: string }>; candidates?: unknown[] }>(
        await sendRequest(ws, "person.list", { include_candidates: true }),
      );
      expect(afterList.people.map((person) => person.name).sort()).toEqual(["Morgan", "Sarah"]);
      expect(afterList.candidates).toEqual([]);

      const identified = okPayload<{ found: boolean; person?: { id: string; name: string }; identity_signal?: { subject: unknown } }>(
        await sendRequest(ws, "person.identify_current_frame", {
          image_base64: "frame",
          session_key: "e2e:person:confirm",
        }),
      );
      expect(identified.found).toBe(true);
      expect(identified.person).toMatchObject({ id: "p-unknown", name: "Morgan" });
      expect(identified.identity_signal?.subject).toEqual({ type: "person", personId: "p-unknown" });
    } finally {
      ws.close();
    }
  });

  test("rejects a candidate over WebSocket and suppresses it after reconnect", async () => {
    const first = await connectAndHandshake(port, "e2e:person:reject-a");
    let candidateId = "";
    try {
      const listed = okPayload<{ candidates?: Array<{ id: string }> }>(
        await sendRequest(first, "person.list", { include_candidates: true }),
      );
      candidateId = listed.candidates![0].id;

      const rejected = okPayload<{ candidate: { id: string; review: { state: string; reason?: string } } }>(
        await sendRequest(first, "person.reject_candidate", {
          candidate_id: candidateId,
          reason: "not a person to remember",
          session_key: "e2e:person:reject-a",
        }),
      );
      expect(rejected.candidate.id).toBe(candidateId);
      expect(rejected.candidate.review).toMatchObject({
        state: "rejected",
        reason: "not a person to remember",
      });
    } finally {
      first.close();
    }

    const second = await connectAndHandshake(port, "e2e:person:reject-b");
    try {
      const afterList = okPayload<{ people: unknown[]; candidates?: unknown[] }>(
        await sendRequest(second, "person.list", { include_candidates: true }),
      );
      expect(afterList.people).toHaveLength(1);
      expect(afterList.candidates).toEqual([]);

      const peopleList = okPayload<{ people: Array<{ name: string }> }>(
        await sendRequest(second, "people.list"),
      );
      expect(peopleList.people.map((person) => person.name)).toEqual(["Sarah"]);

      const identified = okPayload<{
        found: boolean;
        reason?: string;
        candidate_id?: string;
        candidate?: unknown;
        suppressed?: boolean;
        no_enroll?: boolean;
      }>(
        await sendRequest(second, "person.identify_current_frame", {
          image_base64: "frame",
          session_key: "e2e:person:reject-b",
        }),
      );
      expect(identified).toMatchObject({
        found: false,
        reason: "candidate_rejected",
        candidate_id: candidateId,
        suppressed: true,
        no_enroll: true,
      });
      expect(identified.candidate).toBeUndefined();
      expect(reviewStore.get(candidateId)?.review.state).toBe("rejected");
    } finally {
      second.close();
    }
  });

  test("returns RPC errors for terminal review and unsupported cross-profile merge", async () => {
    const ws = await connectAndHandshake(port, "e2e:person:errors");
    try {
      const listed = okPayload<{ candidates?: Array<{ id: string }> }>(
        await sendRequest(ws, "person.list", { include_candidates: true }),
      );
      const candidateId = listed.candidates![0].id;

      const merge = await sendRequest(ws, "person.confirm_candidate", {
        candidate_id: candidateId,
        name: "Morgan",
        person_id: "p-sarah",
        session_key: "e2e:person:errors",
      });
      expect(merge.ok).toBe(false);
      expect(merge.error?.code).toBe("NOT_IMPLEMENTED");
      expect(repo.updates).toEqual([]);

      const reject = await sendRequest(ws, "person.reject_candidate", {
        candidate_id: candidateId,
        reason: "wrong person",
        session_key: "e2e:person:errors",
      });
      expect(reject.ok).toBe(true);

      const confirmRejected = await sendRequest(ws, "person.confirm_candidate", {
        candidate_id: candidateId,
        name: "Morgan",
        session_key: "e2e:person:errors",
      });
      expect(confirmRejected.ok).toBe(false);
      expect(confirmRejected.error?.code).toBe("INVALID_REQUEST");
      expect(confirmRejected.error?.message).toMatch(/already rejected|suppressed/i);
    } finally {
      ws.close();
    }
  });
});
