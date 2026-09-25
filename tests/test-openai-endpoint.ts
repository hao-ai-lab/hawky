import { afterEach, beforeEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAIEndpoint } from "../src/agent/openai-endpoint.js";
import { getConfigDir, setConfigDir, resetConfig } from "../src/storage/config.js";
import { mintOpenAIRealtimeClientSecret, resetRealtimeMintQuotaForTests } from "../src/gateway/live-realtime-broker.js";
import { validateOpenAIKey } from "../src/storage/config-validators.js";

const vars = ["HAWKY_OPENAI_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "HAWKY_PROVIDER_GATEWAY_URL"];
const issuedKey = "sk-hawky-fixture-not-a-real-key-000000000000";
let originalEnv: Record<string, string | undefined>, oldConfig: string, directory: string;
let originalFetch: typeof fetch;
beforeEach(() => {
  originalEnv = Object.fromEntries(vars.map(key => [key, process.env[key]]));
  for (const key of vars) delete process.env[key];
  oldConfig = getConfigDir(); directory = mkdtempSync(join(tmpdir(), "hawk-endpoint-")); setConfigDir(directory);
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  for (const key of vars) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
  setConfigDir(oldConfig); rmSync(directory, { recursive: true, force: true }); globalThis.fetch = originalFetch;
  resetRealtimeMintQuotaForTests();
});
test("issued keys use the router while personal keys remain direct", () => {
  process.env.HAWKY_OPENAI_BASE_URL = "https://router.example/v1/";
  expect(openAIEndpoint("responses", issuedKey)).toBe("https://router.example/v1/responses");
  expect(openAIEndpoint("realtime/client_secrets", "sk-personal")).toBe("https://api.openai.com/v1/realtime/client_secrets");
  expect(openAIEndpoint("live/sessions/id/attach", issuedKey).replace(/^http/, "ws")).toBe("wss://router.example/v1/live/sessions/id/attach");
});
test("issued key requires explicit routing and supports SDK environment and saved configuration", () => {
  expect(() => openAIEndpoint("responses", issuedKey)).toThrow("requires an OpenAI base URL");
  writeFileSync(join(directory, "config.json"), JSON.stringify({ openai_base_url: "https://configured.example/v1" }));
  resetConfig();
  expect(openAIEndpoint("responses", issuedKey)).toBe("https://configured.example/v1/responses");
  process.env.OPENAI_BASE_URL = "https://sdk.example/v1";
  expect(openAIEndpoint("responses", issuedKey)).toBe("https://sdk.example/v1/responses");
});
test("mint and key validation use the issued key without exposing it in the broker response", async () => {
  process.env.HAWKY_OPENAI_BASE_URL = "https://router.example/v1";
  process.env.OPENAI_API_KEY = issuedKey;
  const requests: string[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit) => {
    requests.push(String(input));
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${issuedKey}`);
    return Response.json(String(input).endsWith("/models") ? { data: [] } : { value: "ephemeral-fixture" });
  }) as typeof fetch;
  const minted = await mintOpenAIRealtimeClientSecret({ model: "gpt-realtime-2" }, { allowProviderGatewayForward: false });
  expect(minted.ok).toBe(true);
  expect(JSON.stringify(minted)).not.toContain(issuedKey);
  // Ephemeral credentials still connect to the provider, not the virtual-key proxy.
  expect(minted.websocket_url).toStartWith("wss://api.openai.com/");
  expect((await validateOpenAIKey(issuedKey)).valid).toBe(true);
  expect(requests).toEqual(["https://router.example/v1/realtime/client_secrets", "https://router.example/v1/models"]);
});
