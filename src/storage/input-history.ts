// =============================================================================
// Persistent Input History
//
// Stores user input messages to ~/.hawky/history.jsonl so arrow-up
// recalls messages across sessions. JSONL format, one entry per line.
// Async append (fire-and-forget on submit), sync load on startup.
// =============================================================================

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HISTORY_DIR = join(homedir(), ".hawky");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const MAX_HISTORY_ENTRIES = 500;

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
    if (!existsSync(HISTORY_FILE)) return [];
    const content = readFileSync(HISTORY_FILE, "utf-8");
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
    mkdirSync(HISTORY_DIR, { recursive: true });
    const entry: HistoryEntry = {
      text,
      timestamp: Date.now(),
      session: sessionKey,
    };
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
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
