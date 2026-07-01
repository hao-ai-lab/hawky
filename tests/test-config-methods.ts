// =============================================================================
// Tests for config RPC method handlers (src/gateway/config-methods.ts)
//
// Covers: provider validation, openai_api_key field, cross-field guard.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfig, setConfigDir, resetConfigDir, loadConfig } from "../src/storage/config.js";
import { registerConfigMethods } from "../src/gateway/config-methods.js";
import { MethodError } from "../src/gateway/methods.js";

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) { methods[name] = handler; },
    call(name: string, params: unknown) {
      const m = methods[name];
      if (!m) throw new Error(`Method not found: ${name}`);
      return m(null, params, this);
    },
  };
}

let testDir: string;
const origOpenAIKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-config-methods-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  // Write a minimal config with an anthropic key so the tests don't create defaults
  writeFileSync(join(testDir, "config.json"), JSON.stringify({
    api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
    provider: "anthropic",
  }));
  setConfigDir(testDir);
  resetConfig();
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  resetConfig();
  resetConfigDir();
  if (origOpenAIKey !== undefined) {
    process.env.OPENAI_API_KEY = origOpenAIKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeConfigServer() {
  const server = makeMockServer();
  registerConfigMethods(server as any);
  return server;
}

// =============================================================================
// provider field validation
// =============================================================================

describe("config.update provider validation", () => {
  test("rejects invalid provider value", () => {
    const server = makeConfigServer();
    expect(() => server.call("config.update", { provider: "bedrock" })).toThrow(MethodError);
  });

  test("accepts anthropic", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", { provider: "anthropic" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("anthropic");
  });

  test("accepts vertex", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", { provider: "vertex" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("vertex");
  });
});

// =============================================================================
// openai_api_key field
// =============================================================================

describe("config.update openai_api_key", () => {
  test("setting provider openai without a key throws INVALID_REQUEST", () => {
    const server = makeConfigServer();
    let err: unknown;
    try {
      server.call("config.update", { provider: "openai" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MethodError);
    expect((err as MethodError).code).toBe("INVALID_REQUEST");
    expect((err as MethodError).message).toContain("OpenAI key required");
  });

  test("setting provider openai with openai_api_key in same update succeeds", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", {
      provider: "openai",
      openai_api_key: "sk-openai-test-key",
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai");
    expect(result.config.has_openai_key).toBe(true);
  });

  test("config.update caps OpenAI max_tokens to the selected model limit", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", {
      provider: "openai",
      openai_api_key: "sk-openai-test-key",
      model: "gpt-4o-mini",
      max_tokens: 32768,
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai");
    expect(result.config.model).toBe("gpt-4o-mini");
    expect(result.config.max_tokens).toBe(16384);

    resetConfig();
    const config = loadConfig();
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.max_tokens).toBe(16384);
  });

  test("setting provider openai normalizes stale Claude model and heartbeat override", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", {
      provider: "openai",
      openai_api_key: "sk-openai-test-key",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai");
    expect(result.config.model.startsWith("gpt-")).toBe(true);
    expect(result.config.heartbeat.model).toBeNull();

    resetConfig();
    const config = loadConfig();
    expect(config.provider).toBe("openai");
    expect(config.model.startsWith("gpt-")).toBe(true);
    expect(config.heartbeat.model).toBeNull();
  });

  test("switching back to anthropic normalizes stale OpenAI model", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "sk-existing-openai", brave_search: "" },
      provider: "openai",
      model: "gpt-5.5",
      heartbeat: { model: "gpt-5.4-mini" },
    }));
    resetConfig();
    const server = makeConfigServer();
    const result = server.call("config.update", { provider: "anthropic" }) as any;

    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("anthropic");
    expect(result.config.model.startsWith("claude-")).toBe(true);
    expect(result.config.heartbeat.model?.startsWith("claude-")).toBe(true);
  });

  test("setting provider openai resolves key from OPENAI_API_KEY env", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    resetConfig(); // pick up the env var
    const server = makeConfigServer();
    const result = server.call("config.update", { provider: "openai" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai");
  });

  test("setting provider openai resolves key from existing config.api_keys.openai", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "sk-existing-openai", brave_search: "" },
      provider: "anthropic",
    }));
    resetConfig();
    const server = makeConfigServer();
    const result = server.call("config.update", { provider: "openai" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai");
  });

  test("bare openai_api_key update writes nested api_keys.openai", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", { openai_api_key: "sk-new-key" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.has_openai_key).toBe(true);
  });

  test("bare openai_api_key update preserves sibling api_keys.anthropic", () => {
    const server = makeConfigServer();
    server.call("config.update", { openai_api_key: "sk-new-openai" });
    resetConfig();
    const config = loadConfig();
    expect(config.api_keys.anthropic).toBe("sk-ant-test");
    expect(config.api_keys.openai).toBe("sk-new-openai");
  });

  test("openai_api_key must be a string", () => {
    const server = makeConfigServer();
    expect(() => server.call("config.update", { openai_api_key: 12345 })).toThrow(MethodError);
  });

  test("heartbeat model null clears the override", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", { heartbeat: { model: null } }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.heartbeat.model).toBeNull();

    resetConfig();
    expect(loadConfig().heartbeat.model).toBeNull();
  });

  test("heartbeat model rejects non-string values", () => {
    const server = makeConfigServer();
    expect(() => server.call("config.update", { heartbeat: { model: 42 } })).toThrow(MethodError);
  });
});

// =============================================================================
// openai_compatible provider validation
// =============================================================================

describe("config.update openai_compatible provider", () => {
  test("accepts openai_compatible with valid profile already in config", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "anthropic",
      openai_compatible: {
        active_profile: "groq",
        profiles: { groq: { base_url: "https://api.groq.com/openai/v1", api_key: "gsk-test" } },
      },
    }));
    resetConfig();
    const server = makeConfigServer();
    const result = server.call("config.update", { provider: "openai_compatible" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai_compatible");
  });

  test("rejects openai_compatible when no active_profile set", () => {
    const server = makeConfigServer();
    let err: unknown;
    try {
      server.call("config.update", { provider: "openai_compatible" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MethodError);
    expect((err as MethodError).code).toBe("INVALID_REQUEST");
    expect((err as MethodError).message).toContain("openai_compatible requires an active_profile");
  });

  test("rejects openai_compatible when active_profile references nonexistent profile", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "anthropic",
      openai_compatible: { active_profile: "ghost", profiles: {} },
    }));
    resetConfig();
    const server = makeConfigServer();
    let err: unknown;
    try {
      server.call("config.update", { provider: "openai_compatible" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MethodError);
    expect((err as MethodError).code).toBe("INVALID_REQUEST");
  });

  test("rejects openai_compatible when profile has empty base_url", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "anthropic",
      openai_compatible: {
        active_profile: "bad",
        profiles: { bad: { base_url: "", api_key: "k" } },
      },
    }));
    resetConfig();
    const server = makeConfigServer();
    expect(() => server.call("config.update", { provider: "openai_compatible" })).toThrow(MethodError);
  });

  test("rejects openai_compatible when profile has no resolvable key", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "anthropic",
      openai_compatible: {
        active_profile: "nokey",
        profiles: { nokey: { base_url: "https://api.example.com/v1" } },
      },
    }));
    resetConfig();
    const server = makeConfigServer();
    let err: unknown;
    try {
      server.call("config.update", { provider: "openai_compatible" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MethodError);
    expect((err as MethodError).code).toBe("INVALID_REQUEST");
    expect((err as MethodError).message).toContain("no API key resolvable");
  });

  test("accepts openai_compatible when openai_api_key is supplied in the same update", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "anthropic",
      openai_compatible: {
        active_profile: "runpod",
        profiles: { runpod: { base_url: "https://runpod.example/v1" } },
      },
    }));
    resetConfig();
    const server = makeConfigServer();
    const result = server.call("config.update", {
      provider: "openai_compatible",
      openai_api_key: "sk-openai-fallback",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.config.provider).toBe("openai_compatible");
    expect(result.config.has_openai_key).toBe(true);
  });

  test("persists active_profile without allowing profile edits through config.update", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "openai_compatible",
      openai_compatible: {
        active_profile: "groq",
        profiles: {
          groq: { base_url: "https://api.groq.com/openai/v1", api_key: "gsk-test" },
          local: { base_url: "http://localhost:8000/v1", api_key: "sk-local" },
        },
      },
    }));
    resetConfig();
    const server = makeConfigServer();
    const result = server.call("config.update", {
      openai_compatible: { active_profile: "local" },
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.openai_compatible.active_profile).toBe("local");
    resetConfig();
    expect(loadConfig().openai_compatible?.active_profile).toBe("local");

    expect(() => server.call("config.update", {
      openai_compatible: {
        profiles: { bad: { base_url: "http://bad.example.com/v1" } },
      },
    })).toThrow(MethodError);
  });
});

// =============================================================================
// openai_base_url field
// =============================================================================

describe("config.update openai_base_url", () => {
  test("accepts a valid URL string", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", {
      openai_base_url: "http://localhost:8000/v1",
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.openai_base_url).toBe("http://localhost:8000/v1");
  });

  test("accepts empty string to clear the field", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", { openai_base_url: "" }) as any;
    expect(result.ok).toBe(true);
    expect(result.config.openai_base_url).toBe("");
  });

  test("rejects non-string openai_base_url", () => {
    const server = makeConfigServer();
    expect(() => server.call("config.update", { openai_base_url: 42 })).toThrow(MethodError);
    try {
      server.call("config.update", { openai_base_url: 42 });
    } catch (err) {
      expect((err as MethodError).code).toBe("INVALID_REQUEST");
    }
  });

  test("openai_base_url is returned by config.get", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "openai",
      openai_base_url: "https://api.deepinfra.com/v1/openai",
    }));
    resetConfig();
    const server = makeConfigServer();
    const result = server.call("config.get", undefined) as any;
    expect(result.openai_base_url).toBe("https://api.deepinfra.com/v1/openai");
  });
});

// =============================================================================
// experimental feature flags
// =============================================================================

describe("config.update experiments", () => {
  test("agent runtimes experiment defaults off in config.get", () => {
    const server = makeConfigServer();
    const result = server.call("config.get", undefined) as any;

    expect(result.experiments.agent_runtimes).toBe(false);
  });

  test("persists agent runtimes experiment toggle", () => {
    const server = makeConfigServer();
    const result = server.call("config.update", {
      experiments: { agent_runtimes: true },
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.config.experiments.agent_runtimes).toBe(true);
    resetConfig();
    expect(loadConfig().experiments?.agent_runtimes).toBe(true);
  });

  test("rejects non-object experiments payload", () => {
    const server = makeConfigServer();

    expect(() => server.call("config.update", { experiments: true })).toThrow(MethodError);
  });
});
