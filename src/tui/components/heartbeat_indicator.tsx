// =============================================================================
// Heartbeat Indicator
//
// Persistent status line showing heartbeat state. Visible when idle.
// Updates via heartbeat.started / heartbeat.completed events from gateway.
// =============================================================================

import React from "react";
import { Box, Text } from "ink";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface HeartbeatInfo {
  /** Whether heartbeat is enabled in config */
  enabled?: boolean;
  /** Status of the last heartbeat run */
  lastStatus: "ran" | "skipped" | "failed" | null;
  /** Reason for the last status (e.g., "quiet-hours", "no-tasks") */
  lastReason?: string;
  /** When the last heartbeat ran (ms since epoch) */
  lastRunAt: number | null;
  /** When the next heartbeat is scheduled (ms since epoch) */
  nextRunAt: number | null;
  /** Whether a heartbeat is currently running */
  running: boolean;
  /** Number of heartbeat runs that produced actionable output */
  alertCount: number;
  /** Active hours start time (HH:MM) — shown in quiet-hours indicator */
  activeHoursStart?: string;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

function formatAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatUntil(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}

export function HeartbeatIndicator({ info }: { info: HeartbeatInfo | null }) {
  if (!info) return null;
  if (info.enabled === false) return null;

  const now = Date.now();

  if (info.running) {
    return (
      <Box>
        <Text color="yellow">♡ running...</Text>
      </Box>
    );
  }

  // Quiet hours state
  if (info.lastReason === "quiet-hours") {
    const resumeTime = info.activeHoursStart ?? "??:??";
    return (
      <Box>
        <Text color="gray">♡ quiet (resumes {resumeTime})</Text>
      </Box>
    );
  }

  if (info.lastRunAt === null) {
    // No heartbeat has run yet
    const nextIn = info.nextRunAt ? formatUntil(info.nextRunAt - now) : "?";
    return (
      <Box>
        <Text color="gray">♡ waiting (next: {nextIn})</Text>
      </Box>
    );
  }

  const ago = formatAgo(now - info.lastRunAt);
  const nextIn = info.nextRunAt ? formatUntil(info.nextRunAt - now) : "?";

  const statusIcon = info.lastStatus === "ran"
    ? "⚠"
    : info.lastStatus === "failed"
      ? "✗"
      : "✓";

  const statusColor = info.lastStatus === "ran"
    ? "yellow"
    : info.lastStatus === "failed"
      ? "red"
      : "green";

  return (
    <Box>
      <Text color={statusColor}>♡ {ago} {statusIcon}</Text>
      <Text color="gray"> next: {nextIn}</Text>
    </Box>
  );
}
