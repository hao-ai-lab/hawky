import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeMcpConfig,
  buildCodexMcpConfigOverrides,
  ExternalAgentRuntime,
  parseClaudeJsonLine,
  parseClaudeJsonStdout,
  parseCodexJsonLine,
  parseCodexJsonStdout,
  resolveRuntimeExecutable,
} from "../src/gateway/external-agent-runtime.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claude external runtime JSONL parsing", () => {
  test("builds inline Claude MCP config for Hawky tools", () => {
    const config = JSON.parse(buildClaudeMcpConfig({
      command: "/bin/bun",
      args: ["/repo/src/index.ts", "mcp"],
      cwd: "/repo",
    }));

    expect(config.mcpServers.hawky).toMatchObject({
      type: "stdio",
      command: "/bin/bun",
      args: ["/repo/src/index.ts", "mcp"],
      env: {},
      alwaysLoad: true,
      timeout: 30_000,
    });
  });

  test("parses streamed text, final result, usage, and cost from claude JSONL", () => {
    const delta = parseClaudeJsonLine(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hello " },
      },
    }));
    expect(delta?.assistantTextDelta).toBe("hello ");

    const assistant = parseClaudeJsonLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "hello from claude" }],
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
      },
    }));
    expect(assistant?.assistantText).toBe("hello from claude");
    expect(assistant?.usage).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 2,
    });

    const result = parseClaudeJsonLine(JSON.stringify({
      type: "result",
      subtype: "success",
      result: "hello from claude",
      usage: { input_tokens: 8, output_tokens: 4, cache_creation_input_tokens: 1 },
      total_cost_usd: 0.0123,
    }));
    expect(result?.resultText).toBe("hello from claude");
    expect(result?.totalCostUSD).toBe(0.0123);
    expect(result?.usage).toEqual({
      input_tokens: 8,
      output_tokens: 4,
      cache_creation_input_tokens: 1,
    });
  });

  test("parses claude tool_use and tool_result blocks", () => {
    const start = parseClaudeJsonLine(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__hawky__hawky_session_read",
          input: { sessionKey: "web:general" },
        },
      },
    }));
    expect(start?.toolStarts?.[0]).toEqual({
      tool_use_id: "toolu_1",
      name: "hawky_session_read",
      input: { sessionKey: "web:general" },
    });

    const result = parseClaudeJsonLine(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "session transcript" }],
        }],
      },
    }));
    expect(result?.toolResults?.[0]).toEqual({
      tool_use_id: "toolu_1",
      name: "tool",
      content: "session transcript",
      is_error: false,
    });
  });

  test("parses claude stdout using result text as final answer", () => {
    const parsed = parseClaudeJsonStdout([
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "final",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ].join("\n"));

    expect(parsed.text).toBe("final");
    expect(parsed.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  test("streams claude partial messages and done usage from a fake claude binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-fake-claude-"));
    cleanup.push(dir);
    const binary = join(dir, "claude");
    const argsPath = join(dir, "claude-args.txt");
    writeFileSync(binary, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$HAWKY_FAKE_CLAUDE_ARGS_PATH\"",
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"test\"}'",
      "printf '%s\\n' '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"mcp__hawky__hawky_session_list\",\"input\":{\"limit\":1}}}}'",
      "printf '%s\\n' '{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":[{\"type\":\"text\",\"text\":\"session list empty\"}]}]}}'",
      "printf '%s\\n' '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello \"}}}'",
      "printf '%s\\n' '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"from claude\"}}}'",
      "printf '%s\\n' '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello from claude\"}],\"usage\":{\"input_tokens\":4,\"output_tokens\":5}}}'",
      "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"hello from claude\",\"usage\":{\"input_tokens\":4,\"output_tokens\":5},\"total_cost_usd\":0.01}'",
      "",
    ].join("\n"), { mode: 0o755 });

    const prevBin = process.env.HAWKY_CLAUDE_BIN;
    const prevArgsPath = process.env.HAWKY_FAKE_CLAUDE_ARGS_PATH;
    const prevToolSearch = process.env.ENABLE_TOOL_SEARCH;
    process.env.HAWKY_CLAUDE_BIN = binary;
    process.env.HAWKY_FAKE_CLAUDE_ARGS_PATH = argsPath;
    delete process.env.ENABLE_TOOL_SEARCH;
    try {
      const events: any[] = [];
      const runtime = new ExternalAgentRuntime();
      const result = await runtime.sendMessage({
        runtimeKind: "claude",
        sessionKey: "web:claude-jsonl",
        cwd: dir,
        history: [],
        message: "hello",
        emit: (event) => events.push(event),
      });

      expect(result.assistantText).toBe("hello from claude");
      const toolStart = events.find((event) => event.type === "tool_use_start");
      expect(toolStart).toMatchObject({
        tool_use_id: "toolu_1",
        name: "hawky_session_list",
        input: { limit: 1 },
      });
      const toolResult = events.find((event) => event.type === "tool_result");
      expect(toolResult).toMatchObject({
        tool_use_id: "toolu_1",
        name: "tool",
        content: "session list empty",
        is_error: false,
      });
      expect(events.filter((event) => event.type === "text").map((event) => event.content).join(""))
        .toBe("hello from claude");
      const done = events.find((event) => event.type === "done");
      expect(done?.usage).toEqual({ input_tokens: 4, output_tokens: 5 });
      expect(done?.sessionCostUSD).toBe(0.01);
      const receivedArgs = readFileSync(argsPath, "utf-8");
      expect(receivedArgs).toContain("--output-format");
      expect(receivedArgs).toContain("stream-json");
      expect(receivedArgs).toContain("--include-partial-messages");
      expect(receivedArgs).toContain("Read,Grep,Glob");
      expect(receivedArgs).toContain("--mcp-config");
      expect(receivedArgs).toContain("--strict-mcp-config");
      expect(receivedArgs).toContain("--allowedTools");
      expect(receivedArgs).toContain("mcp__hawky__*");
      const allowedToolsOffset = receivedArgs.indexOf("\n--allowedTools\n");
      const delimiterOffset = receivedArgs.indexOf("\n--\n");
      const promptOffset = receivedArgs.indexOf("You are running inside Hawky");
      expect(allowedToolsOffset).toBeGreaterThanOrEqual(0);
      expect(delimiterOffset).toBeGreaterThan(allowedToolsOffset);
      expect(promptOffset).toBeGreaterThan(delimiterOffset);
    } finally {
      if (prevBin == null) delete process.env.HAWKY_CLAUDE_BIN;
      else process.env.HAWKY_CLAUDE_BIN = prevBin;
      if (prevArgsPath == null) delete process.env.HAWKY_FAKE_CLAUDE_ARGS_PATH;
      else process.env.HAWKY_FAKE_CLAUDE_ARGS_PATH = prevArgsPath;
      if (prevToolSearch == null) delete process.env.ENABLE_TOOL_SEARCH;
      else process.env.ENABLE_TOOL_SEARCH = prevToolSearch;
    }
  });
});

describe("external agent runtime executable resolution", () => {
  test("uses HAWKY-specific binary override first", () => {
    expect(resolveRuntimeExecutable("hermes", {
      HAWKY_HERMES_BIN: "/tmp/custom-hermes",
      HERMES_BIN: "/tmp/other-hermes",
      PATH: "",
    })).toBe("/tmp/custom-hermes");
  });

  test("uses generic binary override when HAWKY override is absent", () => {
    expect(resolveRuntimeExecutable("hermes", {
      HERMES_BIN: "/tmp/generic-hermes",
      PATH: "",
    })).toBe("/tmp/generic-hermes");
  });

  test("finds binaries from PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-runtime-path-"));
    cleanup.push(dir);
    const binary = join(dir, "hawky-fake-runtime");
    writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveRuntimeExecutable("hawky-fake-runtime", { PATH: dir })).toBe(binary);
  });

  test("falls back to the binary name when nothing resolves", () => {
    expect(resolveRuntimeExecutable("not-a-real-hawky-runtime", { PATH: "" }))
      .toBe("not-a-real-hawky-runtime");
  });

  test("MCP server command falls back to the renamed 'hawky' executable when no entrypoint is available", () => {
    // When process.argv[1] is unavailable (e.g. a bundled runtime), the MCP
    // server command resolves the installed CLI by name. After the Hawky
    // rename that name is "hawky", so its override key is HAWKY_BIN — setting
    // it proves both that the fallback fires and that the name is "hawky"
    // (a stale "hawky" name would derive HAWKY_BIN and ignore this).
    const savedArgv1 = process.argv[1];
    const savedBin = process.env.HAWKY_BIN;
    try {
      (process.argv as (string | undefined)[])[1] = undefined;
      process.env.HAWKY_BIN = "/sentinel/bin/hawky";
      const config = JSON.parse(buildClaudeMcpConfig());
      expect(config.mcpServers.hawky.command).toBe("/sentinel/bin/hawky");
      expect(config.mcpServers.hawky.args).toEqual(["mcp"]);
    } finally {
      process.argv[1] = savedArgv1;
      if (savedBin === undefined) delete process.env.HAWKY_BIN;
      else process.env.HAWKY_BIN = savedBin;
    }
  });
});

describe("codex external runtime JSONL parsing", () => {
  test("builds one-off Codex MCP config overrides for Hawky tools", () => {
    const args = buildCodexMcpConfigOverrides({
      command: "/bin/bun",
      args: ["/repo/src/index.ts", "mcp"],
      cwd: "/repo",
    });

    expect(args).toContain("mcp_servers.hawky.enabled=true");
    expect(args).toContain("mcp_servers.hawky.command=\"/bin/bun\"");
    expect(args).toContain("mcp_servers.hawky.args=[\"/repo/src/index.ts\", \"mcp\"]");
    expect(args).toContain("mcp_servers.hawky.cwd=\"/repo\"");
    expect(args).toContain("mcp_servers.hawky.default_tools_approval_mode=\"auto\"");
    expect(args).toContain("mcp_servers.hawky.enabled_tools=[\"hawky_echo\", \"hawky_session_list\", \"hawky_session_read\"]");
  });

  test("parses agent messages and usage from codex JSONL", () => {
    const message = parseCodexJsonLine(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "final answer" },
    }));
    expect(message?.assistantText).toBe("final answer");

    const usage = parseCodexJsonLine(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12, cached_input_tokens: 8, output_tokens: 3 },
    }));
    expect(usage?.usage).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      cache_read_input_tokens: 8,
    });
  });

  test("parses codex command and MCP tool items", () => {
    const commandStart = parseCodexJsonLine(JSON.stringify({
      type: "item.started",
      item: { id: "item_cmd", type: "command_execution", command: "ls" },
    }));
    expect(commandStart?.toolStarts?.[0]).toEqual({
      tool_use_id: "item_cmd",
      name: "bash",
      input: { command: "ls" },
    });

    const commandResult = parseCodexJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_cmd",
        type: "command_execution",
        command: "ls",
        status: "completed",
        output: "file.txt",
        exit_code: 0,
      },
    }));
    expect(commandResult?.toolResults?.[0]).toEqual({
      tool_use_id: "item_cmd",
      name: "bash",
      content: "file.txt",
      is_error: false,
    });

    const mcpStart = parseCodexJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "item_mcp",
        type: "mcp_tool_call",
        name: "mcp__hawky__hawky_session_list",
        input: { limit: 1 },
      },
    }));
    expect(mcpStart?.toolStarts?.[0]).toEqual({
      tool_use_id: "item_mcp",
      name: "hawky_session_list",
      input: { limit: 1 },
    });
  });

  test("falls back to output-last-message file when JSONL has no agent message", () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-codex-output-"));
    cleanup.push(dir);
    const outputPath = join(dir, "last-message.txt");
    writeFileSync(outputPath, "saved final\n", "utf-8");

    const parsed = parseCodexJsonStdout(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      outputPath,
    );
    expect(parsed.text).toBe("saved final");
    expect(parsed.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  test("streams codex agent message and done usage from a fake codex binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-fake-codex-"));
    cleanup.push(dir);
    const binary = join(dir, "codex");
    const argsPath = join(dir, "codex-args.txt");
    writeFileSync(binary, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$HAWKY_FAKE_CODEX_ARGS_PATH\"",
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-test\"}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"item_cmd\",\"type\":\"command_execution\",\"command\":\"ls\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_cmd\",\"type\":\"command_execution\",\"command\":\"ls\",\"status\":\"completed\",\"output\":\"file.txt\",\"exit_code\":0}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello from codex\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"cached_input_tokens\":2,\"output_tokens\":3}}'",
      "",
    ].join("\n"), { mode: 0o755 });

    const prevBin = process.env.HAWKY_CODEX_BIN;
    const prevArgsPath = process.env.HAWKY_FAKE_CODEX_ARGS_PATH;
    process.env.HAWKY_CODEX_BIN = binary;
    process.env.HAWKY_FAKE_CODEX_ARGS_PATH = argsPath;
    try {
      const events: any[] = [];
      const runtime = new ExternalAgentRuntime();
      const result = await runtime.sendMessage({
        runtimeKind: "codex",
        sessionKey: "web:codex-jsonl",
        cwd: dir,
        history: [],
        message: "hello",
        emit: (event) => events.push(event),
      });

      expect(result.assistantText).toBe("hello from codex");
      expect(events.find((event) => event.type === "tool_use_start")).toMatchObject({
        tool_use_id: "item_cmd",
        name: "bash",
        input: { command: "ls" },
      });
      expect(events.find((event) => event.type === "tool_result")).toMatchObject({
        tool_use_id: "item_cmd",
        name: "bash",
        content: "file.txt",
        is_error: false,
      });
      expect(events.some((event) => event.type === "text" && event.content === "hello from codex")).toBe(true);
      const done = events.find((event) => event.type === "done");
      expect(done?.usage).toEqual({
        input_tokens: 5,
        output_tokens: 3,
        cache_read_input_tokens: 2,
      });
      const receivedArgs = readFileSync(argsPath, "utf-8");
      expect(receivedArgs).toContain("mcp_servers.hawky.command=");
      expect(receivedArgs).toContain("mcp_servers.hawky.enabled_tools=");
    } finally {
      if (prevBin == null) delete process.env.HAWKY_CODEX_BIN;
      else process.env.HAWKY_CODEX_BIN = prevBin;
      if (prevArgsPath == null) delete process.env.HAWKY_FAKE_CODEX_ARGS_PATH;
      else process.env.HAWKY_FAKE_CODEX_ARGS_PATH = prevArgsPath;
    }
  });

  test("emits post-tool final answer when it replaces earlier assistant text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-fake-codex-reconcile-"));
    cleanup.push(dir);
    const binary = join(dir, "codex");
    writeFileSync(binary, [
      "#!/bin/sh",
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"I will check.\"}}'",
      "printf '%s\\n' '{\"type\":\"item.started\",\"item\":{\"id\":\"item_cmd\",\"type\":\"command_execution\",\"command\":\"ls\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_cmd\",\"type\":\"command_execution\",\"command\":\"ls\",\"status\":\"completed\",\"output\":\"file.txt\",\"exit_code\":0}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Final answer after tool.\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}'",
      "",
    ].join("\n"), { mode: 0o755 });

    const prevBin = process.env.HAWKY_CODEX_BIN;
    process.env.HAWKY_CODEX_BIN = binary;
    try {
      const events: any[] = [];
      const runtime = new ExternalAgentRuntime();
      const result = await runtime.sendMessage({
        runtimeKind: "codex",
        sessionKey: "web:codex-reconcile",
        cwd: dir,
        history: [],
        message: "hello",
        emit: (event) => events.push(event),
      });

      expect(result.assistantText).toBe("Final answer after tool.");
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(result.messages[1].content[0]).toEqual({
        type: "tool_use",
        id: "item_cmd",
        name: "bash",
        input: { command: "ls" },
      });
      expect(result.messages[2].content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "item_cmd",
        content: "file.txt",
        is_error: false,
      });
      expect(result.messages[3].content[0]).toEqual({
        type: "text",
        text: "Final answer after tool.",
      });
      const textEvents = events.filter((event) => event.type === "text");
      expect(textEvents.map((event) => event.content))
        .toEqual(["I will check.", "Final answer after tool."]);
      expect(textEvents[0].replace).toBeUndefined();
      expect(textEvents[1].replace).toBe(true);
    } finally {
      if (prevBin == null) delete process.env.HAWKY_CODEX_BIN;
      else process.env.HAWKY_CODEX_BIN = prevBin;
    }
  });

  test("emits replacement when a later final answer supersedes earlier text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-fake-codex-replace-"));
    cleanup.push(dir);
    const binary = join(dir, "codex");
    writeFileSync(binary, [
      "#!/bin/sh",
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Draft answer.\"}}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Final answer.\"}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":3}}'",
      "",
    ].join("\n"), { mode: 0o755 });

    const prevBin = process.env.HAWKY_CODEX_BIN;
    process.env.HAWKY_CODEX_BIN = binary;
    try {
      const events: any[] = [];
      const runtime = new ExternalAgentRuntime();
      const result = await runtime.sendMessage({
        runtimeKind: "codex",
        sessionKey: "web:codex-replace",
        cwd: dir,
        history: [],
        message: "hello",
        emit: (event) => events.push(event),
      });

      const textEvents = events.filter((event) => event.type === "text");
      expect(result.assistantText).toBe("Final answer.");
      expect(textEvents.map((event) => event.content)).toEqual(["Draft answer.", "Final answer."]);
      expect(textEvents[1].replace).toBe(true);
    } finally {
      if (prevBin == null) delete process.env.HAWKY_CODEX_BIN;
      else process.env.HAWKY_CODEX_BIN = prevBin;
    }
  });
});
