// =============================================================================
// Broker BYOK Tests — Issue #681
//
// The hosted web demo lets a visitor supply their own OpenAI key (BYOK) instead
// of relying on a shared server-side key. These tests prove that
// mintOpenAIRealtimeClientSecret:
//   - uses a well-formed byok_api_key in the upstream Authorization header,
//     overriding the gateway-configured key;
//   - ignores a malformed BYOK key and falls back to the configured key;
//   - never echoes the key back to the caller in the response payload.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mintOpenAIRealtimeClientSecret } from "../src/gateway/live-realtime-broker.js";

const GATEWAY_KEY = "sk-gateway-configured-key-aaaaaaaaaaaa";
const BYOK_KEY = "sk-byok-visitor-key-bbbbbbbbbbbbbbbbbbbb";

const FAKE_OPENAI_RESPONSE = JSON.stringify({
  client_secret: { value: "ek_test_stub" },
});

/**
 * Stub fetch for the OpenAI client-secret mint call and capture the
 * Authorization header so tests can assert which key was used. Returns the
 * captured-state object plus a restore fn.
 */
function stubMintFetch(): { captured: { authorization: string | null }; restore: () => void } {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = GATEWAY_KEY;
  const captured: { authorization: string | null } = { authorization: null };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.openai.com")) {
      const headers = new Headers(init?.headers);
      captured.authorization = headers.get("Authorization");
      return new Response(FAKE_OPENAI_RESPONSE, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  return {
    captured,
    restore: () => {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    },
  };
}

describe("broker BYOK", () => {
  let stub: ReturnType<typeof stubMintFetch>;

  beforeEach(() => {
    stub = stubMintFetch();
  });

  afterEach(() => {
    stub.restore();
  });

  test("uses a well-formed byok_api_key over the configured key", async () => {
    const res = await mintOpenAIRealtimeClientSecret({ model: "gpt-realtime-2", byok_api_key: BYOK_KEY });
    expect(res.ok).toBe(true);
    expect(stub.captured.authorization).toBe(`Bearer ${BYOK_KEY}`);
  });

  test("falls back to the configured key when no BYOK key is supplied", async () => {
    const res = await mintOpenAIRealtimeClientSecret({ model: "gpt-realtime-2" });
    expect(res.ok).toBe(true);
    expect(stub.captured.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
  });

  test("ignores a malformed BYOK key and falls back to the configured key", async () => {
    const res = await mintOpenAIRealtimeClientSecret({ model: "gpt-realtime-2", byok_api_key: "not-a-real-key" });
    expect(res.ok).toBe(true);
    expect(stub.captured.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
  });

  test("never leaks the key back to the caller in the response payload", async () => {
    const res = await mintOpenAIRealtimeClientSecret({ model: "gpt-realtime-2", byok_api_key: BYOK_KEY });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(BYOK_KEY);
    expect(serialized).not.toContain(GATEWAY_KEY);
  });
});
