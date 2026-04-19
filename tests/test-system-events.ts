// =============================================================================
// Tests: System Event Queue
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueueSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  hasSystemEvents,
  resetSystemEvents,
} from "../src/gateway/system-events.js";

beforeEach(() => {
  resetSystemEvents();
});

// -----------------------------------------------------------------------------
// enqueueSystemEvent
// -----------------------------------------------------------------------------

describe("enqueueSystemEvent", () => {
  test("enqueues a simple event", () => {
    const ok = enqueueSystemEvent("session1", "hello");
    expect(ok).toBe(true);
    expect(hasSystemEvents("session1")).toBe(true);
  });

  test("rejects empty text", () => {
    expect(enqueueSystemEvent("session1", "")).toBe(false);
    expect(enqueueSystemEvent("session1", "   ")).toBe(false);
    expect(hasSystemEvents("session1")).toBe(false);
  });

  test("rejects duplicate consecutive text", () => {
    expect(enqueueSystemEvent("session1", "hello")).toBe(true);
    expect(enqueueSystemEvent("session1", "hello")).toBe(false);
    // Different text succeeds
    expect(enqueueSystemEvent("session1", "world")).toBe(true);
  });

  test("throws on empty sessionKey", () => {
    expect(() => enqueueSystemEvent("", "hello")).toThrow("sessionKey is required");
    expect(() => enqueueSystemEvent("  ", "hello")).toThrow("sessionKey is required");
  });

  test("caps at 20 events (FIFO eviction)", () => {
    for (let i = 0; i < 25; i++) {
      enqueueSystemEvent("session1", `event-${i}`);
    }
    const events = peekSystemEvents("session1");
    expect(events.length).toBe(20);
    // First 5 should be evicted
    expect(events[0].text).toBe("event-5");
    expect(events[19].text).toBe("event-24");
  });

  test("stores contextKey normalized to lowercase", () => {
    enqueueSystemEvent("session1", "hello", "CRON:Job-1");
    const events = peekSystemEvents("session1");
    expect(events[0].contextKey).toBe("cron:job-1");
  });

  test("sessions are isolated", () => {
    enqueueSystemEvent("session1", "hello");
    enqueueSystemEvent("session2", "world");
    expect(peekSystemEvents("session1").length).toBe(1);
    expect(peekSystemEvents("session2").length).toBe(1);
    expect(peekSystemEvents("session1")[0].text).toBe("hello");
    expect(peekSystemEvents("session2")[0].text).toBe("world");
  });
});

// -----------------------------------------------------------------------------
// drainSystemEvents
// -----------------------------------------------------------------------------

describe("drainSystemEvents", () => {
  test("returns events and clears queue", () => {
    enqueueSystemEvent("session1", "event-1");
    enqueueSystemEvent("session1", "event-2");

    const events = drainSystemEvents("session1");
    expect(events.length).toBe(2);
    expect(events[0].text).toBe("event-1");
    expect(events[1].text).toBe("event-2");

    // Queue should be empty now
    expect(hasSystemEvents("session1")).toBe(false);
    expect(drainSystemEvents("session1")).toEqual([]);
  });

  test("returns empty array for unknown session", () => {
    expect(drainSystemEvents("nonexistent")).toEqual([]);
  });

  test("events have timestamps", () => {
    const before = Date.now();
    enqueueSystemEvent("session1", "hello");
    const after = Date.now();

    const events = drainSystemEvents("session1");
    expect(events[0].ts).toBeGreaterThanOrEqual(before);
    expect(events[0].ts).toBeLessThanOrEqual(after);
  });
});

// -----------------------------------------------------------------------------
// peekSystemEvents
// -----------------------------------------------------------------------------

describe("peekSystemEvents", () => {
  test("returns events without clearing", () => {
    enqueueSystemEvent("session1", "hello");
    expect(peekSystemEvents("session1").length).toBe(1);
    expect(peekSystemEvents("session1").length).toBe(1); // still there
  });

  test("returns empty array for unknown session", () => {
    expect(peekSystemEvents("nonexistent")).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// hasSystemEvents
// -----------------------------------------------------------------------------

describe("hasSystemEvents", () => {
  test("returns false for empty/unknown session", () => {
    expect(hasSystemEvents("nonexistent")).toBe(false);
  });

  test("returns true when events exist", () => {
    enqueueSystemEvent("session1", "hello");
    expect(hasSystemEvents("session1")).toBe(true);
  });

  test("returns false after drain", () => {
    enqueueSystemEvent("session1", "hello");
    drainSystemEvents("session1");
    expect(hasSystemEvents("session1")).toBe(false);
  });
});
