// =============================================================================
// Rolling Log File Management
//
// Daily log files: hawky-YYYY-MM-DD.log
// Pruning: removes files older than retention period.
// Size cap: suppresses writes when file exceeds maxFileBytes.
//
// Pattern: a proven rolling files, simplified.
// =============================================================================

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Date formatting
// -----------------------------------------------------------------------------

/** Format local date as YYYY-MM-DD for log file naming. */
export function formatLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Format local ISO timestamp with timezone offset. */
export function formatLocalIso(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const oh = pad(Math.floor(absOffset / 60));
  const om = pad(absOffset % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${oh}:${om}`
  );
}

/** Format time as HH:MM:SS for console display. */
export function formatTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// -----------------------------------------------------------------------------
// File writer
// -----------------------------------------------------------------------------

export class RollingFileWriter {
  private dir: string;
  private maxBytes: number;
  private retentionDays: number;
  private currentDate = "";
  private currentPath = "";
  private currentSize = 0;
  private sizeCapped = false;
  private initialized = false;

  constructor(dir: string, maxBytes: number, retentionDays: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.retentionDays = retentionDays;
  }

  /**
   * Write a line to the current log file.
   * Returns false if write was suppressed (size cap or error).
   */
  write(line: string): boolean {
    if (!this.dir) return false;

    try {
      this.ensureInitialized();
      this.rotateIfNeeded();

      if (this.sizeCapped) return false;

      const data = line + "\n";
      const dataBytes = Buffer.byteLength(data, "utf-8");

      if (this.currentSize + dataBytes > this.maxBytes) {
        this.sizeCapped = true;
        // Write a final warning line
        const warning = JSON.stringify({
          ts: formatLocalIso(),
          level: "warn",
          sub: "logging",
          msg: `Log file size cap reached (${this.maxBytes} bytes). Further writes suppressed until next day.`,
        }) + "\n";
        appendFileSync(this.currentPath, warning, "utf-8");
        return false;
      }

      appendFileSync(this.currentPath, data, "utf-8");
      this.currentSize += dataBytes;
      return true;
    } catch {
      // Never throw on log write failure
      return false;
    }
  }

  /** Get current log file path (for testing/display). */
  getCurrentPath(): string {
    return this.currentPath;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    mkdirSync(this.dir, { recursive: true });
    this.pruneOldFiles();
    this.updateCurrentFile();
  }

  private rotateIfNeeded(): void {
    const today = formatLocalDate();
    if (today !== this.currentDate) {
      this.updateCurrentFile();
    }
  }

  private updateCurrentFile(): void {
    this.currentDate = formatLocalDate();
    this.currentPath = join(this.dir, `hawky-${this.currentDate}.log`);
    this.sizeCapped = false;

    try {
      if (existsSync(this.currentPath)) {
        this.currentSize = statSync(this.currentPath).size;
      } else {
        this.currentSize = 0;
      }
    } catch {
      this.currentSize = 0;
    }
  }

  private pruneOldFiles(): void {
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const files = readdirSync(this.dir);
      for (const file of files) {
        if (!file.startsWith("hawky-") || !file.endsWith(".log")) continue;
        const filePath = join(this.dir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch {
          // Skip files we can't stat/delete
        }
      }
    } catch {
      // Non-fatal: pruning is best-effort
    }
  }
}
