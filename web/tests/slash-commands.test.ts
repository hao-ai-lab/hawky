// =============================================================================
// Test: web slash commands — parsing, filtering, dispatch
// Run: bun test web/tests/slash-commands.test.ts
// =============================================================================

import { describe, expect, it as test } from "vitest";
import {
  isSlashInput, parseSlash, filterCommands, findCommand, dispatchSlash,
  SLASH_COMMANDS, type SlashContext,
} from "../src/lib/slash-commands";

function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext & {
  systemMessages: string[];
  systemMessageCommands: Array<string | undefined>;
  rpcCalls: Array<{ method: string; params: unknown }>;
  views: string[];
  chatSends: string[];
} {
  const systemMessages: string[] = [];
  const systemMessageCommands: Array<string | undefined> = [];
  const rpcCalls: Array<{ method: string; params: unknown }> = [];
  const views: string[] = [];
  const chatSends: string[] = [];
  return {
    rpc: async (method: string, params?: unknown) => { rpcCalls.push({ method, params }); return {} as any; },
    sessionKey: "web:test",
    setView: (v) => { views.push(v); },
    addSystemMessage: (t, command) => { systemMessages.push(t); systemMessageCommands.push(command); },
    sendChatMessage: (t) => { chatSends.push(t); },
    systemMessages, systemMessageCommands, rpcCalls, views, chatSends,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSlashInput / parseSlash / filterCommands / findCommand
// ---------------------------------------------------------------------------

describe("isSlashInput", () => {
  test("recognizes leading slash", () => {
    expect(isSlashInput("/help")).toBe(true);
    expect(isSlashInput("/heartbeat run")).toBe(true);
    expect(isSlashInput("/")).toBe(true);
  });
  test("rejects without leading slash", () => {
    expect(isSlashInput("help")).toBe(false);
    expect(isSlashInput(" /help")).toBe(false);
    expect(isSlashInput("hi /help")).toBe(false);
  });
});

describe("parseSlash", () => {
  test("splits name and args", () => {
    expect(parseSlash("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlash("/heartbeat run")).toEqual({ name: "heartbeat", args: "run" });
    // Args preserve original casing; name is normalized to lowercase.
    expect(parseSlash("/mode acceptEdits")).toEqual({ name: "mode", args: "acceptEdits" });
  });
  test("returns null on non-slash input", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });
  test("collapses extra whitespace", () => {
    expect(parseSlash("/help   ")).toEqual({ name: "help", args: "" });
  });
});

describe("filterCommands", () => {
  test("empty returns full list", () => {
    expect(filterCommands("").length).toBe(SLASH_COMMANDS.length);
  });
  test("prefix narrows", () => {
    const r = filterCommands("/he");
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c.name.includes("he")).toBe(true);
  });
  test("substring also matches", () => {
    const r = filterCommands("ron");
    expect(r.some((c) => c.name === "cron")).toBe(true);
  });
});

describe("findCommand", () => {
  test("looks up by name", () => {
    expect(findCommand("help")?.name).toBe("help");
    expect(findCommand("HELP")?.name).toBe("help");
    expect(findCommand("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dispatchSlash — handler routing + error containment
// ---------------------------------------------------------------------------

describe("dispatchSlash", () => {
  test("/help renders the registry", async () => {
    const ctx = makeCtx();
    await dispatchSlash({ name: "help", args: "" }, ctx);
    expect(ctx.systemMessages.length).toBe(1);
    expect(ctx.systemMessages[0]).toContain("Available slash commands");
    expect(ctx.systemMessages[0]).toContain("/setup");
    expect(ctx.systemMessages[0]).toContain("/cron");
    // Output is tagged with the originating command so ChatView can render
    // it with body typography + a chip instead of the small italic toast.
    expect(ctx.systemMessageCommands[0]).toBe("/help");
  });

  test("dispatch tags every output with its originating command", async () => {
    const ctx = makeCtx();
    ctx.rpc = async () => ({ jobs: [] } as any);
    await dispatchSlash({ name: "cron", args: "" }, ctx);
    expect(ctx.systemMessageCommands).toEqual(["/cron"]);
  });

  test("handler errors are also tagged with the command", async () => {
    const ctx = makeCtx({
      rpc: async () => { throw new Error("boom"); },
    });
    await dispatchSlash({ name: "doctor", args: "" }, ctx);
    expect(ctx.systemMessageCommands[0]).toBe("/doctor");
    expect(ctx.systemMessages[0]).toContain("/doctor failed");
  });

  test("unknown command returns a friendly system message", async () => {
    const ctx = makeCtx();
    await dispatchSlash({ name: "nope", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("Unknown command");
    expect(ctx.systemMessages[0]).toContain("/nope");
  });

  test("handler exceptions are caught and surfaced", async () => {
    const ctx = makeCtx({
      rpc: async () => { throw new Error("rpc boom"); },
    });
    await dispatchSlash({ name: "doctor", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("/doctor failed");
    expect(ctx.systemMessages[0]).toContain("rpc boom");
  });

  test("/setup delegates to the agent (sendChatMessage)", async () => {
    const ctx = makeCtx();
    await dispatchSlash({ name: "setup", args: "" }, ctx);
    expect(ctx.chatSends.length).toBe(1);
    expect(ctx.chatSends[0]).toContain("/setup");
  });

  test("/heartbeat (no args) calls heartbeat.status + config.get", async () => {
    const ctx = makeCtx();
    const calls: string[] = [];
    ctx.rpc = async (method: string) => {
      calls.push(method);
      if (method === "heartbeat.status") return { enabled: true } as any;
      if (method === "config.get") return { heartbeat: { interval_minutes: 30 } } as any;
      return {} as any;
    };
    await dispatchSlash({ name: "heartbeat", args: "" }, ctx);
    expect(calls.sort()).toEqual(["config.get", "heartbeat.status"]);
    expect(ctx.systemMessages[0]).toContain("Heartbeat: enabled (every 30 min)");
  });

  test("/heartbeat handles missing interval gracefully", async () => {
    const ctx = makeCtx();
    ctx.rpc = async (method: string) => {
      if (method === "heartbeat.status") return { enabled: true } as any;
      if (method === "config.get") return {} as any;
      return {} as any;
    };
    await dispatchSlash({ name: "heartbeat", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("Heartbeat: enabled");
    expect(ctx.systemMessages[0]).not.toContain("?");
  });

  test("/cron unwraps the {jobs: []} response shape", async () => {
    const ctx = makeCtx();
    ctx.rpc = async () => ({ jobs: [{
      id: "j1", name: "test job", enabled: true,
      schedule: { kind: "interval" },
      state: { lastStatus: "ok", lastRunAtMs: Date.now() - 60000, nextRunAtMs: Date.now() + 60000 },
    }] } as any);
    await dispatchSlash({ name: "cron", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("Cron jobs (1)");
    expect(ctx.systemMessages[0]).toContain("test job");
  });

  test("/cron with empty list", async () => {
    const ctx = makeCtx();
    ctx.rpc = async () => ({ jobs: [] } as any);
    await dispatchSlash({ name: "cron", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toBe("No cron jobs scheduled.");
  });

  test("/memory is no longer registered", async () => {
    const ctx = makeCtx();
    await dispatchSlash({ name: "memory", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("Unknown command");
  });

  test("/heartbeat run calls heartbeat.trigger", async () => {
    const calls: string[] = [];
    const ctx = makeCtx();
    ctx.rpc = async (method: string) => { calls.push(method); return {} as any; };
    await dispatchSlash({ name: "heartbeat", args: "run" }, ctx);
    expect(calls).toEqual(["heartbeat.trigger"]);
    expect(ctx.systemMessages[0]).toContain("triggered");
  });

  test("/mode (no args) reads current mode via permission.mode", async () => {
    const ctx = makeCtx();
    let captured: { method: string; params: unknown } | null = null;
    ctx.rpc = async (method: string, params?: unknown) => {
      captured = { method, params };
      return { mode: "default" } as any;
    };
    await dispatchSlash({ name: "mode", args: "" }, ctx);
    expect(captured!.method).toBe("permission.mode");
    expect(captured!.params).toEqual({ sessionKey: "web:test" });
    expect(ctx.systemMessages[0]).toContain("Current permission mode: default");
  });

  test("/mode acceptEdits sets mode (normalized to accept-edits)", async () => {
    const ctx = makeCtx();
    let captured: { method: string; params: unknown } | null = null;
    ctx.rpc = async (method: string, params?: unknown) => {
      captured = { method, params };
      return { mode: "accept-edits", message: "Mode set" } as any;
    };
    await dispatchSlash({ name: "mode", args: "acceptEdits" }, ctx);
    expect(captured!.params).toEqual({ mode: "accept-edits", sessionKey: "web:test" });
    expect(ctx.systemMessages[0]).toBe("Mode set");
  });

  test("/mode <bogus> rejects without making an RPC", async () => {
    const ctx = makeCtx();
    let made = false;
    ctx.rpc = async () => { made = true; return {} as any; };
    await dispatchSlash({ name: "mode", args: "wibble" }, ctx);
    expect(made).toBe(false);
    expect(ctx.systemMessages[0]).toContain("Unknown mode");
  });

  test("/compact reports the gateway's compaction outcome", async () => {
    const ctx = makeCtx();
    ctx.rpc = async () => ({ compacted: true } as any);
    await dispatchSlash({ name: "compact", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("Compaction complete");
  });

  test("/compact surfaces a skip reason", async () => {
    const ctx = makeCtx();
    ctx.rpc = async () => ({ compacted: false, reason: "below threshold" } as any);
    await dispatchSlash({ name: "compact", args: "" }, ctx);
    expect(ctx.systemMessages[0]).toContain("Compaction skipped");
    expect(ctx.systemMessages[0]).toContain("below threshold");
  });
});

// ---------------------------------------------------------------------------
// Registry sanity — every entry must have a runnable handler
// ---------------------------------------------------------------------------

describe("SLASH_COMMANDS registry", () => {
  test("every command has a unique name", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every command has a description and run handler", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.run).toBe("function");
    }
  });
});
