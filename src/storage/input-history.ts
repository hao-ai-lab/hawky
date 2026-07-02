// =============================================================================
// Persistent Input History
//
// Stores user input messages to <hawky config dir>/history.jsonl so arrow-up
// recalls messages across sessions. JSONL format, one entry per line.
// Async append (fire-and-forget on submit), sync load on startup.
// =============================================================================

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";

const MAX_HISTORY_ENTRIES = 500;

function historyDir(): string {
  return getConfigDir();
}

function historyFile(): string {
  return join(historyDir(), "history.jsonl");
}

export interface HistoryEntry {
  text: string;
  timestamp: number;
  session?: string;
}

/**
 * Load history entries from disk (synchronous — called once on startup).
 * Returns entries in chronological order (oldest first).
 * Caps at MAX_HISTORY_ENTRIES most recent entries.
 */
export function loadHistorySync(): HistoryEntry[] {
  try {
    const file = historyFile();
    if (!existsSync(file)) return [];
    const content = readFileSync(file, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.text === "string" && entry.text.trim()) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Keep only the most recent entries
    if (entries.length > MAX_HISTORY_ENTRIES) {
      return entries.slice(entries.length - MAX_HISTORY_ENTRIES);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Append a history entry to disk (synchronous but fast — single line append).
 * Called on every submit. Silently fails on I/O error.
 */
export function appendHistoryEntry(text: string, sessionKey?: string): void {
  try {
    mkdirSync(historyDir(), { recursive: true });
    const entry: HistoryEntry = {
      text,
      timestamp: Date.now(),
      session: sessionKey,
    };
    appendFileSync(historyFile(), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // Silently fail — history is nice-to-have, not critical
  }
}

/**
 * Extract just the text strings from history entries.
 * Used to populate the in-memory history array on startup.
 */
export function historyTexts(entries: HistoryEntry[]): string[] {
  return entries.map((e) => e.text);
}
