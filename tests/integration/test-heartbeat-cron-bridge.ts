// =============================================================================
// Integration Tests: Heartbeat + Cron Bridge
//
// Tests the system event pipeline:
//   cron job completes → enqueueSystemEvent → heartbeat drains → prompt includes events
//
// Does NOT use real LLM calls — tests the data flow between cron and heartbeat.
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import {
  enqueueSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  hasSystemEvents,
  resetSystemEvents,
} from "../../src/gateway/system-events.js";
import { buildHeartbeatUserMessage } from "../../src/gateway/heartbeat-prompt.js";
import type { SystemEvent } from "../../src/gateway/system-events.js";

// =============================================================================
// Constants (matches the heartbeat service)
// =============================================================================

const HEARTBEAT_SESSION_KEY = "heartbeat:main";

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  resetSystemEvents();
});

// =============================================================================
// Cron → System Event Queue → Heartbeat Drain
// =============================================================================

describe("heartbeat-cron bridge — event flow", () => {
  test("cron job completion enqueues event, heartbeat drains it", () => {
    // Simulate cron job completing (as cron.ts does)
    const enqueued = enqueueSystemEvent(
      HEARTBEAT_SESSION_KEY,
      'Cron "check-weather" completed: sunny, 72°F',
      "cron:job-123",
    );
    expect(enqueued).toBe(true);
    expect(hasSystemEvents(HEARTBEAT_SESSION_KEY)).toBe(true);

    // Heartbeat drains the queue (as heartbeat.ts does)
    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain("check-weather");
    expect(events[0].contextKey).toBe("cron:job-123");

    // Queue should be empty after drain
    expect(hasSystemEvents(HEARTBEAT_SESSION_KEY)).toBe(false);
    expect(drainSystemEvents(HEARTBEAT_SESSION_KEY)).toHaveLength(0);
  });

  test("multiple cron jobs enqueue events, heartbeat drains all at once", () => {
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "weather" completed: sunny', "cron:weather");
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "news" completed: 3 headlines', "cron:news");
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "stocks" completed: +2.3%', "cron:stocks");

    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.contextKey)).toEqual(["cron:weather", "cron:news", "cron:stocks"]);
  });

  test("duplicate consecutive events are deduplicated", () => {
    // Same cron job fires twice with identical output
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "check" completed: ok', "cron:check");
    const second = enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "check" completed: ok', "cron:check");
    expect(second).toBe(false);

    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    expect(events).toHaveLength(1);
  });

  test("different messages from same cron job are NOT deduplicated", () => {
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "check" completed: ok', "cron:check");
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "check" completed: error!', "cron:check");

    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    expect(events).toHaveLength(2);
  });

  test("FIFO eviction when queue exceeds max (20 events)", () => {
    for (let i = 0; i < 25; i++) {
      enqueueSystemEvent(HEARTBEAT_SESSION_KEY, `Event ${i}`, `cron:${i}`);
    }

    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    expect(events).toHaveLength(20);
    // Oldest 5 should be evicted — first event should be #5
    expect(events[0].text).toBe("Event 5");
    expect(events[19].text).toBe("Event 24");
  });
});

// =============================================================================
// System Events → Heartbeat Prompt
// =============================================================================

describe("heartbeat-cron bridge — prompt integration", () => {
  test("drained events appear in heartbeat user message", () => {
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "weather" completed: sunny', "cron:weather");
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "news" completed: 3 headlines', "cron:news");

    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    const heartbeatMd = "## Tasks\n- [ ] Check the weather\n- [ ] Summarize news";

    const prompt = buildHeartbeatUserMessage(heartbeatMd, events, Date.now());

    // Should include system events section
    expect(prompt).toContain("Pending system events (2):");
    expect(prompt).toContain('Cron "weather" completed: sunny');
    expect(prompt).toContain('Cron "news" completed: 3 headlines');
    // Should also include HEARTBEAT.md content
    expect(prompt).toContain("=== HEARTBEAT.md ===");
    expect(prompt).toContain("Check the weather");
  });

  test("no system events: prompt only has HEARTBEAT.md", () => {
    const events: SystemEvent[] = [];
    const prompt = buildHeartbeatUserMessage("## Tasks\n- [ ] Do something", events);

    expect(prompt).not.toContain("Pending system events");
    expect(prompt).toContain("Do something");
  });

  test("events with age: shows seconds ago", () => {
    const now = Date.now();
    // Create event 30 seconds ago
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, "Old event", "cron:old");
    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    // Manually set ts to 30s ago
    events[0].ts = now - 30_000;

    const prompt = buildHeartbeatUserMessage("tasks", events, now);
    expect(prompt).toContain("[30s ago] Old event");
  });

  test("empty HEARTBEAT.md with system events: heartbeat should still have content", () => {
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, 'Cron "job" completed: result');

    const events = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    // This matches the heartbeat service's logic: hasExternalEvents=true → proceed
    expect(events.length).toBeGreaterThan(0);

    const prompt = buildHeartbeatUserMessage("", events);
    expect(prompt).toContain("Pending system events (1):");
    expect(prompt).toContain('Cron "job" completed: result');
  });
});

// =============================================================================
// Session isolation
// =============================================================================

describe("heartbeat-cron bridge — session isolation", () => {
  test("events for different sessions don't leak", () => {
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, "heartbeat event");
    enqueueSystemEvent("cron:job-1", "cron session event");

    // Heartbeat only sees its own events
    const heartbeatEvents = drainSystemEvents(HEARTBEAT_SESSION_KEY);
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0].text).toBe("heartbeat event");

    // Cron session only sees its own events
    const cronEvents = drainSystemEvents("cron:job-1");
    expect(cronEvents).toHaveLength(1);
    expect(cronEvents[0].text).toBe("cron session event");
  });

  test("draining one session doesn't affect another", () => {
    enqueueSystemEvent(HEARTBEAT_SESSION_KEY, "hb event");
    enqueueSystemEvent("other-session", "other event");

    drainSystemEvents(HEARTBEAT_SESSION_KEY);

    // Other session still has its events
    expect(hasSystemEvents("other-session")).toBe(true);
    expect(drainSystemEvents("other-session")).toHaveLength(1);
  });
});
