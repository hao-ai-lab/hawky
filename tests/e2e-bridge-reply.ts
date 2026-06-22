// =============================================================================
// E2E: chat.send returns the agent's reply + chart image (Fix A)
//
// The web-ios Live tab delegates to the backend via session_send_message →
// chat.send on a "-bridge" session. Previously chat.send returned only a static
// ack, so the backend's answer (and any chart) never reached the live
// transcript. This test drives the REAL registerAgentMethods chat.send handler
// with a mock provider that (1) calls the real generate_chart tool, then (2)
// replies with text — and asserts the RPC return now includes:
//   • reply: the assistant's final text
//   • image: { base64, media_type } — the chart PNG produced by the tool
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetWsPermissions } from "../src/gateway/ws-permission.js";
import type { LLMProvider } from "../src/agent/provider.js";
import type { HawkyConfig } from "../src/agent/types.js";
import type { ResponseFrame } from "../src/gateway/protocol.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";

let testDir: string;

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeConfig(): HawkyConfig {
  return {
    api_keys: { anthropic: "mock", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "mock-model",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: { enabled: false, interval_minutes: 30, keep_recent_messages: 8, active_hours: { start: "08:00", end: "22:00" } },
  };
}

/** Provider that calls a tool on turn 1, then replies with text on turn 2. */
function createToolThenTextProvider(toolName: string, toolInput: Record<string, unknown>, text: string): LLMProvider {
  let callCount = 0;
  return {
    async *stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "message_start" as const, message_id: "m1", model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
        yield { type: "tool_use_start" as const, index: 0, id: "tool_1", name: toolName };
        yield { type: "tool_use_input_delta" as const, partial_json: JSON.stringify(toolInput) };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "tool_use", usage: { output_tokens: 10 } };
        yield { type: "message_stop" as const };
      } else {
        yield { type: "message_start" as const, message_id: "m2", model: "mock", usage: { input_tokens: 20, output_tokens: 5 } };
        yield { type: "text_delta" as const, text };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 10 } };
        yield { type: "message_stop" as const };
      }
    },
  };
}

let reqId = 0;
function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<ResponseFrame> {
  const id = `r${++reqId}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 30000);
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
  const res = await sendRequest(ws, "connect", { version: "test", platform: "test", sessionKey });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

let server: GatewayServer;
let port: number;

function setupGateway(provider: LLMProvider): void {
  resetGatewayState();
  applyDefaultLaneConcurrency();
  server = new GatewayServer();
  const sessions = new AgentSessionManager({ provider, config: makeConfig(), workingDirectory: "/tmp", server });
  server.setActiveSessionCounter(() => sessions.size);
  registerAgentMethods(server, sessions);
  port = getTestPort();
  server.start(port);
}

function isPng(base64: string): boolean {
  const b = Buffer.from(base64, "base64");
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-e2e-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  setSessionsDir(testDir);
  resetWsPermissions();
});

afterEach(async () => {
  if (server) await server.stop(2000);
  resetGatewayState();
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("E2E: chat.send returns reply + chart image (Fix A)", () => {
  test("a turn that calls generate_chart returns reply text AND the chart image", async () => {
    // Mock agent: turn 1 calls generate_chart (REAL tool → real PNG), turn 2 replies.
    setupGateway(
      createToolThenTextProvider(
        "generate_chart",
        { type: "bar", title: "Apple Revenue", labels: ["FY23", "FY24", "FY25"], series: [{ label: "Rev", data: [383, 391, 416] }] },
        "Here's Apple's revenue for the last 3 fiscal years.",
      ),
    );
    // A "-bridge" session, like the live tab delegates to.
    const ws = await connectAndHandshake(port, "web:ios-test-bridge");
    try {
      const res = await sendRequest(ws, "chat.send", { message: "chart apple revenue" });
      expect(res.ok).toBe(true);
      const payload = res.payload as { completed?: boolean; reply?: string; image?: { base64?: string; media_type?: string } };

      // Fix A: the reply text comes back (no longer a static ack).
      expect(payload.completed).toBe(true);
      expect(payload.reply).toContain("Apple's revenue");

      // Fix A: the chart image comes back as base64 PNG.
      expect(payload.image).toBeDefined();
      expect(payload.image?.media_type).toBe("image/png");
      expect(typeof payload.image?.base64).toBe("string");
      expect(isPng(payload.image!.base64!)).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("a text-only turn returns reply but no image", async () => {
    setupGateway(createToolThenTextProvider("generate_chart", { series: [] }, "ignored"));
    // Override with a pure-text provider via a fresh setup.
    await server.stop(2000);
    setupGateway({
      async *stream() {
        yield { type: "message_start" as const, message_id: "t", model: "mock", usage: { input_tokens: 5, output_tokens: 5 } };
        yield { type: "text_delta" as const, text: "Just a text answer, no chart." };
        yield { type: "content_block_stop" as const, index: 0 };
        yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
        yield { type: "message_stop" as const };
      },
    });
    const ws = await connectAndHandshake(port, "web:ios-text-bridge");
    try {
      const res = await sendRequest(ws, "chat.send", { message: "hi" });
      const payload = res.payload as { reply?: string; image?: unknown };
      expect(res.ok).toBe(true);
      expect(payload.reply).toContain("text answer");
      expect(payload.image).toBeUndefined(); // no tool image this turn
    } finally {
      ws.close();
    }
  });
});
