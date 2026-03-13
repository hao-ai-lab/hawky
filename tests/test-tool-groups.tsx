// =============================================================================
// Tests: Grouped Parallel Tools (10.2i + 10.2m)
//
// Tool grouping uses batchId from the backend — tools in the same
// Promise.all share a batchId. The group header persists in Static.
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { MessageList } from "../src/tui/components/message_list.js";
import type { DisplayMessage } from "../src/tui/types.js";

function toolMsg(id: string, name: string, preview: string, opts?: { status?: "executing" | "success"; batchId?: string; batchSize?: number }): DisplayMessage {
  return {
    id, role: "tool", text: "", timestamp: "t",
    toolData: {
      toolUseId: `tu_${id}`, toolName: name, inputPreview: preview,
      status: opts?.status ?? "success",
      outputLines: (opts?.status ?? "success") === "success" ? [{ type: "stdout", content: "ok" }] : [],
      isError: false,
      batchId: opts?.batchId,
      batchSize: opts?.batchSize,
    },
  };
}

function textMsg(id: string, role: "user" | "assistant", text: string): DisplayMessage {
  return { id, role, text, timestamp: "t" };
}

describe("Batch-based tool grouping — committed (Static)", () => {
  test("tools with same batchId show group header", () => {
    const messages = [
      textMsg("1", "user", "Hello"),
      toolMsg("2", "bash", "ls", { batchId: "b1", batchSize: 3 }),
      toolMsg("3", "grep", '"TODO"', { batchId: "b1", batchSize: 3 }),
      toolMsg("4", "glob", "*.ts", { batchId: "b1", batchSize: 3 }),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    expect(lastFrame()).toContain("⚡ 3 tools");
    expect(lastFrame()).toContain("bash, grep, glob");
  });

  test("single tool without batchId shows no group header", () => {
    const messages = [
      toolMsg("1", "bash", "ls"),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    expect(lastFrame()).not.toContain("⚡");
    expect(lastFrame()).toContain("bash");
  });

  test("sequential tools with different batchIds get separate headers", () => {
    const messages = [
      toolMsg("1", "bash", "ls", { batchId: "b1", batchSize: 2 }),
      toolMsg("2", "grep", '"TODO"', { batchId: "b1", batchSize: 2 }),
      textMsg("3", "assistant", "Found files"),
      toolMsg("4", "bash", "cat file", { batchId: "b2", batchSize: 2 }),
      toolMsg("5", "read_file", "index.ts", { batchId: "b2", batchSize: 2 }),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    // Two separate batch headers
    const output = lastFrame();
    const batchHeaders = output.split("\n").filter((l: string) => l.includes("⚡"));
    expect(batchHeaders.length).toBe(2);
  });

  test("tools without batchId (sequential) show no group header", () => {
    const messages = [
      toolMsg("1", "bash", "ls"),
      toolMsg("2", "bash", "pwd"),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    // No batchId → no grouping, even though they're consecutive
    expect(lastFrame()).not.toContain("⚡");
  });

  test("all tools in batch render (no items dropped)", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      toolMsg(`${i}`, "bash", `cmd${i + 1}`, { batchId: "big-batch", batchSize: 10 })
    );
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    expect(lastFrame()).toContain("⚡ 10 tools");
    for (let i = 1; i <= 10; i++) {
      expect(lastFrame()).toContain(`cmd${i}`);
    }
  });

  test("group header deduplicates tool names", () => {
    const messages = [
      toolMsg("1", "bash", "cmd1", { batchId: "b1", batchSize: 3 }),
      toolMsg("2", "bash", "cmd2", { batchId: "b1", batchSize: 3 }),
      toolMsg("3", "bash", "cmd3", { batchId: "b1", batchSize: 3 }),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    expect(lastFrame()).toContain("⚡ 3 tools: bash");
    expect(lastFrame()).not.toContain("bash, bash");
  });
});

describe("Batch-based tool grouping — live area (executing)", () => {
  test("multiple executing tools show running header", () => {
    const messages = [
      toolMsg("1", "bash", "cmd1", { status: "executing", batchId: "b1", batchSize: 3 }),
      toolMsg("2", "grep", '"x"', { status: "executing", batchId: "b1", batchSize: 3 }),
      toolMsg("3", "glob", "*.ts", { status: "executing", batchId: "b1", batchSize: 3 }),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    expect(lastFrame()).toContain("⚡ 3 tools running");
  });

  test("single executing tool shows no running header", () => {
    const messages = [
      toolMsg("1", "bash", "ls", { status: "executing" }),
    ];
    const { lastFrame } = inkRender(<MessageList messages={messages} model="test" />);
    expect(lastFrame()).not.toContain("⚡");
  });
});
