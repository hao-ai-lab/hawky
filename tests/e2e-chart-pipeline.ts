// =============================================================================
// E2E: chart pipeline over the REAL gateway WebSocket tool.invoke path
//
// This proves the full web-ios Live path end-to-end: a real WebSocket connects
// to a real GatewayServer, handshakes, and calls tool.invoke
// {tool_name:"generate_chart", args:{...}}. The gateway runs the REAL whitelist
// → executeGenerateChart, which renders a PNG in-process (canvas@3 + chart.js
// under bun) and returns ToolResult{type:"image"}. We assert a valid PNG comes
// back over the wire — no browser, no auth shim.
//
// Mirrors tests/e2e-generate-chart.ts (same GatewayServer + registerToolMethods
// + real WS connect/handshake), focused on the realistic Apple Revenue chart.
//
// Run with:
//   bun test --timeout 30000 --max-concurrency=1 ./tests/e2e-chart-pipeline.ts
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

describe("E2E: chart pipeline via real gateway WS tool.invoke", () => {
  test("renders the Apple Revenue bar chart PNG over the wire", async () => {
    server.start(port);
    const ws = await connectAndHandshake(port, "web:ios");
    try {
      const res = await sendRequest(ws, "tool.invoke", {
        tool_name: "generate_chart",
        session_key: "web:ios",
        args: {
          type: "bar",
          title: "Apple Revenue (FY, $B)",
          labels: ["FY20", "FY21", "FY22", "FY23", "FY24"],
          series: [{ label: "Revenue", data: [274, 366, 394, 383, 391] }],
          yLabel: "$B",
        },
      });

      // RPC frame is fine.
      expect(res.ok).toBe(true);
      // Tool contract reports success.
      expect(res.payload?.ok).toBe(true);

      const r = res.payload?.result;
      expect(r?.type).toBe("image");
      expect(r?.media_type).toBe("image/png");
      expect(typeof r?.base64).toBe("string");
      // The base64 is a valid PNG (magic bytes 89 50 4E 47).
      expect(isPng(r.base64)).toBe(true);
      // Five data points => metadata.points === 5.
      expect(r?.metadata?.points).toBe(5);
      expect(r?.metadata?.chart_type).toBe("bar");
    } finally {
      ws.close();
    }
  });
});
