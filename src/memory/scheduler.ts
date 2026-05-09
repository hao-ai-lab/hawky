// =============================================================================
// Memory consolidation scheduler (#653)
//
// Periodically consolidates daily memory → global memory (MEMORY.md) via a
// single Haiku call — but ONLY when daily memory actually changed since the last
// successful consolidation. This is the "every 6 hours if anything changed"
// half of the memory automation (the other half is session-end distillation,
// triggered from iOS).
//
// Change detection: compares the newest mtime across memory/*.md against the
// mtime persisted after the last successful run (memory/.consolidation-state.json).
// No change → skip the LLM call entirely. This is cheap and survives restarts.
//
// Self-contained: a setInterval timer the gateway owns. Replaces the heartbeat's
// agent-loop consolidation (now disabled in config).
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HawkyConfig } from "../agent/types.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { distillMemory, latestDailyMtimeMs } from "./distill.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("memory/scheduler");

const STATE_FILE = "memory/.consolidation-state.json";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ConsolidationState {
  /** mtime (ms) of the newest daily log at the last successful consolidation. */
  lastConsolidatedMtimeMs: number;
  /** ISO timestamp of the last successful consolidation (informational). */
  lastConsolidatedAt: string;
}

export interface MemorySchedulerOptions {
  /** Resolves the live gateway config (provider/key may change after /setup). */
  getConfig: () => HawkyConfig;
  /** Override the consolidation interval (ms). Default 6h. */
  intervalMs?: number;
  /** Workspace override (tests). */
  workspace?: WorkspaceManager;
  /** Clock override (tests). */
  now?: () => number;
}

export class MemoryScheduler {
  private readonly getConfig: () => HawkyConfig;
  private readonly intervalMs: number;
  private readonly workspace: WorkspaceManager;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(opts: MemorySchedulerOptions) {
    this.getConfig = opts.getConfig;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.workspace = opts.workspace ?? new WorkspaceManager();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Start the periodic timer. First tick fires after one full interval. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        log.warn("scheduled consolidation failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    // Don't keep the process alive solely for this timer.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
    log.info("memory consolidation scheduler started", { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one consolidation check. Public so tests (and a manual RPC, later) can
   * drive it directly. Skips the LLM call when no daily log changed since the
   * last successful consolidation.
   *
   * @returns what happened, for logging/tests.
   */
  async tick(): Promise<{ ran: boolean; reason: string; file?: string }> {
    if (this.inFlight) return { ran: false, reason: "already in flight" };
    this.inFlight = true;
    try {
      const latest = latestDailyMtimeMs({ workspace: this.workspace });
      if (latest === 0) {
        return { ran: false, reason: "no daily logs" };
      }

      const state = this.readState();
      if (state && latest <= state.lastConsolidatedMtimeMs) {
        log.debug("consolidation skipped — no daily change", {
          latest,
          lastConsolidatedMtimeMs: state.lastConsolidatedMtimeMs,
        });
        return { ran: false, reason: "no change since last consolidation" };
      }

      log.info("daily memory changed — consolidating into global", {
        latest,
        since: state?.lastConsolidatedMtimeMs ?? 0,
      });

      let result;
      try {
        result = await distillMemory(
          this.getConfig(),
          { scope: "global" },
          { workspace: this.workspace },
        );
      } catch (err) {
        // e.g. provider/auth misconfig — don't advance the watermark, retry next tick.
        return { ran: false, reason: err instanceof Error ? err.message : String(err) };
      }

      if (!result.ok) {
        // e.g. no daily logs / empty model output — don't advance the watermark
        // so we retry next tick once something changes.
        return { ran: false, reason: result.note ?? "consolidation returned not-ok" };
      }

      // Record the watermark = the mtime we just consolidated up to.
      this.writeState({
        lastConsolidatedMtimeMs: latest,
        lastConsolidatedAt: new Date(this.now()).toISOString(),
      });
      return { ran: true, reason: "consolidated", file: result.file };
    } finally {
      this.inFlight = false;
    }
  }

  private statePath(): string {
    return join(this.workspace.getWorkspacePath(), STATE_FILE);
  }

  private readState(): ConsolidationState | null {
    const path = this.statePath();
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ConsolidationState;
      if (typeof parsed?.lastConsolidatedMtimeMs === "number") return parsed;
    } catch {
      // Corrupt state — treat as missing (forces a consolidation).
    }
    return null;
  }

  private writeState(state: ConsolidationState): void {
    try {
      this.workspace.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    } catch (err) {
      log.warn("failed to persist consolidation state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
