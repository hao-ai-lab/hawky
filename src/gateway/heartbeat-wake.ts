// =============================================================================
// Heartbeat Wake Scheduler
//
// Coalescing scheduler for heartbeat execution. Heartbeat bypasses command
// lanes entirely — it calls the agent directly. But before running, it checks
// if the Main lane is busy. If busy, it skips and retries.
//
// Pattern: a proven heartbeat-wake.ts + heartbeat-runner.ts check logic.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import { getQueueSize } from "./command-queue.js";
import { CommandLane, WakePriority } from "./types.js";
import type { WakeRequest, WakeResult, WakeHandler } from "./types.js";

const log = createSubsystemLogger("gateway/heartbeat");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1000;

// -----------------------------------------------------------------------------
// Heartbeat Wake
// -----------------------------------------------------------------------------

export class HeartbeatWake {
  private handler: WakeHandler;
  private pending: WakeRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  /**
   * @param handler - Called when heartbeat should execute. Bypasses command lanes.
   *                  Should check HEARTBEAT.md, call the agent, handle HEARTBEAT_OK.
   */
  constructor(handler: WakeHandler) {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Request a heartbeat execution. Multiple requests within the coalescing
   * window are merged — only the highest-priority one executes.
   */
  requestNow(opts?: {
    reason?: string;
    priority?: WakePriority;
    coalesceMs?: number;
  }): void {
    if (this.stopped) return;

    const priority = opts?.priority ?? WakePriority.Default;
    const coalesceMs = opts?.coalesceMs ?? DEFAULT_COALESCE_MS;

    // Coalesce: keep highest priority request
    if (this.pending === null || priority > this.pending.priority) {
      this.pending = {
        reason: opts?.reason,
        priority,
        queuedAt: Date.now(),
      };
    }

    this.schedule(coalesceMs);
  }

  /**
   * Stop the heartbeat wake scheduler. Cancels pending timers.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  /**
   * Check if the scheduler is currently executing a heartbeat.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if there's a pending (coalescing) wake request.
   */
  hasPending(): boolean {
    return this.pending !== null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    // Don't re-schedule if already scheduled
    if (this.timer !== null) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, delayMs);
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.running) return;

    const request = this.pending;
    this.pending = null;

    if (!request) return;

    // Check if Main lane is busy — if so, skip and retry
    const mainQueueSize = getQueueSize(CommandLane.Main);
    if (mainQueueSize > 0) {
      log.debug("skipped — main lane busy", { queueSize: mainQueueSize });
      // Re-queue for retry
      this.pending = {
        reason: "retry",
        priority: WakePriority.Retry,
        queuedAt: Date.now(),
      };
      this.schedule(DEFAULT_RETRY_MS);
      return;
    }

    // Execute heartbeat directly (bypasses lanes)
    this.running = true;
    try {
      const result = await this.handler();
      if (result.status === "skipped") {
        log.debug("handler skipped", { reason: result.reason });
      }
    } catch (err) {
      log.error("heartbeat execution failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }
}
