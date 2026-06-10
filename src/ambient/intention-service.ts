// =============================================================================
// intention-service.ts — obvious-timed-intention service.
//
// Owns the obvious-timed-intention lifecycle for the live gateway. NOT a polling
// loop: timed intentions are armed once and fire via one-shot scheduler callbacks.
//   realtime create_intention({content, when})  → intention.create RPC
//     → handleCreateIntention → buildObviousIntention (resolve + precision gate)
//     → store.create (hard/obvious) → armIntention(when)  [WhenAdapter schedules timer]
//
//   WhenAdapter fires callback at `at` time → handleFire → fireIntention → deliver
//     → NodeInvoker adapter → broadcast("agent.intention_surface") into the session
//
//   On no_frontend_node: re-schedules a retry via whenCron (never-drop guarantee).
//   The only periodic work is a slow prune of terminal intentions (tick(), default 30s).
//
// Standalone + dependency-injected (broadcast/hasSession/clock/whenCron) so it is
// unit testable without the real gateway. In-memory by design (intentions are lost
// on gateway restart — durable store is future work).
// =============================================================================

import type { Intention } from "./intention.js";
import { InMemoryIntentionStore, type IntentionStore } from "./intention-store.js";
import { buildObviousIntention, type CreateIntentionArgs } from "./create-intention.js";
import { armIntention } from "./arming.js";
import { fireIntention } from "./fire.js";
import { WhenAdapter } from "./arm-when.js";
import type { WhenCronService, WhenAdapterDeps } from "./arm-when.js";
import { TimerWhenCronService } from "./when-cron.js";
import { WhereAdapter } from "./arm-where.js";
import type { WhereAdapterDeps } from "./arm-where.js";
import type { ArmAdapter } from "./trigger.js";
import type { NodeInvoker } from "./delivery-service.js";
import { makeSessionInvoker, INTENTION_SURFACE_EVENT } from "./session-delivery.js";

/** Log once at this many failed delivery attempts (stays armed, never dropped). */
export const MAX_DELIVER_ATTEMPTS = 60;

/** Re-exported from session-delivery (iOS bridge stream listens for this `agent.` event). */
export { INTENTION_SURFACE_EVENT };

/** Default retry delay (ms) when no live session is available for delivery. */
const DEFAULT_RETRY_MS = 5_000;

/** Default prune-only tick interval (ms). */
const DEFAULT_PRUNE_MS = 30_000;

export interface IntentionServiceDeps {
  /** server.broadcastToSession bound; returns the number of live connections that received the event. */
  broadcast: (sessionKey: string, event: string, payload: unknown) => number;
  /** True if any live connection is bound to sessionKey. */
  hasSession: (sessionKey: string) => boolean;
  /** Intention store (defaults to a fresh InMemoryIntentionStore). */
  store?: IntentionStore;
  /** Clock (defaults to Date.now); injectable for tests. */
  now?: () => number;
  /** Prune-only tick interval ms (defaults to 30000). */
  tickMs?: number;
  /** One-shot cron service for when-intentions (defaults to new TimerWhenCronService()). */
  whenCron?: WhenCronService;
  /** Retry delay ms when delivery fails due to no_frontend_node (defaults to 5000). */
  retryMs?: number;
  /** Structured logger for the drop warning (defaults to console.warn). */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Where-adapter deps (M8). If absent, where-arming is unavailable (arms fail).
   * Provide emitRegions + waitForAck to enable device-gated region arming.
   */
  whereDeps?: WhereAdapterDeps;
  /**
   * When-adapter notification deps (#482). If absent, no local notification
   * fallback is scheduled on the device for hard timed intentions.
   */
  whenDeps?: WhenAdapterDeps;
}

export class IntentionService {
  readonly store: IntentionStore;
  private readonly broadcast: IntentionServiceDeps["broadcast"];
  private readonly hasSession: IntentionServiceDeps["hasSession"];
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly whenCron: WhenCronService;
  private readonly retryMs: number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  private readonly adapters: Map<string, ArmAdapter>;
  private readonly _attempts = new Map<string, number>();
  private _ticking = false;
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: IntentionServiceDeps) {
    this.store = deps.store ?? new InMemoryIntentionStore();
    this.broadcast = deps.broadcast;
    this.hasSession = deps.hasSession;
    this.now = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? DEFAULT_PRUNE_MS;
    this.whenCron = deps.whenCron ?? new TimerWhenCronService();
    this.retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
    this.log = deps.log ?? ((m, meta) => console.warn(m, meta ?? {}));

    const whenAdapter = new WhenAdapter(this.whenCron, (i, k) => this.handleFire(i, k), deps.whenDeps);
    this.adapters = new Map<string, ArmAdapter>([["when", whenAdapter]]);
    if (deps.whereDeps) {
      this.adapters.set("where", new WhereAdapter(deps.whereDeps));
    }
  }

  /**
   * `intention.create` RPC handler: build a hard/obvious Intention from the
   * realtime model's explicit slots ({ content, when }), enforce the precision
   * gate, then store + arm. This is the sole obvious-timed-intention write path
   * (the former priority:"timed" free-text string-parse path has been retired).
   * On an under-specified `when`, returns needsClarification so the model asks
   * the user one question instead of storing a guess.
   */
  async handleCreateIntention(
    args: CreateIntentionArgs,
    sessionKey: string,
    tz?: string,
  ): Promise<
    | { ok: true; intentionId: string; state: string }
    | { ok: false; needsClarification: true; ask: string; reason: string }
  > {
    const built = buildObviousIntention(args, { now: this.now(), timezone: tz });
    if (!built.ok) {
      return { ok: false, needsClarification: true, ask: built.ask, reason: built.reason };
    }
    const intention = await this.store.create({
      content: built.request.content,
      trigger: built.request.trigger,
      strength: "hard",
      origin: "obvious",
      evidence: { ...built.request.evidence, sessionKey },
      sensitivity: built.request.sensitivity ?? "private",
    });
    const state = await armIntention(intention, this.adapters, this.store);
    if (state === "arm_failed") {
      // Transition the stored intention to arm_failed so it's not left stale in pending_arm.
      try {
        await this.store.transition(intention.id, "arm_failed");
      } catch {
        // Already transitioned (race); ignore.
      }
    }
    // #481: a "deferred" where arm hit the device ack timeout but is RECOVERABLE
    // (the device is still working on it — e.g. awaiting "Always" location auth).
    // Leave the intention in pending_arm so a late region.armed ack can still arm
    // it, and report pending_arm to the realtime model (NOT arm_failed) so it tells
    // the user the reminder is being set up rather than that it failed.
    if (state === "deferred") {
      return { ok: true, intentionId: intention.id, state: "pending_arm" };
    }
    return { ok: true, intentionId: intention.id, state };
  }

  /**
   * Fix 8: disarm where-regions when a where-intention reaches any terminal state.
   * Called after resolved/suppressed/superseded/arm_failed transitions so stale
   * regions are removed from the device.
   */
  private async _disarmWhere(intention: Intention): Promise<void> {
    const whereAdapter = this.adapters.get("where");
    if (whereAdapter) {
      await whereAdapter.disarm(intention);
    }
  }

  /**
   * Cancel the when-timer after a fire. We KEEP the device local notification
   * (cancelNotification=false) so an open app still gets a lock-screen/banner
   * alert in addition to the voice-only in-session surface — the in-app alert
   * is easy to miss, so the system notification is intentionally redundant.
   * The timer itself is already spent; this only cleans up bookkeeping.
   */
  private async _disarmWhen(intention: Intention): Promise<void> {
    const whenAdapter = this.adapters.get("when");
    if (whenAdapter instanceof WhenAdapter) {
      await whenAdapter.disarm(intention, false);
    } else if (whenAdapter) {
      await whenAdapter.disarm(intention);
    }
  }

  /**
   * Fire handler: called by WhenAdapter when the scheduled timer fires.
   * Also called by retry scheduling on repeated no_frontend_node failures.
   * Never drops a hard/obvious obligation — re-schedules retry on no_frontend_node.
   */
  async handleFire(intention: Intention, termKind: string): Promise<void> {
    const sessionKey = intention.evidence.sessionKey;
    const result = await fireIntention(intention, termKind, {
      store: this.store,
      nodes: this.invokerFor(sessionKey),
      scoreCtx: undefined,
      // Fix 8: disarm where-regions on surfaced.
      // #482: also cancel the device local notification when delivered in-session.
      disarmFn: async (i) => {
        await this._disarmWhere(i);
        await this._disarmWhen(i);
      },
    });
    if (!result.delivered && result.reason === "no_frontend_node") {
      // A hard/obvious obligation must NOT be dropped just because the session
      // is briefly disconnected — keep it armed and retry. Log once at the
      // threshold to surface a persistently undeliverable item without spamming.
      const n = (this._attempts.get(intention.id) ?? 0) + 1;
      this._attempts.set(intention.id, n);
      if (n === MAX_DELIVER_ATTEMPTS) {
        this.log("ambient intention delivery deferred: no live session yet (kept armed)", {
          intentionId: intention.id,
          sessionKey,
          attempts: n,
        });
      }
      // Re-schedule a retry — never drop.
      const retryId = `retry:${intention.id}`;
      const retryAt = new Date(this.now() + this.retryMs).toISOString();
      this.whenCron.scheduleAt(retryId, retryAt, () => void this.handleFire(intention, termKind));
    } else {
      // Delivered, or a non-retryable failure (not_armed / kind_not_in_trigger /
      // conjunction_incomplete / in_flight). Clear the attempt counter.
      this._attempts.delete(intention.id);
    }
  }

  /**
   * Prune-only tick: removes terminal intentions from the in-memory store to
   * bound memory growth. Re-entrancy guarded. No firing logic here.
   */
  async tick(): Promise<void> {
    if (this._ticking) return;
    this._ticking = true;
    try {
      // Bound in-memory growth: drop terminal intentions from prior ticks.
      // (Firing moved off the tick to the one-shot WhenAdapter in M5; this tick
      // is prune-only. "suppressed" added by M6's latent lifecycle.)
      await this.store.prune?.(["superseded", "resolved", "suppressed"]);
    } finally {
      this._ticking = false;
    }
  }

  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => void this.tick(), this.tickMs);
    // Don't keep the process alive solely for the prune timer.
    (this._timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    // Cancel all pending one-shot and retry timers so no callback fires after stop.
    this.whenCron.cancelAll();
  }

  /**
   * Public accessor for the NodeInvoker (used by gateway RPCs like region.entered).
   * Returns a NodeInvoker bound to the given sessionKey.
   */
  nodeInvokerFor(sessionKey: string | undefined): NodeInvoker {
    return this.invokerFor(sessionKey);
  }

  /**
   * Returns the registered ArmAdapter for the given kind, or undefined if absent.
   * Used by gateway RPCs (e.g. region.armed resolves the WhereAdapter ack).
   */
  getAdapter(kind: string): ArmAdapter | undefined {
    return this.adapters.get(kind);
  }

  /**
   * A NodeInvoker that adapts the M1 delivery spine onto the realtime session:
   * advertises a synthetic `frontend.message` node iff the session is connected,
   * and turns deliver()'s invoke into a `agent.intention_surface` broadcast.
   */
  private invokerFor(sessionKey: string | undefined): NodeInvoker {
    return makeSessionInvoker(sessionKey, {
      broadcast: this.broadcast,
      hasSession: this.hasSession,
      event: INTENTION_SURFACE_EVENT,
    });
  }
}
