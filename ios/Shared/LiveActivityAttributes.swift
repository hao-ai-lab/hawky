import ActivityKit
import Foundation

struct LiveActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var liveState: WidgetStatus.LiveState
        var recordingState: WidgetStatus.RecordingState
        var audioInputEnabled: Bool
        var contextLine: String
        var detailLine: String
        var startedAt: Date
        var updatedAt: Date

        var primaryLabel: String {
            if liveState == .off, recordingState == .on {
                return "Recording on"
            }
            return liveState.label
        }

        var secondaryLabel: String {
            if liveState == .paused {
                return "Paused"
            }
            if liveState == .off, recordingState == .on {
                return "Saving media"
            }
            return audioInputEnabled ? "Mic on" : "Mic muted"
        }

        var contextSummary: String {
            let trimmed = contextLine.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "Ready when you are" : trimmed
        }
    }

    var sessionTitle: String
}
