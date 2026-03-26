// =============================================================================
// Tests: Heartbeat Prompt Builder
// =============================================================================

import { describe, test, expect } from "bun:test";
import {
  HEARTBEAT_DECISION_TOOL,
  parseHeartbeatDecision,
  buildHeartbeatSystemPrompt,
  buildHeartbeatUserMessage,
  isHeartbeatContentEffectivelyEmpty,
  buildConsolidationSystemPrompt,
  buildConsolidationUserMessage,
  buildFlushSystemPrompt,
  buildFlushUserMessage,
  buildCronDistillationPrefix,
} from "../src/gateway/heartbeat-prompt.js";

// -----------------------------------------------------------------------------
// HEARTBEAT_DECISION_TOOL
// -----------------------------------------------------------------------------

describe("HEARTBEAT_DECISION_TOOL", () => {
  test("has correct name and schema", () => {
    expect(HEARTBEAT_DECISION_TOOL.name).toBe("heartbeat_decision");
    expect(HEARTBEAT_DECISION_TOOL.input_schema.type).toBe("object");
    expect(HEARTBEAT_DECISION_TOOL.input_schema.required).toContain("action");
    expect(HEARTBEAT_DECISION_TOOL.input_schema.properties.action.enum).toEqual(["skip", "run"]);
  });
});

// -----------------------------------------------------------------------------
// parseHeartbeatDecision
// -----------------------------------------------------------------------------

describe("parseHeartbeatDecision", () => {
  test("parses skip action", () => {
    const result = parseHeartbeatDecision({ action: "skip", reason: "nothing to do" });
    expect(result.action).toBe("skip");
    expect(result.reason).toBe("nothing to do");
    expect(result.tasks).toBeUndefined();
  });

  test("parses run action with tasks", () => {
    const result = parseHeartbeatDecision({
      action: "run",
      tasks: "Check email for urgent messages",
      reason: "email check needed",
    });
    expect(result.action).toBe("run");
    expect(result.tasks).toBe("Check email for urgent messages");
    expect(result.reason).toBe("email check needed");
  });

  test("defaults to skip for unknown action", () => {
    const result = parseHeartbeatDecision({ action: "unknown" });
    expect(result.action).toBe("skip");
  });

  test("defaults to skip for missing action", () => {
    const result = parseHeartbeatDecision({});
    expect(result.action).toBe("skip");
  });

  test("handles non-string tasks gracefully", () => {
    const result = parseHeartbeatDecision({ action: "run", tasks: 123 });
    expect(result.action).toBe("run");
    expect(result.tasks).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// buildHeartbeatSystemPrompt
// -----------------------------------------------------------------------------

describe("buildHeartbeatSystemPrompt", () => {
  test("contains key instructions", () => {
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("heartbeat_decision");
    expect(prompt).toContain("skip");
    expect(prompt).toContain("run");
  });
});

// -----------------------------------------------------------------------------
// buildHeartbeatUserMessage
// -----------------------------------------------------------------------------

describe("buildHeartbeatUserMessage", () => {
  test("includes current time", () => {
    const msg = buildHeartbeatUserMessage("Check email", []);
    expect(msg).toContain("Current time:");
  });

  test("includes HEARTBEAT.md content", () => {
    const msg = buildHeartbeatUserMessage("- Check email\n- Review PRs", []);
    expect(msg).toContain("HEARTBEAT.md");
    expect(msg).toContain("Check email");
    expect(msg).toContain("Review PRs");
  });

  test("includes system events when present", () => {
    const events = [
      { text: "Cron job completed: PR check", ts: Date.now() - 5000 },
      { text: "New email from Dean", ts: Date.now() - 2000 },
    ];
    const msg = buildHeartbeatUserMessage("Check email", events);
    expect(msg).toContain("Pending system events (2)");
    expect(msg).toContain("PR check");
    expect(msg).toContain("New email from Dean");
  });

  test("no system events section when empty", () => {
    const msg = buildHeartbeatUserMessage("Check email", []);
    expect(msg).not.toContain("Pending system events");
  });

  test("uses provided timestamp for time formatting", () => {
    const ts = new Date("2026-03-15T14:30:00Z").getTime();
    const msg = buildHeartbeatUserMessage("Check email", [], ts);
    expect(msg).toContain("Current time:");
    // Should format the provided time, not current time
    expect(msg).toContain("2026");
  });
});

// -----------------------------------------------------------------------------
// isHeartbeatContentEffectivelyEmpty
// -----------------------------------------------------------------------------

describe("isHeartbeatContentEffectivelyEmpty", () => {
  test("empty string → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
  });

  test("whitespace only → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("   \n\n  \t  ")).toBe(true);
  });

  test("headers only → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Heartbeat Tasks\n## Active\n")).toBe(true);
  });

  test("empty list items → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- \n* \n- [ ]\n- [x]\n")).toBe(true);
  });

  test("horizontal rules → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("---\n***\n___")).toBe(true);
  });

  test("numbered empty list items → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("1. \n2. \n")).toBe(true);
  });

  test("headers + empty lists → true", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Tasks\n- [ ]\n- [ ]\n")).toBe(true);
  });

  test("text content → false", () => {
    expect(isHeartbeatContentEffectivelyEmpty("Check email")).toBe(false);
  });

  test("list with text → false", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- Check email")).toBe(false);
  });

  test("checkbox with text → false", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- [ ] Check email")).toBe(false);
  });

  test("#hashtag (no space) is not a header → false", () => {
    expect(isHeartbeatContentEffectivelyEmpty("#TODO")).toBe(false);
  });

  test("mixed empty and content → false", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Tasks\n- [ ]\n- Check email\n")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// buildConsolidationSystemPrompt
// -----------------------------------------------------------------------------

describe("buildConsolidationSystemPrompt", () => {
  test("contains consolidation agent identity", () => {
    const prompt = buildConsolidationSystemPrompt();
    expect(prompt).toContain("memory consolidation agent");
    expect(prompt).toContain("Hawky");
  });

  test("instructs agent to use MEMORY.md", () => {
    const prompt = buildConsolidationSystemPrompt();
    expect(prompt).toContain("MEMORY.md");
  });

  test("restricts to file tools only", () => {
    const prompt = buildConsolidationSystemPrompt();
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("edit_file");
    expect(prompt).toContain("Do NOT use bash");
  });

  test("instructs to reply NO_REPLY when nothing to change", () => {
    const prompt = buildConsolidationSystemPrompt();
    expect(prompt).toContain("NO_REPLY");
  });

  test("lists what to promote to MEMORY.md", () => {
    const prompt = buildConsolidationSystemPrompt();
    expect(prompt).toContain("promote");
    expect(prompt).toContain("stale");
  });
});

// -----------------------------------------------------------------------------
// buildConsolidationUserMessage
// -----------------------------------------------------------------------------

describe("buildConsolidationUserMessage", () => {
  test("includes MEMORY.md path", () => {
    const msg = buildConsolidationUserMessage(
      [],
      "/home/user/.hawky/workspace/MEMORY.md",
    );
    expect(msg).toContain("/home/user/.hawky/workspace/MEMORY.md");
  });

  test("includes formatted date", () => {
    const ts = new Date("2026-03-15").getTime();
    const msg = buildConsolidationUserMessage([], "/tmp/MEMORY.md", ts);
    expect(msg).toContain("2026");
  });

  test("includes daily log entries", () => {
    const entries = [
      { date: "2026-03-13", content: "- Reviewed PR #42\n- Sent email to Dean" },
      { date: "2026-03-14", content: "- Deadline extended to April 10" },
    ];
    const msg = buildConsolidationUserMessage(entries, "/tmp/MEMORY.md");
    expect(msg).toContain("2026-03-13");
    expect(msg).toContain("PR #42");
    expect(msg).toContain("2026-03-14");
    expect(msg).toContain("April 10");
  });

  test("handles empty daily logs gracefully", () => {
    const msg = buildConsolidationUserMessage([], "/tmp/MEMORY.md");
    expect(msg).toContain("No recent daily log entries");
    expect(msg).toContain("staleness cleanup");
  });

  test("includes instructions to update MEMORY.md", () => {
    const msg = buildConsolidationUserMessage([], "/tmp/MEMORY.md");
    expect(msg).toContain("MEMORY.md");
    expect(msg).toContain("NO_REPLY");
  });

  test("wraps each log entry with its date header", () => {
    const entries = [{ date: "2026-03-14", content: "Did stuff" }];
    const msg = buildConsolidationUserMessage(entries, "/tmp/MEMORY.md");
    expect(msg).toContain("=== 2026-03-14 ===");
    expect(msg).toContain("Did stuff");
  });
});

// -----------------------------------------------------------------------------
// buildFlushSystemPrompt
// -----------------------------------------------------------------------------

describe("buildFlushSystemPrompt", () => {
  test("contains flush identity", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("Pre-compaction");
    expect(prompt).toContain("memory flush");
  });

  test("marks MEMORY.md as read-only", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("MEMORY.md");
  });

  test("instructs write to memory/YYYY-MM-DD.md", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("memory/YYYY-MM-DD.md");
  });

  test("instructs NO_REPLY when nothing to preserve", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("NO_REPLY");
  });

  test("lists what to preserve", () => {
    const prompt = buildFlushSystemPrompt();
    expect(prompt).toContain("Decisions made");
    expect(prompt).toContain("preferences");
  });
});

// -----------------------------------------------------------------------------
// buildFlushUserMessage
// -----------------------------------------------------------------------------

describe("buildFlushUserMessage", () => {
  test("includes workspace path and date target", () => {
    const msg = buildFlushUserMessage("/home/user/.hawky/workspace");
    expect(msg).toContain("/home/user/.hawky/workspace/memory/");
    expect(msg).toContain("Memory flush");
  });

  test("includes correct date in log target path", () => {
    const ts = new Date("2026-03-15T10:00:00Z").getTime();
    const msg = buildFlushUserMessage("/tmp/workspace", "new", ts);
    expect(msg).toContain("2026-03-15");
  });

  test("uses local date not UTC for daily log target path", () => {
    const ts = new Date("2026-03-16T00:30:00Z").getTime();
    const msg = buildFlushUserMessage("/tmp/workspace", "new", ts);
    // We can't assert a specific date because it depends on the test runner's
    // timezone, but we CAN verify the date matches what `new Date(ts)` says locally.
    const localDate = new Date(ts);
    const expected = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
    expect(msg).toContain(`/tmp/workspace/memory/${expected}.md`);
  });

  test("instructs not to modify MEMORY.md", () => {
    const msg = buildFlushUserMessage("/tmp/workspace");
    expect(msg).toContain("MEMORY.md");
    expect(msg).toContain("Do NOT modify");
  });

  test("mentions NO_REPLY if nothing to preserve", () => {
    const msg = buildFlushUserMessage("/tmp/workspace");
    expect(msg).toContain("NO_REPLY");
  });
});

// -----------------------------------------------------------------------------
// buildCronDistillationPrefix
// -----------------------------------------------------------------------------

describe("buildCronDistillationPrefix", () => {
  test("contains workspace path in daily log target", () => {
    const prefix = buildCronDistillationPrefix("/home/user/.hawky/workspace");
    expect(prefix).toContain("/home/user/.hawky/workspace/memory/");
  });

  test("includes today's date in log target", () => {
    const ts = new Date("2026-03-15T10:00:00Z").getTime();
    const prefix = buildCronDistillationPrefix("/tmp/workspace", ts);
    expect(prefix).toContain("2026-03-15");
  });

  test("uses local date not UTC for daily log target path", () => {
    const ts = new Date("2026-03-16T00:30:00Z").getTime();
    const prefix = buildCronDistillationPrefix("/tmp/workspace", ts);
    const localDate = new Date(ts);
    const expected = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
    expect(prefix).toContain(`/tmp/workspace/memory/${expected}.md`);
  });

  test("instructs not to write to MEMORY.md", () => {
    const prefix = buildCronDistillationPrefix("/tmp/workspace");
    expect(prefix).toContain("Do NOT write to MEMORY.md");
  });

  test("ends with empty line (separator before task)", () => {
    const prefix = buildCronDistillationPrefix("/tmp/workspace");
    expect(prefix.endsWith("\n")).toBe(true);
  });

  test("memory instruction is bracketed (easy to identify)", () => {
    const prefix = buildCronDistillationPrefix("/tmp/workspace");
    expect(prefix.trim().startsWith("[After completing")).toBe(true);
    expect(prefix).toContain("]");
  });
});
