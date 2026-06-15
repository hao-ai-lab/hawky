// =============================================================================
// E2E: generate_chart over the real gateway tool.invoke path
//
// Mirrors the web-ios Live path: a real WebSocket connects, handshakes, and
// calls tool.invoke {tool_name:"generate_chart", args:{...}}. The gateway runs
// the REAL whitelist → executeGenerateChart, which renders a PNG in-process
// (canvas@3 + chart.js under bun) and returns ToolResult{type:"image"}. We
// assert a valid PNG comes back over the wire — no browser, no auth shim.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { registerToolMethods } from "../src/gateway/tool-methods.js";

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

function isPng(base64: string): boolean {
  const b = Buffer.from(base64, "base64");
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

let server: GatewayServer;
let port: number;

beforeEach(() => {
  resetGatewayState();
  server = new GatewayServer();
  port = getTestPort();
  registerToolMethods(server); // real tool.invoke + whitelist (incl. generate_chart)
});

afterEach(async () => {
  await server.stop(2000);
  resetGatewayState();
});

describe("E2E: generate_chart via tool.invoke", () => {
  test("renders a bar chart PNG over the wire", async () => {
    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "generate_chart",
        session_key: "web:ios",
        args: {
          type: "bar",
          title: "E2E Chart",
          labels: ["A", "B", "C", "D"],
          series: [{ label: "vals", data: [5, 9, 3, 7] }],
          yLabel: "count",
        },
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.ok).toBe(true);
      const r = res.payload?.result;
      expect(r?.type).toBe("image");
      expect(r?.media_type).toBe("image/png");
      expect(typeof r?.base64).toBe("string");
      expect(isPng(r.base64)).toBe(true);
      expect(r?.metadata?.chart_type).toBe("bar");
      expect(r?.metadata?.points).toBe(4);
    } finally {
      ws.close();
    }
  });

  test("renders a multi-series line chart", async () => {
    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "generate_chart",
        session_key: "web:ios",
        args: {
          type: "line",
          labels: ["Jan", "Feb", "Mar"],
          series: [
            { label: "2024", data: [5, 8, 6] },
            { label: "2025", data: [7, 9, 12] },
          ],
        },
      });
      expect(res.payload?.ok).toBe(true);
      expect(res.payload?.result?.type).toBe("image");
      expect(res.payload?.result?.metadata?.series_count).toBe(2);
      expect(isPng(res.payload.result.base64)).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("returns a tool error (not RPC error) when series is missing/empty", async () => {
    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "generate_chart",
        session_key: "web:ios",
        args: { type: "bar", series: [] },
      });
      expect(res.ok).toBe(true); // RPC frame fine
      expect(res.payload?.ok).toBe(false); // tool contract reports the error
      expect(String(res.payload?.error)).toMatch(/series|data/i);
    } finally {
      ws.close();
    }
  });

  test("generate_chart is whitelisted (unknown tool lists it)", async () => {
    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const bogus = await sendRequest(ws, "tool.invoke", { tool_name: "nope_not_a_tool", args: {} });
      expect(bogus.ok).toBe(false);
      expect(String(bogus.error?.message)).toContain("generate_chart");
    } finally {
      ws.close();
    }
  });
});
