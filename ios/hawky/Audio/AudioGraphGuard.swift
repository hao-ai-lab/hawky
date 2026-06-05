import Foundation

/// Runs AVAudioEngine graph mutations that can raise an *Objective-C*
/// `NSException` — `setVoiceProcessingEnabled`, `connect`, `attach`,
/// `installTap` — which a Swift `do/catch` cannot catch and which therefore
/// aborts the whole process (SIGABRT). These fire when another app already
/// holds the voice-processing mic (Google Meet / VoIP), on a format mismatch,
/// or on the Simulator. Wrapping the call turns the exception into a thrown
/// Swift error so callers can fall back (e.g. raw capture) instead of crashing.
/// (#673)
enum AudioGraphGuard {
    struct ExceptionError: Error, CustomStringConvertible {
        let description: String
    }

    /// Runs `block`, converting any Obj-C `NSException` it raises — and
    /// re-throwing any Swift error it throws — so the call site can handle both
    /// uniformly. Returns normally only when the block completed cleanly.
    static func run(_ block: () throws -> Void) throws {
        var swiftError: Error?
        do {
            try ObjCExceptionCatcher.catching {
                do { try block() } catch { swiftError = error }
            }
        } catch {
            // Obj-C NSException, bridged to NSError by the shim. Keep the
            // exception name (e.g. com.apple.coreaudio.avfaudio) alongside the
            // reason so field logs can tell a contended mic from a format
            // mismatch. (#673 review)
            let ns = error as NSError
            let name = ns.userInfo["ExceptionName"] as? String
            let reason = ns.localizedDescription
            let description = name.map { "\($0): \(reason)" } ?? reason
            throw ExceptionError(description: description)
        }
        if let swiftError { throw swiftError }
    }
}
