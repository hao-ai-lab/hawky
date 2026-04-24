// =============================================================================
// Shared config resolver — pulls the ASR section out of the top-level
// HawkyConfig (with sensible defaults) so the gateway wiring path produces
// a consistent backend + pipeline configuration.
// =============================================================================

import type { HawkyConfig } from "../../agent/types.js";
import { DEFAULT_WHISPER_API_CONFIG, type WhisperAPIConfig } from "./backends/whisper-api.js";
import { DEFAULT_ASSEMBLYAI_CONFIG, type AssemblyAIConfig } from "./backends/assemblyai.js";
import type { BackendName } from "./backends/index.js";
import type { AsrPipelineConfig } from "./pipeline.js";
import type { PolicyName, RetryConfig } from "./failure-policy.js";
import type { ChatPosterConfig } from "../chat-poster/index.js";

export interface ResolvedAsrConfig extends AsrPipelineConfig {
  backend: BackendName;
  whisper_api: WhisperAPIConfig;
  assemblyai: AssemblyAIConfig;
}

const DEFAULT_RETRY: RetryConfig = {
  max_attempts: 3,
  initial_ms: 500,
  multiplier: 2.0,
  jitter_ms: 100,
};

export function resolveAsrConfig(config: HawkyConfig): ResolvedAsrConfig {
  const raw = config.asr ?? {};
  const backend: BackendName = (raw.backend as BackendName) ?? "whisper-api";
  const failurePolicy: PolicyName =
    (raw.failure_policy as PolicyName) ?? "retry-then-dead-letter";
  return {
    enabled: raw.enabled ?? true,
    mode: (raw.mode ?? "batch") as "batch" | "streaming",
    failure_policy: failurePolicy,
    retry: { ...DEFAULT_RETRY, ...(raw.retry ?? {}) },
    lang: raw.lang,
    backend,
    whisper_api: { ...DEFAULT_WHISPER_API_CONFIG, ...(raw.whisper_api ?? {}) },
    assemblyai: { ...DEFAULT_ASSEMBLYAI_CONFIG, ...(raw.assemblyai ?? {}) },
  };
}

// -----------------------------------------------------------------------------
// chat-poster config — pulled out so the wiring path can construct a config
// without inspecting the raw object inline. Validates session_id_override
// before it lands in AgentSessionManager.getOrCreate(), which maps the key
// onto a filesystem path: an empty string or a traversal pattern must never
// reach that layer.
// -----------------------------------------------------------------------------

const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,63}$/;

function validateSessionIdOverride(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") {
    throw new Error(`chat_poster.session_id_override must be a string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!SESSION_KEY_RE.test(trimmed)) {
    throw new Error(
      `chat_poster.session_id_override "${trimmed}" is invalid: must match ${SESSION_KEY_RE} ` +
        `(no traversal, whitespace, or shell-unsafe characters; first char alphanumeric; ≤64 chars).`,
    );
  }
  return trimmed;
}

export function resolveChatPosterConfig(config: HawkyConfig): ChatPosterConfig {
  const raw = (config as any).chat_poster ?? {};
  return {
    enabled: raw.enabled ?? true,
    session_id_override: validateSessionIdOverride(raw.session_id_override),
    prefix: typeof raw.prefix === "string" ? raw.prefix : "",
    include_confidence: raw.include_confidence === true,
    ...(Array.isArray(raw.silence_denylist)
      ? { silence_denylist: raw.silence_denylist as ReadonlyArray<string> }
      : {}),
    ...(typeof raw.min_confidence === "number" ? { min_confidence: raw.min_confidence } : {}),
    ...(typeof raw.min_duration_ms === "number" ? { min_duration_ms: raw.min_duration_ms } : {}),
    ...(typeof raw.debounce_ms === "number" ? { debounce_ms: raw.debounce_ms } : {}),
    ...(typeof raw.flush_age_ms === "number" ? { flush_age_ms: raw.flush_age_ms } : {}),
    ...(typeof raw.max_items === "number" ? { max_items: raw.max_items } : {}),
    ...(typeof raw.max_chars === "number" ? { max_chars: raw.max_chars } : {}),
  };
}
