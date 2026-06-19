// =============================================================================
// LatentHeartbeatService
//
// Timer-driven loop that calls LatentService.tick() on a fixed interval.
// Mirrors the structure of src/gateway/heartbeat.ts's HeartbeatService:
//   - intervalTimer field, stopped flag, inFlight guard (like distillationInFlight)
//   - status object (lastRunAt / nextRunAt / running)
//   - start() / stop() / armInterval() / executeTick() shape
//   - createSubsystemLogger("ambient/latent-heartbeat")
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { LatentService } from "./latent-service.js";

const log = createSubsystemLogger("ambient/latent-heartbeat");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface LatentHeartbeatStatus {
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  running: boolean;
}

// -----------------------------------------------------------------------------
// LatentHeartbeatService
// -----------------------------------------------------------------------------

export class LatentHeartbeatService {
  private readonly latentService: LatentService;
  private readonly intervalMs: number;
  private readonly enabled: boolean;

  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Prevents overlapping ticks when a recognition pass outlasts the interval. */
  private inFlight = false;

  private status: LatentHeartbeatStatus;

  constructor(opts: {
    latentService: LatentService;
    intervalMs?: number;
    enabled?: boolean;
  }) {
    this.latentService = opts.latentService;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.enabled = opts.enabled ?? true;

    this.status = {
      enabled: this.enabled,
      lastRunAt: null,
      nextRunAt: null,
      running: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the latent heartbeat timer. First tick fires after one full interval.
   * Mirrors HeartbeatService.start().
   */
  start(): void {
    if (!this.enabled) {
      log.info("latent heartbeat disabled");
      return;
    }

    this.stopped = false;
    this.armInterval();
    log.info("latent heartbeat started", { intervalMs: this.intervalMs });
  }

  /**
   * Stop the latent heartbeat timer.
   * Mirrors HeartbeatService.stop().
   */
  stop(): void {
    this.stopped = true;
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    // Do NOT reset inFlight here — an in-flight tick's own finally owns it
    // (mirrors HeartbeatService, which resets distillationInFlight only in the
    // async phase's finally). Clearing it on stop() could let a later start()+tick
    // overlap the still-running tick. The `stopped` guard prevents new runs anyway.
    this.status.nextRunAt = null;
    log.info("latent heartbeat stopped");
  }

  /**
   * Get current status snapshot (copy, not reference).
   * Mirrors HeartbeatService.getStatus().
   */
  getStatus(): LatentHeartbeatStatus {
    return { ...this.status };
  }

  /**
   * Test seam: await a single tick execution immediately.
   */
  async executeTickNow(): Promise<void> {
    await this.executeTick();
  }

  // ---------------------------------------------------------------------------
  // Internal: Timer
  // ---------------------------------------------------------------------------

  private armInterval(): void {
    // Clear any existing timer before re-arming so a double start() can't leak
    // an untracked interval (mirrors HeartbeatService.armInterval()).
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.status.nextRunAt = Date.now() + this.intervalMs;
    this.intervalTimer = setInterval(() => {
      // Update nextRunAt at the start of each scheduled callback (mirrors
      // HeartbeatService) so status tracks the real scheduler, not tick duration.
      this.status.nextRunAt = Date.now() + this.intervalMs;
      void this.executeTick();
    }, this.intervalMs);
    this.intervalTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Internal: Tick execution
  // ---------------------------------------------------------------------------

  private async executeTick(): Promise<void> {
    // Lifecycle guard: never run after stop(). A timer callback (or a manual
    // executeTick) may already be queued when stop() lands; the reference
    // HeartbeatService checks `stopped` before executing for the same reason.
    if (this.stopped) {
      return;
    }
    // Mirror the distillationInFlight guard in HeartbeatService:
    // don't overlap ticks if a recognition pass outlasts the interval.
    if (this.inFlight) {
      log.debug("skip: previous latent tick still running");
      return;
    }

    this.inFlight = true;
    this.status.running = true;

    try {
      await this.latentService.tick();
      this.status.lastRunAt = Date.now();
    } catch (e) {
      log.warn("latent heartbeat tick failed (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.inFlight = false;
      this.status.running = false;
      // nextRunAt is owned by the interval callback (armInterval), not the tick
      // duration — leave it alone here (mirrors HeartbeatService).
    }
  }
}
