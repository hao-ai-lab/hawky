// =============================================================================
// Inbound Message Debouncer
//
// Coalesces rapid-fire messages from external channels into a single batch.
// When a user sends 3 quick Slack messages ("hey" → "can you" → "check emails"),
// the debouncer groups them by key (sender+conversation) and flushes after a
// configurable delay, triggering a single agent turn with concatenated text.
//
// Pattern: a proven createInboundDebouncer (simplified).
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/inbound-debounce");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface InboundDebouncerOpts<T> {
  /** Milliseconds to wait for more messages before flushing. */
  debounceMs: number;
  /** Build a grouping key from an item. Return null to skip debouncing (flush immediately). */
  buildKey: (item: T) => string | null;
  /** Called when a group of messages is ready to be processed. */
  onFlush: (items: T[]) => Promise<void>;
  /** Called on flush errors (optional). */
  onError?: (err: unknown, items: T[]) => void;
  /** Max tracked keys before evicting oldest (prevents memory leak). Default: 1000. */
  maxTrackedKeys?: number;
}

export interface InboundDebouncer<T> {
  /** Push an item into the debouncer. */
  push(item: T): void;
  /** Stop the debouncer and flush all pending items. */
  stop(): Promise<void>;
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

interface PendingGroup<T> {
  items: T[];
  timer: ReturnType<typeof setTimeout>;
}

export function createInboundDebouncer<T>(opts: InboundDebouncerOpts<T>): InboundDebouncer<T> {
  const { debounceMs, buildKey, onFlush, onError, maxTrackedKeys = 1000 } = opts;
  const pending = new Map<string, PendingGroup<T>>();
  let stopped = false;

  function flush(key: string): void {
    const group = pending.get(key);
    if (!group) return;
    pending.delete(key);

    const items = group.items;
    onFlush(items).catch((err) => {
      if (onError) {
        onError(err, items);
      } else {
        log.warn("debounce flush error", {
          key,
          itemCount: items.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  function push(item: T): void {
    if (stopped) return;

    const key = buildKey(item);

    // Null key = no debouncing, flush immediately
    if (key === null) {
      onFlush([item]).catch((err) => {
        if (onError) onError(err, [item]);
      });
      return;
    }

    const existing = pending.get(key);
    if (existing) {
      // Add to existing group, reset timer
      existing.items.push(item);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flush(key), debounceMs);
    } else {
      // Evict oldest if at capacity
      if (pending.size >= maxTrackedKeys) {
        const oldestKey = pending.keys().next().value!;
        flush(oldestKey);
      }

      // New group
      pending.set(key, {
        items: [item],
        timer: setTimeout(() => flush(key), debounceMs),
      });
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    // Flush all pending groups immediately
    const flushPromises: Promise<void>[] = [];
    for (const [key, group] of pending) {
      clearTimeout(group.timer);
      flushPromises.push(
        onFlush(group.items).catch((err) => {
          if (onError) onError(err, group.items);
        }),
      );
    }
    pending.clear();
    await Promise.all(flushPromises);
  }

  return { push, stop };
}
