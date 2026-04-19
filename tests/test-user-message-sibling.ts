// =============================================================================
// Tests: user.message sibling delivery
//
// Proves the broadcastToSession primitive used by chat.send actually fans out
// to all connections bound to the same sessionKey — so a sibling browser on
// the same session sees the "user.message" event. The event-payload shape
// and emission ordering are covered by test-chat-send-user-broadcast.ts;
// this file only asserts the sibling-visibility guarantee end-to-end.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";

let server: GatewayServer;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("Connection failed")));
  });
}

function rpc(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `t-${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 3000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        if (data.ok) resolve(data.payload);
        else reject(new Error(data.error?.message ?? "rpc error"));
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Event timeout: ${eventName}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "event" && data.event === eventName) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data.payload);
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("user.message sibling delivery", () => {
  beforeEach(async () => {
    resetGatewayState();
    server = new GatewayServer();
    server.start(0);
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop(1000);
  });

  test("clients bound to the same session both receive a user.message broadcast", async () => {
    const wsA = await connectWs();
    const wsB = await connectWs();
    await rpc(wsA, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:shared" });
    await rpc(wsB, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:shared" });

    const bReceived = waitForEvent(wsB, "user.message");
    server.broadcastToSession("web:shared", "user.message", {
      type: "user.message",
      sessionKey: "web:shared",
      text: "hi from A",
      messageId: "srv-1",
      timestamp: new Date().toISOString(),
    });
    const payload = await bReceived;
    expect(payload.text).toBe("hi from A");
    expect(payload.sessionKey).toBe("web:shared");

    wsA.close();
    wsB.close();
  });

  test("clients on a DIFFERENT session do not receive the broadcast", async () => {
    const wsA = await connectWs();
    const wsC = await connectWs();
    await rpc(wsA, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:shared" });
    await rpc(wsC, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:other" });

    let cGotIt = false;
    wsC.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === "event" && data.event === "user.message") cGotIt = true;
    });

    server.broadcastToSession("web:shared", "user.message", {
      type: "user.message",
      sessionKey: "web:shared",
      text: "only for web:shared",
      messageId: "srv-2",
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(cGotIt).toBe(false);

    wsA.close();
    wsC.close();
  });

  test("sender (excludeClientId) does NOT receive the broadcast; sibling client does", async () => {
    // End-to-end proof: passing the sender's clientId to broadcastToSession
    // prevents that client from seeing its own user.message echo. A sibling
    // client (different clientId) on the same session still receives it.
    const wsA = await connectWs();
    await rpc(wsA, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:exclude", clientId: "client-A" });
    const wsB = await connectWs();
    await rpc(wsB, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:exclude", clientId: "client-B" });

    let aGotIt = false;
    wsA.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === "event" && data.event === "user.message") aGotIt = true;
    });
    const bReceived = waitForEvent(wsB, "user.message");

    server.broadcastToSession(
      "web:exclude",
      "user.message",
      {
        type: "user.message",
        sessionKey: "web:exclude",
        text: "sent from A",
        messageId: "srv-3",
        timestamp: new Date().toISOString(),
      },
      "client-A",
    );

    const payload = await bReceived;
    expect(payload.text).toBe("sent from A");
    await new Promise((r) => setTimeout(r, 100));
    expect(aGotIt).toBe(false);

    wsA.close();
    wsB.close();
  });

  test("multi-socket same-client: BOTH sockets are excluded by clientId", async () => {
    // Regression for the duplicate-bubble + bubble-disappears bugs (PRs
    // #165, #176): the gateway used to exclude only the originating
    // connId, so a second WS connection from the same logical client
    // (PWA service worker, transient reconnect overlap, dev tunnel)
    // would still receive the broadcast and the client would echo it
    // locally. Excluding by stable clientId fixes this structurally.
    const wsA1 = await connectWs();
    const wsA2 = await connectWs();
    const wsB = await connectWs();
    await rpc(wsA1, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:multi", clientId: "client-A" });
    await rpc(wsA2, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:multi", clientId: "client-A" });
    await rpc(wsB, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:multi", clientId: "client-B" });

    let a1GotIt = false;
    let a2GotIt = false;
    wsA1.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === "event" && data.event === "user.message") a1GotIt = true;
    });
    wsA2.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === "event" && data.event === "user.message") a2GotIt = true;
    });
    const bReceived = waitForEvent(wsB, "user.message");

    server.broadcastToSession(
      "web:multi",
      "user.message",
      {
        type: "user.message",
        sessionKey: "web:multi",
        text: "from A's primary tab",
        messageId: "srv-multi-1",
        timestamp: new Date().toISOString(),
      },
      "client-A",
    );

    const payload = await bReceived;
    expect(payload.text).toBe("from A's primary tab");
    await new Promise((r) => setTimeout(r, 100));
    expect(a1GotIt).toBe(false);
    expect(a2GotIt).toBe(false);

    wsA1.close();
    wsA2.close();
    wsB.close();
  });

  test("clientId omitted in handshake → falls back to per-conn id (legacy clients)", async () => {
    // A client that doesn't send clientId still gets correct exclusion
    // within its own single socket: GatewayConnection defaults clientId
    // to its own connId. So when the handler passes conn.clientId the
    // gateway skips that one socket — which is identical to the old
    // single-conn behavior. Older clients keep working unchanged.
    const wsA = await connectWs();
    await rpc(wsA, "connect", { version: "0.1.0", platform: "web", sessionKey: "web:legacy" });
    const aConn = Array.from(server.getConnections().values())
      .find((c) => c.sessionKey === "web:legacy");
    expect(aConn).toBeDefined();
    expect(aConn!.clientId).toBe(aConn!.connId);

    let aGotIt = false;
    wsA.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data as string);
      if (data.type === "event" && data.event === "user.message") aGotIt = true;
    });

    server.broadcastToSession(
      "web:legacy",
      "user.message",
      {
        type: "user.message",
        sessionKey: "web:legacy",
        text: "skip me",
        messageId: "srv-legacy",
        timestamp: new Date().toISOString(),
      },
      aConn!.clientId,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(aGotIt).toBe(false);

    wsA.close();
  });
});
