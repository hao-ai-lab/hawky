import Foundation
@preconcurrency import CoreML

/// CoreML-backed `SpeakerEmbedder` seam for the device-provisioned CAM++ model.
///
/// The compiled model (`.mlmodelc`, produced from a `.mlpackage`/`.mlmodel`) is a
/// device-provisioned, gitignored binary — exactly like the server's gitignored
/// `campplus.onnx`. It is NOT committed to this repo. This type loads it BY NAME
/// from the app bundle if present, and reports `isAvailable == false` when it is
/// absent, so the live session cleanly falls back to the existing marker path and
/// never crashes.
///
/// The audio → model-feature transform (framing, log-Mel/fbank, windowing) is
/// intentionally left as a single seam method (`makeFeatureProvider`) so the real
/// front-end can be dropped in when the model ships. Until the model binary is
/// provisioned, `load(modelName:)` returns nil and callers use the marker path or
/// the deterministic reference embedder.
struct CoreMLSpeakerEmbedder: SpeakerEmbedder {
    /// Default bundle resource name for the compiled CAM++ model. Overridable so a
    /// build can provision the model under a different name without code changes.
    static let defaultModelName = "campplus"
    /// CAM++ speaker embedding dimension.
    static let defaultDimension = 192
    /// Minimum frames required before we attempt an embedding.
    static let defaultMinimumFrames = 16

    private let model: MLModel?
    private let minimumFrames: Int
    private let inputFeatureName: String
    private let outputFeatureName: String

    let modelInfo: SpeakerEmbeddingModelInfo

    /// Construct with an explicitly provided (already-loaded) model, or nil for the
    /// unavailable seam. Prefer `available(modelName:)` for the bundle-load path.
    init(
        model: MLModel?,
        modelId: String = "campplus-coreml",
        version: String? = nil,
        minimumFrames: Int = CoreMLSpeakerEmbedder.defaultMinimumFrames,
        inputFeatureName: String = "audio",
        outputFeatureName: String = "embedding"
    ) {
        self.model = model
        self.minimumFrames = max(1, minimumFrames)
        self.inputFeatureName = inputFeatureName
        self.outputFeatureName = outputFeatureName
        // Provider `.custom` on the server allow-list. The real model version is
        // stamped in when the binary is provisioned; the gateway enforces a
        // model match against the owner template.
        self.modelInfo = SpeakerEmbeddingModelInfo(
            provider: .custom,
            modelId: modelId,
            version: version
        )
    }

    /// Attempt to load the bundled compiled CAM++ model by name. Returns an
    /// embedder whose `isAvailable` is false when the model is absent — the
    /// expected default state in this open repo (binary is gitignored). Never
    /// throws; a missing model is a normal, handled condition.
    static func available(
        modelName: String = CoreMLSpeakerEmbedder.defaultModelName,
        bundle: Bundle = .main,
        configuration: MLModelConfiguration = MLModelConfiguration()
    ) -> CoreMLSpeakerEmbedder {
        let model = loadCompiledModel(named: modelName, bundle: bundle, configuration: configuration)
        return CoreMLSpeakerEmbedder(model: model)
    }

    /// Available only when the CoreML model actually loaded.
    var isAvailable: Bool { model != nil }

    func embed(_ samples: [Float], sampleRate: Double) throws -> SpeakerEmbedding {
        guard let model else {
            throw SpeakerEmbedderError.modelUnavailable(
                "CAM++ CoreML model is not provisioned on this device."
            )
        }
        guard samples.count >= minimumFrames else {
            throw SpeakerEmbedderError.sampleBufferTooShort(
                count: samples.count,
                minimum: minimumFrames
            )
        }

        let input = try makeFeatureProvider(samples: samples, sampleRate: sampleRate)
        let output: MLFeatureProvider
        do {
            output = try model.prediction(from: input)
        } catch {
            throw SpeakerEmbedderError.invalidEmbedding("CAM++ prediction failed: \(error)")
        }

        guard let array = output.featureValue(for: outputFeatureName)?.multiArrayValue else {
            throw SpeakerEmbedderError.invalidEmbedding(
                "CAM++ output '\(outputFeatureName)' missing or not a multi-array."
            )
        }
        let vector = Self.floatVector(from: array)
        guard !vector.isEmpty else {
            throw SpeakerEmbedderError.invalidEmbedding("CAM++ produced an empty embedding.")
        }
        return SpeakerEmbedding(vector: vector, model: modelInfo)
    }

    /// Build the model input feature provider from mono PCM. The real front-end
    /// (framing / fbank / normalization) is provisioned alongside the model; until
    /// then this passes the raw waveform as a `[1, N]` Float32 multi-array under
    /// the configured input name, which is a common CAM++ export layout.
    private func makeFeatureProvider(samples: [Float], sampleRate: Double) throws -> MLFeatureProvider {
        let count = samples.count
        guard let array = try? MLMultiArray(shape: [1, NSNumber(value: count)], dataType: .float32) else {
            throw SpeakerEmbedderError.invalidEmbedding("Could not allocate CAM++ input buffer.")
        }
        let pointer = array.dataPointer.bindMemory(to: Float32.self, capacity: count)
        for index in 0..<count {
            pointer[index] = Float32(samples[index])
        }
        do {
            return try MLDictionaryFeatureProvider(dictionary: [
                inputFeatureName: MLFeatureValue(multiArray: array),
            ])
        } catch {
            throw SpeakerEmbedderError.invalidEmbedding("Could not build CAM++ feature provider: \(error)")
        }
    }

    private static func floatVector(from array: MLMultiArray) -> [Float] {
        let count = array.count
        guard count > 0 else { return [] }
        var vector = [Float](repeating: 0, count: count)
        if array.dataType == .float32 {
            let pointer = array.dataPointer.bindMemory(to: Float32.self, capacity: count)
            for index in 0..<count { vector[index] = Float(pointer[index]) }
        } else {
            for index in 0..<count { vector[index] = array[index].floatValue }
        }
        return vector
    }

    /// Load a compiled `.mlmodelc` bundle resource by name, or a raw `.mlmodel` if
    /// only that is present (compiling it on-device). Returns nil on any miss.
    private static func loadCompiledModel(
        named modelName: String,
        bundle: Bundle,
        configuration: MLModelConfiguration
    ) -> MLModel? {
        if let compiledURL = bundle.url(forResource: modelName, withExtension: "mlmodelc"),
           let model = try? MLModel(contentsOf: compiledURL, configuration: configuration) {
            return model
        }
        if let rawURL = bundle.url(forResource: modelName, withExtension: "mlmodel"),
           let compiledURL = try? MLModel.compileModel(at: rawURL),
           let model = try? MLModel(contentsOf: compiledURL, configuration: configuration) {
            return model
        }
        return nil
    }
}
