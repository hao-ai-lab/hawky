// =============================================================================
// Tests: Tool Output, InteractiveSelector, PermissionPrompt, AskUserPrompt,
//        formatToolPreview utility
// =============================================================================

import { describe, expect, test } from "bun:test";
import React from "react";
import { render as inkRender } from "ink-testing-library";
import { ToolOutput } from "../src/tui/components/tool_output.js";
import { InteractiveSelector } from "../src/tui/components/interactive_selector.js";
import { PermissionPrompt } from "../src/tui/components/permission_prompt.js";
import { AskUserPrompt } from "../src/tui/components/ask_user_prompt.js";
import { formatToolPreview } from "../src/tui/utils/format_tool_preview.js";
import type { ToolDisplayData, SelectorOption, PendingPermission, PendingAskUser } from "../src/tui/types.js";

const tick = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

// =============================================================================
// formatToolPreview
// =============================================================================

describe("formatToolPreview", () => {
  test("bash shows command", () => {
    expect(formatToolPreview("bash", { command: "echo hello" })).toBe("echo hello");
  });

  test("bash truncates long commands", () => {
    const long = "echo " + "x".repeat(200);
    const preview = formatToolPreview("bash", { command: long });
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith("...")).toBe(true);
  });

  test("bash replaces newlines with spaces", () => {
    expect(formatToolPreview("bash", { command: "echo\nhello\nworld" })).toBe("echo hello world");
  });

  test("read_file shows file_path", () => {
    expect(formatToolPreview("read_file", { file_path: "/src/index.ts" })).toBe("/src/index.ts");
  });

  test("write_file shows file_path", () => {
    expect(formatToolPreview("write_file", { file_path: "/tmp/out.txt", content: "..." })).toBe("/tmp/out.txt");
  });

  test("edit_file shows file_path", () => {
    expect(formatToolPreview("edit_file", { file_path: "/src/app.tsx", old_string: "a", new_string: "b" })).toBe("/src/app.tsx");
  });

  test("glob shows pattern", () => {
    expect(formatToolPreview("glob", { pattern: "**/*.tsx" })).toBe("**/*.tsx");
  });

  test("grep shows quoted pattern", () => {
    expect(formatToolPreview("grep", { pattern: "TODO" })).toBe('"TODO"');
  });

  test("web_fetch shows url", () => {
    expect(formatToolPreview("web_fetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  test("web_search shows quoted query", () => {
    expect(formatToolPreview("web_search", { query: "TypeScript generics" })).toBe('"TypeScript generics"');
  });

  test("ask_user shows question", () => {
    expect(formatToolPreview("ask_user", { question: "What language?" })).toBe("What language?");
  });

  test("unknown tool shows first string value", () => {
    expect(formatToolPreview("custom_tool", { name: "test", count: 42 })).toBe("test");
  });

  test("unknown tool with no string values returns empty", () => {
    expect(formatToolPreview("custom_tool", { count: 42 })).toBe("");
  });

  test("empty input returns empty", () => {
    expect(formatToolPreview("bash", {})).toBe("");
  });
});

// =============================================================================
// ToolOutput component
// =============================================================================

describe("ToolOutput", () => {
  test("renders success with icon and name", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "echo hello",
      status: "success",
      outputLines: [{ type: "stdout", content: "hello" }],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("✓");
    expect(output).toContain("bash");
    expect(output).toContain("echo hello");
    expect(output).toContain("hello");
  });

  test("renders error with icon", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "read_file",
      inputPreview: "/nonexistent",
      status: "error",
      outputLines: [{ type: "stderr", content: "File not found" }],
      isError: true,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("✗");
    expect(output).toContain("read_file");
    expect(output).toContain("File not found");
  });

  test("renders canceled with icon", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "sleep 100",
      status: "canceled",
      outputLines: [],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("⊘");
    expect(lastFrame()).toContain("bash");
  });

  test("renders pending with icon", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "ls",
      status: "pending",
      outputLines: [],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("⏱");
  });

  test("renders continuation prefix for output lines", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "ls",
      status: "success",
      outputLines: [
        { type: "stdout", content: "file1.txt" },
        { type: "stdout", content: "file2.txt" },
      ],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("⎿");
    expect(output).toContain("file1.txt");
    expect(output).toContain("file2.txt");
  });

  test("truncates long output with count (max 4 lines)", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      type: "stdout" as const,
      content: `line ${i + 1}`,
    }));
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "cat bigfile",
      status: "success",
      outputLines: lines,
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("+17 lines");
    expect(output).toContain("ctrl+o to expand");
    expect(output).toContain("line 1");
    expect(output).toContain("line 3");
    expect(output).not.toContain("line 4");
  });

  test("renders empty output without lines", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "true",
      status: "success",
      outputLines: [],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    const output = lastFrame();
    expect(output).toContain("✓");
    expect(output).toContain("bash");
    expect(output).not.toContain("├─");
    expect(output).not.toContain("└─");
  });

  test("executing shows spinner (animated)", async () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "bash",
      inputPreview: "make build",
      status: "executing",
      outputLines: [],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    await tick(200);
    const output = lastFrame();
    // Should show one of the spinner frames (braille chars)
    expect(output).toContain("bash");
    expect(output).toContain("make build");
    // Spinner is a braille character — hard to assert specific frame
    // but it should NOT show ✓ or ✗
    expect(output).not.toContain("✓");
    expect(output).not.toContain("✗");
  });

  test("no input preview shows just name", () => {
    const data: ToolDisplayData = {
      toolUseId: "tu_1",
      toolName: "custom_tool",
      inputPreview: "",
      status: "success",
      outputLines: [],
      isError: false,
    };
    const { lastFrame } = inkRender(<ToolOutput data={data} />);
    expect(lastFrame()).toContain("custom_tool");
    expect(lastFrame()).not.toContain("─ ");
  });
});

// =============================================================================
// InteractiveSelector
// =============================================================================

describe("InteractiveSelector", () => {
  const options: SelectorOption[] = [
    { id: "opt1", label: "Option A" },
    { id: "opt2", label: "Option B" },
    { id: "opt3", label: "Option C" },
  ];

  test("renders all options", () => {
    const { lastFrame } = inkRender(
      <InteractiveSelector options={options} onSelect={() => {}} />,
    );
    const output = lastFrame();
    expect(output).toContain("Option A");
    expect(output).toContain("Option B");
    expect(output).toContain("Option C");
  });

  test("first option is highlighted by default", () => {
    const { lastFrame } = inkRender(
      <InteractiveSelector options={options} onSelect={() => {}} />,
    );
    expect(lastFrame()).toContain("❯");
    // First option should have the highlight marker
    const lines = lastFrame().split("\n");
    const highlightLine = lines.find((l) => l.includes("❯"));
    expect(highlightLine).toContain("Option A");
  });

  test("shows numbered labels", () => {
    const { lastFrame } = inkRender(
      <InteractiveSelector options={options} onSelect={() => {}} />,
    );
    expect(lastFrame()).toContain("1.");
    expect(lastFrame()).toContain("2.");
    expect(lastFrame()).toContain("3.");
  });

  test("shows navigation hint", () => {
    const { lastFrame } = inkRender(
      <InteractiveSelector options={options} onSelect={() => {}} />,
    );
    expect(lastFrame()).toContain("↑/↓ navigate");
    expect(lastFrame()).toContain("Enter confirm");
  });

  test("shows cancel hint when onCancel provided", () => {
    const { lastFrame } = inkRender(
      <InteractiveSelector options={options} onSelect={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("Esc cancel");
  });

  test("number key triggers selection", async () => {
    let selected = "";
    const { stdin } = inkRender(
      <InteractiveSelector options={options} onSelect={(id) => { selected = id; }} />,
    );

    stdin.write("2");
    await tick();

    expect(selected).toBe("opt2");
  });

  test("arrow down then enter selects second option", async () => {
    let selected = "";
    const { stdin } = inkRender(
      <InteractiveSelector options={options} onSelect={(id) => { selected = id; }} />,
    );

    // Arrow down
    stdin.write("\x1b[B");
    await tick();
    // Enter
    stdin.write("\r");
    await tick();

    expect(selected).toBe("opt2");
  });

  test("escape calls onCancel", async () => {
    let cancelled = false;
    const { stdin } = inkRender(
      <InteractiveSelector options={options} onSelect={() => {}} onCancel={() => { cancelled = true; }} />,
    );

    stdin.write("\x1b");
    await tick();

    expect(cancelled).toBe(true);
  });

  test("shows description when provided", () => {
    const opts: SelectorOption[] = [
      { id: "a", label: "Alpha", description: "First letter" },
    ];
    const { lastFrame } = inkRender(
      <InteractiveSelector options={opts} onSelect={() => {}} />,
    );
    expect(lastFrame()).toContain("First letter");
  });

  test("freeForm option enters text mode on Enter", async () => {
    const opts: SelectorOption[] = [
      { id: "other", label: "Something else", freeForm: true },
    ];
    const { lastFrame, stdin } = inkRender(
      <InteractiveSelector options={opts} onSelect={() => {}} />,
    );

    stdin.write("\r"); // Enter on the freeForm option
    await tick();

    expect(lastFrame()).toContain("Type your answer");
  });
});

// =============================================================================
// PermissionPrompt
// =============================================================================

describe("PermissionPrompt", () => {
  const perm: PendingPermission = {
    id: "tu_1",
    toolUseId: "tu_1",
    toolName: "bash",
    toolInput: { command: "rm -rf /tmp/test" },
  };

  test("renders tool name header", () => {
    const { lastFrame } = inkRender(
      <PermissionPrompt permission={perm} onRespond={() => {}} />,
    );
    expect(lastFrame()).toContain("bash");
  });

  test("renders input preview", () => {
    const { lastFrame } = inkRender(
      <PermissionPrompt permission={perm} onRespond={() => {}} />,
    );
    expect(lastFrame()).toContain("rm -rf /tmp/test");
  });

  test("renders Yes/No/Always options", () => {
    const { lastFrame } = inkRender(
      <PermissionPrompt permission={perm} onRespond={() => {}} />,
    );
    const output = lastFrame();
    expect(output).toContain("Yes");
    expect(output).toContain("No");
    expect(output).toContain("Always allow this command");
  });

  test("pressing 1 selects allow_once", async () => {
    let decision = "";
    const { stdin } = inkRender(
      <PermissionPrompt permission={perm} onRespond={(d) => { decision = d; }} />,
    );

    stdin.write("1");
    await tick();

    expect(decision).toBe("allow_once");
  });

  test("pressing 2 then Enter denies with no feedback", async () => {
    let decision = "";
    let feedback: string | undefined;
    const { stdin } = inkRender(
      <PermissionPrompt permission={perm} onRespond={(d, f) => { decision = d; feedback = f; }} />,
    );

    // Press 2 to select "No" — triggers feedback input
    stdin.write("2");
    await tick();

    // Press Enter with empty input — skip feedback
    stdin.write("\r");
    await tick();

    expect(decision).toBe("deny");
    expect(feedback).toBeUndefined();
  });

  test("pressing 3 selects allow_always", async () => {
    let decision = "";
    const { stdin } = inkRender(
      <PermissionPrompt permission={perm} onRespond={(d) => { decision = d; }} />,
    );

    stdin.write("3");
    await tick();

    expect(decision).toBe("allow_always");
  });

  test("shows different tool names correctly", () => {
    const readPerm: PendingPermission = {
      id: "tu_2",
      toolUseId: "tu_2",
      toolName: "write_file",
      toolInput: { file_path: "/tmp/test.txt", content: "hello" },
    };
    const { lastFrame } = inkRender(
      <PermissionPrompt permission={readPerm} onRespond={() => {}} />,
    );
    expect(lastFrame()).toContain("write_file");
    // edit_file and write_file are one permission class — the "always allow"
    // label reflects the class, not the specific tool name.
    expect(lastFrame()).toContain("Always allow file edits");
    expect(lastFrame()).toContain("/tmp/test.txt");
  });
});

// =============================================================================
// AskUserPrompt
// =============================================================================

describe("AskUserPrompt", () => {
  test("renders question text", () => {
    const ask: PendingAskUser = {
      id: "ask_1",
      question: "What is your name?",
      options: [],
      multiSelect: false,
    };
    const { lastFrame } = inkRender(
      <AskUserPrompt askUser={ask} onRespond={() => {}} />,
    );
    expect(lastFrame()).toContain("What is your name?");
    expect(lastFrame()).toContain("Question");
  });

  test("renders free-form input when no options", () => {
    const ask: PendingAskUser = {
      id: "ask_1",
      question: "What is your name?",
      options: [],
      multiSelect: false,
    };
    const { lastFrame } = inkRender(
      <AskUserPrompt askUser={ask} onRespond={() => {}} />,
    );
    expect(lastFrame()).toContain("Type your answer");
  });

  test("renders options when provided", () => {
    const ask: PendingAskUser = {
      id: "ask_1",
      question: "Pick a language",
      options: ["Python", "TypeScript", "Rust", "Something else (type your answer)"],
      multiSelect: false,
    };
    const { lastFrame } = inkRender(
      <AskUserPrompt askUser={ask} onRespond={() => {}} />,
    );
    const output = lastFrame();
    expect(output).toContain("Python");
    expect(output).toContain("TypeScript");
    expect(output).toContain("Rust");
    expect(output).toContain("Something else");
  });

  test("number key selects option", async () => {
    let answers: string[] = [];
    const ask: PendingAskUser = {
      id: "ask_1",
      question: "Pick one",
      options: ["Alpha", "Beta"],
      multiSelect: false,
    };
    const { stdin } = inkRender(
      <AskUserPrompt askUser={ask} onRespond={(a) => { answers = a; }} />,
    );

    stdin.write("2");
    await tick();

    expect(answers).toEqual(["Beta"]);
  });

  test("free-form submit works", async () => {
    let answers: string[] = [];
    const ask: PendingAskUser = {
      id: "ask_1",
      question: "Your name?",
      options: [],
      multiSelect: false,
    };
    const { stdin } = inkRender(
      <AskUserPrompt askUser={ask} onRespond={(a) => { answers = a; }} />,
    );

    stdin.write("Alice");
    await tick();
    stdin.write("\r");
    await tick();

    expect(answers).toEqual(["Alice"]);
  });
});
