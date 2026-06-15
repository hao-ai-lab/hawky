// =============================================================================
// Video loop integration harness.
//
// This is the "boring proof" PR: no new product behavior, just one mocked
// end-to-end path across the video stack:
//   media.chunk.upload live frame -> live file + bus event -> Gemini Live
//   consumer -> tool call -> memory append -> assistant summary persisted.
//
// No network, no real model. The WebSocket is faked and the gateway is a
// method-handler stub.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getBus, resetBus } from "../../src/bus/index.js";
import { registerMediaMethods } from "../../src/gateway/media-methods.js";
import { resetMediaWriters } from "../../src/gateway/media-writer.js";
import { registerGeminiLiveConsumer } from "../../src/consumers/gemini-live-channel/index.js";
import type { WebSocketLike } from "../../src/consumers/gemini-live-channel/client.js";
import { setWorkspaceDir, getWorkspaceDir } from "../../src/storage/workspace.js";

type MethodHandler = (conn: unknown, params: unknown) => unknown | Promise<unknown>;

class StubGateway {
  methods = new Map<string, MethodHandler>();
  broadcasts: Array<{ event: string; payload: unknown }> = [];

  registerMethod(name: string, handler: MethodHandler): void {
    this.methods.set(name, handler);
  }

  async call(name: string, params: unknown): Promise<unknown> {
    const handler = this.methods.get(name);
    if (!handler) throw new Error(`method not registered: ${name}`);
    return await handler({}, params);
  }

  broadcast(event: string, payload: unknown): void {
    this.broadcasts.push({ event, payload });
  }
}

class FakeWs implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(event: { data: unknown }) => void> = [];
  private closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];

  constructor(public readonly url: string) {
    queueMicrotask(() => {
      for (const handler of this.openHandlers) handler();
    });
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: string, listener: any): void {
    if (type === "open") this.openHandlers.push(listener);
    else if (type === "message") this.messageHandlers.push(listener);
    else if (type === "close") this.closeHandlers.push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    for (const handler of this.closeHandlers) {
      handler({ code: code ?? 1000, reason: reason ?? "" });
    }
  }

  pushServer(message: unknown): void {
    const data = JSON.stringify(message);
    for (const handler of this.messageHandlers) handler({ data });
  }

  outgoing(): any[] {
    return this.sent.map((line) => JSON.parse(line));
  }
}

class MockSessionManager {
  appended: Array<{ role: string; content: any[]; timestamp?: string }> = [];
  appendMessage(message: { role: string; content: any[]; timestamp?: string }): void {
    this.appended.push(message);
  }
}

class MockLoop {
  async sendMessage(): Promise<void> {}
  getHistory(): any[] { return []; }
  setHistory(): void {}
}

class MockSessions {
  sessions = new Map<string, { loop: MockLoop; sessionManager: MockSessionManager }>();

  getOrCreate(key: string) {
    let session = this.sessions.get(key);
    if (!session) {
      session = { loop: new MockLoop(), sessionManager: new MockSessionManager() };
      this.sessions.set(key, session);
    }
    return session;
  }
}

let workDir: string;
let workspaceDir: string;
let mediaRoot: string;
let previousWorkspaceDir: string;
let previousWorkspaceEnv: string | undefined;
let previousMediaRootEnv: string | undefined;
let unsubscribeConsumer: (() => void) | null = null;

beforeEach(() => {
  workDir = join(tmpdir(), `hawky-video-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  workspaceDir = join(workDir, "workspace");
  mediaRoot = join(workspaceDir, "media");
  mkdirSync(mediaRoot, { recursive: true });

  previousWorkspaceDir = getWorkspaceDir();
  previousWorkspaceEnv = process.env.HAWKY_WORKSPACE;
  previousMediaRootEnv = process.env.HAWKY_MEDIA_ROOT;
  process.env.HAWKY_WORKSPACE = workspaceDir;
  process.env.HAWKY_MEDIA_ROOT = mediaRoot;
  setWorkspaceDir(workspaceDir);

  resetBus();
});

afterEach(async () => {
  unsubscribeConsumer?.();
  unsubscribeConsumer = null;
  await resetMediaWriters();
  resetBus();
  setWorkspaceDir(previousWorkspaceDir);
  if (previousWorkspaceEnv === undefined) delete process.env.HAWKY_WORKSPACE;
  else process.env.HAWKY_WORKSPACE = previousWorkspaceEnv;
  if (previousMediaRootEnv === undefined) delete process.env.HAWKY_MEDIA_ROOT;
  else process.env.HAWKY_MEDIA_ROOT = previousMediaRootEnv;
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function waitFor<T>(
  label: string,
  fn: () => T | undefined | false,
  timeoutMs = 1000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function tinyJpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x00, 0xff, 0xd9]);
}

describe("video loop integration harness", () => {
  test("live frame reaches model consumer, tool call appends memory, summary persists", async () => {
    const gateway = new StubGateway();
    registerMediaMethods(gateway as any);

    const sockets: FakeWs[] = [];
    const sessions = new MockSessions();
    unsubscribeConsumer = registerGeminiLiveConsumer({
      sessions: sessions as any,
      server: gateway as any,
      config: {
        provider: "gemini-live",
        model: "models/gemini-test",
        idle_reaper_ms: 30_000,
        tools_enabled: true,
        response_modalities: ["TEXT"],
      },
      apiKeyProvider: () => "fake-key",
      wsFactory: (url) => {
        const ws = new FakeWs(url);
        sockets.push(ws);
        return ws;
      },
    });

    const frame = tinyJpeg();
    const result = (await gateway.call("media.chunk.upload", {
      media_kind: "frame",
      session_key: "voice:phone-a",
      bytes: frame.toString("base64"),
      ts_captured_ns: 123,
      device_id: "phone-a",
    })) as { ok: true; seq: number; file_path: string };

    expect(result.ok).toBe(true);
    expect(result.seq).toBe(0);
    expect(existsSync(result.file_path)).toBe(true);
    expect(readFileSync(result.file_path)).toEqual(frame);

    const ws = await waitFor("Gemini Live socket", () => sockets[0]);
    await waitFor("setup frame", () => ws.outgoing().find((msg) => msg.setup));

    ws.pushServer({ setupComplete: {} });
    await waitFor("realtime frame upload", () =>
      ws.outgoing().find((msg) =>
        msg.realtimeInput?.video?.mimeType === "image/jpeg",
      ),
    );

    ws.pushServer({
      toolCall: {
        functionCalls: [
          {
            id: "call-1",
            name: "memory_append",
            args: { category: "daily-log", text: "Saw a whiteboard note." },
          },
        ],
      },
    });

    const memoryDir = join(workspaceDir, "memory", "daily-log");
    await waitFor("memory append", () => existsSync(memoryDir));
    const memoryFiles = readdirSync(memoryDir).filter((file) => file.endsWith(".jsonl"));
    expect(memoryFiles.length).toBe(1);
    const memoryLine = readFileSync(join(memoryDir, memoryFiles[0]), "utf-8").trim();
    expect(JSON.parse(memoryLine).text).toBe("Saw a whiteboard note.");

    await waitFor("tool response", () =>
      ws.outgoing().find((msg) => msg.toolResponse?.functionResponses?.[0]?.id === "call-1"),
    );

    ws.pushServer({
      serverContent: {
        modelTurn: { parts: [{ text: "Whiteboard note captured." }] },
      },
    });
    ws.pushServer({ serverContent: { turnComplete: true } });

    const session = await waitFor("persisted assistant summary", () =>
      sessions.sessions.get("voice:phone-a"),
    );
    expect(session.sessionManager.appended).toHaveLength(1);
    expect(session.sessionManager.appended[0].role).toBe("assistant");
    expect(session.sessionManager.appended[0].content[0].text).toBe("Whiteboard note captured.");
  });
});
