// =============================================================================
// Tests: chat.send broadcasts a `user.message` event
//
// Covers the fix for the bug where sibling clients subscribed to a session
// would not see a user's message until they refreshed and pulled
// session.history. chat.send must broadcast a "user.message" event to all
// subscribed clients BEFORE the agent begins streaming agent.* events.
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionsDir, resetSessionsDir, SessionManager } from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetGatewayState } from "../src/gateway/server.js";

type BroadcastCall = { sessionKey: string; event: string; payload: any; excludeClientId?: string };

function makeMockServer(broadcasts: BroadcastCall[]) {
  const methods: Record<string, Function> = {};
  const srv: any = {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: any, params: any) {
      const method = methods[name];
      if (!method) throw new Error(`Method not found: ${name}`);
      return method(conn, params, srv);
    },
    methods,
    broadcast() {},
    broadcastToSession(sessionKey: string, event: string, payload: any, excludeClientId?: string) {
      broadcasts.push({ sessionKey, event, payload, excludeClientId });
    },
    getConnections() { return new Map(); },
  };
  return srv;
}

let testDir: string;
let sessionsDir: string;
let server: ReturnType<typeof makeMockServer>;
let sessions: AgentSessionManager;
let broadcasts: BroadcastCall[];
// The gateway uses `clientId` (stable per-client identity) to exclude
// every connection of the sender from its own user.message broadcast,
// so two sockets from the same browser still both get skipped.
const mockConn = { connId: "conn-sender-1", clientId: "client-sender-A", sessionKey: null, workingDirectory: "/tmp", bindSession() {} };

function createTestSession(key: string): void {
  const sessionId = key.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  const sm = new SessionManager(sessionId, sessionsDir);
  sm.initSession("test-model", "/tmp");
}

beforeEach(() => {
  resetGatewayState();
  applyDefaultLaneConcurrency();

  testDir = join(tmpdir(), `hawky-usrbcast-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionsDir = join(testDir, "sessions");
  const wsDir = join(testDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  setWorkspaceDir(wsDir);
  writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n");

  broadcasts = [];
  server = makeMockServer(broadcasts);

  const mockProvider = {
    async *stream() {
      yield { type: "message_start" as const, message_id: "msg_1", model: "mock", usage: { input_tokens: 5, output_tokens: 3 } };
      yield { type: "text_delta" as const, text: "hi back" };
      yield { type: "content_block_stop" as const, index: 0 };
      yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 5 } };
      yield { type: "message_stop" as const };
    },
  };

  sessions = new AgentSessionManager({
    provider: mockProvider as any,
    config: { model: "test", api_key: "test", max_tokens: 1024, max_iterations: 5, max_tool_result_chars: 1000 } as any,
    workingDirectory: "/tmp",
    server: server as any,
  });

  registerAgentMethods(server as any, sessions, { model: "test", api_key: "test", max_tokens: 1024, max_iterations: 5, max_tool_result_chars: 1000 } as any);
});

afterEach(() => {
  resetSessionsDir();
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("chat.send broadcasts user.message", () => {
  test("emits a user.message broadcast with text and messageId", async () => {
    createTestSession("web:bcast-A");
    await server.call("chat.send", mockConn, {
      message: "hi",
      sessionKey: "web:bcast-A",
    });

    const userBroadcasts = broadcasts.filter((b) => b.event === "user.message");
    expect(userBroadcasts.length).toBe(1);
    const bc = userBroadcasts[0];
    expect(bc.sessionKey).toBe("web:bcast-A");
    expect(bc.payload.type).toBe("user.message");
    expect(bc.payload.text).toBe("hi");
    expect(typeof bc.payload.messageId).toBe("string");
    expect(bc.payload.messageId.length).toBeGreaterThan(0);
    expect(typeof bc.payload.timestamp).toBe("string");
    expect(bc.payload.sessionKey).toBe("web:bcast-A");
  });

  test("user.message is emitted BEFORE any agent.* events", async () => {
    createTestSession("web:bcast-order");
    await server.call("chat.send", mockConn, {
      message: "order check",
      sessionKey: "web:bcast-order",
    });

    const firstUserIdx = broadcasts.findIndex((b) => b.event === "user.message");
    const firstAgentIdx = broadcasts.findIndex((b) => b.event.startsWith("agent."));
    expect(firstUserIdx).toBeGreaterThanOrEqual(0);
    expect(firstAgentIdx).toBeGreaterThanOrEqual(0);
    expect(firstUserIdx).toBeLessThan(firstAgentIdx);
  });

  test("image attachments carry base64 so siblings can render the thumbnail", async () => {
    createTestSession("web:bcast-att");
    const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    await server.call("chat.send", mockConn, {
      message: "with image",
      sessionKey: "web:bcast-att",
      attachments: [{ base64: TINY_PNG_BASE64, media_type: "image/png" }],
    });

    const bc = broadcasts.find((b) => b.event === "user.message")!;
    expect(bc).toBeDefined();
    expect(Array.isArray(bc.payload.attachments)).toBe(true);
    expect(bc.payload.attachments.length).toBe(1);
    expect(bc.payload.attachments[0].media_type).toBe("image/png");
    // base64 MUST round-trip — without it, sibling clients render an empty
    // bubble where the image should be (P1 from cross-client-sync review).
    expect(bc.payload.attachments[0].base64).toBe(TINY_PNG_BASE64);
  });

  test("PDF documents broadcast metadata (filename, size, media_type) without base64", async () => {
    createTestSession("web:bcast-pdf");
    // %PDF-1.4 + minimal trailer, base64-encoded. Content doesn't matter for
    // the broadcast shape — only that the gateway accepted the upload and
    // propagated the pill metadata to siblings (P2 from review).
    const TINY_PDF_BASE64 = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
    await server.call("chat.send", mockConn, {
      message: "see attached",
      sessionKey: "web:bcast-pdf",
      documents: [{ base64: TINY_PDF_BASE64, media_type: "application/pdf", filename: "spec.pdf" }],
    });

    const bc = broadcasts.find((b) => b.event === "user.message")!;
    expect(bc).toBeDefined();
    expect(Array.isArray(bc.payload.documents)).toBe(true);
    expect(bc.payload.documents.length).toBe(1);
    const doc = bc.payload.documents[0];
    expect(doc.media_type).toBe("application/pdf");
    expect(doc.filename).toBe("spec.pdf");
    expect(typeof doc.sizeBytes).toBe("number");
    expect(doc.sizeBytes).toBeGreaterThan(0);
    // PDFs intentionally omit base64 — pills only need filename/size and
    // forwarding 50MB base64 blobs over the socket is wasted bandwidth.
    expect(doc.base64).toBeUndefined();
  });

  test("attachment-only send (placeholder text + PDF) still broadcasts document metadata", async () => {
    // The web composer sends "(PDF attached)" as the placeholder when the
    // user attaches a PDF without typing anything (see InputBar handleSend).
    // The broadcast must carry that exact text plus the document metadata so
    // siblings render the same bubble the sender sees locally.
    createTestSession("web:bcast-pdfonly");
    const TINY_PDF_BASE64 = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
    await server.call("chat.send", mockConn, {
      message: "(PDF attached)",
      sessionKey: "web:bcast-pdfonly",
      documents: [{ base64: TINY_PDF_BASE64, media_type: "application/pdf", filename: "notes.pdf" }],
    });

    const bc = broadcasts.find((b) => b.event === "user.message")!;
    expect(bc).toBeDefined();
    expect(bc.payload.text).toBe("(PDF attached)");
    expect(bc.payload.documents?.[0]?.filename).toBe("notes.pdf");
  });

  test("no attachments/documents fields when none provided", async () => {
    createTestSession("web:bcast-noatt");
    await server.call("chat.send", mockConn, {
      message: "plain",
      sessionKey: "web:bcast-noatt",
    });
    const bc = broadcasts.find((b) => b.event === "user.message")!;
    expect(bc.payload.attachments).toBeUndefined();
    expect(bc.payload.documents).toBeUndefined();
  });

  test("excludeClientId is set to sender's clientId so every conn of the sender is skipped", async () => {
    createTestSession("web:bcast-exclude");
    await server.call("chat.send", mockConn, {
      message: "no echo please",
      sessionKey: "web:bcast-exclude",
    });
    const bc = broadcasts.find((b) => b.event === "user.message")!;
    expect(bc).toBeDefined();
    // Contract: the sender's stable clientId is passed so broadcastToSession
    // skips ALL connections owned by that client (PWA SW socket, transient
    // reconnect overlap, dev tunnel duplicate). Excluding by per-conn id
    // would leak the broadcast back via the sibling socket.
    expect(bc.excludeClientId).toBe("client-sender-A");
  });
});
