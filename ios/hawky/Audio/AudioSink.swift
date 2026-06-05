import Foundation

/// Consumes `AudioChunk`s and writes them to a destination (file, network, etc).
protocol AudioSink: AnyObject {
    func open(format: AudioFormat, url: URL) throws
    func write(chunk: AudioChunk) throws
    func close() throws
}
