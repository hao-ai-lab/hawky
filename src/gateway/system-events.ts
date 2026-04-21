// =============================================================================
// System Event Queue
//
// Ephemeral in-memory queue for cross-session events. Producers (cron jobs,
// external hooks, exec completions) enqueue short text messages. The heartbeat
// drains the queue on each tick and incorporates events into its prompt.
//
// Pattern: a proven system-events.ts — session-scoped, max 20 events,
// duplicate suppression, no persistence.
//
// This is scaffolding for Part 7.5 (Cron). No producers exist yet.
// =============================================================================

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SystemEvent {
  text: string;
  ts: number;
  /** Context key for deduplication (e.g., "cron:job-id") */
  contextKey?: string;
}

interface SessionQueue {
  queue: SystemEvent[];
  lastText: string | null;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_EVENTS = 20;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

const queues = new Map<string, SessionQueue>();

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Enqueue a system event for a session.
 * Returns false if the text is empty or identical to the last enqueued event.
 */
export function enqueueSystemEvent(
  sessionKey: string,
  text: string,
  contextKey?: string,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (!sessionKey.trim()) {
    throw new Error("sessionKey is required for system events");
  }

  let entry = queues.get(sessionKey);
  if (!entry) {
    entry = { queue: [], lastText: null };
    queues.set(sessionKey, entry);
  }

  // Deduplicate: skip if identical to last enqueued text
  if (entry.lastText === trimmed) return false;

  const event: SystemEvent = {
    text: trimmed,
    ts: Date.now(),
    contextKey: contextKey?.trim().toLowerCase() || undefined,
  };

  entry.queue.push(event);
  entry.lastText = trimmed;

  // Cap at MAX_EVENTS (FIFO eviction)
  while (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }

  return true;
}

/**
 * Drain all pending events for a session. Returns events and clears the queue.
 */
export function drainSystemEvents(sessionKey: string): SystemEvent[] {
  const entry = queues.get(sessionKey);
  if (!entry || entry.queue.length === 0) return [];

  const events = [...entry.queue];
  entry.queue.length = 0;
  queues.delete(sessionKey);
  return events;
}

/**
 * Peek at pending events without clearing.
 */
export function peekSystemEvents(sessionKey: string): SystemEvent[] {
  const entry = queues.get(sessionKey);
  if (!entry) return [];
  return [...entry.queue];
}

/**
 * Check if a session has pending system events.
 */
export function hasSystemEvents(sessionKey: string): boolean {
  const entry = queues.get(sessionKey);
  return entry !== undefined && entry.queue.length > 0;
}

/**
 * Reset all queues. For testing only.
 */
export function resetSystemEvents(): void {
  queues.clear();
}
