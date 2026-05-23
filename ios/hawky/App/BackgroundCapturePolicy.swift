import Foundation

enum BackgroundCapturePolicy: String, CaseIterable, Identifiable {
    case off
    case audioOnly = "audio_only"

    static let storageKey = "recording.backgroundCapturePolicy"
    static let defaultPolicy: BackgroundCapturePolicy = .off

    init(storedValue: String) {
        self = BackgroundCapturePolicy(rawValue: storedValue) ?? Self.defaultPolicy
    }

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off:
            return "Off"
        case .audioOnly:
            return "Keep audio"
        }
    }

    var settingsDescription: String {
        switch self {
        case .off:
            return "When you leave the app, stop the recording session and any active video capture."
        case .audioOnly:
            return "When you leave the app, keep the microphone recording if iOS permits it, but stop camera or Ray-Ban video capture."
        }
    }

    var recordingDescription: String {
        switch self {
        case .off:
            return "If the app leaves the foreground, recording and video capture stop."
        case .audioOnly:
            return "If the app leaves the foreground, the microphone can keep recording when iOS allows it, but video stops."
        }
    }

    var allowsBackgroundAudio: Bool {
        self == .audioOnly
    }
}
