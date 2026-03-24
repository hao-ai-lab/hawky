// =============================================================================
// Heartbeat Setup Helpers
//
// Functions for the /setup wizard to report heartbeat config status and
// generate personalized HEARTBEAT.md content based on enabled skills.
// =============================================================================

import type { HawkyConfig } from "../agent/types.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HeartbeatConfigStatus {
  enabled: boolean;
  intervalMinutes: number;
  activeHours: { start: string; end: string; timezone?: string };
  model: string | null;
  consolidationEnabled: boolean;
}

// -----------------------------------------------------------------------------
// Config status
// -----------------------------------------------------------------------------

/**
 * Extract current heartbeat configuration status from config.
 */
export function getHeartbeatConfigStatus(config: HawkyConfig): HeartbeatConfigStatus {
  return {
    enabled: config.heartbeat.enabled,
    intervalMinutes: config.heartbeat.interval_minutes,
    activeHours: {
      start: config.heartbeat.active_hours.start,
      end: config.heartbeat.active_hours.end,
      timezone: config.heartbeat.active_hours.timezone,
    },
    model: config.heartbeat.model ?? null,
    consolidationEnabled: false,
  };
}

/**
 * Format heartbeat config status as a human-readable string.
 */
export function formatHeartbeatStatus(status: HeartbeatConfigStatus): string {
  const lines: string[] = [];

  lines.push(`Heartbeat: ${status.enabled ? "enabled" : "disabled"}`);
  lines.push(`  Interval: every ${status.intervalMinutes} minutes`);
  lines.push(`  Active hours: ${status.activeHours.start}–${status.activeHours.end} (${status.activeHours.timezone ?? "local"})`);
  lines.push(`  Model: ${status.model ?? "default (same as main model)"}`);
  lines.push(`  Memory consolidation: ${status.consolidationEnabled ? "enabled" : "disabled"}`);

  return lines.join("\n");
}
