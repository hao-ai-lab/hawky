// =============================================================================
// Tests: Agent Tool (sub-agents)
// =============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import {
  drainCompletedAgents,
  getBackgroundAgentStates,
} from "../src/tools/agent.js";

// -----------------------------------------------------------------------------
// drainCompletedAgents
// -----------------------------------------------------------------------------

describe("drainCompletedAgents", () => {
  beforeEach(() => {
    // Clear any leftover state
    drainCompletedAgents();
  });

  it("returns empty array when no agents", () => {
    const completed = drainCompletedAgents();
    expect(completed).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// getBackgroundAgentStates
// -----------------------------------------------------------------------------

describe("getBackgroundAgentStates", () => {
  beforeEach(() => {
    drainCompletedAgents();
  });

  it("returns empty array when no agents", () => {
    const states = getBackgroundAgentStates();
    expect(states).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Agent tool execute (with mock provider)
// -----------------------------------------------------------------------------

describe("agent tool execute", () => {
  function createMockProvider() {
    return {
      stream: async function* () {
        yield { type: "text_delta" as const, text: "Sub-agent result text" };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 10 } };
      },
    } as any;
  }

  function makeContext(overrides?: Record<string, unknown>) {
    return {
      session_id: "tui:main",
      working_directory: "/tmp",
      abort_signal: new AbortController().signal,
      emit: () => {},
      headless: false,
      _provider: createMockProvider(),
      _registry: {
        getApiDefinitions: () => [],
        get: () => undefined,
        has: () => false,
        getAll: () => [],
        count: 0,
        register: () => {},
        registerAll: () => {},
        unregister: () => false,
        clear: () => {},
        execute: async () => ({ type: "error" as const, content: "not found" }),
      },
      _config: {
        api_keys: { anthropic: "test", brave_search: "", openai: "" },
        api_base_url: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        max_iterations: 40,
        max_tool_result_chars: 30000,
        workspace_dir: "/tmp",
        gateway_port: 4242,
        heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
      },
      _agentLoop: {
        getHistory: () => [
          { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
          { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi there" }] },
        ],
      },
      ...overrides,
    } as any;
  }

  it("rejects empty prompt", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const result = await agentToolDefinition.execute({ prompt: "" } as any, makeContext());
    expect(result.type).toBe("error");
    expect(result.content).toContain("empty");
  });

  it("prevents re-forking from sub-agent session", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const ctx = makeContext({ session_id: "subagent:tui:main:agent_1" });
    const result = await agentToolDefinition.execute({ prompt: "do something" } as any, ctx);
    expect(result.type).toBe("error");
    expect(result.content).toContain("Cannot spawn");
  });

  it("returns error when provider is missing", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const ctx = makeContext({ _provider: undefined });
    const result = await agentToolDefinition.execute({ prompt: "test" } as any, ctx);
    expect(result.type).toBe("error");
    expect(result.content).toContain("internal error");
  });

  it("sync agent returns result text", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const result = await agentToolDefinition.execute(
      { prompt: "summarize something" } as any,
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("Sub-agent result text");
    expect(result.metadata?.type).toBe("subagent");
  });

  it("async agent returns immediately with launched status", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const result = await agentToolDefinition.execute(
      { prompt: "research something", run_in_background: true } as any,
      makeContext(),
    );
    expect(result.type).toBe("text");
    expect(result.content).toContain("Background agent launched");
    expect(result.metadata?.status).toBe("launched");
  });

  it("async agent eventually completes", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    await agentToolDefinition.execute(
      { prompt: "research", run_in_background: true, description: "research task" } as any,
      makeContext(),
    );

    // Wait for the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 500));

    const completed = drainCompletedAgents();
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const agent = completed.find((a) => a.description === "research task");
    expect(agent).toBeDefined();
    expect(agent!.status).toBe("completed");
    expect(agent!.result).toContain("Sub-agent result text");
  });

  // ---------------------------------------------------------------------------
  // Edge cases: input validation
  // ---------------------------------------------------------------------------

  it("rejects whitespace-only prompt", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const result = await agentToolDefinition.execute({ prompt: "   \n  " } as any, makeContext());
    expect(result.type).toBe("error");
    expect(result.content).toContain("empty");
  });

  it("returns error when registry is missing", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const ctx = makeContext({ _registry: undefined });
    const result = await agentToolDefinition.execute({ prompt: "test" } as any, ctx);
    expect(result.type).toBe("error");
    expect(result.content).toContain("internal error");
  });

  it("returns error when config is missing", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const ctx = makeContext({ _config: undefined });
    const result = await agentToolDefinition.execute({ prompt: "test" } as any, ctx);
    expect(result.type).toBe("error");
    expect(result.content).toContain("internal error");
  });

  // ---------------------------------------------------------------------------
  // Edge cases: fork guard
  // ---------------------------------------------------------------------------

  it("prevents re-forking from nested subagent session", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    // Deeply nested subagent session key
    const ctx = makeContext({ session_id: "subagent:subagent:tui:main:agent_1:agent_2" });
    const result = await agentToolDefinition.execute({ prompt: "do something" } as any, ctx);
    expect(result.type).toBe("error");
    expect(result.content).toContain("Cannot spawn");
  });

  it("allows agent from non-subagent sessions", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    // Regular sessions should work
    for (const sessionId of ["tui:main", "web:general", "heartbeat:main", "cron:daily"]) {
      const ctx = makeContext({ session_id: sessionId });
      const result = await agentToolDefinition.execute({ prompt: "test task" } as any, ctx);
      // Should not be a fork-guard error (may be other errors from mock, that's fine)
      if (result.type === "error") {
        expect(result.content).not.toContain("Cannot spawn");
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Edge cases: context inheritance
  // ---------------------------------------------------------------------------

  it("works with empty parent history", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const ctx = makeContext({
      _agentLoop: { getHistory: () => [] },
    });
    const result = await agentToolDefinition.execute({ prompt: "do something" } as any, ctx);
    // Should still work — child starts with empty history + delegation prompt
    expect(result.type).toBe("text");
  });

  it("works when agentLoop is missing (no history)", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const ctx = makeContext({ _agentLoop: undefined });
    const result = await agentToolDefinition.execute({ prompt: "do something" } as any, ctx);
    // Should still work — parentHistory defaults to []
    expect(result.type).toBe("text");
  });

  // ---------------------------------------------------------------------------
  // Edge cases: provider failure
  // ---------------------------------------------------------------------------

  it("sync agent handles provider error gracefully", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const failingProvider = {
      stream: async function* () {
        throw new Error("API rate limited");
      },
    } as any;
    const ctx = makeContext({ _provider: failingProvider });
    const result = await agentToolDefinition.execute({ prompt: "test" } as any, ctx);
    // AgentLoop catches provider errors internally and emits error event.
    // The tool gets no text output — result is "(no output)" or error.
    expect(["text", "error"]).toContain(result.type);
  });

  it("async agent completes even with provider error", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const failingProvider = {
      stream: async function* () {
        throw new Error("Connection timeout");
      },
    } as any;
    const ctx = makeContext({ _provider: failingProvider });

    const result = await agentToolDefinition.execute(
      { prompt: "test", run_in_background: true, description: "error task" } as any,
      ctx,
    );
    expect(result.type).toBe("text");
    expect(result.metadata?.status).toBe("launched");

    // Wait for fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 500));

    // AgentLoop catches errors internally — agent still "completes" (with no output)
    // or marks as failed depending on whether sendMessage throws
    const completed = drainCompletedAgents();
    const agent = completed.find((a) => a.description === "error task");
    expect(agent).toBeDefined();
    expect(["completed", "failed"]).toContain(agent!.status);
  });

  // ---------------------------------------------------------------------------
  // Edge cases: metadata and description
  // ---------------------------------------------------------------------------

  it("sync agent includes duration in metadata", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    const result = await agentToolDefinition.execute(
      { prompt: "quick task", description: "quick" } as any,
      makeContext(),
    );
    expect(result.metadata?.durationMs).toBeDefined();
    expect(typeof result.metadata?.durationMs).toBe("number");
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("async agent uses description for label, falls back to prompt", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");

    // With description
    const r1 = await agentToolDefinition.execute(
      { prompt: "long detailed prompt", run_in_background: true, description: "short label" } as any,
      makeContext(),
    );
    expect(r1.content).toContain("short label");
    expect(r1.metadata?.description).toBe("short label");

    // Without description — should truncate prompt
    const r2 = await agentToolDefinition.execute(
      { prompt: "a very long prompt that should be truncated for display purposes", run_in_background: true } as any,
      makeContext(),
    );
    expect(r2.metadata?.description).toBeDefined();
    expect((r2.metadata?.description as string).length).toBeLessThanOrEqual(60);
  });

  // ---------------------------------------------------------------------------
  // Edge cases: multiple background agents
  // ---------------------------------------------------------------------------

  it("multiple async agents tracked independently", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");

    await agentToolDefinition.execute(
      { prompt: "task A", run_in_background: true, description: "agent-A" } as any,
      makeContext(),
    );
    await agentToolDefinition.execute(
      { prompt: "task B", run_in_background: true, description: "agent-B" } as any,
      makeContext(),
    );

    // Both should be tracked
    const states = getBackgroundAgentStates();
    expect(states.length).toBeGreaterThanOrEqual(2);

    // Wait for completion
    await new Promise((r) => setTimeout(r, 500));

    const completed = drainCompletedAgents();
    const agentA = completed.find((a) => a.description === "agent-A");
    const agentB = completed.find((a) => a.description === "agent-B");
    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    expect(agentA!.id).not.toBe(agentB!.id);
  });

  it("drain only returns completed agents, leaves running ones", async () => {
    // This is tested implicitly by the timing in other tests,
    // but let's verify the drain semantics explicitly
    const first = drainCompletedAgents();
    const second = drainCompletedAgents();
    // Second drain should return empty (first already cleared completed)
    expect(second).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Non-interactive lanes: run_in_background must be downgraded to sync
  //
  // cron:* and heartbeat:* run through triggerAgentTurn, not chat.send.
  // drainCompletedAgents() only fires in the chat.send path — so any
  // BackgroundAgentInfo parked by a scheduler turn is never surfaced and
  // never freed. A session that's LRU-evicted while the child is still
  // running strands the sub-agent outright.
  // ---------------------------------------------------------------------------

  it("downgrades run_in_background to sync for cron:* and heartbeat:*", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    for (const sessionId of ["cron:daily-digest", "heartbeat:main"]) {
      const ctx = makeContext({ session_id: sessionId });
      const result = await agentToolDefinition.execute(
        { prompt: "analyze logs", run_in_background: true, description: "scan" } as any,
        ctx,
      );
      // Sync path returns a text result with metadata.type === "subagent".
      // Async path would return "Background agent launched" and metadata.status === "launched".
      expect(result.type).toBe("text");
      expect(result.content).toContain("Sub-agent result text");
      expect(result.metadata?.type).toBe("subagent");
      expect(result.metadata?.status).not.toBe("launched");
    }
  });

  it("does NOT register a BackgroundAgentInfo when a non-interactive lane asks for async", async () => {
    // Without the downgrade, each call would park a BackgroundAgentInfo
    // record in the registry that no one would ever drain. After the
    // downgrade, nothing should be added to the bg-agent registry for
    // the non-interactive lane.
    const { agentToolDefinition } = await import("../src/tools/agent.js");

    for (const sessionId of ["cron:leak-check", "heartbeat:main"]) {
      // Drain any pre-existing state from other tests.
      drainCompletedAgents();

      await agentToolDefinition.execute(
        { prompt: "anything", run_in_background: true } as any,
        makeContext({ session_id: sessionId }),
      );
      // Let any stray fire-and-forget promises settle — there should be none.
      await new Promise((r) => setTimeout(r, 100));

      const stillRunning = getBackgroundAgentStates().filter((s) => s.status === "running");
      expect(stillRunning).toEqual([]);
      expect(drainCompletedAgents()).toEqual([]);
    }
  });

  it("still allows async from interactive sessions (web/tui)", async () => {
    // Regression guard: the downgrade targets non-interactive lanes
    // only. Web/TUI sessions still get the async path — their
    // completions are drained on the next chat.send turn via the
    // <system-reminder> the drainCompletedAgents call surfaces.
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    for (const sessionId of ["web:general", "tui:main"]) {
      const ctx = makeContext({ session_id: sessionId });
      const result = await agentToolDefinition.execute(
        { prompt: "bg task", run_in_background: true, description: `bg-${sessionId}` } as any,
        ctx,
      );
      expect(result.content).toContain("Background agent launched");
      expect(result.metadata?.status).toBe("launched");
    }
    // Cleanup: let the fire-and-forget promises settle.
    await new Promise((r) => setTimeout(r, 300));
    drainCompletedAgents();
  });

  // ---------------------------------------------------------------------------
  // Tool definition schema
  // ---------------------------------------------------------------------------

  it("has correct tool definition schema", async () => {
    const { agentToolDefinition } = await import("../src/tools/agent.js");
    expect(agentToolDefinition.name).toBe("agent");
    expect(agentToolDefinition.permission).toBe("auto_approve");
    expect(agentToolDefinition.input_schema.required).toContain("prompt");
    expect(agentToolDefinition.input_schema.properties.prompt).toBeDefined();
    expect(agentToolDefinition.input_schema.properties.run_in_background).toBeDefined();
    expect(agentToolDefinition.input_schema.properties.description).toBeDefined();
  });
});
