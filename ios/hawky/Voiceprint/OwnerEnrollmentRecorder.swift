import AVFoundation
import Foundation

// =============================================================================
// OwnerEnrollmentRecorder — thin B3 recorder that captures an owner-voice sample
// to a local WAV via LiveRecordingSink, registers it as a voiceprint audio
// artifact, and returns an OwnerEnrollmentSource for the enrollment flow.
//
// Real mic capture is device-only; this exists so OwnerEnrollmentView has a
// concrete recorder. The testable enrollment LOGIC lives in OwnerEnrollmentModel
// and does not depend on this type — tests feed OwnerEnrollmentSource values
// directly, so this recorder is not exercised in the simulator test suite.
// =============================================================================

@MainActor
@Observable
final class OwnerEnrollmentRecorder {
    private(set) var isRecording = false

    private let sink = LiveRecordingSink()
    private var startedAt: Date?
    private let engine = AVAudioEngine()
    private var tapInstalled = false

    /// Fraction of clip wall-clock time counted as VOICED speech. Mirrors the
    /// server sidecar's ~74% voiced-duration estimate so the client's guided floor
    /// tracks the server's VOICED floor.
    static let voicedFraction: Double = 0.74

    /// Frames per input tap buffer (a common AVAudioEngine tap size, ~256 ms at
    /// 16 kHz). The callback re-chunks whatever length it receives, so this only
    /// trades callback frequency against buffer size.
    private static let tapBufferFrames: AVAudioFrameCount = 4_096

    /// Outcome of a start attempt so the caller can distinguish "recording" from a
    /// denied-permission / setup failure and reset UI state accordingly.
    enum StartResult: Equatable {
        case started
        case permissionDenied
        case failed
    }

    /// Begin capturing mic audio into a local WAV. Requests microphone permission and
    /// configures/activates a record-capable AVAudioSession before touching the engine,
    /// mirroring the app's other mic paths. Returns whether recording actually began.
    @discardableResult
    func start(store: LiveSessionStore) async -> StartResult {
        guard !isRecording else { return .started }
        sink.clearLastRecordingResult()

        // Fail closed: never capture (and never write a silent WAV that the ~74%
        // voiced estimate would count as speech) without an explicit mic grant.
        guard await Self.requestMicPermission() else {
            print("[OwnerEnrollmentRecorder] microphone permission denied")
            return .permissionDenied
        }

        // Put the shared session into a record category before reading the input
        // format; another feature may have left it in .ambient/.playback, which makes
        // the input node report a 0 Hz format and crashes installTap.
        do {
            try Self.activateRecordSession()
        } catch {
            print("[OwnerEnrollmentRecorder] session activation failed: \(error)")
            return .failed
        }

        let input = engine.inputNode
        guard let tapFormat = Self.resolveTapFormat(for: input) else {
            print("[OwnerEnrollmentRecorder] no valid input format available")
            Self.deactivateSession()
            return .failed
        }
        let sampleRate = tapFormat.sampleRate

        // Audio-only: hasVideo is false so `source` is unused by the sink; pass a
        // valid case (the enum has no "none").
        sink.start(
            transport: nil,
            hasVideo: false,
            source: .iPhone,
            audioSampleRate: sampleRate
        )

        installTapIfNeeded(on: input, format: tapFormat)

        do {
            engine.prepare()
            try engine.start()
            startedAt = Date()
            isRecording = true
            return .started
        } catch {
            print("[OwnerEnrollmentRecorder] engine start failed: \(error)")
            if tapInstalled {
                input.removeTap(onBus: 0)
                tapInstalled = false
            }
            await sink.stop()
            Self.deactivateSession()
            isRecording = false
            return .failed
        }
    }

    /// Stop capture, finalize the WAV, register it as a voiceprint audio artifact,
    /// and return the resulting source. Returns nil on any failure.
    func stop(store: LiveSessionStore) async -> OwnerEnrollmentSource? {
        guard isRecording else { return nil }
        isRecording = false
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine.stop()
        Self.deactivateSession()

        let artifact = sink.currentAudioArtifact
        let elapsedMs = startedAt.map { Date().timeIntervalSince($0) * 1000 } ?? 0
        startedAt = nil
        await sink.stop()

        guard let artifact else { return nil }
        let voicedMs = elapsedMs * Self.voicedFraction

        return await finalizeSource(artifact: artifact, voicedMs: voicedMs, store: store)
    }

    /// Upload the finalized WAV to the gateway and register it as a voiceprint
    /// audio artifact, returning the resulting source. On any gateway failure
    /// (offline / no roots configured) falls back to the local audio path so a
    /// device with an accessible recording dir can still enroll from the file.
    ///
    /// The upload must precede registration: the WAV is written only to the phone's
    /// Documents dir; without the upload it never reaches an allowed_audio_root and
    /// audio_artifact.register fails FAILED_PRECONDITION (file not found). The
    /// upload reuses the SAME media.chunk.upload RPC the live session uses, keyed by
    /// the WAV basename so the media_id the gateway writes under is byte-identical
    /// to the mediaID we register with.
    private func finalizeSource(
        artifact: LiveVoiceprintAudioArtifactReference,
        voicedMs: Double,
        store: LiveSessionStore
    ) async -> OwnerEnrollmentSource {
        if let (gateway, sessionKey) = store.voiceprintEnrollmentGateway() {
            let uploaded = await gateway.uploadVoiceprintEnrollmentAudio(
                sessionKey: sessionKey,
                mediaID: artifact.audioArtifactID,
                wavPath: artifact.audioPath,
                timeoutSeconds: 30
            )
            if uploaded {
                let registration = await gateway.registerVoiceprintAudioArtifact(
                    sessionKey: sessionKey,
                    audioArtifactID: artifact.audioArtifactID,
                    mediaID: artifact.audioArtifactID,
                    sampleRate: artifact.sampleRate,
                    route: "ios-enrollment",
                    timeoutSeconds: 15
                )
                let resolvedID = registration?.audioArtifactID ?? artifact.audioArtifactID
                if registration?.ok == true {
                    return OwnerEnrollmentSource(
                        audioArtifactID: resolvedID,
                        route: "ios-enrollment",
                        voicedMs: voicedMs
                    )
                }
            }
        }

        return OwnerEnrollmentSource(
            audioPath: artifact.audioPath,
            route: "ios-enrollment",
            voicedMs: voicedMs
        )
    }

    // MARK: - Tap format / install

    /// Resolve a tap format for the input node. installTap raises an uncatchable
    /// NSException on a 0 Hz / 0-channel format, so validate the node's format and
    /// fall back to a known-good format if it has not yet settled on a valid record
    /// format. Returns nil only if even the fallback format cannot be built.
    private static func resolveTapFormat(for input: AVAudioInputNode) -> AVAudioFormat? {
        let inputFormat = input.outputFormat(forBus: 0)
        if inputFormat.sampleRate > 0, inputFormat.channelCount > 0 {
            return inputFormat
        }
        return AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: LiveRecordingSink.defaultSampleRate,
            channels: 1,
            interleaved: false
        )
    }

    /// Install the mic tap once, re-chunking each buffer to pcm16 and forwarding it
    /// to the sink on the main actor. No-op if a tap is already installed.
    private func installTapIfNeeded(on input: AVAudioInputNode, format tapFormat: AVAudioFormat) {
        guard !tapInstalled else { return }
        input.installTap(onBus: 0, bufferSize: Self.tapBufferFrames, format: tapFormat) { [weak self] buffer, _ in
            guard let self else { return }
            let chunk = Self.pcm16Chunk(from: buffer)
            guard !chunk.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.sink.ingestAudio(LiveAudioChunk(
                    data: chunk,
                    formatDescription: "pcm16",
                    capturedAt: Date()
                ))
            }
        }
        tapInstalled = true
    }

    // MARK: - Permission / session

    /// Request (or read the already-resolved) microphone permission. Mirrors
    /// MicAudioSource.requestMicPermission so enrollment shows the standard prompt.
    private static func requestMicPermission() async -> Bool {
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

    /// Put the shared session into a record-capable category and activate it, so the
    /// input node reports a valid record format.
    private static func activateRecordSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try session.setActive(true)
    }

    /// Restore a passive category and release the session. Ignores the benign
    /// "session already inactive" error (561017449) other paths also swallow.
    private static func deactivateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.ambient, mode: .default)
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
        } catch let error as NSError {
            if error.code != 561_017_449 {
                print("[OwnerEnrollmentRecorder] session deactivate failed: \(error)")
            }
        }
    }

    private static func pcm16Chunk(from buffer: AVAudioPCMBuffer) -> Data {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return Data() }
        if let int16 = buffer.int16ChannelData {
            return Data(bytes: int16[0], count: frameLength * MemoryLayout<Int16>.size)
        }
        guard let floatData = buffer.floatChannelData else { return Data() }
        var pcm = [Int16](repeating: 0, count: frameLength)
        let channel = floatData[0]
        for i in 0..<frameLength {
            let clamped = max(-1, min(1, channel[i]))
            pcm[i] = Int16(clamped * Float(Int16.max))
        }
        return pcm.withUnsafeBytes { Data($0) }
    }
}
