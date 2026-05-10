// =============================================================================
// Broker Auth Tests — Issue #480
//
// Proves that POST /api/live/openai/client-secret requires a valid device token
// when the gateway is configured with DeviceAuth.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { DeviceAuth } from "../src/gateway/device-auth.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

const FAKE_OPENAI_RESPONSE = JSON.stringify({
  ok: true,
  model: "gpt-realtime-2",
  websocket_url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
  client_secret: { client_secret: { value: "ek_test_stub" } },
});

/**
 * Stub fetch for OpenAI calls only (api.openai.com).
 * Local server calls (localhost) are forwarded to the real fetch so that
 * test requests actually reach Bun.serve.
 */
function stubOpenAIFetch(): () => void {
  const realFetch = globalThis.fetch;
  // Force a dummy OpenAI key so the broker reaches the (stubbed) mint call
  // regardless of the host env. Without this the test passes only on machines
  // whose ~/.hawky/config.json has a real key and 400s in CI (issue #480 CI).
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-stub-key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.openai.com")) {
      return new Response(FAKE_OPENAI_RESPONSE, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  };
}

async function postBrokerSecret(
  port: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://localhost:${port}/api/live/openai/client-secret`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "gpt-realtime-2" }),
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("broker auth: no deviceAuth configured", () => {
  let server: GatewayServer;
  let port: number;
  let restoreFetch: () => void;

  beforeEach(() => {
    resetGatewayState();
    // No DeviceAuth passed — open mode (localhost dev)
    server = new GatewayServer();
    port = getTestPort();
    restoreFetch = stubOpenAIFetch();
    server.start(port);
  });

  afterEach(async () => {
    restoreFetch();
    await server.stop(1000);
    resetGatewayState();
  });

  test("allows request without Authorization header when no auth configured", async () => {
    const res = await postBrokerSecret(port);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("broker auth: deviceAuth configured", () => {
  let server: GatewayServer;
  let port: number;
  let deviceAuth: DeviceAuth;
  let validToken: string;
  let restoreFetch: () => void;

  beforeEach(() => {
    resetGatewayState();
    const key = randomBytes(32);
    deviceAuth = DeviceAuth.fromKey(key);
    validToken = deviceAuth.createToken("test-device");
    server = new GatewayServer(deviceAuth);
    port = getTestPort();
    restoreFetch = stubOpenAIFetch();
    server.start(port);
  });

  afterEach(async () => {
    restoreFetch();
    await server.stop(1000);
    resetGatewayState();
  });

  test("rejects request with no Authorization header → 401", async () => {
    const res = await postBrokerSecret(port);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("rejects request with invalid token → 401", async () => {
    const res = await postBrokerSecret(port, { Authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("rejects request with malformed Authorization header → 401", async () => {
    const res = await postBrokerSecret(port, { Authorization: "Basic dXNlcjpwYXNz" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("allows request with valid device token → 200", async () => {
    const res = await postBrokerSecret(port, { Authorization: `Bearer ${validToken}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
