import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { deliver, setChannelRegistry, setPushService } from "../src/gateway/delivery.js";
import { ChannelRegistry } from "../src/gateway/channel.js";
import type { ChannelOutboundAdapter, OutboundSendResult } from "../src/gateway/channel-types.js";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function createMockAdapter(channelId = "slack"): ChannelOutboundAdapter & {
  ready: boolean;
  sends: any[];
  stopped: boolean;
} {
  return {
    channelId,
    ready: true,
    sends: [],
    stopped: false,
    isReady() { return this.ready; },
    async sendText(opts) {
      this.sends.push(opts);
      return { ok: true, messageId: "msg-1" };
    },
    async stop() { this.stopped = true; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delivery announce mode", () => {
  let registry: ChannelRegistry;
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    registry = new ChannelRegistry();
    adapter = createMockAdapter("slack");
    registry.register(adapter);
    setChannelRegistry(registry);
  });

  afterEach(() => {
    setChannelRegistry(null);
    setPushService(null);
  });

  test("routes to channel adapter when announce mode", () => {
    const result = deliver({
      config: { mode: "announce", channel: "slack", to: "U12345" },
      title: "Heartbeat",
      message: "Found 3 urgent emails",
    });

    expect(result.delivered).toBe(true);
    expect(result.mode).toBe("announce");
  });

  test("passes message and recipient to adapter", async () => {
    deliver({
      config: { mode: "announce", channel: "slack", to: "U12345" },
      title: "Test",
      message: "hello world",
    });

    // sendText is fire-and-forget, give it a tick
    await Bun.sleep(10);

    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0].to).toBe("U12345");
    expect(adapter.sends[0].text).toBe("hello world");
  });

  test("fails when channel is missing", () => {
    const result = deliver({
      config: { mode: "announce", to: "U12345" },
      title: "Test",
      message: "hello",
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("requires channel and to");
  });

  test("fails when to is missing", () => {
    const result = deliver({
      config: { mode: "announce", channel: "slack" },
      title: "Test",
      message: "hello",
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("requires channel and to");
  });

  test("fails when no channel registry configured", () => {
    setChannelRegistry(null);

    const result = deliver({
      config: { mode: "announce", channel: "slack", to: "U12345" },
      title: "Test",
      message: "hello",
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("no channel registry");
  });

  test("fails when adapter is not ready", () => {
    adapter.ready = false;

    const result = deliver({
      config: { mode: "announce", channel: "slack", to: "U12345" },
      title: "Test",
      message: "hello",
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("not ready");
  });

  test("fails when channel ID not registered", () => {
    const result = deliver({
      config: { mode: "announce", channel: "telegram", to: "12345" },
      title: "Test",
      message: "hello",
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("not ready");
  });

  test("adapter sendText error is non-fatal", async () => {
    const failAdapter: ChannelOutboundAdapter = {
      channelId: "failing",
      isReady() { return true; },
      async sendText() { throw new Error("network error"); },
      async stop() {},
    };
    registry.register(failAdapter);

    const result = deliver({
      config: { mode: "announce", channel: "failing", to: "U12345" },
      title: "Test",
      message: "hello",
    });

    // Should return delivered=true (fire-and-forget)
    expect(result.delivered).toBe(true);

    // Error is caught, not thrown
    await Bun.sleep(10);
  });

  // Existing modes still work

  test("none mode unchanged", () => {
    const result = deliver({
      config: { mode: "none" },
      title: "Test",
      message: "hello",
    });
    expect(result.delivered).toBe(false);
    expect(result.mode).toBe("none");
  });

  test("push mode without service returns error", () => {
    const result = deliver({
      config: { mode: "push" },
      title: "Test",
      message: "hello",
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("push not configured");
  });
});
