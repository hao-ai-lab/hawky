// =============================================================================
// E2E: send_photo over the real gateway tool.invoke path
//
// Exercises the FULL wire path the web-ios Live session uses to share a camera
// frame to Slack:
//
//   real WebSocket  ──connect/handshake──▶  GatewayServer
//        └─ rpc "tool.invoke" {tool_name:"send_photo", args:{image_base64,...}}
//               └─ tool.invoke surface → send_photo executor
//                      └─ ChannelRegistry.getOutbound("slack").sendFile(...)
//
// A MOCK Slack adapter is injected via setSendPhotoDeps, so the upload is
// observed in-process with NO real Slack network call. This is the e2e gap the
// unit tests (mock adapter, direct call) don't cover: the RPC dispatch, the
// extension surface gate, and the args→tool plumbing across a live socket.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { registerToolMethods } from "../src/gateway/tool-methods.js";
import { ChannelRegistry } from "../src/gateway/channel.js";
import { setSendPhotoDeps, resetSendPhotoDeps } from "../src/tools/send_photo.js";
import type { ChannelOutboundAdapter, OutboundSendResult } from "../src/gateway/channel-types.js";

// -----------------------------------------------------------------------------
// Helpers (mirrors tests/e2e-gateway.ts)
// -----------------------------------------------------------------------------

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

let reqId = 0;
function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  const id = `r${++reqId}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function connectAndHandshake(port: number, sessionKey?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", { version: "e2e-test", platform: "test", sessionKey });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

// A 1x1 JPEG, base64 — a valid tiny image payload.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

// Mock Slack adapter that records sendFile() calls instead of hitting Slack.
interface MockSlack extends ChannelOutboundAdapter {
  files: Array<{ to: string; filename: string; comment?: string; bytes: number }>;
}
function makeMockSlack(defaultRecipient = "U0DEFAULT01"): MockSlack {
  const files: MockSlack["files"] = [];
  return {
    channelId: "slack",
    files,
    isReady: () => true,
    async sendText(): Promise<OutboundSendResult> { return { ok: true, messageId: "m1" }; },
    async sendFile(o): Promise<OutboundSendResult> {
      files.push({ to: o.to, filename: o.filename, comment: o.comment, bytes: o.data.length });
      return { ok: true, messageId: "file1", channelId: o.to };
    },
    async stop() {},
    // Used by the tool for the default-DM fallback + name resolution.
    getDefaultRecipient: () => defaultRecipient,
    resolveRecipients: async () => [],
  } as MockSlack;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

let server: GatewayServer;
let port: number;

beforeEach(() => {
  resetGatewayState();
  resetSendPhotoDeps();
  server = new GatewayServer();
  port = getTestPort();
  registerToolMethods(server); // the real tool.invoke RPC and extension surface gate
});

afterEach(async () => {
  await server.stop(2000);
  resetGatewayState();
  resetSendPhotoDeps();
});

describe("E2E: send_photo via tool.invoke", () => {
  test("uploads the attached camera frame to the default Slack DM over the wire", async () => {
    const slack = makeMockSlack("U0B1M53CWQJ");
    const registry = new ChannelRegistry();
    registry.register(slack);
    setSendPhotoDeps(registry);

    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "send_photo",
        args: { image_base64: TINY_JPEG_B64, comment: "from e2e" },
        session_key: "web:ios",
      });

      // The server wraps a handler's return under `payload`; tool.invoke returns
      // { ok:true, result:<ToolResult> } for a successful upload.
      expect(res.ok).toBe(true);
      expect(res.payload?.ok).toBe(true);
      expect(res.payload?.result?.type).toBe("text");

      // The frame actually reached the adapter — default DM, JPEG, non-empty.
      expect(slack.files).toHaveLength(1);
      expect(slack.files[0].to).toBe("U0B1M53CWQJ");
      expect(slack.files[0].filename).toBe("photo.jpg");
      expect(slack.files[0].comment).toBe("from e2e");
      expect(slack.files[0].bytes).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  test("routes an explicit channel id straight through to the upload", async () => {
    const slack = makeMockSlack();
    const registry = new ChannelRegistry();
    registry.register(slack);
    setSendPhotoDeps(registry);

    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "send_photo",
        args: { image_base64: TINY_JPEG_B64, to: "C0TEAM00001" },
        session_key: "web:ios",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.ok).toBe(true);
      expect(slack.files[0].to).toBe("C0TEAM00001");
    } finally {
      ws.close();
    }
  });

  test("returns a tool error (not an RPC error, no upload) when the frame is missing", async () => {
    const slack = makeMockSlack();
    const registry = new ChannelRegistry();
    registry.register(slack);
    setSendPhotoDeps(registry);

    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "send_photo",
        args: {}, // no image_base64
        session_key: "web:ios",
      });
      // RPC frame succeeds; the tool contract surfaces the failure as ok:false.
      expect(res.ok).toBe(true);
      expect(res.payload?.ok).toBe(false);
      expect(String(res.payload?.error)).toMatch(/image_base64|camera/i);
      expect(slack.files).toHaveLength(0);
    } finally {
      ws.close();
    }
  });

  test("send_photo is in the tool.invoke surface; an unknown tool is rejected", async () => {
    setSendPhotoDeps(new ChannelRegistry()); // registry present but no slack adapter

    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      // Unknown tool → handler throws MethodError(INVALID_REQUEST); the frame is
      // ok:false and the error message lists the allowed tools, which must now
      // include send_photo.
      const bogus = await sendRequest(ws, "tool.invoke", { tool_name: "definitely_not_a_tool", args: {} });
      expect(bogus.ok).toBe(false);
      expect(String(bogus.error?.message)).toContain("send_photo");

      // send_photo is directly invocable: it reaches the tool, which then reports the
      // missing-adapter condition as a tool error (proves dispatch, not a 'not
      // invocable' rejection).
      const reached = await sendRequest(ws, "tool.invoke", {
        tool_name: "send_photo",
        args: { image_base64: TINY_JPEG_B64 },
      });
      expect(reached.ok).toBe(true);
      expect(reached.payload?.ok).toBe(false);
      expect(String(reached.payload?.error)).toMatch(/not configured|not available/i);
    } finally {
      ws.close();
    }
  });
});
