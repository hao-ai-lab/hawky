import Foundation

// DebugFrameLog — ring buffer of unparseable / unknown WebSocket frames.
// Hardening note: never silently swallow frames that don't parse.
// This buffer exists so the Test-tab probe can dump recent drops for inspection.
//
// Compile-time only — the #if DEBUG wrapper means release builds get a no-op
// implementation so we don't allocate a ring buffer in production.
// Capacity is intentionally small (~200) — this is a diagnostic, not a transcript.
final class DebugFrameLog: @unchecked Sendable {
    struct Entry {
        let timestamp: Date
        let raw: String
        let reason: String
    }

    static let shared = DebugFrameLog()

    private let lock = NSLock()
    private var buffer: [Entry] = []
    private let capacity: Int

    init(capacity: Int = 200) {
        self.capacity = capacity
        self.buffer.reserveCapacity(capacity)
    }

    func append(raw: String, reason: String) {
        #if DEBUG
        lock.lock(); defer { lock.unlock() }
        if buffer.count >= capacity {
            buffer.removeFirst(buffer.count - capacity + 1)
        }
        buffer.append(Entry(timestamp: Date(), raw: raw, reason: reason))
        #endif
    }

    // Snapshot of the last `limit` entries, oldest-first. Safe to call from any thread.
    func recent(limit: Int = 50) -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        let slice = buffer.suffix(limit)
        return Array(slice)
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        buffer.removeAll(keepingCapacity: true)
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return buffer.count
    }
}
