import AVFoundation
import Foundation

/// `AudioSink` that writes mono PCM16 little-endian WAV files via `AVAudioFile`.
/// `AVAudioFile` handles the RIFF/WAVE header; we just feed `AVAudioPCMBuffer`s.
final class WavFileSink: AudioSink {
    private var file: AVAudioFile?
    private var processingFormat: AVAudioFormat?

    func open(format: AudioFormat, url: URL) throws {
        // Try creating parent dir if missing.
        let parent = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

        // On-disk: linear PCM, 16-bit signed, little-endian, mono at the hardware rate.
        // format.sampleRate is whatever the live tap delivers (MicAudioSource reads
        // buffer.format.sampleRate and propagates it via AudioChunk.sampleRate → Recorder
        // passes it as format). No resampling occurs on device.
        let sampleRate = format.sampleRate
        let channelCount = format.channelCount

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]

        // Tell AVAudioFile our feed buffers are Int16 interleaved at the same rate —
        // it will match on-disk and skip a conversion pass.
        guard let procFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: channelCount,
            interleaved: true
        ) else {
            throw AudioError.sinkFailed("build processingFormat")
        }

        do {
            self.file = try AVAudioFile(
                forWriting: url,
                settings: settings,
                commonFormat: .pcmFormatInt16,
                interleaved: true
            )
            self.processingFormat = procFormat
        } catch {
            throw AudioError.sinkFailed("AVAudioFile open: \(error.localizedDescription)")
        }
    }

    func write(chunk: AudioChunk) throws {
        guard let file, let procFormat = processingFormat else {
            throw AudioError.sinkFailed("write before open")
        }

        let bytesPerFrame = MemoryLayout<Int16>.size * Int(procFormat.channelCount)
        let frameCount = chunk.pcm.count / bytesPerFrame
        guard frameCount > 0 else { return }

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: procFormat,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else {
            throw AudioError.sinkFailed("PCM buffer alloc")
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)

        chunk.pcm.withUnsafeBytes { raw in
            guard let src = raw.baseAddress,
                  let dst = buffer.int16ChannelData?[0] else { return }
            // iOS is little-endian — raw Data bytes match Int16 layout directly.
            memcpy(dst, src, frameCount * bytesPerFrame)
        }

        do {
            try file.write(from: buffer)
        } catch {
            throw AudioError.sinkFailed("file.write: \(error.localizedDescription)")
        }
    }

    func close() throws {
        // AVAudioFile finalizes its WAV header on dealloc — drop the ref.
        file = nil
        processingFormat = nil
    }
}
