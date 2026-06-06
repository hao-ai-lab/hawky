import AVFoundation
import Foundation

/// Plays a 1 kHz sine wave for ~1 second through the active AVAudioSession
/// output (the paired glasses if they own the route, otherwise the phone
/// speaker).
///
/// `play()` is idempotent: calling it while a tone is already playing is a
/// no-op. After playback finishes the engine is torn down so we don't hold
/// the audio route between presses.
@MainActor
final class TestTonePlayer {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var isPlaying = false

    func play(frequency: Double = 1000, duration: TimeInterval = 1.0) {
        guard !isPlaying else { return }
        isPlaying = true

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        self.engine = engine
        self.player = player

        let sampleRate: Double = 44_100
        guard let format = AVAudioFormat(
            standardFormatWithSampleRate: sampleRate,
            channels: 1
        ) else {
            isPlaying = false
            return
        }

        // attach/connect raise an Obj-C NSException on a format mismatch, which a
        // Swift do/catch can't catch — guard it so it fails quietly instead of
        // aborting the app. (#673)
        do {
            try AudioGraphGuard.run {
                engine.attach(player)
                engine.connect(player, to: engine.mainMixerNode, format: format)
            }
        } catch {
            isPlaying = false
            return
        }

        let frameCount = AVAudioFrameCount(sampleRate * duration)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: frameCount
        ) else {
            isPlaying = false
            return
        }
        buffer.frameLength = frameCount

        if let samples = buffer.floatChannelData?[0] {
            let twoPi = 2 * Float.pi
            let step = Float(frequency / sampleRate)
            let amplitude: Float = 0.2   // -14 dBFS, comfortable on-ear level.
            for i in 0..<Int(frameCount) {
                samples[i] = amplitude * sin(twoPi * step * Float(i))
            }
        }

        do {
            try engine.start()
        } catch {
            isPlaying = false
            return
        }

        player.scheduleBuffer(buffer, at: nil, options: []) { [weak self] in
            Task { @MainActor [weak self] in
                self?.teardown()
            }
        }
        player.play()
    }

    /// Abort any in-flight tone. Idempotent; safe to call from tab-leave.
    func stop() {
        teardown()
    }

    private func teardown() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        isPlaying = false
    }
}
