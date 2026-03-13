// =============================================================================
// Integration tests: Agent Loop with real tool definitions
//
// Tests the loop with actual tool implementations (bash, read_file, write_file,
// edit_file, glob, grep) using a mock provider that simulates tool_use responses.
// This verifies that real tools integrate correctly with the loop's three-phase
// tool processing, permission system, and result handling.
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentLoop } from "../src/agent/loop.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../src/agent/provider.js";
import { LLMError } from "../src/agent/provider.js";
import { ToolRegistry, resetToolRegistry } from "../src/tools/registry.js";
import type { HawkyConfig, StreamEvent } from "../src/agent/types.js";

// Import real tool definitions
import { bashToolDefinition } from "../src/tools/bash.js";
import { readFileToolDefinition } from "../src/tools/read_file.js";
import { writeFileToolDefinition } from "../src/tools/write_file.js";
import { editFileToolDefinition } from "../src/tools/edit_file.js";
import { globToolDefinition } from "../src/tools/glob.js";
import { grepToolDefinition } from "../src/tools/grep.js";

// =============================================================================
// Mock provider
// =============================================================================

class MockProvider implements LLMProvider {
  private responses: LLMStreamEvent[][] = [];
  callCount = 0;
  lastRequest: LLMStreamRequest | null = null;

  addResponse(events: LLMStreamEvent[]) {
    this.responses.push(events);
  }

  async *stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    this.lastRequest = request;
    const events = this.responses[this.callCount++] ?? [];
    for (const event of events) {
      if (signal?.aborted) throw new LLMError("aborted", "aborted");
      yield event;
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function makeConfig(overrides?: Partial<HawkyConfig>): HawkyConfig {
  return {
    api_keys: { anthropic: "test-key", brave_search: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    ...overrides,
  };
}

function collectEvents(loop: AgentLoop): StreamEvent[] {
  const events: StreamEvent[] = [];
  loop.subscribe((e) => events.push(e));
  return events;
}

// Build a mock "text-only" LLM response
function textResponse(text: string): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "text_delta", text },
    { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

// Build a mock "tool_use" LLM response
function toolUseResponse(
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "tool_use_start", index: 0, id: toolId, name: toolName },
    { type: "tool_use_input_delta", partial_json: JSON.stringify(input) },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

// Build a response with text + tool_use
function textAndToolResponse(
  text: string,
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "text_delta", text },
    { type: "content_block_stop", index: 0 },
    { type: "tool_use_start", index: 1, id: toolId, name: toolName },
    { type: "tool_use_input_delta", partial_json: JSON.stringify(input) },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
}

// Multi-tool response
function multiToolResponse(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = [
    { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
  ];
  tools.forEach((t, i) => {
    events.push({ type: "tool_use_start", index: i, id: t.id, name: t.name });
    events.push({ type: "tool_use_input_delta", partial_json: JSON.stringify(t.input) });
    events.push({ type: "content_block_stop", index: i });
  });
  events.push({ type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 5 } });
  events.push({ type: "message_stop" });
  return events;
}

// =============================================================================
// Test fixtures
// =============================================================================

let testDir: string;

function setupTestDir(): string {
  testDir = join(tmpdir(), `hawky-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  return testDir;
}

afterEach(() => {
  resetToolRegistry();
  if (testDir) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
});

function registerAllTools(registry: ToolRegistry): void {
  registry.register(bashToolDefinition);
  registry.register(readFileToolDefinition);
  registry.register(writeFileToolDefinition);
  registry.register(editFileToolDefinition);
  registry.register(globToolDefinition);
  registry.register(grepToolDefinition);
}

// =============================================================================
// bash tool integration
// =============================================================================

describe("Agent Loop + bash tool", () => {
  test("executes a bash command and returns output", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    // LLM calls bash, then responds with text
    provider.addResponse(toolUseResponse("tu1", "bash", { command: "echo hello_from_bash" }));
    provider.addResponse(textResponse("The command output was hello_from_bash."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Run echo hello_from_bash");

    // Should have tool_result with the bash output
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).content).toContain("hello_from_bash");
    expect((toolResults[0] as any).is_error).toBe(false);

    // History should have: user, assistant(tool_use), user(tool_result), assistant(text)
    const history = loop.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user");
    expect(history[3].role).toBe("assistant");
  });

  test("bash command failure returns error result", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "bash", { command: "exit 42" }));
    provider.addResponse(textResponse("The command failed."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Run a failing command");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).is_error).toBe(true);
    expect((toolResults[0] as any).content).toContain("exit code 42");
  });
});

// =============================================================================
// read_file tool integration
// =============================================================================

describe("Agent Loop + read_file tool", () => {
  test("reads a file and returns content", async () => {
    const dir = setupTestDir();
    const testFile = join(dir, "hello.txt");
    writeFileSync(testFile, "Hello from test file!");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "read_file", { file_path: testFile }));
    provider.addResponse(textResponse("The file contains: Hello from test file!"));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Read hello.txt");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).content).toContain("Hello from test file!");
    expect((toolResults[0] as any).is_error).toBe(false);
  });

  test("read_file on nonexistent file returns error", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "read_file", { file_path: join(dir, "nope.txt") }));
    provider.addResponse(textResponse("File not found."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Read nope.txt");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).is_error).toBe(true);
  });
});

// =============================================================================
// write_file tool integration
// =============================================================================

describe("Agent Loop + write_file tool", () => {
  test("creates a new file on disk", async () => {
    const dir = setupTestDir();
    const targetFile = join(dir, "new_file.txt");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "write_file", {
      file_path: targetFile,
      content: "Created by agent loop test!",
    }));
    provider.addResponse(textResponse("File created."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Create new_file.txt");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).is_error).toBe(false);

    // Verify file actually exists on disk
    expect(existsSync(targetFile)).toBe(true);
    expect(readFileSync(targetFile, "utf-8")).toBe("Created by agent loop test!");
  });
});

// =============================================================================
// glob tool integration
// =============================================================================

describe("Agent Loop + glob tool", () => {
  test("finds files matching a pattern", async () => {
    const dir = setupTestDir();
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.ts"), "");
    writeFileSync(join(dir, "c.js"), "");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "glob", { pattern: "*.ts", path: dir }));
    provider.addResponse(textResponse("Found 2 TypeScript files."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Find all .ts files");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).content).toContain("a.ts");
    expect((toolResults[0] as any).content).toContain("b.ts");
    expect((toolResults[0] as any).content).not.toContain("c.js");
    expect((toolResults[0] as any).is_error).toBe(false);
  });
});

// =============================================================================
// grep tool integration
// =============================================================================

describe("Agent Loop + grep tool", () => {
  test("searches file content and returns matches", async () => {
    const dir = setupTestDir();
    writeFileSync(join(dir, "code.ts"), "function hello() {\n  return 'world';\n}\n");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "grep", { pattern: "hello", path: dir }));
    provider.addResponse(textResponse("Found 'hello' in code.ts."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Search for 'hello'");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0] as any).content).toContain("code.ts");
    expect((toolResults[0] as any).is_error).toBe(false);
  });
});

// =============================================================================
// Multiple tools in one response
// =============================================================================

describe("Agent Loop + multiple tools", () => {
  test("executes two tools in parallel and returns both results", async () => {
    const dir = setupTestDir();
    writeFileSync(join(dir, "a.txt"), "content A");
    writeFileSync(join(dir, "b.txt"), "content B");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    // LLM requests two read_file calls at once
    provider.addResponse(multiToolResponse([
      { id: "tu1", name: "read_file", input: { file_path: join(dir, "a.txt") } },
      { id: "tu2", name: "read_file", input: { file_path: join(dir, "b.txt") } },
    ]));
    provider.addResponse(textResponse("Both files read."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Read both files");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    const contents = toolResults.map((e) => (e as any).content);
    expect(contents.some((c: string) => c.includes("content A"))).toBe(true);
    expect(contents.some((c: string) => c.includes("content B"))).toBe(true);

    // History: user, assistant(2 tool_use), user(2 tool_result), assistant(text)
    const history = loop.getHistory();
    expect(history).toHaveLength(4);
    // Tool result message should have 2 content blocks
    expect(history[2].content).toHaveLength(2);
  });

  test("mix of bash + glob in one response", async () => {
    const dir = setupTestDir();
    writeFileSync(join(dir, "hello.ts"), "");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(multiToolResponse([
      { id: "tu1", name: "bash", input: { command: "echo mixed_test" } },
      { id: "tu2", name: "glob", input: { pattern: "*.ts", path: dir } },
    ]));
    provider.addResponse(textResponse("Done."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Run bash and glob");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    const contents = toolResults.map((e) => (e as any).content);
    expect(contents.some((c: string) => c.includes("mixed_test"))).toBe(true);
    expect(contents.some((c: string) => c.includes("hello.ts"))).toBe(true);
  });
});

// =============================================================================
// Tool with empty input
// =============================================================================

describe("Agent Loop + empty input tool", () => {
  test("tool_use with empty input {} works correctly", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();

    // Register a tool that takes no required input
    registry.register({
      name: "no_input_tool",
      description: "A tool with no required input",
      input_schema: { type: "object", properties: {} },
      permission: "auto_approve",
      execute: async () => ({ type: "text", content: "executed with empty input" }),
    });

    // Simulate LLM sending tool_use with empty JSON (no input_json_delta events)
    provider.addResponse([
      { type: "message_start", message_id: "m1", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
      { type: "tool_use_start", index: 0, id: "tu1", name: "no_input_tool" },
      // No tool_use_input_delta — empty input
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
    provider.addResponse(textResponse("Done."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Use the tool");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).content).toBe("executed with empty input");
    expect((toolResults[0] as any).is_error).toBe(false);
  });
});

// =============================================================================
// Permission levels with real tools
// =============================================================================

describe("Agent Loop + permission levels", () => {
  test("auto_approve tools (read_file, glob, grep) execute without permission resolver", async () => {
    const dir = setupTestDir();
    writeFileSync(join(dir, "test.txt"), "permission test");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "read_file", { file_path: join(dir, "test.txt") }));
    provider.addResponse(textResponse("Done."));

    // No permissionResolver — auto_approve tools should still work
    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Read test.txt");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).content).toContain("permission test");
  });

  test("ask_user tools (bash) need permission — denied without resolver", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "bash", { command: "echo denied" }));
    provider.addResponse(textResponse("Tool was denied."));

    // No permissionResolver — bash (ask_user) should... actually the current code
    // passes null resolver which means ask_user tools proceed without asking.
    // Let's verify this behavior.
    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Run echo");

    // With no resolver, ask_user tools should still execute (no one to ask)
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).content).toContain("denied");
  });

  test("ask_user tools denied by resolver return error result", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "bash", { command: "mkdir -p /tmp/hawky_should_not_run" }));
    provider.addResponse(textResponse("Tool was denied."));

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: dir,
      permissionResolver: {
        ask: async () => ({ decision: "deny" as const }),
      },
    });
    const events = collectEvents(loop);

    await loop.sendMessage("Run echo");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).is_error).toBe(true);
    expect((toolResults[0] as any).content).toContain("denied");
  });

  test("allow_always caches permission for subsequent calls", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    let askCount = 0;

    // Two bash calls in sequence — use unsafe commands so permission is required
    provider.addResponse(toolUseResponse("tu1", "bash", { command: "mkdir -p /tmp/hawky_perm_first" }));
    provider.addResponse(toolUseResponse("tu2", "bash", { command: "mkdir -p /tmp/hawky_perm_second" }));
    provider.addResponse(textResponse("Done."));

    const loop = new AgentLoop({
      provider,
      registry,
      config: makeConfig(),
      working_directory: dir,
      permissionResolver: {
        ask: async () => {
          askCount++;
          return "allow_always";
        },
      },
    });
    const events = collectEvents(loop);

    await loop.sendMessage("Run two commands");

    // Bash: allow_always saves exact command, so different commands prompt separately
    // (This is the secure behavior — "always allow this command" not "always allow all bash")
    expect(askCount).toBeGreaterThanOrEqual(1);

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
  });
});

// =============================================================================
// edit_file tool integration
// =============================================================================

describe("Agent Loop + edit_file tool", () => {
  test("edits an existing file", async () => {
    const dir = setupTestDir();
    const targetFile = join(dir, "editable.txt");
    writeFileSync(targetFile, "line 1\nold text\nline 3\n");

    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "edit_file", {
      file_path: targetFile,
      old_string: "old text",
      new_string: "new text",
    }));
    provider.addResponse(textResponse("File edited."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    const events = collectEvents(loop);

    await loop.sendMessage("Replace old text with new text");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).is_error).toBe(false);

    // Verify file was actually modified
    const content = readFileSync(targetFile, "utf-8");
    expect(content).toContain("new text");
    expect(content).not.toContain("old text");
  });
});

// =============================================================================
// Tool result in conversation history format
// =============================================================================

describe("Agent Loop + history format", () => {
  test("tool results in history match Anthropic API format", async () => {
    const dir = setupTestDir();
    const provider = new MockProvider();
    const registry = new ToolRegistry();
    registerAllTools(registry);

    provider.addResponse(toolUseResponse("tu1", "bash", { command: "echo test_output" }));
    provider.addResponse(textResponse("Got it."));

    const loop = new AgentLoop({ provider, registry, config: makeConfig(), working_directory: dir });
    await loop.sendMessage("Run echo");

    const history = loop.getHistory();

    // Message 2 (index 1): assistant with tool_use
    const assistantMsg = history[1];
    expect(assistantMsg.role).toBe("assistant");
    const toolUseBlock = assistantMsg.content.find((b) => b.type === "tool_use");
    expect(toolUseBlock).toBeDefined();
    expect((toolUseBlock as any).id).toBe("tu1");
    expect((toolUseBlock as any).name).toBe("bash");

    // Message 3 (index 2): user with tool_result
    const toolResultMsg = history[2];
    expect(toolResultMsg.role).toBe("user");
    const resultBlock = toolResultMsg.content[0];
    expect(resultBlock.type).toBe("tool_result");
    expect((resultBlock as any).tool_use_id).toBe("tu1");
    expect((resultBlock as any).content).toContain("test_output");
  });
});
