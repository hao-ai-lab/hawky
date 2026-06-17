// =============================================================================
// arm-where.ts — ArmAdapter for `where` triggers (M8, where-only v1).
//
// Emits a regions-update to the device and waits for an ack (geocode result).
// Only armable when the `where` term has a named `place`; category-only terms
// are match-only and handled by the broker, not this adapter.
//
// Constructor deps are injected so tests mock them without touching real I/O.
// =============================================================================

import type { Intention } from "./intention.js";
import { findWhereTerm } from "./intention.js";
import type { ArmAdapter, ArmResult } from "./trigger.js";
import { termKey } from "./trigger.js";

// -----------------------------------------------------------------------------
// Region descriptor emitted to the device
// -----------------------------------------------------------------------------

export interface RegionDescriptor {
  intentionId: string;
  place: string;
  /** True for hard/obvious intentions — device should post a local notification on entry. */
  isHard: boolean;
  /** Human-readable label (the place name) shown in the notification. */
  label: string;
  /**
   * The intention's content (e.g. "Buy milk"). The device shows this as the
   * notification title on region entry so the alert says what to do, not just
   * "You've arrived". Empty string if unavailable.
   */
  content: string;
}

// -----------------------------------------------------------------------------
// Injected deps
// -----------------------------------------------------------------------------

export interface WhereAdapterDeps {
  /** Emit a regions-update to the device for the given session. */
  emitRegions(sessionKey: string, regions: RegionDescriptor[]): void;

  /** Arm timeout in ms. Default 10 000. */
  timeoutMs?: number;
}

// -----------------------------------------------------------------------------
// WhereAdapter
//
// Arming protocol:
//   1. arm()        → emits regions-update to device, starts ack timer
//   2. device acks  → calls resolveAck(intentionId, {ok, reason?})
//   3. arm() resolves with the ack result (or timeout)
// -----------------------------------------------------------------------------

export class WhereAdapter implements ArmAdapter {
  readonly kind = "where" as const;

  private readonly emitRegions: WhereAdapterDeps["emitRegions"];
  private readonly timeoutMs: number;

  // Pending ack resolvers keyed by intentionId.
  private readonly pendingAcks = new Map<
    string,
    (result: { ok: boolean; reason?: string }) => void
  >();
  // Per-session set of active armed intentions: sessionKey → Map<intentionId, {place, isHard, content}>.
  private readonly armedBySession = new Map<string, Map<string, { place: string; isHard: boolean; content: string }>>();
  // Per-session set of intentions currently in prepare() (pending_arm phase).
  // Fix 3: include PENDING regions in _fullSetFor so concurrent arms don't clobber each other.
  private readonly pendingBySession = new Map<string, Map<string, { place: string; isHard: boolean; content: string }>>();
  // Fix 2: latch region.entered received while pending_arm; replay after armed.
  private readonly pendingEntries = new Map<string, () => void>();

  constructor(deps: WhereAdapterDeps) {
    this.emitRegions = deps.emitRegions;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  /**
   * Called by the `region.armed` RPC when the device completes geocoding.
   * Resolves the in-flight ack promise created by prepare(). Returns true iff a
   * live resolver was waiting — false means prepare() already settled (e.g. the
   * arm timed out and is now a deferred pending arm; the caller should use the
   * late-ack recovery path armFromLateAck() instead). See region.armed RPC (#481).
   */
  resolveAck(intentionId: string, result: { ok: boolean; reason?: string }): boolean {
    const resolve = this.pendingAcks.get(intentionId);
    if (resolve) {
      this.pendingAcks.delete(intentionId);
      resolve(result);
      return true;
    }
    return false;
  }

  /**
   * Phase 1: Emit regions-update to device and wait for ack (the slow/failable step).
   * Does NOT make the region trigger "live" — that is gated by the store reaching "armed".
   * The region.entered RPC already checks state==="armed" before firing, so an ack
   * arriving before the store transitions is safe.
   *
   * Fix 3: Register intention in pendingBySession BEFORE emitting so that concurrent
   * arms for the same session include each other's pending regions in the emitted set.
   */
  async prepare(intention: Intention): Promise<ArmResult> {
    // Find the first `where` term with a named place.
    const whereTerm = findWhereTerm(intention.trigger);
    if (!whereTerm || !whereTerm.place) {
      return { ok: false, state: "arm_failed", reason: "no_where_place_term" };
    }

    const sessionKey = intention.evidence.sessionKey;
    if (!sessionKey) {
      return { ok: false, state: "arm_failed", reason: "no_session_key" };
    }

    const place = whereTerm.place;
    const isHard = intention.strength === "hard";
    // #615: carry the intention content so the device's region-entry notification
    // can show what to do ("Buy milk"), not just "You've arrived".
    const content = intention.content;

    // Fix 3: Register in pendingBySession BEFORE emitting so sibling concurrent arms see this intention.
    let pendingMap = this.pendingBySession.get(sessionKey);
    if (!pendingMap) {
      pendingMap = new Map();
      this.pendingBySession.set(sessionKey, pendingMap);
    }
    pendingMap.set(intention.id, { place, isHard, content });

    // Register the ack resolver BEFORE emitting to avoid losing a synchronous ack.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const ack = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      this.pendingAcks.set(intention.id, (result) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        resolve(result);
      });
      // Emit region registration to the device after the resolver is in place.
      this.emitRegions(sessionKey, this._fullSetFor(sessionKey, intention.id, place, isHard, content));
      timeoutHandle = setTimeout(() => {
        // #481: delete the in-flight resolver (so resolveAck() reports "no live
        // resolver" and the RPC routes a late ack to armFromLateAck instead) but
        // KEEP the pendingBySession registration so the deferred arm is still
        // recoverable. The device may still be working on this arm — e.g. waiting
        // for the user to grant "Always" location auth, a multi-step OS prompt
        // that can't complete inside the arm timeout. We resolve the prepare()
        // promise as "deferred"; a LATE region.armed ack arms it via armFromLateAck.
        this.pendingAcks.delete(intention.id);
        timedOut = true;
        resolve({ ok: false, reason: "device_ack_timeout" });
      }, this.timeoutMs);
    });

    // #481: a device_ack_timeout is RECOVERABLE, not terminal. Keep the intention
    // registered in pendingBySession (so concurrent arms still see it and the
    // device set stays consistent) and leave the pendingAcks resolver in place so
    // a late ack arms it. Return deferred:true so the caller keeps it in pending_arm.
    if (timedOut) {
      return { ok: false, state: "arm_failed", reason: "device_ack_timeout", deferred: true };
    }

    // Resolved by an explicit ack (or disarm) — remove from pendingBySession.
    const pm = this.pendingBySession.get(sessionKey);
    if (pm) {
      pm.delete(intention.id);
      if (pm.size === 0) this.pendingBySession.delete(sessionKey);
    }

    if (!ack.ok) {
      // Emit the remaining active set (without this intention) so the device stays consistent.
      this.emitRegions(sessionKey, this._fullSetFor(sessionKey, null, "", false, ""));
      return {
        ok: false,
        state: "arm_failed",
        reason: ack.reason ?? "device_ack_failed",
      };
    }

    // Ack received: add to per-session armed set.
    let sessionMap = this.armedBySession.get(sessionKey);
    if (!sessionMap) {
      sessionMap = new Map();
      this.armedBySession.set(sessionKey, sessionMap);
    }
    sessionMap.set(intention.id, { place, isHard, content });
    return { ok: true, state: "armed" };
  }

  /**
   * #481: arm an intention that previously hit device_ack_timeout (deferred) when
   * a LATE region.armed ack finally arrives. The intention is still in
   * pendingBySession (prepare() left it there on timeout). On a positive ack we
   * promote it to armedBySession; on a negative ack we drop it and re-emit the
   * device set. Returns true iff the intention was armed.
   *
   * The store-side transition (pending_arm → armed) is done by the region.armed
   * RPC handler; this only updates the adapter's per-session bookkeeping.
   */
  armFromLateAck(intention: Intention, ack: { ok: boolean; reason?: string }): boolean {
    const sessionKey = intention.evidence.sessionKey;
    if (!sessionKey) return false;
    const pendingMap = this.pendingBySession.get(sessionKey);
    if (!pendingMap || !pendingMap.has(intention.id)) return false;
    const entry = pendingMap.get(intention.id)!;

    // Clear the stale ack resolver (prepare() already resolved on timeout).
    this.pendingAcks.delete(intention.id);

    if (!ack.ok) {
      // Device gave up (e.g. denied/restricted). Drop and re-emit without it.
      pendingMap.delete(intention.id);
      if (pendingMap.size === 0) this.pendingBySession.delete(sessionKey);
      this.emitRegions(sessionKey, this._fullSetFor(sessionKey, null, "", false, ""));
      return false;
    }

    // Promote pending → armed.
    pendingMap.delete(intention.id);
    if (pendingMap.size === 0) this.pendingBySession.delete(sessionKey);
    let sessionMap = this.armedBySession.get(sessionKey);
    if (!sessionMap) {
      sessionMap = new Map();
      this.armedBySession.set(sessionKey, sessionMap);
    }
    sessionMap.set(intention.id, { place: entry.place, isHard: entry.isHard, content: entry.content });
    return true;
  }

  /** True iff this intention is registered as a deferred (pending) arm awaiting a late ack. */
  isPendingArm(intention: Intention): boolean {
    const sessionKey = intention.evidence.sessionKey;
    if (!sessionKey) return false;
    return this.pendingBySession.get(sessionKey)?.has(intention.id) ?? false;
  }

  /**
   * Phase 2 (activate): store is now "armed". Replay any latched region.entered
   * that arrived while the intention was in pending_arm (Fix 2).
   */
  activate(intention: Intention): void {
    const replayFn = this.pendingEntries.get(intention.id);
    if (replayFn) {
      this.pendingEntries.delete(intention.id);
      // Invoke on next microtask so activate() completes first and the store
      // is fully armed before the fire path reads it.
      Promise.resolve().then(replayFn);
    }
  }

  /**
   * Latch a region.entered that arrived while the intention was in pending_arm.
   * Called by the region.entered RPC when state === "pending_arm".
   * The callback will be invoked by activate() once the store reaches "armed".
   */
  latchPendingEntry(intentionId: string, replayFn: () => void): void {
    this.pendingEntries.set(intentionId, replayFn);
  }

  /**
   * Legacy arm() for backward compatibility with tests that call it directly.
   * Equivalent to prepare() + activate() for the where adapter.
   */
  async arm(intention: Intention): Promise<ArmResult> {
    const result = await this.prepare(intention);
    if (result.ok) {
      this.activate(intention);
    }
    return result;
  }

  async disarm(intention: Intention): Promise<void> {
    const sessionKey = intention.evidence.sessionKey;
    if (!sessionKey) return;

    // Cancel any pending-entry latch.
    this.pendingEntries.delete(intention.id);

    // Resolve any outstanding ack promise so prepare() doesn't hang.
    const ackResolve = this.pendingAcks.get(intention.id);
    if (ackResolve) {
      this.pendingAcks.delete(intention.id);
      ackResolve({ ok: false, reason: "disarmed" });
    }

    // Remove from pendingBySession.
    const pendingMap = this.pendingBySession.get(sessionKey);
    const wasInPending = pendingMap?.has(intention.id) ?? false;
    if (wasInPending && pendingMap) {
      pendingMap.delete(intention.id);
      if (pendingMap.size === 0) this.pendingBySession.delete(sessionKey);
    }

    // Remove from armedBySession.
    const sessionMap = this.armedBySession.get(sessionKey);
    const wasInArmed = sessionMap?.has(intention.id) ?? false;
    if (wasInArmed && sessionMap) {
      sessionMap.delete(intention.id);
      if (sessionMap.size === 0) this.armedBySession.delete(sessionKey);
    }

    // Emit updated set if either pending or armed state changed.
    if (wasInPending || wasInArmed) {
      const remaining = this._fullSetFor(sessionKey, null, "", false, "");
      this.emitRegions(sessionKey, remaining);
    }
  }

  /**
   * Build the full set of active regions for a session.
   * Includes both armed (armedBySession) and pending (pendingBySession) intentions
   * so concurrent arms don't clobber each other (Fix 3).
   *
   * If `addId`/`addPlace`/`addIsHard`/`addContent` are provided they are merged in
   * (used during prepare() for the current intention before it's committed to
   * armedBySession). If `addId` is null, only the already-tracked sets are returned.
   */
  private _fullSetFor(
    sessionKey: string,
    addId: string | null,
    addPlace: string,
    addIsHard: boolean,
    addContent: string,
  ): RegionDescriptor[] {
    const result: RegionDescriptor[] = [];
    const seen = new Set<string>();
    const sessionMap = this.armedBySession.get(sessionKey);
    if (sessionMap) {
      for (const [intentionId, entry] of sessionMap) {
        if (!seen.has(intentionId)) {
          seen.add(intentionId);
          result.push({ intentionId, place: entry.place, isHard: entry.isHard, label: entry.place, content: entry.content });
        }
      }
    }
    // Fix 3: include pending (in-flight prepare) intentions for this session.
    const pendingMap = this.pendingBySession.get(sessionKey);
    if (pendingMap) {
      for (const [intentionId, entry] of pendingMap) {
        if (!seen.has(intentionId)) {
          seen.add(intentionId);
          result.push({ intentionId, place: entry.place, isHard: entry.isHard, label: entry.place, content: entry.content });
        }
      }
    }
    if (addId && !seen.has(addId)) {
      result.push({ intentionId: addId, place: addPlace, isHard: addIsHard, label: addPlace, content: addContent });
    }
    return result;
  }

  /** The termKey for the first armable where term (used by region.entered RPC). */
  static wherePlaceTermKey(intention: Intention): string | undefined {
    const t = findWhereTerm(intention.trigger);
    return t ? termKey(t) : undefined;
  }
}
