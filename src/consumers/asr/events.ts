// =============================================================================
// ASR bus events — the wire protocol for asr.partial / asr.final.
//
// Owned by this consumer because the producer of an event owns its shape.
// Subscribers (chat-poster, replay UI) import from here. Changing a field is
// a breaking change for every subscriber.
// =============================================================================

/** Emitted by asr-pipeline for each non-final segment (partials in batch mode
 *  fire right before the final event). */
export interface AsrPartialEvent {
  media_id: string;
  segment_index: number;
  t0_ms: number;
  t1_ms: number;
  text: string;
  backend: string;
  model: string;
}

/** Emitted by asr-pipeline once the whole transcript is ready. */
export interface AsrFinalEvent {
  media_id: string;
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
  /** Wall-clock the backend spent transcribing — upload + submit + poll for
   *  AssemblyAI, single POST round-trip for Whisper. NOT the length of the
   *  audio. Useful for backend latency dashboards; do not use as a proxy for
   *  media duration. */
  transcribe_wallclock_ms: number;
  /** Length of the source recording, forwarded from MediaFinalizedEvent so
   *  downstream consumers (chat-poster silence filter, transcript UI duration
   *  badge) can read media length without re-opening the WAV. */
  media_duration_ms: number;
  node_id: string;
  /** Forwarded from MediaFinalizedEvent so downstream consumers can anchor
   *  the voice memo to the client's capture clock rather than when the ASR
   *  finished running. */
  captured_start_iso: string;
}
