// =============================================================================
// Tests: Socket Store (Zustand)
//
// Unit tests for the Zustand store. Verifies state management, event
// dispatch, and connection lifecycle without a real WebSocket.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSocketStore } from "../src/store/socket-store";
import type { EventFrame } from "@hawky/protocol";
import { type MockWebSocket, installMockWebSocket } from "./helpers/mock-websocket";

let mockWsInstances: MockWebSocket[] = [];

beforeEach(() => {
  mockWsInstances = installMockWebSocket();

  // Reset store state
  useSocketStore.setState({
    status: "disconnected",
    error: null,
    client: null,
    eventListeners: new Set(),
  });
});

afterEach(() => {
  // Cleanup any connections
  const client = useSocketStore.getState().client;
  if (client) client.close();
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("useSocketStore", () => {
  it("starts with disconnected status", () => {
    expect(useSocketStore.getState().status).toBe("disconnected");
  });

  it("connects and updates status to connected", async () => {
    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "test",
      token: "test-token",
    });

    expect(useSocketStore.getState().status).toBe("connected");
    expect(useSocketStore.getState().client).not.toBeNull();
    expect(useSocketStore.getState().error).toBeNull();
  });

  it("disconnect clears client and sets disconnected", async () => {
    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "test",
      token: "test-token",
    });

    useSocketStore.getState().disconnect();

    expect(useSocketStore.getState().status).toBe("disconnected");
    expect(useSocketStore.getState().client).toBeNull();
  });

  it("rpc sends request through client", async () => {
    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "test",
      token: "test-token",
    });

    const rpcPromise = useSocketStore.getState().rpc("session.list", { limit: 5 });

    // Simulate response
    await new Promise((r) => setTimeout(r, 10));
    mockWsInstances[0].simulateServerMessage({
      type: "res",
      id: "req-2",
      ok: true,
      payload: { sessions: ["a", "b"] },
    });

    const result = await rpcPromise;
    expect(result).toEqual({ sessions: ["a", "b"] });
  });

  it("rpc throws when not connected", async () => {
    await expect(
      useSocketStore.getState().rpc("test"),
    ).rejects.toThrow("Not connected");
  });

  it("subscribe receives events from gateway", async () => {
    const events: EventFrame[] = [];
    const unsub = useSocketStore.getState().subscribe((e) => events.push(e));

    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "test",
      token: "test-token",
    });

    mockWsInstances[0].simulateServerMessage({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "hello" },
    });

    expect(events.length).toBe(1);
    expect(events[0].event).toBe("agent.text");

    unsub();
  });

  it("unsubscribe stops receiving events", async () => {
    const events: EventFrame[] = [];
    const unsub = useSocketStore.getState().subscribe((e) => events.push(e));

    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "test",
      token: "test-token",
    });

    unsub();

    mockWsInstances[0].simulateServerMessage({
      type: "event",
      event: "agent.text",
      payload: { type: "text", content: "after unsub" },
    });

    expect(events.length).toBe(0);
  });

  it("connect replaces existing client", async () => {
    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "session1",
      token: "test-token",
    });

    const firstClient = useSocketStore.getState().client;

    await useSocketStore.getState().connect({
      url: "ws://localhost:4242",
      sessionKey: "session2",
      token: "test-token",
    });

    const secondClient = useSocketStore.getState().client;
    expect(secondClient).not.toBe(firstClient);
  });
});
