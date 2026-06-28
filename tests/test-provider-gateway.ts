import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { mintOpenAIRealtimeClientSecret, resetRealtimeMintQuotaForTests } from "../src/gateway/live-realtime-broker.js";
import { resetConfig, resetConfigDir, setConfigDir } from "../src/storage/config.js";

const TOKEN = "internal-provider-token-test";
const OPENAI_KEY = "sk-control-openai-key-aaaaaaaaaaaa";
const ANTHROPIC_KEY = "sk-ant-control-key";

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function clearProviderEnv(): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.HAWKY_PROVIDER_GATEWAY_URL;
  delete process.env.HAWKY_PROVIDER_GATEWAY_TOKEN;
  delete process.env.HAWKY_ANTHROPIC_BASE_URL;
  delete process.env.HAWKY_API_BASE_URL;
  delete process.env.HAWKY_PROVIDER_BUDGET_STORE;
  delete process.env.HAWKY_PROVIDER_DAILY_UNITS;
  delete process.env.HAWKY_PROVIDER_CANARY_UNITS;
  resetConfig();
  resetRealtimeMintQuotaForTests();
}

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hawky-provider-gateway-"));
  setConfigDir(dir);
  resetConfig();
  return dir;
}

describe("provider gateway broker forwarding", () => {
  let realFetch: typeof fetch;
  let configDir: string;

  beforeEach(() => {
    clearProviderEnv();
    configDir = tempConfigDir();
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearProviderEnv();
    resetConfigDir();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("forwards OpenAI Realtime minting to the provider gateway when no local key exists", async () => {
    process.env.HAWKY_PROVIDER_GATEWAY_URL = "http://control.local";
    process.env.HAWKY_PROVIDER_GATEWAY_TOKEN = TOKEN;

    const captured: { url?: string; authorization?: string | null; body?: unknown } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      captured.url = url;
      captured.authorization = new Headers(init?.headers).get("Authorization");
      captured.body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        ok: true,
        model: "gpt-realtime-2",
        client_secret: { value: "ek_forwarded" },
      });
    }) as typeof fetch;

    const result = await mintOpenAIRealtimeClientSecret({ model: "gpt-realtime-2", byok_api_key: "not-a-key" }, { quotaKey: "user:u1" });

    expect(result.ok).toBe(true);
    expect(captured.url).toBe("http://control.local/internal/provider/openai/realtime/client-secret");
    expect(captured.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(captured.body)).not.toContain("not-a-key");
  });
});

describe("provider gateway internal endpoints", () => {
  let server: GatewayServer;
  let port: number;
  let realFetch: typeof fetch;
  let configDir: string;

  beforeEach(() => {
    clearProviderEnv();
    configDir = tempConfigDir();
    resetGatewayState();
    realFetch = globalThis.fetch;
    process.env.HAWKY_PROVIDER_GATEWAY_TOKEN = TOKEN;
    server = new GatewayServer();
    port = getTestPort();
    server.start(port);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await server.stop(1000);
    resetGatewayState();
    clearProviderEnv();
    resetConfigDir();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("rejects internal provider gateway calls without the shared token", async () => {
    const res = await fetch(`http://localhost:${port}/internal/provider/openai/realtime/client-secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-realtime-2" }),
    });
    expect(res.status).toBe(401);
  });

  test("mints OpenAI Realtime client secrets with the control gateway key", async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    const captured: { authorization?: string | null } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.openai.com")) {
        captured.authorization = new Headers(init?.headers).get("Authorization");
        return Response.json({ client_secret: { value: "ek_control" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const res = await fetch(`http://localhost:${port}/internal/provider/openai/realtime/client-secret`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Hawky-Provider-Subject": "user:mikey",
      },
      body: JSON.stringify({ model: "gpt-realtime-2" }),
    });

    expect(res.status).toBe(200);
    expect(captured.authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  test("proxies Anthropic requests while replacing the internal token with the upstream key", async () => {
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
    const captured: { url?: string; xApiKey?: string | null; authorization?: string | null } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.anthropic.com")) {
        const headers = new Headers(init?.headers);
        captured.url = url;
        captured.xApiKey = headers.get("x-api-key");
        captured.authorization = headers.get("Authorization");
        return Response.json({ id: "msg_test", type: "message", content: [] }, {
          headers: { "Content-Type": "application/json" },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const res = await fetch(`http://localhost:${port}/internal/provider/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": TOKEN,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-test", max_tokens: 1, messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured.xApiKey).toBe(ANTHROPIC_KEY);
    expect(captured.authorization).toBeNull();
  });

  test("canary consumes budget without making an upstream call by default", async () => {
    process.env.HAWKY_PROVIDER_BUDGET_STORE = join(configDir, "state", "provider-budget.json");
    process.env.HAWKY_PROVIDER_CANARY_UNITS = "0.25";
    let upstreamCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.openai.com") || url.includes("api.anthropic.com")) {
        upstreamCalls += 1;
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const res = await fetch(`http://localhost:${port}/internal/provider/canary?provider=openai&subject=test-user`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.live).toBe(false);
    expect(body.provider_budget.units).toBe(0.25);
    expect(upstreamCalls).toBe(0);
  });

  test("canary returns 429 when daily budget is exhausted", async () => {
    process.env.HAWKY_PROVIDER_BUDGET_STORE = join(configDir, "state", "provider-budget.json");
    process.env.HAWKY_PROVIDER_DAILY_UNITS = "0.1";
    process.env.HAWKY_PROVIDER_CANARY_UNITS = "0.2";

    const res = await fetch(`http://localhost:${port}/internal/provider/canary?provider=anthropic&subject=tiny-budget`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("budget exceeded");
  });
});
