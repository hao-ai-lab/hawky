import AVFoundation
import Combine
import Foundation

/// Publishes a 0...1 RMS level from the active AVAudioSession input at ~10 Hz.
/// Uses a 1-second rolling window so brief pops don't peg the meter.
@MainActor
final class MicLevelMeter: ObservableObject {
    /// Current smoothed RMS, scaled to 0...1.
    @Published private(set) var level: Float = 0

    // Fresh engine per start() to avoid carrying a stale input-format graph
    // across session-category changes (tab switches toggle .ambient ↔
    // .playAndRecord, which flips HW sample rate between 48 kHz and 16 kHz).
    // Reusing one engine across those transitions surfaces as:
    //   "AVAudioEngineGraph.mm:504 Error, formats don't match!"
    //   "Engine@...: could not initialize, error = -10868"
    // on the second start(). Mirrors MicAudioSource's proven teardown.
    private var engine: AVAudioEngine?
    private var windowSamples: [Float] = []
    private let windowCapacity = 10   // ~10 buffers/sec * 1 s = 10 RMS samples
    private var isRunning = false
    private var lastPublish: ContinuousClock.Instant = .now
    private let publishInterval: Duration = .milliseconds(100)

    func start() {
        guard !isRunning else { return }
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        // bufferSize is a hint; pass format: nil so the node uses its own
        // live format (avoids "Failed to create tap due to format mismatch"
        // after a session reroute). The fresh engine above guarantees this
        // format matches the CURRENT HW format, not a stale one.
        let frames: AVAudioFrameCount = 4096
        input.removeTap(onBus: 0)
        // installTap can raise an Obj-C NSException on a format mismatch, which a
        // Swift do/catch can't catch — guard it so the meter just stays at 0
        // instead of aborting the app. (#673)
        do {
            try AudioGraphGuard.run {
                input.installTap(onBus: 0, bufferSize: frames, format: nil) { [weak self] buffer, _ in
                    guard let self else { return }
                    let rms = Self.computeRMS(buffer)
                    Task { @MainActor [weak self] in
                        self?.ingest(rms: rms)
                    }
                }
            }
        } catch {
            self.engine = nil
            return
        }
        do {
            engine.prepare()
            try engine.start()
            isRunning = true
        } catch {
            // Non-fatal for Phase A: the meter just sits at 0.
            input.removeTap(onBus: 0)
            self.engine = nil
        }
    }

    func stop() {
        guard isRunning else { return }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
        engine = nil
        windowSamples.removeAll(keepingCapacity: true)
        level = 0
        isRunning = false
    }

    private func ingest(rms: Float) {
        windowSamples.append(rms)
        if windowSamples.count > windowCapacity {
            windowSamples.removeFirst(windowSamples.count - windowCapacity)
        }
        let now = ContinuousClock.now
        if now - lastPublish >= publishInterval {
            lastPublish = now
            let mean = windowSamples.reduce(0, +) / Float(max(1, windowSamples.count))
            // Map raw RMS (roughly 0...0.3 for speech) into 0...1 for the bar.
            level = min(1, mean * 4)
        }
    }

    private static func computeRMS(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return 0 }
        let frames = Int(buffer.frameLength)
        guard frames > 0 else { return 0 }
        let samples = channelData[0]
        var sumSquares: Float = 0
        for i in 0..<frames {
            let s = samples[i]
            sumSquares += s * s
        }
        return (sumSquares / Float(frames)).squareRoot()
    }
}
