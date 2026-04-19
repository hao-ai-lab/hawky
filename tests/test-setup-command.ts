// =============================================================================
// Tests for /setup command and SETUP.md template
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeCommand,
  parseCommand,
  isCommand,
  getCommands,
} from "../src/tui/commands.js";
import { WorkspaceManager, setWorkspaceDir, WORKSPACE_FILES, EXTRA_TEMPLATE_FILES } from "../src/storage/workspace.js";
import type { CommandContext } from "../src/tui/commands.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    model: "claude-sonnet-4-6",
    workingDirectory: testDir,
    sessionId: "test-session",
    tokenUsage: null,
    messageCount: 0,
    previousSessionKey: null,
    setPreviousSessionKey: () => {},
    exit: () => {},
    clearMessages: () => {},
    newSession: () => {},
    flushMemory: () => {},
    switchModel: () => {},
    resumeSession: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-setup-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// /setup command registration
// =============================================================================

describe("/setup command", () => {
  test("is registered in command list", () => {
    const commands = getCommands();
    const setup = commands.find((c) => c.name === "setup");
    expect(setup).toBeDefined();
    expect(setup!.description).toContain("setup wizard");
  });

  test("parseCommand recognizes /setup", () => {
    const parsed = parseCommand("/setup");
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("setup");
    expect(parsed!.args).toEqual([]);
  });

  test("returns skillMessage to send to agent", () => {
    const ctx = makeContext();
    const result = executeCommand("/setup", ctx);
    expect(result.handled).toBe(false);
    expect(result.skillMessage).toBeDefined();
    expect(result.skillMessage).toContain("SETUP.md");
    expect(result.text).toBeNull();
  });

  test("skillMessage includes resolved config path", () => {
    const ctx = makeContext();
    const result = executeCommand("/setup", ctx);
    // Should contain an absolute path, not ~
    expect(result.skillMessage).toContain("config.json");
    expect(result.skillMessage).not.toContain("~/");
  });

  test("skillMessage mentions re-run detection", () => {
    const ctx = makeContext();
    const result = executeCommand("/setup", ctx);
    expect(result.skillMessage).toContain("setup_completed_at");
  });

  test("shows in /help output", () => {
    const ctx = makeContext();
    const result = executeCommand("/help", ctx);
    expect(result.text).toContain("/setup");
    expect(result.text).toContain("setup wizard");
  });
});

// =============================================================================
// SETUP.md template
// =============================================================================

describe("SETUP.md template", () => {
  test("template file exists in src/templates", () => {
    const templatePath = join(__dirname, "..", "src", "templates", "SETUP.md");
    expect(existsSync(templatePath)).toBe(true);
  });

  test("template contains all wizard sections", () => {
    const templatePath = join(__dirname, "..", "src", "templates", "SETUP.md");
    const content = readFileSync(templatePath, "utf-8");
    expect(content).toContain("Section 1: API Keys");
    expect(content).toContain("Section 2: Skills");
    expect(content).toContain("Section 3: Heartbeat");
    expect(content).toContain("Section 4: Push Notifications");
    expect(content).toContain("Section 5: Slack Integration");
    expect(content).toContain("Section 6: Memory Warm-Up");
    expect(content).toContain("Section 7: Summary");
  });

  test("template mentions re-run behavior", () => {
    const templatePath = join(__dirname, "..", "src", "templates", "SETUP.md");
    const content = readFileSync(templatePath, "utf-8");
    expect(content).toContain("re-run");
    expect(content).toContain("setup_completed_at");
  });

  test("template mentions skippable sections", () => {
    const templatePath = join(__dirname, "..", "src", "templates", "SETUP.md");
    const content = readFileSync(templatePath, "utf-8");
    expect(content).toContain("skip");
  });

  test("template mentions privacy gate for memory import", () => {
    const templatePath = join(__dirname, "..", "src", "templates", "SETUP.md");
    const content = readFileSync(templatePath, "utf-8");
    expect(content).toContain("Privacy");
    expect(content).toContain("review before saving");
  });
});

// =============================================================================
// Workspace integration
// =============================================================================

describe("SETUP.md workspace integration", () => {
  test("SETUP.md is in EXTRA_TEMPLATE_FILES (not injected into system prompt)", () => {
    expect(EXTRA_TEMPLATE_FILES).toContain("SETUP.md");
    // Must NOT be in WORKSPACE_FILES (which get injected into every prompt)
    expect(WORKSPACE_FILES).not.toContain("SETUP.md");
  });

  test("workspace init creates SETUP.md on first run", () => {
    const wsDir = join(testDir, "workspace");
    setWorkspaceDir(wsDir);
    const ws = new WorkspaceManager();
    const created = ws.init();
    expect(created).toContain("SETUP.md");
    expect(existsSync(join(wsDir, "SETUP.md"))).toBe(true);
  });

  test("workspace init does not overwrite existing SETUP.md", () => {
    const wsDir = join(testDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const setupPath = join(wsDir, "SETUP.md");
    const customContent = "# Custom setup\nUser modified this.";
    require("fs").writeFileSync(setupPath, customContent);

    setWorkspaceDir(wsDir);
    const ws = new WorkspaceManager();
    ws.init();

    const content = readFileSync(setupPath, "utf-8");
    expect(content).toBe(customContent);
  });

  test("SETUP.md persists across workspace reinit (unlike BOOTSTRAP.md)", () => {
    const wsDir = join(testDir, "workspace");
    setWorkspaceDir(wsDir);
    const ws = new WorkspaceManager();

    // First init
    ws.init();
    expect(existsSync(join(wsDir, "SETUP.md"))).toBe(true);

    // Second init (simulates restart)
    const created2 = ws.init();
    expect(created2).not.toContain("SETUP.md");
    expect(existsSync(join(wsDir, "SETUP.md"))).toBe(true);
  });
});

// =============================================================================
// Config type
// =============================================================================

describe("setup_completed_at config field", () => {
  test("HawkyConfig accepts setup_completed_at", () => {
    // Type check: this should compile without errors
    const config: Partial<import("../src/agent/types.js").HawkyConfig> = {
      setup_completed_at: "2026-04-07T00:00:00.000Z",
    };
    expect(config.setup_completed_at).toBe("2026-04-07T00:00:00.000Z");
  });

  test("setup_completed_at is optional (undefined by default)", () => {
    const config: Partial<import("../src/agent/types.js").HawkyConfig> = {};
    expect(config.setup_completed_at).toBeUndefined();
  });
});
