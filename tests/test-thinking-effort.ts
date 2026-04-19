// =============================================================================
// Effort Level Tests
//
// Verifies that effort config maps to the correct API output_config parameter.
// =============================================================================

import { describe, test, expect } from "bun:test";

function makeMockProvider() {
  let capturedRequest: any = null;
  return {
    captured: () => capturedRequest,
    provider: {
      async *stream(request: any) {
        capturedRequest = request;
        yield { type: "message_start", message_id: "msg_1", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        yield { type: "text_delta", text: "Hello" };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" };
      },
    },
  };
}

async function createLoop(effort?: "low" | "medium" | "high" | "xhigh" | "max") {
  const { AgentLoop } = await import("../src/agent/loop.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const mock = makeMockProvider();
  const loop = new AgentLoop({
    provider: mock.provider as any,
    registry: new ToolRegistry(),
    config: {
      model: "claude-opus-4-7",
      max_tokens: 8192,
      ...(effort ? { effort } : {}),
      max_iterations: 5,
      max_tool_result_chars: 10000,
    } as any,
    working_directory: "/tmp",
  });
  return { loop, captured: mock.captured };
}

describe("effort level config → API parameter", () => {
  test("medium effort sends output_config.effort: medium", async () => {
    const { loop, captured } = await createLoop("medium");
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "medium" });
  });

  test("high effort sends output_config.effort: high", async () => {
    const { loop, captured } = await createLoop("high");
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "high" });
  });

  test("low effort sends output_config.effort: low", async () => {
    const { loop, captured } = await createLoop("low");
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "low" });
  });

  test("xhigh effort sends output_config.effort: xhigh", async () => {
    // xhigh was added alongside claude-opus-4-7 (SDK v0.90.0).
    // Slots between high and max in the enum ordering.
    const { loop, captured } = await createLoop("xhigh");
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "xhigh" });
  });

  test("max effort sends output_config.effort: max", async () => {
    const { loop, captured } = await createLoop("max");
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "max" });
  });

  test("no config defaults to medium", async () => {
    const { loop, captured } = await createLoop();
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "medium" });
  });

  test("per-session override via setter", async () => {
    const { loop, captured } = await createLoop("low");
    loop.effort = "max";
    await loop.sendMessage("test");
    expect(captured().output_config).toEqual({ effort: "max" });
  });
});
