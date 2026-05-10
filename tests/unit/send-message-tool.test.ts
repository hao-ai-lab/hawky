// =============================================================================
// send_message tool — unit tests.
//
// Scope:
//   - missing platform/to/text → error
//   - unsupported platform → error
//   - no deps injected → error
//   - platform not configured (no adapter) → error
//   - adapter not ready → error
//   - happy path → calls adapter.sendText and returns ok
//   - adapter sendText failure → error
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  executeSendMessage,
  setSendMessageDeps,
  resetSendMessageDeps,
} from "../../src/tools/send_message.js";
import type { ToolContext } from "../../src/agent/types.js";

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

class MockAdapter {
  channelId: string;
  ready: boolean;
  result: { ok: boolean; messageId?: string; error?: string };
  calls: Array<{ to: string; text: string; threadId?: string }> = [];
  // null = adapter has no resolveRecipients (feature-detect path);
  // array = candidates returned for any query.
  recipients: Array<{ id: string; label: string; kind?: "user" | "channel" }> | null = null;

  constructor(channelId: string, ready = true, result = { ok: true, messageId: "ts1" }) {
    this.channelId = channelId;
    this.ready = ready;
    this.result = result;
  }
  isReady(): boolean {
    return this.ready;
  }
  async sendText(opts: { to: string; text: string; threadId?: string }) {
    this.calls.push(opts);
    return { channelId: this.channelId, ...this.result };
  }
  // Only present when recipients is set, so the tool's feature-detect works
  // for adapters without name resolution.
  get resolveRecipients() {
    if (this.recipients === null) return undefined;
    const list = this.recipients;
    return async (_q: string) => list;
  }
  async stop(): Promise<void> {}
}

class MockRegistry {
  private map = new Map<string, MockAdapter>();
  add(adapter: MockAdapter): void {
    this.map.set(adapter.channelId, adapter);
  }
  getOutbound(id: string): MockAdapter | undefined {
    return this.map.get(id);
  }
}

function makeCtx(): ToolContext {
  return {
    session_id: "test",
    working_directory: "/tmp",
    abort_signal: new AbortController().signal,
    emit: () => {},
  } as unknown as ToolContext;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("send_message tool", () => {
  afterEach(() => {
    resetSendMessageDeps();
  });

  test("missing platform returns an error", async () => {
    setSendMessageDeps(new MockRegistry() as any);
    const r = await executeSendMessage({ platform: "" as any, to: "#x", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("platform");
  });

  test("unsupported platform returns an error", async () => {
    setSendMessageDeps(new MockRegistry() as any);
    const r = await executeSendMessage({ platform: "telegram" as any, to: "#x", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("Unsupported platform");
  });

  test("missing to returns an error", async () => {
    setSendMessageDeps(new MockRegistry() as any);
    const r = await executeSendMessage({ platform: "slack", to: "  ", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("to");
  });

  test("missing text returns an error", async () => {
    setSendMessageDeps(new MockRegistry() as any);
    const r = await executeSendMessage({ platform: "slack", to: "#x", text: "   " }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("text");
  });

  test("no deps injected returns an error", async () => {
    resetSendMessageDeps();
    const r = await executeSendMessage({ platform: "slack", to: "#x", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("not available");
  });

  test("platform not configured returns an error", async () => {
    setSendMessageDeps(new MockRegistry() as any); // empty registry
    const r = await executeSendMessage({ platform: "slack", to: "#x", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("not configured");
  });

  test("adapter not ready returns an error", async () => {
    const reg = new MockRegistry();
    reg.add(new MockAdapter("slack", false));
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "#x", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("not ready");
  });

  test("happy path sends and returns ok", async () => {
    const reg = new MockRegistry();
    const adapter = new MockAdapter("slack");
    reg.add(adapter);
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage(
      { platform: "slack", to: "#general", text: "build passed", thread_id: "t1" },
      makeCtx(),
    );
    expect(r.type).toBe("text");
    expect((r as any).content).toContain("ok: sent to #general on slack");
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0]).toEqual({ to: "#general", text: "build passed", threadId: "t1" });
  });

  test("adapter sendText failure returns an error", async () => {
    const reg = new MockRegistry();
    reg.add(new MockAdapter("slack", true, { ok: false, error: "channel_not_found" }));
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "#nope", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("channel_not_found");
  });

  test("a name resolves to a single user and sends to their id", async () => {
    const reg = new MockRegistry();
    const adapter = new MockAdapter("slack");
    adapter.recipients = [{ id: "U061KKSLXQE", label: "Jay (Xinkai) Zou" }];
    reg.add(adapter);
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "xinkai", text: "你好" }, makeCtx());
    expect(r.type).toBe("text");
    // sent to the resolved id, not the raw name
    expect(adapter.calls[0].to).toBe("U061KKSLXQE");
    expect((r as any).content).toContain("xinkai (U061KKSLXQE)");
  });

  test("a loose channel name resolves to the channel id and posts there", async () => {
    const reg = new MockRegistry();
    const adapter = new MockAdapter("slack");
    adapter.recipients = [{ id: "C0AMBIENT", label: "research-ambient-agent", kind: "channel" }];
    reg.add(adapter);
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "ambient", text: "hi team" }, makeCtx());
    expect(r.type).toBe("text");
    expect(adapter.calls[0].to).toBe("C0AMBIENT");
  });

  test("an ambiguous name returns candidates instead of sending", async () => {
    const reg = new MockRegistry();
    const adapter = new MockAdapter("slack");
    adapter.recipients = [
      { id: "U1", label: "Jay (Xinkai) Zou", kind: "user" },
      { id: "C2", label: "xinkai-fans", kind: "channel" },
    ];
    reg.add(adapter);
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "xinkai", text: "你好" }, makeCtx());
    expect(r.type).toBe("text");
    expect((r as any).content).toContain("Multiple");
    expect((r as any).metadata?.ambiguous).toBe(true);
    expect(adapter.calls.length).toBe(0); // did NOT send
  });

  test("a name with no match returns an error and does not send", async () => {
    const reg = new MockRegistry();
    const adapter = new MockAdapter("slack");
    adapter.recipients = []; // resolver returns nothing
    reg.add(adapter);
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "nobody", text: "hi" }, makeCtx());
    expect(r.type).toBe("error");
    expect((r as any).content).toContain("No slack user or channel matched");
    expect(adapter.calls.length).toBe(0);
  });

  test("a channel (#general) skips name resolution", async () => {
    const reg = new MockRegistry();
    const adapter = new MockAdapter("slack");
    // recipients set, but a #channel must NOT be fuzzy-resolved
    adapter.recipients = [{ id: "Uxxx", label: "should not be used" }];
    reg.add(adapter);
    setSendMessageDeps(reg as any);
    const r = await executeSendMessage({ platform: "slack", to: "#general", text: "hi" }, makeCtx());
    expect(r.type).toBe("text");
    expect(adapter.calls[0].to).toBe("#general");
  });
});
