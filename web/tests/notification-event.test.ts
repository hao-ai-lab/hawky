// =============================================================================
// Tests: notification.received event handling in the session store
//
// Heartbeat (today) and cron (later) deliver display-only notifications
// via the `notification.received` gateway event. This file pins the
// store's behaviour: the event updates notificationsBySession[*] only —
// it must NOT touch messages, unreadCounts, hasUnread, or sessionCache.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore, type NotificationItem } from "../src/store/session-store";

function mkNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "n-1",
    sessionKey: "web:general",
    origin: "heartbeat",
    title: "Heartbeat Update",
    body: "All quiet.",
    timestamp: "2026-04-24T20:00:00.000Z",
    ...overrides,
  };
}

function deliver(notification: NotificationItem) {
  useSessionStore.getState().handleEvent({
    type: "event",
    event: "notification.received",
    payload: { _sessionKey: notification.sessionKey, ...notification } as any,
    seq: 1,
  } as any);
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    activeKey: "web:general",
    notificationsBySession: {},
    messages: [],
    sessionCache: {},
    hasUnread: {},
    unreadCounts: {},
  });
});

describe("notification.received", () => {
  it("appends the notification to notificationsBySession[sessionKey]", () => {
    deliver(mkNotification({ id: "n-a" }));
    const list = useSessionStore.getState().notificationsBySession["web:general"];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("n-a");
    expect(list[0].body).toBe("All quiet.");
  });

  it("does not push anything into messages", () => {
    deliver(mkNotification());
    expect(useSessionStore.getState().messages).toHaveLength(0);
  });

  it("does not bump unread counters or hasUnread for the target session", () => {
    // Heartbeat shouldn't make channels "loud" — it's a soft notification,
    // not a message. The unread system is for real agent/user traffic.
    deliver(mkNotification({ sessionKey: "web:other" }));
    const { unreadCounts, hasUnread } = useSessionStore.getState();
    expect(unreadCounts["web:other"]).toBeUndefined();
    expect(hasUnread["web:other"]).toBeUndefined();
  });

  it("dedupes repeated deliveries of the same id (reconnect replay)", () => {
    deliver(mkNotification({ id: "dup" }));
    deliver(mkNotification({ id: "dup" }));
    const list = useSessionStore.getState().notificationsBySession["web:general"];
    expect(list).toHaveLength(1);
  });

  it("keeps at most 50 notifications per session (ring buffer)", () => {
    for (let i = 0; i < 60; i++) {
      deliver(mkNotification({ id: `n-${i}`, timestamp: new Date(2026, 0, 1, 0, i).toISOString() }));
    }
    const list = useSessionStore.getState().notificationsBySession["web:general"];
    expect(list).toHaveLength(50);
    // Oldest entries dropped from the head — n-10 through n-59 remain.
    expect(list[0].id).toBe("n-10");
    expect(list[49].id).toBe("n-59");
  });

  it("ignores malformed events (missing id or sessionKey)", () => {
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "notification.received",
      payload: { _sessionKey: "web:general", body: "no id" } as any,
      seq: 1,
    } as any);
    useSessionStore.getState().handleEvent({
      type: "event",
      event: "notification.received",
      payload: { _sessionKey: undefined, id: "x", body: "no key" } as any,
      seq: 2,
    } as any);
    expect(useSessionStore.getState().notificationsBySession).toEqual({});
  });
});

describe("dismissNotification / clearNotifications", () => {
  it("dismiss removes the matching notification by id", () => {
    deliver(mkNotification({ id: "keep" }));
    deliver(mkNotification({ id: "drop" }));
    useSessionStore.getState().dismissNotification("web:general", "drop");
    const list = useSessionStore.getState().notificationsBySession["web:general"];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("keep");
  });

  it("dismissing the last notification removes the session's entry entirely", () => {
    deliver(mkNotification({ id: "only" }));
    useSessionStore.getState().dismissNotification("web:general", "only");
    expect("web:general" in useSessionStore.getState().notificationsBySession).toBe(false);
  });

  it("clearNotifications removes all notifications for that session", () => {
    deliver(mkNotification({ id: "a" }));
    deliver(mkNotification({ id: "b", sessionKey: "web:other" }));
    useSessionStore.getState().clearNotifications("web:general");
    expect("web:general" in useSessionStore.getState().notificationsBySession).toBe(false);
    expect(useSessionStore.getState().notificationsBySession["web:other"]).toHaveLength(1);
  });
});

describe("session.renamed remaps notifications", () => {
  it("moves notificationsBySession[oldKey] to newKey", () => {
    deliver(mkNotification({ id: "a", sessionKey: "web:old" }));
    deliver(mkNotification({ id: "b", sessionKey: "web:old" }));

    useSessionStore.getState().handleEvent({
      type: "event",
      event: "session.renamed",
      payload: { oldKey: "web:old", newKey: "web:new" } as any,
      seq: 1,
    } as any);

    const state = useSessionStore.getState();
    expect(state.notificationsBySession["web:old"]).toBeUndefined();
    expect(state.notificationsBySession["web:new"]).toHaveLength(2);
  });
});
