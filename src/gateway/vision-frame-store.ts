import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/index.js";
import { resolveMediaRoot } from "./media-root.js";

const log = createSubsystemLogger("gateway/vision-frame-store");

const MAX_FRAMES_PER_CAPTURE = 12;
const AUDIO_SEGMENT_SECONDS = 3;

export interface VisionFrameUpload {
  capture_id: string;
  seq: number;
  bytes: string;
  mime: "image/jpeg" | "image/png";
  captured_at_ns: number;
}

export interface VisionFrameEntry {
  capture_id: string;
  frame_id: string;
  seq: number;
  path: string;
  sidecar_path: string;
  mime: "image/jpeg" | "image/png";
  base64: string;
  sha256: string;
  bytes: number;
  captured_at_ns: number;
  received_iso: string;
}

const framesByCapture = new Map<string, VisionFrameEntry[]>();

export function captureIdFromMediaId(mediaId: string): string {
  return mediaId
    .replace(/\.seg\d+\.mic$/i, "")
    .replace(/\.mic$/i, "")
    .replace(/\.cam$/i, "");
}

export async function storeVisionFrame(upload: VisionFrameUpload): Promise<VisionFrameEntry> {
  const ext = upload.mime === "image/png" ? "png" : "jpg";
  const mediaRoot = resolveMediaRoot();
  const today = new Date().toISOString().slice(0, 10);
  const dir = join(mediaRoot, today);
  mkdirSync(dir, { recursive: true });

  const raw = Buffer.from(upload.bytes, "base64");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const frame_id = `${upload.capture_id}.frame${String(upload.seq).padStart(4, "0")}`;
  const path = join(dir, `${frame_id}.${ext}`);
  const sidecar_path = join(dir, `${frame_id}.json`);
  const received_iso = new Date().toISOString();

  if (existsSync(path)) {
    // Idempotent retry for the same frame. The index entry is rebuilt below.
    log.debug("vision frame overwriting existing frame", { frame_id, path });
  }

  const entry: VisionFrameEntry = {
    capture_id: upload.capture_id,
    frame_id,
    seq: upload.seq,
    path,
    sidecar_path,
    mime: upload.mime,
    base64: upload.bytes,
    sha256,
    bytes: raw.byteLength,
    captured_at_ns: upload.captured_at_ns,
    received_iso,
  };

  await writeFile(path, raw);
  await writeFile(
    sidecar_path,
    JSON.stringify(
      {
        capture_id: entry.capture_id,
        frame_id: entry.frame_id,
        seq: entry.seq,
        mime: entry.mime,
        bytes: entry.bytes,
        sha256: entry.sha256,
        captured_at_ns: entry.captured_at_ns,
        received_iso: entry.received_iso,
        path: entry.path,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const existing = framesByCapture.get(upload.capture_id) ?? [];
  const deduped = existing.filter((f) => f.seq !== upload.seq);
  deduped.push(entry);
  deduped.sort((a, b) => a.seq - b.seq);
  framesByCapture.set(upload.capture_id, deduped.slice(-MAX_FRAMES_PER_CAPTURE));

  log.info("vision frame stored", {
    capture_id: entry.capture_id,
    frame_id: entry.frame_id,
    bytes: entry.bytes,
    path: entry.path,
  });

  return entry;
}

export function findVisionFramesForMedia(mediaId: string, limit = 3): VisionFrameEntry[] {
  const captureId = captureIdFromMediaId(mediaId);
  const frames = framesByCapture.get(captureId) ?? [];
  const segmentIndex = segmentIndexFromMediaId(mediaId);
  if (segmentIndex == null) return frames.slice(-limit);

  const startSeq = segmentIndex * AUDIO_SEGMENT_SECONDS;
  const endSeq = startSeq + AUDIO_SEGMENT_SECONDS - 1;
  const aligned = frames.filter((frame) => frame.seq >= startSeq && frame.seq <= endSeq);
  return (aligned.length > 0 ? aligned : frames).slice(-limit);
}

function segmentIndexFromMediaId(mediaId: string): number | null {
  const match = /\.seg(\d+)\.mic$/i.exec(mediaId);
  if (!match) return null;
  const idx = Number.parseInt(match[1], 10);
  return Number.isFinite(idx) ? idx : null;
}

export function resetVisionFrameStore(): void {
  framesByCapture.clear();
}
