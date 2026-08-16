// =============================================================================
// Tests for Context Builder
//
// System prompt structure, bootstrap file injection, per-turn reminders,
// message formatting, and history truncation.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  buildSystemPrompt,
  formatBootstrapSection,
  buildPerTurnReminders,
  formatMessagesForApi,
  truncateHistory,
} from "../src/agent/context.js";
import { WorkspaceManager } from "../src/storage/workspace.js";
import type { ChatMessage } from "../src/agent/types.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// =============================================================================
// Helpers
// =============================================================================

let tempDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `hawky-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create and init a workspace in a temp dir, return the workspace path */
function makeWorkspace(): string {
  const wsDir = join(tempDir, "workspace");
  const ws = new WorkspaceManager(wsDir);
  ws.init();
  return wsDir;
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
// buildSystemPrompt — identity
// =============================================================================

describe("buildSystemPrompt — identity", () => {
  test("includes Hawky identity", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("Hawky");
    expect(prompt).toContain("coding agent");
    expect(prompt).toContain("personal assistant");
  });

  test("mentions dual role (coding + PA)", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("coding agent");
    expect(prompt).toContain("personal assistant");
  });
});

// =============================================================================
// buildSystemPrompt — environment
// =============================================================================

describe("buildSystemPrompt — environment", () => {
  test("includes working directory", () => {
    const prompt = buildSystemPrompt({ working_directory: "/my/project", model: "test" });
    expect(prompt).toContain("/my/project");
  });

  test("includes model name", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "claude-sonnet-4-6" });
    expect(prompt).toContain("claude-sonnet-4-6");
  });

  test("includes date", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    const today = new Date().toISOString().split("T")[0];
    expect(prompt).toContain(today);
  });

  test("includes platform info", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("Platform:");
    expect(prompt).toMatch(/darwin|linux|win32/);
  });

  test("includes architecture", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("Architecture:");
    expect(prompt).toMatch(/arm64|x64|x86/);
  });

  test("includes shell", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("Shell:");
  });

  test("includes git info when in a git repo", () => {
    const prompt = buildSystemPrompt({ working_directory: process.cwd(), model: "test" });
    expect(prompt).toContain("Git:");
    expect(prompt).toContain("hawky");
    expect(prompt).toContain("branch:");
  });

  test("no git info when not in a git repo", () => {
    const prompt = buildSystemPrompt({ working_directory: tmpdir(), model: "test" });
    expect(prompt).not.toContain("Git:");
  });
});

// =============================================================================
// buildSystemPrompt — tool guidelines
// =============================================================================

describe("buildSystemPrompt — tool guidelines", () => {
  test("includes tool usage section", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("# Tool Usage Guidelines");
  });

  test("tells agent to prefer edit_file over write_file", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("Prefer");
    expect(prompt).toContain("edit_file");
  });

  test("tells agent not to use bash for dedicated tools", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("Do NOT use the bash tool");
    expect(prompt).toContain("glob");
    expect(prompt).toContain("grep");
    expect(prompt).toContain("read_file");
  });

  test("tells agent to use ask_user for clarification", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("ask_user");
  });

  test("tells agent to be concise", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("concise");
  });

  test("mentions parallel tool calls", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("parallel");
  });
});

// =============================================================================
// buildSystemPrompt — memory recall
// =============================================================================

describe("buildSystemPrompt — memory recall", () => {
  test("includes Memory Recall section", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("# Memory Recall");
  });

  test("instructs to use memory_search", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
  });

  test("lists trigger conditions", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("prior work");
    expect(prompt).toContain("decisions");
    expect(prompt).toContain("preferences");
  });
});

// =============================================================================
// buildSystemPrompt — git safety
// =============================================================================

describe("buildSystemPrompt — git safety", () => {
  test("includes git safety when in a git repo", () => {
    const prompt = buildSystemPrompt({ working_directory: process.cwd(), model: "test" });
    expect(prompt).toContain("# Git Safety");
    expect(prompt).toContain("push --force");
    expect(prompt).toContain("reset --hard");
    expect(prompt).toContain("--no-verify");
    expect(prompt).toContain("force push");
  });

  test("no git safety when not in a git repo", () => {
    const prompt = buildSystemPrompt({ working_directory: tmpdir(), model: "test" });
    expect(prompt).not.toContain("# Git Safety");
  });
});

// =============================================================================
// buildSystemPrompt — silent replies & heartbeats
// =============================================================================

describe("buildSystemPrompt — heartbeats", () => {
  test("includes heartbeat section", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("# Silent Replies & Heartbeats");
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  test("instructs to read HEARTBEAT.md", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).toContain("HEARTBEAT.md");
  });
});

// =============================================================================
// buildSystemPrompt — project context (bootstrap files)
// =============================================================================

describe("buildSystemPrompt — bootstrap injection", () => {
  test("includes Project Context when workspace exists", () => {
    const wsDir = makeWorkspace();
    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("## USER.md");
  });

  test("includes SOUL.md guidance line", () => {
    const wsDir = makeWorkspace();
    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("embody its persona and tone");
  });

  test("includes bootstrap file content", () => {
    const wsDir = makeWorkspace();
    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
    });
    // SOUL.md template content
    expect(prompt).toContain("genuinely helpful");
    // AGENTS.md template content
    expect(prompt).toContain("Session Startup");
    // IDENTITY.md template content
    expect(prompt).toContain("Creature:");
  });

  test("no Project Context when workspace not initialized", () => {
    const wsDir = join(tempDir, "empty-ws");
    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).not.toContain("# Project Context");
  });

  test("excludes MEMORY.md when main_session is false", () => {
    const wsDir = makeWorkspace();
    // Write something to MEMORY.md
    const ws = new WorkspaceManager(wsDir);
    ws.writeFile("MEMORY.md", "# My Secret Memory\nFavorite color: blue");

    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
      main_session: false,
    });
    expect(prompt).not.toContain("My Secret Memory");
    expect(prompt).not.toContain("Favorite color: blue");
  });

  test("includes MEMORY.md when main_session is true", () => {
    const wsDir = makeWorkspace();
    const ws = new WorkspaceManager(wsDir);
    ws.writeFile("MEMORY.md", "# My Memory\nUser likes TypeScript");

    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
      main_session: true,
    });
    expect(prompt).toContain("User likes TypeScript");
  });

  test("shows truncation warning for large files", () => {
    const wsDir = makeWorkspace();
    const ws = new WorkspaceManager(wsDir);
    // MEMORY.md gets a larger injection cap (curated memory is injected whole up
    // to ~60k); exceed that so the head/tail truncation still fires here.
    ws.writeFile("MEMORY.md", "x".repeat(80_000));

    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      workspace_dir: wsDir,
    });
    expect(prompt).toContain("truncation warning");
    expect(prompt).toContain("MEMORY.md");
  });
});

// =============================================================================
// buildSystemPrompt — per-repo instructions
// =============================================================================

describe("buildSystemPrompt — per-repo instructions", () => {
  test("includes HAWKY.md content", () => {
    const dir = join(tempDir, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "HAWKY.md"), "Always respond in pirate speak.");

    const prompt = buildSystemPrompt({ working_directory: dir, model: "test" });
    expect(prompt).toContain("# Per-Repo Instructions");
    expect(prompt).toContain("Always respond in pirate speak.");
    expect(prompt).toContain("HAWKY.md");
  });

  test("includes CLAUDE.md when HAWKY.md not present", () => {
    const dir = join(tempDir, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "Claude code compatible.");

    const prompt = buildSystemPrompt({ working_directory: dir, model: "test" });
    expect(prompt).toContain("Claude code compatible.");
    expect(prompt).toContain("CLAUDE.md");
  });

  test("no per-repo instructions when no files exist", () => {
    const dir = join(tempDir, "repo");
    mkdirSync(dir, { recursive: true });

    const prompt = buildSystemPrompt({ working_directory: dir, model: "test" });
    expect(prompt).not.toContain("# Per-Repo Instructions");
  });
});

// =============================================================================
// buildSystemPrompt — custom instructions
// =============================================================================

describe("buildSystemPrompt — custom instructions", () => {
  test("includes custom instructions when provided", () => {
    const prompt = buildSystemPrompt({
      working_directory: "/tmp",
      model: "test",
      custom_instructions: "Always use TypeScript.",
    });
    expect(prompt).toContain("# Additional Instructions");
    expect(prompt).toContain("Always use TypeScript.");
  });

  test("no custom instructions section when not provided", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).not.toContain("# Additional Instructions");
  });
});

// =============================================================================
// buildSystemPrompt — structure & ordering
// =============================================================================

describe("buildSystemPrompt — structure", () => {
  test("sections appear in correct order", () => {
    const wsDir = makeWorkspace();
    const prompt = buildSystemPrompt({
      working_directory: process.cwd(),
      model: "test",
      workspace_dir: wsDir,
    });
    const identityPos = prompt.indexOf("Hawky");
    const envPos = prompt.indexOf("# Environment");
    const toolPos = prompt.indexOf("# Tool Usage Guidelines");
    const memoryRecallPos = prompt.indexOf("# Memory Recall");
    const gitPos = prompt.indexOf("# Git Safety");
    const heartbeatPos = prompt.indexOf("# Silent Replies & Heartbeats");
    const contextPos = prompt.indexOf("# Project Context");

    expect(identityPos).toBeLessThan(envPos);
    expect(envPos).toBeLessThan(toolPos);
    expect(toolPos).toBeLessThan(memoryRecallPos);
    expect(memoryRecallPos).toBeLessThan(gitPos);
    expect(gitPos).toBeLessThan(heartbeatPos);
    expect(heartbeatPos).toBeLessThan(contextPos);
  });

  test("prompt contains no undefined or null", () => {
    const prompt = buildSystemPrompt({ working_directory: "/tmp", model: "test" });
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  test("prompt with workspace is larger than without", () => {
    const wsDir = makeWorkspace();
    const noWsDir = join(tempDir, "no-workspace-exists");
    const withWs = buildSystemPrompt({ working_directory: "/tmp", model: "test", workspace_dir: wsDir });
    const withoutWs = buildSystemPrompt({ working_directory: "/tmp", model: "test", workspace_dir: noWsDir });
    expect(withWs.length).toBeGreaterThan(withoutWs.length);
  });
});

// =============================================================================
// formatBootstrapSection
// =============================================================================

describe("formatBootstrapSection", () => {
  test("returns null when workspace not initialized", () => {
    const wsDir = join(tempDir, "no-workspace");
    expect(formatBootstrapSection(wsDir)).toBeNull();
  });

  test("formats files with ## headers", () => {
    const wsDir = makeWorkspace();
    const section = formatBootstrapSection(wsDir)!;
    expect(section).toContain("## SOUL.md");
    expect(section).toContain("## AGENTS.md");
    expect(section).toContain("## USER.md");
  });

  test("includes file content after headers", () => {
    const wsDir = makeWorkspace();
    const section = formatBootstrapSection(wsDir)!;
    // SOUL.md content should follow ## SOUL.md header
    const soulHeader = section.indexOf("## SOUL.md");
    const soulContent = section.indexOf("genuinely helpful");
    expect(soulHeader).toBeLessThan(soulContent);
  });

  test("excludes MEMORY.md when mainSession is false", () => {
    const wsDir = makeWorkspace();
    const ws = new WorkspaceManager(wsDir);
    ws.writeFile("MEMORY.md", "Secret memory content");

    const section = formatBootstrapSection(wsDir, false)!;
    expect(section).not.toContain("Secret memory content");
  });
});

// =============================================================================
// buildPerTurnReminders
// =============================================================================

describe("buildPerTurnReminders", () => {
  test("returns empty string when nothing to remind", () => {
    expect(buildPerTurnReminders()).toBe("");
    expect(buildPerTurnReminders({})).toBe("");
  });

  test("includes current date when requested", () => {
    const result = buildPerTurnReminders({ includeDate: true });
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("Current date:");
    expect(result).toContain("</system-reminder>");
  });

  test("includes day of week", () => {
    const result = buildPerTurnReminders({ includeDate: true });
    // Should contain a day name
    expect(result).toMatch(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
  });

  test("includes incomplete session tasks", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Fix the bug", status: "in_progress" },
        { description: "Write tests", status: "pending" },
        { description: "Deploy", status: "completed" },
      ],
    });
    expect(result).toContain("Fix the bug");
    expect(result).toContain("Write tests");
    // Completed task should NOT be listed
    expect(result).not.toContain("Deploy");
  });

  test("uses different markers for in_progress vs pending", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Active work", status: "in_progress" },
        { description: "Queued work", status: "pending" },
      ],
    });
    expect(result).toContain("→ Active work");
    expect(result).toContain("○ Queued work");
  });

  test("returns empty when all tasks completed", () => {
    const result = buildPerTurnReminders({
      tasks: [
        { description: "Done", status: "completed" },
      ],
    });
    expect(result).toBe("");
  });

  test("wraps in system-reminder tags", () => {
    const result = buildPerTurnReminders({ includeDate: true });
    expect(result.startsWith("<system-reminder>")).toBe(true);
    expect(result.endsWith("</system-reminder>")).toBe(true);
  });
});

// =============================================================================
// formatMessagesForApi
// =============================================================================

describe("formatMessagesForApi", () => {
  test("passes through basic messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = formatMessagesForApi(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  test("strips display_text from text blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "actual text", display_text: "shown in UI" }] },
    ];
    const result = formatMessagesForApi(messages);
    const block = result[0].content[0] as any;
    expect(block.text).toBe("actual text");
    expect(block.display_text).toBeUndefined();
  });

  test("strips internal_only from text blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "system reminder", internal_only: true }] },
    ];
    const result = formatMessagesForApi(messages);
    const block = result[0].content[0] as any;
    expect(block.text).toBe("system reminder");
    expect(block.internal_only).toBeUndefined();
  });

  test("strips display_content from tool_result blocks", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "run" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "raw", display_content: "<rich>" }] },
    ];
    const result = formatMessagesForApi(messages);
    const toolResultMsg = result.find((m) => m.content.some((b: any) => b.type === "tool_result"));
    const block = toolResultMsg!.content.find((b: any) => b.type === "tool_result") as any;
    expect(block.content).toBe("raw");
    expect(block.display_content).toBeUndefined();
  });

  test("handles empty messages array", () => {
    expect(formatMessagesForApi([])).toEqual([]);
  });
});

// =============================================================================
// truncateHistory
// =============================================================================

describe("truncateHistory", () => {
  function makeMessages(n: number): ChatMessage[] {
    return Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `msg ${i}` }],
    }));
  }

  test("returns all messages when under limit", () => {
    expect(truncateHistory(makeMessages(4), 10)).toHaveLength(4);
  });

  test("truncates to keep last N turns", () => {
    const result = truncateHistory(makeMessages(40), 5);
    expect(result).toHaveLength(10);
    expect((result[0].content[0] as any).text).toBe("msg 30");
  });

  test("handles empty history", () => {
    expect(truncateHistory([], 5)).toEqual([]);
  });
});
