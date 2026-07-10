import Testing
import Foundation
@testable import hawky

@Suite struct VoiceprintEmbedderTests {

    // MARK: - Deterministic stub embedder

    @Test func deterministicEmbedderProducesStableFixedDimensionVector() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let samples = [Float](repeating: 0.25, count: 4_800)
        let a = try embedder.embed(samples, sampleRate: 16_000)
        #expect(a.dimension == DeterministicSpeakerEmbedder.defaultDimension)
        #expect(a.dimension == 192)
        // All finite (server rejects not_finite).
        #expect(a.vector.allSatisfy { $0.isFinite })
    }

    @Test func deterministicEmbedderSameInputYieldsSameVector() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let samples = (0..<2_048).map { Float(sin(Double($0) * 0.05)) }
        let a = try embedder.embed(samples, sampleRate: 16_000)
        let b = try embedder.embed(samples, sampleRate: 16_000)
        #expect(a.vector == b.vector)
    }

    @Test func deterministicEmbedderDifferentInputsDiffer() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let one = (0..<2_048).map { Float(sin(Double($0) * 0.05)) }
        let two = (0..<2_048).map { Float(sin(Double($0) * 0.07)) }
        let a = try embedder.embed(one, sampleRate: 16_000)
        let b = try embedder.embed(two, sampleRate: 16_000)
        #expect(a.vector != b.vector)
    }

    @Test func deterministicEmbedderIsL2NormalizedAndNonZero() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let samples = (0..<1_024).map { Float(cos(Double($0) * 0.03)) }
        let embedding = try embedder.embed(samples, sampleRate: 16_000)
        let norm = sqrt(embedding.vector.reduce(Float(0)) { $0 + $1 * $1 })
        #expect(abs(norm - 1) < 1e-3)
        // Never zero-norm (server rejects zero_norm).
        #expect(embedding.vector.contains { $0 != 0 })
    }

    @Test func deterministicEmbedderThrowsOnTooShortBuffer() {
        let embedder = DeterministicSpeakerEmbedder(minimumFrames: 16)
        #expect(throws: SpeakerEmbedderError.self) {
            _ = try embedder.embed([0.1, 0.2, 0.3], sampleRate: 16_000)
        }
        #expect(throws: SpeakerEmbedderError.self) {
            _ = try embedder.embed([], sampleRate: 16_000)
        }
    }

    @Test func deterministicEmbedderTooShortErrorIsTyped() {
        let embedder = DeterministicSpeakerEmbedder(minimumFrames: 16)
        do {
            _ = try embedder.embed([0.1], sampleRate: 16_000)
            Issue.record("expected throw")
        } catch let error as SpeakerEmbedderError {
            #expect(error == .sampleBufferTooShort(count: 1, minimum: 16))
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    // MARK: - Model info + provider serialization

    @Test func deterministicEmbedderStampsReferenceProvider() {
        let embedder = DeterministicSpeakerEmbedder()
        #expect(embedder.modelInfo.provider == .reference)
        #expect(embedder.isAvailable)
    }

    @Test func modelInfoSerializesExactServerKeys() {
        let info = SpeakerEmbeddingModelInfo(provider: .custom, modelId: "campplus-coreml", version: "3")
        let object = info.jsonObject
        #expect(object["provider"] == .string("custom"))
        #expect(object["modelId"] == .string("campplus-coreml"))
        #expect(object["version"] == .string("3"))
    }

    @Test func modelInfoOmitsEmptyVersion() {
        let info = SpeakerEmbeddingModelInfo(provider: .reference, modelId: "reference-hash-v1", version: nil)
        let object = info.jsonObject
        #expect(object["version"] == nil)
        #expect(object["provider"] == .string("reference"))
    }

    // MARK: - CoreML seam: model-unavailable path degrades gracefully

    @Test func coreMLEmbedderUnavailableWhenModelAbsent() {
        // No campplus.mlmodelc is committed to this repo, so bundle load misses
        // and the embedder reports itself unavailable rather than crashing.
        let embedder = CoreMLSpeakerEmbedder.available(modelName: "campplus", bundle: .main)
        #expect(!embedder.isAvailable)
        #expect(embedder.modelInfo.provider == .custom)
    }

    @Test func coreMLEmbedderThrowsModelUnavailableWhenAbsent() {
        let embedder = CoreMLSpeakerEmbedder(model: nil)
        #expect(!embedder.isAvailable)
        let samples = [Float](repeating: 0.1, count: 4_800)
        do {
            _ = try embedder.embed(samples, sampleRate: 16_000)
            Issue.record("expected throw")
        } catch let error as SpeakerEmbedderError {
            guard case .modelUnavailable = error else {
                Issue.record("expected .modelUnavailable, got \(error)")
                return
            }
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    // MARK: - score_turns serialization

    @Test func scoreTurnEmitsEmbeddingAsNumberArrayAndModelObject() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let samples = (0..<2_048).map { Float(sin(Double($0) * 0.05)) }
        let embedding = try embedder.embed(samples, sampleRate: 16_000)

        let turn = LiveVoiceprintScoreTurn(
            sessionKey: "realtime:main",
            transcriptItemID: "item-1",
            role: "user",
            text: "hello",
            startMs: 100,
            endMs: 900,
            embedding: embedding,
            nonce: "nonce-abc"
        )
        let object = turn.turnObject

        // Required server keys.
        #expect(object["transcriptItemId"] == .string("item-1"))
        #expect(object["role"] == .string("user"))
        #expect(object["startMs"] == .number(100))
        #expect(object["endMs"] == .number(900))

        // sampleEmbedding is a JSON number array of the right dimension.
        guard case let .array(values)? = object["sampleEmbedding"] else {
            Issue.record("sampleEmbedding not an array")
            return
        }
        #expect(values.count == 192)
        #expect(values.allSatisfy { if case .number = $0 { return true }; return false })

        // sampleEmbeddingModel is an object with the exact server keys.
        guard case let .object(model)? = object["sampleEmbeddingModel"] else {
            Issue.record("sampleEmbeddingModel not an object")
            return
        }
        #expect(model["provider"] == .string("reference"))
        #expect(model["modelId"] == .string("reference-hash-v1"))

        // Optional nonce carried through.
        #expect(object["nonce"] == .string("nonce-abc"))
    }

    @Test func scoreTurnWithoutEmbeddingOmitsEmbeddingFields() {
        let turn = LiveVoiceprintScoreTurn(
            transcriptItemID: "item-2",
            role: "assistant",
            startMs: 0,
            endMs: 500
        )
        let object = turn.turnObject
        #expect(object["sampleEmbedding"] == nil)
        #expect(object["sampleEmbeddingModel"] == nil)
        #expect(object["nonce"] == nil)
        // Still a valid minimal turn.
        #expect(object["transcriptItemId"] == .string("item-2"))
        #expect(object["role"] == .string("assistant"))
    }

    @Test func scoreTurnOptionalNonceOmittedWhenNil() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let embedding = try embedder.embed([Float](repeating: 0.2, count: 512), sampleRate: 16_000)
        let turn = LiveVoiceprintScoreTurn(
            transcriptItemID: "item-3",
            role: "user",
            startMs: 10,
            endMs: 20,
            embedding: embedding,
            nonce: nil
        )
        let object = turn.turnObject
        #expect(object["nonce"] == nil)
        // Embedding still present even without a nonce (B2 supplies the nonce).
        #expect(object["sampleEmbedding"] != nil)
    }

    @Test func scoreTurnsParamsWrapsTurnsUnderTurnsKey() {
        let turn = LiveVoiceprintScoreTurn(
            transcriptItemID: "item-4",
            role: "user",
            startMs: 0,
            endMs: 100
        )
        let params = LiveVoiceprintScoreTurn.scoreTurnsParams(sessionKey: "realtime:main", turns: [turn])
        #expect(params["sessionKey"] == .string("realtime:main"))
        guard case let .array(turns)? = params["turns"] else {
            Issue.record("turns not an array")
            return
        }
        #expect(turns.count == 1)
    }

    @Test func scoreTurnRoundTripsThroughJSONEncoder() throws {
        let embedder = DeterministicSpeakerEmbedder()
        let embedding = try embedder.embed([Float](repeating: 0.3, count: 1_024), sampleRate: 16_000)
        let turn = LiveVoiceprintScoreTurn(
            transcriptItemID: "item-5",
            role: "user",
            startMs: 0,
            endMs: 100,
            embedding: embedding
        )
        let params = LiveVoiceprintScoreTurn.scoreTurnsParams(sessionKey: "k", turns: [turn])
        // Encodes as valid JSON with a numeric sampleEmbedding array.
        let data = try JSONEncoder().encode(JSONValue.object(params))
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let decodedTurns = try #require(root["turns"] as? [[String: Any]])
        let decodedEmbedding = try #require(decodedTurns.first?["sampleEmbedding"] as? [Any])
        #expect(decodedEmbedding.count == 192)
        #expect(decodedEmbedding.allSatisfy { $0 is NSNumber })
        let model = try #require(decodedTurns.first?["sampleEmbeddingModel"] as? [String: Any])
        #expect(model["provider"] as? String == "reference")
    }

    // MARK: - buildVoiceprintScoreTurns wiring

    @Test func buildScoreTurnsAttachesEmbeddingWhenPCMAvailable() {
        let embedder = DeterministicSpeakerEmbedder()
        let finalized = LiveVoiceprintFinalizedTurn(object: [
            "sessionKey": .string("realtime:main"),
            "transcriptItemId": .string("item-a"),
            "role": .string("user"),
            "startMs": .number(0),
            "endMs": .number(800),
            "speechWindowId": .string("ios_speech_1"),
        ])
        let turns = LiveSessionStore.buildVoiceprintScoreTurns(
            sessionKey: "realtime:main",
            finalizedTurns: [finalized].compactMap { $0 },
            embedder: embedder,
            nonce: nil,
            pcmForTurn: { _ in ((0..<2_048).map { Float(sin(Double($0) * 0.05)) }, 16_000) }
        )
        #expect(turns.count == 1)
        #expect(turns.first?.embedding != nil)
        #expect(turns.first?.embedding?.model.provider == .reference)
    }

    @Test func buildScoreTurnsDegradesToMarkersWhenNoEmbedderOrPCM() {
        let finalized = LiveVoiceprintFinalizedTurn(object: [
            "transcriptItemId": .string("item-b"),
            "role": .string("user"),
            "startMs": .number(0),
            "endMs": .number(800),
            "speechWindowId": .string("ios_speech_1"),
        ])
        // No embedder → markers only.
        let noEmbedder = LiveSessionStore.buildVoiceprintScoreTurns(
            sessionKey: "k",
            finalizedTurns: [finalized].compactMap { $0 },
            embedder: nil,
            pcmForTurn: { _ in ([Float](repeating: 0.1, count: 2_048), 16_000) }
        )
        #expect(noEmbedder.first?.embedding == nil)

        // Embedder present but no PCM → markers only, no crash.
        let noPCM = LiveSessionStore.buildVoiceprintScoreTurns(
            sessionKey: "k",
            finalizedTurns: [finalized].compactMap { $0 },
            embedder: DeterministicSpeakerEmbedder(),
            pcmForTurn: { _ in nil }
        )
        #expect(noPCM.first?.embedding == nil)
    }

    @Test func buildScoreTurnsSkipsEmbeddingWhenModelUnavailable() {
        let finalized = LiveVoiceprintFinalizedTurn(object: [
            "transcriptItemId": .string("item-c"),
            "role": .string("user"),
            "startMs": .number(0),
            "endMs": .number(800),
            "speechWindowId": .string("ios_speech_1"),
        ])
        let turns = LiveSessionStore.buildVoiceprintScoreTurns(
            sessionKey: "k",
            finalizedTurns: [finalized].compactMap { $0 },
            embedder: CoreMLSpeakerEmbedder(model: nil), // unavailable
            pcmForTurn: { _ in ([Float](repeating: 0.1, count: 2_048), 16_000) }
        )
        // Unavailable model → no embedding, marker path, no throw.
        #expect(turns.first?.embedding == nil)
    }

    // MARK: - Off-by-default config

    @Test func onDeviceEmbeddingDefaultsOff() {
        let config = LiveSessionConfig()
        #expect(config.onDeviceEmbeddingEnabled == false)
        #expect(config.voiceprintRealtimeEnabled == false)
    }
}
