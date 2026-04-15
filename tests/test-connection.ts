// =============================================================================
// Gateway Connection Tests
//
// Covers the zombie-reaper behavior in GatewayConnection.sendEvent:
//   - ws.send() > 0  → returns true, no close
//   - ws.send() === 0 → socket is closed, close(1006) is invoked
//   - ws.send() === -1 → backpressure, returns false, socket kept alive
// =============================================================================

import { describe, expect, test, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { GatewayConnection, resetConnectionCounter, type WSData } from "../src/gateway/connection.js";
import type { EventFrame } from "../src/gateway/protocol.js";

interface FakeSocket {
  data: WSData;
  sendReturnValue: number;
  sendCalls: number;
  closeCalls: Array<{ code: number; reason: string }>;
  send(_: string | Buffer): number;
  close(code: number, reason: string): void;
}

function makeFakeSocket(sendReturnValue: number): FakeSocket {
  const socket: FakeSocket = {
    data: { connId: "" },
    sendReturnValue,
    sendCalls: 0,
    closeCalls: [],
    send(_raw) {
      socket.sendCalls++;
      return socket.sendReturnValue;
    },
    close(code, reason) {
      socket.closeCalls.push({ code, reason });
    },
  };
  return socket;
}

function makeConn(sendReturnValue: number): { conn: GatewayConnection; socket: FakeSocket } {
  const socket = makeFakeSocket(sendReturnValue);
  const conn = new GatewayConnection(socket as unknown as ServerWebSocket<WSData>, "127.0.0.1");
  return { conn, socket };
}

const frame: EventFrame = { type: "event", event: "test", payload: {}, seq: 1 };

describe("GatewayConnection.sendEvent", () => {
  beforeEach(() => resetConnectionCounter());

  test("returns true and does not close when send returns > 0", () => {
    const { conn, socket } = makeConn(42);
    expect(conn.sendEvent(frame)).toBe(true);
    expect(socket.sendCalls).toBe(1);
    expect(socket.closeCalls.length).toBe(0);
  });

  test("closes the socket with a valid (non-reserved) code when send returns 0", () => {
    const { conn, socket } = makeConn(0);
    expect(conn.sendEvent(frame)).toBe(false);
    expect(socket.sendCalls).toBe(1);
    expect(socket.closeCalls.length).toBe(1);
    // RFC 6455: 1005 and 1006 are reserved and MUST NOT be used in a close
    // frame — some runtimes throw if they are. We pick 1011 (server error).
    const code = socket.closeCalls[0]!.code;
    expect(code).not.toBe(1005);
    expect(code).not.toBe(1006);
    expect(code).toBe(1011);
  });

  test("does not close on backpressure (-1)", () => {
    const { conn, socket } = makeConn(-1);
    expect(conn.sendEvent(frame)).toBe(false);
    expect(socket.sendCalls).toBe(1);
    expect(socket.closeCalls.length).toBe(0);
  });

  test("swallows send exceptions and returns false", () => {
    const socket = makeFakeSocket(1);
    socket.send = () => {
      throw new Error("boom");
    };
    const conn = new GatewayConnection(socket as unknown as ServerWebSocket<WSData>, "127.0.0.1");
    expect(conn.sendEvent(frame)).toBe(false);
  });

  test("tolerates close() itself throwing after send returns 0", () => {
    const socket = makeFakeSocket(0);
    socket.close = () => {
      throw new Error("already closed");
    };
    const conn = new GatewayConnection(socket as unknown as ServerWebSocket<WSData>, "127.0.0.1");
    // Should not propagate the close() error
    expect(conn.sendEvent(frame)).toBe(false);
  });
});
