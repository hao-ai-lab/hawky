// =============================================================================
// asr-pipeline — subscribes to `media.finalized` (filtering kind === "mic"),
// drives the configured ASRBackend through the configured failure policy, and
// publishes `asr.partial` per segment plus `asr.final`. The media_id is carried
// in the event payload; subscribers filter on event.media_id if needed.
//
// See design doc §2, §5, §7, §8.
// =============================================================================

import { createSubsystemLogger } from "../../logging/index.js";
import { getBus } from "../../bus/index.js";
import type { MediaFinalizedEvent } from "../../bus/events.js";
import type { AsrPartialEvent, AsrFinalEvent } from "./events.js";
import { createFailurePolicy, type FailurePolicy, type PolicyName, type RetryConfig } from "./failure-policy.js";
import type { ASRBackend, Transcript } from "./types.js";
import {
  writeTranscriptSidecar,
  type TranscriptSidecar,
} from "./transcript-store.js";

const log = createSubsystemLogger("asr/pipeline");

export interface AsrPipelineConfig {
  enabled: boolean;
  mode: "batch" | "streaming";
  failure_policy: PolicyName;
  retry?: Partial<RetryConfig>;
  lang?: string;
}

export interface AsrPipelineDeps {
  backend: ASRBackend;
  config: AsrPipelineConfig;
  policy?: FailurePolicy; // test hook
}

/** Emit asr.<id>.partial for all but the last segment, then asr.<id>.final. */
export function emitTranscriptEvents(
  transcript: Transcript,
  transcribeWallclockMs: number,
  mediaDurationMs: number,
  nodeId: string,
  capturedStartIso: string,
  wavPath?: string,
): void {
  const bus = getBus();
  const { media_id, segments, backend, model, lang } = transcript;

  // Batch partials-then-final pattern (§7)
  if (segments.length > 1) {
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const partial: AsrPartialEvent = {
        media_id,
        segment_index: i,
        t0_ms: seg.t0_ms,
        t1_ms: seg.t1_ms,
        text: seg.text,
        backend,
        model,
      };
      bus.publish("asr.partial", partial);
    }
  }

  const fullText = segments.map((s) => s.text).join(" ").trim();
  const finalSegments = segments.map((s) => ({
    t0_ms: s.t0_ms,
    t1_ms: s.t1_ms,
    text: s.text,
    ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
  }));
  const finalEvt: AsrFinalEvent = {
    media_id,
    lang,
    text: fullText,
    segments: finalSegments,
    backend,
    model,
    transcribe_wallclock_ms: transcribeWallclockMs,
    media_duration_ms: mediaDurationMs,
    node_id: nodeId,
    captured_start_iso: capturedStartIso,
  };

  // Persist sidecar BEFORE publishing asr.final so replay-style consumers can
  // observe it synchronously with the event. Failure here must never block the
  // bus event — log a warning and continue.
  if (wavPath) {
    const sidecar: TranscriptSidecar = {
      media_id,
      wav_path: wavPath,
      lang,
      text: fullText,
      segments: finalSegments,
      backend,
      model,
      transcribe_wallclock_ms: transcribeWallclockMs,
      media_duration_ms: mediaDurationMs,
      completed_at_iso: new Date().toISOString(),
    };
    writeTranscriptSidecar(sidecar).catch((err) => {
      log.warn("transcript sidecar write failed", {
        media_id,
        wav_path: wavPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  bus.publish("asr.final", finalEvt);
}

/**
 * Register the pipeline on the bus. Returns an unsubscribe function.
 * Returns a no-op unsubscribe when disabled.
 */
export function registerAsrPipeline(deps: AsrPipelineDeps): () => void {
  const { backend, config } = deps;
  if (!config.enabled) {
    log.info("asr pipeline disabled — skipping subscription");
    return () => {};
  }
  if (config.mode === "streaming" && !backend.capabilities.streaming) {
    // Previously this silently fell back to batch, which meant flipping
    // `mode: "streaming"` in config looked successful but produced no
    // behavior change. Refuse to start instead — loud enough that a
    // future contributor adding a streaming backend will notice this
    // check needs updating, and loud enough that a misconfigured prod
    // gateway fails its health check instead of quietly running batch.
    throw new Error(
      `asr.mode="streaming" requested but backend "${backend.name}" has no streaming implementation. ` +
      `Remove the mode override or pick a streaming-capable backend.`,
    );
  }
  if (!backend.transcribeFile) {
    log.warn("backend does not implement transcribeFile — pipeline disabled");
    return () => {};
  }

  const policy =
    deps.policy ??
    createFailurePolicy(config.failure_policy, config.retry ?? {});

  const bus = getBus();
  const unsub = bus.subscribe<MediaFinalizedEvent>(
    "media.finalized",
    async (event) => {
      if (event.kind !== "mic") return; // cam finalized events: ignore for now

      log.info("media.finalized received — transcribing", {
        media_id: event.media_id,
        duration_ms: event.duration_ms,
      });

      const start = Date.now();
      const transcript = await policy.execute(
        () =>
          backend.transcribeFile!(event.path, {
            media_id: event.media_id,
            lang: config.lang,
          }),
        {
          media_id: event.media_id,
          wav_path: event.path,
          mime: event.mime,
          backend: backend.name,
        },
      );
      if (!transcript) return; // policy already logged / dead-lettered

      emitTranscriptEvents(
        transcript,
        Date.now() - start,
        event.duration_ms,
        event.node_id,
        event.captured_start_iso,
        event.path,
      );
    },
  );

  log.info("asr pipeline registered", {
    backend: backend.name,
    mode: config.mode,
    failure_policy: config.failure_policy,
  });
  return unsub;
}
