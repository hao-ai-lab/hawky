// =============================================================================
// Tests: history → DisplayMessage projection
//
// The transition logic lives in the shared canonical reducer
// (src/transcript fromHistory); the TUI binds it via historyToDisplay
// (fromHistory + toDisplayMessage). Ids are deterministic, so no counter
// reset is needed.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { historyToDisplay } from "../src/tui/utils/transcript_display.js";
import type { ChatMessage } from "../src/agent/types.js";

function userMsg(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: "2026-01-01" };
}

function assistantMsg(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: "2026-01-01" };
}

function toolUseMsg(id: string, name: string, input: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
    timestamp: "2026-01-01",
  };
}

function toolResultMsg(toolUseId: string, content: string, isError = false): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    timestamp: "2026-01-01",
  };
}

function mixedAssistantMsg(text: string, toolId: string, toolName: string, input: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: toolId, name: toolName, input },
    ],
    timestamp: "2026-01-01",
  };
}

describe("historyToDisplay", () => {
  test("empty history returns empty", () => {
    expect(historyToDisplay([])).toEqual([]);
  });

  test("user text message", () => {
    const result = historyToDisplay([userMsg("hello")]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].text).toBe("hello");
  });

  test("assistant text message", () => {
    const result = historyToDisplay([assistantMsg("hi there")]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].text).toBe("hi there");
  });

  test("multi-turn conversation", () => {
    const result = historyToDisplay([
      userMsg("hello"),
      assistantMsg("hi"),
      userMsg("how are you"),
      assistantMsg("good"),
    ]);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
    expect(result[3].role).toBe("assistant");
  });

  test("tool_use creates tool display entry", () => {
    const result = historyToDisplay([
      userMsg("run something"),
      toolUseMsg("tu_1", "bash", { command: "echo hello" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("tool");
    expect(result[1].toolData).toBeDefined();
    expect(result[1].toolData!.toolName).toBe("bash");
    expect(result[1].toolData!.inputPreview).toBe("echo hello");
  });

  test("tool_result updates tool entry with output", () => {
    const result = historyToDisplay([
      userMsg("run echo"),
      toolUseMsg("tu_1", "bash", { command: "echo hello" }),
      toolResultMsg("tu_1", "hello"),
      assistantMsg("Done."),
    ]);
    expect(result).toHaveLength(3); // user, tool, assistant (tool_result is absorbed)
    const tool = result[1];
    expect(tool.toolData!.status).toBe("success");
    expect(tool.toolData!.outputLines).toHaveLength(1);
    expect(tool.toolData!.outputLines[0].content).toBe("hello");
    expect(tool.toolData!.isError).toBe(false);
  });

  test("tool_result with error sets error status", () => {
    const result = historyToDisplay([
      userMsg("read file"),
      toolUseMsg("tu_1", "read_file", { file_path: "/nonexistent" }),
      toolResultMsg("tu_1", "File not found", true),
      assistantMsg("The file doesn't exist."),
    ]);
    const tool = result[1];
    expect(tool.toolData!.status).toBe("error");
    expect(tool.toolData!.isError).toBe(true);
    expect(tool.toolData!.outputLines[0].content).toBe("File not found");
    expect(tool.toolData!.outputLines[0].type).toBe("stderr");
  });

  test("mixed assistant message with text + tool_use", () => {
    const result = historyToDisplay([
      userMsg("help"),
      mixedAssistantMsg("Let me check.", "tu_1", "bash", { command: "ls" }),
      toolResultMsg("tu_1", "file1\nfile2"),
      assistantMsg("Found 2 files."),
    ]);
    expect(result).toHaveLength(4); // user, assistant text, tool, assistant text
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[1].text).toBe("Let me check.");
    expect(result[2].role).toBe("tool");
    expect(result[2].toolData!.toolName).toBe("bash");
    expect(result[2].toolData!.outputLines).toHaveLength(2);
    expect(result[3].role).toBe("assistant");
    expect(result[3].text).toBe("Found 2 files.");
  });

  test("multiple tool calls in sequence", () => {
    const result = historyToDisplay([
      userMsg("check files"),
      toolUseMsg("tu_1", "glob", { pattern: "*.ts" }),
      toolResultMsg("tu_1", "index.ts\napp.ts"),
      toolUseMsg("tu_2", "read_file", { file_path: "index.ts" }),
      toolResultMsg("tu_2", "console.log('hi')"),
      assistantMsg("Found the files."),
    ]);
    // user, tool(glob), tool(read_file), assistant
    expect(result).toHaveLength(4);
    expect(result[1].toolData!.toolName).toBe("glob");
    expect(result[2].toolData!.toolName).toBe("read_file");
  });

  test("thinking blocks are skipped", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "The answer is 42." },
      ],
      timestamp: "2026-01-01",
    };
    const result = historyToDisplay([userMsg("question"), msg]);
    expect(result).toHaveLength(2);
    expect(result[1].text).toBe("The answer is 42.");
  });

  test("tool preview shows correct format per tool", () => {
    const result = historyToDisplay([
      userMsg("do stuff"),
      toolUseMsg("tu_1", "grep", { pattern: "TODO" }),
      toolResultMsg("tu_1", "found matches"),
    ]);
    expect(result[1].toolData!.inputPreview).toBe('"TODO"');
  });

  test("all display messages have unique ids", () => {
    const result = historyToDisplay([
      userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d"),
    ]);
    const ids = result.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
