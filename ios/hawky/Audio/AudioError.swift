import Foundation

/// Errors surfaced by audio sources and sinks.
enum AudioError: Error {
    case notAuthorized
    case engineFailed(String)
    case sinkFailed(String)
    case formatUnsupported(AudioFormat)
}
