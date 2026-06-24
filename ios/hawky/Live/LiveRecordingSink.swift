import AVFoundation
import Foundation

/// Persists + uploads a Live session's existing audio/video streams without
/// starting any new capture engine. The Live mic PCM (already captured for the
/// realtime provider) is teed here to a WAV file and the audio `Uploader`; Live
/// visual keyframes (already captured for the provider) are teed to the
/// `KeyframeUploader` and the `RecordingManifestStore`.
///
/// This is the "record what Live is already streaming" path (#363): one shared
/// audio/video stream, two sinks (realtime provider + this recorder). It never
/// taps `AVAudioEngine` itself, so it cannot collide with Live's audio session.
@MainActor
final class LiveRecordingSink {
    // Legacy mic-tee chunks are pcm16 mono at 24 kHz (see LiveAudioSampleRecorder).
    // The parallel-mic path (WebRTC providers that own the realtime mic) captures
    // at the tap's actual hardware rate, so the WAV rate is configurable per
    // recording rather than a fixed constant — writing a wrong rate into the WAV
    // header plays the audio back at the wrong speed.
    nonisolated static let defaultSampleRate: Double = 24_000
    private var sampleRate: Double = defaultSampleRate

    private let uploader = Uploader()
    private let keyframeUploader = KeyframeUploader()
    private let manifestStore = RecordingManifestStore()
    private var sink: WavFileSink?
    private var recordingID = ""
    private var startNs: UInt64 = 0
    private var writtenAudioFrames: Int64 = 0
    private var active = false
    private var hasVideo = false
    private var deferredUploadTransport: GatewayTransport?

    private(set) var lastRecordingURL: URL?
    private(set) var lastDeferredUploadStarted = false

    var isRecording: Bool { active }
    var currentAudioOffsetMs: Double? {
        guard active, sampleRate > 0 else { return nil }
        return Double(writtenAudioFrames) * 1_000 / sampleRate
    }

    var currentAudioArtifact: LiveVoiceprintAudioArtifactReference? {
        guard active, let url = lastRecordingURL else { return nil }
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
        lastDeferredUploadStarted = false
    }

    /// Begin recording. `transport` is the gateway transport for live upload
    /// (nil = local-only). `deferredUploadTransport`, when present, uploads the
    /// saved local media after stop instead of during the session.
    func start(
        transport: GatewayTransport?,
        deferredUploadTransport: GatewayTransport? = nil,
        hasVideo: Bool,
        source: RecordingManifest.VideoSource,
        audioSampleRate: Double = defaultSampleRate
    ) {
        guard !active else { return }
        let prefix = "live-\(Recorder.captureStamp(Date()))"
        recordingID = prefix
        startNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        self.hasVideo = hasVideo
        self.sampleRate = audioSampleRate
        self.writtenAudioFrames = 0
        self.deferredUploadTransport = deferredUploadTransport
        self.lastDeferredUploadStarted = false

        let format = AudioFormat.wavMono(sampleRate: sampleRate)
        let url = Self.makeRecordingURL(base: prefix, format: format)
        let wav = WavFileSink()
        do {
            try wav.open(format: format, url: url)
            sink = wav
            lastRecordingURL = url
        } catch {
            print("[LiveRecordingSink] WAV open failed: \(error)")
            sink = nil
        }

        uploader.start(transport: transport, mediaId: prefix + ".mic")

        if hasVideo {
            keyframeUploader.start(transport: transport, captureId: prefix)
            manifestStore.start(
                recordingID: prefix,
                audioFileName: "\(prefix).\(format.fileExtension)",
                source: source,
                startNs: startNs
            )
        }

        active = true
    }

    /// Tee one Live mic chunk (pcm16/24000/mono) into the WAV + audio uploader.
    func ingestAudio(_ chunk: LiveAudioChunk) {
        guard active else { return }
        let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        let audio = AudioChunk(
            pcm: chunk.data,
            timestamp: CFAbsoluteTimeGetCurrent(),
            sampleRate: sampleRate
        )
        let frameCount = chunk.data.count / MemoryLayout<Int16>.size
        do {
            try sink?.write(chunk: audio)
            writtenAudioFrames += Int64(frameCount)
        } catch {
            print("[LiveRecordingSink] WAV write failed: \(error)")
        }
        uploader.ingest(chunk: audio, capturedAtNs: nowNs)
    }

    /// Tee one Live visual keyframe (JPEG) into the keyframe uploader + manifest.
    func ingestFrame(_ frame: LiveJPEGFrame) {
        guard active, hasVideo else { return }
        let nowNs = UInt64(DispatchTime.now().uptimeNanoseconds)
        keyframeUploader.ingest(jpegBytes: frame.data, capturedAtNs: nowNs)
        manifestStore.ingestKeyframe(jpegBytes: frame.data, capturedAtNs: nowNs)
    }

    /// Stop recording, finalize the WAV, and drain pending uploads.
    func stop() async {
        guard active else { return }
        let finishedRecordingID = recordingID
        let finishedStartNs = startNs
        let finishedURL = lastRecordingURL
        let deferredTransport = deferredUploadTransport
        active = false
        try? sink?.close()
        sink = nil
        await uploader.stop()
        if hasVideo {
            await keyframeUploader.stop()
            manifestStore.stop()
        }
        if let deferredTransport, let finishedURL {
            lastDeferredUploadStarted = true
            let uploader = DeferredLiveMediaUploader(
                transport: deferredTransport,
                recordingID: finishedRecordingID,
                recordingURL: finishedURL,
                startNs: finishedStartNs,
                manifestStore: manifestStore,
                sampleRate: sampleRate
            )
            Task { await uploader.upload() }
        }
        deferredUploadTransport = nil
        hasVideo = false
    }

    private static func makeRecordingURL(base: String, format: AudioFormat) -> URL {
        let dir = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(base).\(format.fileExtension)")
    }
}

private final class DeferredLiveMediaUploader: @unchecked Sendable {
    private let transport: GatewayTransport
    private let recordingID: String
    private let recordingURL: URL
    private let startNs: UInt64
    private let manifestStore: RecordingManifestStore
    private let sampleRate: Double

    init(
        transport: GatewayTransport,
        recordingID: String,
        recordingURL: URL,
        startNs: UInt64,
        manifestStore: RecordingManifestStore,
        sampleRate: Double
    ) {
        self.transport = transport
        self.recordingID = recordingID
        self.recordingURL = recordingURL
        self.startNs = startNs
        self.manifestStore = manifestStore
        self.sampleRate = sampleRate
    }

    @MainActor
    func upload() async {
        guard transport.isConnected else {
            print("[DeferredLiveMediaUploader] gateway not connected; skipped upload for \(recordingID)")
            return
        }
        do {
            try await uploadAudio()
            try await uploadKeyframes()
            print("[DeferredLiveMediaUploader] upload complete for \(recordingID)")
        } catch {
            print("[DeferredLiveMediaUploader] upload failed for \(recordingID): \(error)")
        }
    }

    @MainActor
    private func uploadAudio() async throws {
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
            try await sendAudioChunk(pcm: pcm, seq: seq, final: isFinal)
            seq += 1
        }

        if seq == 0 {
            try await sendAudioChunk(pcm: Data(), seq: 0, final: true)
        }
    }

    @MainActor
    private func uploadKeyframes() async throws {
        guard let manifest = manifestStore.load(recordingID: recordingID) else { return }
        for keyframe in manifest.keyframes {
            let url = manifestStore.keyframeURL(keyframe)
            guard let data = try? Data(contentsOf: url) else { continue }
            let capturedAtNs = startNs + UInt64(max(0, keyframe.offsetMilliseconds)) * 1_000_000
            try await sendKeyframe(data: data, capturedAtNs: capturedAtNs)
        }
    }

    private func sendAudioChunk(pcm: Data, seq: Int, final: Bool) async throws {
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

    private func sendKeyframe(data: Data, capturedAtNs: UInt64) async throws {
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
