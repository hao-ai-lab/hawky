// =============================================================================
// Subsystem Logger
//
// Creates tagged loggers for different subsystems (e.g., "gateway/ws",
// "agent/loop"). Each subsystem gets a consistent color for console output.
//
// Pattern: a proven subsystem logger, simplified.
// =============================================================================

import type { LogLevel } from "./config.js";
import { isLevelEnabled, matchesDebugFlag } from "./config.js";
import { redactMetadata, redactString } from "./redact.js";
import { formatLocalIso, formatTime } from "./rotation.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SubsystemLogger {
  /** Subsystem name (e.g., "gateway/ws") */
  readonly subsystem: string;

  /** Check if a level is enabled (considering debug flags) */
  isEnabled(level: LogLevel): boolean;

  /** Log at various levels. Metadata is optional key-value pairs. */
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  fatal(message: string, meta?: Record<string, unknown>): void;

  /** Create a child logger with nested subsystem name. */
  child(name: string): SubsystemLogger;
}

/** Transport function that receives structured log entries. */
export interface LogTransport {
  (entry: LogEntry): void;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  sub: string;
  msg: string;
  meta?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Console colors (hash-based, consistent per subsystem)
// -----------------------------------------------------------------------------

// ANSI 256-color codes for subsystem names — distinct, readable on dark backgrounds
const SUBSYSTEM_COLORS = [
  "\x1b[36m",   // cyan
  "\x1b[33m",   // yellow
  "\x1b[35m",   // magenta
  "\x1b[32m",   // green
  "\x1b[34m",   // blue
  "\x1b[91m",   // bright red
  "\x1b[92m",   // bright green
  "\x1b[93m",   // bright yellow
  "\x1b[94m",   // bright blue
  "\x1b[95m",   // bright magenta
  "\x1b[96m",   // bright cyan
];

const LEVEL_COLORS: Record<LogLevel, string> = {
  silent: "",
  trace: "\x1b[90m",   // gray
  debug: "\x1b[90m",   // gray
  info: "\x1b[36m",    // cyan
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
  fatal: "\x1b[31m",   // red
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  silent: "",
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
  fatal: "FTL",
};

const RESET = "\x1b[0m";

/** Get a consistent color for a subsystem name (hash-based). */
function subsystemColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return SUBSYSTEM_COLORS[Math.abs(hash) % SUBSYSTEM_COLORS.length];
}

// -----------------------------------------------------------------------------
// Console formatter
// -----------------------------------------------------------------------------

/**
 * Format a log entry for pretty console output.
 * Format: `HH:MM:SS LVL [subsystem] message {meta}`
 */
export function formatConsoleEntry(entry: LogEntry): string {
  const time = `\x1b[90m${formatTime(new Date(entry.ts))}${RESET}`;
  const levelColor = LEVEL_COLORS[entry.level];
  const level = `${levelColor}${LEVEL_LABELS[entry.level]}${RESET}`;
  const subColor = subsystemColor(entry.sub);
  const sub = `${subColor}[${entry.sub}]${RESET}`;
  const msg = redactString(entry.msg);

  let metaStr = "";
  if (entry.meta && Object.keys(entry.meta).length > 0) {
    const redacted = redactMetadata(entry.meta);
    metaStr = ` ${JSON.stringify(redacted)}`;
  }

  return `${time} ${level} ${sub} ${msg}${metaStr}`;
}

/**
 * Format a log entry as a JSON line for file output.
 * No redaction — file logs preserve full values for debugging.
 */
export function formatFileEntry(entry: LogEntry): string {
  const obj: Record<string, unknown> = {
    ts: entry.ts,
    level: entry.level,
    sub: entry.sub,
    msg: entry.msg,
  };
  if (entry.meta) {
    Object.assign(obj, entry.meta);
  }
  return JSON.stringify(obj);
}

// -----------------------------------------------------------------------------
// Subsystem logger factory
// -----------------------------------------------------------------------------

/** State shared by all subsystem loggers within a logger instance. */
export interface LoggerState {
  fileLevel: LogLevel;
  consoleLevel: LogLevel;
  debugFlags: string[];
  tuiMode: boolean;
  transports: LogTransport[];
}

/**
 * Create a subsystem logger.
 *
 * @param subsystem - Hierarchical name (e.g., "gateway/ws")
 * @param state - Shared logger state (levels, transports, flags)
 */
export function createSubsystemLoggerImpl(
  subsystem: string,
  state: LoggerState,
): SubsystemLogger {
  function isEnabled(level: LogLevel): boolean {
    // Check if debug flag matches this subsystem — if so, debug and trace are enabled
    if (
      (level === "debug" || level === "trace") &&
      matchesDebugFlag(subsystem, state.debugFlags)
    ) {
      return true;
    }
    // Otherwise check against configured levels
    return isLevelEnabled(level, state.fileLevel) || isLevelEnabled(level, state.consoleLevel);
  }

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!isEnabled(level)) return;

    const entry: LogEntry = {
      ts: formatLocalIso(),
      level,
      sub: subsystem,
      msg: message,
      meta: meta && Object.keys(meta).length > 0 ? meta : undefined,
    };

    for (const transport of state.transports) {
      try {
        transport(entry);
      } catch {
        // Never let transport errors propagate
      }
    }
  }

  return {
    subsystem,
    isEnabled,
    trace: (msg, meta) => log("trace", msg, meta),
    debug: (msg, meta) => log("debug", msg, meta),
    info: (msg, meta) => log("info", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    fatal: (msg, meta) => log("fatal", msg, meta),
    child: (name) => createSubsystemLoggerImpl(`${subsystem}/${name}`, state),
  };
}
