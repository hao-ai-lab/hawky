import Foundation
import Observation

@MainActor
@Observable
final class SessionStore {
    struct SessionSummary: Identifiable, Equatable {
        let key: String
        var displayName: String
        var unreadCount: Int
        var isPinned: Bool = false
        var isArchived: Bool = false
        var lastActivity: Date? = nil
        var id: String { key }
    }

    var activeSessionKey: String = "ios:main"
    var sessions: [SessionSummary] = [
        SessionSummary(key: "ios:main", displayName: "main", unreadCount: 0)
    ]

    func setActive(_ key: String) {
        activeSessionKey = key
        if !sessions.contains(where: { $0.key == key }) {
            sessions.append(SessionSummary(key: key, displayName: Self.defaultDisplayName(for: key), unreadCount: 0))
        }
    }

    // Upsert: add when new, update in place when the key already exists.
    // Preserves isPinned/isArchived/lastActivity when the caller passes the defaults —
    // the refresh path rebuilds from server truth via replaceAll instead.
    func upsert(_ summary: SessionSummary) {
        if let idx = sessions.firstIndex(where: { $0.key == summary.key }) {
            let existing = sessions[idx]
            var merged = summary
            if !summary.isPinned { merged.isPinned = existing.isPinned }
            if !summary.isArchived { merged.isArchived = existing.isArchived }
            if summary.lastActivity == nil { merged.lastActivity = existing.lastActivity }
            sessions[idx] = merged
        } else {
            sessions.append(summary)
        }
    }

    func replaceAll(_ summaries: [SessionSummary]) {
        sessions = summaries
    }

    func remove(key: String) {
        sessions.removeAll { $0.key == key }
    }

    func setPinned(_ key: String, _ pinned: Bool) {
        if let idx = sessions.firstIndex(where: { $0.key == key }) {
            sessions[idx].isPinned = pinned
        }
    }

    func setArchived(_ key: String, _ archived: Bool) {
        if let idx = sessions.firstIndex(where: { $0.key == key }) {
            sessions[idx].isArchived = archived
        }
    }

    func setDisplayName(_ key: String, _ name: String) {
        if let idx = sessions.firstIndex(where: { $0.key == key }) {
            sessions[idx].displayName = name
        }
    }

    var activeSummary: SessionSummary? {
        sessions.first(where: { $0.key == activeSessionKey })
    }

    // Sort: pinned first, then by lastActivity desc, then displayName asc.
    static func sorted(_ input: [SessionSummary]) -> [SessionSummary] {
        input.sorted { a, b in
            if a.isPinned != b.isPinned { return a.isPinned && !b.isPinned }
            switch (a.lastActivity, b.lastActivity) {
            case let (la?, lb?) where la != lb: return la > lb
            case (.some, .none): return true
            case (.none, .some): return false
            default: break
            }
            return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
        }
    }

    // Fallback displayName: trailing segment after the last `:`.
    static func defaultDisplayName(for key: String) -> String {
        if let colon = key.lastIndex(of: ":") {
            return String(key[key.index(after: colon)...])
        }
        return key
    }
}
