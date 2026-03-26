// =============================================================================
// Gateway Client Tests
//
// Focused protocol-level tests for client-side event routing.
// =============================================================================

import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../src/agent/types.js";
import { GatewayClient } from "../src/gateway/gateway-client.js";

function makeClient(overrides?: {
  onHeartbeatEvent?: (event: string, payload: unknown) => void;
}) {
  return new GatewayClient({
    url: "ws://localhost:4242",
    sessionKey: "tui:main",
    workingDirectory: "/tmp",
    ...overrides,
  });
}

describe("GatewayClient heartbeat event routing", () => {
  test("forwards heartbeat events to onHeartbeatEvent", () => {
    const received: Array<{ event: string; payload: unknown }> = [];
    const client = makeClient({
      onHeartbeatEvent: (event, payload) => {
        received.push({ event, payload });
      },
    });

    (client as any).handleMessage(JSON.stringify({
      type: "event",
      event: "heartbeat.started",
      payload: { timestamp: 123 },
      seq: 1,
    }));

    (client as any).handleMessage(JSON.stringify({
      type: "event",
      event: "heartbeat.completed",
      payload: { status: "skipped", reason: "no-tasks" },
      seq: 2,
    }));

    expect(received).toEqual([
      { event: "heartbeat.started", payload: { timestamp: 123 } },
      { event: "heartbeat.completed", payload: { status: "skipped", reason: "no-tasks" } },
    ]);
  });

  test("does not emit heartbeat events to normal agent subscribers", () => {
    const client = makeClient();
    const events: StreamEvent[] = [];
    client.subscribe((event) => {
      events.push(event);
    });

    (client as any).handleMessage(JSON.stringify({
      type: "event",
      event: "heartbeat.completed",
      payload: { status: "skipped", reason: "quiet-hours" },
      seq: 1,
    }));

    expect(events).toEqual([]);
  });

  test("still emits agent events to subscribers", () => {
    const client = makeClient();
    const events: StreamEvent[] = [];
    client.subscribe((event) => {
      events.push(event);
    });

    (client as any).handleMessage(JSON.stringify({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "hello" },
      seq: 1,
    }));

    expect(events).toEqual([{ type: "text", content: "hello" }]);
  });
});
