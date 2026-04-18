// =============================================================================
// Permission Resolver Tests
//
// Tests the permission pipeline: provider → loop → tool_executor → resolver.
// Uses a mock LLM provider for deterministic behavior — no API calls.
//
// Previously in e2e-api.ts but moved here because they don't need real API.
// =============================================================================

import { describe, expect, test } from "bun:test";
import type { LLMProvider } from "../src/agent/provider.js";
import { AgentLoop } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { HawkyConfig, StreamEvent } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeConfig(overrides?: Partial<HawkyConfig>): HawkyConfig {
  return {
    api_keys: { anthropic: "mock", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "mock-model",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: {
      enabled: false,
      interval_minutes: 30,
      keep_recent_messages: 8,
      active_hours: { start: "08:00", end: "22:00" },
    },
    ...overrides,
  };
}

function collectEvents(loop: AgentLoop): StreamEvent[] {
  const events: StreamEvent[] = [];
  loop.subscribe((e) => events.push(e));
  return events;
}

/**
 * Mock provider that returns a tool_use on first call, text on second.
 * Deterministic — no LLM randomness.
 */
function createToolCallProvider(toolName: string, toolInput: Record<string, unknown>): LLMProvider {
  let callCount = 0;
  return {
    async *stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "message_start" as const, message_id: `msg_${callCount}`, model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        yield { type: "tool_use_start" as const, index: 0, id: `tool_${callCount}`, name: toolName };
        yield { type: "tool_use_input_delta" as const, partial_json: JSON.stringify(toolInput) };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 10 } };
        yield { type: "message_stop" as const };
      } else {
        yield { type: "message_start" as const, message_id: `msg_${callCount}`, model: "mock", usage: { input_tokens: 20, output_tokens: 5 } };
        yield { type: "text_delta" as const, text: "Done." };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" as const };
      }
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("permission resolver: approve flow", () => {
  test("allow_once permits tool execution", async () => {
    const provider = createToolCallProvider("bash", { command: "mkdir -p /tmp/hawky_perm_test" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    const permissionResolver = {
      ask: async () => "allow_once" as const,
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    // Tool should have been called
    const toolStarts = events.filter((e) => e.type === "tool_use_start");
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0] as any).name).toBe("bash");

    // Tool result should show successful execution
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).is_error).toBe(false);
    // rm on non-existent file should return error or empty output — just verify it ran
    expect((toolResults[0] as any).content).toBeTruthy();

    // Agent should complete
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
  });

  test("allow_always permits tool and caches decision", async () => {
    // Provider returns tool_use twice (two iterations)
    let callCount = 0;
    const provider: LLMProvider = {
      async *stream() {
        callCount++;
        if (callCount <= 2) {
          yield { type: "message_start" as const, message_id: `msg_${callCount}`, model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
          yield { type: "tool_use_start" as const, index: 0, id: `tool_${callCount}`, name: "bash" };
          yield { type: "tool_use_input_delta" as const, partial_json: `{"command":"mkdir -p /tmp/hawky_call${callCount}"}` };
          yield { type: "content_block_stop" as const, index: 0 };
          yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 10 } };
          yield { type: "message_stop" as const };
        } else {
          yield { type: "message_start" as const, message_id: `msg_${callCount}`, model: "mock", usage: { input_tokens: 20, output_tokens: 5 } };
          yield { type: "text_delta" as const, text: "Done." };
          yield { type: "content_block_stop" as const, index: 0 };
          yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
          yield { type: "message_stop" as const };
        }
      },
    };

    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCount = 0;
    const permissionResolver = {
      ask: async () => { askCount++; return "allow_always" as const; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    // Two tool calls should have executed
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(2);

    // Bash: allow_always saves exact command, so different commands prompt separately
    // (secure behavior — each unique bash command gets its own approval)
    expect(askCount).toBe(2);
  });
});

describe("permission resolver: deny flow", () => {
  test("deny prevents tool execution", async () => {
    const provider = createToolCallProvider("bash", { command: "mkdir -p /tmp/hawky_denied_test" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    const permissionResolver = {
      ask: async () => ({ decision: "deny" as const }),
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    // Tool result should show denial
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).is_error).toBe(true);
    expect((toolResults[0] as any).content).toContain("denied");

    // Agent should still complete (gracefully handles denial)
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
  });

  test("deny on first tool denies all subsequent tools in batch", async () => {
    // Provider returns two tool calls on first call, text on second
    let callCount = 0;
    const provider: LLMProvider = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield { type: "message_start" as const, message_id: "msg_batch", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
          // First tool
          yield { type: "tool_use_start" as const, index: 0, id: "tool_a", name: "bash" };
          yield { type: "tool_use_input_delta" as const, partial_json: '{"command":"mkdir -p /tmp/hawky_batch_a"}' };
          yield { type: "content_block_stop" as const, index: 0 };
          // Second tool
          yield { type: "tool_use_start" as const, index: 1, id: "tool_b", name: "bash" };
          yield { type: "tool_use_input_delta" as const, partial_json: '{"command":"mkdir -p /tmp/hawky_batch_b"}' };
          yield { type: "content_block_stop" as const, index: 1 };
          yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 20 } };
          yield { type: "message_stop" as const };
        } else {
          yield { type: "message_start" as const, message_id: "msg_batch2", model: "mock", usage: { input_tokens: 20, output_tokens: 5 } };
          yield { type: "text_delta" as const, text: "Both tools were denied." };
          yield { type: "content_block_stop" as const, index: 0 };
          yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
          yield { type: "message_stop" as const };
        }
      },
    };

    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    const permissionResolver = {
      ask: async () => ({ decision: "deny" as const }),
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    // Both tools should be denied
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(2);
    expect((toolResults[0] as any).is_error).toBe(true);
    expect((toolResults[1] as any).is_error).toBe(true);
  });
});

describe("permission resolver: auto_approve flow", () => {
  test("auto_approve tools skip permission resolver entirely", async () => {
    const provider = createToolCallProvider("bash", { command: "echo AUTO" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    // Override permission to auto_approve
    registry.register({ ...bashToolDefinition, permission: "auto_approve" } as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return "allow_once" as const; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    // Tool should have executed
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).is_error).toBe(false);

    // Permission resolver should NOT have been called
    expect(askCalled).toBe(false);
  });
});

// =============================================================================
// Cancel during permission
// =============================================================================

describe("cancel during permission: agent unblocks", () => {
  test("cancel during permission resolves ask() as deny and loop completes", async () => {
    const provider = createToolCallProvider("bash", { command: "rm -rf /important" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    // Permission resolver that simulates a user pressing Esc:
    // waits 50ms, then the cancel fires, then resolves as deny.
    let cancelFn: (() => void) | null = null;
    const permissionResolver = {
      ask: () => new Promise((resolve) => {
        cancelFn = () => resolve({ decision: "deny" as const });
      }),
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    // Start sendMessage (non-blocking — it will block on permission)
    const sendPromise = loop.sendMessage("test");

    // Wait for permission to be requested
    await new Promise((r) => setTimeout(r, 100));

    // Simulate Esc: cancel the loop + resolve pending permission
    loop.cancel();
    cancelFn?.();

    // sendMessage should now complete
    await sendPromise;

    // The tool result should be a denial
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).is_error).toBe(true);

    // Agent should be idle
    expect(loop.isRunning()).toBe(false);
  });

  test("subsequent message works after cancel during permission", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          // First call: tool_use that needs permission
          yield { type: "message_start" as const, message_id: "msg_1", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
          yield { type: "tool_use_start" as const, index: 0, id: "tool_1", name: "bash" };
          yield { type: "tool_use_input_delta" as const, partial_json: '{"command":"rm -rf /"}' };
          yield { type: "content_block_stop" as const, index: 0 };
          yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 10 } };
          yield { type: "message_stop" as const };
        } else {
          // Subsequent calls: simple text response
          yield { type: "message_start" as const, message_id: `msg_${callCount}`, model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
          yield { type: "text_delta" as const, text: "Hello after cancel!" };
          yield { type: "content_block_stop" as const, index: 0 };
          yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
          yield { type: "message_stop" as const };
        }
      },
    };

    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let cancelFn: (() => void) | null = null;
    const permissionResolver = {
      ask: () => new Promise((resolve) => {
        cancelFn = () => resolve({ decision: "deny" as const });
      }),
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });

    // First message: will block on permission
    const events1 = collectEvents(loop);
    const send1 = loop.sendMessage("do something dangerous");

    await new Promise((r) => setTimeout(r, 100));
    loop.cancel();
    cancelFn?.();
    await send1;

    expect(loop.isRunning()).toBe(false);

    // Second message: should work normally (no leftover blocked state)
    const events2: StreamEvent[] = [];
    loop.subscribe((e) => events2.push(e));
    await loop.sendMessage("hello");

    const textEvents = events2.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    expect((textEvents[0] as any).content).toContain("Hello after cancel");
    expect(loop.isRunning()).toBe(false);
  });
});

// =============================================================================
// WS permission cancel
// =============================================================================

import {
  createWsPermissionResolver,
  resolveWsPermission,
  cancelPendingPermissions,
  resetWsPermissions,
  getPendingPermissionForSession,
} from "../src/gateway/ws-permission.js";

describe("WS permission: cancelPendingPermissions", () => {
  test("cancel resolves pending permission as deny", async () => {
    resetWsPermissions();

    const mockServer = {
      broadcastToSession: () => {},
    } as any;

    const resolver = createWsPermissionResolver("test:session", mockServer);

    // Start permission request (non-blocking)
    const decisionPromise = resolver.ask("tool_1", "bash", { command: "rm" });

    // Cancel all pending for this session
    const cancelled = cancelPendingPermissions("test:session");
    expect(cancelled).toBe(1);

    // Should resolve as deny
    const decision = await decisionPromise;
    expect(decision).toEqual({ decision: "deny" });
  });

  test("cancel only affects the specified session", async () => {
    resetWsPermissions();

    const mockServer = {
      broadcastToSession: () => {},
    } as any;

    const resolverA = createWsPermissionResolver("session:a", mockServer);
    const resolverB = createWsPermissionResolver("session:b", mockServer);

    const promiseA = resolverA.ask("tool_a", "bash", { command: "a" });
    const promiseB = resolverB.ask("tool_b", "bash", { command: "b" });

    // Cancel only session A
    cancelPendingPermissions("session:a");

    const decisionA = await promiseA;
    expect(decisionA).toEqual({ decision: "deny" });

    // Session B should still be pending — resolve it manually
    resolveWsPermission("perm-2", "allow_once");
    const decisionB = await promiseB;
    expect(decisionB).toEqual({ decision: "allow_once" });
  });

  test("cancel after resolve is a no-op", async () => {
    resetWsPermissions();

    const mockServer = {
      broadcastToSession: () => {},
    } as any;

    const resolver = createWsPermissionResolver("test:session", mockServer);
    const promise = resolver.ask("tool_1", "bash", { command: "test" });

    // Resolve first
    resolveWsPermission("perm-1", "allow_once");
    const decision = await promise;
    expect(decision).toEqual({ decision: "allow_once" });

    // Cancel should be harmless (no pending to cancel)
    const cancelled = cancelPendingPermissions("test:session");
    expect(cancelled).toBe(0);
  });

  test("permission stays pending indefinitely (no timeout)", async () => {
    resetWsPermissions();

    const mockServer = {
      broadcastToSession: () => {},
    } as any;

    const resolver = createWsPermissionResolver("test:session", mockServer);
    const promise = resolver.ask("tool_1", "bash", { command: "test" });

    // Wait 200ms — permission should still be pending (not auto-denied)
    await new Promise((r) => setTimeout(r, 200));

    // Verify it's still pending by checking cancel returns 1
    const cancelled = cancelPendingPermissions("test:session");
    expect(cancelled).toBe(1);

    const decision = await promise;
    expect(decision).toEqual({ decision: "deny" }); // cancelled = deny
  });
});

// =============================================================================
// Safe bash command allowlist
// =============================================================================

describe("safe bash command allowlist", () => {
  test("safe read-only commands skip permission resolver", async () => {
    // Use "git status" which is in the safe allowlist
    const provider = createToolCallProvider("bash", { command: "git status" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return "allow_once" as const; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    const events = collectEvents(loop);

    await loop.sendMessage("test");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBe(1);
    // Permission resolver should NOT have been called (safe command)
    expect(askCalled).toBe(false);
  });

  test("safe piped commands skip permission resolver", async () => {
    const provider = createToolCallProvider("bash", { command: "cat /etc/hostname | grep local" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return "allow_once" as const; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    collectEvents(loop);

    await loop.sendMessage("test");
    expect(askCalled).toBe(false);
  });

  test("unsafe commands still require permission", async () => {
    const provider = createToolCallProvider("bash", { command: "npm install express" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return "allow_once" as const; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    collectEvents(loop);

    await loop.sendMessage("test");
    expect(askCalled).toBe(true);
  });

  test("commands with shell operators require permission", async () => {
    // Even if individual parts are safe, && chains need approval
    const provider = createToolCallProvider("bash", { command: "echo hello && rm -rf /" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return { decision: "deny" as const }; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    collectEvents(loop);

    await loop.sendMessage("test");
    expect(askCalled).toBe(true);
  });

  test("find commands require permission", async () => {
    const provider = createToolCallProvider("bash", { command: "find . -delete" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return { decision: "deny" as const }; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    collectEvents(loop);

    await loop.sendMessage("test");
    expect(askCalled).toBe(true);
  });

  test("sort with output flag requires permission", async () => {
    const provider = createToolCallProvider("bash", { command: "sort -o /tmp/out.txt /tmp/in.txt" });
    const registry = new ToolRegistry();
    const { bashToolDefinition } = await import("../src/tools/bash.js");
    registry.register(bashToolDefinition as any);

    let askCalled = false;
    const permissionResolver = {
      ask: async () => { askCalled = true; return { decision: "deny" as const }; },
    };

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: "/tmp",
      permissionResolver,
    });
    collectEvents(loop);

    await loop.sendMessage("test");
    expect(askCalled).toBe(true);
  });
});

describe("WS permission: getPendingPermissionForSession (late-join lookup)", () => {
  test("returns null when nothing is pending", () => {
    resetWsPermissions();
    expect(getPendingPermissionForSession("test:session")).toBeNull();
  });

  test("returns the dialog payload while a request is open, then null after resolve", async () => {
    // A 2nd browser tab opened AFTER the original broadcast (or the
    // iPhone after a screen-on) won't have received the permission.request
    // event. session.currentTurn calls this helper to surface enough of
    // the dialog to render it; resolving must clear the entry so a
    // subsequent late-join doesn't see a stale prompt.
    resetWsPermissions();
    const mockServer = { broadcastToSession: () => {} } as any;
    const resolver = createWsPermissionResolver("test:session", mockServer);

    const promise = resolver.ask("tool_x", "bash", { command: "echo hi" });

    const pending = getPendingPermissionForSession("test:session");
    expect(pending).not.toBeNull();
    expect(pending!.dialog.toolName).toBe("bash");
    expect(pending!.dialog.toolInput).toEqual({ command: "echo hi" });
    expect(pending!.dialog.toolUseId).toBe("tool_x");

    // Different session sees nothing.
    expect(getPendingPermissionForSession("other:session")).toBeNull();

    resolveWsPermission(pending!.requestId, "allow_once");
    await promise;
    expect(getPendingPermissionForSession("test:session")).toBeNull();
  });
});
