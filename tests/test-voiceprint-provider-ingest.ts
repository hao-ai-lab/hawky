import { describe, expect, test } from "bun:test";
import {
  applyLiveVoiceRealtimeEvent,
  canonicalizeLiveVoiceEvent,
  geminiLiveVoiceAdapter,
  LIVE_VOICE_PROVIDER_ADAPTERS,
  LiveVoiceTurnTracker,
  nativeLiveVoiceAdapter,
  openaiLiveVoiceAdapter,
  resolveLiveVoiceProviderAdapter,
} from "../src/identity/voiceprint/index.js";

function newTracker(sessionKey: string): LiveVoiceTurnTracker {
  return new LiveVoiceTurnTracker({ sessionKey, route: "iphone_mic" });
}

describe("voiceprint provider ingest adapters", () => {
  test("openai adapter maps every supported event type identically to auto dispatch", () => {
    const openaiEvents: Record<string, unknown>[] = [
      { type: "input_audio_buffer.speech_started", audio_start_ms: 1000, route: "airpods" },
      { type: "input_audio_buffer.speech_stopped", audio_end_ms: 2400 },
      {
        type: "live_recording.audio_artifact",
        audio_artifact_id: "audio_1",
        audio_path: "/tmp/audio_1.wav",
        sample_rate: 16000,
      },
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt_1",
        transcript: "hello",
      },
      {
        type: "response.output_audio_transcript.done",
        item_id: "rt_assistant",
        transcript: "assistant reply",
      },
      {
        type: "response.audio_transcript.done",
        response_id: "resp_1",
        transcript: "assistant reply via response id",
      },
    ];

    for (const event of openaiEvents) {
      // The explicit "openai" adapter and the auto registry must agree.
      expect(openaiLiveVoiceAdapter.toCanonical(event)).toEqual(
        canonicalizeLiveVoiceEvent(event),
      );
      expect(openaiLiveVoiceAdapter.toCanonical(event)).toEqual(
        canonicalizeLiveVoiceEvent(event, "openai"),
      );
    }
  });

  test("openai auto dispatch drives a finalized turn end-to-end", () => {
    const tracker = newTracker("live:openai-ingest");
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_started",
      audio_start_ms: 1000,
      route: "airpods",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "input_audio_buffer.speech_stopped",
      audio_end_ms: 2400,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "live_recording.audio_artifact",
      audio_artifact_id: "audio_openai",
      audio_path: "/tmp/audio_openai.wav",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "rt_openai",
      transcript: "openai finalized turn",
    });

    expect(tracker.drainFinalizedTurns()).toMatchObject([
      {
        transcriptItemId: "rt_openai",
        role: "user",
        text: "openai finalized turn",
        startMs: 1000,
        endMs: 2400,
        audioArtifactId: "audio_openai",
        route: "airpods",
      },
    ]);
  });

  test("gemini/vertex-live adapter drives a finalized turn from activity + transcription", () => {
    const tracker = newTracker("live:gemini-ingest");

    const started = applyLiveVoiceRealtimeEvent(
      tracker,
      { type: "activityStart", turnId: "turn_1", timestampMs: 500, route: "airpods" },
      { provider: "gemini" },
    );
    const stopped = applyLiveVoiceRealtimeEvent(
      tracker,
      { type: "activityEnd", turnId: "turn_1", timestampMs: 1900 },
      { provider: "vertex-live" },
    );
    const transcript = applyLiveVoiceRealtimeEvent(
      tracker,
      {
        type: "inputTranscription",
        turnId: "turn_1",
        inputTranscription: { text: "gemini heard this" },
      },
      { provider: "gemini" },
    );
    // Native audio artifact carries the join to the same turn id.
    const artifact = applyLiveVoiceRealtimeEvent(
      tracker,
      {
        type: "voice.audio_artifact",
        speechWindowId: "turn_1",
        audioArtifactId: "audio_gemini",
        audioPath: "/tmp/audio_gemini.wav",
      },
      { provider: "native" },
    );

    expect(started.status).toBe("recorded");
    expect(stopped.status).toBe("recorded");
    expect(transcript.status).toBe("recorded");
    expect(artifact.status).toBe("recorded");
    expect(tracker.drainFinalizedTurns()).toMatchObject([
      {
        sessionKey: "live:gemini-ingest",
        transcriptItemId: "turn_1",
        role: "user",
        text: "gemini heard this",
        startMs: 500,
        endMs: 1900,
        speechWindowId: "turn_1",
        audioArtifactId: "audio_gemini",
      },
    ]);
  });

  test("gemini adapter recognizes native Live API field shape without a type discriminator", () => {
    const canonical = geminiLiveVoiceAdapter.toCanonical({
      activityStart: { timestampMs: 42, turnId: "turn_shape" },
    });
    expect(canonical).toMatchObject({
      kind: "speech_started",
      atMs: 42,
      itemId: "turn_shape",
    });

    const inputTranscript = geminiLiveVoiceAdapter.toCanonical({
      inputTranscription: { text: "shape text", messageId: "msg_9" },
    });
    expect(inputTranscript).toMatchObject({
      kind: "transcript_completed",
      role: "user",
      text: "shape text",
      transcriptItemId: "msg_9",
    });
  });

  test("native pass-through adapter maps normalized voice.* events end-to-end", () => {
    const tracker = newTracker("live:native-ingest");
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "voice.speech_started",
      speechWindowId: "win_1",
      atMs: 100,
      route: "airpods",
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "voice.speech_stopped",
      speechWindowId: "win_1",
      atMs: 900,
    });
    applyLiveVoiceRealtimeEvent(tracker, {
      type: "voice.audio_artifact",
      speechWindowId: "win_1",
      audioArtifactId: "audio_native",
      audioPath: "/tmp/audio_native.wav",
    });
    const transcript = applyLiveVoiceRealtimeEvent(tracker, {
      type: "voice.transcript_completed",
      speechWindowId: "win_1",
      transcriptItemId: "rt_native",
      text: "native normalized turn",
    });

    expect(transcript.status).toBe("recorded");
    expect(tracker.drainFinalizedTurns()).toMatchObject([
      {
        transcriptItemId: "rt_native",
        role: "user",
        text: "native normalized turn",
        startMs: 100,
        endMs: 900,
        speechWindowId: "win_1",
        audioArtifactId: "audio_native",
      },
    ]);
  });

  test("provider hint selects exactly the named adapter", () => {
    expect(resolveLiveVoiceProviderAdapter("openai")).toBe(openaiLiveVoiceAdapter);
    expect(resolveLiveVoiceProviderAdapter("gemini")).toBe(geminiLiveVoiceAdapter);
    expect(resolveLiveVoiceProviderAdapter("vertex-live")).toBe(geminiLiveVoiceAdapter);
    expect(resolveLiveVoiceProviderAdapter("native")).toBe(nativeLiveVoiceAdapter);
    expect(resolveLiveVoiceProviderAdapter("canonical")).toBe(nativeLiveVoiceAdapter);
    expect(resolveLiveVoiceProviderAdapter("auto")).toBeUndefined();
    expect(resolveLiveVoiceProviderAdapter(undefined)).toBeUndefined();
    expect(resolveLiveVoiceProviderAdapter("nope")).toBeUndefined();

    // A named adapter that does not own an event returns unsupported, not a
    // cross-provider match. An OpenAI-shaped event under the gemini hint is
    // unsupported.
    const tracker = newTracker("live:hint-scope");
    const result = applyLiveVoiceRealtimeEvent(
      tracker,
      { type: "input_audio_buffer.speech_started", audio_start_ms: 1 },
      { provider: "gemini" },
    );
    expect(result).toEqual({
      status: "ignored",
      reason: "unsupported_event",
      eventType: "input_audio_buffer.speech_started",
    });
  });

  test("event-level provider field selects the adapter when no option is given", () => {
    const tracker = newTracker("live:event-provider");
    const started = applyLiveVoiceRealtimeEvent(tracker, {
      type: "activityStart",
      provider: "gemini",
      turnId: "turn_evt",
      timestampMs: 10,
    });
    expect(started.status).toBe("recorded");
  });

  test("unknown / unsupported events still return the ignored result", () => {
    const tracker = newTracker("live:unsupported");
    expect(
      applyLiveVoiceRealtimeEvent(tracker, { type: "response.created", response_id: "r" }),
    ).toEqual({
      status: "ignored",
      reason: "unsupported_event",
      eventType: "response.created",
    });
    expect(canonicalizeLiveVoiceEvent({ type: "totally.unknown" })).toBeNull();
  });

  test("malformed events of a known provider return missing_required_field and never throw", () => {
    const tracker = newTracker("live:malformed");

    // OpenAI: transcription without an item id.
    expect(
      applyLiveVoiceRealtimeEvent(tracker, {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "no id",
      }),
    ).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "conversation.item.input_audio_transcription.completed",
    });

    // Gemini: activityStart without a timestamp.
    expect(
      applyLiveVoiceRealtimeEvent(
        tracker,
        { type: "activityStart", turnId: "turn_bad" },
        { provider: "gemini" },
      ),
    ).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "activityStart",
    });

    // Gemini: inputTranscription without any turn/message id.
    expect(
      applyLiveVoiceRealtimeEvent(
        tracker,
        { type: "inputTranscription", inputTranscription: { text: "orphan" } },
        { provider: "gemini" },
      ),
    ).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "inputTranscription",
    });

    // Native: audio artifact without an id.
    expect(
      applyLiveVoiceRealtimeEvent(
        tracker,
        { type: "voice.audio_artifact", audioPath: "/tmp/x.wav" },
        { provider: "native" },
      ),
    ).toEqual({
      status: "ignored",
      reason: "missing_required_field",
      eventType: "voice.audio_artifact",
    });
  });

  test("registry lists openai first so auto dispatch is unchanged for existing callers", () => {
    expect(LIVE_VOICE_PROVIDER_ADAPTERS[0]).toBe(openaiLiveVoiceAdapter);
    expect(LIVE_VOICE_PROVIDER_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "openai",
      "native",
      "gemini",
    ]);
  });
});
