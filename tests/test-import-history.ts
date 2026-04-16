// =============================================================================
// Tests for import-history skill
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// Find the flatten script path
const scriptPath = join(__dirname, "..", "src", "skill-templates", "import-history", "flatten_chatgpt.py");

// =============================================================================
// SKILL.md exists
// =============================================================================

describe("import-history skill", () => {
  test("SKILL.md exists", () => {
    const skillPath = join(__dirname, "..", "src", "skill-templates", "import-history", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
  });

  test("SKILL.md contains all platform sections", () => {
    const skillPath = join(__dirname, "..", "src", "skill-templates", "import-history", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("Platform: ChatGPT");
    expect(content).toContain("Platform: Claude.ai");
    expect(content).toContain("Platform: iMessage");
    expect(content).toContain("Platform: Slack");
    expect(content).toContain("Platform: WeChat");
  });

  test("SKILL.md contains distillation pipeline", () => {
    const skillPath = join(__dirname, "..", "src", "skill-templates", "import-history", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("Distillation Pipeline");
    expect(content).toContain("Privacy gate");
    expect(content).toContain("Batch by day");
  });

  test("flatten_chatgpt.py exists", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });
});

// =============================================================================
// ChatGPT flatten script
// =============================================================================

describe("flatten_chatgpt.py", () => {
  test("flattens a simple conversation", () => {
    const conversation = [{
      title: "Test Chat",
      current_node: "node-2",
      mapping: {
        "root": {
          id: "root",
          parent: null,
          message: null,
        },
        "node-1": {
          id: "node-1",
          parent: "root",
          message: {
            id: "msg-1",
            author: { role: "user" },
            create_time: 1700000000.0,
            content: { content_type: "text", parts: ["Hello"] },
          },
        },
        "node-2": {
          id: "node-2",
          parent: "node-1",
          message: {
            id: "msg-2",
            author: { role: "assistant" },
            create_time: 1700000001.0,
            content: { content_type: "text", parts: ["Hi there!"] },
          },
        },
      },
    }];

    const inputPath = join(testDir, "conversations.json");
    const outputPath = join(testDir, "output.jsonl");
    writeFileSync(inputPath, JSON.stringify(conversation));

    execSync(`python3 ${scriptPath} ${inputPath} ${outputPath}`, { stdio: "pipe" });

    const lines = readFileSync(outputPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const msg1 = JSON.parse(lines[0]);
    expect(msg1.role).toBe("user");
    expect(msg1.text).toBe("Hello");
    expect(msg1.title).toBe("Test Chat");
    expect(msg1.timestamp).toContain("2023-11-14"); // Unix 1700000000

    const msg2 = JSON.parse(lines[1]);
    expect(msg2.role).toBe("assistant");
    expect(msg2.text).toBe("Hi there!");
  });

  test("handles empty conversations", () => {
    const inputPath = join(testDir, "empty.json");
    const outputPath = join(testDir, "output.jsonl");
    writeFileSync(inputPath, "[]");

    execSync(`python3 ${scriptPath} ${inputPath} ${outputPath}`, { stdio: "pipe" });

    const content = readFileSync(outputPath, "utf-8").trim();
    expect(content).toBe("");
  });

  test("skips system messages", () => {
    const conversation = [{
      title: "Test",
      current_node: "node-2",
      mapping: {
        "root": { id: "root", parent: null, message: null },
        "node-1": {
          id: "node-1",
          parent: "root",
          message: {
            id: "msg-sys",
            author: { role: "system" },
            create_time: 1700000000.0,
            content: { content_type: "text", parts: ["System prompt"] },
          },
        },
        "node-2": {
          id: "node-2",
          parent: "node-1",
          message: {
            id: "msg-user",
            author: { role: "user" },
            create_time: 1700000001.0,
            content: { content_type: "text", parts: ["Hello"] },
          },
        },
      },
    }];

    const inputPath = join(testDir, "conversations.json");
    const outputPath = join(testDir, "output.jsonl");
    writeFileSync(inputPath, JSON.stringify(conversation));

    execSync(`python3 ${scriptPath} ${inputPath} ${outputPath}`, { stdio: "pipe" });

    const lines = readFileSync(outputPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).role).toBe("user");
  });

  test("handles multi-part content", () => {
    const conversation = [{
      title: "Multi-part",
      current_node: "node-1",
      mapping: {
        "root": { id: "root", parent: null, message: null },
        "node-1": {
          id: "node-1",
          parent: "root",
          message: {
            id: "msg-1",
            author: { role: "user" },
            create_time: 1700000000.0,
            content: {
              content_type: "text",
              parts: ["Part 1", { text: "Part 2" }, "Part 3"],
            },
          },
        },
      },
    }];

    const inputPath = join(testDir, "conversations.json");
    const outputPath = join(testDir, "output.jsonl");
    writeFileSync(inputPath, JSON.stringify(conversation));

    execSync(`python3 ${scriptPath} ${inputPath} ${outputPath}`, { stdio: "pipe" });

    const msg = JSON.parse(readFileSync(outputPath, "utf-8").trim());
    expect(msg.text).toContain("Part 1");
    expect(msg.text).toContain("Part 2");
    expect(msg.text).toContain("Part 3");
  });
});
