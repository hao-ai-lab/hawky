import Foundation

enum LiveControlCommandAction: String, Codable, Hashable {
    case openLive
    case toggleMute
    case pauseLive
    case resumeLive
    case stopLive
}

struct LiveControlCommand: Codable, Hashable {
    static let storageKey = "live.control.pendingCommand"

    var action: LiveControlCommandAction
    var createdAt: Date
}

enum LiveControlCommandStore {
    /// Cross-process Darwin notification posted the moment a control command is enqueued,
    /// so the app consumes it immediately instead of polling the App Group on a timer.
    /// Darwin notification names are a global namespace — keep this string unique.
    static let didEnqueueDarwinName = "group.live.hawky.live.control.command" as CFString

    static func enqueue(_ action: LiveControlCommandAction) {
        let command = LiveControlCommand(action: action, createdAt: .now)
        guard let data = try? JSONEncoder().encode(command) else { return }
        defaults.set(data, forKey: LiveControlCommand.storageKey)
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(didEnqueueDarwinName),
            nil,
            nil,
            true
        )
    }

    static func consumePending() -> LiveControlCommand? {
        guard let data = defaults.data(forKey: LiveControlCommand.storageKey),
              let command = try? JSONDecoder().decode(LiveControlCommand.self, from: data) else {
            return nil
        }
        defaults.removeObject(forKey: LiveControlCommand.storageKey)
        return command
    }

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: WidgetStatus.appGroupID) ?? .standard
    }
}
