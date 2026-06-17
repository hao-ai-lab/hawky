import Foundation

enum SettingsRoute: String, CaseIterable, Hashable, Identifiable {
    case connection
    case agent
    case live
    case prompt
    case appearance
    case notifications
    case notificationSessions
    case layout
    case about

    var id: String { rawValue }

    init?(segment: String?) {
        guard let raw = segment?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !raw.isEmpty else {
            return nil
        }
        switch raw {
        case "connection", "gateway":
            self = .connection
        case "agent":
            self = .agent
        case "live", "realtime":
            self = .live
        case "prompt", "prompts":
            self = .prompt
        case "appearance":
            self = .appearance
        case "notifications", "ntfy":
            self = .notifications
        case "notification-sessions", "notification_sessions", "notify-sessions", "notify_sessions", "sessions-to-notify":
            self = .notificationSessions
        case "layout", "app-layout", "app_layout", "tabs":
            self = .layout
        case "about":
            self = .about
        default:
            return nil
        }
    }

    var navigationPath: [SettingsRoute] {
        switch self {
        case .notificationSessions:
            return [.notifications, .notificationSessions]
        default:
            return [self]
        }
    }
}

enum LiveRoute: String, Hashable, Identifiable {
    case root
    case more
    case settings
    case status
    case glasses
    case recordings
    case sessions
    case summary

    var id: String { rawValue }

    init?(segment: String?) {
        guard let raw = segment?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !raw.isEmpty else {
            self = .root
            return
        }
        switch raw {
        case "root", "home":
            self = .root
        case "more":
            self = .more
        case "settings", "setting":
            self = .settings
        case "status", "session-status", "session_status":
            self = .status
        case "glasses", "ray-ban", "rayban", "meta":
            self = .glasses
        case "recordings", "recording":
            self = .recordings
        case "sessions", "history":
            self = .sessions
        case "summary", "summaries":
            self = .summary
        default:
            return nil
        }
    }
}

enum AppDeepLink: Equatable {
    case live(LiveRoute)
    case tab(AppTab)
    case chat(sessionKey: String?)
    case settings(SettingsRoute?)

    init?(url: URL) {
        guard url.scheme?.lowercased() == "hawky" else { return nil }

        let host = url.host?.lowercased()
        let segments = url.pathComponents
            .filter { $0 != "/" }
            .map { $0.removingPercentEncoding ?? $0 }

        switch host {
        case "tab":
            guard let tab = segments.first.flatMap(AppTab.frontendValue) else { return nil }
            self = .tab(tab)
        case "settings", "setting":
            self = .settings(SettingsRoute(segment: segments.first))
        case "chat", "messages", "message":
            self = .chat(sessionKey: segments.first)
        case "recordings", "recording":
            self = .live(.recordings)
        case "live":
            guard let route = LiveRoute(segment: segments.first) else { return nil }
            self = .live(route)
        case "live2", "live-2":
            self = .tab(.live2)
        case "pipecat", "pipe-cat", "pipe_cat":
            self = .tab(.pipecat)
        case "pipecat-recording", "pipecat-record", "pipecat_recording", "pipecat2":
            self = .tab(.pipecatRecording)
        case "gptrdemo", "gptr", "transcription":
            self = .tab(.gptrDemo)
        case "probes", "test":
            self = .tab(.test)
        case nil:
            guard let first = segments.first else { return nil }
            if first == "settings" {
                self = .settings(SettingsRoute(segment: segments.dropFirst().first))
            } else if first == "recordings" {
                self = .live(.recordings)
            } else if first == "live" {
                guard let route = LiveRoute(segment: segments.dropFirst().first) else { return nil }
                self = .live(route)
            } else if first == "chat" {
                self = .chat(sessionKey: segments.dropFirst().first)
            } else if let tab = AppTab.frontendValue(first) {
                self = .tab(tab)
            } else {
                return nil
            }
        default:
            if let host, let tab = AppTab.frontendValue(host) {
                self = .tab(tab)
            } else {
                return nil
            }
        }
    }
}
