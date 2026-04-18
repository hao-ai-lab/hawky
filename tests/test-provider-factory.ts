// =============================================================================
// Tests: LLM Provider Factory
//
// Verifies createProvider() routes to the right backend based on
// config.provider, and that misconfiguration throws LLMErrors with
// user-facing messages pointing at the setup docs.
// =============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import { createProvider } from "../src/agent/provider-factory.js";
import { AnthropicProvider } from "../src/agent/anthropic_provider.js";
import { VertexProvider } from "../src/agent/vertex_provider.js";
import { OpenAIProvider } from "../src/agent/openai_provider.js";
import { LLMError } from "../src/agent/provider.js";
import type { HawkyConfig } from "../src/agent/types.js";

function baseConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-opus-4-7",
    max_tokens: 8192,
    max_iterations: 80,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp/ws",
    gateway_port: 4242,
    ...overrides,
  } as HawkyConfig;
}

describe("createProvider", () => {
  test("returns AnthropicProvider when provider is unset (default)", () => {
    const p = createProvider(baseConfig());
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  test("returns AnthropicProvider when provider is explicitly 'anthropic'", () => {
    const p = createProvider(baseConfig({ provider: "anthropic" }));
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  test("returns VertexProvider when provider is 'vertex' and project_id is set", () => {
    const p = createProvider(baseConfig({
      provider: "vertex",
      vertex: { project_id: "hawky-test", region: "global" },
    }));
    expect(p).toBeInstanceOf(VertexProvider);
  });

  test("throws LLMError with setup-doc hint when vertex.project_id is empty", () => {
    expect(() =>
      createProvider(baseConfig({
        provider: "vertex",
        vertex: { project_id: "", region: "global" },
      })),
    ).toThrow(LLMError);

    try {
      createProvider(baseConfig({
        provider: "vertex",
        vertex: { project_id: "", region: "global" },
      }));
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).message).toContain("vertex.project_id");
      expect((err as LLMError).message).toContain("deploy/VERTEX_SETUP.md");
    }
  });

  test("throws LLMError when vertex block is entirely missing", () => {
    expect(() =>
      createProvider(baseConfig({ provider: "vertex" })),
    ).toThrow(LLMError);
  });

  test("throws LLMError when provider is anthropic but api_key is empty", () => {
    expect(() =>
      createProvider(baseConfig({
        api_keys: { anthropic: "", brave_search: "", openai: "" },
      })),
    ).toThrow(LLMError);

    try {
      createProvider(baseConfig({
        api_keys: { anthropic: "", brave_search: "", openai: "" },
      }));
    } catch (err) {
      expect((err as LLMError).message).toContain("Anthropic API key");
      expect((err as LLMError).message).toContain("deploy/VERTEX_SETUP.md");
    }
  });

  test("anthropic provider still works even if vertex fields are set", () => {
    // Users might have both configured while experimenting — provider field wins.
    const p = createProvider(baseConfig({
      provider: "anthropic",
      vertex: { project_id: "hawky-test", region: "global" },
    }));
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  test("vertex provider defaults region to 'global' when omitted", () => {
    // Should not throw — region is optional.
    const p = createProvider(baseConfig({
      provider: "vertex",
      vertex: { project_id: "hawky-test" } as any,
    }));
    expect(p).toBeInstanceOf(VertexProvider);
  });

  describe("openai provider", () => {
    const origOpenAIKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
      if (origOpenAIKey !== undefined) {
        process.env.OPENAI_API_KEY = origOpenAIKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    test("returns OpenAIProvider when api_keys.openai is set", () => {
      delete process.env.OPENAI_API_KEY;
      const p = createProvider(baseConfig({
        provider: "openai",
        api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      }));
      expect(p).toBeInstanceOf(OpenAIProvider);
    });

    test("openai_base_url set → provider constructed (no error)", () => {
      delete process.env.OPENAI_API_KEY;
      const p = createProvider(baseConfig({
        provider: "openai",
        api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
        openai_base_url: "https://api.deepinfra.com/v1/openai",
      }));
      expect(p).toBeInstanceOf(OpenAIProvider);
    });

    test("no openai_base_url → provider still constructs (uses SDK default)", () => {
      delete process.env.OPENAI_API_KEY;
      const p = createProvider(baseConfig({
        provider: "openai",
        api_keys: { anthropic: "", brave_search: "", openai: "sk-test" },
      }));
      expect(p).toBeInstanceOf(OpenAIProvider);
    });

    test("throws auth_error when no key", () => {
      delete process.env.OPENAI_API_KEY;
      try {
        createProvider(baseConfig({
          provider: "openai",
          api_keys: { anthropic: "", brave_search: "", openai: "" },
        }));
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMError);
        expect((err as LLMError).code).toBe("auth_error");
        expect((err as LLMError).message).toContain("OPENAI_API_KEY");
      }
    });
  });

  describe("openai_compatible provider", () => {
    const origOpenAIKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
      if (origOpenAIKey !== undefined) {
        process.env.OPENAI_API_KEY = origOpenAIKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    function compatConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
      return baseConfig({
        provider: "openai_compatible",
        openai_compatible: {
          active_profile: "groq",
          profiles: {
            groq: { base_url: "https://api.groq.com/openai/v1", api_key: "gsk-test" },
          },
        },
        ...overrides,
      });
    }

    test("happy path — valid profile + literal api_key → OpenAIProvider", () => {
      delete process.env.OPENAI_API_KEY;
      const p = compatConfig();
      expect(createProvider(p)).toBeInstanceOf(OpenAIProvider);
    });

    test("missing active_profile → LLMError", () => {
      delete process.env.OPENAI_API_KEY;
      expect(() =>
        createProvider(baseConfig({
          provider: "openai_compatible",
          openai_compatible: { active_profile: "", profiles: {} },
        })),
      ).toThrow(LLMError);
    });

    test("unknown profile name → LLMError", () => {
      delete process.env.OPENAI_API_KEY;
      expect(() =>
        createProvider(baseConfig({
          provider: "openai_compatible",
          openai_compatible: {
            active_profile: "nonexistent",
            profiles: { groq: { base_url: "https://api.groq.com/openai/v1", api_key: "gsk-test" } },
          },
        })),
      ).toThrow(LLMError);
    });

    test("empty base_url → LLMError", () => {
      delete process.env.OPENAI_API_KEY;
      expect(() =>
        createProvider(baseConfig({
          provider: "openai_compatible",
          openai_compatible: {
            active_profile: "bad",
            profiles: { bad: { base_url: "", api_key: "k" } },
          },
        })),
      ).toThrow(LLMError);
    });

    test("key resolution: literal api_key wins over api_key_env", () => {
      process.env.TEST_GROQ_KEY = "env-key";
      expect(createProvider(
        baseConfig({
          provider: "openai_compatible",
          openai_compatible: {
            active_profile: "groq",
            profiles: { groq: { base_url: "https://api.groq.com/openai/v1", api_key: "literal-key", api_key_env: "TEST_GROQ_KEY" } },
          },
        }),
      )).toBeInstanceOf(OpenAIProvider);
      delete process.env.TEST_GROQ_KEY;
    });

    test("key resolution: api_key_env wins over api_keys.openai", () => {
      delete process.env.OPENAI_API_KEY;
      process.env.MY_VLLM_KEY = "vllm-env-key";
      expect(createProvider(
        baseConfig({
          provider: "openai_compatible",
          api_keys: { anthropic: "", brave_search: "", openai: "oai-key" },
          openai_compatible: {
            active_profile: "vllm",
            profiles: { vllm: { base_url: "http://localhost:8000/v1", api_key_env: "MY_VLLM_KEY" } },
          },
        }),
      )).toBeInstanceOf(OpenAIProvider);
      delete process.env.MY_VLLM_KEY;
    });

    test("key resolution: falls back to api_keys.openai", () => {
      delete process.env.OPENAI_API_KEY;
      expect(createProvider(
        baseConfig({
          provider: "openai_compatible",
          api_keys: { anthropic: "", brave_search: "", openai: "oai-fallback" },
          openai_compatible: {
            active_profile: "groq",
            profiles: { groq: { base_url: "https://api.groq.com/openai/v1" } },
          },
        }),
      )).toBeInstanceOf(OpenAIProvider);
    });

    test("key resolution: falls back to OPENAI_API_KEY env", () => {
      process.env.OPENAI_API_KEY = "env-fallback";
      expect(createProvider(
        baseConfig({
          provider: "openai_compatible",
          api_keys: { anthropic: "", brave_search: "", openai: "" },
          openai_compatible: {
            active_profile: "groq",
            profiles: { groq: { base_url: "https://api.groq.com/openai/v1" } },
          },
        }),
      )).toBeInstanceOf(OpenAIProvider);
    });

    test("no key resolvable → LLMError auth_error", () => {
      delete process.env.OPENAI_API_KEY;
      try {
        createProvider(
          baseConfig({
            provider: "openai_compatible",
            api_keys: { anthropic: "", brave_search: "", openai: "" },
            openai_compatible: {
              active_profile: "groq",
              profiles: { groq: { base_url: "https://api.groq.com/openai/v1" } },
            },
          }),
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMError);
        expect((err as LLMError).code).toBe("auth_error");
        expect((err as LLMError).message).toContain("no API key resolvable");
      }
    });
  });

  test("vertex provider construction does NOT trigger google-auth-library", async () => {
    // Regression guard: AnthropicVertex's constructor eagerly kicks off
    // GoogleAuth.getClient(), which fails as "NO_ADC_FOUND" on machines
    // without ADC (CI runners, teammates who haven't run
    // `gcloud auth application-default login` yet). VertexProvider must
    // defer that work until the first stream() call so:
    //   1. the unit-test suite runs without leaking unhandled rejections
    //   2. startup on a misconfigured machine logs cleanly instead of
    //      spewing a stack trace, and the error surfaces through
    //      classifyError the first time a turn actually runs.
    // If someone re-eagerizes the client, this test catches it.
    let unhandled: unknown = null;
    const handler = (reason: unknown) => { unhandled = reason; };
    process.on("unhandledRejection", handler);
    try {
      createProvider(baseConfig({
        provider: "vertex",
        vertex: { project_id: "hawky-test", region: "global" },
      }));
      // Give any eager async work a tick to fail.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});
