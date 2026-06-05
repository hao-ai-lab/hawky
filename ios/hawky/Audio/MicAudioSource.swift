import AVFoundation
import Foundation

/// Mic-backed `AudioSource` that taps `AVAudioEngine.inputNode`, converts the
/// hardware buffer to mono PCM16 (bit-format only, NO sample-rate conversion),
/// and yields chunks on `samples`. The chunk's `sampleRate` reflects whatever
/// rate the hardware tap delivers (typically 48 kHz when video is active,
/// 16 kHz otherwise). Callers must not assume a fixed rate.
///
/// Crash-safety notes (AVAEUtility format-mismatch at installTap):
///  - The input node's native format changes when the AVAudioSession category
///    changes (e.g. tab switch toggles `.playAndRecord` ↔ `.ambient`). Never
///    cache a format across `start()` calls — always query it fresh AFTER the
///    session is active.
///  - We allocate a fresh `AVAudioEngine` per `start()` and fully tear it down
///    in `stop()` so no internal state leaks between tab switches.
///  - `stop()` is idempotent and safe to call from any state.
final class MicAudioSource: AudioSource {
    private var engine: AVAudioEngine?
    private var continuation: AsyncStream<AudioChunk>.Continuation?
    private var hasSeenFirstBuffer = false

    /// When true, enable Apple's voice-processing I/O on the engine, which runs
    /// hardware acoustic echo cancellation (AEC) using the audio session's
    /// render (playback) as the far-end reference. This is what keeps the
    /// Realtime model's loudspeaker reply from looping back into the mic during
    /// hands-free Live. Off by default so plain recording captures raw audio.
    private let enableVoiceProcessing: Bool

    /// Set after a successful start() so callers can report whether hardware AEC
    /// actually engaged (the API can throw on some routes / simulators).
    private(set) var voiceProcessingActive = false

    let samples: AsyncStream<AudioChunk>

    /// `sampleRate` is accepted for API compatibility but ignored — the actual
    /// rate is taken from the live tap buffer, not a pre-configured target.
    init(sampleRate: Double = 48_000, enableVoiceProcessing: Bool = false) {
        self.enableVoiceProcessing = enableVoiceProcessing
        var cont: AsyncStream<AudioChunk>.Continuation!
        self.samples = AsyncStream { cont = $0 }
        self.continuation = cont
    }

    func start() async throws {
        // Permission check — must be granted before installing the tap.
        let granted = await requestMicPermission()
        guard granted else { throw AudioError.notAuthorized }

        // Fresh engine per start; previous one (if any) is torn down by stop().
        let engine = AVAudioEngine()
        self.engine = engine

        let input = engine.inputNode

        // Engage hardware AEC before touching the graph. setVoiceProcessingEnabled
        // must be called before the engine starts and reconfigures the node's
        // I/O format, so do it first; our tap uses format: nil and adapts.
        // Referencing engine.mainMixerNode here also forces the output chain to
        // exist so the voice-processing unit has a render side to reference.
        voiceProcessingActive = false
        if enableVoiceProcessing {
            // setVoiceProcessingEnabled raises an *Obj-C NSException* (not a Swift
            // error) when another app already holds the voice-processing mic
            // (Google Meet / VoIP) or on the Simulator — which a plain do/catch
            // can't catch, aborting the process (SIGABRT). AudioGraphGuard converts
            // it to a thrown error so we fall back to raw capture (no AEC) instead
            // of crashing. (#673)
            do {
                _ = engine.mainMixerNode
                try AudioGraphGuard.run {
                    try input.setVoiceProcessingEnabled(true)
                }
                voiceProcessingActive = true
            } catch {
                voiceProcessingActive = false
            }
        }

        // Defensive: if a stale tap was left on the shared input node by a
        // crashed prior run, remove it before installing ours. Safe no-op
        // when no tap is installed.
        input.removeTap(onBus: 0)

        // Pass format: nil so the input node uses its own current format at
        // install time. Passing a cached format is racy: if the AVAudioSession
        // category changed (tab switch) the hw rate shifts and installTap
        // throws "Failed to create tap due to format mismatch".
        // The converter is built lazily in handleTap using buffer.format —
        // which is always the node's live format at callback time.
        hasSeenFirstBuffer = false
        // installTap can raise an Obj-C NSException ("Failed to create tap due to
        // format mismatch") if the hw format shifted out from under us — guard it
        // so a mismatch fails the start recoverably instead of aborting. (#673)
        do {
            try AudioGraphGuard.run {
                input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
                    self?.handleTap(buffer: buffer)
                }
            }
        } catch {
            self.engine = nil
            throw AudioError.engineFailed("installTap: \(error.localizedDescription)")
        }

        // prepare()/start() can ALSO raise an Obj-C NSException (e.g. the
        // voice-processing I/O unit failing to start when another app holds the
        // mic) — not just a Swift error — so guard them too, else that exception
        // aborts the process. (#673)
        do {
            try AudioGraphGuard.run {
                engine.prepare()
                try engine.start()
            }
        } catch {
            input.removeTap(onBus: 0)
            self.engine = nil
            throw AudioError.engineFailed("engine.start(): \(error.localizedDescription)")
        }

        // Warmup: await the first non-empty buffer (or time out) so callers
        // don't flip UI state to "recording" before audio is actually flowing.
        await awaitFirstBuffer(timeoutMs: 300)
    }

    func stop() async {
        // Idempotent. Safe to call from any state, including partially-started.
        if let engine = self.engine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
        self.engine = nil
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Conversion

    /// Convert the tap buffer to mono PCM16 at the buffer's native sample rate.
    /// No resampling — the hw rate is preserved and written into the WAV header.
    private func handleTap(buffer: AVAudioPCMBuffer) {
        guard let continuation = self.continuation else { return }
        let hwRate = buffer.format.sampleRate

        // Build a PCM16 mono format at the same sample rate as the tap.
        guard let int16Format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: hwRate,
            channels: 1,
            interleaved: true
        ) else { return }

        // If the tap already delivers PCM16 mono interleaved, read it directly.
        // Otherwise use AVAudioConverter for bit-format conversion only (same rate).
        let int16Data: Data?
        if buffer.format == int16Format, let ptr = buffer.int16ChannelData?[0] {
            let byteCount = Int(buffer.frameLength) * MemoryLayout<Int16>.size
            int16Data = Data(bytes: ptr, count: byteCount)
        } else {
            guard let converter = AVAudioConverter(from: buffer.format, to: int16Format),
                  let outBuffer = AVAudioPCMBuffer(
                      pcmFormat: int16Format,
                      frameCapacity: buffer.frameLength
                  ) else { return }
            var fed = false
            var convError: NSError?
            let status = converter.convert(to: outBuffer, error: &convError) { _, inputStatus in
                if fed { inputStatus.pointee = .noDataNow; return nil }
                fed = true
                inputStatus.pointee = .haveData
                return buffer
            }
            guard status != .error, convError == nil, outBuffer.frameLength > 0,
                  let ptr = outBuffer.int16ChannelData?[0] else { return }
            let byteCount = Int(outBuffer.frameLength) * MemoryLayout<Int16>.size
            int16Data = Data(bytes: ptr, count: byteCount)
        }

        guard let pcmData = int16Data, !pcmData.isEmpty else { return }

        let chunk = AudioChunk(
            pcm: pcmData,
            timestamp: CACurrentMediaTime(),
            sampleRate: hwRate
        )
        hasSeenFirstBuffer = true
        continuation.yield(chunk)
    }

    // MARK: - Warmup

    /// Wait for the first tap buffer to arrive, or give up after `timeoutMs`.
    private func awaitFirstBuffer(timeoutMs: Int) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        while !hasSeenFirstBuffer && Date() < deadline {
            try? await Task.sleep(nanoseconds: 10_000_000) // 10 ms
        }
    }

    // MARK: - Permission

    private func requestMicPermission() async -> Bool {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return true
            case .denied:  return false
            case .undetermined:
                return await AVAudioApplication.requestRecordPermission()
            @unknown default:
                return false
            }
        } else {
            let session = AVAudioSession.sharedInstance()
            switch session.recordPermission {
            case .granted: return true
            case .denied:  return false
            case .undetermined:
                return await withCheckedContinuation { cont in
                    session.requestRecordPermission { cont.resume(returning: $0) }
                }
            @unknown default:
                return false
            }
        }
    }
}
