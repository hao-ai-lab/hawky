// =============================================================================
// Tests: Vertex provider strips `output_config`
//
// Vertex's Anthropic-compatible surface rejects `output_config` with a 400
// ("Extra inputs are not permitted"). The agent loop sets it unconditionally
// because the direct Anthropic API accepts it. VertexProvider must strip the
// field before forwarding to @anthropic-ai/vertex-sdk's messages.create —
// otherwise every turn 400s and the session is interrupted (regression of the
// "agent paused mid-turn" bug observed on a Vertex deployment).
// =============================================================================

import { describe, test, expect } from "bun:test";
import { VertexProvider } from "../src/agent/vertex_provider.js";
import type { LLMStreamRequest } from "../src/agent/provider.js";

function installMockClient(provider: VertexProvider): { captured: () => any } {
  let captured: any = null;
  const mockStream = (async function* () {
    yield { type: "message_start", message: { id: "m1", model: "mock", usage: { input_tokens: 1, output_tokens: 1 } } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
    yield { type: "message_stop" };
  })();
  const mockClient = {
    messages: {
      create: async (params: any) => {
        captured = params;
        return mockStream;
      },
    },
  };
  // Bypass the lazy ADC-bound client — tests run without GCP credentials.
  (provider as any)._client = mockClient;
  return { captured: () => captured };
}

async function consume(it: AsyncGenerator<unknown>) {
  for await (const _ of it) { /* drain */ }
}

function baseRequest(overrides: Partial<LLMStreamRequest> = {}): LLMStreamRequest {
  return {
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("VertexProvider strips output_config", () => {
  test("does not forward output_config to messages.create even when set", async () => {
    const provider = new VertexProvider({ projectId: "test-project", region: "global" });
    const { captured } = installMockClient(provider);

    await consume(provider.stream(baseRequest({ output_config: { effort: "max" } })));

    expect(captured()).toBeTruthy();
    expect(captured().output_config).toBeUndefined();
  });

  test("strips output_config for every effort level (low/medium/high/xhigh/max)", async () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
    for (const effort of efforts) {
      const provider = new VertexProvider({ projectId: "test-project", region: "global" });
      const { captured } = installMockClient(provider);
      await consume(provider.stream(baseRequest({ output_config: { effort } })));
      expect(captured().output_config).toBeUndefined();
    }
  });

  test("preserves other fields (model, messages, system, tools, thinking, stop_sequences)", async () => {
    const provider = new VertexProvider({ projectId: "test-project", region: "global" });
    const { captured } = installMockClient(provider);

    await consume(
      provider.stream(
        baseRequest({
          system: "you are a test",
          tools: [{ name: "foo", description: "f", input_schema: { type: "object" } }] as any,
          thinking: { type: "enabled", budget_tokens: 1024 } as any,
          stop_sequences: ["</done>"],
          output_config: { effort: "high" },
        }),
      ),
    );

    const params = captured();
    expect(params.model).toBe("claude-opus-4-7");
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(params.system).toBe("you are a test");
    expect(params.tools).toHaveLength(1);
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(params.stop_sequences).toEqual(["</done>"]);
    expect(params.stream).toBe(true);
    expect(params.output_config).toBeUndefined();
  });

  test("works fine when output_config is absent (no warning needed, no forwarding)", async () => {
    const provider = new VertexProvider({ projectId: "test-project", region: "global" });
    const { captured } = installMockClient(provider);

    await consume(provider.stream(baseRequest()));

    expect(captured().output_config).toBeUndefined();
  });
});
