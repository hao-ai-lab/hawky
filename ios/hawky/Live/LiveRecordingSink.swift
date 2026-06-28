import AVFoundation
import Foundation

/// Facade for recording the Live session's already-captured media. The split is
/// intentional:
/// - LocalRecordingSink writes WAV + keyframe manifest only.
/// - MediaUploadScheduler owns live/deferred gateway upload queues.
@MainActor
final class LiveRecordingSink {
    // Legacy mic-tee chunks are pcm16 mono at 24 kHz (see LiveAudioSampleRecorder).
    // The parallel-mic path (WebRTC providers that own the realtime mic) captures
    // at the tap's actual hardware rate, so the WAV rate is configurable per
    // recording rather than a fixed constant.
    nonisolated static let defaultSampleRate: Double = 24_000

    private let localSink = LocalRecordingSink()
    private let uploadScheduler = MediaUploadScheduler()
    private var active = false
    private var hasVideo = false

    var isRecording: Bool { active }
    var currentAudioOffsetMs: Double? { localSink.currentAudioOffsetMs }
    var currentAudioArtifact: LiveVoiceprintAudioArtifactReference? { localSink.currentAudioArtifact }
    var lastRecordingURL: URL? { localSink.lastRecordingURL }
    var lastDeferredUploadStarted: Bool { uploadScheduler.lastDeferredUploadStarted }

    func clearLastRecordingResult() {
        localSink.clearLastRecordingResult()
        uploadScheduler.clearLastRecordingResult()
    }

    /// Begin recording. `transport` is the gateway transport for live upload
    /// (nil = local-only). `deferredUploadTransportProvider`, when present, is
    /// resolved after stop so deferred upload uses the current gateway connection
    /// instead of a stale socket captured at session start.
    func start(
        transport: GatewayTransport?,
        deferredUploadTransport: GatewayTransport? = nil,
        deferredUploadTransportProvider: GatewayTransportResolver? = nil,
        hasVideo: Bool,
        source: RecordingManifest.VideoSource,
        audioSampleRate: Double = defaultSampleRate
    ) {
        guard !active else { return }
        let prefix = "live-\(Recorder.captureStamp(Date()))"
        self.hasVideo = hasVideo

        localSink.start(
            recordingID: prefix,
            hasVideo: hasVideo,
            source: source,
            audioSampleRate: audioSampleRate
        )
        uploadScheduler.start(
            recordingID: prefix,
            recordingURL: localSink.lastRecordingURL,
            startNs: localSink.startNs,
            manifestStore: localSink.manifestStore,
            sampleRate: audioSampleRate,
            hasVideo: hasVideo,
            liveUploadTransport: transport,
            deferredUploadTransportProvider: deferredUploadTransportProvider
                ?? Self.resolver(for: deferredUploadTransport)
        )
        active = true
    }

    /// Tee one Live mic chunk into the local WAV and optional media upload queue.
    func ingestAudio(_ chunk: LiveAudioChunk) {
        guard active else { return }
        let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        let audio = AudioChunk(
            pcm: chunk.data,
            timestamp: CFAbsoluteTimeGetCurrent(),
            sampleRate: localSink.sampleRate
        )
        localSink.ingestAudio(audio)
        uploadScheduler.ingestAudio(audio, capturedAtNs: nowNs)
    }

    /// Tee one Live visual keyframe into the local manifest and optional upload queue.
    func ingestFrame(_ frame: LiveJPEGFrame) {
        guard active, hasVideo else { return }
        let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        localSink.ingestFrame(frame, capturedAtNs: nowNs)
        uploadScheduler.ingestFrame(frame, capturedAtNs: nowNs)
    }

    /// Stop recording, finalize the WAV/manifest, and schedule any upload work.
    func stop() async {
        guard active else { return }
        active = false
        let snapshot = localSink.stop()
        await uploadScheduler.stop(snapshot: snapshot)
        hasVideo = false
    }

    private static func resolver(for transport: GatewayTransport?) -> GatewayTransportResolver? {
        guard let transport else { return nil }
        return { transport }
    }
}

@MainActor
private final class LocalRecordingSink {
    private(set) var manifestStore = RecordingManifestStore()
    private var sink: WavFileSink?
    private var recordingID = ""
    private(set) var startNs: UInt64 = 0
    private var writtenAudioFrames: Int64 = 0
    private(set) var sampleRate: Double = LiveRecordingSink.defaultSampleRate
    private var hasVideo = false

    private(set) var lastRecordingURL: URL?

    var currentAudioOffsetMs: Double? {
        guard !recordingID.isEmpty, sampleRate > 0 else { return nil }
        return Double(writtenAudioFrames) * 1_000 / sampleRate
    }

    var currentAudioArtifact: LiveVoiceprintAudioArtifactReference? {
        guard !recordingID.isEmpty, let url = lastRecordingURL else { return nil }
        let id = url.deletingPathExtension().lastPathComponent
        guard !id.isEmpty else { return nil }
        return LiveVoiceprintAudioArtifactReference(
            audioArtifactID: id,
            audioPath: url.path,
            sampleRate: sampleRate
        )
    }

    func clearLastRecordingResult() {
        lastRecordingURL = nil
    }

    func start(
        recordingID: String,
        hasVideo: Bool,
        source: RecordingManifest.VideoSource,
        audioSampleRate: Double
    ) {
        self.recordingID = recordingID
        self.startNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        self.sampleRate = audioSampleRate
        self.writtenAudioFrames = 0
        self.hasVideo = hasVideo

        let format = AudioFormat.wavMono(sampleRate: sampleRate)
        let url = Self.makeRecordingURL(base: recordingID, format: format)
        let wav = WavFileSink()
        do {
            try wav.open(format: format, url: url)
            sink = wav
            lastRecordingURL = url
        } catch {
            print("[LocalRecordingSink] WAV open failed: \(error)")
            sink = nil
        }

        if hasVideo {
            manifestStore.start(
                recordingID: recordingID,
                audioFileName: "\(recordingID).\(format.fileExtension)",
                source: source,
                startNs: startNs
            )
        }
    }

    func ingestAudio(_ audio: AudioChunk) {
        guard !recordingID.isEmpty else { return }
        let frameCount = audio.pcm.count / MemoryLayout<Int16>.size
        do {
            try sink?.write(chunk: audio)
            writtenAudioFrames += Int64(frameCount)
        } catch {
            print("[LocalRecordingSink] WAV write failed: \(error)")
        }
    }

    func ingestFrame(_ frame: LiveJPEGFrame, capturedAtNs: UInt64) {
        guard !recordingID.isEmpty, hasVideo else { return }
        manifestStore.ingestKeyframe(jpegBytes: frame.data, capturedAtNs: capturedAtNs)
    }

    func stop() -> LocalRecordingSnapshot {
        let snapshot = LocalRecordingSnapshot(
            recordingID: recordingID,
            recordingURL: lastRecordingURL,
            startNs: startNs,
            manifestStore: manifestStore,
            sampleRate: sampleRate,
            hasVideo: hasVideo
        )
        try? sink?.close()
        sink = nil
        if hasVideo {
            manifestStore.stop()
        }
        recordingID = ""
        startNs = 0
        writtenAudioFrames = 0
        hasVideo = false
        return snapshot
    }

    private static func makeRecordingURL(base: String, format: AudioFormat) -> URL {
        let dir = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(base).\(format.fileExtension)")
    }
}

@MainActor
private final class MediaUploadScheduler {
    private let uploader = Uploader()
    private let keyframeUploader = KeyframeUploader()

    private var liveUploadEnabled = false
    private var hasVideo = false
    private var deferredUploadTransportProvider: GatewayTransportResolver?
    private(set) var lastDeferredUploadStarted = false

    func clearLastRecordingResult() {
        lastDeferredUploadStarted = false
    }

    func start(
        recordingID: String,
        recordingURL: URL?,
        startNs: UInt64,
        manifestStore: RecordingManifestStore,
        sampleRate: Double,
        hasVideo: Bool,
        liveUploadTransport: GatewayTransport?,
        deferredUploadTransportProvider: GatewayTransportResolver?
    ) {
        uploader.reset()
        keyframeUploader.reset()
        self.liveUploadEnabled = liveUploadTransport != nil
        self.hasVideo = hasVideo
        self.deferredUploadTransportProvider = deferredUploadTransportProvider
        self.lastDeferredUploadStarted = false

        if let liveUploadTransport {
            uploader.start(transport: liveUploadTransport, mediaId: recordingID + ".mic")
            if hasVideo {
                keyframeUploader.start(transport: liveUploadTransport, captureId: recordingID)
            }
        }

        // The unused parameters document the local snapshot that deferred upload
        // will read after stop. Keeping them here makes start() the single place
        // where upload policy is selected, without touching the local writer.
        _ = recordingURL
        _ = startNs
        _ = manifestStore
        _ = sampleRate
    }

    func ingestAudio(_ audio: AudioChunk, capturedAtNs: UInt64) {
        guard liveUploadEnabled else { return }
        uploader.ingest(chunk: audio, capturedAtNs: capturedAtNs)
    }

    func ingestFrame(_ frame: LiveJPEGFrame, capturedAtNs: UInt64) {
        guard liveUploadEnabled, hasVideo else { return }
        keyframeUploader.ingest(jpegBytes: frame.data, capturedAtNs: capturedAtNs)
    }

    func stop(snapshot: LocalRecordingSnapshot) async {
        let shouldStopLiveUpload = liveUploadEnabled
        if shouldStopLiveUpload {
            await uploader.stop()
            if hasVideo {
                await keyframeUploader.stop()
            }
        }
        liveUploadEnabled = false
        hasVideo = false

        guard let transportProvider = deferredUploadTransportProvider,
              let recordingURL = snapshot.recordingURL else {
            deferredUploadTransportProvider = nil
            return
        }

        lastDeferredUploadStarted = true
        let uploader = DeferredLiveMediaUploader(
            transportProvider: transportProvider,
            recordingID: snapshot.recordingID,
            recordingURL: recordingURL,
            startNs: snapshot.startNs,
            manifestStore: snapshot.manifestStore,
            sampleRate: snapshot.sampleRate
        )
        Task { @MainActor in await uploader.upload() }
        deferredUploadTransportProvider = nil
    }
}

private struct LocalRecordingSnapshot {
    let recordingID: String
    let recordingURL: URL?
    let startNs: UInt64
    let manifestStore: RecordingManifestStore
    let sampleRate: Double
    let hasVideo: Bool
}

private final class DeferredLiveMediaUploader: @unchecked Sendable {
    private let transportProvider: GatewayTransportResolver
    private let recordingID: String
    private let recordingURL: URL
    private let startNs: UInt64
    private let manifestStore: RecordingManifestStore
    private let sampleRate: Double

    init(
        transportProvider: @escaping GatewayTransportResolver,
        recordingID: String,
        recordingURL: URL,
        startNs: UInt64,
        manifestStore: RecordingManifestStore,
        sampleRate: Double
    ) {
        self.transportProvider = transportProvider
        self.recordingID = recordingID
        self.recordingURL = recordingURL
        self.startNs = startNs
        self.manifestStore = manifestStore
        self.sampleRate = sampleRate
    }

    @MainActor
    func upload() async {
        guard let transport = await transportProvider() else {
            print("[DeferredLiveMediaUploader] gateway unavailable; skipped upload for \(recordingID)")
            return
        }
        guard transport.isConnected else {
            print("[DeferredLiveMediaUploader] gateway not connected; skipped upload for \(recordingID)")
            return
        }
        do {
            try await uploadAudio(transport: transport)
            try await uploadKeyframes(transport: transport)
            print("[DeferredLiveMediaUploader] upload complete for \(recordingID)")
        } catch {
            print("[DeferredLiveMediaUploader] upload failed for \(recordingID): \(error)")
        }
    }

    @MainActor
    private func uploadAudio(transport: GatewayTransport) async throws {
        let file = try AVAudioFile(forReading: recordingURL)
        let format = file.processingFormat
        let framesPerChunk = AVAudioFrameCount(max(1, Int(sampleRate * 10)))
        var seq = 0

        while file.framePosition < file.length {
            let remaining = AVAudioFrameCount(file.length - file.framePosition)
            let capacity = min(framesPerChunk, remaining)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
                throw DeferredUploadError.bufferAllocationFailed
            }
            try file.read(into: buffer, frameCount: capacity)
            let pcm = Self.pcm16Data(from: buffer)
            guard !pcm.isEmpty else { continue }
            let isFinal = file.framePosition >= file.length
            try await sendAudioChunk(transport: transport, pcm: pcm, seq: seq, final: isFinal)
            seq += 1
        }

        if seq == 0 {
            try await sendAudioChunk(transport: transport, pcm: Data(), seq: 0, final: true)
        }
    }

    @MainActor
    private func uploadKeyframes(transport: GatewayTransport) async throws {
        guard let manifest = manifestStore.load(recordingID: recordingID) else { return }
        for keyframe in manifest.keyframes {
            let url = manifestStore.keyframeURL(keyframe)
            guard let data = try? Data(contentsOf: url) else { continue }
            let capturedAtNs = startNs + UInt64(max(0, keyframe.offsetMilliseconds)) * 1_000_000
            try await sendKeyframe(transport: transport, data: data, capturedAtNs: capturedAtNs)
        }
    }

    private func sendAudioChunk(
        transport: GatewayTransport,
        pcm: Data,
        seq: Int,
        final: Bool
    ) async throws {
        let params: [String: JSONValue] = [
            "media_id": .string("\(recordingID).mic.deferred"),
            "seq": .number(Double(seq)),
            "bytes": .string(pcm.base64EncodedString()),
            "mime": .string("audio/pcm16;rate=\(Int(sampleRate))"),
            "captured_at_ns": .number(Double(startNs)),
            "final": .bool(final),
        ]
        let response = try await transport.send(RequestFrame(
            id: UUID().uuidString,
            method: "media.chunk.upload",
            params: params
        ))
        if !response.ok {
            throw DeferredUploadError.rpc(response.error?.message ?? "media.chunk.upload failed")
        }
    }

    private func sendKeyframe(
        transport: GatewayTransport,
        data: Data,
        capturedAtNs: UInt64
    ) async throws {
        let params: [String: JSONValue] = [
            "session_key": .string(recordingID),
            "media_kind": .string("frame"),
            "bytes": .string(data.base64EncodedString()),
            "mime": .string("image/jpeg"),
            "ts_captured_ns": .number(Double(capturedAtNs)),
        ]
        let response = try await transport.send(RequestFrame(
            id: UUID().uuidString,
            method: "media.chunk.upload",
            params: params
        ))
        if !response.ok {
            throw DeferredUploadError.rpc(response.error?.message ?? "media.chunk.upload frame failed")
        }
    }

    private static func pcm16Data(from buffer: AVAudioPCMBuffer) -> Data {
        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0 else { return Data() }
        let byteCount = frameLength * channelCount * MemoryLayout<Int16>.size

        if let data = buffer.int16ChannelData?[0] {
            return Data(bytes: data, count: byteCount)
        }
        if let audioBuffer = buffer.audioBufferList.pointee.mBuffers.mData {
            return Data(bytes: audioBuffer, count: min(byteCount, Int(buffer.audioBufferList.pointee.mBuffers.mDataByteSize)))
        }
        return Data()
    }
}

private enum DeferredUploadError: Error {
    case bufferAllocationFailed
    case rpc(String)
}
