// =============================================================================
// Tests: MCP Integration
// =============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mcpToolName, bridgeMcpTool } from "../src/mcp/tool-bridge.js";
import type { McpServerConfig } from "../src/mcp/types.js";
import { McpServerManager } from "../src/mcp/server-manager.js";
import {
  callHawkyMcpTool,
  createHawkyMcpServer,
  listHawkyMcpTools,
  readPersistedHawkySession,
} from "../src/mcp/hawky-server.js";
import { resetSessionsDir, SessionManager, setSessionsDir } from "../src/storage/session.js";
import type { ChatMessage } from "../src/agent/types.js";

// -----------------------------------------------------------------------------
// mcpToolName
// -----------------------------------------------------------------------------

describe("mcpToolName", () => {
  it("creates prefixed tool name", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp_github_create_issue");
  });

  it("sanitizes server name", () => {
    expect(mcpToolName("my-server", "do_thing")).toBe("mcp_my_server_do_thing");
    expect(mcpToolName("My Server!", "tool")).toBe("mcp_my_server__tool");
  });

  it("sanitizes tool name", () => {
    expect(mcpToolName("server", "weird tool")).toBe("mcp_server_weird_tool");
  });

  it("handles uppercase", () => {
    expect(mcpToolName("GitHub", "ListPRs")).toBe("mcp_github_ListPRs");
  });
});

// -----------------------------------------------------------------------------
// bridgeMcpTool
// -----------------------------------------------------------------------------

describe("bridgeMcpTool", () => {
  // Mock MCP client
  const mockClient = {
    callTool: async (params: any) => ({
      content: [{ type: "text", text: `Result for ${params.name}` }],
      isError: false,
    }),
  } as any;

  it("converts MCP tool to ToolDefinition", () => {
    const mcpTool = {
      name: "create_issue",
      description: "Create a GitHub issue",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          body: { type: "string", description: "Issue body" },
        },
        required: ["title"],
      },
    };

    const { definition, info } = bridgeMcpTool("github", mcpTool, mockClient, "ask_user");

    expect(definition.name).toBe("mcp_github_create_issue");
    expect(definition.description).toContain("MCP: github");
    expect(definition.description).toContain("Create a GitHub issue");
    expect(definition.permission).toBe("ask_user");
    expect(definition.input_schema.properties.title).toBeDefined();
    expect(definition.input_schema.properties.title.type).toBe("string");
    expect(definition.input_schema.required).toContain("title");

    expect(info.serverName).toBe("github");
    expect(info.originalName).toBe("create_issue");
    expect(info.registeredName).toBe("mcp_github_create_issue");
  });

  it("handles tool with no input schema", () => {
    const mcpTool = { name: "ping", description: "Ping the server" };
    const { definition } = bridgeMcpTool("server", mcpTool, mockClient, "auto_approve");

    expect(definition.name).toBe("mcp_server_ping");
    expect(definition.input_schema.properties).toEqual({});
  });

  it("executes tool via MCP client", async () => {
    const mcpTool = { name: "test_tool" };
    const { definition } = bridgeMcpTool("server", mcpTool, mockClient, "auto_approve");

    const result = await definition.execute(
      { arg1: "value" },
      {
        session_id: "test",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.type).toBe("text");
    expect(result.content).toContain("Result for test_tool");
  });

  it("returns error result on MCP failure", async () => {
    const failingClient = {
      callTool: async () => { throw new Error("Server disconnected"); },
    } as any;

    const mcpTool = { name: "failing_tool" };
    const { definition } = bridgeMcpTool("server", mcpTool, failingClient, "auto_approve");

    const result = await definition.execute(
      {},
      {
        session_id: "test",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.type).toBe("error");
    expect(result.content).toContain("Server disconnected");
  });

  it("handles MCP error result", async () => {
    const errorClient = {
      callTool: async () => ({
        content: [{ type: "text", text: "Not found" }],
        isError: true,
      }),
    } as any;

    const mcpTool = { name: "error_tool" };
    const { definition } = bridgeMcpTool("server", mcpTool, errorClient, "auto_approve");

    const result = await definition.execute(
      {},
      {
        session_id: "test",
        working_directory: "/tmp",
        abort_signal: new AbortController().signal,
        emit: () => {},
      },
    );

    expect(result.type).toBe("error");
    expect(result.content).toContain("Not found");
  });

  it("respects abort signal", async () => {
    const mcpTool = { name: "slow_tool" };
    const { definition } = bridgeMcpTool("server", mcpTool, mockClient, "auto_approve");

    const abortController = new AbortController();
    abortController.abort();

    const result = await definition.execute(
      {},
      {
        session_id: "test",
        working_directory: "/tmp",
        abort_signal: abortController.signal,
        emit: () => {},
      },
    );

    expect(result.type).toBe("error");
    expect(result.content).toContain("interrupted");
  });

  it("uses configured permission level", () => {
    const mcpTool = { name: "tool" };
    const { definition: d1 } = bridgeMcpTool("s", mcpTool, mockClient, "auto_approve");
    const { definition: d2 } = bridgeMcpTool("s", mcpTool, mockClient, "ask_user");
    expect(d1.permission).toBe("auto_approve");
    expect(d2.permission).toBe("ask_user");
  });
});

// -----------------------------------------------------------------------------
// McpServerManager
// -----------------------------------------------------------------------------

describe("McpServerManager", () => {
  it("starts with no servers", () => {
    const manager = new McpServerManager();
    expect(manager.connectedCount).toBe(0);
    expect(manager.totalToolCount).toBe(0);
    expect(manager.getAllStates()).toEqual([]);
    expect(manager.getAllTools()).toEqual([]);
  });

  it("startAll with empty config does nothing", async () => {
    const manager = new McpServerManager();
    await manager.startAll({});
    expect(manager.connectedCount).toBe(0);
  });

  it("startAll logs error for invalid stdio config (no command)", async () => {
    const manager = new McpServerManager();
    await manager.startAll({
      broken: { transport: "stdio" },
    });
    const states = manager.getAllStates();
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe("error");
    expect(states[0].error).toContain("command");
  });

  it("startAll logs error for invalid sse config (no url)", async () => {
    const manager = new McpServerManager();
    await manager.startAll({
      broken: { transport: "sse" },
    });
    const states = manager.getAllStates();
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe("error");
    expect(states[0].error).toContain("url");
  });

  it("stopAll on empty manager is no-op", async () => {
    const manager = new McpServerManager();
    await manager.stopAll(); // should not throw
  });

  it("getServerToolNames returns empty for unknown server", () => {
    const manager = new McpServerManager();
    expect(manager.getServerToolNames("unknown")).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Hawky MCP Server
// -----------------------------------------------------------------------------

describe("Hawky MCP server", () => {
  it("lists read-only Hawky tools", () => {
    const tools = listHawkyMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "hawky_echo",
      "hawky_session_list",
      "hawky_session_read",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it("executes echo and reports unknown tools as MCP errors", async () => {
    const echo = await callHawkyMcpTool("hawky_echo", { text: "ping" });
    expect(textContent(echo)).toBe("ping");
    expect(echo.isError).toBeUndefined();

    const unknown = await callHawkyMcpTool("hawky_nope", {});
    expect(unknown.isError).toBe(true);
    expect(textContent(unknown)).toContain("Unknown Hawky MCP tool");
  });

  it("routes session list and read calls through injected context", async () => {
    const listed = await callHawkyMcpTool(
      "hawky_session_list",
      { limit: 3, includeArchived: true },
      {
        listSessions: (opts) => {
          expect(opts).toEqual({ limit: 3, includeArchived: true });
          return {
            sessions: [{
              sessionKey: "web:general",
              id: "web/general",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastModified: 1,
              messageCount: 2,
            }],
          };
        },
      },
    );
    expect(JSON.parse(textContent(listed)).sessions[0].sessionKey).toBe("web:general");

    const read = await callHawkyMcpTool(
      "hawky_session_read",
      { sessionKey: "web:general", limit: 1, beforeIndex: 2 },
      {
        readSession: (opts) => {
          expect(opts).toEqual({ sessionKey: "web:general", limit: 1, beforeIndex: 2 });
          return {
            sessionKey: "web:general",
            total: 2,
            startIndex: 1,
            endIndex: 2,
            hasMore: true,
            messages: [{ index: 1, role: "assistant", text: "hello" }],
            transcript: "[1] assistant: hello",
          };
        },
      },
    );
    const parsed = JSON.parse(textContent(read));
    expect(parsed.transcript).toContain("assistant: hello");
  });

  it("reads persisted session transcript without creating missing sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-mcp-"));
    setSessionsDir(dir);
    try {
      const session = new SessionManager("web/general");
      session.initSession("test-model", "/tmp/work");
      session.appendMessage(makeMessage("user", "hello from user"));
      session.appendMessage(makeMessage("assistant", "hello from assistant"));

      const result = await readPersistedHawkySession({ sessionKey: "web:general", limit: 2 });
      expect(result).not.toBeNull();
      expect(result!.total).toBe(2);
      expect(result!.messages.map((msg) => msg.role)).toEqual(["user", "assistant"]);
      expect(result!.transcript).toContain("hello from user");
      expect(result!.transcript).toContain("hello from assistant");

      const missing = await readPersistedHawkySession({ sessionKey: "web:missing" });
      expect(missing).toBeNull();
    } finally {
      resetSessionsDir();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects traversal session keys before loading from disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "hawky-mcp-traversal-"));
    const sessionsDir = join(root, "sessions");
    setSessionsDir(sessionsDir);
    try {
      const outside = new SessionManager("other", root);
      outside.initSession("test-model", "/tmp/outside");
      outside.appendMessage(makeMessage("assistant", "outside secret"));

      const visible = new SessionManager("web/general");
      visible.initSession("test-model", "/tmp/work");
      visible.appendMessage(makeMessage("assistant", "inside session"));

      const traversal = await readPersistedHawkySession({ sessionKey: "web:../../other" });
      expect(traversal).toBeNull();

      const valid = await readPersistedHawkySession({ sessionKey: "web:general" });
      expect(valid?.transcript).toContain("inside session");
      expect(valid?.transcript).not.toContain("outside secret");
    } finally {
      resetSessionsDir();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns MCP error for invalid session_read input", async () => {
    const result = await callHawkyMcpTool("hawky_session_read", {});
    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("sessionKey");
  });

  it("serves tools over the MCP protocol", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createHawkyMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("hawky_echo");

      const result = await client.callTool({ name: "hawky_echo", arguments: { text: "round trip" } });
      expect(textContent(result)).toBe("round trip");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function makeMessage(role: "user" | "assistant", text: string): ChatMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: new Date(0).toISOString(),
  };
}

function textContent(result: { content?: unknown[] }): string {
  return (result.content ?? [])
    .map((block) => {
      if (typeof block === "object" && block && (block as any).type === "text") {
        return String((block as any).text ?? "");
      }
      return "";
    })
    .join("\n");
}
