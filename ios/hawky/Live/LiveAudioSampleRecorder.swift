import AVFoundation
import Foundation

final class LiveAudioSampleRecorder {
    private let source: AudioSource
    private var sampleTask: Task<Void, Never>?
    private var capturedData = Data()
    private(set) var capturedBytes = 0

    /// Default Live capture turns on voice-processing AEC so the model's
    /// loudspeaker reply doesn't echo back into the mic. Callers can inject a
    /// custom source (e.g. tests) to override.
    init(enableEchoCancellation: Bool = true) {
        self.source = MicAudioSource(enableVoiceProcessing: enableEchoCancellation)
    }

    init(source: AudioSource) {
        self.source = source
    }

    func start(onChunk: @escaping @Sendable (LiveAudioChunk) async -> Void) async throws {
        capturedData.removeAll(keepingCapacity: true)
        capturedBytes = 0
        try activateSession()

        sampleTask = Task { [source] in
            for await chunk in source.samples {
                let converted = LivePCM16Resampler.resample(
                    chunk.pcm,
                    sourceRate: chunk.sampleRate,
                    targetRate: 24_000
                )
                guard !converted.isEmpty else { continue }
                await MainActor.run {
                    self.capturedData.append(converted)
                    self.capturedBytes = self.capturedData.count
                }
                await onChunk(LiveAudioChunk(
                    data: converted,
                    formatDescription: "pcm16/24000/mono",
                    capturedAt: Date()
                ))
            }
        }

        try await source.start()
    }

    func stop(shouldDeactivateSession: Bool = true) async -> LiveAudioChunk? {
        await source.stop()
        sampleTask?.cancel()
        sampleTask = nil
        if shouldDeactivateSession {
            deactivateSession()
        }

        guard !capturedData.isEmpty else { return nil }
        return LiveAudioChunk(
            data: capturedData,
            formatDescription: "pcm16/24000/mono",
            capturedAt: Date()
        )
    }

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try? session.setPreferredSampleRate(24_000)
        try session.setActive(true)
    }

    private func deactivateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.ambient, mode: .default)
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
        } catch let error as NSError {
            if error.code != 561_017_449 {
                print("[LiveAudioSampleRecorder] session deactivate failed: \(error)")
            }
        }
    }
}

enum LivePCM16Resampler {
    static func resample(_ data: Data, sourceRate: Double, targetRate: Double) -> Data {
        guard sourceRate > 0, targetRate > 0, !data.isEmpty else { return Data() }
        if abs(sourceRate - targetRate) < 0.5 {
            return data
        }

        let sourceSampleCount = data.count / MemoryLayout<Int16>.size
        guard sourceSampleCount > 0 else { return Data() }

        let targetSampleCount = max(1, Int((Double(sourceSampleCount) * targetRate / sourceRate).rounded()))
        var output = Data(count: targetSampleCount * MemoryLayout<Int16>.size)
        data.withUnsafeBytes { sourceRaw in
            output.withUnsafeMutableBytes { targetRaw in
                guard let source = sourceRaw.bindMemory(to: Int16.self).baseAddress,
                      let target = targetRaw.bindMemory(to: Int16.self).baseAddress else { return }
                for index in 0..<targetSampleCount {
                    let sourceIndex = min(sourceSampleCount - 1, Int((Double(index) * sourceRate / targetRate).rounded()))
                    target[index] = source[sourceIndex]
                }
            }
        }
        return output
    }
}
