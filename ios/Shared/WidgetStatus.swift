import Foundation
import SwiftUI

enum SurfaceStyle {
    static let brandName = "Hawky"

    static let accent = Color(red: 0.93, green: 0.72, blue: 0.38)
    static let accentStrong = Color(red: 0.659, green: 0.329, blue: 0.0)
    static let liveConfirm = Color(red: 0.20, green: 0.78, blue: 0.35)
    static let liveConfirmOnWhite = Color(red: 0.118, green: 0.482, blue: 0.204)
    static let liveEnd = Color(red: 0.96, green: 0.26, blue: 0.21)
    static let liveMic = Color(red: 1.00, green: 0.62, blue: 0.04)
    static let liveMicOnWhite = Color(red: 0.659, green: 0.329, blue: 0.0)

    static let darkBackground = Color(red: 0.10, green: 0.095, blue: 0.085)
    static let liveActivityBackground = Color(red: 0.10, green: 0.095, blue: 0.085).opacity(0.94)
    static let widgetPanelBackground = Color(red: 0.12, green: 0.115, blue: 0.105).opacity(0.92)

    enum WidgetFont {
        static let eyebrow: Font = .caption2.weight(.bold)
        static let title: Font = .headline.weight(.semibold)
        static let status: Font = .caption.weight(.semibold)
        static let detail: Font = .caption2
        static let liveBody: Font = .subheadline.weight(.semibold)
        static let compactStatus: Font = .caption2.weight(.bold)
    }

    static func statusColor(
        liveState: WidgetStatus.LiveState,
        recordingState: WidgetStatus.RecordingState,
        audioInputEnabled: Bool = true
    ) -> Color {
        switch liveState {
        case .off:
            return recordingState == .on ? liveEnd : .secondary
        case .connecting, .paused:
            return accent
        case .on:
            return audioInputEnabled ? liveConfirm : liveMic
        case .failed:
            return liveEnd
        }
    }
}

struct WidgetStatus: Codable, Equatable, Hashable {
    static let appGroupID = "group.live.hawky"
    static let storageKey = "widget.status"

    var liveState: LiveState
    var recordingState: RecordingState
    var contextLine: String
    var detailLine: String
    var updatedAt: Date

    static let idle = WidgetStatus(
        liveState: .off,
        recordingState: .off,
        contextLine: "Ready when you are",
        detailLine: "Open Live to start",
        updatedAt: .now
    )

    enum LiveState: String, Codable, Hashable {
        case off
        case connecting
        case on
        case paused
        case failed

        var label: String {
            switch self {
            case .off: return "Live off"
            case .connecting: return "Live connecting"
            case .on: return "Live running"
            case .paused: return "Live paused"
            case .failed: return "Live failed"
            }
        }
    }

    enum RecordingState: String, Codable, Hashable {
        case off
        case on

        var label: String {
            switch self {
            case .off: return "Recording off"
            case .on: return "Recording on"
            }
        }
    }

    var primaryLabel: String {
        if liveState == .off, recordingState == .on {
            return recordingState.label
        }
        return liveState.label
    }

    var secondaryLabel: String {
        if !contextLine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return contextLine
        }
        if recordingState == .on, liveState != .off {
            return "Saving Live media"
        }
        return "Updated \(Self.shortTimeFormatter.string(from: updatedAt))"
    }

    private static let shortTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()
}

enum WidgetStatusStore {
    static func read() -> WidgetStatus {
        guard let data = defaults.data(forKey: WidgetStatus.storageKey),
              let status = try? JSONDecoder().decode(WidgetStatus.self, from: data) else {
            return .idle
        }
        return status
    }

    static func write(_ status: WidgetStatus) {
        guard let data = try? JSONEncoder().encode(status) else { return }
        defaults.set(data, forKey: WidgetStatus.storageKey)
    }

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: WidgetStatus.appGroupID) ?? .standard
    }
}
