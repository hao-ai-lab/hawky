import AVFoundation
import Foundation

/// Owns the AVAudioSession configuration for the Glasses tab (Phase A).
///
/// Phase A is audio-only: we configure `.playAndRecord` / `.voiceChat` with
/// `.allowBluetoothHFP` so iOS can route through a paired Ray-Ban Meta (or
/// any other HFP headset) when the user selects it. Pairing itself is done
/// in iOS Settings → Bluetooth; this type only activates the session.
///
/// The option set is exposed via `requiredOptions` so a unit test can lock
/// `.allowBluetoothHFP` in without booting the full session.
@MainActor
final class GlassesAudioSession {
    /// The option set we insist on for HFP-aware glasses routing.
    ///
    /// Rationale per `plan/10-glasses.md` Phase A:
    ///   .allowBluetoothHFP — non-deprecated replacement for .allowBluetooth;
    ///                        routes to HFP headsets / Ray-Ban Meta glasses.
    ///   .duckOthers        — lower competing audio while we probe / play tone.
    ///   .defaultToSpeaker  — fall back to the phone speaker when no HFP route
    ///                        is available so test tone is still audible.
    static var requiredOptions: AVAudioSession.CategoryOptions {
        [.allowBluetoothHFP, .duckOthers, .defaultToSpeaker]
    }

    private let session = AVAudioSession.sharedInstance()
    private var isActive = false

    func activate() throws {
        guard !isActive else { return }
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: Self.requiredOptions
        )
        try session.setActive(true, options: [])
        isActive = true
    }

    func deactivate() {
        guard isActive else { return }
        // Best-effort: .notifyOthersOnDeactivation lets paused music resume.
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        isActive = false
    }
}
