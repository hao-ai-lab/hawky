import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import {
  KNOWN_OPENAI_MODELS,
  fetchOpenAIModelCatalog,
  getCachedCatalog,
  setCachedCatalog,
  clearCachedCatalog,
} from "../src/agent/openai-models.js";

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

  test("happy path parses data array", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.4-mini" }, { id: "gpt-5.4-nano" }] }),
      { status: 200 },
    )) as typeof fetch;
    const models = await fetchOpenAIModelCatalog("sk-test");
    expect(models.length).toBe(2);
    expect(models[0].id).toBe("gpt-5.4-mini");
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
