// =============================================================================
// Tests: TUI Polish (4.7)
//
// Welcome screen, diff preview, status bar hints, cancel message.
// =============================================================================

import { describe, expect, test, afterEach } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { WelcomeScreen } from "../src/tui/components/welcome_screen.js";
import { StatusBar } from "../src/tui/components/status_bar.js";
import { PermissionPrompt } from "../src/tui/components/permission_prompt.js";
import { generateDiffPreview, formatEditDiff } from "../src/tui/utils/diff_preview.js";
import type { PendingPermission } from "../src/tui/types.js";
import { App } from "../src/tui/app.js";
import type { LLMProvider, LLMStreamEvent } from "../src/agent/provider.js";
import type { HawkyConfig } from "../src/agent/types.js";
import { AgentLoopSource } from "./helpers/mock-agent-source.js";

// =============================================================================
// Welcome Screen
// =============================================================================

describe("WelcomeScreen", () => {
  test("renders model name", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="claude-sonnet-4-6" workingDirectory="/tmp/test" />,
    );
    expect(lastFrame()).toContain("claude-sonnet-4-6");
  });

  test("renders Hawky version", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" />,
    );
    expect(lastFrame()).toContain("Hawky");
  });

  test("renders working directory", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/home/user/project" />,
    );
    expect(lastFrame()).toContain("project");
  });

  test("renders git branch when provided", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" gitBranch="main" gitClean={true} />,
    );
    expect(lastFrame()).toContain("main");
  });

  test("renders git clean indicator", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" gitBranch="main" gitClean={true} />,
    );
    expect(lastFrame()).toContain("✓");
  });

  test("renders git dirty indicator", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" gitBranch="feature" gitClean={false} />,
    );
    expect(lastFrame()).toContain("●");
  });

  test("renders tips section", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" />,
    );
    const output = lastFrame();
    expect(output).toContain("/help");
    expect(output).toContain("Ctrl+J");
    expect(output).toContain("Esc");
  });

  test("renders session info", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" sessionInfo="Resumed session abc-123" />,
    );
    expect(lastFrame()).toContain("Resumed session abc-123");
  });

  test("renders figlet Hao AI Lab text", () => {
    const { lastFrame } = inkRender(
      <WelcomeScreen model="test" workingDirectory="/tmp" />,
    );
    // Figlet text contains distinctive characters
    expect(lastFrame()).toContain("|_|");
  });
});

// =============================================================================
// Status Bar — interrupt hint
// =============================================================================

describe("StatusBar — interrupt hint", () => {
  test("shows '(esc to interrupt)' during thinking", () => {
    const { lastFrame } = inkRender(
      <StatusBar status="thinking" model="test" />,
    );
    expect(lastFrame()).toContain("esc to interrupt");
  });

  test("shows '(esc to interrupt)' during streaming", () => {
    const { lastFrame } = inkRender(
      <StatusBar status="streaming" model="test" />,
    );
    expect(lastFrame()).toContain("esc to interrupt");
  });

  test("no interrupt hint when idle", () => {
    const { lastFrame } = inkRender(
      <StatusBar status="idle" model="test" />,
    );
    expect(lastFrame()).not.toContain("esc to interrupt");
  });

  test("no interrupt hint on error", () => {
    const { lastFrame } = inkRender(
      <StatusBar status="error" model="test" />,
    );
    expect(lastFrame()).not.toContain("esc to interrupt");
  });
});

// =============================================================================
// Diff Preview
// =============================================================================

describe("generateDiffPreview", () => {
  test("new file shows all additions", () => {
    const result = generateDiffPreview(null, "line 1\nline 2\nline 3");
    expect(result).toContain("+ line 1");
    expect(result).toContain("+ line 2");
    expect(result).toContain("+ line 3");
    // Green color
    expect(result).toContain("\x1b[32m");
  });

  test("truncates long new file", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = generateDiffPreview(null, lines);
    expect(result).toContain("more lines");
  });

  test("changed lines show red and green", () => {
    const result = generateDiffPreview("old line", "new line");
    expect(result).toContain("\x1b[31m"); // Red for removal
    expect(result).toContain("\x1b[32m"); // Green for addition
    expect(result).toContain("old line");
    expect(result).toContain("new line");
  });
});

describe("formatEditDiff", () => {
  test("shows old as red, new as green", () => {
    const result = formatEditDiff("const x = 1;", "const x = 42;");
    expect(result).toContain("\x1b[31m- const x = 1;\x1b[0m");
    expect(result).toContain("\x1b[32m+ const x = 42;\x1b[0m");
  });

  test("multi-line edit", () => {
    const result = formatEditDiff("a\nb", "c\nd\ne");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
    expect(result).toContain("+ c");
    expect(result).toContain("+ d");
    expect(result).toContain("+ e");
  });

  test("truncates long diffs", () => {
    const old = Array.from({ length: 10 }, (_, i) => `old ${i}`).join("\n");
    const nw = Array.from({ length: 10 }, (_, i) => `new ${i}`).join("\n");
    const result = formatEditDiff(old, nw);
    expect(result).toContain("more lines");
  });

  test("empty old string (new content)", () => {
    const result = formatEditDiff("", "new content");
    expect(result).toContain("+ new content");
  });
});

// =============================================================================
// Permission Prompt with diff
// =============================================================================

describe("PermissionPrompt — diff preview", () => {
  test("edit_file shows diff", () => {
    const perm: PendingPermission = {
      id: "tu_1",
      toolUseId: "tu_1",
      toolName: "edit_file",
      toolInput: {
        file_path: "/src/index.ts",
        old_string: "const x = 1;",
        new_string: "const x = 42;",
      },
    };
    const { lastFrame } = inkRender(
      <PermissionPrompt permission={perm} onRespond={() => {}} />,
    );
    const output = lastFrame();
    expect(output).toContain("edit_file");
    expect(output).toContain("/src/index.ts");
    // Diff should be visible
    expect(output).toContain("const x = 1;");
    expect(output).toContain("const x = 42;");
  });

  test("bash does not show diff", () => {
    const perm: PendingPermission = {
      id: "tu_1",
      toolUseId: "tu_1",
      toolName: "bash",
      toolInput: { command: "echo hello" },
    };
    const { lastFrame } = inkRender(
      <PermissionPrompt permission={perm} onRespond={() => {}} />,
    );
    // Should not have diff markers
    expect(lastFrame()).not.toContain("+ ");
    expect(lastFrame()).not.toContain("- ");
  });
});

// =============================================================================
// Channel removal verification (moved from test-session-integration.tsx)
// =============================================================================

class SimpleProvider implements LLMProvider {
  async *stream(): AsyncGenerator<LLMStreamEvent> {
    yield { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } };
    yield { type: "text_delta", text: "hi" };
    yield { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 2 } };
    yield { type: "message_stop" };
  }
}

function makeAppConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
  } as HawkyConfig;
}

describe("Channel removal — no # in App output", () => {
  test("welcome banner has no channel hash", () => {
    const { lastFrame, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(new SimpleProvider(), makeAppConfig())} sessionKey="test:main" />,
    );
    expect(lastFrame()).toContain("Hawky");
    expect(lastFrame()).not.toContain("#");
    unmount();
  });

  test("status bar has no channel hash", () => {
    const { lastFrame, unmount } = inkRender(
      <App model="claude-sonnet-4-6" agentSource={new AgentLoopSource(new SimpleProvider(), makeAppConfig())} sessionKey="test:main" />,
    );
    const hashCount = (lastFrame().match(/#/g) || []).length;
    expect(hashCount).toBe(0);
    unmount();
  });
});
