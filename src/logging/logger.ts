// =============================================================================
// Core Logger
//
// Central logger with dual transports (file + console). All subsystem loggers
// share the same state and transports. Console capture routes stray console.*
// calls through the logger to prevent TUI corruption.
//
// Pattern: a proven logger architecture, no external deps.
// =============================================================================

import { isLevelEnabled, matchesDebugFlag } from "./config.js";
import type { LogLevel, LoggerSettings } from "./config.js";
import { onLogEntry } from "./error-buffer.js";
import { RollingFileWriter } from "./rotation.js";
import { formatConsoleEntry, formatFileEntry } from "./subsystem.js";
import type { LogEntry, LoggerState, SubsystemLogger } from "./subsystem.js";
import { createSubsystemLoggerImpl } from "./subsystem.js";

// -----------------------------------------------------------------------------
// Global logger state
// -----------------------------------------------------------------------------

let globalState: LoggerState | null = null;
let fileWriter: RollingFileWriter | null = null;
let consolePatched = false;
let originalConsole: {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
} | null = null;

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

/**
 * Initialize the global logger. Must be called once at startup.
 * Safe to call multiple times — subsequent calls update settings.
 */
export function initLogger(settings: LoggerSettings): void {
  // Create file writer (if dir is set)
  if (settings.dir) {
    fileWriter = new RollingFileWriter(settings.dir, settings.maxFileBytes, settings.retentionDays);
  }

  // Build transports
  const transports: ((entry: LogEntry) => void)[] = [];

  // File transport — always active (no redaction)
  // Debug-flagged subsystems bypass file level threshold.
  if (fileWriter) {
    const writer = fileWriter; // Capture for closure
    const flags = settings.debugFlags;
    transports.push((entry: LogEntry) => {
      const levelOk = isLevelEnabled(entry.level, settings.level);
      const flagOk = matchesDebugFlag(entry.sub, flags);
      if (levelOk || flagOk) {
        writer.write(formatFileEntry(entry));
      }
    });
  }

  // Console transport — suppressed in TUI mode
  // Debug-flagged subsystems bypass console level threshold.
  if (!settings.tuiMode) {
    const flags = settings.debugFlags;
    transports.push((entry: LogEntry) => {
      const levelOk = isLevelEnabled(entry.level, settings.consoleLevel);
      const flagOk = matchesDebugFlag(entry.sub, flags);
      if (!levelOk && !flagOk) return;
      const output = formatConsoleEntry(entry);
      // Use original console to avoid recursion if console is captured
      const write = originalConsole?.error ?? console.error;
      write(output);
    });
  }

  // Error buffer transport — captures error/warn entries into ring buffer + JSONL
  transports.push((entry: LogEntry) => {
    if (entry.level === "error" || entry.level === "warn" || entry.level === "fatal") {
      onLogEntry(entry.level === "fatal" ? "error" : entry.level, entry.sub, entry.msg, entry.meta);
    }
  });

  // Update or create global state
  if (globalState) {
    globalState.fileLevel = settings.level;
    globalState.consoleLevel = settings.consoleLevel;
    globalState.debugFlags = settings.debugFlags;
    globalState.tuiMode = settings.tuiMode;
    globalState.transports = transports;
  } else {
    globalState = {
      fileLevel: settings.level,
      consoleLevel: settings.consoleLevel,
      debugFlags: settings.debugFlags,
      tuiMode: settings.tuiMode,
      transports,
    };
  }
}

// -----------------------------------------------------------------------------
// Subsystem logger factory (public API)
// -----------------------------------------------------------------------------

/**
 * Create a subsystem logger. If the global logger hasn't been initialized,
 * creates a minimal no-op state (file-only fallback).
 *
 * @param subsystem - Hierarchical name (e.g., "gateway/ws", "agent/loop")
 */
export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  if (!globalState) {
    // Fallback: create minimal state that logs nothing
    // This allows modules to import and create loggers at module level
    // before initLogger() is called. They'll start working once init runs.
    globalState = {
      fileLevel: "info",
      consoleLevel: "warn",
      debugFlags: [],
      tuiMode: false,
      transports: [],
    };
  }
  return createSubsystemLoggerImpl(subsystem, globalState);
}

// -----------------------------------------------------------------------------
// Console capture
// -----------------------------------------------------------------------------

/**
 * Patch console.log/info/warn/error/debug to route through the logger.
 * Prevents stray console calls from corrupting TUI output.
 * Third-party libraries that use console.* will be captured.
 */
export function enableConsoleCapture(): void {
  if (consolePatched) return;
  consolePatched = true;

  // Save originals
  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const captureLog = createSubsystemLogger("console");

  const levelMap: Record<string, LogLevel> = {
    log: "info",
    info: "info",
    warn: "warn",
    error: "error",
    debug: "debug",
  };

  for (const [method, level] of Object.entries(levelMap)) {
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      captureLog[level as keyof Pick<SubsystemLogger, "info" | "warn" | "error" | "debug">](msg);
    };
  }
}

/**
 * Restore original console methods. Used in tests and cleanup.
 */
export function disableConsoleCapture(): void {
  if (!consolePatched || !originalConsole) return;
  consolePatched = false;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
  originalConsole = null;
}

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

/**
 * Reset global logger state. For testing only.
 */
export function resetLogger(): void {
  globalState = null;
  fileWriter = null;
  disableConsoleCapture();
}

/**
 * Get the current file writer (for testing).
 */
export function getFileWriter(): RollingFileWriter | null {
  return fileWriter;
}
