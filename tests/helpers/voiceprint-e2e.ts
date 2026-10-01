// Shared harness for the two voiceprint gateway e2e specs:
//   - tests/e2e-voiceprint-pipeline.ts (track 1: reference backend, always runs)
//   - tests/e2e-voiceprint-onnx.ts     (track 2: real CAM++, gated on assets)
//
// Both specs drive the REAL gateway RPC handlers via a tiny in-process JSON-RPC
// server, register finalized media artifacts by writing `<mediaId>.json` sidecars,
// and precompute owner templates through the REAL embedding sidecar. Only the
// backend (reference vs onnx) and its numerics differ; the wiring below is identical,
// so it lives here to keep the two specs focused on what each track actually proves.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Frozen ISO timestamps used across both e2e specs for created/updated metadata. */
export const CREATED_AT = "2026-06-23T00:00:00.000Z";
export const UPDATED_AT = "2026-06-23T00:00:01.000Z";

export interface MockRpcConn {
  sessionKey: string | null;
}

export interface MockRpcServer {
  registerMethod(name: string, handler: Function): void;
  call(name: string, conn: MockRpcConn, params: unknown): unknown;
}

/**
 * Minimal in-process JSON-RPC server: `registerVoiceprintMethods` registers handlers
 * onto it, and `call` invokes one with the same `(conn, params, server)` signature the
 * real gateway uses — no network, no framing.
 */
export function makeMockServer(): MockRpcServer {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: MockRpcConn, params: unknown) {
      const method = methods[name];
      if (!method) {
        throw new Error(`Method not found: ${name}`);
      }
      return method(conn, params, this);
    },
  };
}

/** Cosine similarity of two equal-length embedding vectors (0 for a zero vector). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Writes a mono 16-bit PCM WAV of a sine at `freqHz` so different turns produce different audio. */
export function writeSineWav(
  path: string,
  freqHz: number,
  durationMs = 1500,
  sampleRate = 16000,
): void {
  // Ensure the parent dir exists: a mid-test abort in one spec can otherwise race the
  // shared afterEach cleanup and delete a sibling temp dir out from under the next test,
  // surfacing as an ENOENT "unhandled error between tests". mkdir -p makes writes robust
  // to that interleaving instead of failing on a just-deleted directory.
  mkdirSync(dirname(path), { recursive: true });
  const sampleCount = Math.round((durationMs / 1000) * sampleRate);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.5 * 32767);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  writeFileSync(path, buffer);
}

/**
 * Writes the `<mediaId>.json` finalized-media sidecar into `root` so
 * `identity.voiceprint.audio_artifact.register` can resolve `<mediaId>` there.
 *
 * The registration path only accepts artifacts whose sidecar has a truthy `final_iso`
 * and an `audio/*` `mime` (it derives the sample rate from the mime); the remaining
 * fields are realistic padding. Scoring reads audio only for turns whose
 * audioArtifactId resolves to such a registered artifact, so writing this sidecar is
 * required to exercise the real score -> slice -> embed flow (a bare audioPath is
 * skipped as missing_audio_artifact).
 */
export function writeMediaSidecar(
  root: string,
  mediaId: string,
  mime = "audio/pcm16;rate=16000",
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${mediaId}.json`),
    JSON.stringify(
      {
        mime,
        captured_start_iso: CREATED_AT,
        locked: false,
        final_iso: CREATED_AT,
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Writes a finalized gateway media artifact (`<mediaId>.wav` sine tone + its
 * `<mediaId>.json` sidecar) into `root`, returning the WAV path. Used by the
 * reference-backend track, where distinct sine frequencies stand in for distinct clips.
 */
export function writeFinalizedMediaWav(root: string, mediaId: string, freqHz: number): string {
  const audioPath = join(root, `${mediaId}.wav`);
  writeSineWav(audioPath, freqHz);
  writeMediaSidecar(root, mediaId);
  return audioPath;
}
