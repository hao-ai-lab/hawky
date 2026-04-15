// =============================================================================
// Tests: Image Attachments
//
// Covers: chat.send with attachments, image validation, content block
// construction, JSONL persistence of image messages, oversized/invalid rejection
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionsDir, resetSessionsDir, SessionManager } from "../src/storage/session.js";
import { setWorkspaceDir } from "../src/storage/workspace.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { AgentSessionManager } from "../src/gateway/agent-sessions.js";
import { applyDefaultLaneConcurrency } from "../src/gateway/lanes.js";
import { resetGatewayState } from "../src/gateway/server.js";

// =============================================================================
// Mock server
// =============================================================================

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: any, params: any) {
      const method = methods[name];
      if (!method) throw new Error(`Method not found: ${name}`);
      return method(conn, params, this);
    },
    methods,
    broadcast() {},
    broadcastToSession() {},
    getConnections() { return new Map(); },
  };
}

// =============================================================================
// Setup
// =============================================================================

let testDir: string;
let sessionsDir: string;
let server: ReturnType<typeof makeMockServer>;
let sessions: AgentSessionManager;
const mockConn = { sessionKey: null, workingDirectory: "/tmp", bindSession() {} };

// A tiny 1x1 red PNG (base64)
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

function createTestSession(key: string): void {
  const sessionId = key.replace(":", "/").replace(/[^a-zA-Z0-9_/.-]/g, "-");
  const sm = new SessionManager(sessionId, sessionsDir);
  sm.initSession("test-model", "/tmp");
}

beforeEach(() => {
  // Initialize lane system (required for chat.send which routes through command queue)
  resetGatewayState();
  applyDefaultLaneConcurrency();

  testDir = join(tmpdir(), `hawky-img-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sessionsDir = join(testDir, "sessions");
  const wsDir = join(testDir, "workspace");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  setSessionsDir(sessionsDir);
  setWorkspaceDir(wsDir);
  writeFileSync(join(wsDir, "MEMORY.md"), "# Memory\n");

  server = makeMockServer();

  // Mock provider that returns immediately with text
  let callCount = 0;
  const mockProvider = {
    async *stream() {
      callCount++;
      yield { type: "message_start" as const, message_id: `msg_${callCount}`, model: "mock", usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: "text_delta" as const, text: "I see the image." };
      yield { type: "content_block_stop" as const, index: 0 };
      yield { type: "message_delta" as const, stop_reason: "end_turn", usage: { output_tokens: 10 } };
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

// =============================================================================
// chat.send with attachments
// =============================================================================

describe("chat.send with attachments", () => {
  test("accepts message with valid image attachment", async () => {
    createTestSession("web:img-test");
    const result = await server.call("chat.send", mockConn, {
      message: "What is in this image?",
      sessionKey: "web:img-test",
      attachments: [{
        base64: TINY_PNG_BASE64,
        media_type: "image/png",
      }],
    });
    expect(result.completed).toBe(true);

    // Images stay in history for multi-turn reference. sanitizeHistoryImages()
    // handles size management before each API call (replaces oldest when over budget).
    const session = sessions.get("web:img-test");
    const history = session!.loop.getHistory();
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const imageBlock = userMsg!.content.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
  });

  test("accepts message without attachments (backward compatible)", async () => {
    createTestSession("web:no-img");
    const result = await server.call("chat.send", mockConn, {
      message: "Hello",
      sessionKey: "web:no-img",
    });
    expect(result.completed).toBe(true);
  });

  test("skips attachments with unsupported media type", async () => {
    createTestSession("web:bad-type");
    const result = await server.call("chat.send", mockConn, {
      message: "Check this",
      sessionKey: "web:bad-type",
      attachments: [{
        base64: TINY_PNG_BASE64,
        media_type: "application/pdf",
      }],
    });
    expect(result.completed).toBe(true);

    // No image block should be in history
    const session = sessions.get("web:bad-type");
    const history = session!.loop.getHistory();
    const userMsg = history.find((m) => m.role === "user");
    const imageBlock = userMsg?.content.find((b) => b.type === "image");
    expect(imageBlock).toBeUndefined();
  });

  test("rejects oversized attachments (>3MB) with error", async () => {
    createTestSession("web:big-img");
    // Create a base64 string that exceeds 3MB when decoded
    const bigBase64 = "A".repeat(5 * 1024 * 1024); // ~3.75MB decoded
    try {
      await server.call("chat.send", mockConn, {
        message: "Big image",
        sessionKey: "web:big-img",
        attachments: [{
          base64: bigBase64,
          media_type: "image/png",
        }],
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message || err.error).toContain("too large");
    }
  });

  test("skips attachments with missing base64 or media_type", async () => {
    createTestSession("web:incomplete");
    const result = await server.call("chat.send", mockConn, {
      message: "Incomplete",
      sessionKey: "web:incomplete",
      attachments: [
        { base64: TINY_PNG_BASE64 }, // missing media_type
        { media_type: "image/png" }, // missing base64
        {}, // both missing
      ],
    });
    expect(result.completed).toBe(true);
  });

  test("accepts multiple valid attachments", async () => {
    createTestSession("web:multi");
    const result = await server.call("chat.send", mockConn, {
      message: "Multiple images",
      sessionKey: "web:multi",
      attachments: [
        { base64: TINY_PNG_BASE64, media_type: "image/png" },
        { base64: TINY_PNG_BASE64, media_type: "image/jpeg" },
      ],
    });
    expect(result.completed).toBe(true);

    // Both images stay in history for multi-turn reference
    const session = sessions.get("web:multi");
    const history = session!.loop.getHistory();
    const userMsg = history.find((m) => m.role === "user");
    const imageBlocks = userMsg!.content.filter((b) => b.type === "image");
    expect(imageBlocks.length).toBe(2);
  });

  test("all four image types accepted", async () => {
    const types = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    for (const type of types) {
      createTestSession(`web:type-${type.split("/")[1]}`);
      const result = await server.call("chat.send", mockConn, {
        message: `Test ${type}`,
        sessionKey: `web:type-${type.split("/")[1]}`,
        attachments: [{ base64: TINY_PNG_BASE64, media_type: type }],
      });
      expect(result.completed).toBe(true);
    }
  });
});

// =============================================================================
// JSONL persistence
// =============================================================================

describe("image message JSONL persistence", () => {
  test("image blocks are persisted in session JSONL", async () => {
    createTestSession("web:persist");
    await server.call("chat.send", mockConn, {
      message: "Persist this image",
      sessionKey: "web:persist",
      attachments: [{ base64: TINY_PNG_BASE64, media_type: "image/png" }],
    });

    // Read the JSONL file directly
    const filePath = join(sessionsDir, "web", "persist.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    // Images are scrubbed before JSONL persistence (replaced with placeholder)
    // to avoid storing sensitive base64 data on disk. Live history keeps images
    // for multi-turn reference; sanitizeHistoryImages() manages budget at API time.
    const msgWithPlaceholder = lines.find((l: any) =>
      l.type === "message" &&
      l.message?.role === "user" &&
      l.message?.content?.some?.((b: any) => b.type === "text" && b.text?.includes("[image was attached]"))
    );
    expect(msgWithPlaceholder).toBeDefined();
  });
});

// =============================================================================
// chat.send with documents (PDFs)
// =============================================================================

// A minimal valid single-page PDF (same content as tests/fixtures/test-doc.pdf),
// base64-encoded. Small enough to slip under all size caps.
const TINY_PDF_BASE64 = Buffer.from(
  "%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n" +
  "2 0 obj <</Type/Pages/Count 1/Kids[3 0 R]>> endobj\n" +
  "3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>> endobj\n" +
  "xref\n0 4\n0000000000 65535 f \n0000000015 00000 n \n" +
  "0000000054 00000 n \n0000000097 00000 n \ntrailer <</Size 4/Root 1 0 R>>\n" +
  "startxref\n148\n%%EOF\n",
).toString("base64");

describe("chat.send with documents", () => {
  test("accepts a PDF document and emits a document block in history", async () => {
    createTestSession("web:doc-test");
    const result = await server.call("chat.send", mockConn, {
      message: "Summarise this PDF",
      sessionKey: "web:doc-test",
      documents: [{ base64: TINY_PDF_BASE64, media_type: "application/pdf", filename: "report.pdf" }],
    });
    expect(result.completed).toBe(true);

    const session = sessions.get("web:doc-test");
    const history = session!.loop.getHistory();
    const userMsg = history.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const docBlock = userMsg!.content.find((b: any) => b.type === "document");
    expect(docBlock).toBeDefined();
    expect((docBlock as any).source.media_type).toBe("application/pdf");
    expect((docBlock as any).title).toBe("report.pdf");
  });

  test("skips a document with an unsupported media type (only PDF is allowed)", async () => {
    createTestSession("web:doc-bad-type");
    const result = await server.call("chat.send", mockConn, {
      message: "Word doc?",
      sessionKey: "web:doc-bad-type",
      documents: [{
        base64: TINY_PDF_BASE64,
        media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }],
    });
    expect(result.completed).toBe(true);
    const session = sessions.get("web:doc-bad-type");
    const userMsg = session!.loop.getHistory().find((m) => m.role === "user");
    expect(userMsg?.content.find((b: any) => b.type === "document")).toBeUndefined();
  });

  test("rejects an oversized document (>27MB base64) with an error", async () => {
    createTestSession("web:doc-big");
    // 28 MB base64 > MAX_DOCUMENT_BASE64 (27 MB), matches sanitizer cap.
    const bigBase64 = "A".repeat(28 * 1024 * 1024);
    try {
      await server.call("chat.send", mockConn, {
        message: "Big PDF",
        sessionKey: "web:doc-big",
        documents: [{ base64: bigBase64, media_type: "application/pdf" }],
      });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message || err.error).toContain("too large");
    }
  });

  test("rejects a combined payload larger than the per-message base64 cap", async () => {
    // Three docs, each 20 MB base64, totals 60 MB > MAX_DOCUMENT_TOTAL_BASE64 (50 MB).
    // Each is UNDER the per-item cap, so the rejection proves the total check fires.
    createTestSession("web:doc-total");
    const twenty = "A".repeat(20 * 1024 * 1024);
    try {
      await server.call("chat.send", mockConn, {
        message: "Combined payload",
        sessionKey: "web:doc-total",
        documents: [
          { base64: twenty, media_type: "application/pdf" },
          { base64: twenty, media_type: "application/pdf" },
          { base64: twenty, media_type: "application/pdf" },
        ],
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message || err.error).toMatch(/exceeds|too large/i);
    }
  });

  test("rejects more than the per-message document count cap", async () => {
    createTestSession("web:doc-count");
    const docs = new Array(4).fill(null).map(() => ({
      base64: TINY_PDF_BASE64,
      media_type: "application/pdf",
    }));
    try {
      await server.call("chat.send", mockConn, {
        message: "Too many",
        sessionKey: "web:doc-count",
        documents: docs,
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message || err.error).toMatch(/too many documents/i);
    }
  });

  test("document blocks are scrubbed in JSONL persistence", async () => {
    createTestSession("web:doc-persist");
    await server.call("chat.send", mockConn, {
      message: "Persist the PDF",
      sessionKey: "web:doc-persist",
      documents: [{ base64: TINY_PDF_BASE64, media_type: "application/pdf", filename: "notes.pdf" }],
    });
    const filePath = join(sessionsDir, "web", "doc-persist.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const scrubbed = lines.find((l: any) =>
      l.type === "message" &&
      l.message?.role === "user" &&
      l.message?.content?.some?.((b: any) => b.type === "text" && b.text?.includes("[notes.pdf was attached]")),
    );
    expect(scrubbed).toBeDefined();
    // The raw base64 must not appear on disk.
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).not.toContain(TINY_PDF_BASE64);
  });

  test("accepts a mix of images and documents in one message", async () => {
    createTestSession("web:mix");
    await server.call("chat.send", mockConn, {
      message: "Image + PDF",
      sessionKey: "web:mix",
      attachments: [{ base64: TINY_PNG_BASE64, media_type: "image/png" }],
      documents: [{ base64: TINY_PDF_BASE64, media_type: "application/pdf" }],
    });
    const session = sessions.get("web:mix");
    const userMsg = session!.loop.getHistory().find((m) => m.role === "user");
    expect(userMsg?.content.some((b: any) => b.type === "image")).toBe(true);
    expect(userMsg?.content.some((b: any) => b.type === "document")).toBe(true);
  });
});
