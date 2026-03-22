// =============================================================================
// Cron Session Reaper — No-Delete Policy
//
// Previously deleted orphaned session and run log files. Now a no-op —
// files are never deleted. Sidebar visibility is controlled by session.list
// filtering instead. Kept as a stub for the CronService lifecycle.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { CronStore } from "./cron-store.js";

const log = createSubsystemLogger("gateway/cron-reaper");

export interface ReaperConfig {
  sessionDays: number;
  reaperIntervalMinutes: number;
}

export interface ReaperResult {
  swept: boolean;
  prunedSessions: number;
  prunedRunLogs: number;
}

/**
 * No-op reaper — files are never deleted (storage is cheap).
 * Sidebar visibility is controlled by session.list filtering.
 */
export function sweepCronOrphans(_opts: {
  store: CronStore;
  config: ReaperConfig;
  sessionsDir: string;
  force?: boolean;
}): ReaperResult {
  return { swept: false, prunedSessions: 0, prunedRunLogs: 0 };
}
