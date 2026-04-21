// =============================================================================
// Graceful Shutdown
//
// Orchestrated shutdown sequence for the gateway process.
// Pattern: a proven run-loop.ts + server-close.ts + Claude Code's
// gracefulShutdown.ts. Adapted for Hawky's single-user architecture.
//
// Shutdown sequence:
//   1. Stop services (heartbeat, cron) — no new background work
//   2. Drain in-flight tasks (up to DRAIN_TIMEOUT_MS)
//   3. Persist state (heartbeat state file)
//   4. Close WebSocket connections + HTTP server
//   5. Exit process
//
// Failsafe timer guarantees exit even if drain/close hangs.
// =============================================================================

import type { GatewayServer } from "./server.js";
import type { HeartbeatService } from "./heartbeat.js";
import type { CronService } from "./cron.js";
import { markGatewayDraining, waitForActiveTasks } from "./command-queue.js";
import { cancelPendingPermissions } from "./ws-permission.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/shutdown");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DRAIN_TIMEOUT_MS = 10_000;    // Wait up to 10s for in-flight work
const FAILSAFE_TIMEOUT_MS = 20_000; // Hard exit after 20s (user-configured)

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ShutdownDeps {
  gateway: GatewayServer;
  heartbeat: HeartbeatService;
  cronService: CronService;
  /** Session keys to cancel pending permissions for on shutdown. */
  getActiveSessionKeys: () => string[];
  /** Optional callback before shutdown (e.g., persist cost tracker). */
  onBeforeShutdown?: () => void | Promise<void>;
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let shutdownInProgress = false;

/** Check if shutdown is in progress (for testing). */
export function isShutdownInProgress(): boolean {
  return shutdownInProgress;
}

/** Reset shutdown state (for testing only). */
export function resetShutdownState(): void {
  shutdownInProgress = false;
}

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------

/**
 * Perform a graceful gateway shutdown.
 *
 * Safe to call multiple times — second call is a no-op (prevents double
 * shutdown from rapid Ctrl+C or SIGINT+SIGTERM race).
 *
 * @param deps - Service references needed for shutdown
 * @param exitCode - Process exit code (default 0)
 */
export async function gracefulShutdown(
  deps: ShutdownDeps,
  exitCode = 0,
): Promise<void> {
  if (shutdownInProgress) {
    log.info("shutdown already in progress, ignoring");
    return;
  }
  shutdownInProgress = true;

  const startMs = Date.now();
  log.info("graceful shutdown starting");

  // Arm failsafe timer — guarantees exit even if drain/close hangs.
  const failsafe = setTimeout(() => {
    log.warn("failsafe timeout reached, forcing exit", {
      elapsedMs: Date.now() - startMs,
      timeoutMs: FAILSAFE_TIMEOUT_MS,
    });
    process.exit(exitCode || 1);
  }, FAILSAFE_TIMEOUT_MS);
  // Don't let the failsafe timer keep the process alive if everything
  // completes normally — unref so it doesn't block natural exit.
  failsafe.unref();

  try {
    // Phase 1: Stop accepting new work + stop services
    log.info("phase 1: stopping services");
    markGatewayDraining(); // Reject new enqueues immediately
    deps.heartbeat.stop();
    deps.cronService.stop();

    // Phase 2: Drain in-flight work (API calls still add cost during drain)
    log.info("phase 2: draining in-flight tasks", { timeoutMs: DRAIN_TIMEOUT_MS });
    const { drained } = await waitForActiveTasks(DRAIN_TIMEOUT_MS);
    if (drained) {
      log.info("phase 2: all tasks drained", { elapsedMs: Date.now() - startMs });
    } else {
      log.warn("phase 2: drain timeout, some tasks still active", {
        elapsedMs: Date.now() - startMs,
      });
    }

    // Phase 2.5: Persist state AFTER drain — captures cost from in-flight API calls
    await deps.onBeforeShutdown?.();

    // Phase 3: Cancel pending permissions (unblock stuck lanes)
    log.info("phase 3: cancelling pending permissions");
    for (const sessionKey of deps.getActiveSessionKeys()) {
      cancelPendingPermissions(sessionKey);
    }

    // Phase 4: Close connections + server
    // (State persistence is automatic: CronStore saves on every mutation,
    // HeartbeatService persists lastConsolidatedAt after each consolidation.)
    log.info("phase 4: closing connections");
    // Use close code 1012 (Service Restart) so clients know it's intentional.
    // gateway.stop() handles: mark draining → close connections → stop HTTP.
    // We already drained in Phase 2, so gateway.stop(0) closes immediately.
    await deps.gateway.stop(0);

    const elapsedMs = Date.now() - startMs;
    log.info("graceful shutdown complete", { elapsedMs });
  } catch (err) {
    log.error("error during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(failsafe);
    process.exit(exitCode);
  }
}

/**
 * Install signal handlers for graceful shutdown.
 * Call once during gateway startup.
 */
export function installShutdownHandlers(deps: ShutdownDeps): void {
  const handler = (signal: string) => {
    log.info("received signal", { signal });
    console.log(`\nReceived ${signal}, shutting down...`);
    void gracefulShutdown(deps, 0);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}
