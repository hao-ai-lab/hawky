// =============================================================================
// Tests: Slash Command System
//
// Unit tests for command parsing, registry, and each handler.
// Integration tests via ink-testing-library for commands through the TUI.
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  parseCommand,
  isCommand,
  executeCommand,
  getCommands,
  type CommandContext,
} from "../src/tui/commands.js";

// =============================================================================
// Helpers
// =============================================================================

function makeContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    model: "claude-sonnet-4-6",
    workingDirectory: "/tmp/test",
    sessionId: "test-session-id",
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
    messageCount: 10,
    gitBranch: "main",
    previousSessionKey: null,
    setPreviousSessionKey: () => {},
    exit: () => {},
    clearMessages: () => {},
    newSession: () => {},
    flushMemory: () => {},
    triggerCompaction: () => {},
    fetchMcpStatus: () => {},
    switchModel: () => {},
    resumeSession: () => {},
    showStatusPanel: () => {},
    toggleBypass: () => null,
    setPermissionMode: () => null,
    getPermissionMode: () => "",
    setEffort: () => null,
    getEffort: () => {},
    forkSession: () => {},
    renameSession: () => {},
    archiveSession: () => {},
    deleteSession: () => {},
    pinSession: () => {},
    unpinSession: () => {},
    swapProvider: () => {},
    addProfile: () => {},
    removeProfile: () => {},
    renameProfile: () => {},
    getProviderConfig: () => ({ provider: "anthropic" }),
    ...overrides,
  };
}

// =============================================================================
// parseCommand
// =============================================================================

describe("parseCommand", () => {
  test("parses simple command", () => {
    const result = parseCommand("/help");
    expect(result).toEqual({ name: "help", args: [] });
  });

  test("parses command with args", () => {
    const result = parseCommand("/model claude-haiku-4-5");
    expect(result).toEqual({ name: "model", args: ["claude-haiku-4-5"] });
  });

  test("parses command with multiple args", () => {
    const result = parseCommand("/resume abc-123 --force");
    expect(result).toEqual({ name: "resume", args: ["abc-123", "--force"] });
  });

  test("lowercases command name", () => {
    const result = parseCommand("/HELP");
    expect(result).toEqual({ name: "help", args: [] });
  });

  test("trims whitespace", () => {
    const result = parseCommand("  /help  ");
    expect(result).toEqual({ name: "help", args: [] });
  });

  test("returns null for non-command", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseCommand("")).toBeNull();
  });

  test("returns null for just slash", () => {
    expect(parseCommand("/")).toBeNull();
  });
});

// =============================================================================
// isCommand
// =============================================================================

describe("isCommand", () => {
  test("returns true for /help", () => {
    expect(isCommand("/help")).toBe(true);
  });

  test("returns true for /exit", () => {
    expect(isCommand("/exit")).toBe(true);
  });

  test("returns false for regular text", () => {
    expect(isCommand("hello world")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isCommand("")).toBe(false);
  });

  test("returns true with leading whitespace", () => {
    expect(isCommand("  /help")).toBe(true);
  });
});

// =============================================================================
// Command registry
// =============================================================================

describe("getCommands", () => {
  test("returns all registered commands", () => {
    const cmds = getCommands();
    expect(cmds.length).toBeGreaterThanOrEqual(10);
  });

  test("every command has name and description", () => {
    for (const cmd of getCommands()) {
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  test("includes expected commands", () => {
    const names = getCommands().map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("exit");
    expect(names).toContain("clear");
    expect(names).toContain("flush");
    expect(names).toContain("model");
    expect(names).toContain("resume");
    expect(names).toContain("sessions");
    expect(names).toContain("history");
    expect(names).toContain("status");
    expect(names).toContain("compact");
  });
});

// =============================================================================
// /help
// =============================================================================

describe("/help command", () => {
  test("lists all commands", () => {
    const result = executeCommand("/help", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("/help");
    expect(result.text).toContain("/exit");
    expect(result.text).toContain("/clear");
    expect(result.text).toContain("/flush");
    expect(result.text).toContain("/model");
  });

  test("shows aliases", () => {
    const result = executeCommand("/help", makeContext());
    expect(result.text).toContain("/quit");
  });

  test("shows descriptions", () => {
    const result = executeCommand("/help", makeContext());
    expect(result.text).toContain("Exit");
    expect(result.text).toContain("Clear");
    expect(result.text).toContain("model");
  });
});

// =============================================================================
// /exit and /quit
// =============================================================================

describe("/exit command", () => {
  test("calls exit callback", () => {
    let exited = false;
    const ctx = makeContext({ exit: () => { exited = true; } });
    executeCommand("/exit", ctx);
    expect(exited).toBe(true);
  });

  test("/quit alias works", () => {
    let exited = false;
    const ctx = makeContext({ exit: () => { exited = true; } });
    executeCommand("/quit", ctx);
    expect(exited).toBe(true);
  });
});

// =============================================================================
// /clear
// =============================================================================

describe("/clear command", () => {
  test("calls clearMessages", () => {
    let cleared = false;
    const ctx = makeContext({ clearMessages: () => { cleared = true; } });
    const result = executeCommand("/clear", ctx);
    expect(cleared).toBe(true);
    expect(result.text).toContain("cleared");
  });
});

// =============================================================================
// /flush
// =============================================================================

describe("/flush command", () => {
  test("calls flushMemory", () => {
    let flushed = false;
    const ctx = makeContext({ flushMemory: () => { flushed = true; } });
    const result = executeCommand("/flush", ctx);
    expect(flushed).toBe(true);
    expect(result.handled).toBe(true);
  });
});

// =============================================================================
// /model
// =============================================================================

describe("/model command", () => {
  test("shows current model with no args", () => {
    const result = executeCommand("/model", makeContext({ model: "claude-opus-4-6" }));
    expect(result.text).toContain("claude-opus-4-6");
  });

  test("switches model with arg", () => {
    let switched = "";
    const ctx = makeContext({ switchModel: (m) => { switched = m; } });
    const result = executeCommand("/model claude-haiku-4-5", ctx);
    expect(switched).toBe("claude-haiku-4-5");
    expect(result.text).toContain("claude-haiku-4-5");
  });
});

// =============================================================================
// /history
// =============================================================================

describe("/history command", () => {
  test("shows message count and tokens", () => {
    const result = executeCommand("/history", makeContext({
      messageCount: 20,
      tokenUsage: { input_tokens: 5000, output_tokens: 1500 },
    }));
    expect(result.text).toContain("20");
    expect(result.text).toContain("5,000");
    expect(result.text).toContain("1,500");
    expect(result.text).toContain("6,500");
  });

  test("shows no usage when null", () => {
    const result = executeCommand("/history", makeContext({ tokenUsage: null }));
    expect(result.text).toContain("no usage data");
  });
});

// =============================================================================
// /status
// =============================================================================

describe("/status command", () => {
  test("opens status panel on cost tab", () => {
    let openedTab: string | undefined;
    const result = executeCommand("/status", makeContext({
      showStatusPanel: (tab) => { openedTab = tab; },
    }));
    expect(result.handled).toBe(true);
    expect(result.text).toBeNull();
    expect(openedTab).toBe("cost");
  });

  test("/cost opens cost tab", () => {
    let openedTab: string | undefined;
    const result = executeCommand("/cost", makeContext({
      showStatusPanel: (tab) => { openedTab = tab; },
    }));
    expect(result.handled).toBe(true);
    expect(openedTab).toBe("cost");
  });

  test("/usage opens usage tab", () => {
    let openedTab: string | undefined;
    const result = executeCommand("/usage", makeContext({
      showStatusPanel: (tab) => { openedTab = tab; },
    }));
    expect(result.handled).toBe(true);
    expect(openedTab).toBe("usage");
  });

  test("/errors opens errors tab", () => {
    let openedTab: string | undefined;
    const result = executeCommand("/errors", makeContext({
      showStatusPanel: (tab) => { openedTab = tab; },
    }));
    expect(result.handled).toBe(true);
    expect(openedTab).toBe("errors");
  });
});

// =============================================================================
// /compact
// =============================================================================

describe("/compact command", () => {
  test("calls triggerCompaction callback", () => {
    let compacted = false;
    const ctx = makeContext({ triggerCompaction: () => { compacted = true; } });
    const result = executeCommand("/compact", ctx);
    expect(compacted).toBe(true);
    expect(result.handled).toBe(true);
  });
});

// =============================================================================
// /sessions
// =============================================================================

describe("/sessions command", () => {
  test("returns handled result", () => {
    const result = executeCommand("/sessions", makeContext());
    expect(result.handled).toBe(true);
    // May show "No sessions" or list — depends on test env
    expect(result.text).toBeTruthy();
  });
});

// =============================================================================
// /resume
// =============================================================================

describe("/resume command", () => {
  test("with no args lists sessions", () => {
    const result = executeCommand("/resume", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toBeTruthy();
  });

  test("with arg calls resumeSession", () => {
    let resumed = "";
    const ctx = makeContext({ resumeSession: (id) => { resumed = id; } });
    const result = executeCommand("/resume abc-123", ctx);
    expect(resumed).toBe("abc-123");
    expect(result.handled).toBe(true);
    // text is null because resumeSession shows its own messages
    expect(result.text).toBeNull();
  });
});

// =============================================================================
// Unknown commands
// =============================================================================

describe("Unknown command", () => {
  test("returns error with available commands", () => {
    const result = executeCommand("/nonexistent", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Unknown command");
    expect(result.text).toContain("/help");
  });
});

// =============================================================================
// Case insensitivity
// =============================================================================

// =============================================================================
// /heartbeat
// =============================================================================

describe("/heartbeat command", () => {
  test("calls resumeSession with heartbeat:main", () => {
    let resumed = "";
    const ctx = makeContext({ resumeSession: (id) => { resumed = id; } });
    const result = executeCommand("/heartbeat", ctx);
    expect(resumed).toBe("heartbeat:main");
    expect(result.handled).toBe(true);
    expect(result.text).toBeNull();
  });

  test("/hb alias works", () => {
    let resumed = "";
    const ctx = makeContext({ resumeSession: (id) => { resumed = id; } });
    const result = executeCommand("/hb", ctx);
    expect(resumed).toBe("heartbeat:main");
    expect(result.handled).toBe(true);
  });

  test("/help lists heartbeat command", () => {
    const result = executeCommand("/help", makeContext());
    expect(result.text).toContain("/heartbeat");
  });
});

// =============================================================================
// /back
// =============================================================================

describe("/back command", () => {
  test("returns to previous session after /heartbeat", () => {
    const sessions: string[] = [];
    let prevKey: string | null = null;
    const ctx = makeContext({
      sessionId: "tui:main",
      previousSessionKey: null,
      setPreviousSessionKey: (k) => { prevKey = k; ctx.previousSessionKey = k; },
      resumeSession: (id) => { sessions.push(id); },
    });

    // Go to heartbeat — should save current session
    executeCommand("/heartbeat", ctx);
    expect(sessions).toEqual(["heartbeat:main"]);
    expect(prevKey).toBe("tui:main");

    // Go back — should return to saved session
    const result = executeCommand("/back", ctx);
    expect(result.handled).toBe(true);
    expect(sessions).toEqual(["heartbeat:main", "tui:main"]);
    expect(ctx.previousSessionKey).toBe(null);
  });

  test("shows message when no previous session", () => {
    const ctx = makeContext({ previousSessionKey: null });
    const result = executeCommand("/back", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("No previous session");
  });
});

// =============================================================================
// /cron
// =============================================================================

describe("/cron command", () => {
  test("/cron with no args sends list message", () => {
    const result = executeCommand("/cron", makeContext());
    expect(result.handled).toBe(false);
    expect(result.skillMessage).toContain("cron");
  });

  test("/cron list sends list message", () => {
    const result = executeCommand("/cron list", makeContext());
    expect(result.handled).toBe(false);
    expect(result.skillMessage).toContain("cron");
  });

  test("/cron status sends status message", () => {
    const result = executeCommand("/cron status", makeContext());
    expect(result.handled).toBe(false);
    expect(result.skillMessage).toContain("status");
  });

  test("/cron run without id shows usage", () => {
    const result = executeCommand("/cron run", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("/cron run with id sends run message", () => {
    const result = executeCommand("/cron run abc123", makeContext());
    expect(result.handled).toBe(false);
    expect(result.skillMessage).toContain("abc123");
  });

  test("/cron delete without id shows usage", () => {
    const result = executeCommand("/cron delete", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("/cron history without id shows usage", () => {
    const result = executeCommand("/cron history", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("/cron add shows natural language guidance", () => {
    const result = executeCommand("/cron add", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("natural language");
  });

  test("/cron unknown shows help", () => {
    const result = executeCommand("/cron blah", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Available");
  });

  test("/help lists cron command", () => {
    const result = executeCommand("/help", makeContext());
    expect(result.text).toContain("/cron");
  });
});

// =============================================================================
// Case insensitivity
// =============================================================================

describe("Case insensitivity", () => {
  test("mixed-case commands work (parseCommand already lowercases)", () => {
    // Single test covers the case-insensitivity guarantee — parseCommand
    // lowercases the command name, so all commands inherently work in any case.
    const help = executeCommand("/HELP", makeContext());
    expect(help.handled).toBe(true);
    expect(help.text).toContain("/help");
  });
});

// =============================================================================
// /rename
// =============================================================================

describe("/rename command", () => {
  test("calls renameSession with name", () => {
    let renamed: { key: string; name: string } | null = null;
    const ctx = makeContext({
      renameSession: (key, name) => { renamed = { key, name }; },
    });
    const result = executeCommand("/rename My Cool Project", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("My Cool Project");
    expect(renamed?.key).toBe("test-session-id");
    expect(renamed?.name).toBe("My Cool Project");
  });

  test("shows usage when no name given", () => {
    const result = executeCommand("/rename", makeContext());
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("joins multi-word names", () => {
    let renamed: { key: string; name: string } | null = null;
    const ctx = makeContext({
      renameSession: (key, name) => { renamed = { key, name }; },
    });
    executeCommand("/rename Hello World Test", ctx);
    expect(renamed?.name).toBe("Hello World Test");
  });
});

// =============================================================================
// /archive
// =============================================================================

describe("/archive command", () => {
  test("calls archiveSession", () => {
    let archived = "";
    const ctx = makeContext({
      archiveSession: (key) => { archived = key; },
    });
    const result = executeCommand("/archive", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("archived");
    expect(archived).toBe("test-session-id");
  });
});

// =============================================================================
// /delete
// =============================================================================

describe("/delete command", () => {
  test("requires --confirm flag", () => {
    let deleted = "";
    const ctx = makeContext({
      deleteSession: (key) => { deleted = key; },
    });
    const result = executeCommand("/delete", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("--confirm");
    expect(deleted).toBe(""); // Not called without flag
  });

  test("calls deleteSession with --confirm", () => {
    let deleted = "";
    const ctx = makeContext({
      deleteSession: (key) => { deleted = key; },
    });
    const result = executeCommand("/delete --confirm", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("deleted");
    expect(deleted).toBe("test-session-id");
  });
});

// =============================================================================
// /pin / /unpin
// =============================================================================

describe("/pin command", () => {
  test("calls pinSession", () => {
    let pinned = "";
    const ctx = makeContext({
      pinSession: (key) => { pinned = key; },
    });
    const result = executeCommand("/pin", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("pinned");
    expect(pinned).toBe("test-session-id");
  });
});

describe("/unpin command", () => {
  test("calls unpinSession", () => {
    let unpinned = "";
    const ctx = makeContext({
      unpinSession: (key) => { unpinned = key; },
    });
    const result = executeCommand("/unpin", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("unpinned");
    expect(unpinned).toBe("test-session-id");
  });
});

// =============================================================================
// /provider
// =============================================================================

describe("/provider command — parse and dispatch", () => {
  test("no args lists provider config", () => {
    const ctx = makeContext({
      getProviderConfig: () => ({ provider: "anthropic" }),
    });
    const result = executeCommand("/provider", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("anthropic");
  });

  test("list alias works", () => {
    const ctx = makeContext({
      getProviderConfig: () => ({ provider: "openai" }),
    });
    const result = executeCommand("/provider list", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("openai");
  });

  test("swap to anthropic calls swapProvider", () => {
    let swapped: { provider: string; active_profile?: string } | null = null;
    const ctx = makeContext({ swapProvider: (s) => { swapped = s; } });
    const result = executeCommand("/provider anthropic", ctx);
    expect(result.handled).toBe(true);
    expect(swapped).toEqual({ provider: "anthropic", active_profile: undefined });
  });

  test("swap openai_compatible:<profile> passes active_profile", () => {
    let swapped: { provider: string; active_profile?: string } | null = null;
    const ctx = makeContext({ swapProvider: (s) => { swapped = s; } });
    executeCommand("/provider openai_compatible:my-vllm", ctx);
    expect(swapped?.provider).toBe("openai_compatible");
    expect(swapped?.active_profile).toBe("my-vllm");
  });

  test("unknown provider name returns error, does NOT call swapProvider", () => {
    let swapped = false;
    const ctx = makeContext({ swapProvider: () => { swapped = true; } });
    const result = executeCommand("/provider badprovider", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Unknown provider");
    expect(swapped).toBe(false);
  });

  test("add without name shows usage", () => {
    const ctx = makeContext();
    const result = executeCommand("/provider add", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("add without --base-url shows error", () => {
    const ctx = makeContext();
    const result = executeCommand("/provider add myprofile", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Missing --base-url");
  });

  test("add with name and --base-url calls addProfile", () => {
    let added: { name: string; base_url: string } | null = null;
    const ctx = makeContext({ addProfile: (p) => { added = p; } });
    executeCommand("/provider add vllm-local --base-url http://localhost:8000/v1", ctx);
    expect(added?.name).toBe("vllm-local");
    expect(added?.base_url).toBe("http://localhost:8000/v1");
  });

  test("add with all flags", () => {
    let added: Record<string, unknown> | null = null;
    const ctx = makeContext({ addProfile: (p) => { added = p as Record<string, unknown>; } });
    executeCommand("/provider add vllm-local --base-url http://localhost:8000/v1 --api-key sk-test --model meta-llama/Llama-3 --overwrite", ctx);
    expect(added?.api_key).toBe("sk-test");
    expect(added?.model).toBe("meta-llama/Llama-3");
    expect(added?.overwrite).toBe(true);
  });

  test("remove without name shows usage", () => {
    const ctx = makeContext();
    const result = executeCommand("/provider remove", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("remove with name calls removeProfile", () => {
    let removed = "";
    const ctx = makeContext({ removeProfile: (n) => { removed = n; } });
    executeCommand("/provider remove vllm-local", ctx);
    expect(removed).toBe("vllm-local");
  });

  test("rename with args calls renameProfile", () => {
    let oldN = "", newN = "";
    const ctx = makeContext({ renameProfile: (o, n) => { oldN = o; newN = n; } });
    executeCommand("/provider rename old-name new-name", ctx);
    expect(oldN).toBe("old-name");
    expect(newN).toBe("new-name");
  });

  test("rename without args shows usage", () => {
    const ctx = makeContext();
    const result = executeCommand("/provider rename", ctx);
    expect(result.handled).toBe(true);
    expect(result.text).toContain("Usage");
  });

  test("shows profiles in list output", () => {
    const ctx = makeContext({
      getProviderConfig: () => ({
        provider: "openai_compatible",
        active_profile: "vllm-local",
        profiles: {
          "vllm-local": { base_url: "http://localhost:8000/v1", model: "llama3" },
        },
      }),
    });
    const result = executeCommand("/provider", ctx);
    expect(result.text).toContain("vllm-local");
    expect(result.text).toContain("http://localhost:8000/v1");
  });
});
