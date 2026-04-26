// =============================================================================
// gemini-live-channel — config resolver.
//
// Coerces the optional `live_consumer` section of HawkyConfig into a
// fully-populated GeminiLiveConsumerConfig with defaults applied.
// =============================================================================

import type { HawkyConfig } from "../../agent/types.js";
import {
  DEFAULT_GEMINI_LIVE_CONSUMER_CONFIG,
  type GeminiLiveConsumerConfig,
  type GeminiLiveProvider,
} from "./index.js";

export function resolveGeminiLiveConsumerConfig(
  config: HawkyConfig,
): GeminiLiveConsumerConfig {
  const raw = config.live_consumer ?? {};

  const provider: GeminiLiveProvider =
    raw.provider === "gemini-live" ? "gemini-live" : "none";

  const idle =
    typeof raw.idle_reaper_ms === "number" && raw.idle_reaper_ms > 0
      ? Math.floor(raw.idle_reaper_ms)
      : DEFAULT_GEMINI_LIVE_CONSUMER_CONFIG.idle_reaper_ms;

  const modalities =
    Array.isArray(raw.response_modalities) && raw.response_modalities.length > 0
      ? raw.response_modalities.filter((m): m is "TEXT" | "AUDIO" =>
          m === "TEXT" || m === "AUDIO",
        )
      : DEFAULT_GEMINI_LIVE_CONSUMER_CONFIG.response_modalities;

  return {
    provider,
    model: typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : null,
    idle_reaper_ms: idle,
    tools_enabled:
      typeof raw.tools_enabled === "boolean"
        ? raw.tools_enabled
        : DEFAULT_GEMINI_LIVE_CONSUMER_CONFIG.tools_enabled,
    response_modalities:
      modalities.length > 0
        ? modalities
        : DEFAULT_GEMINI_LIVE_CONSUMER_CONFIG.response_modalities,
  };
}
