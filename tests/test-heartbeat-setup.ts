// =============================================================================
// Tests for heartbeat setup helpers (src/gateway/heartbeat-setup.ts)
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  getHeartbeatConfigStatus,
  formatHeartbeatStatus,
  type HeartbeatConfigStatus,
} from "../src/gateway/heartbeat-setup.js";
import { getDefaultConfig } from "../src/storage/config.js";

// =============================================================================
// getHeartbeatConfigStatus
// =============================================================================

describe("getHeartbeatConfigStatus", () => {
  test("extracts status from default config", () => {
    const config = getDefaultConfig();
    const status = getHeartbeatConfigStatus(config);
    expect(status.enabled).toBe(true);
    expect(status.intervalMinutes).toBe(30);
    expect(status.activeHours.start).toBe("00:00");
    expect(status.activeHours.end).toBe("23:59");
    expect(status.model).toBe("claude-sonnet-4-6");
    // #653: heartbeat consolidation defaults OFF — the memory feature owns it now.
    expect(status.consolidationEnabled).toBe(false);
  });

  test("extracts enabled heartbeat with custom settings", () => {
    const config = {
      ...getDefaultConfig(),
      heartbeat: {
        ...getDefaultConfig().heartbeat,
        enabled: true,
        interval_minutes: 15,
        model: "claude-haiku-4-5-20251001",
        active_hours: { start: "06:00", end: "20:00", timezone: "America/New_York" },
        consolidation_enabled: false,
      },
    };
    const status = getHeartbeatConfigStatus(config);
    expect(status.enabled).toBe(true);
    expect(status.intervalMinutes).toBe(15);
    expect(status.model).toBe("claude-haiku-4-5-20251001");
    expect(status.activeHours.start).toBe("06:00");
    expect(status.activeHours.timezone).toBe("America/New_York");
    expect(status.consolidationEnabled).toBe(false);
  });
});

// =============================================================================
// formatHeartbeatStatus
// =============================================================================

describe("formatHeartbeatStatus", () => {
  test("formats disabled heartbeat with defaults visible", () => {
    const status: HeartbeatConfigStatus = {
      enabled: false,
      intervalMinutes: 30,
      activeHours: { start: "08:00", end: "22:00" },
      model: null,
      consolidationEnabled: true,
    };
    const formatted = formatHeartbeatStatus(status);
    expect(formatted).toContain("disabled");
    // Defaults should still be shown even when disabled
    expect(formatted).toContain("30 minutes");
    expect(formatted).toContain("08:00");
    expect(formatted).toContain("22:00");
  });

  test("formats enabled heartbeat with all details", () => {
    const status: HeartbeatConfigStatus = {
      enabled: true,
      intervalMinutes: 15,
      activeHours: { start: "09:00", end: "21:00", timezone: "UTC" },
      model: "claude-haiku-4-5-20251001",
      consolidationEnabled: true,
    };
    const formatted = formatHeartbeatStatus(status);
    expect(formatted).toContain("enabled");
    expect(formatted).toContain("15 minutes");
    expect(formatted).toContain("09:00");
    expect(formatted).toContain("21:00");
    expect(formatted).toContain("claude-haiku");
  });

  test("shows default model when none specified", () => {
    const status: HeartbeatConfigStatus = {
      enabled: true,
      intervalMinutes: 30,
      activeHours: { start: "08:00", end: "22:00" },
      model: null,
      consolidationEnabled: true,
    };
    const formatted = formatHeartbeatStatus(status);
    expect(formatted).toContain("default");
  });
});

// =============================================================================
// /setup integration
// =============================================================================

describe("/setup includes heartbeat status", () => {
  test("setup command skillMessage contains heartbeat status", () => {
    const { executeCommand } = require("../src/tui/commands.js");
    const ctx = {
      model: "test",
      workingDirectory: process.cwd(),
      sessionId: "test",
      tokenUsage: null,
      messageCount: 0,
      previousSessionKey: null,
      setPreviousSessionKey: () => {},
      exit: () => {},
      clearMessages: () => {},
      newSession: () => {},
      flushMemory: () => {},
      triggerCompaction: () => {},
      fetchMcpStatus: () => {},
      switchModel: () => {},
      resumeSession: () => {},
      showStatusPanel: () => {},
    };

    const result = executeCommand("/setup", ctx);
    expect(result.skillMessage).toContain("heartbeat status");
    // Should include interval and hours even if disabled
    expect(result.skillMessage).toContain("minutes");
  });
});
