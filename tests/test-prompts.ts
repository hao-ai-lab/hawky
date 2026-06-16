// =============================================================================
// Prompt registry tests (#512 Phase 1)
//
// Three guarantees:
//  1. Byte-identical: registry defaults match the exact text callers used to emit.
//     - For builders that survive (heartbeat consolidation/flush/distillation,
//       subagent delegation), assert builder output === getPrompt(id).
//     - For replaced consts (compaction, gemini, realtime live), assert against
//       a frozen copy of the original literal captured here.
//  2. Override layer: a ~/.hawky/prompts/<id>.md file wins, then falls back.
//  3. Cache + completeness: listPromptIds covers all ids; cache reset re-reads.
// =============================================================================

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getPrompt,
  listPromptIds,
  resetPromptCache,
  PROMPTS,
  setPromptOverride,
  deletePromptOverride,
  getPromptStatus,
  listPromptsWithStatus,
  hasPromptOverride,
  isKnownPromptId,
} from "../src/prompts/index.js";
import { setConfigDir, resetConfigDir } from "../src/storage/config.js";
import {
  buildConsolidationSystemPrompt,
  buildFlushSystemPrompt,
  buildDistillationSystemPrompt,
} from "../src/gateway/heartbeat-prompt.js";
import { GEMINI_LIVE_DEFAULT_PROMPT } from "../src/consumers/gemini-live-channel/index.js";
import { registerPromptMethods } from "../src/gateway/prompt-methods.js";

// Frozen copy of the original compaction prompt (pre-refactor) — anchors the
// byte-identical assertion for a const that no longer lives inline.
const ORIGINAL_COMPACTION = `Your task is to create a detailed summary of the conversation so far.
This summary will replace the conversation history, so include ALL information
needed to continue working effectively.

Required sections in your summary:

1. **Primary Request and Intent**: What the user explicitly asked for, their goals, and the broader context of what they're trying to accomplish.

2. **Key Technical Decisions**: Architecture choices, design patterns chosen, trade-offs discussed, and the reasoning behind decisions.

3. **Files and Code**: Specific file paths that were modified or examined, what was changed in each, and any important code patterns or structures. Include enough detail that you could continue editing these files.

4. **Errors and Fixes**: Problems encountered during the work and how they were resolved. Include root causes, not just symptoms.

5. **Current State**: What is the precise state of the work right now? What was the last thing completed? What file was last edited?

6. **Pending Work**: Outstanding tasks, next steps the user expects, and any commitments made during the conversation.

7. **User Preferences**: Any preferences, corrections, or feedback the user gave about how to approach the work.

CRITICAL: Respond with plain text only. Do NOT call any tools.
Wrap your summary in <summary> tags.`;

const ORIGINAL_REALTIME_LIVE = "You are Hawky Live, a concise realtime assistant.";

afterEach(() => {
  resetConfigDir();
  resetPromptCache();
});

describe("prompt registry — byte-identical defaults", () => {
  test("heartbeat consolidation builder equals registry default", () => {
    expect(buildConsolidationSystemPrompt()).toBe(getPrompt("heartbeat.consolidation.system"));
  });

  test("heartbeat flush builder equals registry default", () => {
    expect(buildFlushSystemPrompt()).toBe(getPrompt("heartbeat.flush.system"));
  });

  test("heartbeat distillation builder equals registry default", () => {
    expect(buildDistillationSystemPrompt()).toBe(getPrompt("heartbeat.distillation.system"));
  });

  test("compaction default matches original inline text", () => {
    expect(getPrompt("compaction")).toBe(ORIGINAL_COMPACTION);
  });

  test("realtime live default matches original inline text", () => {
    expect(getPrompt("realtime.live.default")).toBe(ORIGINAL_REALTIME_LIVE);
  });

  test("gemini default export equals registry default", () => {
    expect(GEMINI_LIVE_DEFAULT_PROMPT).toBe(getPrompt("gemini_live.default"));
    // and is trimmed (no leading/trailing whitespace), as before
    expect(GEMINI_LIVE_DEFAULT_PROMPT).toBe(GEMINI_LIVE_DEFAULT_PROMPT.trim());
  });

  test("subagent delegation default has the fixed header + trailing blank", () => {
    const t = getPrompt("subagent.delegation");
    expect(t.startsWith("STOP. READ THIS FIRST.")).toBe(true);
    // trailing blank line is preserved (so concatenation stays byte-identical)
    expect(t.endsWith("\n")).toBe(true);
  });
});

describe("prompt registry — override layer", () => {
  test("override file wins, then falls back to default after removal", () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-prompts-"));
    try {
      setConfigDir(dir);
      mkdirSync(join(dir, "prompts"), { recursive: true });
      const overrideText = "OVERRIDDEN compaction prompt for this deployment.";
      writeFileSync(join(dir, "prompts", "compaction.md"), overrideText);

      resetPromptCache();
      expect(getPrompt("compaction")).toBe(overrideText);

      // Remove the override → fall back to the bundled default.
      rmSync(join(dir, "prompts", "compaction.md"));
      resetPromptCache();
      expect(getPrompt("compaction")).toBe(ORIGINAL_COMPACTION);
    } finally {
      resetConfigDir();
      resetPromptCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("override is taken as authoritative bytes (no trim)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-prompts-"));
    try {
      setConfigDir(dir);
      mkdirSync(join(dir, "prompts"), { recursive: true });
      const raw = "\n  spaced override  \n";
      writeFileSync(join(dir, "prompts", "realtime.live.default.md"), raw);
      resetPromptCache();
      expect(getPrompt("realtime.live.default")).toBe(raw);
    } finally {
      resetConfigDir();
      resetPromptCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prompt registry — completeness + cache", () => {
  test("listPromptIds includes every Phase-1 id", () => {
    const ids = listPromptIds();
    for (const id of [
      "agent.system.persona",
      "compaction",
      "compaction.summarizer.system",
      "subagent.delegation",
      "heartbeat.consolidation.system",
      "heartbeat.flush.system",
      "heartbeat.distillation.system",
      "realtime.live.default",
      "gemini_live.default",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("every registry entry resolves to a non-empty string", () => {
    for (const id of listPromptIds()) {
      expect(getPrompt(id).length).toBeGreaterThan(0);
    }
  });

  test("unknown id throws", () => {
    expect(() => getPrompt("does.not.exist")).toThrow();
  });

  test("PROMPTS entries are self-consistent (id matches key)", () => {
    for (const [key, entry] of Object.entries(PROMPTS)) {
      expect(entry.id).toBe(key);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("prompt registry — CRUD over overrides", () => {
  function withTmpConfig<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "hawky-prompts-crud-"));
    try {
      setConfigDir(dir);
      resetPromptCache();
      return fn(dir);
    } finally {
      resetConfigDir();
      resetPromptCache();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("set then get reflects the override; status flags overridden", () => {
    withTmpConfig(() => {
      expect(hasPromptOverride("compaction")).toBe(false);
      setPromptOverride("compaction", "NEW TEXT");
      expect(getPrompt("compaction")).toBe("NEW TEXT");

      const status = getPromptStatus("compaction");
      expect(status.text).toBe("NEW TEXT");
      expect(status.overridden).toBe(true);
      expect(status.default).toBe(PROMPTS["compaction"].template);
      expect(status.default).not.toBe("NEW TEXT");
    });
  });

  test("delete removes the override and returns true; second delete returns false", () => {
    withTmpConfig(() => {
      setPromptOverride("realtime.live.default", "x");
      expect(deletePromptOverride("realtime.live.default")).toBe(true);
      expect(getPrompt("realtime.live.default")).toBe(PROMPTS["realtime.live.default"].template);
      expect(hasPromptOverride("realtime.live.default")).toBe(false);
      // deleting again is a no-op
      expect(deletePromptOverride("realtime.live.default")).toBe(false);
    });
  });

  test("set creates ~/.hawky/prompts/ lazily (dir did not pre-exist)", () => {
    withTmpConfig(() => {
      // no prompts/ dir created yet
      setPromptOverride("agent.system.persona", "Persona override.");
      expect(getPrompt("agent.system.persona")).toBe("Persona override.");
    });
  });

  test("set/delete/get reject unknown ids", () => {
    withTmpConfig(() => {
      expect(() => setPromptOverride("nope.nope", "x")).toThrow();
      expect(() => deletePromptOverride("nope.nope")).toThrow();
      expect(() => getPromptStatus("nope.nope")).toThrow();
      expect(isKnownPromptId("nope.nope")).toBe(false);
      expect(isKnownPromptId("compaction")).toBe(true);
    });
  });

  test("listPromptsWithStatus returns every prompt with default + overridden", () => {
    withTmpConfig(() => {
      setPromptOverride("compaction", "ov");
      const all = listPromptsWithStatus();
      expect(all.length).toBe(listPromptIds().length);
      const c = all.find((p) => p.id === "compaction")!;
      expect(c.overridden).toBe(true);
      expect(c.text).toBe("ov");
      const persona = all.find((p) => p.id === "agent.system.persona")!;
      expect(persona.overridden).toBe(false);
      expect(persona.text).toBe(PROMPTS["agent.system.persona"].template);
    });
  });
});

describe("prompts.* RPC methods", () => {
  // Minimal mock server: captures registered handlers so we can invoke them.
  function makeServer() {
    const handlers = new Map<string, (conn: unknown, params: unknown) => unknown>();
    const server = {
      registerMethod(name: string, fn: (conn: unknown, params: unknown) => unknown) {
        handlers.set(name, fn);
      },
    };
    registerPromptMethods(server as any);
    return {
      call: (name: string, params?: unknown) => handlers.get(name)!(null, params),
      names: () => [...handlers.keys()],
    };
  }

  function withTmpConfig<T>(fn: (srv: ReturnType<typeof makeServer>) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "hawky-prompts-rpc-"));
    try {
      setConfigDir(dir);
      resetPromptCache();
      return fn(makeServer());
    } finally {
      resetConfigDir();
      resetPromptCache();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("registers list/get/set/delete", () => {
    const srv = makeServer();
    for (const m of ["prompts.list", "prompts.get", "prompts.set", "prompts.delete"]) {
      expect(srv.names()).toContain(m);
    }
  });

  test("set → get → delete round-trip via RPC", () => {
    withTmpConfig((srv) => {
      const setRes = srv.call("prompts.set", { id: "compaction", text: "RPC TEXT" }) as any;
      expect(setRes.overridden).toBe(true);
      expect(setRes.text).toBe("RPC TEXT");

      const getRes = srv.call("prompts.get", { id: "compaction" }) as any;
      expect(getRes.text).toBe("RPC TEXT");

      const delRes = srv.call("prompts.delete", { id: "compaction" }) as any;
      expect(delRes.removed).toBe(true);
      expect(delRes.overridden).toBe(false);
      expect(delRes.text).toBe(PROMPTS["compaction"].template);
    });
  });

  test("list returns all prompts", () => {
    withTmpConfig((srv) => {
      const res = srv.call("prompts.list") as any;
      expect(Array.isArray(res.prompts)).toBe(true);
      expect(res.prompts.length).toBe(listPromptIds().length);
    });
  });

  test("get/set/delete reject missing or unknown id", () => {
    withTmpConfig((srv) => {
      expect(() => srv.call("prompts.get", {})).toThrow();
      expect(() => srv.call("prompts.get", { id: "nope.nope" })).toThrow();
      expect(() => srv.call("prompts.set", { id: "compaction" })).toThrow(); // missing text
      expect(() => srv.call("prompts.set", { id: "nope.nope", text: "x" })).toThrow();
      expect(() => srv.call("prompts.delete", { id: "nope.nope" })).toThrow();
    });
  });
});
