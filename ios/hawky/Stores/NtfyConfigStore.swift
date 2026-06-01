import Foundation
import Observation

// NtfyConfigStore — thin wrapper around `config.get` / `config.update` RPCs for
// the Hawky ntfy notification adapter. The server-side contract lives on
// Hawky and exposes these keys under `config.notifications.ntfy`:
//   - enabled  (Bool)
//   - baseUrl  (String, e.g. "https://ntfy.sh")
//   - topic    (String, e.g. "abc123")
//   - triggers ([String])
//   - click    (String? — universal link ntfy opens on tap)
//
// This store is UI-only: it reads config on demand, writes on toggle/submit,
// and does NOT register for push notifications or open a new WebSocket.
@MainActor
@Observable
final class NtfyConfigStore {
    // Loaded state. nil while the initial `config.get` is in flight or has failed.
    private(set) var enabled: Bool = false
    private(set) var baseUrl: String = "https://ntfy.sh"
    private(set) var topic: String = ""
    private(set) var triggers: [String] = []
    // Per-session allowlist. Empty = fire for all sessions (server default).
    // A non-empty list restricts ntfy pushes to sessions whose sessionKey
    // (e.g. "ios:main") is present. Server-side: see notifications.ts.
    private(set) var sessions: [String] = []

    // Lifecycle — `idle` until first load; `loaded` once config.get succeeds;
    // `error(msg)` if the RPC fails. Views can show a disabled state on error.
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }
    private(set) var loadState: LoadState = .idle

    // Test-push feedback — transient message shown under the "Send test push" row.
    private(set) var testPushFeedback: String?

    // Convenience — full subscription URL used for the UI row + deep link.
    // Returns nil when topic is empty so the view can show a "not configured" hint.
    var subscriptionURL: URL? {
        let trimmedBase = baseUrl.trimmingCharacters(in: .whitespaces)
        let trimmedTopic = topic.trimmingCharacters(in: .whitespaces)
        guard !trimmedTopic.isEmpty, !trimmedBase.isEmpty else { return nil }
        let base = trimmedBase.hasSuffix("/") ? String(trimmedBase.dropLast()) : trimmedBase
        return URL(string: "\(base)/\(trimmedTopic)")
    }

    // Fetch current config from the gateway. Safe to call repeatedly.
    func load(transport: GatewayTransport) async {
        loadState = .loading
        let frame = RequestFrame(id: UUID().uuidString, method: "config.get", params: nil)
        do {
            let resp = try await transport.send(frame)
            guard resp.ok else {
                loadState = .error(resp.error?.message ?? "config.get failed")
                return
            }
            apply(payload: resp.payload)
            loadState = .loaded
        } catch {
            loadState = .error("\(error)")
        }
    }

    // Write back the per-session allowlist. Empty = fire for all sessions.
    // Optimistic; reverts on failure.
    func setSessions(_ newValue: [String], transport: GatewayTransport) async {
        let previous = sessions
        sessions = newValue
        await updateNtfy(
            ["sessions": .array(newValue.map { .string($0) })],
            transport: transport,
            onFailure: { self.sessions = previous }
        )
    }

    // Write back `enabled`. Optimistic — snap UI, revert on failure.
    func setEnabled(_ newValue: Bool, transport: GatewayTransport) async {
        let previous = enabled
        enabled = newValue
        await updateNtfy(["enabled": .bool(newValue)], transport: transport, onFailure: {
            self.enabled = previous
        })
    }

    // Write back `topic`. Caller passes the already-trimmed string. Optimistic.
    func setTopic(_ newValue: String, transport: GatewayTransport) async {
        let trimmed = newValue.trimmingCharacters(in: .whitespaces)
        let previous = topic
        topic = trimmed
        await updateNtfy(["topic": .string(trimmed)], transport: transport, onFailure: {
            self.topic = previous
        })
    }

    // Replace the triggers array wholesale. Optimistic.
    func setTriggers(_ newValue: [String], transport: GatewayTransport) async {
        let previous = triggers
        triggers = newValue
        let arr: [JSONValue] = newValue.map { .string($0) }
        await updateNtfy(["triggers": .array(arr)], transport: transport, onFailure: {
            self.triggers = previous
        })
    }

    // Toggle a single trigger name on/off. When `names` has >1 entry they are
    // added/removed together (used for the "Permission requests" toggle that
    // manages both `permission.request` and `agent.permission_request`).
    func toggleTrigger(names: [String], on: Bool, transport: GatewayTransport) async {
        var next = triggers
        if on {
            for n in names where !next.contains(n) { next.append(n) }
        } else {
            next.removeAll { names.contains($0) }
        }
        await setTriggers(next, transport: transport)
    }

    // Generate a random topic — `hawky-<12 hex>` — and push it.
    @discardableResult
    func generateRandomTopic(transport: GatewayTransport) async -> String {
        var bytes = [UInt8](repeating: 0, count: 6)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let candidate = "hawky-\(hex)"
        await setTopic(candidate, transport: transport)
        return candidate
    }

    // Send a synthetic "test from Hawky" push directly to ntfy (bypasses the
    // gateway so the user can verify topic + iOS app wiring without touching
    // Hawky's adapter). Uses HTTP POST to <baseUrl>/<topic>. Updates
    // `testPushFeedback` with a success/error message the view can render.
    func sendTestPush() async {
        let trimmedBase = baseUrl.trimmingCharacters(in: .whitespaces)
        let trimmedTopic = topic.trimmingCharacters(in: .whitespaces)
        guard !trimmedBase.isEmpty, !trimmedTopic.isEmpty else {
            testPushFeedback = "Set a topic first"
            return
        }
        let base = trimmedBase.hasSuffix("/") ? String(trimmedBase.dropLast()) : trimmedBase
        guard let url = URL(string: "\(base)/\(trimmedTopic)") else {
            testPushFeedback = "Invalid base URL"
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Hawky test push", forHTTPHeaderField: "Title")
        req.setValue("3", forHTTPHeaderField: "Priority")
        req.setValue("white_check_mark", forHTTPHeaderField: "Tags")
        req.httpBody = "Test from Hawky — \(Date().formatted(date: .omitted, time: .standard))"
            .data(using: .utf8)
        testPushFeedback = "Sending…"
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                testPushFeedback = "HTTP \(http.statusCode)"
            } else {
                testPushFeedback = "Sent"
            }
        } catch {
            testPushFeedback = "Failed: \(error.localizedDescription)"
        }
    }

    // ------------------------------------------------------------------
    // Internals

    // Hawky's config.update expects params in the shape
    // `{ notifications: { ntfy: { ...fields } } }` at the top level of params.
    // NO `patch:` wrapper — that was an early-draft shape.
    private func updateNtfy(
        _ fields: [String: JSONValue],
        transport: GatewayTransport,
        onFailure: @escaping @MainActor () -> Void
    ) async {
        let params: [String: JSONValue] = [
            "notifications": .object([
                "ntfy": .object(fields)
            ])
        ]
        let frame = RequestFrame(
            id: UUID().uuidString,
            method: "config.update",
            params: params
        )
        do {
            let resp = try await transport.send(frame)
            if !resp.ok {
                onFailure()
                loadState = .error(resp.error?.message ?? "config.update failed")
            }
        } catch {
            onFailure()
            loadState = .error("\(error)")
        }
    }

    // Extract the notifications.ntfy subtree from a `config.get` response.
    // Tolerant: missing keys leave defaults in place so stale UI doesn't break
    // when the Hawky side hasn't been bumped yet.
    private func apply(payload: JSONValue?) {
        guard case .object(let root) = payload ?? .null else { return }
        // Hawky may wrap the config under "config" or return it flat — handle both.
        let notifications: [String: JSONValue]
        if case .some(.object(let wrap)) = root["config"],
           case .some(.object(let n)) = wrap["notifications"] {
            notifications = n
        } else if case .some(.object(let n)) = root["notifications"] {
            notifications = n
        } else {
            return
        }
        guard case .some(.object(let ntfy)) = notifications["ntfy"] else { return }
        if case .some(.bool(let b)) = ntfy["enabled"] { enabled = b }
        if case .some(.string(let s)) = ntfy["baseUrl"], !s.isEmpty { baseUrl = s }
        if case .some(.string(let s)) = ntfy["topic"] { topic = s }
        if case .some(.array(let arr)) = ntfy["triggers"] {
            triggers = arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        if case .some(.array(let arr)) = ntfy["sessions"] {
            sessions = arr.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
    }
}
