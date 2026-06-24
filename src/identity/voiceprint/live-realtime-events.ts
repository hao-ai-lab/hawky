import type { SpeechTurn } from "./contracts.js";
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
}

export function applyLiveVoiceRealtimeEvent(
  tracker: LiveVoiceTurnTracker,
  event: LiveVoiceRealtimeEvent,
  options: LiveVoiceRealtimeEventOptions = {},
): LiveVoiceRealtimeEventResult {
  switch (event.type) {
    case "input_audio_buffer.speech_started": {
      const atMs = eventTimeMs(event, ["audio_start_ms", "start_ms", "at_ms"]);
      if (atMs === undefined) {
        return missingRequiredField(event.type);
      }
      const speechWindow = tracker.recordSpeechStarted({
        speechWindowId: realtimeSpeechWindowId(event),
        atMs,
        route: optionalRoute(event),
      });
      return { status: "recorded", kind: "speech_started", speechWindow };
    }
    case "input_audio_buffer.speech_stopped": {
      const atMs = eventTimeMs(event, ["audio_end_ms", "end_ms", "at_ms"]);
      if (atMs === undefined) {
        return missingRequiredField(event.type);
      }
      const speechWindow = tracker.recordSpeechStopped({
        speechWindowId: realtimeSpeechWindowId(event),
        atMs,
      });
      return { status: "recorded", kind: "speech_stopped", speechWindow };
    }
    case "conversation.item.input_audio_transcription.completed": {
      const transcriptItemId = optionalString(event, [
        "item_id",
        "itemId",
        "transcript_item_id",
        "transcriptItemId",
      ]);
      if (!transcriptItemId) {
        return missingRequiredField(event.type);
      }
      if (!transcriptSpeechWindowJoinIsResolvable(tracker, event, transcriptItemId)) {
        return missingRequiredField(event.type);
      }
      const transcript = tracker.recordTranscriptCompleted({
        transcriptItemId,
        role: "user",
        text: optionalString(event, ["transcript", "text"]),
        speechWindowId: realtimeTranscriptSpeechWindowId(tracker, event, transcriptItemId),
      });
      return { status: "recorded", kind: "transcript_completed", transcript };
    }
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done": {
      const transcriptItemId =
        optionalString(event, ["item_id", "itemId", "transcript_item_id", "transcriptItemId"]) ||
        optionalString(event, ["response_id", "responseId"]);
      if (!transcriptItemId) {
        return missingRequiredField(event.type);
      }
      const transcript = tracker.recordTranscriptCompleted({
        transcriptItemId,
        role: "assistant",
        text: optionalString(event, ["transcript", "text"]),
      });
      return { status: "recorded", kind: "transcript_completed", transcript };
    }
    case "live_recording.audio_artifact": {
      const audioArtifactId = optionalString(event, [
        "audio_artifact_id",
        "audioArtifactId",
        "artifact_id",
        "artifactId",
      ]);
      if (!audioArtifactId) {
        return missingRequiredField(event.type);
      }
      if (!audioArtifactJoinIsResolvable(tracker, event)) {
        return missingRequiredField(event.type);
      }
      const speechWindowId = realtimeAudioSpeechWindowId(tracker, event);
      const transcriptItemId = realtimeAudioTranscriptItemId(tracker, event);
      let audioArtifact: LiveVoiceTurnAudioArtifact;
      try {
        audioArtifact = tracker.attachAudioArtifact({
          audioArtifactId,
          audioPath: optionalString(event, ["audio_path", "audioPath", "path"]),
          sampleRate: optionalFiniteNumber(event, ["sample_rate", "sampleRate"]),
          route: optionalRoute(event),
          speechWindowId,
          transcriptItemId,
        });
      } catch {
        return missingRequiredField(event.type);
      }
      return { status: "recorded", kind: "audio_artifact", audioArtifact };
    }
    default:
      return { status: "ignored", reason: "unsupported_event", eventType: event.type };
  }
}

function eventTimeMs(
  event: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  return optionalFiniteNumber(event, keys);
}

function optionalString(event: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalFiniteNumber(
  event: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function optionalRoute(event: Record<string, unknown>): SpeechTurn["route"] | undefined {
  return optionalString(event, ["route", "audio_route", "audioRoute"]);
}

function realtimeSpeechWindowId(event: Record<string, unknown>): string | undefined {
  return explicitSpeechWindowId(event) ?? realtimeItemId(event);
}

function realtimeTranscriptSpeechWindowId(
  tracker: LiveVoiceTurnTracker,
  event: Record<string, unknown>,
  transcriptItemId: string,
): string | undefined {
  const explicit = explicitSpeechWindowId(event);
  if (explicit) {
    return tracker.hasSpeechWindow(explicit) ? explicit : undefined;
  }
  if (tracker.hasSpeechWindow(transcriptItemId)) {
    return transcriptItemId;
  }
  return undefined;
}

function transcriptSpeechWindowJoinIsResolvable(
  tracker: LiveVoiceTurnTracker,
  event: Record<string, unknown>,
  transcriptItemId: string,
): boolean {
  const explicit = explicitSpeechWindowId(event);
  if (explicit) {
    return tracker.hasSpeechWindow(explicit);
  }
  return true;
}

function realtimeAudioSpeechWindowId(
  tracker: LiveVoiceTurnTracker,
  event: Record<string, unknown>,
): string | undefined {
  const explicit = explicitSpeechWindowId(event);
  if (explicit) {
    return explicit;
  }
  const itemId = realtimeItemId(event);
  if (itemId && tracker.hasSpeechWindow(itemId)) {
    return itemId;
  }
  return undefined;
}

function realtimeAudioTranscriptItemId(
  tracker: LiveVoiceTurnTracker,
  event: Record<string, unknown>,
): string | undefined {
  const transcriptItemId = optionalString(event, [
    "transcript_item_id",
    "transcriptItemId",
    "item_id",
    "itemId",
  ]);
  if (transcriptItemId && tracker.hasTranscript(transcriptItemId)) {
    return transcriptItemId;
  }
  return undefined;
}

function audioArtifactJoinIsResolvable(
  tracker: LiveVoiceTurnTracker,
  event: Record<string, unknown>,
): boolean {
  const explicitSpeechWindow = explicitSpeechWindowId(event);
  if (explicitSpeechWindow && !tracker.hasSpeechWindow(explicitSpeechWindow)) {
    return false;
  }

  const itemId = realtimeItemId(event);
  if (itemId && !tracker.hasSpeechWindow(itemId) && !tracker.hasTranscript(itemId)) {
    return false;
  }

  const transcriptItemId = optionalString(event, ["transcript_item_id", "transcriptItemId"]);
  if (transcriptItemId && !tracker.hasTranscript(transcriptItemId)) {
    return false;
  }

  return true;
}

function explicitSpeechWindowId(event: Record<string, unknown>): string | undefined {
  return optionalString(event, ["speech_window_id", "speechWindowId"]);
}

function realtimeItemId(event: Record<string, unknown>): string | undefined {
  return optionalString(event, ["item_id", "itemId"]);
}

function missingRequiredField(eventType: string): LiveVoiceRealtimeEventResult {
  return { status: "ignored", reason: "missing_required_field", eventType };
}
