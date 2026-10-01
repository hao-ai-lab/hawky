import type { SpeechTurn } from "./contracts.js";

/**
 * CANONICAL internal live-voice event vocabulary.
 *
 * This is the normalized form the {@link LiveVoiceTurnTracker} already consumes.
 * It is derived directly from what the OpenAI-shaped `applyLiveVoiceRealtimeEvent`
 * already extracted — it does NOT invent new tracker capabilities.
 *
 * A provider adapter is a pure `(rawEvent) => CanonicalLiveVoiceEvent | null`
 * function. Returning `null` means the adapter does not recognize the event.
 *
 * Two identifier kinds are carried explicitly so provider-agnostic dispatch can
 * preserve the OpenAI join semantics byte-for-byte:
 *  - `speechWindowId` is an EXPLICIT window id (OpenAI `speech_window_id`). When
 *    present, the join must resolve against it strictly.
 *  - `itemId` is a soft/turn correlation id (OpenAI `item_id`). It is only used
 *    as a window/transcript id when the tracker already knows it.
 */
export type CanonicalLiveVoiceEvent =
  | CanonicalSpeechStartedEvent
  | CanonicalSpeechStoppedEvent
  | CanonicalTranscriptCompletedEvent
  | CanonicalAudioArtifactEvent;

export interface CanonicalSpeechStartedEvent {
  kind: "speech_started";
  /** Original provider event type, preserved for `eventType` in results. */
  eventType: string;
  atMs: number;
  /** Explicit window id (e.g. OpenAI `speech_window_id`). */
  speechWindowId?: string;
  /** Soft turn/item correlation id (e.g. OpenAI `item_id`). */
  itemId?: string;
  route?: SpeechTurn["route"];
}

export interface CanonicalSpeechStoppedEvent {
  kind: "speech_stopped";
  eventType: string;
  atMs: number;
  speechWindowId?: string;
  itemId?: string;
}

export interface CanonicalTranscriptCompletedEvent {
  kind: "transcript_completed";
  eventType: string;
  transcriptItemId: string;
  role: SpeechTurn["role"];
  text?: string;
  /** Explicit window id (e.g. OpenAI `speech_window_id`). */
  speechWindowId?: string;
  /** Soft turn/item correlation id (e.g. OpenAI `item_id`). */
  itemId?: string;
}

export interface CanonicalAudioArtifactEvent {
  kind: "audio_artifact";
  eventType: string;
  audioArtifactId: string;
  audioPath?: string;
  sampleRate?: number;
  route?: SpeechTurn["route"];
  /** Explicit window id (e.g. OpenAI `speech_window_id`). */
  speechWindowId?: string;
  /** Explicit transcript id (e.g. OpenAI `transcript_item_id`). */
  transcriptItemId?: string;
  /** Soft turn/item correlation id (e.g. OpenAI `item_id`). */
  itemId?: string;
}
