// =============================================================================
// Mock WebSocket for testing
//
// Shared across ws-client and socket-store tests. Simulates the browser
// WebSocket API with auto-respond to "connect" handshake.
// =============================================================================

import { vi } from "vitest";

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
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
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  removeEventListener(type: string, handler: (event: any) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    }
  }

  send(data: string) {
    const frame = JSON.parse(data);
    if (frame.type === "req" && frame.method === "connect") {
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
  }

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code: code ?? 1000 });
  }

  // Test helpers
  emit(type: string, event: any) {
    for (const handler of this.listeners[type] ?? []) {
      handler(event);
    }
  }

  simulateServerMessage(data: unknown) {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

/** Install MockWebSocket globally and track instances. Returns the instances array. */
export function installMockWebSocket(): MockWebSocket[] {
  const instances: MockWebSocket[] = [];
  vi.stubGlobal("WebSocket", class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  });
  return instances;
}
