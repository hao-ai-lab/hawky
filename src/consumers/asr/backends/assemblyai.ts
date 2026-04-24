// =============================================================================
// AssemblyAIBackend — batch upload + poll.
//
// Three-step REST flow:
//
//   1. POST  {endpoint}/v2/upload           raw wav bytes → { upload_url }
//   2. POST  {endpoint}/v2/transcript       { audio_url, punctuate, format_text }
//                                           → { id, status: "queued", ... }
//   3. GET   {endpoint}/v2/transcript/{id}  poll every poll_interval_ms until
//                                           status ∈ { completed, error } or
//                                           timeout_ms elapses.
//
// Auth header on every request: `Authorization: ${api_key}` (no "Bearer ").
//
// Segmentation: we chunk AssemblyAI's word-level timestamps into
// ~5-second windows so downstream consumers (chat-poster alignment,
// vision sync, diarization overlays) get per-segment t0/t1 boundaries
// instead of one span that covers the whole transcript. When `words` is
// empty we fall back to a single synthetic segment so downstream
// emitters always have something to work with.
// =============================================================================

import { createSubsystemLogger } from "../../../logging/index.js";
import type { ASRBackend, Transcript } from "../types.js";

const log = createSubsystemLogger("asr/assemblyai");

export interface AssemblyAIConfig {
  endpoint: string;
  api_key_env: string;
  timeout_ms: number;
  poll_interval_ms: number;
  /** AssemblyAI speech model — sent to /v2/transcript as `speech_models`
   *  and echoed onto the resulting Transcript.model so the bus event and
   *  sidecar truthfully report what generated the text. */
  speech_model: string;
}

export const DEFAULT_ASSEMBLYAI_CONFIG: AssemblyAIConfig = {
  endpoint: "https://api.assemblyai.com",
  api_key_env: "ASSEMBLYAI_API_KEY",
  timeout_ms: 300_000,
  poll_interval_ms: 2_000,
  speech_model: "universal-2",
};

interface UploadResponse {
  upload_url?: string;
}

interface TranscriptWord {
  start?: number;
  end?: number;
  text?: string;
  confidence?: number;
}

interface TranscriptResponse {
  id?: string;
  status?: "queued" | "processing" | "completed" | "error";
  text?: string;
  words?: TranscriptWord[];
  confidence?: number;
  language_code?: string;
  error?: string;
}

export class AssemblyAIBackend implements ASRBackend {
  readonly name = "assemblyai";
  readonly capabilities = {
    batch: true,
    streaming: false,
    partials: false,
    diarization: false,
    langs: ["*"],
  };

  private readonly config: AssemblyAIConfig;

  constructor(config: Partial<AssemblyAIConfig> = {}) {
    this.config = { ...DEFAULT_ASSEMBLYAI_CONFIG, ...config };
    if (!this.config.api_key_env) {
      throw new Error("AssemblyAI backend requires api_key_env");
    }
    // The factory pre-checks that process.env[this.config.api_key_env] is set
    // before instantiating any backend; reaching this constructor without the
    // env var indicates a programmer error (e.g. constructing the class
    // directly in a test). Fail loud rather than running with a missing key.
    if (!process.env[this.config.api_key_env]) {
      throw new Error(
        `${this.config.api_key_env} is not set — cannot construct AssemblyAI backend`,
      );
    }
  }

  async transcribeFile(
    wavPath: string,
    opts: { media_id: string; lang?: string },
  ): Promise<Transcript> {
    const apiKey = process.env[this.config.api_key_env];
    if (!apiKey) {
      throw new Error(
        `${this.config.api_key_env} is not set — cannot call AssemblyAI API`,
      );
    }

    const started = Date.now();

    // ---- Step 1: upload ----
    // Pass the file path — uploadAudio streams via Bun.file() to avoid
    // slurping a multi-hundred-MB capture into memory (previously
    // `readFile(wavPath)` OOM'd on long sessions).
    const uploadUrl = await this.uploadAudio(apiKey, wavPath);

    // ---- Step 2: submit transcript ----
    const transcriptId = await this.submitTranscript(apiKey, uploadUrl, opts.lang);

    // ---- Step 3: poll ----
    const final = await this.pollTranscript(apiKey, transcriptId, started);

    const words = Array.isArray(final.words) ? final.words : [];
    const text = (final.text ?? "").trim();
    const segments = segmentFromWords(words, text, final.confidence);

    log.info("assemblyai transcription complete", {
      media_id: opts.media_id,
      transcript_id: transcriptId,
      word_count: words.length,
      lang: final.language_code ?? "unknown",
      elapsed_ms: Date.now() - started,
    });

    return {
      media_id: opts.media_id,
      lang: final.language_code ?? "unknown",
      backend: this.name,
      model: this.config.speech_model,
      segments,
    };
  }

  private async uploadAudio(apiKey: string, wavPath: string): Promise<string> {
    const url = `${this.config.endpoint}/v2/upload`;
    // Bun.file(path) behaves as a Blob; passing it as the fetch body
    // streams the bytes off disk in chunks instead of materializing the
    // entire WAV in memory. Critical for long captures — a 60-minute
    // 48 kHz mono recording is ~345 MB.
    const blob = Bun.file(wavPath);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/octet-stream",
      },
      body: blob,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `AssemblyAI upload HTTP ${resp.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
      );
    }

    const body = (await resp.json()) as UploadResponse;
    if (!body.upload_url || typeof body.upload_url !== "string") {
      throw new Error("AssemblyAI upload succeeded but response missing upload_url");
    }
    return body.upload_url;
  }

  private async submitTranscript(
    apiKey: string,
    audioUrl: string,
    lang?: string,
  ): Promise<string> {
    const url = `${this.config.endpoint}/v2/transcript`;
    const payload: Record<string, unknown> = {
      audio_url: audioUrl,
      speech_models: [this.config.speech_model],
      punctuate: true,
      format_text: true,
    };
    if (lang) payload.language_code = lang;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `AssemblyAI submit HTTP ${resp.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
      );
    }

    const body = (await resp.json()) as TranscriptResponse;
    if (!body.id || typeof body.id !== "string") {
      throw new Error("AssemblyAI submit succeeded but response missing id");
    }
    return body.id;
  }

  private async pollTranscript(
    apiKey: string,
    transcriptId: string,
    started: number,
  ): Promise<TranscriptResponse> {
    const url = `${this.config.endpoint}/v2/transcript/${transcriptId}`;

    while (true) {
      if (Date.now() - started >= this.config.timeout_ms) {
        throw new Error(
          `AssemblyAI poll timed out after ${this.config.timeout_ms}ms (transcript_id=${transcriptId})`,
        );
      }

      const resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: apiKey },
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(
          `AssemblyAI poll HTTP ${resp.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
        );
      }

      const body = (await resp.json()) as TranscriptResponse;

      if (body.status === "completed") {
        return body;
      }
      if (body.status === "error") {
        throw new Error(
          `AssemblyAI transcription error: ${body.error ?? "unknown error"}`,
        );
      }

      // queued | processing → wait and retry (bounded by timeout_ms above).
      const remaining = this.config.timeout_ms - (Date.now() - started);
      if (remaining <= 0) {
        throw new Error(
          `AssemblyAI poll timed out after ${this.config.timeout_ms}ms (transcript_id=${transcriptId})`,
        );
      }
      const sleepMs = Math.min(this.config.poll_interval_ms, remaining);
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}

// -----------------------------------------------------------------------------
// Segmentation: word-level timestamps → ~5s segments
// -----------------------------------------------------------------------------

/** Max duration a single segment is allowed to span before we close it. */
const SEGMENT_TARGET_MS = 5_000;

/**
 * Collapse AssemblyAI's per-word timing into coarser ~5-second segments.
 * Closes a segment whenever appending the next word would push it past
 * SEGMENT_TARGET_MS (measured against the segment's t0_ms). Confidence on
 * each segment is the mean of its contributing word confidences (falling
 * back to the transcript-level confidence when a word omits it).
 *
 * Falls back to a single synthetic segment when `words` is empty — so a
 * transcript-only response (no per-word timings) still produces a
 * non-empty `segments` array for the chat-poster.
 */
export function segmentFromWords(
  words: TranscriptWord[],
  fullText: string,
  transcriptConfidence?: number,
): Transcript["segments"] {
  if (words.length === 0) {
    return [{ t0_ms: 0, t1_ms: 0, text: fullText, confidence: transcriptConfidence }];
  }

  interface Bucket {
    t0_ms: number;
    t1_ms: number;
    parts: string[];
    confidences: number[];
  }
  const buckets: Bucket[] = [];
  let cur: Bucket | null = null;

  for (const w of words) {
    const start: number = typeof w.start === "number" ? w.start : cur?.t1_ms ?? 0;
    const end = typeof w.end === "number" ? w.end : start;
    const text = (w.text ?? "").trim();
    if (!text) continue;

    if (!cur || end - cur.t0_ms > SEGMENT_TARGET_MS) {
      cur = { t0_ms: start, t1_ms: end, parts: [text], confidences: [] };
      buckets.push(cur);
    } else {
      cur.t1_ms = end;
      cur.parts.push(text);
    }
    if (typeof w.confidence === "number") {
      cur.confidences.push(w.confidence);
    }
  }

  return buckets.map((b) => {
    const meanConf = b.confidences.length > 0
      ? b.confidences.reduce((s, c) => s + c, 0) / b.confidences.length
      : transcriptConfidence;
    return {
      t0_ms: b.t0_ms,
      t1_ms: b.t1_ms,
      text: b.parts.join(" "),
      confidence: meanConf,
    };
  });
}
