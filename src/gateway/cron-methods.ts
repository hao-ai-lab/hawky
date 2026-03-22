// =============================================================================
// Cron RPC Method Handlers
//
// RPC methods for cron job management:
//   cron.status  — scheduler status
//   cron.list    — list jobs
//   cron.add     — create job
//   cron.update  — update job (enabled, schedule, payload, etc.)
//   cron.remove  — delete job
//   cron.run     — force-run job
//   cron.history — run history for a job
// =============================================================================

import type { GatewayServer } from "./server.js";
import type { CronService } from "./cron.js";
import { MethodError } from "./methods.js";

// -----------------------------------------------------------------------------
// Register cron methods
// -----------------------------------------------------------------------------

export function registerCronMethods(
  server: GatewayServer,
  cron: CronService,
): void {
  server.registerMethod("cron.status", () => {
    return cron.getStatus();
  });

  server.registerMethod("cron.list", (_conn, params) => {
    const p = params as { includeDisabled?: boolean } | undefined;
    return { jobs: cron.listJobs(p?.includeDisabled) };
  });

  server.registerMethod("cron.add", (_conn, params) => {
    const p = params as any;
    if (!p?.name || !p?.schedule || !p?.payload?.message) {
      throw new MethodError("INVALID_REQUEST", "name, schedule, and payload.message are required");
    }
    // Strip delivery_target from incoming params before forwarding. Older
    // agent templates and TUI clients may still send the field; persisting
    // it would just write dead state into jobs.json (nothing reads it
    // anymore). Matches the cron tool's behaviour in src/tools/cron.ts.
    const { delivery_target: _droppedDeliveryTarget, ...sanitized } = p;
    const job = cron.addJob(sanitized);
    return { job };
  });

  server.registerMethod("cron.update", (_conn, params) => {
    const p = params as { jobId?: string; [key: string]: unknown } | undefined;
    if (!p?.jobId) {
      throw new MethodError("INVALID_REQUEST", "jobId is required");
    }

    // Build validated patch — only allow known fields with correct types
    const patch: Record<string, unknown> = {};
    if (p.name !== undefined) {
      if (typeof p.name !== "string" || !p.name.trim()) {
        throw new MethodError("INVALID_REQUEST", "name must be a non-empty string");
      }
      patch.name = p.name.trim();
    }
    if (p.enabled !== undefined) {
      patch.enabled = !!p.enabled;
    }
    // delivery_target is intentionally dropped: even if a TUI / older web
    // client sends it on cron.update, we silently ignore the field rather
    // than persisting state that nothing will read. The schema field stays
    // on CronJob for back-compat reads of older jobs.json files. Track
    // whether the input contained a deprecated-only field so the empty-
    // patch guard below can recognise "valid call, just nothing left to
    // apply" and return a no-op success instead of a hard error — Codex
    // caught that legacy callers sending only delivery_target hit the
    // INVALID_REQUEST path.
    const sawLegacyOnlyField = p.delivery_target !== undefined;
    if (p.heartbeatBridge !== undefined) {
      patch.heartbeatBridge = !!p.heartbeatBridge;
    }
    if (p.payload !== undefined) {
      const pl = p.payload as Record<string, unknown>;
      if (pl.message !== undefined && typeof pl.message !== "string") {
        throw new MethodError("INVALID_REQUEST", "payload.message must be a string");
      }
      patch.payload = pl;
    }

    if (Object.keys(patch).length === 0) {
      // No supported fields supplied. If the caller sent only deprecated-
      // and-stripped fields (delivery_target today), succeed as a no-op
      // and return the unchanged job. That preserves back-compat for
      // older clients without persisting dead state. Otherwise this is
      // a real "no fields" error and we throw.
      if (sawLegacyOnlyField) {
        const job = cron.getJob(p.jobId);
        if (!job) {
          throw new MethodError("NOT_FOUND", `Job not found: ${p.jobId}`);
        }
        return { job };
      }
      throw new MethodError("INVALID_REQUEST", "No valid fields to update");
    }

    const updated = cron.updateJob(p.jobId, patch);
    if (!updated) {
      throw new MethodError("NOT_FOUND", `Job not found: ${p.jobId}`);
    }
    return { job: updated };
  });

  server.registerMethod("cron.remove", (_conn, params) => {
    const p = params as { jobId?: string } | undefined;
    if (!p?.jobId) {
      throw new MethodError("INVALID_REQUEST", "jobId is required");
    }
    const removed = cron.removeJob(p.jobId);
    if (!removed) {
      throw new MethodError("NOT_FOUND", `Job not found: ${p.jobId}`);
    }
    return { removed: true };
  });

  server.registerMethod("cron.run", async (_conn, params) => {
    const p = params as { jobId?: string } | undefined;
    if (!p?.jobId) {
      throw new MethodError("INVALID_REQUEST", "jobId is required");
    }
    await cron.forceRun(p.jobId);
    return { triggered: true };
  });

  server.registerMethod("cron.history", (_conn, params) => {
    const p = params as { jobId?: string; limit?: number } | undefined;
    if (!p?.jobId) {
      throw new MethodError("INVALID_REQUEST", "jobId is required");
    }
    const runs = cron.getRunHistory(p.jobId, p?.limit ?? 20);
    return { runs };
  });
}
