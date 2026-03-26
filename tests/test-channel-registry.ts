import { describe, test, expect, beforeEach } from "bun:test";
import { ChannelRegistry } from "../src/gateway/channel.js";
import type {
  ChannelOutboundAdapter,
  ChannelInboundAdapter,
  OutboundSendResult,
  InboundMessageHandler,
} from "../src/gateway/channel-types.js";

// ---------------------------------------------------------------------------
// Mock adapters
// ---------------------------------------------------------------------------

function createMockOutbound(channelId = "test"): ChannelOutboundAdapter & { stopped: boolean; sends: any[] } {
  return {
    channelId,
    stopped: false,
    sends: [],
    isReady() { return !this.stopped; },
    async sendText(opts) {
      this.sends.push(opts);
      return { ok: true, messageId: `msg-${this.sends.length}` };
    },
    async stop() { this.stopped = true; },
  };
}

function createMockAdapter(channelId = "test"): ChannelOutboundAdapter & ChannelInboundAdapter & {
  stopped: boolean;
  started: boolean;
  sends: any[];
  handler: InboundMessageHandler | null;
} {
  return {
    channelId,
    stopped: false,
    started: false,
    sends: [],
    handler: null,
    isReady() { return this.started && !this.stopped; },
    async sendText(opts) {
      this.sends.push(opts);
      return { ok: true, messageId: `msg-${this.sends.length}` };
    },
    async start() { this.started = true; },
    onMessage(handler: InboundMessageHandler) { this.handler = handler; },
    async stop() { this.stopped = true; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelRegistry", () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  test("register and retrieve outbound adapter", () => {
    const adapter = createMockOutbound("slack");
    registry.register(adapter);
    expect(registry.getOutbound("slack")).toBe(adapter);
  });

  test("has() returns true for registered, false for unregistered", () => {
    const adapter = createMockOutbound("slack");
    registry.register(adapter);
    expect(registry.has("slack")).toBe(true);
    expect(registry.has("telegram")).toBe(false);
  });

  test("list() returns registered channel IDs", () => {
    registry.register(createMockOutbound("slack"));
    registry.register(createMockOutbound("imessage"));
    expect(registry.list().sort()).toEqual(["imessage", "slack"]);
  });

  test("getOutbound returns undefined for unregistered channel", () => {
    expect(registry.getOutbound("nonexistent")).toBeUndefined();
  });

  test("getInbound returns adapter if it supports inbound", () => {
    const adapter = createMockAdapter("slack");
    registry.register(adapter);
    expect(registry.getInbound("slack")).toBe(adapter);
  });

  test("getInbound returns undefined for outbound-only adapter", () => {
    const adapter = createMockOutbound("webhook");
    registry.register(adapter);
    expect(registry.getInbound("webhook")).toBeUndefined();
  });

  test("register replaces existing adapter with same channelId", () => {
    const first = createMockOutbound("slack");
    const second = createMockOutbound("slack");
    registry.register(first);
    registry.register(second);
    expect(registry.getOutbound("slack")).toBe(second);
  });

  test("stopAll stops all adapters and clears registry", async () => {
    const a = createMockOutbound("slack");
    const b = createMockAdapter("imessage");
    registry.register(a);
    registry.register(b);

    await registry.stopAll();

    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(registry.has("slack")).toBe(false);
  });

  test("stopAll handles adapter stop errors gracefully", async () => {
    const adapter: ChannelOutboundAdapter = {
      channelId: "bad",
      isReady() { return true; },
      async sendText() { return { ok: true }; },
      async stop() { throw new Error("stop failed"); },
    };
    registry.register(adapter);

    // Should not throw
    await registry.stopAll();
    expect(registry.list()).toEqual([]);
  });
});
