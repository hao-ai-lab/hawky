// =============================================================================
// Tests: Anthropic provider drops `output_config.effort` for Haiku
//
// The Haiku tier rejects `output_config` with HTTP 400 ("This model does not
// support the effort parameter."). The agent loop sets output_config.effort on
// EVERY request (it is provider-agnostic), so AnthropicProvider must strip the
// field for models that don't support it — otherwise every heartbeat /
// consolidation / distillation turn running on claude-haiku-4-5 400s silently.
// Opus/Sonnet (4.6+) accept the field and must keep it.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { AnthropicProvider, modelSupportsEffort } from "../src/agent/anthropic_provider.js";
import type { LLMStreamRequest } from "../src/agent/provider.js";

function installMockClient(provider: AnthropicProvider): { captured: () => any } {
  let captured: any = null;
  const mockStream = (async function* () {
    yield { type: "message_start", message: { id: "m1", model: "mock", usage: { input_tokens: 1, output_tokens: 1 } } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
    yield { type: "message_stop" };
  })();
  const mockClient = {
    messages: {
      create: async (params: any) => { captured = params; return mockStream; },
    },
  };
  (provider as any).client = mockClient;
  return { captured: () => captured };
}

async function consume(it: AsyncGenerator<unknown>) {
  for await (const _ of it) { /* drain */ }
}

function baseRequest(overrides: Partial<LLMStreamRequest> = {}): LLMStreamRequest {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("modelSupportsEffort", () => {
  test("Haiku models do NOT support the effort dial", () => {
    expect(modelSupportsEffort("claude-haiku-4-5")).toBe(false);
    expect(modelSupportsEffort("claude-haiku-4-5-20251001")).toBe(false);
    expect(modelSupportsEffort("CLAUDE-HAIKU-4-5")).toBe(false); // case-insensitive
  });
  test("Opus/Sonnet models DO support the effort dial", () => {
    expect(modelSupportsEffort("claude-opus-4-7")).toBe(true);
    expect(modelSupportsEffort("claude-opus-4-8")).toBe(true);
    expect(modelSupportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(modelSupportsEffort("claude-sonnet-4-6-20260301")).toBe(true);
  });
});

describe("AnthropicProvider output_config gating", () => {
  test("drops output_config for Haiku even when the loop sets it", async () => {
    const provider = new AnthropicProvider("test-key");
    const { captured } = installMockClient(provider);
    await consume(provider.stream(baseRequest({ model: "claude-haiku-4-5", output_config: { effort: "medium" } })));
    expect(captured()).toBeTruthy();
    expect(captured().output_config).toBeUndefined();
    expect(captured().model).toBe("claude-haiku-4-5");
  });

  test("drops output_config for Haiku at every effort level", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const provider = new AnthropicProvider("test-key");
      const { captured } = installMockClient(provider);
      await consume(provider.stream(baseRequest({ output_config: { effort } })));
      expect(captured().output_config).toBeUndefined();
    }
  });

  test("preserves output_config for Opus/Sonnet", async () => {
    for (const model of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-8"]) {
      const provider = new AnthropicProvider("test-key");
      const { captured } = installMockClient(provider);
      await consume(provider.stream(baseRequest({ model, output_config: { effort: "high" } })));
      expect(captured().output_config).toEqual({ effort: "high" });
    }
  });

  test("preserves other fields when stripping for Haiku", async () => {
    const provider = new AnthropicProvider("test-key");
    const { captured } = installMockClient(provider);
    await consume(provider.stream(baseRequest({
      output_config: { effort: "max" },
      system: "you are a test",
      stop_sequences: ["</done>"],
    })));
    const p = captured();
    expect(p.output_config).toBeUndefined();
    expect(p.system).toBe("you are a test");
    expect(p.stop_sequences).toEqual(["</done>"]);
    expect(p.messages).toBeTruthy();
  });

  test("no output_config in request → none forwarded (no spurious field)", async () => {
    const provider = new AnthropicProvider("test-key");
    const { captured } = installMockClient(provider);
    await consume(provider.stream(baseRequest({ model: "claude-sonnet-4-6" })));
    expect(captured().output_config).toBeUndefined();
  });
});
