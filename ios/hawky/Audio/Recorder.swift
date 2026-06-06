import AVFoundation
import Combine
import Foundation

/// Coordinator that drives a `MicAudioSource` → `WavFileSink` pipeline and a
/// simple `AVAudioPlayer` for playback. UI-bound via `@Published` properties.
///
/// Audio session policy (this tab only):
///   - On startRecording: set category `.playAndRecord` + activate.
///   - On stopRecording / teardown: best-effort revert to `.ambient`.
/// Wrapped in `try?` so a glasses-owned session config isn't clobbered hard.
@MainActor
final class Recorder: NSObject, ObservableObject {
    enum State: Equatable { case idle, recording, playing, paused }

    @Published var state: State = .idle
    @Published var levelRMS: Float = 0
    @Published var lastRecordingURL: URL?
    @Published private(set) var audioChunkCount: UInt64 = 0
    @Published private(set) var audioByteCount: UInt64 = 0
    @Published private(set) var lastAudioChunkAt: Date?

    /// Recording always produces WAV at the raw hardware sample rate.
    /// No user-selectable format; no resampling.
    var currentFormat: AudioFormat { .wavMono(sampleRate: 48_000) }

    // Playback progress — published for the scrubber UI.
    @Published var playbackPosition: TimeInterval = 0
    @Published var playbackDuration: TimeInterval = 0

    private var source: MicAudioSource?
    private var sink: AudioSink?
    private var pumpTask: Task<Void, Never>?
    private var player: AVAudioPlayer?
    private var playbackTickTask: Task<Void, Never>?

    /// Optional second consumer of the PCM pump: streams chunks to Hawky.
    /// Lifecycle is managed by the view (start/stop around record tap). The
    /// recorder only fans out chunks if this is non-nil.
    weak var uploader: Uploader?

    /// Optional video capture — started/stopped in parallel with audio when
    /// the user has enabled video mode. Lifecycle managed by the view.
    weak var videoCapture: VideoCapture?

    /// Optional video uploader — fed fMP4 fragments via VideoCapture.onFragment.
    weak var videoUploader: VideoUploader?

    /// Shared capture ID prefix for a recording session. Set at startRecording
    /// to the same "rec-<yyyyMMdd-HHmmss>" stamp as the local .wav filename
    /// (see makeRecordingURL). Callers append ".mic" or ".cam" → final media
    /// IDs like "rec-20260422-220131.mic" trivially correlate with the
    /// on-device recording file. Must satisfy the Hawky media_id regex:
    ///   /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/
    private(set) var captureIdPrefix: String = ""

    // MARK: - Recording

    func startRecording(input: AVAudioSessionPortDescription? = nil, captureIdPrefix requestedCaptureIdPrefix: String? = nil) async throws {
        guard state == .idle else { return }

        // Compute one timestamp up-front so the local .wav filename and the
        // upload media_id share the same stamp (trivially correlate-able).
        // Format matches makeRecordingURL below AND the Hawky media_id
        // regex /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/ — ISO 8601's `:` would
        // violate that regex, so we use a compact UTC stamp.
        captureIdPrefix = requestedCaptureIdPrefix ?? "rec-\(Self.captureStamp(Date()))"

        activateSession(forRecording: true)

        // Apply preferred input *after* activation, while category is playAndRecord.
        // If the input is no longer reachable, swallow the error and fall back to
        // the OS default — the caller (UI) surfaces the warning to the user.
        if let input {
            let session = AVAudioSession.sharedInstance()
            let live = session.availableInputs?.first(where: { $0.uid == input.uid })
            if let live {
                try? session.setPreferredInput(live)
            }
        }

        let format = currentFormat
        let url = makeRecordingURL(format: format)
        // MicAudioSource captures raw hw-rate PCM16; WavFileSink writes it
        // verbatim — no resampling on device.
        let source = MicAudioSource()
        let sink: AudioSink = WavFileSink()

        do {
            try sink.open(format: format, url: url)
            try await source.start()
        } catch {
            try? sink.close()
            await source.stop()
            deactivateSession()
            throw error
        }

        self.source = source
        self.sink = sink
        self.lastRecordingURL = url
        self.state = .recording
        self.levelRMS = 0
        self.audioChunkCount = 0
        self.audioByteCount = 0
        self.lastAudioChunkAt = nil

        // Start video capture in parallel with audio if wired up.
        if let vc = videoCapture {
            let vu = videoUploader
            vc.onSegment = { [weak vu] data, _ in
                let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
                vu?.ingest(mp4Bytes: data, capturedAtNs: nowNs)
            }
            await vc.start()
        }

        // Run the PCM pump OFF the main actor. `Recorder` is @MainActor, so a
        // plain `Task {}` here inherits the main actor and runs every chunk's
        // disk write + per-sample RMS loop on the UI thread (~47×/s at 48 kHz).
        // That alone makes Record janky, and once glasses video adds per-frame
        // work on the same thread the UI (including the Stop button) stalls —
        // taps stop registering. Detached keeps the hot path off-main; we hop
        // back to the main actor only in a single batched, throttled update.
        //
        // `sink`/`source` aren't Sendable, but the pump is their SOLE user
        // until `stopRecording` tears them down after the pump exits — so the
        // access is serial and the unchecked capture is safe.
        nonisolated(unsafe) let pumpSink = sink
        nonisolated(unsafe) let pumpSource = source
        pumpTask = Task.detached(priority: .userInitiated) { [weak self] in
            let stream = pumpSource.samples
            // Batch chunks for the @MainActor hop and flush at most ~20×/s.
            // The old code did a main-actor hop PER chunk; combined with the
            // per-frame video work that flooded the main thread enough to
            // swallow button taps. Track every delivery task so stopRecording()
            // can wait for a real uploader barrier before the caller drains it.
            var deliveryTasks: [Task<Void, Never>] = []
            var pending: [(chunk: AudioChunk, ns: UInt64)] = []
            var pendingBytes: UInt64 = 0
            var lastFlushNs: UInt64 = 0
            var lastRMS: Float = 0
            for await chunk in stream {
                if Task.isCancelled { break }
                do {
                    try pumpSink.write(chunk: chunk)
                } catch {
                    print("[Recorder] sink.write failed: \(error)")
                    break
                }
                let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
                lastRMS = Self.computeRMS(pcm16LE: chunk.pcm)
                pending.append((chunk, nowNs))
                pendingBytes += UInt64(chunk.pcm.count)

                guard nowNs &- lastFlushNs >= 50_000_000 else { continue }
                lastFlushNs = nowNs
                let batch = pending
                let bytes = pendingBytes
                let rms = lastRMS
                pending = []
                pendingBytes = 0
                let delivery = Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.audioChunkCount += UInt64(batch.count)
                    self.audioByteCount += bytes
                    self.lastAudioChunkAt = Date()
                    for item in batch {
                        self.uploader?.ingest(chunk: item.chunk, capturedAtNs: item.ns)
                    }
                    self.levelRMS = rms
                }
                deliveryTasks.append(delivery)
            }
            // Flush whatever's left after the stream ends.
            if !pending.isEmpty {
                let batch = pending
                let bytes = pendingBytes
                let rms = lastRMS
                let delivery = Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.audioChunkCount += UInt64(batch.count)
                    self.audioByteCount += bytes
                    self.lastAudioChunkAt = Date()
                    for item in batch {
                        self.uploader?.ingest(chunk: item.chunk, capturedAtNs: item.ns)
                    }
                    self.levelRMS = rms
                }
                deliveryTasks.append(delivery)
            }
            for delivery in deliveryTasks {
                await delivery.value
            }
        }
    }

    func stopRecording() async {
        guard state == .recording else { return }
        // Flip UI state to idle FIRST so the Stop button is responsive
        // immediately. The awaits below yield the main actor while they form a
        // flush barrier before RecordingView drains the uploader.
        state = .idle

        let pump = pumpTask
        // Non-Sendable, but ownership transfers cleanly to the single detached
        // teardown path below (the main actor drops its refs right after).
        nonisolated(unsafe) let oldSource = source
        nonisolated(unsafe) let oldSink = sink
        pumpTask = nil
        source = nil
        sink = nil

        // `oldSource.stop()` finishes the stream, which ends the pump loop.
        // The pump awaits all queued main-actor deliveries before returning, so
        // once this completes no stale chunks can arrive after uploader.stop().
        pump?.cancel()
        await oldSource?.stop()
        _ = await pump?.value
        try? oldSink?.close()

        levelRMS = 0
        lastAudioChunkAt = nil

        deactivateSession()
        // Stop video capture after audio so the final fMP4 fragment is flushed.
        await videoCapture?.stop()
    }

    // MARK: - Playback

    func playLastRecording() throws {
        guard state == .idle, let url = lastRecordingURL else { return }

        activateSession(forRecording: false)
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            p.delegate = self
            guard p.play() else {
                deactivateSession()
                throw AudioError.engineFailed("AVAudioPlayer.play() returned false")
            }
            self.player = p
            self.playbackDuration = p.duration
            self.playbackPosition = 0
            self.state = .playing
            startPlaybackTicker()
        } catch {
            deactivateSession()
            throw error
        }
    }

    func stopPlayback() {
        guard state == .playing || state == .paused else { return }
        stopPlaybackTicker()
        player?.stop()
        player = nil
        playbackPosition = 0
        playbackDuration = 0
        state = .idle
        deactivateSession()
    }

    func pausePlayback() {
        guard state == .playing, let p = player else { return }
        p.pause()
        playbackPosition = p.currentTime
        stopPlaybackTicker()
        state = .paused
    }

    func resumePlayback() {
        guard state == .paused, let p = player else { return }
        if p.play() {
            state = .playing
            startPlaybackTicker()
        }
    }

    func seek(to seconds: TimeInterval) {
        guard let p = player else { return }
        let clamped = max(0, min(seconds, p.duration))
        p.currentTime = clamped
        playbackPosition = clamped
    }

    func skipForward(_ seconds: TimeInterval = 15) {
        guard let p = player else { return }
        seek(to: p.currentTime + seconds)
    }

    func skipBackward(_ seconds: TimeInterval = 15) {
        guard let p = player else { return }
        seek(to: p.currentTime - seconds)
    }

    private func startPlaybackTicker() {
        stopPlaybackTicker()
        playbackTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000) // 0.1s
                guard let self else { return }
                await MainActor.run {
                    if let p = self.player, self.state == .playing {
                        self.playbackPosition = p.currentTime
                    }
                }
            }
        }
    }

    private func stopPlaybackTicker() {
        playbackTickTask?.cancel()
        playbackTickTask = nil
    }

    // MARK: - Session

    private func activateSession(forRecording: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            if forRecording {
                try session.setCategory(.playAndRecord,
                                        mode: .default,
                                        options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
                // Pin preferred rate to 16 kHz for audio-only sessions.
                // When AVCaptureSession later hijacks the session to 48 kHz,
                // the drift is detected in MicAudioSource via session.sampleRate.
                try? session.setPreferredSampleRate(16_000)
            } else {
                try session.setCategory(.playback, mode: .default)
            }
            try session.setActive(true)
        } catch {
            print("[Recorder] session activate failed: \(error)")
        }
    }

    private func deactivateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.ambient, mode: .default)
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
        } catch let err as NSError {
            // 561017449 == AVAudioSessionErrorCodeIsBusy: another consumer
            // (Glasses meter, ChatClient mic, etc.) still holds the session.
            // That's fine — they'll deactivate on their own. Only log if the
            // error is something else we actually care about.
            if err.code != 561_017_449 {
                print("[Recorder] session deactivate failed: \(err)")
            }
        }
    }

    // MARK: - Helpers

    private func makeRecordingURL(format: AudioFormat) -> URL {
        let base = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        // Reuse the captureIdPrefix set in startRecording so the local file
        // name and the upload media_id share an identical stamp. Fall back
        // to a freshly-computed stamp in the unlikely case this is called
        // outside a recording flow.
        let base_name = captureIdPrefix.isEmpty
            ? "rec-\(Self.captureStamp(Date()))"
            : captureIdPrefix
        return base.appendingPathComponent("\(base_name).\(format.fileExtension)")
    }

    /// Formats a date as a compact UTC `yyyyMMdd-HHmmss` stamp. Deliberately
    /// colon-free so the produced string is safe for both filenames and the
    /// Hawky media_id regex.
    static func captureStamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: date)
    }

    /// RMS over Int16 LE samples, normalized to [0, 1].
    /// `nonisolated`: a pure transform over its argument with no actor state, so
    /// the detached PCM pump can call it off the main actor.
    nonisolated static func computeRMS(pcm16LE data: Data) -> Float {
        let count = data.count / MemoryLayout<Int16>.size
        guard count > 0 else { return 0 }
        var sumSquares: Double = 0
        data.withUnsafeBytes { raw in
            guard let p = raw.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<count {
                let s = Double(p[i]) / Double(Int16.max)
                sumSquares += s * s
            }
        }
        let rms = sqrt(sumSquares / Double(count))
        return Float(min(1.0, max(0.0, rms)))
    }

    /// Cleanup on app background — revert session so glasses phase-A isn't stepped on.
    func handleAppBackground(reason: String = "App entered background") async {
        print("[Recorder] \(reason) state=\(state)")
        if state == .recording { await stopRecording() }
        if state == .playing || state == .paused { stopPlayback() }
        // Even if we were idle, make sure the session is deactivated so
        // another tab (Glasses) can claim it with its own category cleanly.
        teardownAudioSession()
    }

    /// Force-deactivate the AVAudioSession. Idempotent; safe while idle.
    /// Called on tab-leave to prevent the next tab's engine from colliding
    /// with a half-configured session (which triggers AVAEUtility format
    /// mismatches on `installTap`).
    func teardownAudioSession() {
        deactivateSession()
    }
}

extension Recorder: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor in
            if self.state == .playing {
                self.stopPlaybackTicker()
                self.player = nil
                self.playbackPosition = 0
                self.playbackDuration = 0
                self.state = .idle
                self.deactivateSession()
            }
        }
    }
}
