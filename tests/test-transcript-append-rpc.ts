import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { MethodError } from "../src/gateway/methods.js";
import { resetSessionsDir, setSessionsDir } from "../src/storage/session.js";

type TranscriptCall = {
  sessionKey: string;
  turn: { role: string; text: string; ts: string };
  mode: string;
};

let tempDir: string;
let previousAmbientIntentions: string | undefined;

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: any, params?: any) {
      const method = methods[name];
      if (!method) throw new Error(`Method not found: ${name}`);
      return method(conn, params, this);
    },
    broadcast() {},
    broadcastToSession() {},
    getConnections() {
      return new Map();
    },
  };
}

function makeRegisteredServer(calls: TranscriptCall[]) {
  const server = makeMockServer();
  const latentService = {
    onTranscript(sessionKey: string, turn: TranscriptCall["turn"], mode: string) {
      calls.push({ sessionKey, turn, mode });
    },
  };

  registerAgentMethods(server as any, {} as any, undefined, undefined, undefined, latentService as any);
  return server;
}

function makeBoundConn(sessionKey = "realtime:a") {
  return { sessionKey, mode: "ambient" };
}

function turn(text = "hello") {
  return { role: "user", text, ts: "2026-06-30T12:00:00.000Z" };
}

beforeEach(() => {
  tempDir = join(tmpdir(), `hawky-transcript-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  setSessionsDir(join(tempDir, "sessions"));
  previousAmbientIntentions = process.env.AMBIENT_INTENTIONS;
  process.env.AMBIENT_INTENTIONS = "1";
});

afterEach(() => {
  if (previousAmbientIntentions === undefined) {
    delete process.env.AMBIENT_INTENTIONS;
  } else {
    process.env.AMBIENT_INTENTIONS = previousAmbientIntentions;
  }
  resetSessionsDir();
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("transcript.append RPC", () => {
  test("uses the bound connection session when sessionKey is omitted", async () => {
    const calls: TranscriptCall[] = [];
    const server = makeRegisteredServer(calls);

    await server.call("transcript.append", makeBoundConn("realtime:a"), { turns: [turn("from a")] });

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionKey).toBe("realtime:a");
    expect(calls[0].turn.text).toBe("from a");
  });

  test("accepts an explicit sessionKey only when it matches the bound connection", async () => {
    const calls: TranscriptCall[] = [];
    const server = makeRegisteredServer(calls);

    await server.call("transcript.append", makeBoundConn("realtime:a"), {
      sessionKey: "realtime:a",
      turns: [turn("still a")],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionKey).toBe("realtime:a");
  });

  test("rejects attempts to append transcript turns into another session", async () => {
    const calls: TranscriptCall[] = [];
    const server = makeRegisteredServer(calls);

    let error: unknown;
    try {
      await server.call("transcript.append", makeBoundConn("realtime:a"), {
        sessionKey: "realtime:b",
        turns: [turn("private b text")],
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(MethodError);
    expect((error as MethodError).code).toBe("FORBIDDEN");
    expect((error as MethodError).message).toContain("Session mismatch");
    expect(calls).toHaveLength(0);
  });
});
