// =============================================================================
// Structured Logger Tests
//
// Comprehensive tests for the logging module: config resolution, subsystem
// loggers, file rotation, redaction, console capture, and integration.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LogLevel,
  resolveLoggerSettings,
  isLevelEnabled,
  matchesDebugFlag,
  LEVEL_ORDER,
} from "../src/logging/config.js";
import {
  redactString,
  redactMetadata,
  maskValue,
  looksLikeSecret,
} from "../src/logging/redact.js";
import {
  RollingFileWriter,
  formatLocalDate,
  formatLocalIso,
  formatTime,
} from "../src/logging/rotation.js";
import {
  formatConsoleEntry,
  formatFileEntry,
  createSubsystemLoggerImpl,
} from "../src/logging/subsystem.js";
import type { LogEntry, LoggerState } from "../src/logging/subsystem.js";
import {
  initLogger,
  createSubsystemLogger,
  resetLogger,
  enableConsoleCapture,
  disableConsoleCapture,
  getFileWriter,
} from "../src/logging/logger.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let testDir: string;

function makeTestDir(): string {
  const dir = join(tmpdir(), `hawky-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeState(overrides?: Partial<LoggerState>): LoggerState {
  return {
    fileLevel: "info",
    consoleLevel: "info",
    debugFlags: [],
    tuiMode: false,
    transports: [],
    ...overrides,
  };
}

beforeEach(() => {
  testDir = makeTestDir();
  resetLogger();
  // Clear env vars that may leak from the user's shell
  delete process.env.HAWKY_LOG_LEVEL;
  delete process.env.HAWKY_CONSOLE_LOG_LEVEL;
  delete process.env.HAWKY_DEBUG;
});

afterEach(() => {
  resetLogger();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  // Clean up env vars
  delete process.env.HAWKY_LOG_LEVEL;
  delete process.env.HAWKY_CONSOLE_LOG_LEVEL;
  delete process.env.HAWKY_DEBUG;
});

// =============================================================================
// CONFIG
// =============================================================================

describe("config: resolveLoggerSettings", () => {
  test("returns defaults when no config or env", () => {
    const s = resolveLoggerSettings(undefined, "/tmp/logs", false);
    expect(s.level).toBe("info");
    expect(s.consoleLevel).toBe("info");
    expect(s.dir).toBe("/tmp/logs");
    expect(s.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(s.retentionDays).toBe(7);
    expect(s.debugFlags).toEqual([]);
    expect(s.tuiMode).toBe(false);
  });

  test("TUI mode defaults console level to warn", () => {
    const s = resolveLoggerSettings(undefined, "/tmp/logs", true);
    expect(s.consoleLevel).toBe("warn");
    expect(s.tuiMode).toBe(true);
  });

  test("config file overrides defaults", () => {
    const s = resolveLoggerSettings({
      level: "debug",
      consoleLevel: "error",
      dir: "/custom/logs",
      maxFileBytes: 10_000_000,
      retentionDays: 3,
    }, "/tmp/logs");
    expect(s.level).toBe("debug");
    expect(s.consoleLevel).toBe("error");
    expect(s.dir).toBe("/custom/logs");
    expect(s.maxFileBytes).toBe(10_000_000);
    expect(s.retentionDays).toBe(3);
  });

  test("env var HAWKY_LOG_LEVEL overrides config", () => {
    process.env.HAWKY_LOG_LEVEL = "trace";
    const s = resolveLoggerSettings({ level: "warn" }, "/tmp/logs");
    expect(s.level).toBe("trace");
    // Console level should also be updated when file level is overridden
    expect(s.consoleLevel).toBe("trace");
  });

  test("env var HAWKY_CONSOLE_LOG_LEVEL overrides independently", () => {
    process.env.HAWKY_LOG_LEVEL = "debug";
    process.env.HAWKY_CONSOLE_LOG_LEVEL = "error";
    const s = resolveLoggerSettings(undefined, "/tmp/logs");
    expect(s.level).toBe("debug");
    expect(s.consoleLevel).toBe("error");
  });

  test("env var HAWKY_DEBUG sets debug flags", () => {
    process.env.HAWKY_DEBUG = "gateway/*, agent/loop";
    const s = resolveLoggerSettings(undefined, "/tmp/logs");
    expect(s.debugFlags).toEqual(["gateway/*", "agent/loop"]);
  });

  test("invalid level in env var is ignored", () => {
    process.env.HAWKY_LOG_LEVEL = "banana";
    const s = resolveLoggerSettings(undefined, "/tmp/logs");
    expect(s.level).toBe("info"); // default
  });

  test("invalid level in config is ignored", () => {
    const s = resolveLoggerSettings({ level: "banana" }, "/tmp/logs");
    expect(s.level).toBe("info");
  });

  test("negative or zero values for maxFileBytes/retentionDays are ignored", () => {
    const s = resolveLoggerSettings({
      maxFileBytes: -1,
      retentionDays: 0,
    }, "/tmp/logs");
    expect(s.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(s.retentionDays).toBe(7);
  });

  test("empty default dir uses empty string", () => {
    const s = resolveLoggerSettings();
    expect(s.dir).toBe("");
  });
});

describe("config: isLevelEnabled", () => {
  test("level ordering is correct", () => {
    expect(LEVEL_ORDER.silent).toBeLessThan(LEVEL_ORDER.fatal);
    expect(LEVEL_ORDER.fatal).toBeLessThan(LEVEL_ORDER.error);
    expect(LEVEL_ORDER.error).toBeLessThan(LEVEL_ORDER.warn);
    expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.info);
    expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.debug);
    expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.trace);
  });

  test("error is enabled at info level", () => {
    expect(isLevelEnabled("error", "info")).toBe(true);
  });

  test("debug is not enabled at info level", () => {
    expect(isLevelEnabled("debug", "info")).toBe(false);
  });

  test("all levels enabled at trace", () => {
    const levels: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];
    for (const l of levels) {
      expect(isLevelEnabled(l, "trace")).toBe(true);
    }
  });

  test("nothing enabled at silent", () => {
    const levels: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];
    for (const l of levels) {
      expect(isLevelEnabled(l, "silent")).toBe(false);
    }
  });
});

describe("config: matchesDebugFlag", () => {
  test("empty flags matches nothing", () => {
    expect(matchesDebugFlag("gateway/ws", [])).toBe(false);
  });

  test("wildcard matches everything", () => {
    expect(matchesDebugFlag("gateway/ws", ["*"])).toBe(true);
    expect(matchesDebugFlag("agent/loop", ["*"])).toBe(true);
  });

  test("exact match", () => {
    expect(matchesDebugFlag("gateway/ws", ["gateway/ws"])).toBe(true);
    expect(matchesDebugFlag("gateway/ws", ["gateway/boot"])).toBe(false);
  });

  test("glob pattern: gateway/* matches gateway subsystems", () => {
    expect(matchesDebugFlag("gateway/ws", ["gateway/*"])).toBe(true);
    expect(matchesDebugFlag("gateway/boot", ["gateway/*"])).toBe(true);
    expect(matchesDebugFlag("gateway", ["gateway/*"])).toBe(true);
    expect(matchesDebugFlag("agent/loop", ["gateway/*"])).toBe(false);
  });

  test("multiple flags — any match works", () => {
    expect(matchesDebugFlag("agent/loop", ["gateway/*", "agent/loop"])).toBe(true);
  });
});

// =============================================================================
// REDACTION
// =============================================================================

describe("redaction: maskValue", () => {
  test("short values masked as ***", () => {
    expect(maskValue("short")).toBe("***");
    expect(maskValue("12345678901")).toBe("***"); // 11 chars
  });

  test("longer values show first 4 and last 4", () => {
    expect(maskValue("1234567890ab")).toBe("1234...90ab");
    expect(maskValue("sk-ant-api03-longkey")).toBe("sk-a...gkey");
  });
});

describe("redaction: looksLikeSecret", () => {
  test("detects Anthropic API keys", () => {
    expect(looksLikeSecret("sk-ant-api03-5wW6SBRKzTZwfeSo8qA8KeX")).toBe(true);
  });

  test("detects GitHub tokens", () => {
    expect(looksLikeSecret("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe(true);
  });

  test("detects Slack tokens", () => {
    expect(looksLikeSecret("xoxb-123456-abcdef")).toBe(true);
  });

  test("does not flag normal strings", () => {
    expect(looksLikeSecret("hello world")).toBe(false);
    expect(looksLikeSecret("12345")).toBe(false);
    expect(looksLikeSecret("model-name")).toBe(false);
  });
});

describe("redaction: redactString", () => {
  test("redacts env var assignments", () => {
    const input = "API_KEY=sk-ant-api03-verylongsecretkey123";
    const result = redactString(input);
    expect(result).not.toContain("verylongsecretkey");
    expect(result).toContain("API_KEY=");
  });

  test("redacts JSON key-value pairs", () => {
    const input = '{"apiKey": "sk-ant-verylongsecretkey123456"}';
    const result = redactString(input);
    expect(result).not.toContain("verylongsecretkey");
  });

  test("leaves normal strings unchanged", () => {
    const input = "Starting server on port 4242";
    expect(redactString(input)).toBe(input);
  });
});

describe("redaction: redactMetadata", () => {
  test("redacts sensitive key names", () => {
    const meta = { apiKey: "sk-abc123456789", name: "test" };
    const result = redactMetadata(meta);
    // 14 chars — masked as first4...last4
    expect(result.apiKey).toBe("sk-a...6789");
    expect(result.name).toBe("test");
  });

  test("redacts short sensitive values as ***", () => {
    const meta = { token: "short", password: "12345" };
    const result = redactMetadata(meta);
    expect(result.token).toBe("***");
    expect(result.password).toBe("***");
  });

  test("redacts secret-looking values regardless of key name", () => {
    const meta = { value: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" };
    const result = redactMetadata(meta);
    expect(result.value).not.toContain("ABCDEFGHIJKLMNOPQRST");
  });

  test("preserves non-string values", () => {
    const meta = { count: 42, enabled: true, tags: ["a", "b"] };
    const result = redactMetadata(meta);
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
    expect(result.tags).toEqual(["a", "b"]);
  });
});

// =============================================================================
// ROTATION
// =============================================================================

describe("rotation: formatLocalDate", () => {
  test("formats date as YYYY-MM-DD", () => {
    const result = formatLocalDate(new Date(2026, 2, 22)); // March 22
    expect(result).toBe("2026-03-22");
  });

  test("pads single-digit months and days", () => {
    const result = formatLocalDate(new Date(2026, 0, 5)); // Jan 5
    expect(result).toBe("2026-01-05");
  });
});

describe("rotation: formatLocalIso", () => {
  test("produces valid ISO-like timestamp with offset", () => {
    const result = formatLocalIso(new Date(2026, 2, 22, 14, 30, 45, 123));
    expect(result).toMatch(/^2026-03-22T14:30:45\.123[+-]\d{2}:\d{2}$/);
  });
});

describe("rotation: formatTime", () => {
  test("formats as HH:MM:SS", () => {
    const result = formatTime(new Date(2026, 2, 22, 9, 5, 3));
    expect(result).toBe("09:05:03");
  });
});

describe("rotation: RollingFileWriter", () => {
  test("creates log directory and writes to file", () => {
    const logDir = join(testDir, "logs");
    const writer = new RollingFileWriter(logDir, 50 * 1024 * 1024, 7);
    const written = writer.write('{"msg":"hello"}');
    expect(written).toBe(true);
    expect(existsSync(logDir)).toBe(true);

    const path = writer.getCurrentPath();
    expect(path).toContain("hawky-");
    expect(path).toContain(".log");
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("hello");
  });

  test("enforces size cap", () => {
    const logDir = join(testDir, "logs-cap");
    const writer = new RollingFileWriter(logDir, 200, 7); // 200 byte cap

    // Write lines until cap is hit
    let count = 0;
    while (writer.write(`{"line":${count}}`) && count < 100) {
      count++;
    }
    // Should have written some lines but not 100
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);

    // Further writes should return false
    expect(writer.write('{"msg":"over cap"}')).toBe(false);

    // File should contain the cap warning
    const content = readFileSync(writer.getCurrentPath(), "utf-8");
    expect(content).toContain("size cap reached");
  });

  test("prunes old log files on init", () => {
    const logDir = join(testDir, "logs-prune");
    mkdirSync(logDir, { recursive: true });

    // Create a "very old" log file (simulate by naming it with an old date)
    const oldFile = join(logDir, "hawky-2020-01-01.log");
    writeFileSync(oldFile, "old log data", "utf-8");
    // Set its mtime to the past
    const oldTime = new Date("2020-01-01").getTime() / 1000;
    const { utimesSync } = require("node:fs");
    utimesSync(oldFile, oldTime, oldTime);

    // Create writer — should prune the old file
    const writer = new RollingFileWriter(logDir, 50 * 1024 * 1024, 7);
    writer.write('{"msg":"new"}');

    expect(existsSync(oldFile)).toBe(false);
  });

  test("preserves recent log files", () => {
    const logDir = join(testDir, "logs-keep");
    mkdirSync(logDir, { recursive: true });

    // Create a "recent" log file (today)
    const recentFile = join(logDir, `hawky-${formatLocalDate()}.log`);
    writeFileSync(recentFile, "recent data\n", "utf-8");

    const writer = new RollingFileWriter(logDir, 50 * 1024 * 1024, 7);
    writer.write('{"msg":"append"}');

    expect(existsSync(recentFile)).toBe(true);
    const content = readFileSync(recentFile, "utf-8");
    expect(content).toContain("recent data");
    expect(content).toContain("append");
  });

  test("no-op when dir is empty string", () => {
    const writer = new RollingFileWriter("", 50 * 1024 * 1024, 7);
    expect(writer.write('{"msg":"noop"}')).toBe(false);
  });
});

// =============================================================================
// SUBSYSTEM LOGGER
// =============================================================================

describe("subsystem: formatFileEntry", () => {
  test("produces valid JSON with required fields", () => {
    const entry: LogEntry = {
      ts: "2026-03-22T14:30:45.123-07:00",
      level: "info",
      sub: "gateway/ws",
      msg: "connected",
    };
    const line = formatFileEntry(entry);
    const parsed = JSON.parse(line);
    expect(parsed.ts).toBe(entry.ts);
    expect(parsed.level).toBe("info");
    expect(parsed.sub).toBe("gateway/ws");
    expect(parsed.msg).toBe("connected");
  });

  test("includes metadata as top-level fields", () => {
    const entry: LogEntry = {
      ts: "2026-03-22T14:30:45.123-07:00",
      level: "info",
      sub: "agent/loop",
      msg: "iteration done",
      meta: { toolCount: 3, model: "claude-sonnet-4-6" },
    };
    const parsed = JSON.parse(formatFileEntry(entry));
    expect(parsed.toolCount).toBe(3);
    expect(parsed.model).toBe("claude-sonnet-4-6");
  });
});

describe("subsystem: formatConsoleEntry", () => {
  test("includes time, level label, subsystem, and message", () => {
    const entry: LogEntry = {
      ts: formatLocalIso(new Date(2026, 2, 22, 14, 30, 45)),
      level: "info",
      sub: "gateway/ws",
      msg: "client connected",
    };
    const output = formatConsoleEntry(entry);
    expect(output).toContain("14:30:45");
    expect(output).toContain("INF");
    expect(output).toContain("[gateway/ws]");
    expect(output).toContain("client connected");
  });

  test("redacts secrets in message", () => {
    const entry: LogEntry = {
      ts: formatLocalIso(),
      level: "info",
      sub: "app",
      msg: 'Loading API_KEY=sk-ant-api03-verylongsecretkey',
    };
    const output = formatConsoleEntry(entry);
    expect(output).not.toContain("verylongsecretkey");
  });

  test("redacts secrets in metadata", () => {
    const entry: LogEntry = {
      ts: formatLocalIso(),
      level: "info",
      sub: "app",
      msg: "config loaded",
      meta: { apiKey: "sk-ant-api03-verylongsecretkey" },
    };
    const output = formatConsoleEntry(entry);
    expect(output).not.toContain("verylongsecretkey");
  });
});

describe("subsystem: createSubsystemLoggerImpl", () => {
  test("logs at enabled levels", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      transports: [(e) => entries.push(e)],
    });
    const log = createSubsystemLoggerImpl("test", state);
    log.info("hello");
    log.error("oops");
    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe("info");
    expect(entries[1].level).toBe("error");
  });

  test("does not log below threshold", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      fileLevel: "warn",
      consoleLevel: "warn",
      transports: [(e) => entries.push(e)],
    });
    const log = createSubsystemLoggerImpl("test", state);
    log.debug("ignored");
    log.info("also ignored");
    log.warn("captured");
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("warn");
  });

  test("debug flags enable debug for specific subsystems", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      fileLevel: "info",
      consoleLevel: "info",
      debugFlags: ["gateway/*"],
      transports: [(e) => entries.push(e)],
    });
    const gwLog = createSubsystemLoggerImpl("gateway/ws", state);
    const agentLog = createSubsystemLoggerImpl("agent/loop", state);

    gwLog.debug("gateway debug visible");
    agentLog.debug("agent debug hidden");

    expect(entries).toHaveLength(1);
    expect(entries[0].sub).toBe("gateway/ws");
  });

  test("child logger creates nested subsystem name", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      transports: [(e) => entries.push(e)],
    });
    const parent = createSubsystemLoggerImpl("gateway", state);
    const child = parent.child("ws");
    child.info("from child");
    expect(entries[0].sub).toBe("gateway/ws");
  });

  test("isEnabled reflects current state", () => {
    const state = makeState({ fileLevel: "warn", consoleLevel: "warn" });
    const log = createSubsystemLoggerImpl("test", state);
    expect(log.isEnabled("error")).toBe(true);
    expect(log.isEnabled("info")).toBe(false);
    expect(log.isEnabled("debug")).toBe(false);
  });

  test("metadata is included in log entries", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      transports: [(e) => entries.push(e)],
    });
    const log = createSubsystemLoggerImpl("test", state);
    log.info("with meta", { count: 42, name: "foo" });
    expect(entries[0].meta).toEqual({ count: 42, name: "foo" });
  });

  test("empty metadata is omitted", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      transports: [(e) => entries.push(e)],
    });
    const log = createSubsystemLoggerImpl("test", state);
    log.info("no meta", {});
    expect(entries[0].meta).toBeUndefined();
  });

  test("transport errors are swallowed", () => {
    const state = makeState({
      transports: [() => { throw new Error("transport boom"); }],
    });
    const log = createSubsystemLoggerImpl("test", state);
    // Should not throw
    expect(() => log.info("should not throw")).not.toThrow();
  });

  test("all log levels work", () => {
    const entries: LogEntry[] = [];
    const state = makeState({
      fileLevel: "trace",
      consoleLevel: "trace",
      transports: [(e) => entries.push(e)],
    });
    const log = createSubsystemLoggerImpl("test", state);
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    log.fatal("f");
    expect(entries.map((e) => e.level)).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
  });
});

// =============================================================================
// CORE LOGGER
// =============================================================================

describe("logger: initLogger + createSubsystemLogger", () => {
  test("creates logger that writes to file", () => {
    const logDir = join(testDir, "init-test");
    initLogger(resolveLoggerSettings(undefined, logDir));
    const log = createSubsystemLogger("test/init");
    log.info("file write test");

    const writer = getFileWriter();
    expect(writer).not.toBeNull();
    const path = writer!.getCurrentPath();
    expect(existsSync(path)).toBe(true);

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("file write test");
    expect(content).toContain("test/init");

    // Verify it's valid JSON Lines
    const lines = content.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("createSubsystemLogger works before initLogger (lazy init)", () => {
    const log = createSubsystemLogger("early");
    // Should not throw — just logs nothing until init
    expect(() => log.info("before init")).not.toThrow();
  });

  test("loggers created before init start working after init", () => {
    const log = createSubsystemLogger("pre-init");
    // No transports yet — this is fine
    log.info("lost message");

    // Now init with file transport
    const logDir = join(testDir, "post-init");
    initLogger(resolveLoggerSettings(undefined, logDir));

    // Now messages should be captured
    log.info("captured message");
    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    expect(content).toContain("captured message");
    expect(content).not.toContain("lost message"); // pre-init messages are dropped
  });

  test("TUI mode suppresses console transport", () => {
    const logDir = join(testDir, "tui-mode");
    const settings = resolveLoggerSettings(undefined, logDir, true);
    expect(settings.tuiMode).toBe(true);
    initLogger(settings);

    // File should still work
    const log = createSubsystemLogger("tui");
    log.info("tui message");
    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    expect(content).toContain("tui message");
  });

  test("reinitializing updates settings", () => {
    const logDir = join(testDir, "reinit");
    initLogger(resolveLoggerSettings({ level: "warn" }, logDir));
    const log = createSubsystemLogger("reinit");

    // Write an error first to ensure the file is created
    log.error("error appears");
    log.info("should not appear");
    const writer1 = getFileWriter();
    let content = readFileSync(writer1!.getCurrentPath(), "utf-8");
    expect(content).toContain("error appears");
    expect(content).not.toContain("should not appear");

    // Reinit with lower threshold
    initLogger(resolveLoggerSettings({ level: "debug" }, logDir));
    log.info("should appear now");
    const writer2 = getFileWriter();
    content = readFileSync(writer2!.getCurrentPath(), "utf-8");
    expect(content).toContain("should appear now");
  });
});

describe("logger: console capture", () => {
  test("captures console.log and routes through logger", () => {
    const logDir = join(testDir, "capture");
    initLogger(resolveLoggerSettings(undefined, logDir, false));
    enableConsoleCapture();

    // console.log should now route through logger
    console.log("captured by logger");

    disableConsoleCapture();

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    expect(content).toContain("captured by logger");
    expect(content).toContain('"sub":"console"');
  });

  test("captures console.error at error level", () => {
    const logDir = join(testDir, "capture-err");
    initLogger(resolveLoggerSettings(undefined, logDir, false));
    enableConsoleCapture();

    console.error("error message");

    disableConsoleCapture();

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    expect(content).toContain("error message");
    expect(content).toContain('"level":"error"');
  });

  test("disableConsoleCapture restores originals", () => {
    const originalLog = console.log;
    enableConsoleCapture();
    expect(console.log).not.toBe(originalLog);
    disableConsoleCapture();
    expect(console.log).toBe(originalLog);
  });

  test("double enable is idempotent", () => {
    enableConsoleCapture();
    enableConsoleCapture(); // Should not double-wrap
    disableConsoleCapture();
    // If double-wrapped, this would leave one layer patched
    // Test passes if console.log is restored
  });
});

// =============================================================================
// INTEGRATION
// =============================================================================

describe("integration: full pipeline", () => {
  test("subsystem logger writes JSON Lines to rotating file", () => {
    const logDir = join(testDir, "integration");
    initLogger(resolveLoggerSettings({ level: "debug" }, logDir));

    const gwLog = createSubsystemLogger("gateway/ws");
    const agentLog = createSubsystemLogger("agent/loop");

    gwLog.info("client connected", { clientId: "abc123" });
    agentLog.debug("iteration start", { iteration: 1 });
    agentLog.warn("slow tool", { tool: "bash", ms: 5000 });

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    expect(lines).toHaveLength(3);
    expect(lines[0].sub).toBe("gateway/ws");
    expect(lines[0].clientId).toBe("abc123");
    expect(lines[1].sub).toBe("agent/loop");
    expect(lines[1].iteration).toBe(1);
    expect(lines[2].level).toBe("warn");
    expect(lines[2].tool).toBe("bash");
  });

  test("debug flags selectively enable debug logging", () => {
    process.env.HAWKY_DEBUG = "gateway/*";
    const logDir = join(testDir, "flags");
    initLogger(resolveLoggerSettings(undefined, logDir));

    const gwLog = createSubsystemLogger("gateway/ws");
    const agentLog = createSubsystemLogger("agent/loop");

    gwLog.debug("gateway debug — should appear");
    agentLog.debug("agent debug — should NOT appear");
    agentLog.info("agent info — should appear");

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    expect(content).toContain("gateway debug");
    expect(content).not.toContain("agent debug");
    expect(content).toContain("agent info");
  });

  test("file logs contain no ANSI escape codes", () => {
    const logDir = join(testDir, "no-ansi");
    initLogger(resolveLoggerSettings(undefined, logDir));
    const log = createSubsystemLogger("test");
    log.info("plain message");

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    expect(content).not.toContain("\x1b[");
  });

  test("timestamps are in local ISO format with timezone", () => {
    const logDir = join(testDir, "timestamps");
    initLogger(resolveLoggerSettings(undefined, logDir));
    const log = createSubsystemLogger("test");
    log.info("timestamp test");

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    const entry = JSON.parse(content.trim());
    // Should match: YYYY-MM-DDTHH:MM:SS.mmm+HH:MM or -HH:MM
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  test("secrets are NOT redacted in file logs", () => {
    const logDir = join(testDir, "file-secrets");
    initLogger(resolveLoggerSettings(undefined, logDir));
    const log = createSubsystemLogger("test");
    log.info("key loaded", { apiKey: "sk-ant-api03-verylongsecretkey" });

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    // File logs preserve secrets for debugging
    expect(content).toContain("verylongsecretkey");
  });

  test("multiple subsystem loggers share the same file", () => {
    const logDir = join(testDir, "shared-file");
    initLogger(resolveLoggerSettings(undefined, logDir));

    const log1 = createSubsystemLogger("sub1");
    const log2 = createSubsystemLogger("sub2");
    const log3 = createSubsystemLogger("sub3");

    log1.info("from sub1");
    log2.info("from sub2");
    log3.info("from sub3");

    const writer = getFileWriter();
    const content = readFileSync(writer!.getCurrentPath(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).sub)).toEqual(["sub1", "sub2", "sub3"]);
  });
});
