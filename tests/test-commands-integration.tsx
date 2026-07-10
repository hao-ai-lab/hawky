// =============================================================================
// Slash Commands — TUI Integration Tests
//
// Tests commands through the full App component with ink-testing-library.
// Verifies commands show output in message list and modify app state.
// =============================================================================

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { App } from "../src/tui/app.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HawkyConfig } from "../src/agent/types.js";
import type { LLMProvider, LLMStreamRequest, LLMStreamEvent } from "../src/agent/provider.js";
import { LLMError } from "../src/agent/provider.js";
import { AgentLoopSource } from "./helpers/mock-agent-source.js";

const tick = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

// =============================================================================
// Mock Provider
// =============================================================================

class MockProvider implements LLMProvider {
  private responses: LLMStreamEvent[][] = [];
  callCount = 0;

  addResponse(events: LLMStreamEvent[]) {
    this.responses.push(events);
  }

  async *stream(request: LLMStreamRequest, signal?: AbortSignal): AsyncGenerator<LLMStreamEvent> {
    const events = this.responses[this.callCount++] ?? [];
    for (const event of events) {
      if (signal?.aborted) throw new LLMError("aborted", "aborted");
      await new Promise((r) => setTimeout(r, 5));
      yield event;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
  };
}

function textResponse(text: string): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: "msg_1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "text_delta", text },
    { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

// =============================================================================
// /help through TUI
// =============================================================================

describe("Commands via TUI", () => {
  test("/help shows command list", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/help");
    await tick();
    stdin.write("\r");
    await tick();

    const output = lastFrame();
    expect(output).toContain("/help");
    expect(output).toContain("/exit");
    expect(output).toContain("/clear");
    expect(output).toContain("/new");
    expect(output).toContain("/model");

    unmount();
  });

  test("/help does not call the agent", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("should not be called"));

    const { stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/help");
    await tick();
    stdin.write("\r");
    await tick();

    // Provider should not have been called
    expect(provider.callCount).toBe(0);

    unmount();
  });

  test("/model shows current model", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick();

    expect(lastFrame()).toContain("claude-sonnet-4-6");

    unmount();
  });

  test("/status opens status panel", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/status");
    await tick();
    stdin.write("\r");
    await tick();

    const output = lastFrame();
    // Panel should show tab headers
    expect(output).toContain("Cost");
    expect(output).toContain("Usage");
    expect(output).toContain("Errors");

    unmount();
  });

  test("/history shows stats", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("reply"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    // Send a real message first to get some history
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick(800); // Needs enough time for agent loop to complete

    // Now check history
    stdin.write("/history");
    await tick();
    stdin.write("\r");
    await tick(200);

    const output = lastFrame();
    expect(output).toContain("Messages:");
    expect(output).toContain("tokens");

    unmount();
  });

  test("/clear clears message state and confirms", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("Hello!"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    // Clear (even without prior messages, should confirm)
    stdin.write("/clear");
    await tick();
    stdin.write("\r");
    await tick();

    // Note: Ink's <Static> preserves already-rendered items,
    // but the internal message state is cleared. New messages
    // after /clear won't include old ones.
    expect(lastFrame()).toContain("cleared");

    unmount();
  });

  test("unknown command shows error", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/nonexistent");
    await tick();
    stdin.write("\r");
    await tick();

    expect(lastFrame()).toContain("Unknown command");

    unmount();
  });

  test("/HELP is case-insensitive", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/HELP");
    await tick();
    stdin.write("\r");
    await tick();

    expect(lastFrame()).toContain("/help");

    unmount();
  });

  test("non-command text is sent to agent", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("Agent reply!"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("hello agent");
    await tick();
    stdin.write("\r");
    await tick(500);

    expect(lastFrame()).toContain("Agent reply!");
    expect(provider.callCount).toBe(1);

    unmount();
  });

  test("/compact triggers compaction (no inline output)", async () => {
    const provider = new MockProvider();
    provider.addResponse(textResponse("hi"));

    const { lastFrame, stdin, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(provider, makeConfig())} sessionKey="test:main" />,
    );

    stdin.write("/compact");
    await tick();
    stdin.write("\r");
    await tick();

    // /compact now triggers compaction via RPC — no inline text output.
    // It should NOT show "not yet implemented" or any error.
    expect(lastFrame()).not.toContain("not yet implemented");
    expect(lastFrame()).not.toContain("Unknown command");

    unmount();
  });
});
