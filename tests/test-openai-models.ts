import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import {
  KNOWN_OPENAI_MODELS,
  buildOpenAIModelCatalogURL,
  fetchOpenAIModelCatalog,
  getCachedCatalog,
  resolveOpenAIModelCatalogProbe,
  setCachedCatalog,
  clearCachedCatalog,
} from "../src/agent/openai-models.js";
import type { HawkyConfig } from "../src/agent/types.js";

function baseConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "gpt-5.4",
    max_tokens: 8192,
    max_iterations: 80,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp/ws",
    gateway_port: 4242,
    ...overrides,
  } as HawkyConfig;
}

describe("KNOWN_OPENAI_MODELS", () => {
  test("ships exactly the 8 priced IDs", () => {
    expect(KNOWN_OPENAI_MODELS.length).toBe(8);
    for (const id of KNOWN_OPENAI_MODELS) {
      expect(id.startsWith("gpt-")).toBe(true);
    }
  });

  test("includes the gpt-5.x flagship lineup", () => {
    expect(KNOWN_OPENAI_MODELS).toContain("gpt-5.5");
    expect(KNOWN_OPENAI_MODELS).toContain("gpt-5.4");
    expect(KNOWN_OPENAI_MODELS).toContain("gpt-5.3-codex");
  });
});

describe("catalog cache", () => {
  beforeEach(() => clearCachedCatalog());
  afterEach(() => clearCachedCatalog());

  test("returns null before any probe", () => {
    expect(getCachedCatalog()).toBeNull();
  });

  test("set then get round-trips", () => {
    setCachedCatalog([{ id: "gpt-5.4-mini" }, { id: "gpt-5.5" }]);
    const cached = getCachedCatalog();
    expect(cached).not.toBeNull();
    expect(cached!.length).toBe(2);
    expect(cached![0].id).toBe("gpt-5.4-mini");
  });

  test("clear empties the cache", () => {
    setCachedCatalog([{ id: "gpt-5.4" }]);
    clearCachedCatalog();
    expect(getCachedCatalog()).toBeNull();
  });
});

describe("fetchOpenAIModelCatalog", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("builds model catalog URLs from OpenAI-compatible base URLs", () => {
    expect(buildOpenAIModelCatalogURL()).toBe("https://api.openai.com/v1/models");
    expect(buildOpenAIModelCatalogURL("http://localhost:8000/v1")).toBe("http://localhost:8000/v1/models");
    expect(buildOpenAIModelCatalogURL("https://api.deepinfra.com/v1/openai/")).toBe("https://api.deepinfra.com/v1/openai/models");
  });

  test("happy path parses data array", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.4-mini" }, { id: "gpt-5.4-nano" }] }),
      { status: 200 },
    )) as typeof fetch;
    const models = await fetchOpenAIModelCatalog("sk-test");
    expect(models.length).toBe(2);
    expect(models[0].id).toBe("gpt-5.4-mini");
  });

  test("uses custom base URL and authorization header", async () => {
    const captured: { url?: string; authorization?: string | null; hasSignal?: boolean } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      captured.authorization = new Headers(init?.headers).get("Authorization");
      captured.hasSignal = init?.signal instanceof AbortSignal;
      return new Response(
        JSON.stringify({ data: [{ id: "llama-4-scout" }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const models = await fetchOpenAIModelCatalog("sk-custom", {
      baseURL: "http://localhost:8000/v1",
      timeoutMs: 50,
    });

    expect(captured.url).toBe("http://localhost:8000/v1/models");
    expect(captured.authorization).toBe("Bearer sk-custom");
    expect(captured.hasSignal).toBe(true);
    expect(models).toEqual([{ id: "llama-4-scout" }]);
  });

  test("401 throws", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    await expect(fetchOpenAIModelCatalog("sk-bad")).rejects.toThrow(/401/);
  });

  test("missing data array throws", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ object: "list" }),
      { status: 200 },
    )) as typeof fetch;
    await expect(fetchOpenAIModelCatalog("sk-test")).rejects.toThrow(/data array/);
  });
});

describe("resolveOpenAIModelCatalogProbe", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalCompatKey = process.env.TEST_OPENAI_COMPAT_KEY;

  afterEach(() => {
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;

    if (originalCompatKey === undefined) delete process.env.TEST_OPENAI_COMPAT_KEY;
    else process.env.TEST_OPENAI_COMPAT_KEY = originalCompatKey;
  });

  test("uses openai_base_url for openai provider probes", () => {
    delete process.env.OPENAI_API_KEY;
    const probe = resolveOpenAIModelCatalogProbe(baseConfig({
      provider: "openai",
      api_keys: { anthropic: "", brave_search: "", openai: "sk-config" },
      openai_base_url: "http://localhost:8000/v1",
    }));

    expect(probe).toEqual({
      apiKey: "sk-config",
      baseURL: "http://localhost:8000/v1",
    });
  });

  test("uses active openai-compatible profile base URL and key", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.TEST_OPENAI_COMPAT_KEY = "compat-env-key";
    const probe = resolveOpenAIModelCatalogProbe(baseConfig({
      provider: "openai_compatible",
      openai_compatible: {
        active_profile: "local",
        profiles: {
          local: { base_url: "http://localhost:9000/v1", api_key_env: "TEST_OPENAI_COMPAT_KEY" },
        },
      },
    }));

    expect(probe).toEqual({
      apiKey: "compat-env-key",
      baseURL: "http://localhost:9000/v1",
    });
  });

  test("returns null when selected provider has no catalog key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(resolveOpenAIModelCatalogProbe(baseConfig({ provider: "openai" }))).toBeNull();
    expect(resolveOpenAIModelCatalogProbe(baseConfig({ provider: "anthropic" }))).toBeNull();
  });
});
