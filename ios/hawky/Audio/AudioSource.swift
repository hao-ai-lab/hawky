import Foundation

/// A single buffer of PCM audio emitted by an `AudioSource`.
struct AudioChunk {
    let pcm: Data
    let timestamp: TimeInterval
    let sampleRate: Double
}

/// Produces a stream of `AudioChunk`s. Concrete implementations wrap mic, file, or test sources.
protocol AudioSource: AnyObject {
    func start() async throws
    func stop() async
    var samples: AsyncStream<AudioChunk> { get }
}
