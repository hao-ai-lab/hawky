// =============================================================================
// Backend registry — pick an ASRBackend from config.
// =============================================================================

import { createSubsystemLogger } from "../../../logging/index.js";
import type { ASRBackend } from "../types.js";
import { WhisperAPIBackend, DEFAULT_WHISPER_API_CONFIG, type WhisperAPIConfig } from "./whisper-api.js";
import { AssemblyAIBackend, DEFAULT_ASSEMBLYAI_CONFIG, type AssemblyAIConfig } from "./assemblyai.js";

const log = createSubsystemLogger("asr/factory");

export type BackendName =
  | "whisper-api"
  | "whisper-cpp"
  | "deepgram"
  | "assemblyai"
  | "disabled";

export interface BackendConfig {
  backend: BackendName;
  whisper_api?: Partial<WhisperAPIConfig>;
  assemblyai?: Partial<AssemblyAIConfig>;
}

/**
 * Build a backend from config, or return null when construction is impossible
 * for an environmental reason (e.g. the API-key env var is missing). Caller
 * (src/index.ts) skips pipeline registration on null so the gateway never
 * runs a structurally non-functional ASR pipeline that would write empty
 * sidecars and fire empty asr.final events.
 *
 * Throws only on programmer errors (unknown backend, unimplemented backend) —
 * those should fail the gateway loud at boot.
 */
export function createBackend(cfg: BackendConfig): ASRBackend | null {
  switch (cfg.backend) {
    case "disabled":
      return null;
    case "whisper-api": {
      const merged: WhisperAPIConfig = { ...DEFAULT_WHISPER_API_CONFIG, ...cfg.whisper_api };
      if (!process.env[merged.api_key_env]) {
        log.info(
          `${merged.api_key_env} is not set — skipping whisper-api backend (no pipeline registered)`,
        );
        return null;
      }
      return new WhisperAPIBackend(merged);
    }
    case "assemblyai": {
      const merged: AssemblyAIConfig = { ...DEFAULT_ASSEMBLYAI_CONFIG, ...cfg.assemblyai };
      if (!process.env[merged.api_key_env]) {
        log.info(
          `${merged.api_key_env} is not set — skipping assemblyai backend (no pipeline registered)`,
        );
        return null;
      }
      return new AssemblyAIBackend(merged);
    }
    case "whisper-cpp":
    case "deepgram":
      throw new Error(`ASR backend "${cfg.backend}" not implemented`);
    default: {
      const exhaustive: never = cfg.backend;
      throw new Error(
        `unknown ASR backend: ${exhaustive} (valid: whisper-api, assemblyai, disabled)`,
      );
    }
  }
}

// Re-exports for convenience
export { WhisperAPIBackend, DEFAULT_WHISPER_API_CONFIG } from "./whisper-api.js";
export type { WhisperAPIConfig } from "./whisper-api.js";
export { AssemblyAIBackend, DEFAULT_ASSEMBLYAI_CONFIG } from "./assemblyai.js";
export type { AssemblyAIConfig } from "./assemblyai.js";
