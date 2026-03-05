// =============================================================================
// Logging Module — Public API
//
// Usage:
//   import { createSubsystemLogger, initLogger } from "../logging/index.js";
//
//   // At startup:
//   initLogger(resolveLoggerSettings(config.logging, logDir, tuiMode));
//
//   // In any module:
//   const log = createSubsystemLogger("agent/loop");
//   log.info("iteration complete", { toolCount: 3 });
// =============================================================================

// Core
export { createSubsystemLogger, initLogger, resetLogger, enableConsoleCapture, disableConsoleCapture, getFileWriter } from "./logger.js";

// Config
export { resolveLoggerSettings, matchesDebugFlag, isLevelEnabled, LEVEL_ORDER } from "./config.js";
export type { LogLevel, LoggerSettings } from "./config.js";

// Subsystem types
export type { SubsystemLogger, LogEntry, LogTransport, LoggerState } from "./subsystem.js";
export { formatConsoleEntry, formatFileEntry } from "./subsystem.js";

// Rotation
export { RollingFileWriter, formatLocalDate, formatLocalIso, formatTime } from "./rotation.js";

// Redaction
export { redactString, redactMetadata, maskValue, looksLikeSecret } from "./redact.js";
