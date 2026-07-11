import Testing
import Foundation
@testable import hawky

/// Server-side owner-recognition rendering tests: parse the per-turn `states` the
/// gateway returns (result/confidence/lifecycle), build MARKER-ONLY turns for the
/// on-device/B2 submission path (no sampleEmbedding, no nonce), and map states to the
/// live verbose recognition lines. WS2: iOS no longer boomerangs score_turns for the
/// server path — the gateway auto-scores and PIGGYBACKS `scoredStates`, which
/// `handleVoiceprintRealtimeResult` renders through the SAME shared renderer exercised
/// here. All pure/static — no live gateway.
@Suite struct VoiceprintServerSideRecognitionTests {

    // MARK: - states parsing

    /// A representative score_turns response with an owner_speaking (0.97) turn and an
    /// unknown_speaker (0.50) turn — the exact proof shape — is parsed per turn.
    @Test func scoreTurnsResultParsesPerTurnStates() {
        let result = LiveVoiceprintScoreTurnsResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "turns": .number(2),
            "states": .array([
                .object([
                    "transcriptItemId": .string("item-owner"),
                    "lifecycle": .string("resolved"),
                    "result": .string("owner_speaking"),
                    "confidence": .number(0.97),
                ]),
                .object([
                    "transcriptItemId": .string("item-other"),
                    "lifecycle": .string("resolved"),
                    "result": .string("unknown_speaker"),
                    "confidence": .number(0.50),
                ]),
            ]),
        ]))

        #expect(result?.ok == true)
        #expect(result?.states.count == 2)

        let owner = result?.states.first { $0.transcriptItemID == "item-owner" }
        #expect(owner?.result == "owner_speaking")
        #expect(owner?.confidence == 0.97)
        #expect(owner?.lifecycle == "resolved")

        let other = result?.states.first { $0.transcriptItemID == "item-other" }
        #expect(other?.result == "unknown_speaker")
        #expect(other?.confidence == 0.50)
    }

    /// A skipped state (no `result`/`confidence`) parses without a decision.
    @Test func scoreTurnsResultParsesSkippedStateWithoutResult() {
        let result = LiveVoiceprintScoreTurnsResult(payload: .object([
            "sessionKey": .string("realtime:main"),
            "states": .array([
                .object([
                    "transcriptItemId": .string("item-skip"),
                    "lifecycle": .string("skipped"),
                    "skipReason": .string("too_short"),
                ]),
            ]),
        ]))
        let state = result?.states.first
        #expect(state?.result == nil)
        #expect(state?.confidence == nil)
        #expect(state?.lifecycle == "skipped")
        #expect(state?.skipReason == "too_short")
    }

    /// A response without a `states` array yields an empty (non-nil) states list.
    @Test func scoreTurnsResultWithoutStatesIsEmpty() {
        let result = LiveVoiceprintScoreTurnsResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "turns": .number(1),
        ]))
        #expect(result?.states.isEmpty == true)
    }

    // MARK: - marker-only turns for finalized turns

    /// The server-side path builds MARKER-ONLY score_turns from finalized turns: with
    /// no embedder and no nonce, each turn carries transcriptItemId/role/startMs/endMs/
    /// audioArtifactId but NO sampleEmbedding and NO nonce.
    @Test func serverSidePathBuildsMarkerOnlyTurns() {
        let finalized = LiveVoiceprintFinalizedTurn(object: [
            "sessionKey": .string("realtime:main"),
            "transcriptItemId": .string("item-1"),
            "role": .string("user"),
            "startMs": .number(0),
            "endMs": .number(800),
            "audioArtifactId": .string("artifact-1"),
            "speechWindowId": .string("ios_speech_1"),
        ])!

        let turns = LiveSessionStore.buildVoiceprintScoreTurns(
            sessionKey: "realtime:main",
            finalizedTurns: [finalized],
            embedder: nil,
            nonce: nil,
            pcmForTurn: { _ in nil }
        )

        #expect(turns.count == 1)
        #expect(turns.first?.embedding == nil)
        #expect(turns.first?.nonce == nil)

        let object = turns.first!.turnObject
        #expect(object["transcriptItemId"] == .string("item-1"))
        #expect(object["role"] == .string("user"))
        #expect(object["audioArtifactId"] == .string("artifact-1"))
        // MARKER-ONLY: neither the client embedding nor a liveness nonce is present.
        #expect(object["sampleEmbedding"] == nil)
        #expect(object["sampleEmbeddingModel"] == nil)
        #expect(object["nonce"] == nil)
    }

    // MARK: - recognition line surfacing

    @Test func recognitionLinesSurfaceOwnerAndUnknown() {
        let result = LiveVoiceprintScoreTurnsResult(payload: .object([
            "sessionKey": .string("realtime:main"),
            "states": .array([
                .object([
                    "transcriptItemId": .string("item-owner"),
                    "lifecycle": .string("resolved"),
                    "result": .string("owner_speaking"),
                    "confidence": .number(0.97),
                ]),
                .object([
                    "transcriptItemId": .string("item-other"),
                    "lifecycle": .string("resolved"),
                    "result": .string("unknown_speaker"),
                    "confidence": .number(0.50),
                ]),
            ]),
        ]))

        let lines = LiveSessionStore.voiceprintRecognitionLines(result: result, total: 2)
        #expect(lines.count == 2)
        #expect(lines[0] == "🗣️ You (owner) · 0.97")
        #expect(lines[1] == "Unknown speaker · 0.50")
    }

    /// FAIL-SAFE: a nil result (transport error) NEVER surfaces an owner line.
    @Test func recognitionLinesNilResultNeverSurfacesOwner() {
        let lines = LiveSessionStore.voiceprintRecognitionLines(result: nil, total: 3)
        #expect(lines.count == 1)
        #expect(!lines[0].contains("owner"))
        #expect(!lines[0].contains("You"))
    }

    /// FAIL-SAFE: an empty states array NEVER surfaces an owner line.
    @Test func recognitionLinesEmptyStatesNeverSurfacesOwner() {
        let result = LiveVoiceprintScoreTurnsResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
        ]))
        let lines = LiveSessionStore.voiceprintRecognitionLines(result: result, total: 1)
        #expect(lines.count == 1)
        #expect(!lines[0].contains("You (owner)"))
    }

    /// WS2: the piggybacked `scoredStates` render through the SAME states-based
    /// renderer that `handleVoiceprintRealtimeResult` calls — owner + unknown surface,
    /// empty states surface no owner line.
    @Test func recognitionLinesFromScoredStatesMatchRenderer() {
        let states = [
            LiveVoiceprintScoreTurnState(object: [
                "transcriptItemId": .string("item-owner"),
                "lifecycle": .string("resolved"),
                "result": .string("owner_speaking"),
                "confidence": .number(0.97),
            ])!,
            LiveVoiceprintScoreTurnState(object: [
                "transcriptItemId": .string("item-other"),
                "lifecycle": .string("resolved"),
                "result": .string("unknown_speaker"),
                "confidence": .number(0.50),
            ])!,
        ]
        let lines = LiveSessionStore.voiceprintRecognitionLines(states: states, total: 2)
        #expect(lines.count == 2)
        #expect(lines[0] == "🗣️ You (owner) · 0.97")
        #expect(lines[1] == "Unknown speaker · 0.50")

        // FAIL-SAFE: empty scoredStates never surfaces an owner line.
        let empty = LiveSessionStore.voiceprintRecognitionLines(states: [], total: 4)
        #expect(empty.count == 1)
        #expect(!empty[0].contains("owner"))
    }

    /// A skipped/unscored turn is surfaced as "not scored", never as an owner.
    @Test func recognitionLinesSkippedTurnIsNotOwner() {
        let result = LiveVoiceprintScoreTurnsResult(payload: .object([
            "sessionKey": .string("realtime:main"),
            "states": .array([
                .object([
                    "transcriptItemId": .string("item-skip"),
                    "lifecycle": .string("skipped"),
                    "skipReason": .string("too_short"),
                ]),
            ]),
        ]))
        let lines = LiveSessionStore.voiceprintRecognitionLines(result: result, total: 1)
        #expect(lines.count == 1)
        #expect(lines[0].contains("not scored"))
        #expect(lines[0].contains("too_short"))
        #expect(!lines[0].contains("owner"))
    }
}
