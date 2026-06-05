import AVFoundation
import Foundation

/// Stub — not used in the recording pipeline. Recorder always uses WavFileSink.
///
/// The post-recording "Compress to M4A" action in RecordingView uses
/// AVAssetExportSession directly and does NOT go through this sink.
/// Kept to avoid Xcode project churn; open() always throws.
final class AacFileSink: AudioSink {
    func open(format: AudioFormat, url: URL) throws {
        throw AudioError.sinkFailed("AacFileSink is not used in the recording pipeline; use WavFileSink")
    }

    func write(chunk: AudioChunk) throws {
        throw AudioError.sinkFailed("AacFileSink is not used in the recording pipeline")
    }

    func close() throws {}
}
