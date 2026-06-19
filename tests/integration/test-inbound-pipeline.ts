// =============================================================================
// Integration Tests: Inbound Message Pipeline
//
// Tests the inbound flow wired together in index.ts:
//   SlackAdapter.onMessage → resolveAndBind → debouncer.push → onFlush →
//   sessionBindings.resolve → trigger work in bound session
//
// Does NOT connect to real Slack — uses the debouncer + binding directly
// with synthetic InboundMessage values, verifying the contract.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { SessionBindingService } from "../../src/gateway/session-binding.js";
import { createInboundDebouncer } from "../../src/gateway/inbound-debounce.js";
import type { InboundMessage } from "../../src/gateway/channel-types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeMsg(opts: {
  conversationId: string;
  senderId: string;
  text: string;
}): InboundMessage {
  return {
    channelId: "slack",
    conversationId: opts.conversationId,
    senderId: opts.senderId,
    text: opts.text,
    timestamp: Date.now(),
  };
}

// -----------------------------------------------------------------------------
// Tests — mirror the exact wiring in index.ts onMessage handler
// -----------------------------------------------------------------------------

let bindings: SessionBindingService;
let flushedBatches: InboundMessage[][];

beforeEach(() => {
  bindings = new SessionBindingService();
  flushedBatches = [];
});

describe("inbound pipeline — single user", () => {
  test("first message from a user promotes wildcard to exact binding", async () => {
    bindings.bind("slack", "*", "web:general");

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: 30,
      buildKey: (m) => `${m.senderId}:${m.conversationId}`,
      onFlush: async (msgs) => { flushedBatches.push(msgs); },
    });

    // Simulate the Slack adapter's onMessage handler (from index.ts)
    const onMessage = (msg: InboundMessage) => {
      bindings.resolveAndBind(msg.channelId, msg.conversationId);
      debouncer.push(msg);
    };

    onMessage(makeMsg({ conversationId: "D_user1", senderId: "U1", text: "hello" }));

    // Before flush, the exact binding should already exist (resolveAndBind is sync)
    const boundConversations = bindings.listBySession("web:general");
    expect(boundConversations.length).toBe(1);
    expect(boundConversations[0].conversationId).toBe("D_user1");

    await debouncer.stop();
  });

  test("rapid messages coalesce into one batch with exact binding preserved", async () => {
    bindings.bind("slack", "*", "web:general");

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: 50,
      buildKey: (m) => `${m.senderId}:${m.conversationId}`,
      onFlush: async (msgs) => { flushedBatches.push(msgs); },
    });

    const onMessage = (msg: InboundMessage) => {
      bindings.resolveAndBind(msg.channelId, msg.conversationId);
      debouncer.push(msg);
    };

    onMessage(makeMsg({ conversationId: "D_user1", senderId: "U1", text: "hey" }));
    onMessage(makeMsg({ conversationId: "D_user1", senderId: "U1", text: "can you" }));
    onMessage(makeMsg({ conversationId: "D_user1", senderId: "U1", text: "check emails" }));

    await Bun.sleep(80);

    expect(flushedBatches.length).toBe(1);
    expect(flushedBatches[0].length).toBe(3);
    expect(flushedBatches[0].map(m => m.text)).toEqual(["hey", "can you", "check emails"]);

    // Exact binding should still exist (single entry, not duplicated)
    const boundConversations = bindings.listBySession("web:general");
    expect(boundConversations.length).toBe(1);

    await debouncer.stop();
  });

  test("debouncer onFlush can resolve session from any message in batch", async () => {
    bindings.bind("slack", "*", "web:general");

    let resolvedSessionKey: string | undefined;

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: 30,
      buildKey: (m) => `${m.senderId}:${m.conversationId}`,
      onFlush: async (msgs) => {
        const first = msgs[0];
        resolvedSessionKey = bindings.resolve(first.channelId, first.conversationId);
        flushedBatches.push(msgs);
      },
    });

    const onMessage = (msg: InboundMessage) => {
      bindings.resolveAndBind(msg.channelId, msg.conversationId);
      debouncer.push(msg);
    };

    onMessage(makeMsg({ conversationId: "D_user1", senderId: "U1", text: "hi" }));

    await Bun.sleep(50);

    expect(resolvedSessionKey).toBe("web:general");

    await debouncer.stop();
  });
});

describe("inbound pipeline — multiple users", () => {
  test("different users on different conversations flush into separate batches", async () => {
    bindings.bind("slack", "*", "web:general");

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: 30,
      buildKey: (m) => `${m.senderId}:${m.conversationId}`,
      onFlush: async (msgs) => { flushedBatches.push(msgs); },
    });

    const onMessage = (msg: InboundMessage) => {
      bindings.resolveAndBind(msg.channelId, msg.conversationId);
      debouncer.push(msg);
    };

    onMessage(makeMsg({ conversationId: "D_user1", senderId: "U1", text: "from user 1" }));
    onMessage(makeMsg({ conversationId: "D_user2", senderId: "U2", text: "from user 2" }));

    await Bun.sleep(60);

    // Two separate batches (one per user)
    expect(flushedBatches.length).toBe(2);
    expect(flushedBatches[0].length).toBe(1);
    expect(flushedBatches[1].length).toBe(1);

    // Both conversations now have exact bindings
    const boundConversations = bindings.listBySession("web:general");
    expect(boundConversations.length).toBe(2);
    expect(boundConversations.map(b => b.conversationId).sort()).toEqual(["D_user1", "D_user2"]);

    await debouncer.stop();
  });

  test("same user in different conversations are separate debounce groups", async () => {
    bindings.bind("slack", "*", "web:general");

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: 30,
      buildKey: (m) => `${m.senderId}:${m.conversationId}`,
      onFlush: async (msgs) => { flushedBatches.push(msgs); },
    });

    const onMessage = (msg: InboundMessage) => {
      bindings.resolveAndBind(msg.channelId, msg.conversationId);
      debouncer.push(msg);
    };

    // Same user U1 messages in two different DM channels (unusual but possible)
    onMessage(makeMsg({ conversationId: "D_A", senderId: "U1", text: "in A" }));
    onMessage(makeMsg({ conversationId: "D_B", senderId: "U1", text: "in B" }));

    await Bun.sleep(60);

    expect(flushedBatches.length).toBe(2);

    await debouncer.stop();
  });
});

describe("inbound pipeline — no wildcard binding", () => {
  test("messages from unbound conversations are debounced but resolve to nothing", async () => {
    // No wildcard, no exact bindings
    let resolvedSessionKey: string | undefined = "unset";

    const debouncer = createInboundDebouncer<InboundMessage>({
      debounceMs: 30,
      buildKey: (m) => `${m.senderId}:${m.conversationId}`,
      onFlush: async (msgs) => {
        const first = msgs[0];
        resolvedSessionKey = bindings.resolve(first.channelId, first.conversationId);
        flushedBatches.push(msgs);
      },
    });

    const onMessage = (msg: InboundMessage) => {
      bindings.resolveAndBind(msg.channelId, msg.conversationId);
      debouncer.push(msg);
    };

    onMessage(makeMsg({ conversationId: "D_unknown", senderId: "U1", text: "hi" }));

    await Bun.sleep(50);

    expect(flushedBatches.length).toBe(1);
    expect(resolvedSessionKey).toBeUndefined();
    // No exact bindings created since wildcard never existed
    expect(bindings.listAll().length).toBe(0);

    await debouncer.stop();
  });
});
