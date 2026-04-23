// =============================================================================
// Event Shapes — the wire protocol on the in-process bus.
//
// These types are load-bearing: every consumer relies on them. Changing a
// field is a breaking change for every subscriber. See design doc §4.
//
// This PR (bus substrate) only owns MediaFinalizedEvent. ASR and chat events
// are declared by the producers that emit them, in their own PRs.
// =============================================================================

/** Emitted by media writers when a capture has been fully flushed to disk. */
export interface MediaFinalizedEvent {
  media_id: string;
  kind: "mic" | "cam";
  path: string;          // absolute path to .wav / .mp4
  sidecar_path: string;  // absolute path to .json
  duration_ms: number;
  sha256: string;
  mime: string;          // e.g. "audio/pcm16;rate=48000"
  node_id: string;
  /**
   * ISO 8601 timestamp of when the first chunk for this capture was
   * received by the gateway. Surfaced from the sidecar (`captured_start_iso`)
   * so downstream consumers (chat-poster alignment, transcription
   * timelines) can show "voice memo from 09:42 PM" with the actual
   * capture time rather than the finalize time.
   */
  captured_start_iso: string;
}

/**
 * Emitted by the live-chunk writer for each self-contained frame / audio-chunk
 * that lands on disk. No debounce, no lane batching — consumers get the raw
 * firehose and decide what to buffer. See research/priority-stream-contract.md.
 */
export interface MediaLiveChunkEvent {
  session_key: string;
  media_kind: "frame" | "audio_chunk";
  file_path: string;            // absolute path under live/
  seq: number;
  ts_captured_ns?: number;      // from RPC, pass-through
  device_id?: string;           // from RPC, pass-through
  size_bytes: number;
  duration_ms?: number;         // audio_chunk only
}
