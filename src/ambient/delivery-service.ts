// =============================================================================
// Delivery Service — gate → push via frontend.message node → log.
//
// Ported from C1a src/gateway/realtime-surface.ts (pushSurfaceToFrontend,
// push-log, re-emit guard), adapted to M0 PushItem / DeliveryDecision.
//
// The node-invoke function is injected so this module is unit-testable with a
// mock — no direct NodeRegistry import required.
// =============================================================================

import { scoreDelivery } from "./delivery-gate.js";
import type { ScoreContext } from "./delivery-gate.js";
import type { PushItem, VoiceStatus } from "./delivery.js";

// -----------------------------------------------------------------------------
// Node invoke abstraction (injected for testability)
// -----------------------------------------------------------------------------

export interface NodeInvokeResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/**
 * Minimal NodeRegistry surface required by deliver().
 * In production, pass the real NodeRegistry; in tests, pass a mock.
 */
export interface NodeInvoker {
  listConnected(): Array<{ nodeId: string; commands: string[] }>;
  invoke(
    nodeId: string,
    command: string,
    args: Record<string, unknown>,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<NodeInvokeResult>;
}

// -----------------------------------------------------------------------------
// Delivery result
// -----------------------------------------------------------------------------

export interface DeliverResult {
  delivered: boolean;
  voiceStatus: VoiceStatus;
  reason?: string;
}

// -----------------------------------------------------------------------------
// Re-emit guard (in-process; per-service-instance)
// -----------------------------------------------------------------------------

/** Items that have already been spoken (or are waiting to be spoken). */
const alreadySpoken = new Set<string>();

/** Exported for test teardown. */
export function _resetReEmitGuard(): void {
  alreadySpoken.clear();
}

// -----------------------------------------------------------------------------
// deliver
// -----------------------------------------------------------------------------

/**
 * Score the item, find the frontend.message node, push it, and record status.
 *
 * @param item  - the PushItem to deliver
 * @param ctx   - delivery context (optional; v1 gate is context-only, unused)
 * @param nodes - injected node invoker (pass NodeRegistry in prod; mock in tests)
 * @param signal - optional AbortSignal
 */
export async function deliver(
  item: PushItem,
  ctx: ScoreContext | undefined,
  nodes: NodeInvoker | undefined,
  signal?: AbortSignal,
): Promise<DeliverResult> {
  // Re-emit guard: skip if already spoken/waiting
  if (alreadySpoken.has(item.id)) {
    return { delivered: false, voiceStatus: "dropped", reason: "already_spoken" };
  }

  // Score
  const { decision, channel } = scoreDelivery(item, ctx);

  if (!decision.push) {
    return { delivered: false, voiceStatus: "dropped", reason: "gate_suppressed" };
  }

  // Resolve frontend node
  if (!nodes) {
    return { delivered: false, voiceStatus: "dropped", reason: "no_frontend_node" };
  }

  const frontendNode = nodes
    .listConnected()
    .find((n) => n.commands.includes("frontend.message"));

  if (!frontendNode) {
    return { delivered: false, voiceStatus: "dropped", reason: "no_frontend_node" };
  }

  // Invoke
  let result: NodeInvokeResult;
  try {
    result = await nodes.invoke(
      frontendNode.nodeId,
      "frontend.message",
      {
        id: item.id,
        intentionId: item.intentionId,
        title: item.title,
        body: item.body,
        deliver: decision.deliver,
        busy: decision.busy,
        channel,
        cautious: channel === "suggest",
      },
      undefined,
      signal,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { delivered: false, voiceStatus: "dropped", reason };
  }

  if (!result.ok) {
    return {
      delivered: false,
      voiceStatus: "dropped",
      reason: result.error ?? "invoke_failed",
    };
  }

  // Map returned payload → VoiceStatus; derive from decision when absent.
  const payload = result.payload as Record<string, unknown> | undefined;
  const raw = typeof payload?.voiceStatus === "string" ? payload.voiceStatus : undefined;
  let voiceStatus: VoiceStatus;
  if (raw === "spoken" || raw === "waiting" || raw === "context" || raw === "dropped") {
    voiceStatus = raw;
  } else if (decision.deliver === "speak") {
    voiceStatus = decision.busy === "queue" ? "waiting" : "spoken";
  } else {
    voiceStatus = "context";
  }

  // Push-log: record if spoken/waiting so re-emit guard works
  if (voiceStatus === "spoken" || voiceStatus === "waiting") {
    alreadySpoken.add(item.id);
  }

  return { delivered: true, voiceStatus };
}
