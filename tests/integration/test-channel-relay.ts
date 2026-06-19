// =============================================================================
// Integration Tests: Channel Relay (Full Sync)
//
// Tests the core "full sync" invariant: when a session has channel bindings,
// any assistant text relays to all bound external conversations.
//
// Exercises:
//   relayToChannels() + ChannelRegistry + SessionBindingService
//   with a mock outbound adapter (no real Slack API calls).
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { relayToChannels } from "../../src/gateway/channel-relay.js";
import { ChannelRegistry } from "../../src/gateway/channel.js";
import { SessionBindingService } from "../../src/gateway/session-binding.js";
import type {
  ChannelOutboundAdapter,
  OutboundSendResult,
} from "../../src/gateway/channel-types.js";

// -----------------------------------------------------------------------------
// Mock adapter — captures all sends, configurable behavior
// -----------------------------------------------------------------------------

interface MockAdapter extends ChannelOutboundAdapter {
  readonly sends: Array<{ to: string; text: string; threadId?: string }>;
  ready: boolean;
  sendBehavior: "ok" | "not-ok" | "throw";
  stopped: boolean;
}

function createMockAdapter(channelId: string): MockAdapter {
  const adapter: MockAdapter = {
    channelId,
    sends: [],
    ready: true,
    sendBehavior: "ok",
    stopped: false,
    isReady() { return this.ready && !this.stopped; },
    async sendText(opts) {
      this.sends.push({ to: opts.to, text: opts.text, threadId: opts.threadId });
      if (this.sendBehavior === "throw") {
        throw new Error("mock adapter throw");
      }
      if (this.sendBehavior === "not-ok") {
        return { ok: false, error: "mock adapter not-ok" };
      }
      return { ok: true, messageId: `msg-${this.sends.length}` };
    },
    async stop() { this.stopped = true; },
  };
  return adapter;
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

let registry: ChannelRegistry;
let bindings: SessionBindingService;
let slack: MockAdapter;

beforeEach(() => {
  registry = new ChannelRegistry();
  bindings = new SessionBindingService();
  slack = createMockAdapter("slack");
  registry.register(slack);
});

// -----------------------------------------------------------------------------
// Happy path — relay to bound channel
// -----------------------------------------------------------------------------

describe("relayToChannels — happy path", () => {
  test("relays to adapter when session has exact binding", async () => {
    bindings.bind("slack", "D123", "web:general");

    relayToChannels({
      sessionKey: "web:general",
      text: "hello from agent",
      registry,
      bindings,
    });

    await Bun.sleep(10); // fire-and-forget — give it a tick

    expect(slack.sends.length).toBe(1);
    expect(slack.sends[0].to).toBe("D123");
    expect(slack.sends[0].text).toBe("hello from agent");
  });

  test("relays to multiple bindings on the same session", async () => {
    bindings.bind("slack", "D123", "web:general");
    bindings.bind("slack", "D456", "web:general");

    relayToChannels({
      sessionKey: "web:general",
      text: "broadcast",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(2);
    expect(slack.sends.map(s => s.to).sort()).toEqual(["D123", "D456"]);
  });

  test("relays across multiple channel adapters", async () => {
    const imessage = createMockAdapter("imessage");
    registry.register(imessage);

    bindings.bind("slack", "D123", "web:general");
    bindings.bind("imessage", "chat-1", "web:general");

    relayToChannels({
      sessionKey: "web:general",
      text: "cross-channel",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(1);
    expect(imessage.sends.length).toBe(1);
    expect(slack.sends[0].text).toBe("cross-channel");
    expect(imessage.sends[0].text).toBe("cross-channel");
  });
});

// -----------------------------------------------------------------------------
// Filtering — no relay when conditions don't match
// -----------------------------------------------------------------------------

describe("relayToChannels — filtering", () => {
  test("does not relay when session has no bindings", async () => {
    bindings.bind("slack", "D123", "web:other");

    relayToChannels({
      sessionKey: "web:general",
      text: "should not send",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(0);
  });

  test("does not relay when text is empty", async () => {
    bindings.bind("slack", "D123", "web:general");

    relayToChannels({
      sessionKey: "web:general",
      text: "",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(0);
  });

  test("does not relay when registry is null", async () => {
    bindings.bind("slack", "D123", "web:general");

    relayToChannels({
      sessionKey: "web:general",
      text: "hi",
      registry: null,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(0);
  });

  test("does not relay when bindings is null", async () => {
    relayToChannels({
      sessionKey: "web:general",
      text: "hi",
      registry,
      bindings: null,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(0);
  });

  test("does not relay to adapters that are not ready", async () => {
    bindings.bind("slack", "D123", "web:general");
    slack.ready = false;

    relayToChannels({
      sessionKey: "web:general",
      text: "hi",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(0);
  });

  test("does not relay to wildcard bindings (outbound can't target '*')", async () => {
    bindings.bind("slack", "*", "web:general");
    // No exact bindings — only wildcard

    relayToChannels({
      sessionKey: "web:general",
      text: "should not go to *",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(0);
  });

  test("relays to exact binding but not wildcard when both exist", async () => {
    bindings.bind("slack", "*", "web:general");     // wildcard — skipped
    bindings.bind("slack", "D123", "web:general");  // exact — used

    relayToChannels({
      sessionKey: "web:general",
      text: "hi",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(1);
    expect(slack.sends[0].to).toBe("D123");
  });
});

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

describe("relayToChannels — error handling", () => {
  test("adapter throw is caught, no unhandled rejection", async () => {
    bindings.bind("slack", "D123", "web:general");
    slack.sendBehavior = "throw";

    // Should not throw
    expect(() => relayToChannels({
      sessionKey: "web:general",
      text: "will throw",
      registry,
      bindings,
    })).not.toThrow();

    await Bun.sleep(20);
    // Adapter was still called
    expect(slack.sends.length).toBe(1);
  });

  test("adapter ok:false is handled (logged, no throw)", async () => {
    bindings.bind("slack", "D123", "web:general");
    slack.sendBehavior = "not-ok";

    expect(() => relayToChannels({
      sessionKey: "web:general",
      text: "will fail",
      registry,
      bindings,
    })).not.toThrow();

    await Bun.sleep(20);
    expect(slack.sends.length).toBe(1);
  });

  test("one adapter failing does not prevent others from receiving", async () => {
    const imessage = createMockAdapter("imessage");
    registry.register(imessage);
    slack.sendBehavior = "throw";

    bindings.bind("slack", "D123", "web:general");
    bindings.bind("imessage", "chat-1", "web:general");

    relayToChannels({
      sessionKey: "web:general",
      text: "partial failure",
      registry,
      bindings,
    });

    await Bun.sleep(20);

    // Both were attempted
    expect(slack.sends.length).toBe(1);
    expect(imessage.sends.length).toBe(1);
    // iMessage succeeded despite Slack throwing
    expect(imessage.sends[0].text).toBe("partial failure");
  });
});

// -----------------------------------------------------------------------------
// Binding lifecycle — exact bindings created via resolveAndBind get targeted
// -----------------------------------------------------------------------------

describe("relayToChannels — with resolveAndBind lifecycle", () => {
  test("wildcard-only → no relay; resolveAndBind creates exact → relay works", async () => {
    // Start with wildcard only (default startup state)
    bindings.bind("slack", "*", "web:general");

    // Simulate an inbound message that triggers resolveAndBind
    // (this is what Slack adapter's onMessage handler does via index.ts)
    bindings.resolveAndBind("slack", "D_user1");

    // Now relay (e.g., heartbeat response → session → Slack)
    relayToChannels({
      sessionKey: "web:general",
      text: "reply after inbound",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(1);
    expect(slack.sends[0].to).toBe("D_user1");
    // Critically: NOT sent to "*"
    expect(slack.sends.every(s => s.to !== "*")).toBe(true);
  });

  test("same user, multiple DM conversations → relay fans out to all bindings", async () => {
    // In single-user mode (allowedUserId gate enforced in SlackAdapter),
    // all inbound conversations belong to the same person. Multiple bindings
    // can still exist (e.g., a mobile DM and a desktop DM, or a user DM plus
    // a shared group DM the user is in). Session output should reach every
    // place the single authorized user might be reading.
    bindings.bind("slack", "*", "web:general");

    bindings.resolveAndBind("slack", "D_mobile");
    bindings.resolveAndBind("slack", "D_desktop");

    relayToChannels({
      sessionKey: "web:general",
      text: "fanout",
      registry,
      bindings,
    });

    await Bun.sleep(10);

    expect(slack.sends.length).toBe(2);
    expect(slack.sends.map(s => s.to).sort()).toEqual(["D_desktop", "D_mobile"]);
  });
});
