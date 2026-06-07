import Foundation

// =============================================================================
// Memory feature (#653) — iOS-side models for the four-tier memory system.
//
// Parsed from the gateway memory.snapshot / memory.distill RPC payloads. The
// four tiers map onto workspace files:
//   soul     -> SOUL.md
//   identity -> IDENTITY.md
//   global   -> MEMORY.md
//   daily    -> memory/YYYY-MM-DD.md
// =============================================================================

/// One day's distilled memory (a daily log).
struct LiveMemoryDailyEntry: Equatable, Identifiable {
    /// "YYYY-MM-DD" — also the stable identity for SwiftUI lists.
    let date: String
    let content: String
    var id: String { date }
}

/// The four-tier memory snapshot for the current user/workspace.
struct LiveMemorySnapshot: Equatable {
    var soul: String
    var identity: String
    var global: String
    var daily: [LiveMemoryDailyEntry]

    init(soul: String = "", identity: String = "", global: String = "", daily: [LiveMemoryDailyEntry] = []) {
        self.soul = soul
        self.identity = identity
        self.global = global
        self.daily = daily
    }

    /// Parse from the `snapshot` object of a memory.snapshot payload.
    init(object: [String: JSONValue]) {
        func str(_ key: String) -> String {
            if case let .string(s)? = object[key] { return s } else { return "" }
        }
        self.soul = str("soul")
        self.identity = str("identity")
        self.global = str("global")
        if case let .array(arr)? = object["daily"] {
            self.daily = arr.compactMap { entry in
                guard case let .object(obj) = entry,
                      case let .string(date)? = obj["date"] else { return nil }
                let content: String
                if case let .string(c)? = obj["content"] { content = c } else { content = "" }
                return LiveMemoryDailyEntry(date: date, content: content)
            }
        } else {
            self.daily = []
        }
    }
}

/// Result of a memory.distill RPC. `ok` may be false (with a `note`) even when
/// the RPC itself succeeded — e.g. no transcript to distill.
struct LiveMemoryDistillResult: Equatable {
    var ok: Bool
    var scope: String
    var file: String
    var preview: String
    var mocked: Bool
    var note: String?

    /// Parse from the payload-root object of a memory.distill response.
    init(object: [String: JSONValue]) {
        func str(_ key: String) -> String {
            if case let .string(s)? = object[key] { return s } else { return "" }
        }
        if case let .bool(b)? = object["ok"] { self.ok = b } else { self.ok = false }
        self.scope = str("scope")
        self.file = str("file")
        self.preview = str("preview")
        if case let .bool(m)? = object["mocked"] { self.mocked = m } else { self.mocked = false }
        if case let .string(n)? = object["note"], !n.isEmpty { self.note = n } else { self.note = nil }
    }
}
