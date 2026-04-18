// =============================================================================
// broadcastNotification — display-only delivery for heartbeat/cron
// =============================================================================

import { describe, expect, test } from "bun:test";
import { broadcastNotification } from "../src/gateway/notification.js";

type Broadcast = { sessionKey: string; event: string; payload: any };

function makeMockServer() {
  const calls: Broadcast[] = [];
  const server = {
    broadcastToSession(sessionKey: string, event: string, payload: any) {
      calls.push({ sessionKey, event, payload });
    },
  };
  return { server: server as any, calls };
}

describe("broadcastNotification", () => {
  test("broadcasts a notification.received event with id/title/body/timestamp", () => {
    const { server, calls } = makeMockServer();

    const ok = broadcastNotification(
      { sessionKey: "web:general", origin: "heartbeat", title: "Heartbeat Update", body: "All quiet." },
      { server },
    );

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionKey).toBe("web:general");
    expect(calls[0].event).toBe("notification.received");
    expect(calls[0].payload.sessionKey).toBe("web:general");
    expect(calls[0].payload.origin).toBe("heartbeat");
    expect(calls[0].payload.title).toBe("Heartbeat Update");
    expect(calls[0].payload.body).toBe("All quiet.");
    expect(typeof calls[0].payload.id).toBe("string");
    expect(calls[0].payload.id.length).toBeGreaterThan(8);
    expect(typeof calls[0].payload.timestamp).toBe("string");
  });

  test("falls back to origin when no title supplied", () => {
    const { server, calls } = makeMockServer();
    broadcastNotification({ sessionKey: "web:general", origin: "cron:standup", body: "hi" }, { server });
    expect(calls[0].payload.title).toBe("cron:standup");
  });

  test("each call mints a fresh id", () => {
    const { server, calls } = makeMockServer();
    broadcastNotification({ sessionKey: "web:general", origin: "heartbeat", body: "a" }, { server });
    broadcastNotification({ sessionKey: "web:general", origin: "heartbeat", body: "b" }, { server });
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.id).not.toBe(calls[1].payload.id);
  });

  test("strips <system-reminder> blocks before broadcast (reuses sanitizer)", () => {
    // Heartbeat agents occasionally imitate the system-reminder scratchpad in
    // their output — those must not leak into a channel notification.
    const { server, calls } = makeMockServer();
    broadcastNotification(
      {
        sessionKey: "web:general",
        origin: "heartbeat",
        body: "Real update.\n<system-reminder>internal scratchpad</system-reminder>\nMore update.",
      },
      { server },
    );
    expect(calls[0].payload.body).not.toContain("scratchpad");
    expect(calls[0].payload.body).toContain("Real update.");
    expect(calls[0].payload.body).toContain("More update.");
  });

  test("returns false and does not broadcast when body is empty after scrubbing", () => {
    const { server, calls } = makeMockServer();
    const ok = broadcastNotification(
      {
        sessionKey: "web:general",
        origin: "heartbeat",
        body: "<system-reminder>only scratchpad</system-reminder>",
      },
      { server },
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("returns false for an empty body", () => {
    const { server, calls } = makeMockServer();
    const ok = broadcastNotification({ sessionKey: "web:general", origin: "heartbeat", body: "" }, { server });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
