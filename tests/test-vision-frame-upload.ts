import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import type { RequestFrame, ResponseFrame } from "../src/gateway/protocol.js";
import { registerVisionMethods } from "../src/gateway/vision-methods.js";
import {
  findVisionFramesForMedia,
  resetVisionFrameStore,
} from "../src/gateway/vision-frame-store.js";

function getTestPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

async function connectWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`WS connect failed: ${e}`)));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
  return ws;
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<ResponseFrame> {
  const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame: RequestFrame = { type: "req", id: reqId, method, params };
  ws.send(JSON.stringify(frame));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for response to ${method}`)),
      5000,
    );
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === reqId) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data as ResponseFrame);
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("vision.frame.upload", () => {
  let server: GatewayServer;
  let port: number;
  let ws: WebSocket;
  let mediaRoot: string;
  let originalMediaRoot: string | undefined;

  beforeEach(async () => {
    mediaRoot = mkdtempSync(join(tmpdir(), "hawky-vision-frame-test-"));
    originalMediaRoot = process.env.HAWKY_MEDIA_ROOT;
    process.env.HAWKY_MEDIA_ROOT = mediaRoot;

    resetGatewayState();
    resetVisionFrameStore();

    server = new GatewayServer(null);
    registerVisionMethods(server);

    port = getTestPort();
    server.start(port);
    ws = await connectWs(port);

    const res = await sendRequest(ws, "connect", {
      version: "test-1.0",
      platform: "test",
    });
    expect(res.ok).toBe(true);
  });

  afterEach(async () => {
    ws?.close();
    await server.stop(500);
    resetGatewayState();
    resetVisionFrameStore();

    if (originalMediaRoot === undefined) delete process.env.HAWKY_MEDIA_ROOT;
    else process.env.HAWKY_MEDIA_ROOT = originalMediaRoot;

    rmSync(mediaRoot, { recursive: true, force: true });
  });

  test("stores jpeg frame and JSON sidecar under the media root", async () => {
    const captureId = "rec-20260529-120000";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    const res = await sendRequest(ws, "vision.frame.upload", {
      capture_id: captureId,
      seq: 2,
      bytes: jpeg.toString("base64"),
      mime: "image/jpeg",
      captured_at_ns: 123_000_000,
    });

    expect(res.ok).toBe(true);
    const payload = res.payload as {
      ok: boolean;
      frame_id: string;
      path: string;
      bytes: number;
      sha256: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.frame_id).toBe(`${captureId}.frame0002`);
    expect(payload.bytes).toBe(jpeg.byteLength);
    expect(payload.sha256).toBe(createHash("sha256").update(jpeg).digest("hex"));

    const today = new Date().toISOString().slice(0, 10);
    const jpgPath = join(mediaRoot, today, `${captureId}.frame0002.jpg`);
    const sidecarPath = join(mediaRoot, today, `${captureId}.frame0002.json`);

    expect(payload.path).toBe(jpgPath);
    expect(existsSync(jpgPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);
    expect(readFileSync(jpgPath)).toEqual(jpeg);

    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    expect(sidecar.capture_id).toBe(captureId);
    expect(sidecar.frame_id).toBe(`${captureId}.frame0002`);
    expect(sidecar.mime).toBe("image/jpeg");
    expect(sidecar.bytes).toBe(jpeg.byteLength);
    expect(sidecar.captured_at_ns).toBe(123_000_000);

    const frames = findVisionFramesForMedia(`${captureId}.seg0.mic`);
    expect(frames.map((frame) => frame.seq)).toEqual([2]);
  });

  test("rejects unsupported mime types before writing a file", async () => {
    const res = await sendRequest(ws, "vision.frame.upload", {
      capture_id: "rec-unsupported",
      seq: 0,
      bytes: Buffer.from("not an image").toString("base64"),
      mime: "image/gif",
      captured_at_ns: 0,
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
    expect(res.error?.message).toContain("mime must be image/jpeg or image/png");
  });

  test("echoes jpeg metadata without storing a file", async () => {
    const captureId = "rec-echo";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    const res = await sendRequest(ws, "vision.frame.echo", {
      capture_id: captureId,
      seq: 7,
      bytes: jpeg.toString("base64"),
      mime: "image/jpeg",
      captured_at_ns: 456_000_000,
    });

    expect(res.ok).toBe(true);
    const payload = res.payload as {
      ok: boolean;
      capture_id: string;
      seq: number;
      bytes: number;
      sha256: string;
      received_at_ms: number;
      processed_at_ms: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.capture_id).toBe(captureId);
    expect(payload.seq).toBe(7);
    expect(payload.bytes).toBe(jpeg.byteLength);
    expect(payload.sha256).toBe(createHash("sha256").update(jpeg).digest("hex"));
    expect(payload.processed_at_ms).toBeGreaterThanOrEqual(payload.received_at_ms);

    const today = new Date().toISOString().slice(0, 10);
    const jpgPath = join(mediaRoot, today, `${captureId}.frame0007.jpg`);
    expect(existsSync(jpgPath)).toBe(false);
  });
});
