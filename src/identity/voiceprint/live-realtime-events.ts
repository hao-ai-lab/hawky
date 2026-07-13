import type {
  CanonicalAudioArtifactEvent,
  CanonicalLiveVoiceEvent,
  CanonicalSpeechStartedEvent,
  CanonicalSpeechStoppedEvent,
  CanonicalTranscriptCompletedEvent,
} from "./live-realtime-canonical.js";
import {
  canonicalizeLiveVoiceEvent,
  type LiveVoiceRealtimeProviderHint,
} from "./live-realtime-adapters.js";
import {
  LiveVoiceTurnTracker,
  type LiveVoiceTurnAudioArtifact,
  type LiveVoiceTurnSpeechWindow,
  type LiveVoiceTurnTranscript,
} from "./live-turn-tracker.js";

export type LiveVoiceRealtimeEvent =
  | ({
      type: "input_audio_buffer.speech_started";
    } & Record<string, unknown>)
  | ({
      type: "input_audio_buffer.speech_stopped";
    } & Record<string, unknown>)
  | ({
      type: "conversation.item.input_audio_transcription.completed";
    } & Record<string, unknown>)
  | ({
      type: "response.audio_transcript.done" | "response.output_audio_transcript.done";
    } & Record<string, unknown>)
  | ({
      type: "live_recording.audio_artifact";
    } & Record<string, unknown>)
  | ({ type: string } & Record<string, unknown>);

export type LiveVoiceRealtimeEventResult =
  | {
      status: "recorded";
      kind: "speech_started" | "speech_stopped";
      speechWindow: LiveVoiceTurnSpeechWindow;
    }
  | {
      status: "recorded";
      kind: "transcript_completed";
      transcript: LiveVoiceTurnTranscript;
    }
  | {
      status: "recorded";
      kind: "audio_artifact";
      audioArtifact: LiveVoiceTurnAudioArtifact;
    }
  | {
      status: "ignored";
      reason: "unsupported_event" | "missing_required_field";
      eventType: string;
    };

export interface LiveVoiceRealtimeEventOptions {
  nowMs?: () => number;
  /**
   * OPTIONAL provider hint. Defaults to `auto`, which walks the adapter registry
   * (OpenAI first) exactly as before — so existing callers are byte-for-byte
   * unchanged. A known hint (e.g. "gemini", "native") selects that adapter.
   */
  provider?: LiveVoiceRealtimeProviderHint;
}

export function applyLiveVoiceRealtimeEvent(
  tracker: LiveVoiceTurnTracker,
  event: LiveVoiceRealtimeEvent,
  options: LiveVoiceRealtimeEventOptions = {},
): LiveVoiceRealtimeEventResult {
  const canonical = canonicalizeLiveVoiceEvent(
    event as Record<string, unknown>,
    options.provider ?? readProviderHint(event),
  );
  if (canonical === null) {
    return { status: "ignored", reason: "unsupported_event", eventType: event.type };
  }
  if (canonical === "missing_required_field") {
    return missingRequiredField(event.type);
  }
  return applyCanonicalLiveVoiceEvent(tracker, canonical);
}

/**
 * Runs the tracker-facing join logic on a canonical event. This is the exact
 * behavior the original OpenAI-shaped applier had; the OpenAI adapter simply
 * produces the same extracted fields, so OpenAI results are unchanged.
 */
export function applyCanonicalLiveVoiceEvent(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalLiveVoiceEvent,
): LiveVoiceRealtimeEventResult {
  switch (event.kind) {
    case "speech_started":
      return applySpeechStarted(tracker, event);
    case "speech_stopped":
      return applySpeechStopped(tracker, event);
    case "transcript_completed":
      return applyTranscriptCompleted(tracker, event);
    case "audio_artifact":
      return applyAudioArtifact(tracker, event);
  }
}

function applySpeechStarted(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalSpeechStartedEvent,
): LiveVoiceRealtimeEventResult {
  const speechWindow = tracker.recordSpeechStarted({
    speechWindowId: realtimeSpeechWindowId(event),
    atMs: event.atMs,
    route: event.route,
  });
  return { status: "recorded", kind: "speech_started", speechWindow };
}

function applySpeechStopped(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalSpeechStoppedEvent,
): LiveVoiceRealtimeEventResult {
  const speechWindow = tracker.recordSpeechStopped({
    speechWindowId: realtimeSpeechWindowId(event),
    atMs: event.atMs,
  });
  return { status: "recorded", kind: "speech_stopped", speechWindow };
}

function applyTranscriptCompleted(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalTranscriptCompletedEvent,
): LiveVoiceRealtimeEventResult {
  if (event.role === "user") {
    if (!transcriptSpeechWindowJoinIsResolvable(tracker, event)) {
      return missingRequiredField(event.eventType);
    }
    const transcript = tracker.recordTranscriptCompleted({
      transcriptItemId: event.transcriptItemId,
      role: "user",
      text: event.text,
      speechWindowId: realtimeTranscriptSpeechWindowId(tracker, event),
    });
    return { status: "recorded", kind: "transcript_completed", transcript };
  }

  const transcript = tracker.recordTranscriptCompleted({
    transcriptItemId: event.transcriptItemId,
    role: event.role,
    text: event.text,
  });
  return { status: "recorded", kind: "transcript_completed", transcript };
}

function applyAudioArtifact(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalAudioArtifactEvent,
): LiveVoiceRealtimeEventResult {
  if (!audioArtifactJoinIsResolvable(tracker, event)) {
    return missingRequiredField(event.eventType);
  }
  const speechWindowId = realtimeAudioSpeechWindowId(tracker, event);
  const transcriptItemId = realtimeAudioTranscriptItemId(tracker, event);
  let audioArtifact: LiveVoiceTurnAudioArtifact;
  try {
    audioArtifact = tracker.attachAudioArtifact({
      audioArtifactId: event.audioArtifactId,
      audioPath: event.audioPath,
      sampleRate: event.sampleRate,
      route: event.route,
      speechWindowId,
      transcriptItemId,
    });
  } catch {
    return missingRequiredField(event.eventType);
  }
  return { status: "recorded", kind: "audio_artifact", audioArtifact };
}

function readProviderHint(event: Record<string, unknown>): LiveVoiceRealtimeProviderHint | undefined {
  const value = event.provider;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

// --- Tracker-facing join resolution (canonical fields) -----------------------
//
// These preserve the original OpenAI join semantics exactly. `speechWindowId` is
// the explicit window id; `itemId` is the soft turn/item correlation id.

function realtimeSpeechWindowId(
  event: CanonicalSpeechStartedEvent | CanonicalSpeechStoppedEvent,
): string | undefined {
  return event.speechWindowId ?? event.itemId;
}

function realtimeTranscriptSpeechWindowId(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalTranscriptCompletedEvent,
): string | undefined {
  const explicit = event.speechWindowId;
  if (explicit) {
    return tracker.hasSpeechWindow(explicit) ? explicit : undefined;
  }
  if (tracker.hasSpeechWindow(event.transcriptItemId)) {
    return event.transcriptItemId;
  }
  return undefined;
}

function transcriptSpeechWindowJoinIsResolvable(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalTranscriptCompletedEvent,
): boolean {
  const explicit = event.speechWindowId;
  if (explicit) {
    return tracker.hasSpeechWindow(explicit);
  }
  return true;
}

function realtimeAudioSpeechWindowId(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalAudioArtifactEvent,
): string | undefined {
  const explicit = event.speechWindowId;
  if (explicit) {
    return explicit;
  }
  const itemId = event.itemId;
  if (itemId && tracker.hasSpeechWindow(itemId)) {
    return itemId;
  }
  return undefined;
}

function realtimeAudioTranscriptItemId(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalAudioArtifactEvent,
): string | undefined {
  const transcriptItemId = event.transcriptItemId ?? event.itemId;
  if (transcriptItemId && tracker.hasTranscript(transcriptItemId)) {
    return transcriptItemId;
  }
  return undefined;
}

function audioArtifactJoinIsResolvable(
  tracker: LiveVoiceTurnTracker,
  event: CanonicalAudioArtifactEvent,
): boolean {
  const explicitSpeechWindow = event.speechWindowId;
  if (explicitSpeechWindow && !tracker.hasSpeechWindow(explicitSpeechWindow)) {
    return false;
  }

  const itemId = event.itemId;
  if (itemId && !tracker.hasSpeechWindow(itemId) && !tracker.hasTranscript(itemId)) {
    return false;
  }

  const transcriptItemId = event.transcriptItemId;
  if (transcriptItemId && !tracker.hasTranscript(transcriptItemId)) {
    return false;
  }

  return true;
}

function missingRequiredField(eventType: string): LiveVoiceRealtimeEventResult {
  return { status: "ignored", reason: "missing_required_field", eventType };
}
