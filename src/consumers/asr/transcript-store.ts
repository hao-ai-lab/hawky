// =============================================================================
// transcript-store — persists transcripts as a sidecar JSON file next to the
// WAV. Purely additive; decouples transcription persistence from chat delivery.
//
// Given a wav at <dir>/<media_id>.wav, the sidecar is written to
// <dir>/<media_id>.transcript.json. Writing is idempotent (overwrites).
// =============================================================================

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { createSubsystemLogger } from "../../logging/index.js";

const log = createSubsystemLogger("asr/transcript-store");

export interface TranscriptSidecar {
  media_id: string;
  wav_path: string;
  lang: string;
  text: string;
  segments: Array<{
    t0_ms: number;
    t1_ms: number;
    text: string;
    confidence?: number;
  }>;
  backend: string;
  model: string;
  /** Wall-clock the backend spent transcribing. Distinct from media length. */
  transcribe_wallclock_ms: number;
  /** Length of the source audio, forwarded from MediaFinalizedEvent. */
  media_duration_ms: number;
  completed_at_iso: string;
}

/** Derive the sidecar path from a WAV path by swapping the suffix. */
export function sidecarPathFor(wavPath: string): string {
  return wavPath.replace(/\.wav$/i, ".transcript.json");
}

/**
 * Write the transcript sidecar next to the WAV. Idempotent: overwrites any
 * existing sidecar with the same name. Ensures the parent directory exists.
 *
 * Atomic: write the full JSON body to `<path>.tmp`, then `rename` into
 * place. Readers only ever see either the old sidecar or the fully-written
 * new one — never a half-written JSON body from a crash mid-write. Mirrors
 * the dead-letter writer's tmp+rename discipline (see deadletter.ts) so
 * consumers can trust any sidecar that exists on disk.
 */
export async function writeTranscriptSidecar(sidecar: TranscriptSidecar): Promise<void> {
  const outPath = sidecarPathFor(sidecar.wav_path);
  const tmpPath = `${outPath}.tmp`;
  await mkdir(dirname(outPath), { recursive: true });
  const body = JSON.stringify(sidecar, null, 2);
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, outPath);
  log.debug("wrote transcript sidecar", {
    media_id: sidecar.media_id,
    path: outPath,
    bytes: body.length,
  });
}

/**
 * Read the sidecar that belongs to the given WAV path. Returns null if the
 * file does not exist; throws if the file exists but contains corrupt JSON.
 */
export async function readTranscriptSidecar(wavPath: string): Promise<TranscriptSidecar | null> {
  const p = sidecarPathFor(wavPath);
  if (!existsSync(p)) return null;
  const body = await readFile(p, "utf8");
  return JSON.parse(body) as TranscriptSidecar;
}

