// =============================================================================
// `hawky asr-replay` — replay dead-lettered ASR items.
//
//   hawky asr-replay                  # replay all dead-lettered items
//   hawky asr-replay <media_id>       # replay one specific item
//   hawky asr-replay --dry-run        # list what would be replayed
//
// On success the dead-letter file is deleted and asr.final fires on the bus
// as if the original had succeeded. Does not start the gateway — this is an
// in-process, one-shot tool. Transcripts only: this CLI does NOT register a
// chat-poster and does NOT construct an AgentSessionManager. A successful
// replay re-publishes the transcript on the bus; live chat-poster wiring
// happens only inside the gateway process. CLI-driven replays are observable
// via stdout and the bus event stream.
// =============================================================================

import { loadConfig } from "../storage/config.js";
import { createSubsystemLogger } from "../logging/index.js";
import {
  listDeadLetters,
  loadDeadLetter,
  deleteDeadLetter,
  getDeadLetterDir,
  type DeadLetterEntry,
} from "../consumers/asr/deadletter.js";
import { createBackend } from "../consumers/asr/backends/index.js";
import { emitTranscriptEvents } from "../consumers/asr/pipeline.js";
import { getNodeId } from "../consumers/chat-poster/session-resolver.js";
import { resolveAsrConfig } from "../consumers/asr/config.js";

const log = createSubsystemLogger("cli/asr-replay");

export interface AsrReplayOptions {
  media_id?: string | null;
  dryRun?: boolean;
}

/**
 * Exit codes:
 *   0 = all entries replayed OK (or no entries)
 *   1 = configuration error (missing backend, missing creds, unsupported backend)
 *   2 = at least one entry failed transcription
 */
export async function runAsrReplay(opts: AsrReplayOptions): Promise<number> {
  const config = loadConfig();
  const asrCfg = resolveAsrConfig(config);

  if (asrCfg.backend === "disabled") {
    console.error("asr backend is disabled in config — nothing to replay against");
    return 1;
  }

  // Concurrent replay processes share the dead-letter dir without coordination — acceptable for a manual CLI tool.
  const entries: DeadLetterEntry[] = opts.media_id
    ? (() => {
        const e = loadDeadLetter(opts.media_id!);
        return e ? [e] : [];
      })()
    : listDeadLetters();

  if (entries.length === 0) {
    console.log(`No dead-lettered items in ${getDeadLetterDir()}`);
    return 0;
  }

  if (opts.dryRun) {
    console.log(`Would replay ${entries.length} item(s):`);
    for (const e of entries) {
      console.log(
        `  - ${e.media_id}  (${e.backend}, attempts=${e.attempts}, last_error="${e.last_error}")`,
      );
    }
    return 0;
  }

  let backend;
  try {
    backend = createBackend({
      backend: asrCfg.backend,
      whisper_api: asrCfg.whisper_api,
      assemblyai: asrCfg.assemblyai,
    });
  } catch (err) {
    console.error(
      `Failed to construct ASR backend: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (!backend || !backend.transcribeFile) {
    console.error(
      `Configured backend "${asrCfg.backend}" does not support transcribeFile or is missing credentials`,
    );
    return 1;
  }

  const nodeId = getNodeId();
  let okCount = 0;
  let failCount = 0;
  for (const entry of entries) {
    console.log(`Replaying ${entry.media_id} (wav=${entry.wav_path}) ...`);
    try {
      const start = Date.now();
      // Single attempt per replay item; the entry already exhausted retry upstream before reaching the dead-letter dir.
      const transcript = await backend.transcribeFile(entry.wav_path, {
        media_id: entry.media_id,
      });
      // Dead-letter entries do not carry duration / capture timestamp; replay
      // re-emits with 0 duration and the entry's dead-letter timestamp as a
      // best-effort proxy. Downstream consumers treat asr.final from replay
      // identically to live finals — see the transcript sidecar for ground truth.
      await emitTranscriptEvents(
        transcript,
        Date.now() - start,
        0,
        nodeId,
        entry.ts_iso,
        entry.wav_path,
      );
      const text = transcript.segments.map((s) => s.text).join(" ").trim();
      console.log(`  transcript: ${text}`);
      deleteDeadLetter(entry.media_id);
      okCount++;
      console.log(`  ok  ${entry.media_id} replayed, ${transcript.segments.length} segment(s)`);
    } catch (err) {
      failCount++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  fail ${entry.media_id}: ${msg}`);
      log.warn("replay failed", { media_id: entry.media_id, error: msg });
    }
  }

  console.log(`Done: ${okCount} replayed, ${failCount} failed.`);
  if (okCount > 0) {
    console.log(
      "Note: replayed transcripts wrote .transcript.json sidecars next to each WAV.",
    );
    console.log(
      "They do NOT post into chat sessions — only live captures inside the running gateway do that.",
    );
  }
  return failCount === 0 ? 0 : 2;
}

/** Parse argv slice (already past the "asr-replay" token). */
export function parseArgs(args: string[]): AsrReplayOptions {
  const opts: AsrReplayOptions = { dryRun: false, media_id: null };
  for (const a of args) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (!a.startsWith("-") && !opts.media_id) opts.media_id = a;
  }
  return opts;
}
