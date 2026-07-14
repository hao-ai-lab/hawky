// =============================================================================
// Gateway Startup Banner
//
// Pretty-prints resolved configuration at gateway startup.
// Two-column format: left-aligned labels, left-aligned values.
// API keys are never printed.
// =============================================================================

import type { HawkyConfig } from "../agent/types.js";
import { isLoopbackHost } from "./loopback.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface BannerParams {
  version: string;
  port: number;
  bindHost: string;
  model: string;
  config: HawkyConfig;
  configPath: string;
  logDir: string;
  cronJobCount: number;
}

// -----------------------------------------------------------------------------
// Banner
// -----------------------------------------------------------------------------

export function printGatewayBanner(params: BannerParams): void {
  const { version, port, bindHost, model, config, configPath, logDir, cronJobCount } = params;
  const hb = config.heartbeat;
  const isLoopback = isLoopbackHost(bindHost);

  // Build rows: [label, value]
  const rows: Array<[string, string]> = [];

  rows.push(["Gateway", `ws://${bindHost}:${port}`]);
  rows.push(["Health", `http://${bindHost}:${port}/health`]);
  if (!isLoopback) {
    rows.push(["Bind", `${bindHost} (network-accessible)`]);
  }
  rows.push(["Auth", "device tokens (browser-based)"]);
  rows.push(["Config", configPath]);
  rows.push(["Logs", logDir]);
  rows.push(["Model", model]);
  rows.push(["Max tokens", String(config.max_tokens)]);

  // API keys — show presence, never the value
  const hasAnthropic = !!config.api_keys.anthropic;
  const hasOpenAI = !!config.api_keys.openai;
  const hasBrave = !!config.api_keys.brave_search;
  rows.push(["API keys", [
    hasAnthropic ? "anthropic" : null,
    hasOpenAI ? "openai" : null,
    hasBrave ? "brave" : null,
  ].filter(Boolean).join(", ") || "(none)"]);

  // Heartbeat
  if (hb.enabled) {
    const hours = hb.active_hours
      ? `${hb.active_hours.start}–${hb.active_hours.end}`
      : "all day";
    rows.push(["Heartbeat", `every ${hb.interval_minutes}m (active ${hours})`]);
    if (hb.model) {
      rows.push(["  Model", hb.model]);
    }
  } else {
    rows.push(["Heartbeat", "disabled"]);
  }

  // Consolidation
  if (!hb.enabled) {
    rows.push(["Consolidation", "disabled (heartbeat off)"]);
  } else {
    rows.push(["Consolidation", "disabled (memory scheduler owns this)"]);
  }

  // Memory flush
  const flush = config.memory_flush;
  if (flush?.enabled !== false) {
    rows.push(["Memory flush", `enabled (threshold ${flush?.threshold_percent ?? 90}%)`]);
  } else {
    rows.push(["Memory flush", "disabled"]);
  }

  // Cron
  if (config.cron?.enabled !== false) {
    rows.push(["Cron", `enabled (${cronJobCount} job${cronJobCount !== 1 ? "s" : ""})`]);
  } else {
    rows.push(["Cron", "disabled"]);
  }

  // Push notifications
  if (config.notifications?.vapid_email) {
    rows.push(["Push", "enabled (Web Push)"]);
  } else {
    rows.push(["Push", "disabled (set notifications.vapid_email to enable)"]);
  }

  // Concurrency
  const conc = config.concurrency;
  const mainMax = conc?.main_max ?? 4;
  const cronMax = conc?.cron_max ?? 4;
  const subMax = conc?.subagent_max ?? 8;
  rows.push(["Concurrency", `Main=${mainMax}  Cron=${cronMax}  Subagent=${subMax}`]);

  // Compute column widths from content
  const labelWidth = Math.max(...rows.map(([l]) => l.length)) + 2;
  const totalWidth = Math.max(
    ...rows.map(([l, v]) => labelWidth + v.length),
    20, // minimum
  );

  // Print
  console.log();
  console.log(`  hawky v${version}`);
  console.log(`  ${"─".repeat(totalWidth)}`);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(labelWidth)}${value}`);
  }
  console.log(`  ${"─".repeat(totalWidth)}`);
  console.log(`  Press Ctrl+C to stop.`);
  console.log();
}
