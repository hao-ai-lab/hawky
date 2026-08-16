import Testing
import Foundation
@testable import hawky

/// Regression tests for the WebRTC VAD dataflow fix.
///
/// The vendored OpenAI Realtime (WebRTC) transport delegate is arg-less, so the
/// provider re-emits `input_audio_buffer.speech_started` / `.speech_stopped` with an
/// EMPTY JSON body ("{}"). Before the fix, the static converter DROPPED those events
/// (returned nil) unless the raw JSON carried `audio_start_ms`/`audio_end_ms` OR the
/// recording offset was non-nil — so during parallel-mic warm-up every VAD event was
/// lost, the server turn tracker saw zero speech windows, and no turn ever finalized
/// (finalized_turns:0 forever → owner recognition never ran).
///
/// These tests pin the fixed behavior:
///  - empty-JSON speech_started/stopped now SURVIVE the converter,
///  - the monotonic offset repair yields finite, strictly-increasing timestamps in the
///    recording time base (endMs > startMs) even when the offset is nil or stalled,
///  - the OFF-BY-DEFAULT converter behavior for other event kinds is unchanged.
@Suite struct VoiceprintRealtimeVadTests {

    // MARK: - converter survives empty-JSON VAD

    /// speech_started with EMPTY JSON and a nil recording offset (warm-up) is no longer
    /// dropped: the converter returns a non-nil event so the MainActor caller can stamp a
    /// recording-aligned timestamp. (Before the fix this returned nil.)
    @Test func emptyJSONSpeechStartedSurvivesWithNilOffset() {
        let event = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_started",
            rawJSON: "{}",
            route: "webrtc",
            recordingOffsetMs: nil
        )
        #expect(event != nil)
        #expect(event?.type == "input_audio_buffer.speech_started")
        // Warm-up: no offset available yet, so the converter leaves the stamp to the
        // MainActor caller. The point is that the event SURVIVES.
        #expect(event?.audioStartMs == nil)
        #expect(event?.route == "webrtc")
    }

    /// speech_stopped with EMPTY JSON and a nil recording offset likewise survives.
    @Test func emptyJSONSpeechStoppedSurvivesWithNilOffset() {
        let event = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_stopped",
            rawJSON: "{}",
            route: "webrtc",
            recordingOffsetMs: nil
        )
        #expect(event != nil)
        #expect(event?.type == "input_audio_buffer.speech_stopped")
        #expect(event?.audioEndMs == nil)
    }

    /// When the recording offset IS available, the converter still stamps it (unchanged
    /// wire behavior): the timestamp is the recording-offset time base shared with the
    /// audio artifact WAV, not an arbitrary clock.
    @Test func speechStartedStampsRecordingOffsetWhenAvailable() {
        let started = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_started",
            rawJSON: "{}",
            recordingOffsetMs: 1_500
        )
        #expect(started?.audioStartMs == 1_500)

        let stopped = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_stopped",
            rawJSON: "{}",
            recordingOffsetMs: 2_300
        )
        #expect(stopped?.audioEndMs == 2_300)
    }

    /// An explicit `audio_start_ms` in the raw JSON still wins over the recording offset,
    /// preserving the pre-existing provider contract.
    @Test func explicitJSONTimestampStillWins() {
        let event = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_started",
            rawJSON: "{\"audio_start_ms\": 42}",
            recordingOffsetMs: 9_999
        )
        #expect(event?.audioStartMs == 42)
    }

    // MARK: - monotonic recording-aligned repair

    /// Warm-up: the first speech_started arrives with a nil offset. The repair floors it
    /// to the recording-timeline origin (>= 1ms), never producing NaN/nil.
    @Test func monotonicRepairFloorsNilCandidateAtSessionStart() {
        let first = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: nil, last: nil)
        #expect(first.isFinite)
        #expect(first >= 1)
    }

    /// The critical server requirement: speech_stopped must be STRICTLY after
    /// speech_started (`endMs > startMs`). When start and stop resolve to the SAME
    /// recording offset (arg-less WebRTC VAD, no frames written between them), the repair
    /// nudges the stop forward so the window is non-degenerate.
    @Test func monotonicRepairKeepsEndStrictlyAfterStartOnStalledOffset() {
        let start = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: 1_000, last: nil)
        // stop resolves to the identical recording offset → must still advance.
        let stop = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: 1_000, last: start)
        #expect(start == 1_000)
        #expect(stop > start)
    }

    /// Real forward progress is preserved: when the candidate legitimately advances past
    /// the monotonic floor, the repair returns the candidate unchanged (no spurious +1).
    @Test func monotonicRepairPreservesRealForwardProgress() {
        let start = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: 500, last: nil)
        let stop = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: 1_800, last: start)
        #expect(start == 500)
        #expect(stop == 1_800)
    }

    /// A whole start→stop→start→stop sequence across two turns stays finite and strictly
    /// monotonic, including a warm-up (nil) start followed by stalled offsets — the exact
    /// shape the server turn tracker needs to finalize each turn.
    @Test func monotonicSequenceAcrossTurnsIsStrictlyIncreasing() {
        var last: Double?
        var emitted: [Double] = []
        // Turn 1: warm-up start (nil), stop stalls at 0 offset.
        for candidate in [nil, Double(0)] as [Double?] {
            let next = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: candidate, last: last)
            emitted.append(next)
            last = next
        }
        // Turn 2: offsets now flow from the recording sink.
        for candidate in [Double(1_200), Double(1_200)] as [Double?] {
            let next = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: candidate, last: last)
            emitted.append(next)
            last = next
        }
        #expect(emitted.count == 4)
        for i in 1..<emitted.count {
            #expect(emitted[i] > emitted[i - 1], "VAD offset \(i) not strictly after previous: \(emitted)")
        }
        #expect(emitted.allSatisfy { $0.isFinite })
    }

    /// NaN/infinite candidates never poison the timeline: the repair falls back to the
    /// monotonic floor and stays finite.
    @Test func monotonicRepairRejectsNonFiniteCandidate() {
        let next = LiveSessionStore.monotonicVoiceprintVadOffsetMs(candidate: .nan, last: 300)
        #expect(next.isFinite)
        #expect(next > 300)
    }

    // MARK: - OFF-BY-DEFAULT / unrelated event kinds unchanged

    /// A transcript-completed event still requires an item_id (unchanged), so the fix does
    /// not widen or alter the non-VAD converter surface.
    @Test func transcriptCompletedStillRequiresItemID() {
        let missing = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "conversation.item.input_audio_transcription.completed",
            rawJSON: "{}"
        )
        #expect(missing == nil)

        let present = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "conversation.item.input_audio_transcription.completed",
            rawJSON: "{\"item_id\": \"item-1\", \"transcript\": \"hi\"}"
        )
        #expect(present?.itemID == "item-1")
        #expect(present?.transcript == "hi")
    }

    /// An unrelated raw event kind is still dropped (returns nil) — the converter did not
    /// become permissive for everything, only for the two VAD kinds it already handled.
    @Test func unrelatedEventKindStillDropped() {
        let event = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "response.created",
            rawJSON: "{}"
        )
        #expect(event == nil)
    }

    // MARK: - warm-up audio-artifact late-bind (concern #2)

    /// Warm-up race: for WebRTC the parallel-mic WAV opens lazily on the first streamed
    /// chunk, so a first-turn speech_stopped can find `currentAudioArtifact == nil`. Before
    /// the fix the artifact was dropped permanently and the server (includeMissingAudio=false)
    /// never finalized/scored that turn. The fix stashes the join keys so the artifact can be
    /// late-bound once the WAV opens. This pins the stash's de-dupe + ordering contract.
    @Test func pendingAudioArtifactStashDeDupesByJoinKey() {
        var pending: [(itemID: String?, speechWindowID: String?)] = []

        // First warm-up turn: no real item_id yet (arg-less WebRTC), only the synthesized
        // speech window id. It must be stashed.
        LiveSessionStore.appendPendingVoiceprintAudioArtifactJoin(
            itemID: nil,
            speechWindowID: "ios_speech_1",
            into: &pending
        )
        #expect(pending.count == 1)
        #expect(pending.first?.speechWindowID == "ios_speech_1")

        // A re-fired speech_stopped for the SAME window must not double-bind.
        LiveSessionStore.appendPendingVoiceprintAudioArtifactJoin(
            itemID: nil,
            speechWindowID: "ios_speech_1",
            into: &pending
        )
        #expect(pending.count == 1)

        // A distinct window (second warm-up turn) is stashed, preserving order.
        LiveSessionStore.appendPendingVoiceprintAudioArtifactJoin(
            itemID: nil,
            speechWindowID: "ios_speech_2",
            into: &pending
        )
        #expect(pending.count == 2)
        #expect(pending.map { $0.speechWindowID } == ["ios_speech_1", "ios_speech_2"])
    }

    /// item_id takes precedence over speechWindowID for the join key (matching
    /// voiceprintAudioArtifactEvent), so two entries that share an item_id de-dupe even if
    /// their window ids differ. A pair with no usable join key is ignored (never stashed).
    @Test func pendingAudioArtifactStashKeysOnItemIDFirstAndDropsEmpty() {
        var pending: [(itemID: String?, speechWindowID: String?)] = []

        LiveSessionStore.appendPendingVoiceprintAudioArtifactJoin(
            itemID: "item_real_7",
            speechWindowID: "ios_speech_9",
            into: &pending
        )
        // Same item_id, different window -> same server join key -> de-duped.
        LiveSessionStore.appendPendingVoiceprintAudioArtifactJoin(
            itemID: "item_real_7",
            speechWindowID: "ios_speech_99",
            into: &pending
        )
        #expect(pending.count == 1)
        #expect(pending.first?.itemID == "item_real_7")

        // Empty/whitespace join keys are ignored.
        LiveSessionStore.appendPendingVoiceprintAudioArtifactJoin(
            itemID: "   ",
            speechWindowID: nil,
            into: &pending
        )
        #expect(pending.count == 1)
    }

    /// The late-bound artifact event keys on the SAME join id the server tracker uses to
    /// match `audioByWindow`: the artifact id embeds the join id (item_id first, else the
    /// speech window id). This is what lets a warm-up turn's late artifact bind to its
    /// finalized window. Pins the join-id embedding for a window-only (warm-up) artifact.
    @Test func lateBoundArtifactEventCarriesWindowJoinID() {
        let artifact = LiveVoiceprintAudioArtifactReference(
            audioArtifactID: "rec_abc",
            audioPath: "/tmp/rec_abc.wav",
            sampleRate: 24_000
        )
        let event = LiveSessionStore.voiceprintAudioArtifactEvent(
            itemID: nil,
            speechWindowID: "ios_speech_1",
            artifact: artifact,
            route: "webrtc"
        )
        #expect(event.type == "live_recording.audio_artifact")
        #expect(event.speechWindowID == "ios_speech_1")
        // The server joins the artifact to the window via this composite id.
        #expect(event.audioArtifactID == "rec_abc:ios_speech_1")
        #expect(event.audioPath == "/tmp/rec_abc.wav")
        #expect(event.sampleRate == 24_000)
    }
}
