// =============================================================================
// Dead-letter store for ASR transcription failures.
//
// File layout: ~/.hawky/workspace/asr-deadletter/<media_id>.json
// Atomic writes via rename(2). Readers tolerate a missing directory.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../../logging/index.js";

const log = createSubsystemLogger("asr/deadletter");

export interface DeadLetterEntry {
  media_id: string;
  wav_path: string;
  mime: string;
  backend: string;
  attempts: number;
  last_error: string;
  ts_iso: string;
}

function resolveDir(): string {
  if (process.env.HAWKY_ASR_DEADLETTER_DIR) return process.env.HAWKY_ASR_DEADLETTER_DIR;
  return join(homedir(), ".hawky", "workspace", "asr-deadletter");
}

function pathFor(media_id: string): string {
  const safe = media_id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return join(resolveDir(), `${safe}.json`);
}

export async function writeDeadLetter(entry: DeadLetterEntry): Promise<void> {
  const dir = resolveDir();
  mkdirSync(dir, { recursive: true });
  const finalPath = pathFor(entry.media_id);
  const tmpPath = finalPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf-8");
  await rename(tmpPath, finalPath);
  log.info("dead-letter written", { media_id: entry.media_id, path: finalPath });
}

export function listDeadLetters(): DeadLetterEntry[] {
  const dir = resolveDir();
  if (!existsSync(dir)) return [];
  const out: DeadLetterEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, name), "utf-8");
      out.push(JSON.parse(raw) as DeadLetterEntry);
    } catch (err) {
      log.warn("skipping unreadable dead-letter file", {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function loadDeadLetter(media_id: string): DeadLetterEntry | null {
  const p = pathFor(media_id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as DeadLetterEntry;
  } catch {
    return null;
  }
}

export function deleteDeadLetter(media_id: string): boolean {
  const p = pathFor(media_id);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function getDeadLetterDir(): string {
  return resolveDir();
}
