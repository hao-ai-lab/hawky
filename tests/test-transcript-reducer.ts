// =============================================================================
// Tests: Canonical Transcript Reducer (src/transcript/)
//
// Unit tests for the pure StreamEvent -> TranscriptState fold that replaces
// the duplicated transition logic in the TUI hook, the web session store
// (active + background + parseHistoryMessages), and the web-ios history
// mapper. Also validates the language-neutral golden fixtures in
// src/transcript/fixtures/*.json (each: { events: StreamEvent[], expected:
// TranscriptState }).
// =============================================================================

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  initialState,
  reduce,
  fromHistory,
  selectFlat,
  appendUserMessage,
  isUserAbortError,
} from "../src/transcript/index.js";
import type {
  StreamEvent,
  TranscriptState,
  TranscriptMessageItem,
  TranscriptToolItem,
  HistoryMessage,
} from "../src/transcript/index.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function run(events: StreamEvent[], from?: TranscriptState): TranscriptState {
  return events.reduce((s, e) => reduce(s, e), from ?? initialState());
}

function msgItems(s: TranscriptState): TranscriptMessageItem[] {
  return s.items.filter((it): it is TranscriptMessageItem => it.kind === "message");
}

function toolItems(s: TranscriptState): TranscriptToolItem[] {
  return s.items.filter((it): it is TranscriptToolItem => it.kind === "tool");
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  }
  return obj;
}

const text = (content: string, replace?: boolean): StreamEvent =>
  replace === undefined ? { type: "text", content } : { type: "text", content, replace };
const toolStart = (id: string, name = "bash", input: Record<string, unknown> = { command: "ls" }): StreamEvent =>
  ({ type: "tool_use_start", tool_use_id: id, name, input });
const toolLine = (id: string, content: string, stream: "stdout" | "stderr" = "stdout"): StreamEvent =>
  ({ type: "tool_streaming", tool_use_id: id, stream_type: stream, content });
const toolResult = (id: string, content: string, isError = false, extra?: Partial<Extract<StreamEvent, { type: "tool_result" }>>): StreamEvent =>
  ({ type: "tool_result", tool_use_id: id, name: "bash", content, is_error: isError, ...extra });
const done: StreamEvent = { type: "done" };

// -----------------------------------------------------------------------------
// initialState / selectFlat
// -----------------------------------------------------------------------------

describe("initialState", () => {
  test("is empty, JSON-serializable, and has a fresh cursor", () => {
    const s = initialState();
    expect(s.items).toEqual([]);
    expect(s.cursor).toEqual({
      streamingItemId: null,
      toolUseIdToItem: {},
      replaceTargetItemId: null,
      cancelPending: false,
      thinkingText: "",
      nextMessageSeq: 0,
      replacedCommitted: false,
      orphanToolResults: {},
    });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("selectFlat", () => {
  test("returns the ordered items as a defensive copy", () => {
    const s = run([text("hi"), toolStart("t1")]);
    const flat = selectFlat(s);
    expect(flat.map((it) => it.kind)).toEqual(["message", "tool"]);
    flat.pop();
    expect(s.items).toHaveLength(2); // original untouched
  });
});

// -----------------------------------------------------------------------------
// text
// -----------------------------------------------------------------------------

describe("text", () => {
  test("first delta creates a streaming assistant message with a deterministic id", () => {
    const s = run([text("Hel")]);
    expect(s.items).toEqual([
      { kind: "message", id: "msg-0", role: "assistant", text: "Hel", done: false },
    ]);
    expect(s.cursor.streamingItemId).toBe("msg-0");
  });

  test("subsequent deltas append to the streaming message", () => {
    const s = run([text("Hel"), text("lo"), text(" world")]);
    expect(msgItems(s)[0].text).toBe("Hello world");
    expect(s.items).toHaveLength(1);
  });

  test("replace=true swaps the streaming text wholesale", () => {
    const s = run([text("draft one"), text("final answer", true)]);
    expect(msgItems(s)[0].text).toBe("final answer");
    expect(s.cursor.replacedCommitted).toBe(false); // streaming, not committed
  });

  test("replace with no streaming and no replace target starts a fresh message", () => {
    const s = run([text("full text", true)]);
    expect(s.items).toEqual([
      { kind: "message", id: "msg-0", role: "assistant", text: "full text", done: false },
    ]);
  });

  test("replace retargets text committed by tool_use_start, in place, and reports replacedCommitted", () => {
    const s0 = run([text("thinking out loud"), toolStart("t1"), toolResult("t1", "ok")]);
    // text was committed (done=true) when the tool started
    expect(msgItems(s0)[0].done).toBe(true);
    expect(s0.cursor.replaceTargetItemId).toBe("msg-0");

    const s1 = reduce(s0, text("refined text", true));
    // Replaced IN PLACE (web rule) — item order unchanged
    expect(s1.items.map((it) => it.id)).toEqual(["msg-0", "t1"]);
    expect(msgItems(s1)[0].text).toBe("refined text");
    expect(msgItems(s1)[0].done).toBe(false); // streaming again
    expect(s1.cursor.streamingItemId).toBe("msg-0");
    expect(s1.cursor.replaceTargetItemId).toBeNull();
    // TUI adapter hook: this reduce replaced committed text
    expect(s1.cursor.replacedCommitted).toBe(true);
    // ...and the flag is transient: cleared by the very next reduce
    const s2 = reduce(s1, text(" more"));
    expect(s2.cursor.replacedCommitted).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// thinking
// -----------------------------------------------------------------------------

describe("thinking", () => {
  test("accumulates in the cursor without creating items", () => {
    const s = run([
      { type: "thinking", content: "hmm " },
      { type: "thinking", content: "okay" },
    ]);
    expect(s.items).toEqual([]);
    expect(s.cursor.thinkingText).toBe("hmm okay");
  });

  test("is cleared on done", () => {
    const s = run([{ type: "thinking", content: "hmm" }, done]);
    expect(s.cursor.thinkingText).toBe("");
  });
});

// -----------------------------------------------------------------------------
// tool_use_start / tool_streaming / tool_result
// -----------------------------------------------------------------------------

describe("tool_use_start", () => {
  test("creates a running tool item with id = tool_use_id and full input in meta", () => {
    const s = run([toolStart("toolu_1", "bash", { command: "echo hi" })]);
    expect(s.items).toEqual([
      {
        kind: "tool",
        id: "toolu_1",
        toolUseId: "toolu_1",
        name: "bash",
        inputPreview: "echo hi",
        status: "running",
        output: [],
        meta: { input: { command: "echo hi" } },
      },
    ]);
    expect(s.cursor.toolUseIdToItem).toEqual({ toolu_1: "toolu_1" });
  });

  test("commits in-flight streaming text first (done=true) and keeps it as the replace target", () => {
    const s = run([text("Let me check."), toolStart("t1")]);
    expect(msgItems(s)[0].done).toBe(true);
    expect(s.cursor.streamingItemId).toBeNull();
    expect(s.cursor.replaceTargetItemId).toBe("msg-0");
    expect(s.items.map((it) => it.kind)).toEqual(["message", "tool"]);
  });

  test("carries approvalReason / batchId / batchSize into meta", () => {
    const s = run([
      {
        type: "tool_use_start",
        tool_use_id: "t1",
        name: "bash",
        input: {},
        approvalReason: "safe_command",
        batchId: "b1",
        batchSize: 2,
      },
    ]);
    expect(toolItems(s)[0].meta).toEqual({
      input: {},
      approvalReason: "safe_command",
      batchId: "b1",
      batchSize: 2,
    });
  });

  test("duplicate tool_use_id gets a uniqued item id, map points at the newest", () => {
    const s = run([toolStart("dup"), toolResult("dup", "one"), toolStart("dup")]);
    expect(toolItems(s).map((t) => t.id)).toEqual(["dup", "dup#2"]);
    expect(s.cursor.toolUseIdToItem).toEqual({ dup: "dup#2" });
  });
});

describe("tool_streaming", () => {
  test("appends typed lines to the tool's output", () => {
    const s = run([
      toolStart("t1"),
      toolLine("t1", "line 1"),
      toolLine("t1", "warn", "stderr"),
    ]);
    expect(toolItems(s)[0].output).toEqual([
      { type: "stdout", content: "line 1" },
      { type: "stderr", content: "warn" },
    ]);
  });

  test("unknown tool_use_id is a no-op", () => {
    const s0 = run([toolStart("t1")]);
    const s1 = reduce(s0, toolLine("nope", "x"));
    expect(s1.items).toEqual(s0.items);
  });
});

describe("tool_result", () => {
  test("keeps streamed lines when present and stashes the raw result in meta (TUI rule)", () => {
    const s = run([
      toolStart("t1"),
      toolLine("t1", "streamed line"),
      toolResult("t1", "truncated summary"),
    ]);
    const t = toolItems(s)[0];
    expect(t.status).toBe("ok");
    expect(t.output).toEqual([{ type: "stdout", content: "streamed line" }]);
    expect(t.meta?.resultContent).toBe("truncated summary");
    expect(s.cursor.toolUseIdToItem).toEqual({});
  });

  test("without streamed lines, splits display_content||content into non-empty lines", () => {
    const s = run([
      toolStart("t1"),
      toolResult("t1", "raw for api", false, { display_content: "pretty a\n\npretty b" }),
    ]);
    const t = toolItems(s)[0];
    expect(t.output).toEqual([
      { type: "stdout", content: "pretty a" },
      { type: "stdout", content: "pretty b" },
    ]);
    expect(t.meta?.resultContent).toBe("raw for api");
    expect(t.meta?.displayContent).toBe("pretty a\n\npretty b");
  });

  test("error result flips status to error with stderr lines", () => {
    const s = run([toolStart("t1"), toolResult("t1", "boom\nbad", true)]);
    const t = toolItems(s)[0];
    expect(t.status).toBe("error");
    expect(t.output).toEqual([
      { type: "stderr", content: "boom" },
      { type: "stderr", content: "bad" },
    ]);
    expect(t.meta?.isError).toBe(true);
  });

  test("stores tool metadata (e.g. diff data) in meta.metadata", () => {
    const s = run([
      toolStart("t1", "edit_file", { file_path: "a.ts" }),
      toolResult("t1", "ok", false, { metadata: { diff: "x" } }),
    ]);
    expect(toolItems(s)[0].meta?.metadata).toEqual({ diff: "x" });
  });

  test("orphan error result appends a system item; orphan success is dropped", () => {
    const long = "e".repeat(300);
    const s = run([
      toolResult("ghost-ok", "fine", false),
      { type: "tool_result", tool_use_id: "ghost", name: "bash", content: long, is_error: true },
    ]);
    expect(s.items).toHaveLength(1);
    const m = msgItems(s)[0];
    expect(m.role).toBe("system");
    expect(m.text).toBe(`Tool bash failed: ${"e".repeat(200)}`);
    expect(m.meta?.marker).toBe("orphan_tool_error");
  });

  test("live orphan result is stashed; a late tool_use_start consumes it and resolves", () => {
    // Out-of-order replayed/re-broadcast stream: result before start.
    const s0 = run([toolResult("tx", "early output")]);
    expect(s0.items).toEqual([]); // success emits nothing…
    expect(s0.cursor.orphanToolResults).toEqual({
      tx: { content: "early output", isError: false },
    }); // …but the result is NOT lost
    const s1 = run([toolStart("tx"), done], s0);
    const t = toolItems(s1)[0];
    expect(t.status).toBe("ok"); // created already resolved — never spins
    expect(t.meta?.resultContent).toBe("early output");
    expect(t.output).toEqual([{ type: "stdout", content: "early output" }]);
    expect(s1.cursor.orphanToolResults).toEqual({}); // stash consumed
    expect(s1.cursor.toolUseIdToItem).toEqual({}); // never registered as in-flight
  });

  test("live orphan ERROR result is stashed too (system item still emitted)", () => {
    const s0 = run([toolResult("tx", "boom", true)]);
    expect(msgItems(s0)[0].meta?.marker).toBe("orphan_tool_error");
    expect(s0.cursor.orphanToolResults.tx).toEqual({ content: "boom", isError: true });
    const s1 = reduce(s0, toolStart("tx"));
    expect(toolItems(s1)[0].status).toBe("error");
    expect(toolItems(s1)[0].meta?.isError).toBe(true);
  });

  test("duplicate result for an already-resolved tool is dropped (no bogus orphan error)", () => {
    const s0 = run([toolStart("t1"), toolResult("t1", "ok output")]);
    // Replayed broadcast: same tool_use_id, this time as an error.
    const s1 = reduce(s0, toolResult("t1", "boom", true));
    expect(s1.items).toEqual(s0.items); // resolved card untouched, nothing appended
    expect(toolItems(s1)[0].status).toBe("ok");
  });

  test("parallel tools resolve independently and out of order", () => {
    const s = run([
      toolStart("a", "bash", { command: "sleep 1" }),
      toolStart("b", "bash", { command: "sleep 2" }),
      toolResult("b", "b done"),
      toolResult("a", "a failed", true),
    ]);
    const [a, b] = toolItems(s);
    expect(a.status).toBe("error");
    expect(b.status).toBe("ok");
  });
});

// -----------------------------------------------------------------------------
// done
// -----------------------------------------------------------------------------

describe("done", () => {
  test("finalizes streaming text and resets streaming bookkeeping", () => {
    const s = run([text("answer"), done]);
    expect(msgItems(s)[0]).toEqual({
      kind: "message", id: "msg-0", role: "assistant", text: "answer", done: true,
    });
    expect(s.cursor.streamingItemId).toBeNull();
    expect(s.cursor.replaceTargetItemId).toBeNull();
    expect(s.cursor.toolUseIdToItem).toEqual({});
  });

  test("clears a stale cancelPending flag (web rule)", () => {
    const s = run([{ type: "cancel", content: "stopped" }, done]);
    expect(s.cursor.cancelPending).toBe(false);
  });

  test("adds no items (usage/cost are adapter concerns)", () => {
    const s = run([
      text("hi"),
      { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, sessionCostUSD: 0.01 },
    ]);
    expect(s.items).toHaveLength(1);
  });

  test("settles in-flight tools as ok with meta.settledByDone (no permanent spinner)", () => {
    // The tool's result broadcast was dropped, but the turn completed —
    // done must settle the card, because it wipes toolUseIdToItem and a
    // late tool_result would be dropped as a duplicate.
    const s = run([toolStart("t1"), toolStart("t2"), toolResult("t1", "out"), done]);
    const [t1, t2] = toolItems(s);
    expect(t1.status).toBe("ok");
    expect(t1.meta?.settledByDone).toBeUndefined(); // resolved normally — untouched
    expect(t2.status).toBe("ok");
    expect(t2.meta?.settledByDone).toBe(true);
    expect(s.cursor.toolUseIdToItem).toEqual({});
    // A late replayed result after done is still a harmless no-op.
    const s1 = reduce(s, toolResult("t2", "late"));
    expect(s1.items).toEqual(s.items);
  });

  test("settles fromHistory-restored trailing running tools of a dead session", () => {
    const s0 = fromHistory([
      {
        index: 0, role: "assistant", timestamp: "ts",
        content: [{ type: "tool_use", id: "stuck", name: "bash", input: {} }],
      },
    ]);
    expect(toolItems(s0)[0].status).toBe("running");
    // Next turn completes without ever resolving the restored tool.
    const s1 = run([text("new answer"), done], s0);
    expect(toolItems(s1)[0].status).toBe("ok");
    expect(toolItems(s1)[0].meta?.settledByDone).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// error / cancel (sentinel-gated suppression — canonicalized from web)
// -----------------------------------------------------------------------------

describe("error", () => {
  test("appends a system 'Error: …' item with marker and code", () => {
    const s = run([{ type: "error", content: "kaput", code: "api_error" }]);
    expect(msgItems(s)[0]).toMatchObject({
      role: "system",
      text: "Error: kaput",
      done: true,
      meta: { marker: "error", code: "api_error" },
    });
  });

  test("finalizes any streaming text without altering it", () => {
    const s = run([text("partial"), { type: "error", content: "boom" }]);
    expect(msgItems(s)[0]).toMatchObject({ text: "partial", done: true });
    expect(s.cursor.streamingItemId).toBeNull();
  });

  test("user-abort error right after cancel is suppressed, flag consumed", () => {
    const s0 = run([text("hi"), { type: "cancel", content: "Request cancelled by user" }]);
    expect(s0.cursor.cancelPending).toBe(true);
    const s1 = reduce(s0, { type: "error", content: "Request aborted by user" });
    expect(s1.items).toHaveLength(s0.items.length); // nothing appended
    expect(s1.cursor.cancelPending).toBe(false);
    // A later abort-shaped error is NOT suppressed (flag already consumed)
    const s2 = reduce(s1, { type: "error", content: "Request aborted by user" });
    expect(msgItems(s2).at(-1)?.text).toBe("Error: Request aborted by user");
  });

  test("settles in-flight tools as error with meta.aborted (no permanent spinner)", () => {
    const s = run([
      toolStart("t1"),
      toolStart("t2"),
      toolResult("t1", "finished first"),
      { type: "error", content: "connection lost" },
      done, // wipes toolUseIdToItem — t2 could never settle after this
    ]);
    const [t1, t2] = toolItems(s);
    expect(t1.status).toBe("ok"); // already resolved — untouched
    expect(t1.meta?.aborted).toBeUndefined();
    expect(t2.status).toBe("error");
    expect(t2.meta?.aborted).toBe(true);
    expect(s.cursor.toolUseIdToItem).toEqual({});
  });

  test("non-abort error right after cancel still surfaces (sentinel gate)", () => {
    const s0 = run([{ type: "cancel", content: "stopped" }]);
    const s1 = reduce(s0, { type: "error", content: "ECONNRESET" });
    expect(msgItems(s1).at(-1)?.text).toBe("Error: ECONNRESET");
    expect(s1.cursor.cancelPending).toBe(false);
  });
});

describe("isUserAbortError", () => {
  test("matches the backend sentinel variants only", () => {
    expect(isUserAbortError("Request aborted by user")).toBe(true);
    expect(isUserAbortError("Request aborted by the user")).toBe(true);
    expect(isUserAbortError("aborted BY USER")).toBe(true);
    expect(isUserAbortError("connection reset")).toBe(false);
    expect(isUserAbortError(undefined)).toBe(false);
  });
});

describe("cancel", () => {
  test("finalizes streaming text UNSUFFIXED and emits a marker item (web rule)", () => {
    const s = run([text("half an ans"), { type: "cancel", content: "Request cancelled by user" }]);
    expect(msgItems(s)[0]).toMatchObject({ text: "half an ans", done: true });
    const marker = msgItems(s)[1];
    expect(marker).toMatchObject({
      role: "system",
      text: "Request cancelled by user",
      meta: { marker: "cancel" },
    });
    expect(s.cursor.cancelPending).toBe(true);
    expect(s.cursor.streamingItemId).toBeNull();
  });

  test("flips in-flight tools to error with meta.cancelled=true and clears the map", () => {
    const s = run([
      toolStart("t1"),
      toolStart("t2"),
      toolResult("t1", "finished first"),
      { type: "cancel", content: "stopped" },
    ]);
    const [t1, t2] = toolItems(s);
    expect(t1.status).toBe("ok"); // already resolved — untouched
    expect(t1.meta?.cancelled).toBeUndefined();
    expect(t2.status).toBe("error");
    expect(t2.meta?.cancelled).toBe(true);
    expect(s.cursor.toolUseIdToItem).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// queue_message / system_message
// -----------------------------------------------------------------------------

describe("queue_message", () => {
  test("emits a system item carrying the queued text and position", () => {
    const s = run([{ type: "queue_message", content: "do it later", position: 1 }]);
    expect(msgItems(s)[0]).toMatchObject({
      role: "system",
      text: "do it later",
      meta: { marker: "queue", position: 1 },
    });
  });
});

describe("system_message", () => {
  test("emits a system item, preserving the subtype", () => {
    const s = run([
      { type: "system_message", content: "Context compacted", subtype: "compaction" },
      { type: "system_message", content: "plain" },
    ]);
    expect(msgItems(s)[0].meta).toEqual({ subtype: "compaction" });
    expect(msgItems(s)[1].meta).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// user messages + user_committed
// -----------------------------------------------------------------------------

describe("appendUserMessage / user_committed", () => {
  test("appendUserMessage creates a done user bubble with a counter id", () => {
    const s = appendUserMessage(initialState(), "hello");
    expect(s.items).toEqual([
      { kind: "message", id: "msg-0", role: "user", text: "hello", done: true },
    ]);
    expect(s.cursor.nextMessageSeq).toBe(1);
  });

  test("user_committed stamps backendIndex on the last un-stamped user bubble, id unchanged", () => {
    let s = appendUserMessage(initialState(), "first", { backendIndex: 4 });
    s = appendUserMessage(s, "second");
    s = reduce(s, { type: "user_committed", message_index: 6 });
    const users = msgItems(s);
    expect(users[0].backendIndex).toBe(4); // already stamped — untouched
    expect(users[1].backendIndex).toBe(6);
    expect(users[1].id).toBe("msg-1"); // stable React key
  });

  test("user_committed stamps FIFO when two sends are pending (commits arrive in send order)", () => {
    let s = appendUserMessage(initialState(), "first");
    s = appendUserMessage(s, "second"); // e.g. a queued message
    s = reduce(s, { type: "user_committed", message_index: 10 });
    s = reduce(s, { type: "user_committed", message_index: 12 });
    const users = msgItems(s);
    expect(users[0].backendIndex).toBe(10); // NOT cross-stamped
    expect(users[1].backendIndex).toBe(12);
  });

  test("user_committed with nothing to stamp is a no-op", () => {
    const s0 = run([text("assistant only")]);
    const s1 = reduce(s0, { type: "user_committed", message_index: 9 });
    expect(s1.items).toEqual(s0.items);
  });

  test("user_committed skips index-less HISTORY user items — stamps the pending optimistic bubble", () => {
    // Legacy/foreign history feed: row without msg.index (fromHistory
    // tolerates it, so its items violate the "history always carries an
    // index" assumption the stamping scan otherwise relies on).
    const s0 = fromHistory([{ role: "user", content: "legacy" } as HistoryMessage]);
    expect(msgItems(s0)[0].backendIndex).toBeUndefined();
    const s1 = appendUserMessage(s0, "new send");
    const s2 = reduce(s1, { type: "user_committed", message_index: 42 });
    const [legacy, fresh] = msgItems(s2);
    expect(legacy.backendIndex).toBeUndefined(); // NOT stamped with a bogus index
    expect(fresh.backendIndex).toBe(42); // the real optimistic bubble
  });

  test("appendUserMessage with a caller-supplied msg-N id cannot collide with seq-minted ids", () => {
    const s0 = appendUserMessage(initialState(), "u", { id: "msg-0" });
    expect(s0.cursor.nextMessageSeq).toBe(1); // counter advanced past the taken id
    const s1 = run([text("delta")], s0);
    expect(s1.items.map((it) => it.id)).toEqual(["msg-0", "msg-1"]); // unique
    const s2 = reduce(s1, text(" more"));
    expect(msgItems(s2)[0].text).toBe("u"); // user bubble untouched by deltas
    expect(msgItems(s2)[1].text).toBe("delta more");
  });

  test("appendUserMessage #n-suffixes a supplied id that already exists", () => {
    let s = appendUserMessage(initialState(), "a", { id: "dup" });
    s = appendUserMessage(s, "b", { id: "dup" });
    s = appendUserMessage(s, "c", { id: "dup" });
    expect(s.items.map((it) => it.id)).toEqual(["dup", "dup#2", "dup#3"]);
  });
});

// -----------------------------------------------------------------------------
// dialog events are transcript no-ops
// -----------------------------------------------------------------------------

describe("permission / ask_user events", () => {
  test("do not touch items or streaming bookkeeping", () => {
    const s0 = run([text("streaming…")]);
    const events: StreamEvent[] = [
      { type: "permission_request", id: "p1", tool_use_id: "t1", tool_name: "bash", tool_input: {} },
      { type: "permission_result", id: "p1", decision: "allow_once" },
      { type: "ask_user_request", id: "q1", tool_use_id: "t1", question: "which?", options: ["a"], multi_select: false },
      { type: "ask_user_response", id: "q1", selected: ["a"] },
    ];
    const s1 = run(events, s0);
    expect(s1.items).toEqual(s0.items);
    expect(s1.cursor.streamingItemId).toBe(s0.cursor.streamingItemId);
  });
});

// -----------------------------------------------------------------------------
// purity + determinism + full union coverage
// -----------------------------------------------------------------------------

describe("purity", () => {
  const everyEvent: StreamEvent[] = [
    text("a"),
    text("b", true),
    { type: "thinking", content: "t" },
    toolStart("t1"),
    toolLine("t1", "l"),
    toolResult("t1", "r"),
    { type: "permission_request", id: "p", tool_use_id: "t2", tool_name: "bash", tool_input: {} },
    { type: "permission_result", id: "p", decision: "deny" },
    { type: "ask_user_request", id: "q", tool_use_id: "t2", question: "?", options: [], multi_select: false },
    { type: "ask_user_response", id: "q", selected: [] },
    { type: "queue_message", content: "queued", position: 1 },
    { type: "system_message", content: "sys", subtype: "info" },
    { type: "user_committed", message_index: 0 },
    { type: "cancel", content: "stopped" },
    { type: "error", content: "bad", code: "api_error" },
    done,
  ];

  test("reduce never mutates its inputs (deep-frozen state and events)", () => {
    let s = deepFreeze(initialState());
    for (const e of everyEvent) {
      s = deepFreeze(reduce(s, deepFreeze(structuredClone(e))));
    }
    expect(s.items.length).toBeGreaterThan(0);
  });

  test("reduce is deterministic: same sequence twice gives deep-equal states", () => {
    const a = run(everyEvent);
    const b = run(everyEvent);
    expect(a).toEqual(b);
  });

  test("state stays JSON-serializable through the full union", () => {
    const s = run(everyEvent);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  test("covers every StreamEvent type (compile-time exhaustive, runtime spot check)", () => {
    const seen = new Set(everyEvent.map((e) => e.type));
    expect([...seen].sort()).toEqual([
      "ask_user_request", "ask_user_response", "cancel", "done", "error",
      "permission_request", "permission_result", "queue_message",
      "system_message", "text", "thinking", "tool_result", "tool_streaming",
      "tool_use_start", "user_committed",
    ]);
  });
});

// -----------------------------------------------------------------------------
// fromHistory
// -----------------------------------------------------------------------------

describe("fromHistory", () => {
  test("string content becomes one done message with backendIndex + timestamp", () => {
    const s = fromHistory([
      { index: 0, role: "user", timestamp: "2026-01-01T00:00:00Z", content: "hey" },
    ]);
    expect(s.items).toEqual([
      {
        kind: "message", id: "msg-hi0.0", role: "user", text: "hey", done: true,
        backendIndex: 0, timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  test("text blocks fold into one bubble per row; deterministic index-based ids", () => {
    const s = fromHistory([
      { index: 3, role: "assistant", timestamp: "ts1", content: [{ type: "text", text: "part 1 " }, { type: "text", text: "part 2" }] },
    ]);
    expect(msgItems(s)[0]).toMatchObject({
      id: "msg-hi3.0", role: "assistant", text: "part 1 part 2", backendIndex: 3, done: true,
    });
  });

  test("tool_use + matching tool_result pair into one resolved tool item", () => {
    const s = fromHistory([
      {
        index: 1, role: "assistant", timestamp: "ts1",
        content: [
          { type: "text", text: "Running it." },
          { type: "tool_use", id: "toolu_9", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        index: 2, role: "user", timestamp: "ts2",
        content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "file.txt", is_error: false }],
      },
    ]);
    expect(s.items.map((it) => it.kind)).toEqual(["message", "tool"]);
    const t = toolItems(s)[0];
    expect(t).toMatchObject({
      id: "toolu_9", toolUseId: "toolu_9", name: "bash", status: "ok", timestamp: "ts1",
    });
    expect(t.output).toEqual([{ type: "stdout", content: "file.txt" }]);
    expect(t.meta).toMatchObject({ input: { command: "ls" }, resultContent: "file.txt", isError: false });
  });

  test("text inside a tool_result turn is skipped (web rule: no blank user bubbles)", () => {
    const s = fromHistory([
      {
        index: 2, role: "user", timestamp: "ts2",
        content: [
          { type: "tool_result", tool_use_id: "missing", content: "out", is_error: false },
          { type: "text", text: "plumbing text" },
        ],
      },
    ]);
    expect(msgItems(s)).toEqual([]);
  });

  test("array tool_result content joins its text parts", () => {
    const s = fromHistory([
      { index: 0, role: "assistant", timestamp: "t", content: [{ type: "tool_use", id: "a", name: "bash", input: {} }] },
      {
        index: 1, role: "user", timestamp: "t",
        content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }], is_error: false }],
      },
    ]);
    expect(toolItems(s)[0].meta?.resultContent).toBe("xy");
  });

  test("orphan tool_results land in cursor.orphanToolResults for cross-page stitching", () => {
    const s = fromHistory([
      {
        index: 10, role: "user", timestamp: "ts",
        content: [{ type: "tool_result", tool_use_id: "older-page-tool", content: "late output", is_error: true }],
      },
    ]);
    expect(s.cursor.orphanToolResults).toEqual({
      "older-page-tool": { content: "late output", isError: true },
    });
    expect(s.items).toEqual([]);
  });

  test("adjacent runs of 2+ tool_uses share a synthetic batchId; interleaved text splits runs", () => {
    const s = fromHistory([
      {
        index: 0, role: "assistant", timestamp: "ts",
        content: [
          { type: "tool_use", id: "a", name: "bash", input: {} },
          { type: "tool_use", id: "b", name: "bash", input: {} },
          { type: "text", text: "then, separately:" },
          { type: "tool_use", id: "c", name: "bash", input: {} },
        ],
      },
    ]);
    const [a, b, c] = toolItems(s);
    expect(a.meta?.batchId).toBeDefined();
    expect(a.meta?.batchId).toBe(b.meta?.batchId);
    expect(c.meta?.batchId).toBeUndefined();
  });

  test("synthetic batchIds never collide across separate fromHistory folds (pagination)", () => {
    const parallelRow = (index: number): HistoryMessage => ({
      index, role: "assistant", timestamp: `ts${index}`,
      content: [
        { type: "tool_use", id: `t${index}a`, name: "bash", input: {} },
        { type: "tool_use", id: `t${index}b`, name: "bash", input: {} },
      ],
    });
    // Two pages, each folded with its own fromHistory call (web's
    // loadOlderMessages), then prepended into one items array.
    const olderPage = fromHistory([parallelRow(0)]);
    const newerPage = fromHistory([parallelRow(100)]);
    const olderBatch = toolItems(olderPage)[0].meta?.batchId;
    const newerBatch = toolItems(newerPage)[0].meta?.batchId;
    expect(olderBatch).toBeDefined();
    expect(newerBatch).toBeDefined();
    expect(olderBatch).not.toBe(newerBatch); // would merge unrelated ToolSteps
    // Same row folded twice (re-fetch) still gets the SAME id — the batch id
    // derives from row identity, not call-local state.
    expect(toolItems(fromHistory([parallelRow(0)]))[0].meta?.batchId).toBe(olderBatch);
  });

  test("idNamespace keeps legacy index-less row ids (and their batchIds) unique across folds", () => {
    const legacyRows: HistoryMessage[] = [
      { role: "user", content: "no index" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "", name: "bash", input: {} },
          { type: "tool_use", id: "", name: "bash", input: {} },
        ],
      },
    ];
    const pageA = fromHistory(legacyRows, { idNamespace: "p50" });
    const pageB = fromHistory(legacyRows, { idNamespace: "p150" });
    const idsA = pageA.items.map((it) => it.id);
    const idsB = pageB.items.map((it) => it.id);
    expect(idsA[0]).toBe("msg-hp50.r0.0");
    for (const id of idsA) expect(idsB).not.toContain(id);
    expect(toolItems(pageA)[0].meta?.batchId).not.toBe(toolItems(pageB)[0].meta?.batchId);
    // Without a namespace the fallback stays the bare row ordinal (back-compat).
    expect(msgItems(fromHistory([legacyRows[0]]))[0].id).toBe("msg-hr0.0");
  });

  test("stale 'running' tools in non-trailing turns are reclassified to ok; trailing turn keeps running", () => {
    const s = fromHistory([
      {
        index: 0, role: "assistant", timestamp: "ts-old",
        content: [{ type: "tool_use", id: "legacy", name: "bash", input: {} }], // result never persisted
      },
      { index: 1, role: "user", timestamp: "ts-mid", content: "next question" },
      {
        index: 2, role: "assistant", timestamp: "ts-new",
        content: [{ type: "tool_use", id: "inflight", name: "bash", input: {} }],
      },
    ]);
    const byId = Object.fromEntries(toolItems(s).map((t) => [t.id, t.status]));
    expect(byId.legacy).toBe("ok");       // earlier turn — must have completed
    expect(byId.inflight).toBe("running"); // trailing turn — genuinely in flight
  });

  test("image and document blocks attach to the flushed bubble with fallback text", () => {
    const s = fromHistory([
      {
        index: 0, role: "user", timestamp: "ts",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
      },
      {
        index: 1, role: "user", timestamp: "ts2",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAABBBB" }, title: "spec.pdf" },
          { type: "text", text: "please read" },
        ],
      },
    ]);
    const [img, doc] = msgItems(s);
    expect(img.text).toBe("(image attached)");
    expect(img.meta?.images).toEqual([{ base64: "AAAA", media_type: "image/png" }]);
    expect(doc.text).toBe("please read");
    expect(doc.meta?.documents).toEqual([
      { media_type: "application/pdf", filename: "spec.pdf", sizeBytes: 6 },
    ]);
  });

  test("legacy fallback: a non-tool-result row that produced nothing gets one joined bubble", () => {
    const s = fromHistory([
      { role: "system", timestamp: "ts-a", content: [{ type: "weird_block", text: "legacy note" }] },
    ]);
    expect(msgItems(s)[0]).toMatchObject({ role: "system", text: "legacy note", done: true });
  });

  test("legacy fallback fires per row even when consecutive rows share a timestamp", () => {
    const s = fromHistory([
      { role: "system", timestamp: "ts-same", content: [{ type: "weird_block", text: "row one legacy" }] },
      { role: "system", timestamp: "ts-same", content: [{ type: "weird_block", text: "row two legacy" }] },
    ]);
    expect(msgItems(s).map((m) => m.text)).toEqual(["row one legacy", "row two legacy"]);
  });

  test("duplicate tool_use ids get uniqued item ids, matching the live fold", () => {
    const s = fromHistory([
      {
        index: 0, role: "assistant", timestamp: "ts",
        content: [
          { type: "tool_use", id: "dup", name: "bash", input: {} },
          { type: "tool_use", id: "dup", name: "bash", input: {} },
        ],
      },
    ]);
    expect(toolItems(s).map((t) => t.id)).toEqual(["dup", "dup#2"]);
  });

  test("seeds cursor.toolUseIdToItem for trailing running tools so a live tool_result resolves them", () => {
    const s0 = fromHistory([
      { index: 0, role: "user", timestamp: "ts-old", content: "run it" },
      {
        index: 1, role: "assistant", timestamp: "ts-new",
        content: [{ type: "tool_use", id: "t9", name: "bash", input: { command: "ls" } }],
      },
    ]);
    expect(s0.cursor.toolUseIdToItem).toEqual({ t9: "t9" });
    // Reconnect-mid-turn: the in-flight tool's result arrives live.
    const s1 = reduce(s0, toolResult("t9", "file.txt"));
    const t = toolItems(s1)[0];
    expect(t.status).toBe("ok");
    expect(t.meta?.resultContent).toBe("file.txt");
    expect(s1.cursor.toolUseIdToItem).toEqual({});
    // Reclassified-to-ok (non-trailing) tools are NOT registered.
    const s2 = fromHistory([
      {
        index: 0, role: "assistant", timestamp: "ts-old",
        content: [{ type: "tool_use", id: "legacy", name: "bash", input: {} }],
      },
      { index: 1, role: "user", timestamp: "ts-new", content: "next" },
    ]);
    expect(s2.cursor.toolUseIdToItem).toEqual({});
  });

  test("rows without index still get deterministic row-ordinal ids", () => {
    const s = fromHistory([{ role: "user", content: "no index" } as HistoryMessage]);
    expect(msgItems(s)[0].id).toBe("msg-hr0.0");
    expect(msgItems(s)[0].backendIndex).toBeUndefined();
  });

  test("live reduce continues cleanly on top of a fromHistory state", () => {
    const s0 = fromHistory([{ index: 0, role: "user", timestamp: "ts", content: "hi" }]);
    const s1 = run([text("hello!"), done], s0);
    expect(s1.items.map((it) => it.id)).toEqual(["msg-hi0.0", "msg-0"]);
    expect(msgItems(s1)[1]).toMatchObject({ role: "assistant", text: "hello!", done: true });
  });

  test("is pure: same rows in, deep-equal state out; inputs not mutated", () => {
    const rows: HistoryMessage[] = [
      { index: 0, role: "assistant", timestamp: "t", content: [{ type: "tool_use", id: "a", name: "bash", input: { command: "x" } }] },
    ];
    const frozen = deepFreeze(structuredClone(rows));
    expect(fromHistory(frozen)).toEqual(fromHistory(rows));
  });
});

// -----------------------------------------------------------------------------
// Golden fixtures (language-neutral)
// -----------------------------------------------------------------------------

describe("golden fixtures", () => {
  const fixturesDir = join(import.meta.dir, "../src/transcript/fixtures");
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();

  test("fixture directory is populated", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    test(`fixture: ${file}`, () => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as {
        events: StreamEvent[];
        expected: TranscriptState;
      };
      expect(Array.isArray(fixture.events)).toBe(true);
      expect(fixture.expected).toBeDefined();
      const state = run(fixture.events);
      // JSON round-trip normalizes undefined-valued optional fields so the
      // comparison is exactly what a non-TS consumer would see.
      expect(JSON.parse(JSON.stringify(state))).toEqual(fixture.expected);
    });
  }
});
