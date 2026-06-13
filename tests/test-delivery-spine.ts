// =============================================================================
// Test: Delivery spine (M1 gateway)
// Run: bun test tests/test-delivery-spine.ts
// Verifies: scoreDelivery, buildPushItem, deliver (with mock node)
// Per M1 subplan e2e handbook.
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import { scoreDelivery } from "../src/ambient/delivery-gate.js";
import { buildPushItem } from "../src/ambient/broker.js";
import { deliver, _resetReEmitGuard } from "../src/ambient/delivery-service.js";
import type { PushItem } from "../src/ambient/delivery.js";
import type { Intention } from "../src/ambient/intention.js";
import type { NodeInvoker } from "../src/ambient/delivery-service.js";

// =============================================================================
// scoreDelivery — v1 context-only stub
// =============================================================================

describe("scoreDelivery", () => {
  const item: PushItem = {
    id: "i1", title: "Meeting now", body: "Standup in 2 min",
    source: "intention", at: "2026-06-05T10:00:00Z",
  };

  test("always returns push:true, deliver:context", () => {
    const { decision, score } = scoreDelivery(item);
    expect(decision.push).toBe(true);
    expect(decision.deliver).toBe("context");
    expect(score).toBe(1);
  });

  test("always returns channel:silent_card", () => {
    const { channel } = scoreDelivery(item);
    expect(channel).toBe("silent_card");
  });

  test("busy policy is downgrade", () => {
    const { decision } = scoreDelivery(item);
    expect(decision.busy).toBe("downgrade");
  });

  test("with ScoreContext: still returns push:true, deliver:context", () => {
    const { decision, channel } = scoreDelivery(item, {});
    expect(decision.push).toBe(true);
    expect(decision.deliver).toBe("context");
    expect(channel).toBe("silent_card");
  });

  test("no ctx: same result as with empty ctx", () => {
    const withCtx = scoreDelivery(item, {});
    const noCtx = scoreDelivery(item);
    expect(withCtx).toEqual(noCtx);
  });

  test("hard intention → speak + queue (definitive delivery)", () => {
    const hard: PushItem = { id: "h1", title: "Take pills", body: "Take pills", source: "intention", strength: "hard" };
    const { decision, channel } = scoreDelivery(hard);
    expect(decision.push).toBe(true);
    expect(decision.deliver).toBe("speak");
    expect(decision.busy).toBe("queue");
    expect(channel).toBe("speak");
  });
});

// =============================================================================
// buildPushItem (broker)
// =============================================================================

describe("buildPushItem", () => {
  const baseIntention: Intention = {
    id: "intention-001",
    content: "Buy oat milk at the grocery store",
    trigger: { all: [{ kind: "when", at: "2026-06-05T18:00:00Z" }] },
    strength: "hard",
    origin: "obvious",
    state: "surfaced",
    evidence: { ts: "2026-06-05T10:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-05T09:00:00Z",
    updatedAt: "2026-06-05T10:00:00Z",
  };

  test("Intention → PushItem: source intention, carries intentionId and at", () => {
    const item = buildPushItem({ kind: "intention", intention: baseIntention });
    expect(item.source).toBe("intention");
    expect(item.intentionId).toBe("intention-001");
    expect(item.at).toBe("2026-06-05T18:00:00Z");
    expect(item.id).toBe("intention-001");
    expect(item.body).toBe(baseIntention.content);
    expect(item.title.length).toBeLessThanOrEqual(80);
  });

  test("hard Intention → strength:hard", () => {
    const item = buildPushItem({ kind: "intention", intention: baseIntention });
    expect(item.strength).toBe("hard");
  });

  test("soft Intention → strength:soft", () => {
    const softIntention: Intention = { ...baseIntention, id: "intention-002", strength: "soft", trigger: {} };
    const item = buildPushItem({ kind: "intention", intention: softIntention });
    expect(item.strength).toBe("soft");
    expect(item.at).toBeUndefined();
  });

  test("Intention without when trigger → at undefined", () => {
    const whereIntention: Intention = {
      ...baseIntention,
      id: "intention-003",
      trigger: { all: [{ kind: "where", place: "grocery" }] },
    };
    const item = buildPushItem({ kind: "intention", intention: whereIntention });
    expect(item.at).toBeUndefined();
  });

  test("task input → source task", () => {
    const item = buildPushItem({ kind: "task", id: "t1", title: "Review PR", body: "PR #42 needs review" });
    expect(item.source).toBe("task");
    expect(item.id).toBe("t1");
    expect(item.intentionId).toBeUndefined();
  });

  test("external input → source external, carries itemKind", () => {
    const item = buildPushItem({ kind: "external", id: "e1", title: "Calendar", body: "Meeting in 5", itemKind: "critical" });
    expect(item.source).toBe("external");
    expect(item.kind).toBe("critical");
  });

  test("long content text gets truncated title to ≤80 chars", () => {
    const longIntention: Intention = {
      ...baseIntention,
      id: "intention-long",
      content: "a".repeat(100),
    };
    const item = buildPushItem({ kind: "intention", intention: longIntention });
    expect(item.title.length).toBeLessThanOrEqual(80);
    expect(item.body.length).toBe(100);
  });
});

// =============================================================================
// scoreDelivery — latent origin → suggest channel (M8 cautious delivery)
// =============================================================================

describe("scoreDelivery latent", () => {
  const latentItem: PushItem = {
    id: "lat-1",
    title: "Maybe buy oat milk",
    body: "You mentioned grocery shopping",
    source: "intention",
    strength: "soft",
    origin: "latent",
    confidence: 0.75,
  };

  test("latent origin → deliver:speak, channel:suggest", () => {
    const { decision, channel } = scoreDelivery(latentItem);
    expect(decision.deliver).toBe("speak");
    expect(channel).toBe("suggest");
  });

  test("latent origin → push:true, busy:queue", () => {
    const { decision } = scoreDelivery(latentItem);
    expect(decision.push).toBe(true);
    expect(decision.busy).toBe("queue");
  });

  test("hard + obvious wins over latent (hard checked first)", () => {
    const hardObvious: PushItem = { ...latentItem, strength: "hard", origin: "obvious" };
    const { channel } = scoreDelivery(hardObvious);
    expect(channel).toBe("speak"); // definitive, not suggest
  });

  test("soft + obvious (not latent) → silent_card", () => {
    const softObvious: PushItem = { id: "so-1", title: "x", body: "x", source: "intention", strength: "soft", origin: "obvious" };
    const { channel } = scoreDelivery(softObvious);
    expect(channel).toBe("silent_card");
  });
});

// =============================================================================
// buildPushItem — origin + confidence propagation (M8)
// =============================================================================

describe("buildPushItem latent propagation", () => {
  const latentIntention: Intention = {
    id: "lat-int-1",
    content: "You should call your dentist",
    trigger: { all: [] },
    strength: "soft",
    origin: "latent",
    state: "surfaced",
    evidence: { ts: "2026-06-06T10:00:00Z" },
    sensitivity: "private",
    confidence: 0.72,
    createdAt: "2026-06-06T09:00:00Z",
    updatedAt: "2026-06-06T10:00:00Z",
  };

  test("latent intention → PushItem carries origin:latent", () => {
    const item = buildPushItem({ kind: "intention", intention: latentIntention });
    expect(item.origin).toBe("latent");
  });

  test("latent intention → PushItem carries confidence", () => {
    const item = buildPushItem({ kind: "intention", intention: latentIntention });
    expect(item.confidence).toBe(0.72);
  });

  test("obvious intention → origin:obvious propagated", () => {
    const obvious: Intention = { ...latentIntention, id: "obv-1", origin: "obvious", confidence: undefined };
    const item = buildPushItem({ kind: "intention", intention: obvious });
    expect(item.origin).toBe("obvious");
    expect(item.confidence).toBeUndefined();
  });
});

// =============================================================================
// scoreDelivery — mode-aware latent delivery (Fix 2)
// =============================================================================

describe("scoreDelivery mode-aware latent delivery (Fix 2)", () => {
  const latentItem: PushItem = {
    id: "lat-mode-1",
    title: "Check groceries",
    body: "You mentioned the store",
    source: "intention",
    strength: "soft",
    origin: "latent",
    confidence: 0.7,
  };

  test("latent + ambient mode → suggest channel (cautious)", () => {
    const { channel, decision } = scoreDelivery(latentItem, { mode: "ambient" });
    expect(channel).toBe("suggest");
    expect(decision.deliver).toBe("speak");
    expect(decision.busy).toBe("queue");
  });

  test("latent + directive mode → speak channel (assertive)", () => {
    const { channel, decision } = scoreDelivery(latentItem, { mode: "directive" });
    expect(channel).toBe("speak");
    expect(decision.deliver).toBe("speak");
    expect(decision.busy).toBe("queue");
  });

  test("latent + no ctx (unset mode) → suggest channel (cautious, backward compat)", () => {
    const { channel } = scoreDelivery(latentItem);
    expect(channel).toBe("suggest");
  });

  test("latent + quiet mode → suggest channel (cautious, not assertive)", () => {
    // quiet mode disables latent surfacing upstream; if it somehow reaches delivery it stays cautious
    const { channel } = scoreDelivery(latentItem, { mode: "quiet" });
    expect(channel).toBe("suggest");
  });
});

// =============================================================================
// deliver — cautious:true passed to node invoke for latent items (M8)
// =============================================================================

describe("deliver cautious flag", () => {
  beforeEach(() => {
    _resetReEmitGuard();
  });

  const latentItem: PushItem = {
    id: "lat-del-1",
    title: "Maybe call dentist",
    body: "You mentioned dental checkup",
    source: "intention",
    strength: "soft",
    origin: "latent",
    confidence: 0.75,
  };

  test("latent item → node invoke receives cautious:true", async () => {
    let capturedArgs: Record<string, unknown> = {};
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke(_nodeId, _cmd, args) { capturedArgs = args; return { ok: true, payload: {} }; },
    };
    await deliver(latentItem, {}, nodes);
    expect(capturedArgs.cautious).toBe(true);
  });

  test("hard item → node invoke receives cautious:false", async () => {
    let capturedArgs: Record<string, unknown> = {};
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke(_nodeId, _cmd, args) { capturedArgs = args; return { ok: true, payload: {} }; },
    };
    const hardItem: PushItem = { id: "h-del-1", title: "T", body: "B", source: "intention", strength: "hard", origin: "obvious" };
    await deliver(hardItem, {}, nodes);
    expect(capturedArgs.cautious).toBe(false);
  });

  test("soft obvious item → node invoke receives cautious:false", async () => {
    let capturedArgs: Record<string, unknown> = {};
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke(_nodeId, _cmd, args) { capturedArgs = args; return { ok: true, payload: {} }; },
    };
    await deliver(latentItem, {}, nodes);
    // latent → cautious:true confirmed above; here test a soft obvious
    const softObvious: PushItem = { id: "so-del-1", title: "T", body: "B", source: "intention", strength: "soft", origin: "obvious" };
    capturedArgs = {};
    await deliver(softObvious, {}, nodes);
    expect(capturedArgs.cautious).toBe(false);
  });

  test("latent item delivered as speak (not dropped)", async () => {
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke() { return { ok: true, payload: {} }; },
    };
    const result = await deliver(latentItem, {}, nodes);
    expect(result.delivered).toBe(true);
  });
});

// =============================================================================
// deliver (delivery-service)
// =============================================================================

describe("deliver", () => {
  beforeEach(() => {
    _resetReEmitGuard();
  });

  // soft item → context delivery, exercising the deliver() mechanics below
  // (node found / invoke fail / re-emit guard) independent of the speak path.
  const item: PushItem = {
    id: "d1",
    title: "Meeting",
    body: "Standup in 5",
    source: "intention",
    strength: "soft",
  };

  function makeMockNodes(voiceStatusOverride?: string): NodeInvoker {
    return {
      listConnected() {
        return [{ nodeId: "ios-1", commands: ["frontend.message", "system.info"] }];
      },
      async invoke(_nodeId, _cmd, _args) {
        const payload: Record<string, unknown> = {};
        if (voiceStatusOverride) payload.voiceStatus = voiceStatusOverride;
        return { ok: true, payload };
      },
    };
  }

  test("with mock frontend.message node → delivered:true, voiceStatus:context", async () => {
    const result = await deliver(item, {}, makeMockNodes());
    expect(result.delivered).toBe(true);
    expect(result.voiceStatus).toBe("context");
  });

  test("scoreDelivery always push:true → deliver always attempts invoke", async () => {
    let invoked = false;
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke() { invoked = true; return { ok: true, payload: {} }; },
    };
    await deliver(item, {}, nodes);
    expect(invoked).toBe(true);
  });

  test("no node → delivered:false, reason:no_frontend_node, voiceStatus:dropped", async () => {
    const noNodes: NodeInvoker = {
      listConnected() { return []; },
      async invoke() { return { ok: true }; },
    };
    const result = await deliver(item, undefined, noNodes);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no_frontend_node");
    expect(result.voiceStatus).toBe("dropped");
  });

  test("undefined nodes → delivered:false, reason:no_frontend_node", async () => {
    const result = await deliver(item, undefined, undefined);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no_frontend_node");
  });

  test("re-emit guard: context delivery does NOT trigger guard (voiceStatus:context)", async () => {
    // context path: voiceStatus is "context", not "spoken"/"waiting" → guard not set
    const first = await deliver(item, {}, makeMockNodes());
    expect(first.delivered).toBe(true);
    expect(first.voiceStatus).toBe("context");

    // second call: guard was not set, so delivers again
    const second = await deliver(item, {}, makeMockNodes());
    expect(second.delivered).toBe(true);
  });

  test("re-emit guard fires when node returns voiceStatus:spoken", async () => {
    const first = await deliver(item, {}, makeMockNodes("spoken"));
    expect(first.delivered).toBe(true);
    expect(first.voiceStatus).toBe("spoken");

    const second = await deliver(item, {}, makeMockNodes("spoken"));
    expect(second.delivered).toBe(false);
    expect(second.reason).toBe("already_spoken");
    expect(second.voiceStatus).toBe("dropped");
  });

  test("invoke failure → delivered:false with reason", async () => {
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke() { return { ok: false, error: "connection_lost" }; },
    };
    const result = await deliver(item, {}, nodes);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("connection_lost");
  });

  test("invoke throws → delivered:false, voiceStatus:dropped", async () => {
    const nodes: NodeInvoker = {
      listConnected() { return [{ nodeId: "ios-1", commands: ["frontend.message"] }]; },
      async invoke() { throw new Error("network_timeout"); },
    };
    const result = await deliver(item, {}, nodes);
    expect(result.delivered).toBe(false);
    expect(result.voiceStatus).toBe("dropped");
    expect(result.reason).toBe("network_timeout");
  });

  test("context delivery → voiceStatus:context (derived from decision)", async () => {
    // scoreDelivery always returns deliver:context → voiceStatus derived as "context"
    const result = await deliver(item, {}, makeMockNodes());
    expect(result.delivered).toBe(true);
    expect(result.voiceStatus).toBe("context");
  });
});
