// =============================================================================
// Integration Tests: Live Provider Swap (OpenAI-compatible mock server)
//
// Exercises the full swap wire path:
//   mock Bun.serve OpenAI endpoint → createProvider → OpenAIProvider → fetch
//
// Scope: AgentSessionManager + real OpenAIProvider + real fetch to mock server.
// Does NOT boot GatewayServer — too heavy for an integration suite.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSessionManager } from "../../src/gateway/agent-sessions.js";
import { OpenAIProvider } from "../../src/agent/openai_provider.js";
import { AnthropicProvider } from "../../src/agent/anthropic_provider.js";
import type { HawkyConfig } from "../../src/agent/types.js";
import {
  setConfigDir,
  resetConfigDir,
  resetConfig,
  saveConfig,
  loadConfig,
} from "../../src/storage/config.js";
import { setSessionsDir, resetSessionsDir } from "../../src/storage/session.js";
import { setWorkspaceDir } from "../../src/storage/workspace.js";

// =============================================================================
// Helpers
// =============================================================================

let testDir: string;
let sessions: AgentSessionManager;

function baseConfig(overrides: Partial<HawkyConfig> = {}): HawkyConfig {
  return {
    api_keys: { anthropic: "sk-ant-test", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "gpt-test",
    max_tokens: 512,
    max_iterations: 10,
    max_tool_result_chars: 10000,
    workspace_dir: join(testDir, "workspace"),
    gateway_port: 4242,
    heartbeat: {
      enabled: false,
      interval_minutes: 30,
      keep_recent_messages: 32,
      active_hours: { start: "00:00", end: "23:59", timezone: "local" },
      consolidation_enabled: false,
      consolidation_frequency_hours: 12,
      consolidation_days: 3,
      distillation_enabled: false,
      distillation_frequency_hours: 6,
      distillation_min_new_messages: 10,
    },
    cron: { enabled: false },
    memory_flush: { enabled: false, threshold_percent: 90 },
    compaction: {
      enabled: false, threshold_percent: 95, blocking_percent: 98,
      keep_recent_turns: 20, max_failures: 3,
    },
    concurrency: { main_max: 4, cron_max: 4, subagent_max: 8 },
    media: { retention: { audio_days: 7, video_days: 3 } },
    ...overrides,
  } as HawkyConfig;
}

// Build a minimal OpenAI SSE streaming response for a simple text reply.
function makeStreamResponse(text: string): Response {
  const chunks = [
    // message_start equivalent chunk
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-test",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
    // text delta
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-test",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }),
    // finish
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "gpt-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    "[DONE]",
  ];
  const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `provider-swap-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(testDir, "sessions"), { recursive: true });
  mkdirSync(join(testDir, "workspace"), { recursive: true });

  setConfigDir(testDir);
  resetConfig();
  setSessionsDir(join(testDir, "sessions"));
  setWorkspaceDir(join(testDir, "workspace"));
});

afterEach(() => {
  resetConfig();
  resetConfigDir();
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// =============================================================================
// Mock server boot helper
// =============================================================================

function bootMockOpenAI(opts: {
  captureRequests?: Array<{ path: string; body: unknown }>;
  chatResponse?: string;
}): { server: ReturnType<typeof Bun.serve>; baseUrl: string } {
  const requests = opts.captureRequests ?? [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return Response.json({ object: "list", data: [{ id: "gpt-test", object: "model" }] });
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body: unknown = null;
        try { body = await req.json(); } catch {}
        requests.push({ path: url.pathname, body });
        return makeStreamResponse(opts.chatResponse ?? "hello from mock");
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

// =============================================================================
// Tests
// =============================================================================

describe("provider swap — openai_compatible profile", () => {
  test("swapProvider to openai_compatible:local-mock returns ok:true", () => {
    const { server, baseUrl } = bootMockOpenAI({});
    try {
      const cfg = baseConfig({
        openai_compatible: {
          active_profile: undefined,
          profiles: {
            "local-mock": { base_url: baseUrl, api_key: "sk-mock" },
          },
        },
      });
      saveConfig(cfg);
      resetConfig();
      sessions = new AgentSessionManager({
        provider: new AnthropicProvider("sk-ant-test"),
        config: loadConfig(),
        workingDirectory: join(testDir, "workspace"),
      });

      const result = sessions.swapProvider({
        provider: "openai_compatible",
        active_profile: "local-mock",
      });
      expect(result).toEqual({ ok: true });
      expect(sessions.getActiveProvider()).toBeInstanceOf(OpenAIProvider);
    } finally {
      server.stop();
    }
  });

  test("active provider after swap is OpenAIProvider pointing at mock server", async () => {
    const captured: Array<{ path: string; body: unknown }> = [];
    const { server, baseUrl } = bootMockOpenAI({ captureRequests: captured, chatResponse: "pong" });
    try {
      const cfg = baseConfig({
        openai_compatible: {
          active_profile: undefined,
          profiles: { "local-mock": { base_url: baseUrl, api_key: "sk-mock" } },
        },
      });
      saveConfig(cfg);
      resetConfig();
      sessions = new AgentSessionManager({
        provider: new AnthropicProvider("sk-ant-test"),
        config: loadConfig(),
        workingDirectory: join(testDir, "workspace"),
      });

      sessions.swapProvider({ provider: "openai_compatible", active_profile: "local-mock" });

      // Drive one turn through the live provider → real fetch to mock server
      const session = sessions.getOrCreate("integ:swap-test");
      const received: string[] = [];
      const unsub = session.loop.subscribe((ev) => {
        if (ev.type === "text") received.push(ev.content as string);
      });

      await session.loop.sendMessage("ping");
      unsub();

      // The mock server must have received the POST
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].path).toBe("/v1/chat/completions");
      // The agent received the mocked reply
      expect(received.join("")).toContain("pong");
    } finally {
      server.stop();
    }
  });

  test("swap back to anthropic updates getActiveProvider", () => {
    const { server, baseUrl } = bootMockOpenAI({});
    try {
      const cfg = baseConfig({
        openai_compatible: {
          active_profile: undefined,
          profiles: { "local-mock": { base_url: baseUrl, api_key: "sk-mock" } },
        },
      });
      saveConfig(cfg);
      resetConfig();
      sessions = new AgentSessionManager({
        provider: new AnthropicProvider("sk-ant-test"),
        config: loadConfig(),
        workingDirectory: join(testDir, "workspace"),
      });

      sessions.swapProvider({ provider: "openai_compatible", active_profile: "local-mock" });
      expect(sessions.getActiveProvider()).toBeInstanceOf(OpenAIProvider);

      sessions.swapProvider({ provider: "anthropic" });
      expect(sessions.getActiveProvider()).toBeInstanceOf(AnthropicProvider);
    } finally {
      server.stop();
    }
  });

  test("swapProvider refused while session loop is running (in-flight guard)", () => {
    const { server, baseUrl } = bootMockOpenAI({});
    try {
      const cfg = baseConfig({
        openai_compatible: {
          active_profile: undefined,
          profiles: { "local-mock": { base_url: baseUrl, api_key: "sk-mock" } },
        },
      });
      saveConfig(cfg);
      resetConfig();
      sessions = new AgentSessionManager({
        provider: new AnthropicProvider("sk-ant-test"),
        config: loadConfig(),
        workingDirectory: join(testDir, "workspace"),
      });

      const session = sessions.getOrCreate("integ:in-flight");
      // Simulate an in-flight turn by setting the loop's internal flag
      (session.loop as any).running = true;
      const result = sessions.swapProvider({
        provider: "openai_compatible",
        active_profile: "local-mock",
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain("in-flight turn");
      (session.loop as any).running = false;
    } finally {
      server.stop();
    }
  });

  test("swapProvider refuses unknown profile", () => {
    const cfg = baseConfig();
    saveConfig(cfg);
    resetConfig();
    sessions = new AgentSessionManager({
      provider: new AnthropicProvider("sk-ant-test"),
      config: loadConfig(),
      workingDirectory: join(testDir, "workspace"),
    });

    const result = sessions.swapProvider({
      provider: "openai_compatible",
      active_profile: "does-not-exist",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/profile/i);
  });

  test("GET /v1/models on mock server returns gpt-test", async () => {
    const { server, baseUrl } = bootMockOpenAI({});
    try {
      const resp = await fetch(`${baseUrl}/models`);
      expect(resp.ok).toBe(true);
      const body = await resp.json() as any;
      expect(body.data[0].id).toBe("gpt-test");
    } finally {
      server.stop();
    }
  });
});
