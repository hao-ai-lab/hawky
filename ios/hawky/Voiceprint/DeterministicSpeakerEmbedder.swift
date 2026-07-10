import Foundation

/// Dev/test-only reference `SpeakerEmbedder`.
///
/// This is NOT a real speaker model. It hashes the input PCM into a stable,
/// fixed-dimension, L2-normalized vector so the seam and the score_turns
/// serialization can be exercised in unit tests WITHOUT the device-provisioned
/// CAM++ CoreML binary. It is non-discriminative: two different speakers saying
/// the same words would collide, and it must NEVER be used to make a real
/// identity decision. It exists purely to keep the wire shape testable.
///
/// Determinism contract (relied on by tests):
/// - The same input samples + sampleRate always yield the same vector.
/// - Different inputs yield different vectors (with overwhelming probability).
struct DeterministicSpeakerEmbedder: SpeakerEmbedder {
    /// CAM++ target dimension, so serialization tests see a realistic 192-dim shape.
    static let defaultDimension = 192
    /// Minimum frames required to produce an embedding. Below this we throw
    /// `sampleBufferTooShort` — a real embedder needs a meaningful window, and
    /// the stub mirrors that so the too-short path is testable.
    static let defaultMinimumFrames = 16

    private let dimension: Int
    private let minimumFrames: Int

    let modelInfo: SpeakerEmbeddingModelInfo

    init(
        dimension: Int = DeterministicSpeakerEmbedder.defaultDimension,
        minimumFrames: Int = DeterministicSpeakerEmbedder.defaultMinimumFrames,
        modelId: String = "reference-hash-v1",
        version: String? = "1"
    ) {
        self.dimension = max(1, dimension)
        self.minimumFrames = max(1, minimumFrames)
        // Provider `.reference` is on the server's allow-list; the gateway treats
        // it as a non-production model and (absent a matching owner template) will
        // reject it with `model_mismatch`, so a stub embedding can never
        // manufacture a spurious owner match against a real CAM++ template.
        self.modelInfo = SpeakerEmbeddingModelInfo(
            provider: .reference,
            modelId: modelId,
            version: version
        )
    }

    /// The stub is always available — it has no external model dependency.
    var isAvailable: Bool { true }

    func embed(_ samples: [Float], sampleRate: Double) throws -> SpeakerEmbedding {
        guard samples.count >= minimumFrames else {
            throw SpeakerEmbedderError.sampleBufferTooShort(
                count: samples.count,
                minimum: minimumFrames
            )
        }

        // Seed a splitmix64 PRNG from a stable hash of the samples + rate, then
        // fill the vector. This gives determinism (same input → same vector) and
        // separation (different input → different seed → different vector) without
        // modeling anything acoustic.
        var hasher = Hasher()
        hasher.combine(samples.count)
        hasher.combine(Int(sampleRate.rounded()))
        // Quantize samples so tiny float noise doesn't defeat determinism, while
        // real signal differences still change the digest.
        for sample in samples {
            let clamped = min(1, max(-1, sample))
            hasher.combine(Int32((clamped * 32767).rounded()))
        }
        var state = UInt64(bitPattern: Int64(hasher.finalize())) ^ 0x9E3779B97F4A7C15

        var vector = [Float](repeating: 0, count: dimension)
        for index in 0..<dimension {
            vector[index] = Float(Self.nextUnitInterval(&state)) * 2 - 1
        }

        // L2-normalize so the vector lands on the unit hypersphere (the gateway
        // rejects a zero-norm embedding; cosine scoring assumes normalized-ish
        // vectors). Guaranteed non-zero for a non-empty vector by construction.
        let norm = sqrt(vector.reduce(Float(0)) { $0 + $1 * $1 })
        if norm > 0 {
            for index in vector.indices {
                vector[index] /= norm
            }
        } else {
            // Degenerate-only guard; keeps a finite, non-zero vector so we never
            // emit something the server would reject as zero_norm.
            vector[0] = 1
        }

        return SpeakerEmbedding(vector: vector, model: modelInfo)
    }

    /// splitmix64 → [0, 1). Deterministic given the same starting `state`.
    private static func nextUnitInterval(_ state: inout UInt64) -> Double {
        state = state &+ 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        z = z ^ (z >> 31)
        // Top 53 bits → double in [0, 1).
        return Double(z >> 11) * (1.0 / 9_007_199_254_740_992.0)
    }
}
