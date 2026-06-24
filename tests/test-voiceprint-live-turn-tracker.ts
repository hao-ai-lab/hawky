import { describe, expect, test } from "bun:test";
import {
  buildLiveVoiceprintScoringPlan,
  LiveVoiceTurnTracker,
  type LiveVoiceprintPlanItemInput,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("live voice turn tracker", () => {
  test("assembles finalized turns from speech, transcript, and audio artifact events", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-turn-tracker",
      route: "iphone_mic",
    });
    const speech = tracker.recordSpeechStarted({ atMs: 1000 });
    tracker.recordSpeechStopped({ speechWindowId: speech.id, atMs: 2600 });
    tracker.attachAudioArtifact({
      speechWindowId: speech.id,
      audioArtifactId: "audio_tracker_1",
      audioPath: "/tmp/audio_tracker_1.wav",
      samples: sineWave(1600, 0.1),
      sampleRate,
      route: "airpods",
    });
    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_1",
      text: "this should become a finalized owner turn",
    });

    const turns = tracker.drainFinalizedTurns();

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      sessionKey: "live:voice-turn-tracker",
      transcriptItemId: "rt_tracker_1",
      role: "user",
      text: "this should become a finalized owner turn",
      startMs: 1000,
      endMs: 2600,
      audioArtifactId: "audio_tracker_1",
      audioPath: "/tmp/audio_tracker_1.wav",
      route: "airpods",
      speechWindowId: speech.id,
    });
    expect(turns[0]?.samples).toBeInstanceOf(Float32Array);
    expect(tracker.drainFinalizedTurns()).toEqual([]);
  });

  test("waits for audio by default but can finalize missing-audio turns for skipped plans", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-turn-tracker",
      route: "iphone_mic",
    });
    tracker.recordSpeechStarted({ speechWindowId: "speech_missing_audio", atMs: 500 });
    tracker.recordSpeechStopped({ speechWindowId: "speech_missing_audio", atMs: 1800 });
    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_missing_audio",
      text: "capture failed before an artifact was written",
      speechWindowId: "speech_missing_audio",
    });

    expect(tracker.drainFinalizedTurns()).toEqual([]);

    const [turn] = tracker.drainFinalizedTurns({ includeMissingAudio: true });
    if (!turn) {
      throw new Error("expected missing-audio finalized turn");
    }
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [planTurn(turn)],
    });

    expect(turn.audioArtifactId).toBeUndefined();
    expect(turn.audioPath).toBeUndefined();
    expect(plan.status).toBe("skipped");
    expect(plan.skipped[0]?.reason).toBe("missing_audio_artifact");
    expect(plan.states[0]?.lifecycle).toBe("skipped");
  });

  test("joins transcript-first turns once the audio artifact arrives", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-turn-tracker",
      route: "iphone_mic",
    });
    tracker.recordSpeechStarted({ speechWindowId: "speech_late_audio", atMs: 100 });
    tracker.recordSpeechStopped({ speechWindowId: "speech_late_audio", atMs: 1900 });
    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_late_audio",
      text: "audio arrives after transcript",
      speechWindowId: "speech_late_audio",
    });

    expect(tracker.pendingTranscriptCount()).toBe(1);
    expect(tracker.drainFinalizedTurns()).toEqual([]);

    tracker.attachAudioArtifact({
      transcriptItemId: "rt_tracker_late_audio",
      audioArtifactId: "audio_tracker_late_audio",
      audioPath: "/tmp/audio_tracker_late_audio.wav",
      samples: sineWave(1800, 0.1),
      sampleRate,
    });

    const turns = tracker.drainFinalizedTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.audioArtifactId).toBe("audio_tracker_late_audio");
    expect(turns[0]?.audioPath).toBe("/tmp/audio_tracker_late_audio.wav");
  });

  test("does not bind assistant transcripts to input speech windows", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-turn-tracker",
      route: "iphone_mic",
    });
    const speech = tracker.recordSpeechStarted({ atMs: 1000 });
    tracker.recordSpeechStopped({ speechWindowId: speech.id, atMs: 2400 });
    tracker.attachAudioArtifact({
      speechWindowId: speech.id,
      audioArtifactId: "audio_tracker_owner_window",
      audioPath: "/tmp/audio_tracker_owner_window.wav",
      samples: sineWave(1400, 0.1),
      sampleRate,
    });

    const assistantTranscript = tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_assistant_first",
      role: "assistant",
      text: "assistant response completed before user transcript",
    });
    expect(assistantTranscript.speechWindowId).toBeUndefined();
    expect(() =>
      tracker.recordTranscriptCompleted({
        transcriptItemId: "rt_tracker_assistant_bound",
        role: "assistant",
        speechWindowId: speech.id,
      }),
    ).toThrow(/non-user transcript cannot bind/);

    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_user_after_assistant",
      text: "user transcript should still claim the speech window",
    });

    const turns = tracker.drainFinalizedTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.transcriptItemId).toBe("rt_tracker_user_after_assistant");
    expect(turns[0]?.speechWindowId).toBe(speech.id);
    expect(turns[0]?.audioArtifactId).toBe("audio_tracker_owner_window");
    expect(tracker.pendingTranscriptCount()).toBe(0);
  });

  test("rejects audio artifacts with mismatched transcript and speech window joins", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-turn-tracker",
      route: "iphone_mic",
    });
    tracker.recordSpeechStarted({ speechWindowId: "speech_join_a", atMs: 1000 });
    tracker.recordSpeechStopped({ speechWindowId: "speech_join_a", atMs: 2200 });
    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_join_a",
      speechWindowId: "speech_join_a",
    });
    tracker.recordSpeechStarted({ speechWindowId: "speech_join_b", atMs: 2400 });
    tracker.recordSpeechStopped({ speechWindowId: "speech_join_b", atMs: 3600 });
    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_join_b",
      speechWindowId: "speech_join_b",
    });

    expect(() =>
      tracker.attachAudioArtifact({
        speechWindowId: "speech_join_a",
        transcriptItemId: "rt_tracker_join_b",
        audioArtifactId: "audio_tracker_join_mismatch",
        audioPath: "/tmp/audio_tracker_join_mismatch.wav",
        samples: sineWave(1200, 0.1),
        sampleRate,
      }),
    ).toThrow(/join mismatch/);

    const turns = tracker.drainFinalizedTurns();
    expect(turns).toEqual([]);
  });

  test("rejects duplicate transcript ids and invalid speech windows", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-turn-tracker",
    });
    tracker.recordSpeechStarted({ speechWindowId: "speech_invalid", atMs: 1000 });

    expect(() =>
      tracker.recordSpeechStopped({
        speechWindowId: "speech_invalid",
        atMs: 900,
      }),
    ).toThrow(/after speech start/);

    tracker.recordSpeechStopped({
      speechWindowId: "speech_invalid",
      atMs: 1500,
    });
    tracker.recordTranscriptCompleted({
      transcriptItemId: "rt_tracker_duplicate",
      speechWindowId: "speech_invalid",
    });

    expect(() =>
      tracker.recordTranscriptCompleted({
        transcriptItemId: "rt_tracker_duplicate",
      }),
    ).toThrow(/Duplicate live voice transcript item id/);
    expect(() =>
      tracker.attachAudioArtifact({
        transcriptItemId: "rt_unknown",
        audioArtifactId: "audio_unknown",
      }),
    ).toThrow(/unknown transcript/);
  });
});

function planTurn(turn: ReturnType<LiveVoiceTurnTracker["drainFinalizedTurns"]>[number]): LiveVoiceprintPlanItemInput {
  return {
    ...turn,
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    consent: processingConsent,
    expectedModel: { provider: "custom", modelId: "tracker-sidecar", version: "1" },
  };
}

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
