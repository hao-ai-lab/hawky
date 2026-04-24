// =============================================================================
// WhisperAPIBackend — DeepInfra OpenAI-compatible Whisper.
//
// POSTs the .wav file as multipart/form-data to the configured endpoint:
//
//   POST https://api.deepinfra.com/v1/openai/audio/transcriptions
//   Authorization: Bearer $DEEPINFRA_API_KEY
//   Content-Type: multipart/form-data
//     file:            <wav bytes>
//     model:           openai/whisper-large-v3
//     response_format: verbose_json
//
// verbose_json responses include a `segments: [{start, end, text}, ...]` array
// that maps directly onto Transcript.segments[]. `start`/`end` are seconds;
// we convert to ms for the bus.
// =============================================================================

import { basename } from "node:path";
import { createSubsystemLogger } from "../../../logging/index.js";
import type { ASRBackend, Transcript } from "../types.js";

const log = createSubsystemLogger("asr/whisper-api");

export interface WhisperAPIConfig {
  endpoint: string;
  model: string;
  api_key_env: string;
  timeout_ms: number;
}

export const DEFAULT_WHISPER_API_CONFIG: WhisperAPIConfig = {
  endpoint: "https://api.deepinfra.com/v1/openai/audio/transcriptions",
  model: "openai/whisper-large-v3",
  api_key_env: "DEEPINFRA_API_KEY",
  timeout_ms: 60_000,
};

interface VerboseJsonResponse {
  text?: string;
  language?: string;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
}

export class WhisperAPIBackend implements ASRBackend {
  readonly name = "deepinfra-whisper";
  readonly capabilities = {
    batch: true,
    streaming: false,
    partials: false,
    diarization: false,
    langs: ["*"],
  };

  constructor(private config: WhisperAPIConfig = DEFAULT_WHISPER_API_CONFIG) {
    if (!this.config.api_key_env) {
      throw new Error("Whisper backend requires api_key_env");
    }
    // The factory pre-checks that process.env[this.config.api_key_env] is set
    // before instantiating any backend; reaching this constructor without the
    // env var indicates a programmer error. Fail loud rather than running
    // with a missing key — otherwise the failure policy burns its entire
    // retry budget on a non-retryable condition.
    if (!process.env[this.config.api_key_env]) {
      throw new Error(
        `${this.config.api_key_env} is not set — cannot construct Whisper backend`,
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
        `${this.config.api_key_env} is not set — cannot call Whisper API`,
      );
    }

    // Stream the WAV from disk via Bun.file(), which exposes a Blob
    // interface — fetch/FormData will read it chunked instead of
    // pulling the whole file into memory. A 60-minute 48 kHz capture is
    // ~345 MB; the previous `readFile` approach OOM'd on long sessions.
    const blob = Bun.file(wavPath);
    const form = new FormData();
    form.append("file", blob, basename(wavPath));
    form.append("model", this.config.model);
    form.append("response_format", "verbose_json");
    if (opts.lang) form.append("language", opts.lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_ms);
    let resp: Response;
    try {
      resp = await fetch(this.config.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(
        `Whisper API HTTP ${resp.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
      );
    }

    const body = (await resp.json()) as VerboseJsonResponse;
    const rawSegments = Array.isArray(body.segments) ? body.segments : [];
    const segments = rawSegments
      .filter((s) => typeof s.text === "string")
      .map((s) => ({
        t0_ms: Math.round((s.start ?? 0) * 1000),
        t1_ms: Math.round((s.end ?? s.start ?? 0) * 1000),
        text: (s.text ?? "").trim(),
      }));

    // If verbose_json returned no segments, fall back to single-segment text
    // so downstream emitters always have something.
    if (segments.length === 0 && typeof body.text === "string" && body.text.trim()) {
      segments.push({ t0_ms: 0, t1_ms: 0, text: body.text.trim() });
    }

    log.info("whisper transcription complete", {
      media_id: opts.media_id,
      segment_count: segments.length,
      lang: body.language ?? "unknown",
    });

    return {
      media_id: opts.media_id,
      lang: body.language ?? "unknown",
      backend: this.name,
      model: this.config.model,
      segments,
    };
  }
}
