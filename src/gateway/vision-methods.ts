import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import { createSubsystemLogger } from "../logging/index.js";
import { storeVisionFrame, type VisionFrameUpload } from "./vision-frame-store.js";
import { MEDIA_ID_REGEX } from "./media-id.js";
import { createHash } from "node:crypto";

const log = createSubsystemLogger("gateway/vision-methods");
const MAX_FRAME_RAW_BYTES = 768 * 1024;
const MAX_FRAME_BASE64_LEN = Math.ceil(MAX_FRAME_RAW_BYTES * 4 / 3) + 4;
const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png"]);

export function registerVisionMethods(server: GatewayServer): void {
  server.registerMethod("vision.frame.upload", async (_conn, params) => {
    const p = parseVisionFrameParams(params);

    const entry = await storeVisionFrame({
      capture_id: p.capture_id,
      seq: p.seq,
      bytes: p.bytes,
      mime: p.mime,
      captured_at_ns: p.captured_at_ns,
    } as VisionFrameUpload);

    log.debug("vision.frame.upload", {
      capture_id: entry.capture_id,
      frame_id: entry.frame_id,
      bytes: entry.bytes,
    });

    return {
      ok: true,
      frame_id: entry.frame_id,
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    };
  });

  server.registerMethod("vision.frame.echo", async (_conn, params) => {
    const p = parseVisionFrameParams(params);
    const receivedAtMs = Date.now();
    const raw = Buffer.from(p.bytes, "base64");
    const sha256 = createHash("sha256").update(raw).digest("hex");

    return {
      ok: true,
      capture_id: p.capture_id,
      seq: p.seq,
      mime: p.mime,
      bytes: raw.byteLength,
      sha256,
      received_at_ms: receivedAtMs,
      processed_at_ms: Date.now(),
    };
  });
}

function parseVisionFrameParams(params: unknown): VisionFrameUpload {
  const p = params as Record<string, unknown> | undefined;
  if (!p) throw new MethodError("INVALID_REQUEST", "params required");

  if (typeof p.capture_id !== "string" || !MEDIA_ID_REGEX.test(p.capture_id)) {
    throw new MethodError(
      "INVALID_REQUEST",
      `capture_id must match /${MEDIA_ID_REGEX.source}/`,
    );
  }
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq < 0) {
    throw new MethodError("INVALID_REQUEST", "seq must be a non-negative integer");
  }
  if (typeof p.bytes !== "string") {
    throw new MethodError("INVALID_REQUEST", "bytes must be a base64 string");
  }
  if (p.bytes.length > MAX_FRAME_BASE64_LEN) {
    throw new MethodError(
      "INVALID_REQUEST",
      `frame too large (${p.bytes.length} base64 chars). Max ${MAX_FRAME_RAW_BYTES / 1024} KB raw per frame.`,
    );
  }
  if (typeof p.mime !== "string" || !SUPPORTED_MIMES.has(p.mime)) {
    throw new MethodError("INVALID_REQUEST", "mime must be image/jpeg or image/png");
  }
  if (typeof p.captured_at_ns !== "number") {
    throw new MethodError("INVALID_REQUEST", "captured_at_ns must be a number");
  }

  return {
    capture_id: p.capture_id,
    seq: p.seq,
    bytes: p.bytes,
    mime: p.mime as "image/jpeg" | "image/png",
    captured_at_ns: p.captured_at_ns,
  };
}
