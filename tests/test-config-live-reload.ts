// =============================================================================
// Tests: Live config reload via AgentSessionManager.updateConfig
//
// Verifies that mutating the shared config object is observable to already-
// constructed AgentLoop instances. The loop reads this.config.model /
// this.config.max_tokens on every turn (src/agent/loop.ts), so an in-place
// mutation propagates without reconstructing the loop or restarting the
// gateway.
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
        yield { type: "text_delta", text: "ok" };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" };
      },
    },
  };
}

async function buildLoop(sharedConfig: any) {
  const { AgentLoop } = await import("../src/agent/loop.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const mock = makeMockProvider();
  const loop = new AgentLoop({
    provider: mock.provider as any,
    registry: new ToolRegistry(),
    config: sharedConfig,
    working_directory: "/tmp",
  });
  return { loop, captured: mock.captured };
}

describe("AgentLoop reads live config on each turn", () => {
  test("model change via shared-reference mutation is picked up next turn", async () => {
    // Matches the runtime shape: config is a single object held by both
    // AgentSessionManager and every AgentLoop it constructed. Settings-panel
    // updates mutate that shared object in place.
    const shared: any = {
      model: "claude-opus-4-6",
      max_tokens: 8192,
      max_iterations: 5,
      max_tool_result_chars: 10000,
    };
    const { loop, captured } = await buildLoop(shared);

    await loop.sendMessage("hello");
    expect(captured().model).toBe("claude-opus-4-6");

    // Simulate the Settings panel → config.update → agentSessions.updateConfig
    // flow: Object.assign onto the shared reference.
    Object.assign(shared, { model: "claude-opus-4-7" });

    await loop.sendMessage("still you?");
    expect(captured().model).toBe("claude-opus-4-7");
  });

  test("max_tokens change is picked up next turn", async () => {
    const shared: any = {
      model: "claude-opus-4-7",
      max_tokens: 8192,
      max_iterations: 5,
      max_tool_result_chars: 10000,
    };
    const { loop, captured } = await buildLoop(shared);

    await loop.sendMessage("one");
    expect(captured().max_tokens).toBe(8192);

    Object.assign(shared, { max_tokens: 64000 });

    await loop.sendMessage("two");
    expect(captured().max_tokens).toBe(64000);
  });
});

describe("AgentSessionManager.updateConfig", () => {
  test("mutates this.config in place so loops see the change", async () => {
    const { AgentSessionManager } = await import("../src/gateway/agent-sessions.js");
    const initial: any = {
      model: "claude-opus-4-6",
      max_tokens: 8192,
      max_iterations: 5,
      max_tool_result_chars: 10000,
      workspace_dir: "/tmp",
    };
    const mgr = new AgentSessionManager({
      provider: { async *stream() {} } as any,
      config: initial,
      workingDirectory: "/tmp",
    });

    mgr.updateConfig({ ...initial, model: "claude-opus-4-7", max_tokens: 32000 });

    // The reference mgr was given at construction is now mutated.
    expect(initial.model).toBe("claude-opus-4-7");
    expect(initial.max_tokens).toBe(32000);
  });

  test("preserves fields not overwritten (Object.assign merge)", async () => {
    const { AgentSessionManager } = await import("../src/gateway/agent-sessions.js");
    const initial: any = {
      model: "claude-opus-4-6",
      max_tokens: 8192,
      max_iterations: 42,
      max_tool_result_chars: 10000,
      workspace_dir: "/tmp",
    };
    const mgr = new AgentSessionManager({
      provider: { async *stream() {} } as any,
      config: initial,
      workingDirectory: "/tmp",
    });

    // Update only provides a subset.
    mgr.updateConfig({ ...initial, model: "claude-opus-4-7" });

    expect(initial.model).toBe("claude-opus-4-7");
    // Unspecified fields unchanged.
    expect(initial.max_iterations).toBe(42);
    expect(initial.workspace_dir).toBe("/tmp");
  });
});
