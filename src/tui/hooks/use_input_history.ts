// =============================================================================
// Input History Hook
//
// Manages Up/Down arrow history navigation for the input area.
// Persists history to ~/.hawky/history.jsonl across sessions.
// On startup, loads disk history into memory. On submit, appends to disk.
// =============================================================================

import { useState, useCallback, useRef } from "react";
import { loadHistorySync, appendHistoryEntry, historyTexts } from "../../storage/input-history.js";

export interface UseInputHistoryReturn {
  /** Navigate backwards in history. Returns previous message or null if at start. */
  goBack: (currentDraft: string) => string | null;
  /** Navigate forwards in history. Returns next message or draft if at end. */
  goForward: () => string | null;
  /** Add a message to history (called on submit). */
  addToHistory: (message: string) => void;
  /** Whether currently navigating history (disables other input behaviors). */
  isNavigating: boolean;
  /** Reset navigation state (called on submit or when user edits). */
  resetNavigation: () => void;
}

/**
 * Load persistent history once (module-level singleton).
 * This runs on first import, before any React render.
 */
let _diskHistoryLoaded = false;
let _diskHistory: string[] = [];

function getDiskHistory(): string[] {
  if (!_diskHistoryLoaded) {
    _diskHistory = historyTexts(loadHistorySync());
    _diskHistoryLoaded = true;
  }
  return _diskHistory;
}

/** Reset disk history cache (for testing). */
export function resetDiskHistoryCache(): void {
  _diskHistoryLoaded = false;
  _diskHistory = [];
}

export function useInputHistory(): UseInputHistoryReturn {
  // Seed in-memory history from disk on first render
  const historyRef = useRef<string[]>([...getDiskHistory()]);
  // Track which entries came from disk (don't re-persist them)
  const diskCountRef = useRef(historyRef.current.length);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = not navigating
  const draftRef = useRef(""); // Saved draft when entering history

  const addToHistory = useCallback((message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    // Avoid duplicates at the end
    const history = historyRef.current;
    if (history.length === 0 || history[history.length - 1] !== trimmed) {
      history.push(trimmed);
    }
  }, []);

  const goBack = useCallback((currentDraft: string): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;

    const currentIndex = historyIndex;
    if (currentIndex === -1) {
      // Entering history mode — save current draft
      draftRef.current = currentDraft;
      const newIndex = history.length - 1;
      setHistoryIndex(newIndex);
      return history[newIndex];
    }

    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      setHistoryIndex(newIndex);
      return history[newIndex];
    }

    return null; // Already at oldest
  }, [historyIndex]);

  const goForward = useCallback((): string | null => {
    const history = historyRef.current;
    if (historyIndex === -1) return null; // Not navigating

    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      return history[newIndex];
    }

    // At the end — return to draft
    setHistoryIndex(-1);
    return draftRef.current;
  }, [historyIndex]);

  const resetNavigation = useCallback(() => {
    setHistoryIndex(-1);
    draftRef.current = "";
  }, []);

  return {
    goBack,
    goForward,
    addToHistory,
    isNavigating: historyIndex !== -1,
    resetNavigation,
  };
}

/**
 * Persist a message to disk history.
 * Called separately from addToHistory so session-restored messages
 * (which are already on disk via session JSONL) don't get re-persisted.
 */
export function persistToHistory(message: string, sessionKey?: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  appendHistoryEntry(trimmed, sessionKey);
}

/**
 * Populate history from restored session messages.
 * Extracts user text messages for Up/Down recall.
 */
export function extractUserMessages(messages: Array<{ role: string; text: string }>): string[] {
  return messages
    .filter((m) => m.role === "user" && m.text.trim().length > 0)
    .map((m) => m.text.trim());
}
