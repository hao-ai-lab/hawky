// =============================================================================
// people.list Tests — Issue #681
//
// The web demo's People view reads the DeepFace person DB via the people.list
// RPC (gateway/people-methods.ts → fetchPeople). These tests prove that
// fetchPeople:
//   - maps DeepFace person records to the lean wire DTO and strips embeddings;
//   - degrades gracefully (available:false, people:[]) when the service is
//     unreachable or returns a non-200, rather than throwing.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { fetchPeople } from "../src/gateway/people-methods.js";

const RAW_PEOPLE = [
  {
    id: "p1",
    name: "Jay",
    embeddings: [[0.1, 0.2, 0.3]],
    facts: ["Master's student at UCSD", "Loves rock climbing"],
    recaps: [
      { summary: "Talked about the demo.", at: "2026-06-16T19:37:53Z" },
      { summary: "Discussed the seed round.", at: "2026-06-18T10:00:00Z" },
    ],
    thumbnail: "/9j/4AAQSkZJRgABAQ==", // base64 JPEG face crop from DeepFace
    created_at: "2026-06-16T19:37:53Z",
    last_seen_at: "2026-06-20T05:51:11Z",
  },
  { id: "p2", name: "", facts: "nope", recaps: [{ at: "x" }] }, // malformed → defaulted (no thumbnail)
];

/** Stub fetch for the DeepFace /people endpoint. */
function stubDeepFaceFetch(handler: (url: string) => Response | Promise<Response>): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/people")) return handler(url);
    return realFetch(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

describe("people.list (fetchPeople)", () => {
  let restore: () => void = () => {};

  afterEach(() => restore());

  test("maps people and strips embeddings", async () => {
    restore = stubDeepFaceFetch(() =>
      new Response(JSON.stringify({ people: RAW_PEOPLE }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchPeople();
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
    expect(result.people).toHaveLength(2);

    const jay = result.people[0];
    expect(jay.name).toBe("Jay");
    expect(jay.facts).toEqual(["Master's student at UCSD", "Loves rock climbing"]);
    expect(jay.recaps).toHaveLength(2);
    expect(jay.recaps[1].summary).toBe("Discussed the seed round.");
    // The base64 face thumbnail is passed through for the People view.
    expect(jay.thumbnail).toBe("/9j/4AAQSkZJRgABAQ==");
    // Embeddings must never reach the wire DTO.
    expect((jay as Record<string, unknown>).embeddings).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("0.1");

    // Malformed record defaults: blank name → "Unknown", bad facts → [], recap
    // with no summary dropped, no thumbnail.
    const p2 = result.people[1];
    expect(p2.name).toBe("Unknown");
    expect(p2.facts).toEqual([]);
    expect(p2.recaps).toEqual([]);
    expect(p2.thumbnail).toBeUndefined();
  });

  test("degrades to available:false on a non-200 response", async () => {
    restore = stubDeepFaceFetch(() => new Response("nope", { status: 500 }));
    const result = await fetchPeople();
    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
    expect(result.people).toEqual([]);
    expect(typeof result.note).toBe("string");
  });

  test("degrades to available:false when the service is unreachable", async () => {
    restore = stubDeepFaceFetch(() => { throw new Error("ECONNREFUSED"); });
    const result = await fetchPeople();
    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
    expect(result.people).toEqual([]);
    expect(result.note).toBeDefined();
  });
});
