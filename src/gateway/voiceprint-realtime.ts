import {
  applyLiveVoiceRealtimeEvent,
  LiveVoiceTurnTracker,
  type LiveVoiceRealtimeEvent,
  type LiveVoiceRealtimeEventResult,
  type LiveVoiceTurnDrainOptions,
  type LiveVoiceTurnFinalized,
} from "../identity/voiceprint/index.js";

export type VoiceprintRealtimeFinalizedTurn = Omit<LiveVoiceTurnFinalized, "samples">;

export interface VoiceprintRealtimeSessionApplyResult {
  ok: true;
  sessionKey: string;
  event: LiveVoiceRealtimeEventResult;
  finalizedTurns: VoiceprintRealtimeFinalizedTurn[];
  pendingSpeechWindows: number;
  pendingTranscripts: number;
}

export interface VoiceprintRealtimeSessionResetResult {
  ok: true;
  sessionKey: string;
}

export interface VoiceprintRealtimeSessionStoreOptions {
  nowMs?: () => number;
}

export class VoiceprintRealtimeSessionStore {
  private readonly nowMs?: () => number;
  private readonly trackers = new Map<string, LiveVoiceTurnTracker>();

  constructor(options: VoiceprintRealtimeSessionStoreOptions = {}) {
    this.nowMs = options.nowMs;
  }

  applyEvent(input: {
    sessionKey: string;
    event: LiveVoiceRealtimeEvent;
    includeMissingAudio?: boolean;
  }): VoiceprintRealtimeSessionApplyResult {
    const sessionKey = normalizedSessionKey(input.sessionKey);
    const tracker = this.trackerFor(sessionKey);
    const event = applyLiveVoiceRealtimeEvent(tracker, input.event, {
      nowMs: this.nowMs,
    });
    const drainOptions: LiveVoiceTurnDrainOptions = {
      includeMissingAudio: input.includeMissingAudio === true,
    };
    const finalizedTurns = tracker
      .drainFinalizedTurns(drainOptions)
      .map(serializeFinalizedTurn);

    return {
      ok: true,
      sessionKey,
      event,
      finalizedTurns,
      pendingSpeechWindows: tracker.pendingSpeechWindowCount(),
      pendingTranscripts: tracker.pendingTranscriptCount(),
    };
  }

  reset(sessionKey: string): VoiceprintRealtimeSessionResetResult {
    const normalized = normalizedSessionKey(sessionKey);
    this.trackers.delete(normalized);
    return { ok: true, sessionKey: normalized };
  }

  private trackerFor(sessionKey: string): LiveVoiceTurnTracker {
    const current = this.trackers.get(sessionKey);
    if (current) {
      return current;
    }
    const tracker = new LiveVoiceTurnTracker({ sessionKey });
    this.trackers.set(sessionKey, tracker);
    return tracker;
  }
}

export function createVoiceprintRealtimeSessionStore(
  options: VoiceprintRealtimeSessionStoreOptions = {},
): VoiceprintRealtimeSessionStore {
  return new VoiceprintRealtimeSessionStore(options);
}

function serializeFinalizedTurn(turn: LiveVoiceTurnFinalized): VoiceprintRealtimeFinalizedTurn {
  const { samples: _samples, ...serializable } = turn;
  return serializable;
}

function normalizedSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    throw new Error("Voiceprint realtime session requires sessionKey.");
  }
  return trimmed;
}
