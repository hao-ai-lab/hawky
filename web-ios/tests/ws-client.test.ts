import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketClient } from "../src/lib/ws-client";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  private listeners: Record<string, Array<(event: any) => void>> = {};

  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", {});
    }, 0);
  }

  addEventListener(type: string, handler: (event: any) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), handler];
  }

  send(data: string) {
    const frame = JSON.parse(data);
    if (frame.type !== "req" || frame.method !== "connect") return;
    setTimeout(() => {
      this.emit("message", {
        data: JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { connId: "mock-conn", serverVersion: "0.1.0", methods: [] },
        }),
      });
    }, 0);
  }

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: code ?? 1000 });
  }

  emit(type: string, event: any) {
    for (const handler of this.listeners[type] ?? []) {
      handler(event);
    }
  }
}

let mockWsInstances: MockWebSocket[] = [];

beforeEach(() => {
  mockWsInstances = [];
  vi.stubGlobal("WebSocket", class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstances.push(this);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("WebSocketClient", () => {
  it("does not reconnect after auth refresh resolves if the client was closed", async () => {
    let resolveToken!: (token: string | null) => void;
    const onAuthFailed = vi.fn(
      () => new Promise<string | null>((resolve) => { resolveToken = resolve; }),
    );
    const client = new WebSocketClient({
      url: "ws://localhost:4242",
      sessionKey: "web:ios",
      token: "old-token",
      onAuthFailed,
    });
    await client.connect();

    mockWsInstances[0].close(1008);
    await tick();
    expect(onAuthFailed).toHaveBeenCalledTimes(1);

    client.close();
    resolveToken("new-token");
    await tick();

    expect(mockWsInstances).toHaveLength(1);
    expect(client.status).toBe("disconnected");
  });
});
