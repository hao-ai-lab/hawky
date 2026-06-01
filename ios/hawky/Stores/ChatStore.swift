import Foundation
import Observation

@MainActor
@Observable
final class ChatStore {
    enum Role: Equatable {
        case user
        case assistant
        case system

        var screenshotLabel: String {
            switch self {
            case .user: return "user"
            case .assistant: return "assistant"
            case .system: return "system"
            }
        }
    }

    struct Message: Identifiable, Equatable {
        let id: UUID
        let role: Role
        var text: String
        var isStreaming: Bool
        let timestamp: Date
    }

    var messages: [Message] = []

    // Pagination cursor for session.history. `oldestIndex` is the absolute server-side
    // index of the oldest message currently loaded in `messages` (nil when empty/unknown).
    // `hasMoreHistory` tells the UI whether older messages exist on the server beyond
    // what we've loaded — set from session.history's `hasMore` field.
    // Cleared by reset() / replaceAll(); updated by replaceAllWithCursor / prependOlder.
    var oldestIndex: Int? = nil
    // Absolute server-side index of the newest message currently loaded. Nil when
    // empty or when the server response didn't carry indices. Used by the
    // foreground-refresh path to append only messages the client hasn't seen yet
    // without touching a streaming tail.
    var newestIndex: Int? = nil
    var hasMoreHistory: Bool = false
    var isLoadingOlder: Bool = false

    // True while an assistant turn is mid-stream — refreshHead must not clobber
    // or reorder messages while this is set.
    var isStreamingActive: Bool {
        messages.last?.isStreaming == true
    }

    @discardableResult
    func appendUser(_ text: String) -> UUID {
        let msg = Message(id: UUID(), role: .user, text: text, isStreaming: false, timestamp: Date())
        messages.append(msg)
        return msg.id
    }

    @discardableResult
    func beginAssistantTurn() -> UUID {
        let msg = Message(id: UUID(), role: .assistant, text: "", isStreaming: true, timestamp: Date())
        messages.append(msg)
        return msg.id
    }

    // Unknown id is a no-op — delta frames may arrive after reset() or for turns
    // the UI abandoned; crashing here would surface transport races as user-visible bugs.
    func appendDelta(_ text: String, to id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].text.append(text)
    }

    func replaceAssistantText(_ text: String, id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].text = text
    }

    func finalizeAssistant(id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].isStreaming = false
    }

    func appendSystem(_ text: String) {
        messages.append(Message(id: UUID(), role: .system, text: text, isStreaming: false, timestamp: Date()))
    }

    func appendError(_ text: String) {
        appendSystem("Error: \(text)")
    }

    func reset() {
        messages.removeAll()
        oldestIndex = nil
        newestIndex = nil
        hasMoreHistory = false
        isLoadingOlder = false
    }

    // Idempotent replace: clear existing and set new. Used by the Tweak-tab
    // "Reload session.history" probe to overlay server-side history onto the UI.
    func replaceAll(_ newMessages: [Message]) {
        messages = newMessages
        oldestIndex = nil
        newestIndex = nil
        hasMoreHistory = false
        isLoadingOlder = false
    }

    // Replace messages AND set pagination cursor atomically.
    // `oldest` = absolute server index of the first element in `newMessages` (nil if empty).
    // `hasMore` = whether older messages still exist on the server.
    func replaceAllWithCursor(_ newMessages: [Message], oldest: Int?, hasMore: Bool, newest: Int? = nil) {
        messages = newMessages
        oldestIndex = oldest
        newestIndex = newest
        hasMoreHistory = hasMore
        isLoadingOlder = false
    }

    // Append messages from a fresh session.history head fetch that the client
    // has not seen yet. Filters by absolute server index: anything at-or-below
    // `newestIndex` is dropped. Never mutates the streaming tail — callers must
    // guard with `isStreamingActive` before invoking.
    // Returns the number of messages actually appended.
    @discardableResult
    func appendNewerFromHead(_ page: HistoryPage) -> Int {
        guard !page.items.isEmpty else { return 0 }
        let threshold = newestIndex ?? Int.min
        var appended = 0
        var maxSeen = newestIndex
        for item in page.items {
            guard let idx = item.index else { continue }
            if idx > threshold {
                messages.append(item.message)
                appended += 1
                if maxSeen == nil || idx > (maxSeen ?? Int.min) { maxSeen = idx }
            }
        }
        if let m = maxSeen { newestIndex = m }
        return appended
    }

    // Prepend older messages returned by a paginated session.history fetch.
    // Advances `oldestIndex` downward and updates `hasMoreHistory`. Callers must
    // pass server-ordered (ascending index) messages — this keeps chronological
    // ordering in `messages`.
    func prependOlder(_ older: [Message], oldest: Int?, hasMore: Bool) {
        if !older.isEmpty {
            messages.insert(contentsOf: older, at: 0)
        }
        if let o = oldest { oldestIndex = o }
        hasMoreHistory = hasMore
        isLoadingOlder = false
    }

    // Decode a session.history payload into ChatStore.Message values.
    // Gateway shape (hawky/src/gateway/agent-methods.ts:706):
    //   { messages: [{ role: "user"|"assistant", timestamp: string?, content: ContentBlock[] }],
    //     sessionKey: string, total: number }
    // ContentBlock variants (hawky/src/agent/types.ts:287+): text, thinking, tool_use, tool_result, image.
    // MVP: concatenate `text` blocks (preferring `display_text` if present); skip everything else.
    // Messages whose text ends up empty are dropped so stray tool-only turns don't show as blanks.
    static func decodeHistoryPayload(_ payload: JSONValue) -> [Message] {
        guard case .object(let obj) = payload,
              case .some(.array(let arr)) = obj["messages"] else {
            return []
        }
        return arr.compactMap { decodeHistoryMessage($0) }
    }

    // Paginated decode: returns messages plus the oldest absolute server index
    // present in the payload and the server's `hasMore` flag. Callers use these
    // to drive the "Load older" pagination control.
    // `oldestIndex` is nil if no message carried an `index` field (defensive
    // against older server builds).
    struct HistoryPage {
        let messages: [Message]
        let oldestIndex: Int?
        let newestIndex: Int?
        let hasMore: Bool
        // Per-message decoded items with their server index (nil if the payload
        // row didn't carry one). Preserved in the same order as `messages`.
        // Used by the foreground-refresh path to merge head deltas by index.
        let items: [Item]

        struct Item {
            let message: Message
            let index: Int?
        }
    }

    static func decodeHistoryPage(_ payload: JSONValue) -> HistoryPage {
        guard case .object(let obj) = payload,
              case .some(.array(let arr)) = obj["messages"] else {
            return HistoryPage(messages: [], oldestIndex: nil, newestIndex: nil, hasMore: false, items: [])
        }
        var decoded: [Message] = []
        var items: [HistoryPage.Item] = []
        var indices: [Int] = []
        for raw in arr {
            guard let m = decodeHistoryMessage(raw) else { continue }
            decoded.append(m)
            var idx: Int? = nil
            if case .object(let o) = raw, case .some(.number(let n)) = o["index"] {
                idx = Int(n)
                indices.append(Int(n))
            }
            items.append(HistoryPage.Item(message: m, index: idx))
        }
        let hasMore: Bool
        if case .some(.bool(let b)) = obj["hasMore"] { hasMore = b } else { hasMore = false }
        return HistoryPage(messages: decoded, oldestIndex: indices.min(), newestIndex: indices.max(), hasMore: hasMore, items: items)
    }

    private static func decodeHistoryMessage(_ v: JSONValue) -> Message? {
        guard case .object(let obj) = v,
              case .some(.string(let roleRaw)) = obj["role"] else { return nil }
        let role: Role
        switch roleRaw {
        case "user": role = .user
        case "assistant": role = .assistant
        default: role = .system
        }
        let text: String
        if case .some(.array(let blocks)) = obj["content"] {
            text = blocks.compactMap(extractBlockText).joined()
        } else if case .some(.string(let s)) = obj["content"] {
            text = s
        } else {
            text = ""
        }
        if text.isEmpty { return nil }
        let ts: Date
        if case .some(.string(let tsStr)) = obj["timestamp"],
           let parsed = iso8601Fractional.date(from: tsStr) ?? iso8601Plain.date(from: tsStr) {
            ts = parsed
        } else {
            ts = Date()
        }
        return Message(id: UUID(), role: role, text: text, isStreaming: false, timestamp: ts)
    }

    private static func extractBlockText(_ v: JSONValue) -> String? {
        guard case .object(let obj) = v,
              case .some(.string(let type)) = obj["type"],
              type == "text" else { return nil }
        if case .some(.string(let dt)) = obj["display_text"], !dt.isEmpty { return dt }
        if case .some(.string(let t)) = obj["text"] { return t }
        return nil
    }

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
