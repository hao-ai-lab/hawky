// =============================================================================
// E2E Tests — Web Demo gateway methods (#681)
//
// Full end-to-end over a real Bun WebSocket connection: WS client → gateway
// method → response. Covers the two backend pieces the hosted web demo adds:
//
//   1. people.list — degrades gracefully to { available:false, people:[] } when
//      the DeepFace service isn't running (the common demo deployment), so the
//      People view renders an empty state instead of erroring.
//   2. live.openaiClientSecret — accepts a visitor's BYOK key (mint stubbed) and
//      fails cleanly when no key is available at all.
//
// The DeepFace + OpenAI upstream HTTP calls are stubbed so the test is hermetic.
//
// Run with: bun test --timeout 30000 --max-concurrency=1 ./tests/e2e-web-demo.ts
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { registerPeopleMethods } from "../src/gateway/people-methods.js";
import {
  mintOpenAIRealtimeClientSecret,
  LiveRealtimeBrokerError,
  type LiveRealtimeClientSecretParams,
} from "../src/gateway/live-realtime-broker.js";
import { MethodError } from "../src/gateway/methods.js";
import type { ResponseFrame } from "../src/gateway/protocol.js";
import { setConfigDir, resetConfigDir, resetConfig } from "../src/storage/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

const BYOK_KEY = "sk-byok-e2e-key-bbbbbbbbbbbbbbbbbbbbbb";

/**
 * Stub upstream HTTP for both the DeepFace /people endpoint (force "down") and
 * the OpenAI client-secret mint (capture the Authorization header). Local
 * Bun.serve traffic (localhost) is forwarded to the real fetch.
 */
function stubUpstream(opts: { deepfaceDown: boolean }): {
  captured: { mintAuthorization: string | null };
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  const captured: { mintAuthorization: string | null } = { mintAuthorization: null };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/people")) {
      if (opts.deepfaceDown) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ people: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("api.openai.com")) {
      captured.mintAuthorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ client_secret: { value: "ek_e2e_stub" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = realFetch; } };
}

/** Mirror of the production live.openaiClientSecret handler (agent-methods.ts). */
function registerBrokerMethod(server: GatewayServer): void {
  server.registerMethod("live.openaiClientSecret", async (_conn, params) => {
    try {
      return await mintOpenAIRealtimeClientSecret((params ?? {}) as LiveRealtimeClientSecretParams);
    } catch (err) {
      if (err instanceof LiveRealtimeBrokerError) {
        throw new MethodError("UPSTREAM_ERROR", err.message);
      }
      throw err;
    }
  });
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<ResponseFrame> {
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function connectAndHandshake(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", { version: "e2e-test", platform: "test" });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

let server: GatewayServer;
let port: number;
let stub: ReturnType<typeof stubUpstream>;
let prevKey: string | undefined;
let configDir: string;

beforeEach(() => {
  resetGatewayState();
  // Hermetic config: point at an empty temp dir AND clear the env key so the
  // broker never picks up a real OpenAI key from the developer's
  // ~/.hawky/config.json or a loaded .env. Mirrors CI (no configured key)
  // regardless of the local machine. Individual tests opt back in (env/BYOK).
  configDir = mkdtempSync(join(tmpdir(), "hawky-e2e-webdemo-"));
  setConfigDir(configDir);
  resetConfig(); // drop any previously-cached config (with a key) from a prior test
  prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  server = new GatewayServer(); // open mode (localhost) — no device auth
  port = getTestPort();
});

afterEach(async () => {
  stub?.restore();
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
  await server.stop(2000);
  resetGatewayState();
  resetConfig(); // clear the temp config from the cache before the path resets
  resetConfigDir();
  try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("E2E: web demo — people.list", () => {
  test("degrades to available:false when DeepFace is down", async () => {
    stub = stubUpstream({ deepfaceDown: true });
    registerPeopleMethods(server);
    server.start(port);

    const ws = await connectAndHandshake(port);
    const res = await sendRequest(ws, "people.list");
    ws.close();

    expect(res.ok).toBe(true);
    const payload = res.payload as { available: boolean; people: unknown[]; note?: string };
    expect(payload.available).toBe(false);
    expect(payload.people).toEqual([]);
    expect(typeof payload.note).toBe("string");
  });

  test("returns people when the service responds", async () => {
    stub = stubUpstream({ deepfaceDown: false });
    registerPeopleMethods(server);
    server.start(port);

    const ws = await connectAndHandshake(port);
    const res = await sendRequest(ws, "people.list");
    ws.close();

    expect(res.ok).toBe(true);
    const payload = res.payload as { available: boolean; people: unknown[] };
    expect(payload.available).toBe(true);
    expect(Array.isArray(payload.people)).toBe(true);
  });
});

describe("E2E: web demo — live.openaiClientSecret BYOK", () => {
  test("accepts a BYOK key and uses it upstream", async () => {
    delete process.env.OPENAI_API_KEY; // no gateway key — only BYOK should work
    stub = stubUpstream({ deepfaceDown: true });
    registerBrokerMethod(server);
    server.start(port);

    const ws = await connectAndHandshake(port);
    const res = await sendRequest(ws, "live.openaiClientSecret", {
      model: "gpt-realtime-2",
      byok_api_key: BYOK_KEY,
    });
    ws.close();

    expect(res.ok).toBe(true);
    expect((res.payload as { ok: boolean }).ok).toBe(true);
    expect(stub.captured.mintAuthorization).toBe(`Bearer ${BYOK_KEY}`);
  });

  test("fails cleanly when no key is available at all", async () => {
    delete process.env.OPENAI_API_KEY;
    stub = stubUpstream({ deepfaceDown: true });
    registerBrokerMethod(server);
    server.start(port);

    const ws = await connectAndHandshake(port);
    const res = await sendRequest(ws, "live.openaiClientSecret", { model: "gpt-realtime-2" });
    ws.close();

    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/no openai api key/i);
    // The mint call must never have been attempted without a key.
    expect(stub.captured.mintAuthorization).toBeNull();
  });
});
