import AVFoundation
import Foundation

// =============================================================================
// OwnerEnrollmentRecorder — thin B3 recorder that captures an owner-voice sample
// to a local WAV via LiveRecordingSink, registers it as a voiceprint audio
// artifact, and returns an OwnerEnrollmentSource for the enrollment flow.
//
// CAPTURE-DOMAIN PARITY (the whole reason this recorder is not a bespoke tap):
// live recognition scores audio captured through `MicAudioSource(voiceProcessing:
// true)` — Apple's voice-processing I/O (AEC/AGC/NS). A template enrolled from
// RAW (`.measurement`) audio is acoustically ORTHOGONAL to that domain for the
// SAME speaker (measured cosine 0.01-0.14 cross-domain vs ~0.6-0.7 in-domain),
// so the owner never matches at recognition time. Enrollment therefore captures
// through the EXACT same MicAudioSource + voice-capture session config that
// `LiveSessionStore.startParallelMicRecording` uses. See
// docs/voiceprint-architecture.md ("capture-domain mismatch").
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

    /// Live elapsed wall-clock capture time (ms), published so the UI counter can
    /// climb in real time while recording. Reset to 0 on start, advanced by a
    /// main-actor timer (never the audio thread), and frozen on stop. The View
    /// applies `voicedFraction` to render a running "voiced speech" estimate.
    private(set) var elapsedMs: Double = 0

    private let sink = LiveRecordingSink()
    private var startedAt: Date?
    private var elapsedTimer: Timer?
    /// The SAME mic source live recognition records through (voice-processing I/O
    /// on) so the enrolled template shares the recognition acoustic domain.
    private var mic: MicAudioSource?
    private var captureTask: Task<Void, Never>?

    /// Fraction of clip wall-clock time counted as VOICED speech. Mirrors the
    /// server sidecar's ~74% voiced-duration estimate so the client's guided floor
    /// tracks the server's VOICED floor.
    static let voicedFraction: Double = 0.74

    /// Outcome of a start attempt so the caller can distinguish "recording" from a
    /// denied-permission / setup failure and reset UI state accordingly.
    enum StartResult: Equatable {
        case started
        case permissionDenied
        case failed
    }

    /// Begin capturing mic audio into a local WAV through the live recognition
    /// capture path (voice-processing I/O). Configures the same voice-capture
    /// AVAudioSession live uses, then streams `MicAudioSource` chunks into the
    /// recording sink. Returns whether recording actually began.
    @discardableResult
    func start(store: LiveSessionStore) async -> StartResult {
        guard !isRecording else { return .started }
        sink.clearLastRecordingResult()

        // Match the live recognition session (mode .voiceChat) so the
        // voice-processing I/O engages the same way it does during scoring; the
        // input node also reports a valid record format afterward. Another
        // feature may have left the session in .ambient/.playback.
        do {
            try Self.activateVoiceCaptureSession()
        } catch {
            print("[OwnerEnrollmentRecorder] session activation failed: \(error)")
            return .failed
        }

        // Fail closed on permission (MicAudioSource throws .notAuthorized), and
        // fall back to a clear failure on any other engine/route error rather
        // than writing a silent WAV the ~74% voiced estimate would count as speech.
        let mic = MicAudioSource(enableVoiceProcessing: true)
        do {
            try await mic.start()
        } catch AudioError.notAuthorized {
            print("[OwnerEnrollmentRecorder] microphone permission denied")
            Self.deactivateSession()
            return .permissionDenied
        } catch {
            print("[OwnerEnrollmentRecorder] mic start failed: \(error)")
            Self.deactivateSession()
            return .failed
        }
        self.mic = mic

        // Drain mic chunks into the sink on the main actor (this type is
        // @MainActor, so the Task inherits it). The WAV opens lazily on the first
        // chunk at the tap's hardware rate — the sink needs a concrete rate.
        captureTask = Task { [weak self] in
            var sinkStarted = false
            for await chunk in mic.samples {
                guard let self else { break }
                if !sinkStarted {
                    sinkStarted = true
                    // Audio-only: hasVideo false so `source` is unused; pass a
                    // valid case (the enum has no "none").
                    self.sink.start(
                        transport: nil,
                        hasVideo: false,
                        source: .iPhone,
                        audioSampleRate: chunk.sampleRate
                    )
                }
                self.sink.ingestAudio(LiveAudioChunk(
                    data: chunk.pcm,
                    formatDescription: "pcm16/mono/\(Int(chunk.sampleRate))",
                    capturedAt: Date()
                ))
            }
        }

        startedAt = Date()
        isRecording = true
        startElapsedTimer()
        return .started
    }

    /// Result of stopping a capture: a source that can be shown IMMEDIATELY (with the
    /// locally-computed voicedMs) plus the raw artifact needed to upgrade that source
    /// to an artifact-backed one via a background `upload(...)`. `localSource` always
    /// carries the local WAV path so the UI can update the voiced count and consent
    /// gate without waiting on the network; `artifact` is nil only when the WAV could
    /// not be finalized (nothing to upload, nothing to enroll from).
    struct StopOutcome {
        let localSource: OwnerEnrollmentSource
        let artifact: LiveVoiceprintAudioArtifactReference?
    }

    /// Stop capture and finalize the WAV. Returns IMMEDIATELY (no network) with a
    /// local-path source computed from the locally-measured voiced duration, so the
    /// UI's voiced count / consent gate update the instant the user stops. The caller
    /// runs `upload(...)` in the background to upgrade the source to artifact-backed.
    /// Returns nil only when there was no active recording to stop.
    func stop() async -> StopOutcome? {
        guard isRecording else { return nil }
        isRecording = false
        stopElapsedTimer()

        // Stop the mic first so its stream finishes, THEN drain the capture task
        // so the sink has ingested every chunk before we finalize the WAV.
        if let mic {
            await mic.stop()
        }
        mic = nil
        await captureTask?.value
        captureTask = nil
        Self.deactivateSession()

        let artifact = sink.currentAudioArtifact
        let measuredMs = startedAt.map { Date().timeIntervalSince($0) * 1000 } ?? 0
        startedAt = nil
        elapsedMs = measuredMs
        await sink.stop()

        let voicedMs = measuredMs * Self.voicedFraction

        // Always hand back a local-path source so the UI can update immediately even
        // if the upload later fails. If the WAV could not be finalized there is
        // nothing to enroll from, so return a source with no path/artifact and a nil
        // artifact; the caller treats that as a failed capture.
        let localSource = OwnerEnrollmentSource(
            audioPath: artifact?.audioPath,
            route: "ios-enrollment",
            voicedMs: voicedMs
        )
        return StopOutcome(localSource: localSource, artifact: artifact)
    }

    /// Upload the finalized WAV to the gateway and register it as a voiceprint
    /// audio artifact, returning an artifact-backed source keyed by the SAME id/
    /// voicedMs as the local source it upgrades. Returns nil on any gateway failure
    /// (offline / no roots configured / register rejected) so the caller keeps the
    /// local-path fallback source it already displayed.
    ///
    /// The upload must precede registration: the WAV is written only to the phone's
    /// Documents dir; without the upload it never reaches an allowed_audio_root and
    /// audio_artifact.register fails FAILED_PRECONDITION (file not found). The
    /// upload reuses the SAME media.chunk.upload RPC the live session uses, keyed by
    /// the WAV basename so the media_id the gateway writes under is byte-identical
    /// to the mediaID we register with.
    func upload(
        artifact: LiveVoiceprintAudioArtifactReference,
        sourceID: String,
        voicedMs: Double,
        store: LiveSessionStore
    ) async -> OwnerEnrollmentSource? {
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
                    // Upgrade the SAME source (id preserved) from local-path to
                    // artifact-backed; voicedMs is carried through unchanged so the
                    // guided floor does not shift under the user.
                    return OwnerEnrollmentSource(
                        id: sourceID,
                        audioArtifactID: resolvedID,
                        route: "ios-enrollment",
                        voicedMs: voicedMs
                    )
                }
            }
        }

        // Upload/register failed: the caller keeps the local-path source it already
        // displayed. Signal that no upgrade happened.
        return nil
    }

    // MARK: - Elapsed timer (live UI counter, main-actor only)

    /// Start the 0.1s main-actor timer that publishes `elapsedMs` while recording.
    /// Runs on the main actor (never the audio thread) so it only drives UI. Tolerant
    /// to save power; stopped on `stop()`.
    private func startElapsedTimer() {
        elapsedMs = 0
        elapsedTimer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isRecording, let started = self.startedAt else { return }
                self.elapsedMs = Date().timeIntervalSince(started) * 1000
            }
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        elapsedTimer = timer
    }

    /// Invalidate the elapsed timer so it stops advancing `elapsedMs`.
    private func stopElapsedTimer() {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
    }

    // MARK: - Session

    /// Configure the shared session for voice capture, matching
    /// `LiveAudioSampleRecorder.activateSession` (mode `.voiceChat`) so that when
    /// `MicAudioSource(voiceProcessing: true)` engages Apple's voice-processing
    /// I/O it does so in the SAME configuration recognition captures under. The
    /// old `.measurement` (raw) mode is what created the enrollment↔live domain
    /// mismatch; voice-processing AGC also keeps levels off the clipping ceiling
    /// (the reason `.measurement` was adopted) without disabling the processing.
    private static func activateVoiceCaptureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
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
}
