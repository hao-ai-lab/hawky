// =============================================================================
// Integration Tests: Tool Chain Workflows
//
// Tests multi-step tool sequences through the real AgentLoop with mock LLM.
// Verifies that tool outputs from one step are available to the next.
// =============================================================================

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentLoop } from "../../src/agent/loop.js";
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from "../../src/agent/provider.js";
import { LLMError } from "../../src/agent/provider.js";
import { ToolRegistry, resetToolRegistry } from "../../src/tools/registry.js";
import type { HawkyConfig, StreamEvent } from "../../src/agent/types.js";

// Real tool definitions
import { bashToolDefinition } from "../../src/tools/bash.js";
import { readFileToolDefinition } from "../../src/tools/read_file.js";
import { writeFileToolDefinition } from "../../src/tools/write_file.js";
import { editFileToolDefinition } from "../../src/tools/edit_file.js";
import { globToolDefinition } from "../../src/tools/glob.js";
import { grepToolDefinition } from "../../src/tools/grep.js";

// =============================================================================
// Mock provider that supports multi-turn tool chains
// =============================================================================

class ChainProvider implements LLMProvider {
  private responses: LLMStreamEvent[][] = [];
  callCount = 0;
  requests: LLMStreamRequest[] = [];

  addResponse(events: LLMStreamEvent[]) {
    this.responses.push(events);
  }

  async *stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    this.requests.push(request);
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

let testDir: string;

afterEach(() => {
  resetToolRegistry();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function setup(): { provider: ChainProvider; loop: AgentLoop; events: StreamEvent[] } {
  testDir = join(tmpdir(), `hawky-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  const provider = new ChainProvider();
  const registry = new ToolRegistry();
  registry.register(bashToolDefinition as any);
  registry.register(readFileToolDefinition as any);
  registry.register(writeFileToolDefinition as any);
  registry.register(editFileToolDefinition as any);
  registry.register(globToolDefinition as any);
  registry.register(grepToolDefinition as any);

  const config: HawkyConfig = {
    api_keys: { anthropic: "test-key", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: testDir,
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 60, keep_recent_messages: 10, active_hours: { start: "00:00", end: "23:59" } },
  } as HawkyConfig;

  const loop = new AgentLoop({
    provider,
    registry,
    config,
    working_directory: testDir,
    permissionResolver: { ask: async () => "allow_once" as const },
  });

  const events: StreamEvent[] = [];
  loop.subscribe((e) => events.push(e));

  return { provider, loop, events };
}

function toolUseResponse(
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: `m-${toolId}`, model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "tool_use_start", index: 0, id: toolId, name: toolName },
    { type: "tool_use_input_delta", partial_json: JSON.stringify(input) },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", stop_reason: "tool_use", usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

function textResponse(text: string): LLMStreamEvent[] {
  return [
    { type: "message_start", message_id: "m-final", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
    { type: "text_delta", text },
    { type: "message_delta", stop_reason: "end_turn", usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

function multiToolResponse(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = [
    { type: "message_start", message_id: "m-multi", model: "test", usage: { input_tokens: 10, output_tokens: 0 } },
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
// Multi-step tool chains
// =============================================================================

describe("tool chain — glob → read_file", () => {
  test("glob finds file, then read_file reads it", async () => {
    const { provider, loop, events } = setup();

    // Create a test file
    writeFileSync(join(testDir, "hello.txt"), "Hello World!\nLine 2\n");

    // Turn 1: LLM calls glob
    provider.addResponse(toolUseResponse("tu_glob", "glob", { pattern: "*.txt", path: testDir }));
    // Turn 2: LLM sees glob result, calls read_file
    provider.addResponse(toolUseResponse("tu_read", "read_file", { file_path: join(testDir, "hello.txt") }));
    // Turn 3: LLM sees file content, responds with text
    provider.addResponse(textResponse("The file contains Hello World!"));

    await loop.sendMessage("find and read the txt file");

    // Verify tool results were emitted
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);

    // First result is glob (should list hello.txt)
    expect((toolResults[0] as any).name).toBe("glob");
    expect((toolResults[0] as any).content).toContain("hello.txt");

    // Second result is read_file (should have file content)
    expect((toolResults[1] as any).name).toBe("read_file");
    expect((toolResults[1] as any).content).toContain("Hello World!");

    // Provider should see tool results in the conversation history
    // Request 2 should contain the glob result; Request 3 should contain read_file result
    expect(provider.callCount).toBe(3);
  });
});

describe("tool chain — write_file → read_file", () => {
  test("write creates file, read verifies content", async () => {
    const { provider, loop, events } = setup();
    const filePath = join(testDir, "new-file.txt");

    // Turn 1: LLM writes a file
    provider.addResponse(toolUseResponse("tu_write", "write_file", {
      file_path: filePath,
      content: "Created by agent",
    }));
    // Turn 2: LLM reads it back
    provider.addResponse(toolUseResponse("tu_read", "read_file", { file_path: filePath }));
    // Turn 3: LLM confirms
    provider.addResponse(textResponse("File created and verified."));

    await loop.sendMessage("create and verify a file");

    // File should actually exist on disk
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("Created by agent");

    // Read result should contain the content
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect((toolResults[1] as any).content).toContain("Created by agent");
  });
});

describe("tool chain — parallel tools", () => {
  test("two tools execute in parallel, both results collected", async () => {
    const { provider, loop, events } = setup();

    // Create two files
    writeFileSync(join(testDir, "a.txt"), "file A content");
    writeFileSync(join(testDir, "b.txt"), "file B content");

    // Turn 1: LLM calls two read_file in parallel
    provider.addResponse(multiToolResponse([
      { id: "tu_a", name: "read_file", input: { file_path: join(testDir, "a.txt") } },
      { id: "tu_b", name: "read_file", input: { file_path: join(testDir, "b.txt") } },
    ]));
    // Turn 2: LLM responds with summary
    provider.addResponse(textResponse("Both files read successfully."));

    await loop.sendMessage("read both files");

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);

    const contents = toolResults.map((r) => (r as any).content);
    expect(contents.some((c: string) => c.includes("file A content"))).toBe(true);
    expect(contents.some((c: string) => c.includes("file B content"))).toBe(true);
  });
});

describe("tool chain — write_file → edit_file", () => {
  test("write creates file, edit modifies it", async () => {
    const { provider, loop } = setup();
    const filePath = join(testDir, "editable.txt");

    // Turn 1: write
    provider.addResponse(toolUseResponse("tu_write", "write_file", {
      file_path: filePath,
      content: "function hello() {\n  return 'world';\n}\n",
    }));
    // Turn 2: edit
    provider.addResponse(toolUseResponse("tu_edit", "edit_file", {
      file_path: filePath,
      old_string: "return 'world';",
      new_string: "return 'hello world';",
    }));
    // Turn 3: confirm
    provider.addResponse(textResponse("File updated."));

    await loop.sendMessage("create and edit a file");

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("return 'hello world';");
    expect(content).not.toContain("return 'world';");
  });
});

describe("tool chain — grep → edit_file", () => {
  test("grep finds pattern, edit fixes it", async () => {
    const { provider, loop } = setup();

    // Create a file with a "bug"
    const filePath = join(testDir, "buggy.ts");
    writeFileSync(filePath, 'const x = "TODO: fix this";\nconst y = 42;\n');

    // Turn 1: grep for TODO
    provider.addResponse(toolUseResponse("tu_grep", "grep", {
      pattern: "TODO",
      path: testDir,
    }));
    // Turn 2: edit to fix the TODO
    provider.addResponse(toolUseResponse("tu_edit", "edit_file", {
      file_path: filePath,
      old_string: '"TODO: fix this"',
      new_string: '"fixed"',
    }));
    // Turn 3: confirm
    provider.addResponse(textResponse("Bug fixed."));

    await loop.sendMessage("find and fix TODOs");

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('"fixed"');
    expect(content).not.toContain("TODO");
  });
});
