// =============================================================================
// Logger Configuration
//
// Resolves logger settings from env vars, config file, and defaults.
// Priority: env var > config file > defaults.
// =============================================================================

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type LogLevel = "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface LoggerSettings {
  /** File log level (default: "info") */
  level: LogLevel;
  /** Console log level (default: "warn" in TUI, "info" in gateway) */
  consoleLevel: LogLevel;
  /** Log directory (default: ~/.hawky/logs) */
  dir: string;
  /** Max file size in bytes before suppressing writes (default: 50MB) */
  maxFileBytes: number;
  /** Retention in days (default: 7) */
  retentionDays: number;
  /** Diagnostic debug flags (e.g., "gateway/*,agent/loop") */
  debugFlags: string[];
  /** Whether running in TUI mode (suppresses console output) */
  tuiMode: boolean;
}

/** Numeric ordering for level comparison. Lower = more severe. */
export const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  fatal: 1,
  error: 2,
  warn: 3,
  info: 4,
  debug: 5,
  trace: 6,
};

/** Check if a message at `msgLevel` should be shown given `minLevel` threshold. */
export function isLevelEnabled(msgLevel: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[msgLevel] <= LEVEL_ORDER[minLevel];
}

// -----------------------------------------------------------------------------
// Config resolution
// -----------------------------------------------------------------------------

const VALID_LEVELS = new Set<string>(["silent", "fatal", "error", "warn", "info", "debug", "trace"]);

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return VALID_LEVELS.has(lower) ? (lower as LogLevel) : undefined;
}

/**
 * Resolve logger settings from config object and environment.
 *
 * @param configLogging - The `logging` section from config.json (if any)
 * @param defaultDir - Default log directory (typically ~/.hawky/logs)
 * @param tuiMode - Whether running in TUI mode
 */
export function resolveLoggerSettings(
  configLogging?: Partial<{
    level: string;
    consoleLevel: string;
    dir: string;
    maxFileBytes: number;
    retentionDays: number;
  }>,
  defaultDir?: string,
  tuiMode = false,
): LoggerSettings {
  // Defaults
  const settings: LoggerSettings = {
    level: "info",
    consoleLevel: tuiMode ? "warn" : "info",
    dir: defaultDir ?? "",
    maxFileBytes: 50 * 1024 * 1024, // 50MB
    retentionDays: 7,
    debugFlags: [],
    tuiMode,
  };

  // Layer 1: config file
  if (configLogging) {
    const cfgLevel = parseLevel(configLogging.level);
    if (cfgLevel) settings.level = cfgLevel;

    const cfgConsole = parseLevel(configLogging.consoleLevel);
    if (cfgConsole) settings.consoleLevel = cfgConsole;

    if (configLogging.dir) settings.dir = configLogging.dir;
    if (configLogging.maxFileBytes && configLogging.maxFileBytes > 0) {
      settings.maxFileBytes = configLogging.maxFileBytes;
    }
    if (configLogging.retentionDays && configLogging.retentionDays > 0) {
      settings.retentionDays = configLogging.retentionDays;
    }
  }

  // Layer 2: env vars (highest priority)
  const envLevel = parseLevel(process.env.HAWKY_LOG_LEVEL);
  if (envLevel) {
    settings.level = envLevel;
    // If file level is overridden and console isn't explicitly set, match it
    if (!configLogging?.consoleLevel && !process.env.HAWKY_CONSOLE_LOG_LEVEL) {
      settings.consoleLevel = envLevel;
    }
  }

  const envConsole = parseLevel(process.env.HAWKY_CONSOLE_LOG_LEVEL);
  if (envConsole) settings.consoleLevel = envConsole;

  // Diagnostic debug flags
  const envDebug = process.env.HAWKY_DEBUG;
  if (envDebug) {
    settings.debugFlags = envDebug.split(",").map((f) => f.trim()).filter(Boolean);
  }

  return settings;
}

// -----------------------------------------------------------------------------
// Diagnostic flag matching
// -----------------------------------------------------------------------------

/**
 * Check if a subsystem matches any diagnostic debug flag.
 * Supports glob patterns: "gateway/*" matches "gateway/ws", "gateway/boot", etc.
 * "*" matches everything.
 */
export function matchesDebugFlag(subsystem: string, flags: string[]): boolean {
  if (flags.length === 0) return false;
  for (const flag of flags) {
    if (flag === "*") return true;
    if (flag === subsystem) return true;
    // Simple glob: "gateway/*" matches "gateway/anything"
    if (flag.endsWith("/*")) {
      const prefix = flag.slice(0, -2);
      if (subsystem === prefix || subsystem.startsWith(prefix + "/")) return true;
    }
  }
  return false;
}
