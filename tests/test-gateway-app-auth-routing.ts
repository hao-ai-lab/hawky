// =============================================================================
// Gateway App Auth Routing Tests
//
// Regression coverage for routes that must either bypass the app login wall or
// use trusted transport identity when app auth is enabled.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceAuth } from "../src/gateway/device-auth.js";
import { GatewayServer, requestIp, resetGatewayState } from "../src/gateway/server.js";
import { resetConfig, resetConfigDir, setConfigDir } from "../src/storage/config.js";

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

const FAKE_OPENAI_RESPONSE = JSON.stringify({
  ok: true,
  model: "gpt-realtime-2",
  websocket_url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
  client_secret: { client_secret: { value: "ek_test_stub" } },
});

function stubOpenAIFetch(): () => void {
  const realFetch = globalThis.fetch;
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

const ENV_KEYS = [
  "HAWKY_APP_AUTH",
  "HAWKY_ALLOW_FIRST_USER_REGISTRATION",
  "HAWKY_HEALTH_TOKEN",
  "HAWKY_TRUST_PROXY",
  "HAWKY_TRUST_PROXY_HEADERS",
  "OPENAI_API_KEY",
] as const;

type EnvKey = typeof ENV_KEYS[number];
type EnvSnapshot = Partial<Record<EnvKey, string>>;

function saveEnv(): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("gateway app-auth routing", () => {
  let server: GatewayServer | null;
  let port: number;
  let tmpDir: string;
  let env: EnvSnapshot;
  let restoreFetch: (() => void) | null;

  beforeEach(() => {
    resetGatewayState();
    env = saveEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "hawky-gateway-app-auth-"));
    setConfigDir(tmpDir);
    resetConfig();
    process.env.HAWKY_APP_AUTH = "1";
    delete process.env.HAWKY_HEALTH_TOKEN;
    delete process.env.HAWKY_TRUST_PROXY;
    delete process.env.HAWKY_TRUST_PROXY_HEADERS;
    server = null;
    restoreFetch = null;
    port = getTestPort();
  });

  afterEach(async () => {
    restoreFetch?.();
    await server?.stop(1000);
    server = null;
    resetGatewayState();
    rmSync(tmpDir, { recursive: true, force: true });
    resetConfigDir();
    resetConfig();
    restoreEnv(env);
  });

  test("health and readiness probes stay public when no health token is configured", async () => {
    server = new GatewayServer();
    server.start(port);

    const health = await fetch(`http://localhost:${port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json() as { status: string }).status).toBe("live");

    const ready = await fetch(`http://localhost:${port}/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json() as { status: string }).status).toBe("ready");
  });

  test("health token is enforced when explicitly configured", async () => {
    process.env.HAWKY_HEALTH_TOKEN = "probe-secret";
    server = new GatewayServer();
    server.start(port);

    const missing = await fetch(`http://localhost:${port}/health`);
    expect(missing.status).toBe(401);

    const ok = await fetch(`http://localhost:${port}/ready`, {
      headers: { "X-Hawky-Health-Token": "probe-secret" },
    });
    expect(ok.status).toBe(200);
  });

  test("OpenAI realtime broker reaches device-token validation past the app login wall", async () => {
    const auth = DeviceAuth.fromKey(randomBytes(32));
    const token = auth.createToken("ios-device");
    restoreFetch = stubOpenAIFetch();
    server = new GatewayServer(auth);
    server.start(port);

    const res = await postBrokerSecret(port, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  test("OpenAI realtime broker returns device-token errors instead of login-wall errors", async () => {
    const auth = DeviceAuth.fromKey(randomBytes(32));
    server = new GatewayServer(auth);
    server.start(port);

    const res = await postBrokerSecret(port, { Authorization: "Bearer invalid-token" });
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("Invalid or missing device token");
  });

  test("OpenAI realtime broker stays behind app auth without a device-token bearer", async () => {
    server = new GatewayServer();
    server.start(port);

    const res = await postBrokerSecret(port);
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: string };
    expect(body.error).toBe("Login required");
  });

  test("/auth/device login page returns to the requested device-token flow", async () => {
    const auth = DeviceAuth.fromKey(randomBytes(32));
    server = new GatewayServer(auth);
    server.start(port);

    const res = await fetch(`http://localhost:${port}/auth/device?callback_port=12345&device=cli`);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('name="return_url" value="/auth/device?callback_port=12345&amp;device=cli"');
  });

  test("requestIp ignores spoofable forwarded headers unless proxy trust is enabled", () => {
    const req = new Request("http://localhost/auth/login", {
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        "X-Forwarded-For": "198.51.100.20, 10.0.0.1",
      },
    });

    expect(requestIp(req)).toBe("");
    expect(requestIp(req, { requestIP: () => ({ address: "127.0.0.1" }) })).toBe("127.0.0.1");

    process.env.HAWKY_TRUST_PROXY_HEADERS = "1";
    expect(requestIp(req)).toBe("203.0.113.10");
    expect(requestIp(req, { requestIP: () => ({ address: "127.0.0.1" }) })).toBe("203.0.113.10");

    const xffOnly = new Request("http://localhost/auth/login", {
      headers: { "X-Forwarded-For": "198.51.100.20, 10.0.0.1" },
    });
    expect(requestIp(xffOnly, { requestIP: () => ({ address: "127.0.0.1" }) })).toBe("198.51.100.20");

    const noProxyHeaders = new Request("http://localhost/auth/login");
    expect(requestIp(noProxyHeaders, { requestIP: () => ({ address: "127.0.0.1" }) })).toBe("127.0.0.1");
  });
});
