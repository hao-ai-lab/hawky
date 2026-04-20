// =============================================================================
// Tests: Workspace RPCs
//
// Tests for workspace.list, workspace.read, workspace.write RPCs used by
// the Memory Editor. Uses a temp workspace directory for isolation.
// =============================================================================

import { test, describe, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setWorkspaceDir, WorkspaceManager } from "../src/storage/workspace.js";
import { GatewayServer } from "../src/gateway/server.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";

// Test directory
const testDir = join(tmpdir(), `hawky-ws-rpc-test-${Date.now()}`);
const wsDir = join(testDir, "workspace");

// Mock server that captures registered methods
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
    // Stubs for GatewayServer interface
    broadcast() {},
    broadcastToSession() {},
    getConnections() { return new Map(); },
  };
}

beforeAll(() => {
  // Set up test workspace
  mkdirSync(join(wsDir, "memory"), { recursive: true });
  setWorkspaceDir(wsDir);

  // Create test files
  writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n\nTest content here.\n");
  writeFileSync(join(wsDir, "SOUL.md"), "# Soul\n\nI am Hawky.\n");
  writeFileSync(join(wsDir, "USER.md"), "# User\n\nHao Zhang.\n");
  writeFileSync(join(wsDir, "AGENTS.md"), "# Agents\n\nAgent config.\n");
  writeFileSync(join(wsDir, "memory", "2026-04-01.md"), "# 2026-04-01\n\n[10:00] Morning note.\n");
  writeFileSync(join(wsDir, "memory", "2026-04-02.md"), "# 2026-04-02\n\n[14:00] Afternoon note.\n");

  // Register methods on mock server
  const server = makeMockServer();
  registerAgentMethods(server as any, {} as any);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const server = makeMockServer();

// Re-register for each test call
function callRpc(method: string, params?: any) {
  // Create a fresh mock server each time to ensure methods are registered
  const s = makeMockServer();
  registerAgentMethods(s as any, {} as any);
  return s.call(method, { sessionKey: "test" }, params);
}

// =============================================================================
// workspace.list
// =============================================================================

describe("workspace.list", () => {
  test("returns workspace files and daily logs", () => {
    const result = callRpc("workspace.list") as any;
    expect(result.files).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);

    const names = result.files.map((f: any) => f.name);
    expect(names).toContain("MEMORY.md");
    expect(names).toContain("SOUL.md");
    expect(names).toContain("USER.md");
  });

  test("daily logs appear with memory/ path prefix", () => {
    const result = callRpc("workspace.list") as any;
    const dailyLogs = result.files.filter((f: any) => f.path.startsWith("memory/"));
    expect(dailyLogs.length).toBeGreaterThanOrEqual(2);
    expect(dailyLogs[0].path).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
  });

  test("daily logs are sorted newest first", () => {
    const result = callRpc("workspace.list") as any;
    const dailyLogs = result.files.filter((f: any) => f.path.startsWith("memory/"));
    if (dailyLogs.length >= 2) {
      // Newest first
      expect(dailyLogs[0].name >= dailyLogs[1].name).toBe(true);
    }
  });

  test("MEMORY.md is editable", () => {
    const result = callRpc("workspace.list") as any;
    const memory = result.files.find((f: any) => f.name === "MEMORY.md");
    expect(memory.editable).toBe(true);
  });

  test("SOUL.md is read-only", () => {
    const result = callRpc("workspace.list") as any;
    const soul = result.files.find((f: any) => f.name === "SOUL.md");
    expect(soul.editable).toBe(false);
  });

  test("daily logs are editable", () => {
    const result = callRpc("workspace.list") as any;
    const dailyLogs = result.files.filter((f: any) => f.path.startsWith("memory/"));
    for (const log of dailyLogs) {
      expect(log.editable).toBe(true);
    }
  });

  test("files include size", () => {
    const result = callRpc("workspace.list") as any;
    const memory = result.files.find((f: any) => f.name === "MEMORY.md");
    expect(typeof memory.size).toBe("number");
    expect(memory.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// workspace.read
// =============================================================================

describe("workspace.read", () => {
  test("reads MEMORY.md content", () => {
    const result = callRpc("workspace.read", { path: "MEMORY.md" }) as any;
    expect(result.content).toContain("# Memory");
    expect(result.content).toContain("Test content");
    expect(result.path).toBe("MEMORY.md");
    expect(result.editable).toBe(true);
  });

  test("reads SOUL.md as read-only", () => {
    const result = callRpc("workspace.read", { path: "SOUL.md" }) as any;
    expect(result.content).toContain("# Soul");
    expect(result.editable).toBe(false);
  });

  test("reads daily log", () => {
    const result = callRpc("workspace.read", { path: "memory/2026-04-01.md" }) as any;
    expect(result.content).toContain("Morning note");
    expect(result.editable).toBe(true);
  });

  test("rejects missing path", () => {
    expect(() => callRpc("workspace.read", {})).toThrow("path is required");
  });

  test("rejects nonexistent file", () => {
    expect(() => callRpc("workspace.read", { path: "NONEXISTENT.md" })).toThrow("not accessible");
  });

  test("rejects path traversal", () => {
    expect(() => callRpc("workspace.read", { path: "../etc/passwd.md" })).toThrow("invalid");
  });

  test("rejects absolute path", () => {
    expect(() => callRpc("workspace.read", { path: "/etc/passwd.md" })).toThrow("invalid");
  });

  test("rejects non-.md files", () => {
    expect(() => callRpc("workspace.read", { path: "secrets.json" })).toThrow("invalid");
  });

  test("rejects BOOTSTRAP.md (internal file)", () => {
    expect(() => callRpc("workspace.read", { path: "BOOTSTRAP.md" })).toThrow("not accessible");
  });

  test("rejects TOOLS.md (internal file)", () => {
    expect(() => callRpc("workspace.read", { path: "TOOLS.md" })).toThrow("not accessible");
  });
});

// =============================================================================
// workspace.write
// =============================================================================

describe("workspace.write", () => {
  test("writes to MEMORY.md", () => {
    const newContent = "# Memory\n\nUpdated content.\n";
    const result = callRpc("workspace.write", { path: "MEMORY.md", content: newContent }) as any;
    expect(result.ok).toBe(true);

    // Verify on disk
    const onDisk = readFileSync(join(wsDir, "MEMORY.md"), "utf-8");
    expect(onDisk).toBe(newContent);
  });

  test("writes to daily log", () => {
    const newContent = "# 2026-04-01\n\nUpdated log.\n";
    const result = callRpc("workspace.write", { path: "memory/2026-04-01.md", content: newContent }) as any;
    expect(result.ok).toBe(true);

    const onDisk = readFileSync(join(wsDir, "memory", "2026-04-01.md"), "utf-8");
    expect(onDisk).toBe(newContent);
  });

  test("rejects write to read-only file (SOUL.md)", () => {
    expect(() => callRpc("workspace.write", { path: "SOUL.md", content: "hacked" })).toThrow("read-only");
  });

  test("rejects write to read-only file (USER.md)", () => {
    expect(() => callRpc("workspace.write", { path: "USER.md", content: "hacked" })).toThrow("read-only");
  });

  test("rejects write to read-only file (AGENTS.md)", () => {
    expect(() => callRpc("workspace.write", { path: "AGENTS.md", content: "hacked" })).toThrow("read-only");
  });

  test("rejects missing path", () => {
    expect(() => callRpc("workspace.write", { content: "text" })).toThrow("path and content are required");
  });

  test("rejects missing content", () => {
    expect(() => callRpc("workspace.write", { path: "MEMORY.md" })).toThrow("path and content are required");
  });

  test("rejects path traversal", () => {
    expect(() => callRpc("workspace.write", { path: "../evil.md", content: "x" })).toThrow("invalid");
  });

  test("rejects non-.md files", () => {
    expect(() => callRpc("workspace.write", { path: "script.sh", content: "x" })).toThrow("invalid");
  });
});
