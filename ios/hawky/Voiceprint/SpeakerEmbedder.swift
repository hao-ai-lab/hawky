import Foundation

extension Dictionary where Key == String, Value == JSONValue {
    /// Set `key` to a `.string` value only when the optional is present and
    /// non-empty. Omitting empty/absent strings matches the server parser's
    /// treatment of these optional fields.
    mutating func setOptionalString(_ key: String, _ value: String?) {
        if let value, !value.isEmpty { self[key] = .string(value) }
    }
}

/// On-device speaker-embedder seam (workflow B1).
///
/// The gateway already ships a client-embedding scoring path
/// (`src/identity/voiceprint/live-client-embedding.ts`): when
/// `acceptClientEmbeddings` is on and a valid A8 liveness nonce is present, the
/// server scores a client-supplied embedding DIRECTLY against the owner template
/// so no raw biometric audio ever leaves the phone. This seam is the iOS producer
/// of that embedding.
///
/// The seam is deliberately model-agnostic:
/// - `CoreMLSpeakerEmbedder` loads a device-provisioned CAM++ CoreML model BY NAME
///   if the compiled `.mlmodelc` is present in the app bundle, and reports itself
///   unavailable otherwise. That binary is gitignored (like the server's
///   `campplus.onnx`) and is NOT committed to this repo.
/// - `DeterministicSpeakerEmbedder` is a dev/test-only reference that hashes the
///   input into a stable fixed-dimension vector. It is NON-DISCRIMINATIVE (it does
///   not model any real speaker characteristics) and exists only so the seam and
///   the score_turns serialization are unit-testable without the real model.
///
/// Target embedding dimension for CAM++ is 192; the deterministic reference uses
/// the same dimension so serialization tests exercise a realistic shape.
protocol SpeakerEmbedder: Sendable {
    /// Whether this embedder can actually produce embeddings right now. A CoreML
    /// embedder returns false when its model binary is absent; callers MUST fall
    /// back to the existing marker path and never block the live session.
    var isAvailable: Bool { get }

    /// The model identity this embedder stamps onto every embedding it produces.
    /// Serialized as `sampleEmbeddingModel` so the gateway can reject a
    /// model-mismatch against the owner template.
    var modelInfo: SpeakerEmbeddingModelInfo { get }

    /// Compute a speaker embedding for a finalized turn's mono PCM samples.
    /// `samples` are normalized float PCM in [-1, 1]; `sampleRate` is in Hz.
    /// Throws `SpeakerEmbedderError` for empty/too-short input or an unavailable
    /// model — callers treat any throw as "fall back to markers", never a crash.
    func embed(_ samples: [Float], sampleRate: Double) throws -> SpeakerEmbedding
}

/// Identity of the model that produced an embedding. Field names + valid provider
/// values match the gateway `sampleEmbeddingModel` contract
/// (`parseOptionalClientEmbeddingModel` in `src/gateway/voiceprint-methods.ts`).
struct SpeakerEmbeddingModelInfo: Equatable, Sendable {
    /// Must be one of the server's allowed providers. The two this seam uses:
    /// - `.reference` for the deterministic dev/test stub.
    /// - `.custom` for the device-provisioned CAM++ CoreML model.
    enum Provider: String, Equatable, Sendable {
        case externalJSON = "external-json"
        case signalBaseline = "signal-baseline"
        case speechbrain
        case wespeaker
        case picovoice
        case sherpaONNX = "sherpa-onnx"
        case reference
        case custom
    }

    var provider: Provider
    var modelId: String
    var version: String?

    init(provider: Provider, modelId: String, version: String? = nil) {
        self.provider = provider
        self.modelId = modelId
        self.version = version
    }

    /// Serialize as the `sampleEmbeddingModel` object the gateway expects:
    /// `{ provider, modelId, version? }` with those EXACT keys.
    var jsonObject: [String: JSONValue] {
        var object: [String: JSONValue] = [
            "provider": .string(provider.rawValue),
            "modelId": .string(modelId),
        ]
        if let version, !version.isEmpty {
            object["version"] = .string(version)
        }
        return object
    }
}

/// A computed speaker embedding plus the model that produced it.
struct SpeakerEmbedding: Equatable, Sendable {
    /// CAM++ speaker-embedding dimension. Single source of truth shared by the
    /// CoreML and deterministic-reference embedders (the reference stub matches it
    /// so serialization tests exercise a realistic 192-dim shape).
    static let camPlusDimension = 192

    /// The embedding vector. Target dimension is 192 for CAM++.
    var vector: [Float]
    var model: SpeakerEmbeddingModelInfo

    init(vector: [Float], model: SpeakerEmbeddingModelInfo) {
        self.vector = vector
        self.model = model
    }

    var dimension: Int { vector.count }

    /// Serialize the vector as a JSON number array for the `sampleEmbedding`
    /// turn field. Non-finite guards live server-side (`not_finite` rejection);
    /// this just widens Float → Double for JSON.
    var vectorJSONArray: JSONValue {
        .array(vector.map { .number(Double($0)) })
    }
}

/// Typed failures for the embedder seam. Callers treat any of these as "no
/// on-device embedding this turn → fall back to markers", never a crash.
enum SpeakerEmbedderError: Error, Equatable {
    /// The sample buffer was empty or shorter than `minimum` frames.
    case sampleBufferTooShort(count: Int, minimum: Int)
    /// The backing model (e.g. CoreML CAM++) is not present on this device.
    case modelUnavailable(String)
    /// The model ran but produced an unusable vector (empty / wrong dimension).
    case invalidEmbedding(String)
}

/// One turn's worth of score_turns params, carrying the on-device embedding.
///
/// This is the EXACT shape the gateway `score_turns` turn parser accepts
/// (`parseScoreTurnInput` in `src/gateway/voiceprint-methods.ts`):
/// required `transcriptItemId` / `role` / `startMs` / `endMs`, plus the
/// optional on-device fields `sampleEmbedding` (number array),
/// `sampleEmbeddingModel` (`{provider, modelId, version?}`), and `nonce`.
///
/// The `nonce` is the A8 single-use liveness nonce. B1 only leaves a place for
/// it — B2 fetches/binds it via `request_embedding_challenge`. When nil, the
/// field is omitted and the gateway will not score the client embedding (it
/// requires a valid nonce), which keeps this path safely inert until B2 lands.
struct LiveVoiceprintScoreTurn: Equatable, Sendable {
    var sessionKey: String?
    var transcriptItemID: String
    var role: String
    var text: String?
    var startMs: Double
    var endMs: Double
    var audioArtifactID: String?
    var audioPath: String?
    var route: String?
    /// The on-device embedding for this turn, if one was produced. nil → the
    /// turn carries no client embedding and the server scores via its own path.
    var embedding: SpeakerEmbedding?
    /// A8 liveness nonce (populated by B2). nil → omit; server won't score the
    /// client embedding without it.
    var nonce: String?

    init(
        sessionKey: String? = nil,
        transcriptItemID: String,
        role: String,
        text: String? = nil,
        startMs: Double,
        endMs: Double,
        audioArtifactID: String? = nil,
        audioPath: String? = nil,
        route: String? = nil,
        embedding: SpeakerEmbedding? = nil,
        nonce: String? = nil
    ) {
        self.sessionKey = sessionKey
        self.transcriptItemID = transcriptItemID
        self.role = role
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
        self.audioArtifactID = audioArtifactID
        self.audioPath = audioPath
        self.route = route
        self.embedding = embedding
        self.nonce = nonce
    }

    /// The `turn` object for `identity.voiceprint.score_turns` params. Keys match
    /// the server parser exactly.
    var turnObject: [String: JSONValue] {
        var object: [String: JSONValue] = [
            "transcriptItemId": .string(transcriptItemID),
            "role": .string(role),
            "startMs": .number(startMs),
            "endMs": .number(endMs),
        ]
        object.setOptionalString("sessionKey", sessionKey)
        if let text { object["text"] = .string(text) }
        object.setOptionalString("audioArtifactId", audioArtifactID)
        object.setOptionalString("audioPath", audioPath)
        object.setOptionalString("route", route)
        if let embedding {
            object["sampleEmbedding"] = embedding.vectorJSONArray
            object["sampleEmbeddingModel"] = .object(embedding.model.jsonObject)
        }
        object.setOptionalString("nonce", nonce)
        return object
    }

    /// Full `identity.voiceprint.score_turns` params for a batch of turns.
    static func scoreTurnsParams(
        sessionKey: String,
        turns: [LiveVoiceprintScoreTurn]
    ) -> [String: JSONValue] {
        [
            "sessionKey": .string(sessionKey),
            "turns": .array(turns.map { .object($0.turnObject) }),
        ]
    }
}
