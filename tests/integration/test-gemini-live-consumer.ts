// =============================================================================
// gemini-live-channel — integration test.
//
// Slice 3 (priority-stream-ingest). Verifies:
//   • Consumer subscribes to `media.live.chunk` on startup.
//   • First chunk for a session_key opens a WS, sends setup with the default
//     live prompt.
//   • Subsequent frames + audio are forwarded via realtimeInput video/audio
//     with the expected mimeTypes.
//   • Server-issued tool calls (memory_append / channel_send) route into
//     the existing tool handler registry, and a toolResponse is sent back.
//   • On server `turnComplete`, the accumulated text is persisted as an
//     assistant message on the voice session.
//   • The consumer skips registration (no-ops) when provider="none" or when
//     GEMINI_API_KEY is absent.
//
// All mocks. No network, no live WS, no live LLM calls.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBus, resetBus } from "../../src/bus/index.js";
import { setWorkspaceDir } from "../../src/storage/workspace.js";
import type { MediaLiveChunkEvent } from "../../src/bus/events.js";
import {
  GEMINI_LIVE_TOOL_EXTENSION_MANIFEST,
  registerGeminiLiveConsumer,
  GEMINI_LIVE_DEFAULT_PROMPT,
  getGeminiLiveFunctionDeclarations,
  getGeminiLiveToolNames,
  type GeminiLiveConsumerConfig,
} from "../../src/consumers/gemini-live-channel/index.js";
import { resolveGeminiLiveConsumerConfig } from "../../src/consumers/gemini-live-channel/config.js";
import type { WebSocketLike } from "../../src/consumers/gemini-live-channel/client.js";
import {
  resetChannelSendDeps,
  setChannelSendDeps,
} from "../../src/tools/channel_send.js";

// -----------------------------------------------------------------------------
// Fake WebSocket — records outgoing messages, lets the test push fake server
// messages back in.
// -----------------------------------------------------------------------------

class FakeWs implements WebSocketLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(ev: { data: unknown }) => void> = [];
  private closeHandlers: Array<(ev: { code: number; reason: string }) => void> = [];
  private errorHandlers: Array<(ev: unknown) => void> = [];

  constructor(public readonly url: string) {
    // Defer open so addEventListener("open", ...) can run first.
    queueMicrotask(() => {
      for (const h of this.openHandlers) h();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
    for (const h of this.closeHandlers) {
      h({ code: _code ?? 1000, reason: _reason ?? "" });
    }
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: string, listener: any): void {
    if (type === "open") this.openHandlers.push(listener);
    else if (type === "message") this.messageHandlers.push(listener);
    else if (type === "close") this.closeHandlers.push(listener);
    else if (type === "error") this.errorHandlers.push(listener);
  }

  /** Test helper — push a fake server message. */
  pushServer(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const h of this.messageHandlers) h({ data });
  }

  /** Parse all captured outgoing frames as JSON. */
  outgoing(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

// -----------------------------------------------------------------------------
// Mock AgentSessionManager — captures appendMessage calls so we can assert
// turn-complete summaries get persisted.
// -----------------------------------------------------------------------------

class MockSessionManager {
  appended: Array<{ role: string; content: any[]; timestamp?: string }> = [];
  appendMessage(m: { role: string; content: any[]; timestamp?: string }): void {
    this.appended.push(m);
  }
  initSession(): void {}
  loadSession(): null { return null; }
}

class MockLoop {
  private history: any[] = [];
  getHistory(): any[] { return this.history; }
  setHistory(h: any[]): void { this.history = h; }
  async sendMessage(_t: string): Promise<void> {}
}

class MockSessions {
  sessions = new Map<string, { loop: MockLoop; sessionManager: MockSessionManager }>();
  getOrCreate(key: string) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { loop: new MockLoop(), sessionManager: new MockSessionManager() };
      this.sessions.set(key, s);
    }
    return s;
  }
  has(key: string): boolean { return this.sessions.has(key); }
}

class MockServer {
  broadcasts: Array<{ event: string; payload: unknown }> = [];
  sessionBroadcasts: Array<{ sessionKey: string; event: string; payload: any }> = [];
  broadcast(event: string, payload: unknown): void {
    this.broadcasts.push({ event, payload });
  }
  broadcastToSession(sessionKey: string, event: string, payload?: unknown): void {
    this.sessionBroadcasts.push({ sessionKey, event, payload });
  }
  /** Downlink `live.*` events in arrival order. */
  liveEvents(): Array<{ event: string; payload: any }> {
    return this.sessionBroadcasts
      .filter((b) => b.event.startsWith("live."))
      .map((b) => ({ event: b.event, payload: b.payload }));
  }
}

// -----------------------------------------------------------------------------
// Test env setup
// -----------------------------------------------------------------------------

let workDir: string;
let prevWorkspace: string | undefined;

function makeChunkFile(
  dir: string,
  name: string,
  bytes: Buffer,
): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, bytes);
  return full;
}

beforeEach(() => {
  resetBus();
  resetChannelSendDeps();
  workDir = join(tmpdir(), `gemini-live-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workDir, { recursive: true });
  prevWorkspace = process.env.HAWKY_WORKSPACE;
  process.env.HAWKY_WORKSPACE = workDir;
  setWorkspaceDir(workDir);
});

afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (prevWorkspace === undefined) delete process.env.HAWKY_WORKSPACE;
  else process.env.HAWKY_WORKSPACE = prevWorkspace;
  resetChannelSendDeps();
  resetBus();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function baseConfig(overrides: Partial<GeminiLiveConsumerConfig> = {}): GeminiLiveConsumerConfig {
  return {
    provider: "gemini-live",
    model: "models/gemini-test",
    idle_reaper_ms: 30_000,
    tools_enabled: true,
    response_modalities: ["TEXT"],
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("gemini-live-consumer — registration gating", () => {
  test("provider=none → no-op, no subscribers added", () => {
    const sessions = new MockSessions();
    const before = (getBus() as any)._subscriberCountFor("media.live.chunk");
    const unsub = registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig({ provider: "none" }),
      apiKeyProvider: () => "fake-key",
    });
    const after = (getBus() as any)._subscriberCountFor("media.live.chunk");
    expect(after).toBe(before);
    unsub();
  });

  test("missing API key → logs warning and skips (no subscription)", () => {
    const sessions = new MockSessions();
    const before = (getBus() as any)._subscriberCountFor("media.live.chunk");
    const unsub = registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => undefined,
    });
    const after = (getBus() as any)._subscriberCountFor("media.live.chunk");
    expect(after).toBe(before);
    unsub();
  });

  test("provider=gemini-live + key present → subscribes", () => {
    const sessions = new MockSessions();
    const before = (getBus() as any)._subscriberCountFor("media.live.chunk");
    const unsub = registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => new FakeWs(url),
    });
    const after = (getBus() as any)._subscriberCountFor("media.live.chunk");
    expect(after).toBe(before + 1);
    unsub();
  });
});

describe("gemini-live-consumer — streaming + setup", () => {
  test("declares Gemini Live tools through the extension manifest projection", () => {
    expect(GEMINI_LIVE_TOOL_EXTENSION_MANIFEST.surfaces).toContain("gemini.live");
    expect(GEMINI_LIVE_TOOL_EXTENSION_MANIFEST.tools?.map((tool) => tool.name)).toEqual([
      "memory_append",
      "channel_send",
    ]);
    expect(getGeminiLiveToolNames()).toEqual(["memory_append", "channel_send"]);

    const declarations = getGeminiLiveFunctionDeclarations();
    expect(declarations.map((decl) => decl.name)).toEqual(["memory_append", "channel_send"]);
    expect(declarations[0].parameters).toBeDefined();
    expect(declarations[1].parameters).toBeDefined();
  });

  test("first chunk opens WS, sends setup with default prompt, then forwards chunk after setupComplete", async () => {
    const sessions = new MockSessions();
    const server = new MockServer();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      server: server as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const framePath = makeChunkFile(join(workDir, "live", "voice:abc"), "0001.jpg", Buffer.from([0xff, 0xd8, 0xff]));

    const ev: MediaLiveChunkEvent = {
      session_key: "voice:abc",
      media_kind: "frame",
      file_path: framePath,
      seq: 1,
      device_id: "abc",
      size_bytes: 3,
    };

    getBus().publish("media.live.chunk", ev);

    // Let the session open microtask run.
    await new Promise((r) => setTimeout(r, 10));

    expect(wsInstances.length).toBe(1);
    const ws = wsInstances[0]!;

    // First outgoing message is setup with the default prompt.
    const out = ws.outgoing();
    expect(out.length).toBeGreaterThanOrEqual(1);
    const setupMsg = out[0];
    expect(setupMsg.setup).toBeDefined();
    expect(setupMsg.setup.model).toBe("models/gemini-test");
    expect(setupMsg.setup.systemInstruction.parts[0].text).toBe(GEMINI_LIVE_DEFAULT_PROMPT);
    // Tool registration is included when tools_enabled=true.
    expect(Array.isArray(setupMsg.setup.tools)).toBe(true);
    const decls = setupMsg.setup.tools[0].functionDeclarations.map((d: any) => d.name);
    expect(decls).toEqual(["memory_append", "channel_send"]);

    // Frame should NOT be forwarded yet (setup not complete).
    expect(out.length).toBe(1);

    // Server finishes setup → consumer drains pending chunks.
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 10));

    const out2 = ws.outgoing();
    const realtimeFrames = out2.filter((m) => m.realtimeInput);
    expect(realtimeFrames.length).toBe(1);
    expect(realtimeFrames[0].realtimeInput.video.mimeType).toBe("image/jpeg");
    // base64 of 0xff 0xd8 0xff = "/9j/"
    expect(realtimeFrames[0].realtimeInput.video.data).toBe("/9j/");
  });

  test("tools_enabled=false omits Gemini Live tool declarations", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig({ tools_enabled: false }),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const framePath = makeChunkFile(join(workDir, "live", "voice:no-tools"), "0001.jpg", Buffer.from([0xff, 0xd8]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:no-tools",
      media_kind: "frame",
      file_path: framePath,
      seq: 1,
      size_bytes: 2,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));

    const setupMsg = wsInstances[0]!.outgoing()[0];
    expect(setupMsg.setup).toBeDefined();
    expect(setupMsg.setup.tools).toBeUndefined();
  });

  test("bundles frames + audio for the same session via realtimeInput", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const live = join(workDir, "live", "voice:abc");
    const fp = makeChunkFile(live, "0001.jpg", Buffer.from([0xff, 0xd8]));
    const ap = makeChunkFile(live, "0001.pcm", Buffer.from([0x01, 0x02, 0x03, 0x04]));

    getBus().publish("media.live.chunk", {
      session_key: "voice:abc",
      media_kind: "frame",
      file_path: fp,
      seq: 1,
      size_bytes: 2,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    getBus().publish("media.live.chunk", {
      session_key: "voice:abc",
      media_kind: "audio_chunk",
      file_path: ap,
      seq: 1,
      size_bytes: 4,
      duration_ms: 100,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));

    const frames = ws.outgoing().filter((m) => m.realtimeInput);
    expect(frames.length).toBe(2);
    const mimes = frames.map((f) =>
      (f.realtimeInput.video ?? f.realtimeInput.audio).mimeType,
    );
    expect(mimes).toContain("image/jpeg");
    expect(mimes.some((m) => m.startsWith("audio/pcm;rate=16000"))).toBe(true);
  });

  test("separate session_keys get separate WS sessions", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fpA = makeChunkFile(join(workDir, "live", "voice:a"), "0001.jpg", Buffer.from([0x01]));
    const fpB = makeChunkFile(join(workDir, "live", "voice:b"), "0001.jpg", Buffer.from([0x02]));

    getBus().publish("media.live.chunk", {
      session_key: "voice:a", media_kind: "frame", file_path: fpA, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);
    getBus().publish("media.live.chunk", {
      session_key: "voice:b", media_kind: "frame", file_path: fpB, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    expect(wsInstances.length).toBe(2);
  });
});

describe("gemini-live-consumer — tool dispatch + turn persistence", () => {
  test("server toolCall for memory_append → handler runs, file is written, toolResponse sent", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:abc"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:abc", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    // Fake Gemini issues a memory_append tool call.
    ws.pushServer({
      toolCall: {
        functionCalls: [
          {
            id: "call-1",
            name: "memory_append",
            args: { category: "daily-log", text: "saw a cat" },
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    // A toolResponse should have been sent back.
    const responses = ws.outgoing().filter((m) => m.toolResponse);
    expect(responses.length).toBe(1);
    expect(responses[0].toolResponse.functionResponses[0].name).toBe("memory_append");

    // And the memory file should now exist.
    // WorkspaceManager writes under <HAWKY_WORKSPACE>/memory/<category>/<YYYY-MM-DD>.jsonl
    // We just check the directory has one file.
    const memCatDir = join(workDir, "memory", "daily-log");
    expect(existsSync(memCatDir)).toBe(true);
  });

  test("server toolCall for channel_send → target session is updated and toolResponse sent", async () => {
    const sessions = new MockSessions();
    const server = new MockServer();
    const wsInstances: FakeWs[] = [];
    setChannelSendDeps(sessions as any, server as any);

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:abc"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:abc", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    ws.pushServer({
      toolCall: {
        functionCalls: [
          {
            id: "call-channel-send",
            name: "channel_send",
            args: { to: "web:general", text: "handoff from live" },
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    const target = sessions.sessions.get("web:general");
    expect(target).toBeTruthy();
    expect(target!.loop.getHistory().length).toBe(1);
    expect(target!.loop.getHistory()[0].content[0].text).toBe("handoff from live");
    expect(target!.sessionManager.appended.length).toBe(1);
    expect(target!.sessionManager.appended[0]!.content[0].text).toBe("handoff from live");
    expect(server.broadcasts).toEqual([
      { event: "session.updated", payload: { sessionKey: "web:general" } },
    ]);

    const responses = ws.outgoing().filter((m) => m.toolResponse);
    expect(responses.length).toBe(1);
    const response = responses[0].toolResponse.functionResponses[0];
    expect(response.name).toBe("channel_send");
    expect(response.response.output.type).toBe("text");
    expect(response.response.output.metadata.target_session).toBe("web:general");
  });

  test("tools_enabled=false ignores server tool calls without side effects", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig({ tools_enabled: false }),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:no-tool-dispatch"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:no-tool-dispatch", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    ws.pushServer({
      toolCall: {
        functionCalls: [
          {
            id: "call-disabled",
            name: "memory_append",
            args: { category: "daily-log", text: "should not write" },
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const responses = ws.outgoing().filter((m) => m.toolResponse);
    expect(responses.length).toBe(0);
    expect(existsSync(join(workDir, "memory", "daily-log"))).toBe(false);
  });

  test("unknown Gemini Live tool call returns an error toolResponse", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:abc"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:abc", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    ws.pushServer({
      toolCall: {
        functionCalls: [
          {
            id: "call-unknown",
            name: "not_installed",
            args: {},
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const responses = ws.outgoing().filter((m) => m.toolResponse);
    expect(responses.length).toBe(1);
    const response = responses[0].toolResponse.functionResponses[0];
    expect(response.name).toBe("not_installed");
    expect(response.response.output.type).toBe("error");
    expect(response.response.output.content).toContain("unknown tool: not_installed");
  });

  test("turnComplete flushes accumulated text to sessionManager.appendMessage", async () => {
    const sessions = new MockSessions();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:abc"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:abc", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    ws.pushServer({
      serverContent: {
        modelTurn: { parts: [{ text: "noop: " }, { text: "quiet scene." }] },
      },
    });
    ws.pushServer({
      serverContent: { turnComplete: true },
    });
    await new Promise((r) => setTimeout(r, 20));

    const s = sessions.getOrCreate("voice:abc");
    const assistantMsgs = s.sessionManager.appended.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0]!.content[0].text).toBe("noop: quiet scene.");
  });
});

describe("gemini-live-consumer — realtime downlink (#2)", () => {
  test("a turn emits live.* in order with onset, then closes; tMs non-decreasing, seq resets per turn", async () => {
    const sessions = new MockSessions();
    const server = new MockServer();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      server: server as any,
      config: baseConfig({ response_modalities: ["AUDIO"] }),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:dl"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:dl", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    // Turn 1: audio blob first (onset), then a transcript delta, then complete.
    ws.pushServer({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: "QUJDRA==" } },
            { text: "hello there" },
          ],
        },
      },
    });
    ws.pushServer({ serverContent: { turnComplete: true } });
    await new Promise((r) => setTimeout(r, 20));

    const live = server.liveEvents();
    const kinds = live.map((e) => e.event);

    // session_open precedes the turn; response_start fires once, before deltas.
    expect(kinds).toContain("live.session_open");
    expect(kinds).toContain("live.response_start");
    expect(kinds).toContain("live.turn_complete");
    expect(kinds.filter((k) => k === "live.response_start").length).toBe(1);

    // Ordering within the turn: response_start → (audio/text deltas) → complete.
    const start = kinds.indexOf("live.response_start");
    const complete = kinds.indexOf("live.turn_complete");
    expect(start).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(start);
    expect(kinds.indexOf("live.audio_delta")).toBeGreaterThan(start);
    expect(kinds.indexOf("live.text_delta")).toBeGreaterThan(start);
    expect(kinds.indexOf("live.audio_delta")).toBeLessThan(complete);

    // Onset modality reflects the first part seen (audio).
    const responseStart = live.find((e) => e.event === "live.response_start")!;
    expect(responseStart.payload.modality).toBe("audio");
    expect(responseStart.payload.provider).toBe("gemini-live");

    // turn_complete carries the final text for substring scoring.
    const turnComplete = live.find((e) => e.event === "live.turn_complete")!;
    expect(turnComplete.payload.text).toBe("hello there");

    // tMs non-decreasing across the whole stream.
    const ts = live.map((e) => e.payload.tMs);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]!);

    // Within a turn, seq is strictly increasing for that turnId.
    const turn1Id = responseStart.payload.turnId;
    const turn1Seqs = live.filter((e) => e.payload.turnId === turn1Id).map((e) => e.payload.seq);
    for (let i = 1; i < turn1Seqs.length; i++) expect(turn1Seqs[i]).toBeGreaterThan(turn1Seqs[i - 1]!);

    // Turn 2 gets a fresh turnId and seq resets to 0.
    ws.pushServer({
      serverContent: { modelTurn: { parts: [{ text: "again" }] } },
    });
    ws.pushServer({ serverContent: { turnComplete: true } });
    await new Promise((r) => setTimeout(r, 20));

    const turn2Start = server.liveEvents().find(
      (e) => e.event === "live.response_start" && e.payload.turnId !== turn1Id,
    )!;
    expect(turn2Start).toBeDefined();
    expect(turn2Start.payload.seq).toBe(0);
    expect(turn2Start.payload.turnId).not.toBe(turn1Id);
  });

  test("downlink is session-scoped: session B never sees session A's live.* events", async () => {
    const sessions = new MockSessions();
    const server = new MockServer();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      server: server as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    for (const key of ["voice:A", "voice:B"]) {
      const fp = makeChunkFile(join(workDir, "live", key), "0001.jpg", Buffer.from([0x01]));
      getBus().publish("media.live.chunk", {
        session_key: key, media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
      } as MediaLiveChunkEvent);
    }
    await new Promise((r) => setTimeout(r, 10));

    // Complete a turn only on A's socket.
    const wsA = wsInstances[0]!;
    wsA.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));
    wsA.pushServer({ serverContent: { modelTurn: { parts: [{ text: "a-only" }] } } });
    wsA.pushServer({ serverContent: { turnComplete: true } });
    await new Promise((r) => setTimeout(r, 20));

    const live = server.liveEvents();
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((e) => e.payload.sessionKey === "voice:A")).toBe(true);
    expect(live.some((e) => e.payload.sessionKey === "voice:B")).toBe(false);
  });

  test("a tool call surfaces live.tool_call then live.tool_result (the tool-grading path)", async () => {
    const sessions = new MockSessions();
    const server = new MockServer();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      server: server as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:tools"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:tools", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    ws.pushServer({
      toolCall: {
        functionCalls: [
          { id: "call-1", name: "memory_append", args: { category: "daily-log", text: "saw a cat" } },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    const live = server.liveEvents();

    // tool_call is surfaced with the model's call id / name / args …
    const toolCall = live.find((e) => e.event === "live.tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.payload.callId).toBe("call-1");
    expect(toolCall!.payload.name).toBe("memory_append");
    expect(toolCall!.payload.args).toEqual({ category: "daily-log", text: "saw a cat" });

    // … followed by tool_result for the same call, ok=true on success.
    const toolResult = live.find((e) => e.event === "live.tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.payload.callId).toBe("call-1");
    expect(toolResult!.payload.ok).toBe(true);

    // Ordering: tool_call precedes tool_result.
    const kinds = live.map((e) => e.event);
    expect(kinds.indexOf("live.tool_call")).toBeLessThan(kinds.indexOf("live.tool_result"));
  });

  test("an unknown tool call surfaces tool_result with ok=false", async () => {
    const sessions = new MockSessions();
    const server = new MockServer();
    const wsInstances: FakeWs[] = [];

    registerGeminiLiveConsumer({
      sessions: sessions as any,
      server: server as any,
      config: baseConfig(),
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const w = new FakeWs(url);
        wsInstances.push(w);
        return w;
      },
    });

    const fp = makeChunkFile(join(workDir, "live", "voice:badtool"), "0001.jpg", Buffer.from([0x01]));
    getBus().publish("media.live.chunk", {
      session_key: "voice:badtool", media_kind: "frame", file_path: fp, seq: 1, size_bytes: 1,
    } as MediaLiveChunkEvent);

    await new Promise((r) => setTimeout(r, 10));
    const ws = wsInstances[0]!;
    ws.pushServer({ setupComplete: {} });
    await new Promise((r) => setTimeout(r, 5));

    ws.pushServer({
      toolCall: { functionCalls: [{ id: "call-x", name: "does_not_exist", args: {} }] },
    });
    await new Promise((r) => setTimeout(r, 30));

    const toolResult = server.liveEvents().find((e) => e.event === "live.tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult!.payload.callId).toBe("call-x");
    expect(toolResult!.payload.ok).toBe(false);
  });
});

describe("gemini-live-consumer — config resolver", () => {
  test("defaults applied when live_consumer section missing", () => {
    const cfg = resolveGeminiLiveConsumerConfig({} as any);
    expect(cfg.provider).toBe("none");
    expect(cfg.idle_reaper_ms).toBe(30_000);
    expect(cfg.tools_enabled).toBe(true);
    expect(cfg.response_modalities).toEqual(["TEXT"]);
  });

  test("explicit fields are honored", () => {
    const cfg = resolveGeminiLiveConsumerConfig({
      live_consumer: {
        provider: "gemini-live",
        model: "models/custom",
        idle_reaper_ms: 15_000,
        tools_enabled: false,
        response_modalities: ["AUDIO"],
      },
    } as any);
    expect(cfg.provider).toBe("gemini-live");
    expect(cfg.model).toBe("models/custom");
    expect(cfg.idle_reaper_ms).toBe(15_000);
    expect(cfg.tools_enabled).toBe(false);
    expect(cfg.response_modalities).toEqual(["AUDIO"]);
  });

  test("invalid provider string coerces to 'none'", () => {
    const cfg = resolveGeminiLiveConsumerConfig({
      live_consumer: { provider: "bogus" as any },
    } as any);
    expect(cfg.provider).toBe("none");
  });
});
