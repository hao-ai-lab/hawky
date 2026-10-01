import { describe, expect, test } from "bun:test";
import {
  applyLiveVoiceRealtimeEvent,
  LiveVoiceTurnTracker,
} from "../src/identity/voiceprint/index.js";

describe("live voice realtime event adapter", () => {
  test("maps realtime speech, transcription, and recording artifact events into finalized turns", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-realtime-events",
      route: "iphone_mic",
    });

    const started = applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_started",
      audio_start_ms: 1000,
      route: "airpods",
    });
    const stopped = applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_stopped",
      audio_end_ms: 2400,
    });
    const artifact = applyLiveVoiceRealtimeEvent(tracker, {
      type: "live_recording.audio_artifact",
      audio_artifact_id: "audio_realtime_events_1",
      audio_path: "/tmp/audio_realtime_events_1.wav",
      sample_rate: 16000,
    });
    const transcript = applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_realtime_events_1",
      transcript: "this should become a voiceprint turn",
    });

    expect(started.status).toBe("recorded");
    expect(stopped.status).toBe("recorded");
    expect(artifact.status).toBe("recorded");
    expect(transcript.status).toBe("recorded");
    expect(tracker.drainFinalizedTurns()).toMatchObject([
      {
        sessionKey: "live:voice-realtime-events",
        transcriptItemId: "rt_realtime_events_1",
        role: "user",
        text: "this should become a voiceprint turn",
        startMs: 1000,
        endMs: 2400,
        audioArtifactId: "audio_realtime_events_1",
        audioPath: "/tmp/audio_realtime_events_1.wav",
        route: "airpods",
      },
    ]);
  });

  test("keeps assistant transcript events from consuming input speech windows", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-realtime-events",
      route: "iphone_mic",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_started",
      speechWindowId: "speech_realtime_user",
      audio_start_ms: 500,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_stopped",
      speechWindowId: "speech_realtime_user",
      audio_end_ms: 1700,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "live_recording.audio_artifact",
      speechWindowId: "speech_realtime_user",
      audioArtifactId: "audio_realtime_user",
      audioPath: "/tmp/audio_realtime_user.wav",
    });

    const assistant = applyLiveVoiceRealtimeEvent(tracker, {
      type: "response.output_audio_transcript.done",
      item_id: "rt_realtime_assistant",
      transcript: "assistant finished first",
    });
    const user = applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_realtime_user",
      transcript: "user transcript still owns the input speech window",
    });

    expect(assistant.status).toBe("recorded");
    expect(user.status).toBe("recorded");
    expect(tracker.drainFinalizedTurns()).toMatchObject([
      {
        transcriptItemId: "rt_realtime_user",
        speechWindowId: "speech_realtime_user",
        audioArtifactId: "audio_realtime_user",
      },
    ]);
  });

  test("uses realtime item ids to join out-of-order adjacent speech windows", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-realtime-events",
      route: "iphone_mic",
    });

    const startA = applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_started",
      item_id: "rt_realtime_a",
      audio_start_ms: 1000,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "rt_realtime_a",
      audio_end_ms: 1800,
    });
    const startB = applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_started",
      item_id: "rt_realtime_b",
      audio_start_ms: 1900,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "rt_realtime_b",
      audio_end_ms: 2700,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "live_recording.audio_artifact",
      item_id: "rt_realtime_b",
      audio_artifact_id: "audio_realtime_b",
      audio_path: "/tmp/audio_realtime_b.wav",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_realtime_b",
      transcript: "second speech transcript arrived first",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "live_recording.audio_artifact",
      item_id: "rt_realtime_a",
      audio_artifact_id: "audio_realtime_a",
      audio_path: "/tmp/audio_realtime_a.wav",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_realtime_a",
      transcript: "first speech transcript arrived second",
    });

    if (startA.status !== "recorded" || startB.status !== "recorded") {
      throw new Error("expected speech starts to be recorded");
    }
    expect(startA.speechWindow.id).toBe("rt_realtime_a");
    expect(startB.speechWindow.id).toBe("rt_realtime_b");
    expect(tracker.drainFinalizedTurns()).toMatchObject([
      {
        transcriptItemId: "rt_realtime_b",
        speechWindowId: "rt_realtime_b",
        startMs: 1900,
        endMs: 2700,
        audioArtifactId: "audio_realtime_b",
      },
      {
        transcriptItemId: "rt_realtime_a",
        speechWindowId: "rt_realtime_a",
        startMs: 1000,
        endMs: 1800,
        audioArtifactId: "audio_realtime_a",
      },
    ]);
  });

  test("rejects unknown explicit transcript speech windows instead of falling back", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-realtime-events",
      route: "iphone_mic",
    });

    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_started",
      speech_window_id: "speech_known",
      audio_start_ms: 1000,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_stopped",
      speech_window_id: "speech_known",
      audio_end_ms: 1800,
    });

    const staleTranscript = applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_stale_transcript",
      speech_window_id: "speech_unknown",
      transcript: "this must not consume speech_known",
    });
    const validTranscript = applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_valid_transcript",
      transcript: "this may use the fallback window",
    });

    expect(staleTranscript).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "conversation.item.input_audio_transcription.completed",
    });
    expect(validTranscript.status).toBe("recorded");
    expect(tracker.pendingTranscriptCount()).toBe(1);
    expect(tracker.drainFinalizedTurns({ includeMissingAudio: true })).toMatchObject([
      {
        transcriptItemId: "rt_valid_transcript",
        speechWindowId: "speech_known",
      },
    ]);
  });

  test("does not substitute wall-clock time for missing audio offsets", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-realtime-events",
      route: "iphone_mic",
    });

    const started = applyLiveVoiceRealtimeEvent(
      tracker,
      {
        type: "input_audio_buffer.speech_started",
        item_id: "rt_realtime_missing_offsets",
      },
      { nowMs: () => 1_800_000_000_000 },
    );
    const stopped = applyLiveVoiceRealtimeEvent(
      tracker,
      {
        type: "input_audio_buffer.speech_stopped",
        item_id: "rt_realtime_missing_offsets",
      },
      { nowMs: () => 1_800_000_000_500 },
    );
    const artifact = applyLiveVoiceRealtimeEvent(tracker, {
      type: "live_recording.audio_artifact",
      item_id: "rt_realtime_missing_offsets",
      audio_artifact_id: "audio_realtime_missing_offsets",
      audio_path: "/tmp/audio_realtime_missing_offsets.wav",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_realtime_missing_offsets",
      transcript: "this transcript must not get a wall-clock speech window",
    });

    expect(started).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "input_audio_buffer.speech_started",
    });
    expect(stopped).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "input_audio_buffer.speech_stopped",
    });
    expect(artifact).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "live_recording.audio_artifact",
    });
    expect(tracker.drainFinalizedTurns()).toEqual([]);
    expect(tracker.pendingSpeechWindowCount()).toBe(0);
    expect(tracker.pendingTranscriptCount()).toBe(1);
  });

  test("ignores unsupported events and supported events missing required ids", () => {
    const tracker = new LiveVoiceTurnTracker({
      sessionKey: "live:voice-realtime-events",
    });

    expect(
      applyLiveVoiceRealtimeEvent(tracker, {
        type: "response.created",
        response_id: "resp_1",
      }),
    ).toEqual({
      status: "ignored",
      reason: "unsupported_event",
      eventType: "response.created",
    });
    expect(
      applyLiveVoiceRealtimeEvent(tracker, {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "missing item id",
      }),
    ).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "conversation.item.input_audio_transcription.completed",
    });
    expect(
      applyLiveVoiceRealtimeEvent(tracker, {
        type: "live_recording.audio_artifact",
        audio_path: "/tmp/missing_id.wav",
      }),
    ).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "live_recording.audio_artifact",
    });
  });
});
