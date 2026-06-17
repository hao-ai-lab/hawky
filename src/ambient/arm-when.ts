// =============================================================================
// arm-when.ts — ArmAdapter for `when` triggers using an injected scheduler.
// Schedules a one-shot callback at TriggerWhen.at; on fire calls fireIntention.
// The scheduler is injected so tests can mock it.
// =============================================================================

import type { Intention } from "./intention.js";
import { findWhenTerm } from "./intention.js";
import type { ArmAdapter, ArmResult } from "./trigger.js";

// -----------------------------------------------------------------------------
// Minimal scheduler interface (inject TimerWhenCronService or a mock)
// -----------------------------------------------------------------------------

export interface WhenCronService {
  /** Schedule a one-shot callback at the given absolute ISO timestamp. */
  scheduleAt(id: string, isoTime: string, callback: () => void): void;

  cancel(id: string): void;

  /** Cancel all pending jobs (used by IntentionService.stop()). */
  cancelAll(): void;
}

// -----------------------------------------------------------------------------
// Device-notification descriptor emitted to the device at arm time (#482)
// -----------------------------------------------------------------------------

export interface WhenNotificationDescriptor {
  intentionId: string;
  /** ISO 8601 UTC timestamp at which the on-device notification should fire. */
  fireDate: string;
  /** Short notification title (≤60 chars, derived from intention.content). */
  title: string;
  /** Notification body (same as title for hard timed reminders). */
  body: string;
}

/**
 * Injected notification callbacks for `when` intentions (#482).
 * When wired, activate() broadcasts arm metadata to the device so it can
 * schedule a local UNCalendarNotification as a durable offline fallback.
 * disarm() broadcasts a cancel so the device removes the pending request.
 */
export interface WhenAdapterDeps {
  /** Emit notification metadata to the device at arm time. */
  emitWhenArmed(sessionKey: string, descriptor: WhenNotificationDescriptor): void;
  /** Tell the device to cancel the pending local notification for this intention. */
  emitWhenDisarmed(sessionKey: string, intentionId: string): void;
}

// -----------------------------------------------------------------------------
// WhenAdapter
// -----------------------------------------------------------------------------

export class WhenAdapter implements ArmAdapter {
  readonly kind = "when" as const;

  private cron: WhenCronService;
  private onFire: (intention: Intention, firedTermKey: string) => Promise<void>;
  private readonly deps?: WhenAdapterDeps;
  // Track scheduled job ids by intention id for disarm.
  private scheduled = new Map<string, string>();
  // Track validated intentions awaiting activate() (store the `at` time).
  private prepared = new Map<string, string>();

  constructor(
    cron: WhenCronService,
    onFire: (intention: Intention, firedTermKey: string) => Promise<void>,
    deps?: WhenAdapterDeps,
  ) {
    this.cron = cron;
    this.onFire = onFire;
    this.deps = deps;
  }

  /**
   * Phase 1: Validate that the `when` term has an actionable `at` time.
   * Does NOT schedule the timer — that happens in activate().
   */
  async prepare(intention: Intention): Promise<ArmResult> {
    const whenTerm = findWhenTerm(intention.trigger);

    if (!whenTerm) {
      return { ok: false, state: "arm_failed", reason: "no_when_term" };
    }

    if (!whenTerm.at) {
      return { ok: false, state: "arm_failed", reason: "when_missing_time" };
    }

    // Stash the at-time for activate().
    this.prepared.set(intention.id, whenTerm.at);
    return { ok: true, state: "armed" };
  }

  /**
   * Phase 2: Schedule the timer. Called only after the store is "armed".
   * Invariant: timer can only fire when store state === "armed".
   * #482: also emits when.armed to the device so it can schedule a local
   * UNCalendarNotification as a durable offline fallback.
   */
  activate(intention: Intention): void {
    const at = this.prepared.get(intention.id);
    if (!at) return; // should not happen if prepare() succeeded

    this.prepared.delete(intention.id);

    // Idempotent: cancel any existing job for this intention before scheduling.
    const existingJobId = this.scheduled.get(intention.id);
    if (existingJobId) {
      this.cron.cancel(existingJobId);
      this.scheduled.delete(intention.id);
    }

    const jobId = `when:${intention.id}`;
    this.cron.scheduleAt(jobId, at, () => {
      void this.onFire(intention, "when");
    });

    this.scheduled.set(intention.id, jobId);

    // #482: push notification metadata to the device for local fallback scheduling.
    const sessionKey = intention.evidence.sessionKey;
    if (sessionKey && this.deps) {
      const title = intention.content.length > 60
        ? intention.content.slice(0, 57) + "…"
        : intention.content;
      this.deps.emitWhenArmed(sessionKey, {
        intentionId: intention.id,
        fireDate: at,
        title,
        body: title,
      });
    }
  }

  /**
   * Cancel the scheduled timer (and, by default, the device's pending local
   * notification).
   *
   * `cancelNotification` defaults to true (arm rollback, user-cancel, expiry —
   * the reminder is truly gone, so the local-notification fallback must go too).
   *
   * Pass `false` on the post-fire path: the timed reminder just fired and was
   * surfaced in-session, but we deliberately KEEP the local notification so the
   * user also gets a lock-screen/banner alert when the app is open (the in-app
   * surface is voice-only and easy to miss). The timer is already spent, so we
   * only need to clean up local bookkeeping here.
   */
  async disarm(intention: Intention, cancelNotification = true): Promise<void> {
    this.prepared.delete(intention.id);
    const jobId = this.scheduled.get(intention.id);
    if (jobId) {
      this.cron.cancel(jobId);
      this.scheduled.delete(intention.id);
    }
    // #482: tell the device to cancel the pending local notification — unless
    // this is the post-fire path, where we keep it so an open app still alerts.
    if (!cancelNotification) return;
    const sessionKey = intention.evidence.sessionKey;
    if (sessionKey && this.deps) {
      this.deps.emitWhenDisarmed(sessionKey, intention.id);
    }
  }

  /**
   * Legacy arm() for backward compatibility with tests that call it directly.
   * Equivalent to prepare() + activate() in sequence.
   */
  async arm(intention: Intention): Promise<ArmResult> {
    const result = await this.prepare(intention);
    if (result.ok) {
      this.activate(intention);
    }
    return result;
  }
}
