// =============================================================================
// Tests: Session Management RPCs
//
// Covers: session.rename, session.archive, session.unarchive, session.delete,
//         session.pin, session.unpin, and updated session.list with meta fields.
// =============================================================================

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionsDir, resetSessionsDir, SessionManager, loadSessionMeta } from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { resetConfig, resetConfigDir, setConfigDir } from "../src/storage/config.js";
import { GatewayServer } from "../src/gateway/server.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";

// =============================================================================
// Mock server
// =============================================================================

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: any, params: any) {
      const method = methods[name];
      if (!method) throw new Error(`Method not found: ${name}`);
      return method(conn, params, this);
    },
    methods,
    broadcast() {},
    broadcastToSession() {},
    getConnections() { return new Map(); },
  };
}

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;
let sessionsDir: string;
let wsDir: string;
let server: ReturnType<typeof makeMockServer>;
let sessions: AgentSessionManager;
const mockConn = { sessionKey: null, workingDirectory: "/tmp", bindSession() {} };

function createTestSession(sessionKey: string, messageCount = 2): void {
  const sessionId = sessionKey.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  const sm = new SessionManager(sessionId, sessionsDir);
  sm.initSession("test-model", "/tmp");
  for (let i = 0; i < messageCount; i++) {
    sm.appendMessage({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Message ${i}` }],
    });
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-rpc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionsDir = join(testDir, "sessions");
  wsDir = join(testDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  setWorkspaceDir(wsDir);

  // Create workspace files needed by registerAgentMethods
  writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n");
  writeFileSync(join(testDir, "config.json"), JSON.stringify({
    api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
    provider: "anthropic",
    experiments: { agent_runtimes: true },
  }));
  setConfigDir(testDir);
  resetConfig();

  server = makeMockServer();

  // Create a minimal mock provider
  const mockProvider = {
    createMessage: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], model: "test", stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
    countTokens: async () => ({ input_tokens: 0 }),
  };

  sessions = new AgentSessionManager({
    provider: mockProvider as any,
    config: { model: "test", api_key: "test" } as any,
    workingDirectory: "/tmp",
    server: server as any,
  });

  registerAgentMethods(server as any, sessions, { model: "test", api_key: "test" } as any);
});

afterEach(() => {
  resetSessionsDir();
  resetConfig();
  resetConfigDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// session.rename
// =============================================================================

describe("session.rename", () => {
  test("sets display name in meta.json", () => {
    createTestSession("web:general");
    const result = server.call("session.rename", mockConn, {
      sessionKey: "web:general",
      displayName: "My Project",
    });
    expect(result.ok).toBe(true);
    expect(result.displayName).toBe("My Project");
    const meta = loadSessionMeta();
    expect(meta["web:general"]?.displayName).toBe("My Project");
  });

  test("clears display name with empty string", () => {
    createTestSession("web:general");
    server.call("session.rename", mockConn, { sessionKey: "web:general", displayName: "Name" });
    const result = server.call("session.rename", mockConn, { sessionKey: "web:general", displayName: "" });
    expect(result.displayName).toBeNull();
    const meta = loadSessionMeta();
    // Entry cleaned up since no meaningful fields
    expect(meta["web:general"]).toBeUndefined();
  });

  test("trims whitespace from display name", () => {
    server.call("session.rename", mockConn, { sessionKey: "web:test", displayName: "  Trimmed  " });
    const meta = loadSessionMeta();
    expect(meta["web:test"]?.displayName).toBe("Trimmed");
  });

  test("throws on missing sessionKey", () => {
    expect(() => server.call("session.rename", mockConn, {})).toThrow();
  });

  test("throws on missing displayName", () => {
    expect(() => server.call("session.rename", mockConn, { sessionKey: "web:x" })).toThrow();
  });
});

// =============================================================================
// session.archive / session.unarchive
// =============================================================================

describe("session.archive", () => {
  test("sets archived flag in meta.json", () => {
    createTestSession("web:temp");
    const result = server.call("session.archive", mockConn, { sessionKey: "web:temp" });
    expect(result.ok).toBe(true);
    const meta = loadSessionMeta();
    expect(meta["web:temp"]?.archived).toBe(true);
  });

  test("preserves JSONL file (doesn't delete data)", () => {
    createTestSession("web:temp");
    server.call("session.archive", mockConn, { sessionKey: "web:temp" });
    expect(existsSync(join(sessionsDir, "web", "temp.jsonl"))).toBe(true);
  });

  test("throws on missing sessionKey", () => {
    expect(() => server.call("session.archive", mockConn, {})).toThrow();
  });
});

describe("session.unarchive", () => {
  test("clears archived flag", () => {
    createTestSession("web:temp");
    server.call("session.archive", mockConn, { sessionKey: "web:temp" });
    server.call("session.unarchive", mockConn, { sessionKey: "web:temp" });
    const meta = loadSessionMeta();
    // Entry should be cleaned up (no meaningful fields)
    expect(meta["web:temp"]).toBeUndefined();
  });

  test("preserves other meta fields when unarchiving", () => {
    server.call("session.rename", mockConn, { sessionKey: "web:temp", displayName: "Keep" });
    server.call("session.archive", mockConn, { sessionKey: "web:temp" });
    server.call("session.unarchive", mockConn, { sessionKey: "web:temp" });
    const meta = loadSessionMeta();
    expect(meta["web:temp"]?.displayName).toBe("Keep");
    expect(meta["web:temp"]?.archived).toBeUndefined();
  });

  test("throws on missing sessionKey", () => {
    expect(() => server.call("session.unarchive", mockConn, {})).toThrow();
  });
});

// =============================================================================
// session.delete
// =============================================================================

describe("session.delete", () => {
  test("deletes JSONL file from disk", () => {
    createTestSession("web:trash");
    expect(existsSync(join(sessionsDir, "web", "trash.jsonl"))).toBe(true);
    const result = server.call("session.delete", mockConn, { sessionKey: "web:trash" });
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
    expect(existsSync(join(sessionsDir, "web", "trash.jsonl"))).toBe(false);
  });

  test("removes meta entry", () => {
    createTestSession("web:trash");
    server.call("session.rename", mockConn, { sessionKey: "web:trash", displayName: "Gone" });
    server.call("session.delete", mockConn, { sessionKey: "web:trash" });
    const meta = loadSessionMeta();
    expect(meta["web:trash"]).toBeUndefined();
  });

  test("evicts from in-memory session manager", () => {
    createTestSession("web:inmem");
    // Load into memory
    sessions.getOrCreate("web:inmem");
    expect(sessions.has("web:inmem")).toBe(true);
    server.call("session.delete", mockConn, { sessionKey: "web:inmem" });
    expect(sessions.has("web:inmem")).toBe(false);
  });

  test("returns deleted=false for nonexistent file", () => {
    const result = server.call("session.delete", mockConn, { sessionKey: "web:ghost" });
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(false);
  });

  test("throws on missing sessionKey", () => {
    expect(() => server.call("session.delete", mockConn, {})).toThrow();
  });
});

// =============================================================================
// session.pin / session.unpin
// =============================================================================

describe("session.pin", () => {
  test("sets pinned flag in meta.json", () => {
    const result = server.call("session.pin", mockConn, { sessionKey: "web:important" });
    expect(result.ok).toBe(true);
    const meta = loadSessionMeta();
    expect(meta["web:important"]?.pinned).toBe(true);
  });

  test("throws on missing sessionKey", () => {
    expect(() => server.call("session.pin", mockConn, {})).toThrow();
  });
});

describe("session.unpin", () => {
  test("clears pinned flag", () => {
    server.call("session.pin", mockConn, { sessionKey: "web:pinned" });
    server.call("session.unpin", mockConn, { sessionKey: "web:pinned" });
    const meta = loadSessionMeta();
    // Entry cleaned up — no meaningful fields
    expect(meta["web:pinned"]).toBeUndefined();
  });

  test("throws on missing sessionKey", () => {
    expect(() => server.call("session.unpin", mockConn, {})).toThrow();
  });
});

// =============================================================================
// session.resolve runtime selection
// =============================================================================

describe("session.resolve runtimeKind", () => {
  test("rejects experimental runtime kind when feature flag is disabled", () => {
    writeFileSync(join(testDir, "config.json"), JSON.stringify({
      api_keys: { anthropic: "sk-ant-test", openai: "", brave_search: "" },
      provider: "anthropic",
      experiments: { agent_runtimes: false },
    }));
    resetConfig();

    expect(() => server.call("session.resolve", mockConn, {
      sessionKey: "web:blocked-hermes",
      runtimeKind: "hermes",
    })).toThrow();
  });

  test("persists experimental runtime kind for new sessions", () => {
    const result = server.call("session.resolve", mockConn, {
      sessionKey: "web:codex-test",
      runtimeKind: "codex",
      workingDirectory: "/tmp/runtime-cwd",
    });

    expect(result.runtimeKind).toBe("codex");
    expect(result.runtimeCapabilities).toMatchObject({
      streaming: true,
      mcp: true,
      attachments: false,
      permissions: false,
      usage: true,
      structuredHistory: false,
    });
    const meta = loadSessionMeta();
    expect(meta["web:codex-test"]?.runtimeKind).toBe("codex");
  });

  test("persists claude runtime kind with streaming MCP capabilities", () => {
    const result = server.call("session.resolve", mockConn, {
      sessionKey: "web:claude-test",
      runtimeKind: "claude",
      workingDirectory: "/tmp/runtime-cwd",
    });

    expect(result.runtimeKind).toBe("claude");
    expect(result.runtimeCapabilities).toMatchObject({
      streaming: true,
      mcp: true,
      attachments: false,
      permissions: false,
      usage: true,
      structuredHistory: false,
    });
    const meta = loadSessionMeta();
    expect(meta["web:claude-test"]?.runtimeKind).toBe("claude");
  });

  test("session.list returns persisted runtime kind", () => {
    server.call("session.resolve", mockConn, {
      sessionKey: "web:hermes-test",
      runtimeKind: "hermes",
    });

    const result = server.call("session.list", mockConn, { limit: 10 });
    const session = result.sessions.find((s: any) => s.id === "web/hermes-test");
    expect(session?.runtimeKind).toBe("hermes");
    expect(session?.runtimeCapabilities).toMatchObject({
      streaming: false,
      attachments: false,
      permissions: false,
      usage: false,
    });
  });

  test("defaults legacy sessions to native runtime", () => {
    createTestSession("web:plain-runtime", 1);

    const result = server.call("session.list", mockConn, { limit: 10 });
    const session = result.sessions.find((s: any) => s.id === "web/plain-runtime");
    expect(session?.runtimeKind).toBe("native");
  });

  test("rejects invalid runtime kind", () => {
    expect(() => server.call("session.resolve", mockConn, {
      sessionKey: "web:nope",
      runtimeKind: "bad",
    })).toThrow();
  });

  test("chat.send rejects attachments for experimental text-only runtimes", async () => {
    server.call("session.resolve", mockConn, {
      sessionKey: "web:codex-text-only",
      runtimeKind: "codex",
    });

    await expect(server.call("chat.send", mockConn, {
      sessionKey: "web:codex-text-only",
      message: "describe this image",
      attachments: [{ base64: "AAAA", media_type: "image/png" }],
    })).rejects.toThrow("text-only");
  });

  test("chat.send persists external runtime tool_use and tool_result messages", async () => {
    const binary = join(testDir, "fake-codex");
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
      server.call("session.resolve", mockConn, {
        sessionKey: "web:codex-persist",
        runtimeKind: "codex",
        workingDirectory: testDir,
      });

      await server.call("chat.send", mockConn, {
        sessionKey: "web:codex-persist",
        message: "list files",
      });

      const persisted = new SessionManager("web/codex-persist", sessionsDir).loadSession();
      expect(persisted?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(persisted?.messages[1].content[0]).toEqual({
        type: "tool_use",
        id: "item_cmd",
        name: "bash",
        input: { command: "ls" },
      });
      expect(persisted?.messages[2].content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "item_cmd",
        content: "file.txt",
        is_error: false,
      });
      expect(persisted?.messages[3].content[0]).toEqual({
        type: "text",
        text: "Final answer after tool.",
      });
    } finally {
      if (prevBin == null) delete process.env.HAWKY_CODEX_BIN;
      else process.env.HAWKY_CODEX_BIN = prevBin;
    }
  });
});

// =============================================================================
// session.exists
// =============================================================================

describe("session.exists", () => {
  test("checks the configured sessions directory", () => {
    createTestSession("web:configured", 1);

    const result = server.call("session.exists", mockConn, { sessionKey: "web:configured" });

    expect(result).toEqual({ exists: true, sessionKey: "web:configured" });
  });
});

// =============================================================================
// session.list with meta fields
// =============================================================================

describe("session.list with meta", () => {
  test("returns displayName, pinned, archived in session list", () => {
    createTestSession("web:general", 3);
    server.call("session.rename", mockConn, { sessionKey: "web:general", displayName: "Main" });
    server.call("session.pin", mockConn, { sessionKey: "web:general" });

    const result = server.call("session.list", mockConn, { limit: 10 });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].displayName).toBe("Main");
    expect(result.sessions[0].pinned).toBe(true);
    expect(result.sessions[0].archived).toBe(false);
  });

  test("excludes archived sessions by default", () => {
    createTestSession("web:visible", 1);
    createTestSession("web:hidden", 1);
    server.call("session.archive", mockConn, { sessionKey: "web:hidden" });

    const result = server.call("session.list", mockConn, { limit: 10 });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("web/visible");
  });

  test("includes archived when includeArchived=true", () => {
    createTestSession("web:visible", 1);
    createTestSession("web:hidden", 1);
    server.call("session.archive", mockConn, { sessionKey: "web:hidden" });

    const result = server.call("session.list", mockConn, { limit: 10, includeArchived: true });
    expect(result.sessions.length).toBe(2);
  });

  test("sessions without meta have null/false defaults", () => {
    createTestSession("web:plain", 1);
    const result = server.call("session.list", mockConn, { limit: 10 });
    expect(result.sessions[0].displayName).toBeNull();
    expect(result.sessions[0].pinned).toBe(false);
    expect(result.sessions[0].archived).toBe(false);
  });

  test("marks active sessions by exact storage id match", () => {
    createTestSession("web:general", 1);
    createTestSession("web:general-archive", 1);
    sessions.getOrCreate("web:general-archive");

    const result = server.call("session.list", mockConn, { limit: 10 });
    const general = result.sessions.find((s: any) => s.id === "web/general");
    const archive = result.sessions.find((s: any) => s.id === "web/general-archive");

    expect(general?.active).toBe(false);
    expect(archive?.active).toBe(true);
  });
});
