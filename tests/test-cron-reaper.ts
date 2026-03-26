// =============================================================================
// Tests: Cron Reaper (No-Delete Policy)
//
// The reaper is now a no-op — files are never deleted.
// Sidebar visibility is controlled by session.list filtering instead.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { sweepCronOrphans } from "../src/gateway/cron-reaper.js";

describe("cron reaper (no-delete policy)", () => {
  test("returns swept=false (no-op)", () => {
    const result = sweepCronOrphans({
      store: { getJobs: () => [], getStorePath: () => "/tmp/test" } as any,
      config: { sessionDays: 7, reaperIntervalMinutes: 60 },
      sessionsDir: "/tmp/nonexistent",
      force: true,
    });

    expect(result.swept).toBe(false);
    expect(result.prunedSessions).toBe(0);
    expect(result.prunedRunLogs).toBe(0);
  });
});
