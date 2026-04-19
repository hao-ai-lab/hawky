// =============================================================================
// Subscription Registry Tests
//
// Tests for the multi-session WebSocket subscription system.
// Verifies bidirectional mapping, subscribe/unsubscribe, cleanup on disconnect.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { createSubscriptionRegistry } from "../src/gateway/subscriptions.js";

describe("SubscriptionRegistry", () => {
  let registry: ReturnType<typeof createSubscriptionRegistry>;

  beforeEach(() => {
    registry = createSubscriptionRegistry();
  });

  // ---------------------------------------------------------------------------
  // Basic subscribe/unsubscribe
  // ---------------------------------------------------------------------------

  test("subscribe adds connection to session subscribers", () => {
    registry.subscribe("conn-1", "web:general");
    const subs = registry.getSubscribers("web:general");
    expect(subs.has("conn-1")).toBe(true);
    expect(subs.size).toBe(1);
  });

  test("multiple connections subscribe to same session", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-2", "web:general");
    const subs = registry.getSubscribers("web:general");
    expect(subs.size).toBe(2);
    expect(subs.has("conn-1")).toBe(true);
    expect(subs.has("conn-2")).toBe(true);
  });

  test("one connection subscribes to multiple sessions", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-1", "heartbeat:main");
    registry.subscribe("conn-1", "cron:daily");
    expect(registry.getSubscribers("web:general").has("conn-1")).toBe(true);
    expect(registry.getSubscribers("heartbeat:main").has("conn-1")).toBe(true);
    expect(registry.getSubscribers("cron:daily").has("conn-1")).toBe(true);
  });

  test("duplicate subscribe is idempotent", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-1", "web:general");
    expect(registry.getSubscribers("web:general").size).toBe(1);
  });

  test("unsubscribe removes connection from session", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-2", "web:general");
    registry.unsubscribe("conn-1", "web:general");
    const subs = registry.getSubscribers("web:general");
    expect(subs.has("conn-1")).toBe(false);
    expect(subs.has("conn-2")).toBe(true);
  });

  test("unsubscribe from non-subscribed session is no-op", () => {
    registry.unsubscribe("conn-1", "web:general");
    expect(registry.getSubscribers("web:general").size).toBe(0);
  });

  test("getSubscribers returns empty set for unknown session", () => {
    const subs = registry.getSubscribers("nonexistent");
    expect(subs.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // unsubscribeAll (connection disconnect)
  // ---------------------------------------------------------------------------

  test("unsubscribeAll removes connection from all sessions", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-1", "heartbeat:main");
    registry.subscribe("conn-1", "cron:daily");
    registry.subscribe("conn-2", "web:general");

    registry.unsubscribeAll("conn-1");

    expect(registry.getSubscribers("web:general").has("conn-1")).toBe(false);
    expect(registry.getSubscribers("heartbeat:main").has("conn-1")).toBe(false);
    expect(registry.getSubscribers("cron:daily").has("conn-1")).toBe(false);
    // conn-2 unaffected
    expect(registry.getSubscribers("web:general").has("conn-2")).toBe(true);
  });

  test("unsubscribeAll on unsubscribed connection is no-op", () => {
    registry.unsubscribeAll("conn-1");
    // No error
  });

  test("unsubscribeAll cleans up empty session entries", () => {
    registry.subscribe("conn-1", "web:general");
    registry.unsubscribeAll("conn-1");
    // Internal map should be clean — getSubscribers returns empty set
    expect(registry.getSubscribers("web:general").size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // subscribeAll (auto-subscribe on connect)
  // ---------------------------------------------------------------------------

  test("subscribeAll subscribes to all provided sessions", () => {
    registry.subscribeAll("conn-1", ["web:general", "heartbeat:main", "cron:daily"]);
    expect(registry.getSubscribers("web:general").has("conn-1")).toBe(true);
    expect(registry.getSubscribers("heartbeat:main").has("conn-1")).toBe(true);
    expect(registry.getSubscribers("cron:daily").has("conn-1")).toBe(true);
  });

  test("subscribeAll with empty list is no-op", () => {
    registry.subscribeAll("conn-1", []);
    // No error, no subscriptions
  });

  // ---------------------------------------------------------------------------
  // reset (testing)
  // ---------------------------------------------------------------------------

  test("reset clears all subscriptions", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-2", "heartbeat:main");
    registry.reset();
    expect(registry.getSubscribers("web:general").size).toBe(0);
    expect(registry.getSubscribers("heartbeat:main").size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Cross-session isolation
  // ---------------------------------------------------------------------------

  test("sessions are independent — subscribing to A does not affect B", () => {
    registry.subscribe("conn-1", "web:general");
    expect(registry.getSubscribers("web:code").size).toBe(0);
  });

  test("unsubscribing from A does not affect B", () => {
    registry.subscribe("conn-1", "web:general");
    registry.subscribe("conn-1", "web:code");
    registry.unsubscribe("conn-1", "web:general");
    expect(registry.getSubscribers("web:code").has("conn-1")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Concurrent simulation
  // ---------------------------------------------------------------------------

  test("many connections and sessions", () => {
    // 5 connections, 10 sessions each
    for (let c = 0; c < 5; c++) {
      for (let s = 0; s < 10; s++) {
        registry.subscribe(`conn-${c}`, `session-${s}`);
      }
    }
    // Each session has 5 subscribers
    expect(registry.getSubscribers("session-0").size).toBe(5);
    expect(registry.getSubscribers("session-9").size).toBe(5);

    // Disconnect conn-2
    registry.unsubscribeAll("conn-2");
    expect(registry.getSubscribers("session-0").size).toBe(4);
    expect(registry.getSubscribers("session-0").has("conn-2")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // rename — used by session rename
  // ---------------------------------------------------------------------------

  test("rename moves all subscribers from oldKey to newKey", () => {
    registry.subscribe("conn-1", "web:old");
    registry.subscribe("conn-2", "web:old");

    registry.rename("web:old", "web:new");

    expect(registry.getSubscribers("web:old").size).toBe(0);
    const subs = registry.getSubscribers("web:new");
    expect(subs.size).toBe(2);
    expect(subs.has("conn-1")).toBe(true);
    expect(subs.has("conn-2")).toBe(true);
  });

  test("rename updates connection → session mapping", () => {
    registry.subscribe("conn-1", "web:old");
    registry.subscribe("conn-1", "web:other");

    registry.rename("web:old", "web:new");

    const sessions = registry.getSubscribedSessions("conn-1");
    expect(sessions.has("web:old")).toBe(false);
    expect(sessions.has("web:new")).toBe(true);
    expect(sessions.has("web:other")).toBe(true);
  });

  test("rename merges with any pre-existing subscribers of newKey", () => {
    registry.subscribe("conn-1", "web:old");
    registry.subscribe("conn-2", "web:new");

    registry.rename("web:old", "web:new");

    const subs = registry.getSubscribers("web:new");
    expect(subs.size).toBe(2);
    expect(subs.has("conn-1")).toBe(true);
    expect(subs.has("conn-2")).toBe(true);
  });

  test("rename with no subscribers is a no-op", () => {
    registry.rename("web:missing", "web:new");
    expect(registry.getSubscribers("web:new").size).toBe(0);
  });

  test("rename with identical keys is a no-op", () => {
    registry.subscribe("conn-1", "web:general");
    registry.rename("web:general", "web:general");
    expect(registry.getSubscribers("web:general").size).toBe(1);
  });
});
