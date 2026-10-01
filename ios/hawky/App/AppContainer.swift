import Foundation
import Observation

// Typed error surfaced to the UI for session switch failures.
// Always carries a human-readable reason — never leak raw NSError to views.
enum AppContainerError: LocalizedError, Equatable {
    case switchFailed(reason: String)
    var errorDescription: String? {
        switch self { case .switchFailed(let r): return r }
    }
}

// AppContainer — composition root. Wires auth → transport → chat client → stores.
// Single @Observable on main actor so SwiftUI views can read it directly.
@MainActor
@Observable
final class AppContainer {
    private(set) var gatewayURL: URL
    private(set) var deviceAuth: DeviceAuthClient
    let connectionStore: ConnectionStore
    let chatStore: ChatStore
    let sessionStore: SessionStore

    private(set) var transport: GatewayTransport?
    private(set) var chatClient: ChatClient?
    /// Node runner — nil until the user opts in via Settings ("Act as node").
    /// Runs on its own WebSocket; does not share state with the client transport.
    private(set) var nodeRunner: NodeRunner?
    private var nodeRunTask: Task<Void, Never>?

    // Injectable factory for tests; production uses URLSessionGatewayTransport.
    var transportFactory: @MainActor () -> GatewayTransport = { URLSessionGatewayTransport() }

    // Injectable clock for tests — defaults to Date(). Used by handleForegroundTransition
    // to measure time-since-background without reaching for the wall clock directly.
    var nowProvider: @MainActor () -> Date = { Date() }

    // Set when the scene transitions away from .active. Nil while in foreground
    // or on first launch. Read+cleared by handleForegroundTransition.
    private(set) var lastBackgroundedAt: Date?

    // Debounce window for the foreground head-refresh path. Refresh runs on
    // every .active transition, but if a refresh ran less than this long ago
    // we skip to avoid spamming the gateway on rapid background/foreground
    // toggles (e.g. swipe-gesture dismissals, Control Center peeks).
    let foregroundRefreshDebounce: TimeInterval = 2

    // Wall-clock time of the last successful or attempted head refresh. Read
    // and updated by refreshHeadIfNeeded to enforce the debounce.
    private var lastForegroundRefreshAt: Date?

    // Test seam — directly install a transport without connecting, to drive switchSession flows.
    func _testInstallTransport(_ t: GatewayTransport?) { self.transport = t }

    private var currentAssistantId: UUID?
    private let launchConfiguration: LaunchConfiguration
    private let seedData: LaunchSeedData?

    init(launchConfiguration: LaunchConfiguration = .current()) {
        self.launchConfiguration = launchConfiguration
        self.seedData = launchConfiguration.gateway == .seededLocal
            ? LaunchSeedFixtures.data(
                for: launchConfiguration.seedProfile,
                fallbackSession: launchConfiguration.seededSession
            )
            : nil
        // UserDefaults override key: "gatewayURL".
        let defaultURL = URL(string: GatewayDefaults.urlString)!
        let resolvedGatewayURL: URL
        if let raw = UserDefaults.standard.string(forKey: "gatewayURL"),
           let url = URL(string: raw) {
            resolvedGatewayURL = url
        } else {
            resolvedGatewayURL = defaultURL
        }
        self.gatewayURL = resolvedGatewayURL
        self.deviceAuth = DeviceAuthClient(baseURL: resolvedGatewayURL)
        self.connectionStore = ConnectionStore()
        self.chatStore = ChatStore()
        self.sessionStore = SessionStore()
    }

    // Translate http(s) base URL → ws(s) URL for the WebSocket upgrade endpoint.
    private var websocketURL: URL {
        var comps = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false)!
        switch comps.scheme {
        case "https": comps.scheme = "wss"
        case "http": comps.scheme = "ws"
        default: break
        }
        return comps.url ?? gatewayURL
    }

    // Single path for building the transport, running connect+hello, and wiring ChatClient.
    // Reused by start / reauthenticate / ensureConnected so stale sockets can be rebuilt
    // without duplicating the handshake sequence.
    private func buildAndConnect(token: String, platform: String) async throws {
        let transport = transportFactory()
        self.transport = transport
        let params = ConnectParams(
            version: "1",
            platform: platform,
            token: token,
            sessionKey: sessionStore.activeSessionKey,
            role: "client"
        )
        let hello = try await transport.connect(url: websocketURL, connectParams: params)
        connectionStore.markConnected(connId: hello.connId)
        self.chatClient = ChatClient(transport: transport, sessionKey: sessionStore.activeSessionKey)
    }

    // Rebuilds the transport when the current one is stale (ENOTCONN / closed socket).
    // Callers (e.g. switchSession) use this before RPCs to avoid NSPOSIXErrorDomain 57.
    func ensureConnected() async throws {
        if transport?.isConnected == true { return }
        await transport?.disconnect()
        self.transport = nil
        self.chatClient = nil
        connectionStore.markConnecting()
        let token: String
        if let cached = try? KeychainStore.load(for: gatewayURL), !cached.isEmpty {
            token = cached
        } else {
            token = try await deviceAuth.acquireAndStore()
        }
        let platform = UserDefaults.standard.string(forKey: "deviceName") ?? "mobile"
        try await buildAndConnect(token: token, platform: platform)
    }

    // Start the node-role WebSocket alongside the client connection. Only
    // invoked when the user has enabled "Act as node" in Settings (default OFF
    // for MVP). The node runner owns its own socket; reuses the Keychain JWT.
    func startNode() async {
        guard UserDefaults.standard.bool(forKey: "actAsNode") else { return }
        if nodeRunner != nil { return }
        let token: String
        do {
            if let cached = try? KeychainStore.load(for: gatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await deviceAuth.acquireAndStore()
            }
        } catch {
            NSLog("ios: startNode token acquisition failed: \(error)")
            return
        }
        let nodeId = nodeIdentifier()
        let name = UserDefaults.standard.string(forKey: "deviceName") ?? "mobile"
        let config = NodeRunner.Config(
            nodeId: nodeId,
            name: name,
            gatewayURL: gatewayURL,
            platform: "mobile",
            token: token
        )
        let runner = NodeRunner(
            config: config,
            transport: URLSessionNodeTransport(),
            commands: [
                DeviceInfoCommand(),
                BatteryCommand(),
                StorageCommand(),
                NetworkCommand(),
                ClipboardCommand(),
                NotificationShowCommand(),
                FrontendMessageCommand(),
                FrontendOpenTabCommand(),
            ]
        )
        let runnerGatewayURL = gatewayURL
        let runnerDeviceAuth = deviceAuth
        runner.onAuthFailed = {
            try? KeychainStore.delete(for: runnerGatewayURL)
            return try? await runnerDeviceAuth.acquireAndStore()
        }
        runner.onEvicted = { [weak self] in
            NSLog("ios: node evicted; stopping node role")
            self?.nodeRunner = nil
        }
        self.nodeRunner = runner
        self.nodeRunTask = Task { await runner.start() }
    }

    /// Stop the node-role runner. Safe to call when not running.
    func stopNode() async {
        nodeRunTask?.cancel()
        nodeRunTask = nil
        if let runner = nodeRunner {
            await runner.stop()
        }
        nodeRunner = nil
    }

    /// Stable nodeId persisted in UserDefaults. Generated on first enable.
    private func nodeIdentifier() -> String {
        if let existing = UserDefaults.standard.string(forKey: "nodeId"),
           !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: "nodeId")
        return fresh
    }

    func start() async {
        if launchConfiguration.gateway == .seededLocal {
            startSeededSession()
            return
        }

        NSLog("ios: starting with gateway \(gatewayURL.absoluteString)")
        connectionStore.markConnecting()
        do {
            let token: String
            if let cached = try? KeychainStore.load(for: gatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await deviceAuth.acquireAndStore()
            }
            try await buildAndConnect(token: token, platform: "mobile")
            // Non-fatal — a list refresh failure shouldn't block chat.
            do { try await refreshSessionList() } catch {
                NSLog("ios: refreshSessionList failed: \(error)")
            }
            // Start the node role if the user has opted in. Silent no-op when
            // the "Act as node" toggle is off (default for MVP).
            await startNode()
            // Initial history load for the focused session. scenePhase's
            // foreground-refresh path only fires on .background/.inactive →
            // .active transitions, so on a cold launch (.active with no prior
            // phase) it is skipped. Without this call the Chat tab renders
            // empty until the user backgrounds + foregrounds the app.
            // Reuses the same debounced path as the foreground refresh, so a
            // scenePhase event arriving within foregroundRefreshDebounce of
            // this call will be a silent no-op (prevents double-fire).
            await refreshHeadIfNeeded(for: sessionStore.activeSessionKey)
        } catch GatewayTransportError.unauthorized {
            try? KeychainStore.delete(for: gatewayURL)
            connectionStore.markError("Unauthorized. Tap the status dot and re-authenticate.")
        } catch DeviceAuthError.unauthorized {
            try? KeychainStore.delete(for: gatewayURL)
            NSLog("ios: device auth rejected")
            connectionStore.markError("Device auth rejected. Check gateway URL.")
        } catch {
            NSLog("ios: connection failed: \(error)")
            connectionStore.markError("Connection failed: \(error)")
        }
    }

    // Clear Keychain, fetch a fresh token, rebuild transport, reconnect.
    // Called from Settings "Re-authenticate" button.
    func reauthenticate() async {
        try? KeychainStore.delete(for: gatewayURL)
        await transport?.disconnect()
        self.transport = nil
        self.chatClient = nil
        connectionStore.markConnecting()
        do {
            let token = try await deviceAuth.acquireAndStore()
            let platform = UserDefaults.standard.string(forKey: "deviceName") ?? "mobile"
            try await buildAndConnect(token: token, platform: platform)
        } catch {
            connectionStore.markError("Re-auth failed: \(error)")
        }
    }

    /// Persist and immediately apply gateway/device settings without requiring
    /// a force-quit. Rebuilds all gateway-owned sockets so Settings, Chat, Live,
    /// and node-role calls observe the same active endpoint.
    func applyGatewaySettings(gatewayURL newGatewayURL: URL, deviceName: String) async throws {
        let trimmedName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(newGatewayURL.absoluteString, forKey: "gatewayURL")
        UserDefaults.standard.set(trimmedName, forKey: "deviceName")

        await stopNode()
        await transport?.disconnect()
        self.transport = nil
        self.chatClient = nil
        self.currentAssistantId = nil
        self.gatewayURL = newGatewayURL
        self.deviceAuth = DeviceAuthClient(baseURL: newGatewayURL)
        connectionStore.markConnecting()

        do {
            let token: String
            if let cached = try? KeychainStore.load(for: newGatewayURL), !cached.isEmpty {
                token = cached
            } else {
                token = try await deviceAuth.acquireAndStore()
            }
            let platform = trimmedName.isEmpty ? "mobile" : trimmedName
            try await buildAndConnect(token: token, platform: platform)
            do { try await refreshSessionList() } catch {
                NSLog("ios: refreshSessionList failed after gateway settings apply: \(error)")
            }
            await refreshHeadIfNeeded(for: sessionStore.activeSessionKey)
            await startNode()
        } catch {
            connectionStore.markError("Connection failed: \(error)")
            throw error
        }
    }

    // Initial history window size. Kept small to minimize time-to-first-paint when
    // opening a session with a long history — older messages are fetched on-demand
    // via loadOlderHistory() ("Load older" button in ChatView). Hawky caps at 100
    // server-side by default, so 50 is a conservative paginated window.
    nonisolated static let initialHistoryLimit: Int = 50

    // Fetch session.history via the live transport and overlay it onto ChatStore.
    // Populates pagination cursor state so the UI can offer "Load older".
    // Returns the number of messages loaded into the store.
    @discardableResult
    func reloadHistory(limit: Int = AppContainer.initialHistoryLimit) async throws -> Int {
        if launchConfiguration.gateway == .seededLocal {
            return installSeededMessages(for: sessionStore.activeSessionKey)
        }

        guard let transport else { throw GatewayTransportError.notConnected }
        let params: [String: JSONValue] = [
            "sessionKey": .string(sessionStore.activeSessionKey),
            "limit": .number(Double(limit))
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "session.history", params: params)
        let resp = try await transport.send(frame)
        if !resp.ok {
            throw GatewayTransportError.decodeError(message: resp.error?.message ?? "session.history failed")
        }
        let page = resp.payload.map(ChatStore.decodeHistoryPage) ?? ChatStore.HistoryPage(messages: [], oldestIndex: nil, newestIndex: nil, hasMore: false, items: [])
        chatStore.replaceAllWithCursor(page.messages, oldest: page.oldestIndex, hasMore: page.hasMore, newest: page.newestIndex)
        return page.messages.count
    }

    // Silent head refresh for the currently-focused session. Called from
    // scenePhase → .active. Merge semantics:
    //  - If an assistant turn is actively streaming, skip entirely so we never
    //    clobber the in-progress tail.
    //  - If the local store has no newestIndex (fresh / just-switched), overlay
    //    the full head window via replaceAllWithCursor.
    //  - Otherwise, append only messages whose server index is strictly greater
    //    than the local newestIndex. No reorder, no rewrite of existing rows.
    // Transient failures are swallowed (NSLog only) — this is a background
    // refresh and must not surface a user-visible banner.
    @discardableResult
    func refreshHeadIfNeeded(for sessionKey: String, limit: Int = AppContainer.initialHistoryLimit) async -> Int {
        if sessionKey != sessionStore.activeSessionKey { return 0 }
        if chatStore.isStreamingActive { return 0 }
        if let last = lastForegroundRefreshAt,
           nowProvider().timeIntervalSince(last) < foregroundRefreshDebounce {
            return 0
        }
        guard let transport, transport.isConnected else { return 0 }
        lastForegroundRefreshAt = nowProvider()
        let params: [String: JSONValue] = [
            "sessionKey": .string(sessionKey),
            "limit": .number(Double(limit))
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "session.history", params: params)
        let resp: ResponseFrame
        do {
            resp = try await transport.send(frame)
        } catch {
            NSLog("ios: refreshHead transport error: \(error)")
            return 0
        }
        guard resp.ok, let payload = resp.payload else {
            if let msg = resp.error?.message {
                NSLog("ios: refreshHead rpc error: \(msg)")
            }
            return 0
        }
        // Re-check streaming state after the await — a send may have started
        // while the fetch was in flight.
        if chatStore.isStreamingActive { return 0 }
        // If the focused session changed during the await, bail — we'd be
        // writing to the wrong session's store.
        if sessionKey != sessionStore.activeSessionKey { return 0 }
        let page = ChatStore.decodeHistoryPage(payload)
        if chatStore.newestIndex == nil {
            chatStore.replaceAllWithCursor(page.messages, oldest: page.oldestIndex, hasMore: page.hasMore, newest: page.newestIndex)
            return page.messages.count
        }
        return chatStore.appendNewerFromHead(page)
    }

    // Fetch the next older window of history via beforeIndex pagination and
    // prepend it to the store. No-op if we're already at the top or a load is
    // in flight. Does NOT interact with streaming — streaming mutates only the
    // latest assistant message by UUID, and older messages live behind it.
    @discardableResult
    func loadOlderHistory(limit: Int = AppContainer.initialHistoryLimit) async throws -> Int {
        if launchConfiguration.gateway == .seededLocal {
            return 0
        }

        guard let transport else { throw GatewayTransportError.notConnected }
        guard chatStore.hasMoreHistory, !chatStore.isLoadingOlder,
              let before = chatStore.oldestIndex else { return 0 }
        chatStore.isLoadingOlder = true
        let params: [String: JSONValue] = [
            "sessionKey": .string(sessionStore.activeSessionKey),
            "limit": .number(Double(limit)),
            "beforeIndex": .number(Double(before))
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "session.history", params: params)
        let resp: ResponseFrame
        do {
            resp = try await transport.send(frame)
        } catch {
            chatStore.isLoadingOlder = false
            throw error
        }
        if !resp.ok {
            chatStore.isLoadingOlder = false
            throw GatewayTransportError.decodeError(message: resp.error?.message ?? "session.history failed")
        }
        let page = resp.payload.map(ChatStore.decodeHistoryPage) ?? ChatStore.HistoryPage(messages: [], oldestIndex: nil, newestIndex: nil, hasMore: false, items: [])
        chatStore.prependOlder(page.messages, oldest: page.oldestIndex, hasMore: page.hasMore)
        return page.messages.count
    }

    func conversationScreenshotSnapshot(limit: Int = 1_000) async -> ConversationScreenshotSnapshot? {
        var messages = chatStore.messages
        if launchConfiguration.gateway != .seededLocal,
           let transport,
           transport.isConnected {
            let loaded = await fetchConversationMessagesForScreenshot(limit: limit, transport: transport)
            if !loaded.isEmpty {
                messages = loaded
            }
        }

        let rows = messages
            .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .map {
                ConversationScreenshotSnapshot.Row(
                    role: $0.role.screenshotLabel,
                    text: $0.text,
                    timestamp: $0.timestamp
                )
            }
        guard !rows.isEmpty else { return nil }
        let displayName = sessionStore.activeSummary?.displayName
            ?? SessionStore.defaultDisplayName(for: sessionStore.activeSessionKey)
        return ConversationScreenshotSnapshot(
            title: displayName,
            subtitle: "Chat session \(sessionStore.activeSessionKey)",
            rows: rows
        )
    }

    private func fetchConversationMessagesForScreenshot(
        limit: Int,
        transport: GatewayTransport
    ) async -> [ChatStore.Message] {
        var all: [ChatStore.Message] = []
        var beforeIndex: Int?
        var hasMore = true

        while hasMore, all.count < limit {
            var params: [String: JSONValue] = [
                "sessionKey": .string(sessionStore.activeSessionKey),
                "limit": .number(Double(min(200, limit - all.count))),
            ]
            if let beforeIndex {
                params["beforeIndex"] = .number(Double(beforeIndex))
            }
            let frame = RequestFrame(id: UUID().uuidString, method: "session.history", params: params)
            do {
                let resp = try await transport.send(frame)
                guard resp.ok, let payload = resp.payload else { break }
                let page = ChatStore.decodeHistoryPage(payload)
                if page.messages.isEmpty { break }
                if beforeIndex == nil {
                    all = page.messages
                } else {
                    all.insert(contentsOf: page.messages, at: 0)
                }
                beforeIndex = page.oldestIndex
                hasMore = page.hasMore && all.count < limit && page.oldestIndex != nil
            } catch {
                break
            }
        }
        return all
    }

    // session.list → SessionStore.sessions. Hawky returns each row as `id` using
    // slash-separated form (e.g. "ios/main"); we restore the `:` separator
    // so the value round-trips as a sessionKey.
    func refreshSessionList() async throws {
        if launchConfiguration.gateway == .seededLocal {
            return
        }

        guard let transport else { throw GatewayTransportError.notConnected }
        // Ask for archived too — the UI filters them client-side via a toggle.
        let params: [String: JSONValue] = [
            "limit": .number(200),
            "includeArchived": .bool(true)
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "session.list", params: params)
        let resp = try await transport.send(frame)
        if !resp.ok {
            throw GatewayTransportError.decodeError(message: resp.error?.message ?? "session.list failed")
        }
        guard case .object(let obj) = resp.payload ?? .null,
              case .some(.array(let arr)) = obj["sessions"] else {
            return
        }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoNoFrac = ISO8601DateFormatter()
        var summaries: [SessionStore.SessionSummary] = []
        for v in arr {
            guard case .object(let row) = v,
                  case .some(.string(let rawId)) = row["id"] else { continue }
            let key = rawId.replacingOccurrences(of: "/", with: ":")
            let display: String
            if case .some(.string(let d)) = row["displayName"], !d.isEmpty {
                display = d
            } else {
                display = SessionStore.defaultDisplayName(for: key)
            }
            var pinned = false
            if case .some(.bool(let b)) = row["pinned"] { pinned = b }
            var archived = false
            if case .some(.bool(let b)) = row["archived"] { archived = b }
            var lastActivity: Date? = nil
            if case .some(.string(let ts)) = row["createdAt"] {
                lastActivity = iso.date(from: ts) ?? isoNoFrac.date(from: ts)
            }
            summaries.append(.init(
                key: key,
                displayName: display,
                unreadCount: 0,
                isPinned: pinned,
                isArchived: archived,
                lastActivity: lastActivity
            ))
        }
        // Keep the active session present even if the server hasn't persisted it yet.
        if !summaries.contains(where: { $0.key == sessionStore.activeSessionKey }) {
            summaries.insert(
                .init(
                    key: sessionStore.activeSessionKey,
                    displayName: SessionStore.defaultDisplayName(for: sessionStore.activeSessionKey),
                    unreadCount: 0
                ),
                at: 0
            )
        }
        sessionStore.replaceAll(summaries)
    }

    // -------------------------------------------------------------------------
    // Session mutation RPCs — rename / pin / unpin / archive / delete.
    // Each calls the Hawky agent-methods endpoint and then updates local store.
    // On archive/delete of the active session, fall back to first non-archived.
    // -------------------------------------------------------------------------

    func rename(key: String, to displayName: String) async throws {
        guard let transport else { throw GatewayTransportError.notConnected }
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let params: [String: JSONValue] = [
            "sessionKey": .string(key),
            "displayName": .string(trimmed)
        ]
        let frame = RequestFrame(id: UUID().uuidString, method: "session.rename", params: params)
        let resp = try await transport.send(frame)
        if !resp.ok {
            throw GatewayTransportError.decodeError(message: resp.error?.message ?? "session.rename failed")
        }
        let effective = trimmed.isEmpty ? SessionStore.defaultDisplayName(for: key) : trimmed
        sessionStore.setDisplayName(key, effective)
    }

    func pin(key: String) async throws {
        try await simpleSessionRPC("session.pin", key: key)
        sessionStore.setPinned(key, true)
    }

    func unpin(key: String) async throws {
        try await simpleSessionRPC("session.unpin", key: key)
        sessionStore.setPinned(key, false)
    }

    func archive(key: String) async throws {
        try await simpleSessionRPC("session.archive", key: key)
        sessionStore.setArchived(key, true)
        if sessionStore.activeSessionKey == key {
            try await fallbackAwayFrom(key)
        }
    }

    func unarchive(key: String) async throws {
        try await simpleSessionRPC("session.unarchive", key: key)
        sessionStore.setArchived(key, false)
    }

    func delete(key: String) async throws {
        try await simpleSessionRPC("session.delete", key: key)
        let wasActive = sessionStore.activeSessionKey == key
        sessionStore.remove(key: key)
        if wasActive {
            try await fallbackAwayFrom(key)
        }
    }

    private func simpleSessionRPC(_ method: String, key: String) async throws {
        guard let transport else { throw GatewayTransportError.notConnected }
        let params: [String: JSONValue] = ["sessionKey": .string(key)]
        let frame = RequestFrame(id: UUID().uuidString, method: method, params: params)
        let resp = try await transport.send(frame)
        if !resp.ok {
            throw GatewayTransportError.decodeError(message: resp.error?.message ?? "\(method) failed")
        }
    }

    // Pick a replacement session when active is archived/deleted.
    // Prefer ios:main, then first non-archived, else create ios:main.
    private func fallbackAwayFrom(_ key: String) async throws {
        let candidates = sessionStore.sessions.filter { $0.key != key && !$0.isArchived }
        let fallback: String
        if let main = candidates.first(where: { $0.key == "ios:main" }) {
            fallback = main.key
        } else if let first = candidates.first {
            fallback = first.key
        } else {
            fallback = "ios:main"
            sessionStore.upsert(.init(key: fallback, displayName: "main", unreadCount: 0))
        }
        if fallback != sessionStore.activeSessionKey {
            try await switchSession(to: fallback)
        }
    }

    // session.resolve rebinds the existing conn to the new sessionKey. If the current
    // transport is stale (socket dead → ENOTCONN 57) we rebuild it first via ensureConnected.
    // All failures surface as AppContainerError.switchFailed so the UI never sees raw NSError.
    func switchSession(to key: String) async throws {
        if key == sessionStore.activeSessionKey { return }
        if launchConfiguration.gateway == .seededLocal {
            sessionStore.setActive(key)
            currentAssistantId = nil
            _ = installSeededMessages(for: key)
            return
        }

        if transport?.isConnected != true {
            do {
                try await ensureConnected()
            } catch {
                throw AppContainerError.switchFailed(reason: "Not connected to gateway. Tap the dot to retry.")
            }
        }
        guard let transport else {
            throw AppContainerError.switchFailed(reason: "Not connected to gateway. Tap the dot to retry.")
        }
        chatStore.reset()
        currentAssistantId = nil
        let params: [String: JSONValue] = ["sessionKey": .string(key)]
        let frame = RequestFrame(id: UUID().uuidString, method: "session.resolve", params: params)
        let resp: ResponseFrame
        do {
            resp = try await transport.send(frame)
        } catch {
            let reason: String
            if case GatewayTransportError.decodeError(let m) = error { reason = m }
            else if error is GatewayTransportError { reason = "Not connected to gateway. Tap the dot to retry." }
            else { reason = "Not connected to gateway. Tap the dot to retry." }
            throw AppContainerError.switchFailed(reason: reason)
        }
        if !resp.ok {
            throw AppContainerError.switchFailed(reason: resp.error?.message ?? "session.resolve failed")
        }
        sessionStore.setActive(key)
        self.chatClient = ChatClient(transport: transport, sessionKey: key)
        _ = try? await reloadHistory()
    }

    // Local-only — the server creates the session lazily on first chat.send.
    func newSession(key: String, displayName: String?) async throws {
        let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let display = trimmed.isEmpty ? SessionStore.defaultDisplayName(for: key) : trimmed
        sessionStore.upsert(.init(key: key, displayName: display, unreadCount: 0))
        try await switchSession(to: key)
    }

    // Record the wall-clock time when the scene left .active. Called from the
    // scenePhase observer on both .inactive and .background transitions.
    func noteBackgrounded() {
        lastBackgroundedAt = nowProvider()
    }

    // Called on scene .active when the previous phase was .inactive or .background.
    // Two concerns:
    //  - If the transport is not currently connected, restart the pipeline via start()
    //    so a stale socket from the suspended app gets rebuilt.
    //  - If we are still connected, silently refresh the focused session's head
    //    so the user never sees stale chat after returning from background.
    //    Debounced inside refreshHeadIfNeeded to avoid spamming the gateway on
    //    rapid background/foreground toggles.
    func handleForegroundTransition() async {
        lastBackgroundedAt = nil

        if launchConfiguration.gateway == .seededLocal {
            startSeededSession()
            return
        }

        let isConnected: Bool
        if case .connected = connectionStore.status { isConnected = true } else { isConnected = false }

        if !isConnected {
            await start()
            return
        }
        await refreshHeadIfNeeded(for: sessionStore.activeSessionKey)
    }

    func clearToken() async {
        try? KeychainStore.delete(for: gatewayURL)
        await transport?.disconnect()
        self.transport = nil
        self.chatClient = nil
        connectionStore.markIdle()
    }

    func sendMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let client = chatClient else { return }
        chatStore.appendUser(trimmed)
        currentAssistantId = nil
        do {
            let stream = try await client.send(trimmed)
            for await event in stream {
                switch event {
                case .text(content: let chunk, replace: let replace):
                    if let id = currentAssistantId {
                        if replace {
                            chatStore.replaceAssistantText(chunk, id: id)
                        } else {
                            chatStore.appendDelta(chunk, to: id)
                        }
                    } else {
                        let id = chatStore.beginAssistantTurn()
                        currentAssistantId = id
                        chatStore.replaceAssistantText(chunk, id: id)
                    }
                case .done:
                    if let id = currentAssistantId { chatStore.finalizeAssistant(id: id) }
                    currentAssistantId = nil
                case .error(let code, let message):
                    if let id = currentAssistantId { chatStore.finalizeAssistant(id: id) }
                    chatStore.appendError("[\(code)] \(message)")
                    currentAssistantId = nil
                case .systemMessage(let s):
                    chatStore.appendSystem(s)
                case .toolStart, .toolResult, .permissionRequest, .intentionSurface, .regionsUpdate,
                     .whenArmed, .whenDisarmed, .voiceprintIdentity:
                    continue
                }
            }
        } catch {
            chatStore.appendError("\(error)")
        }
    }

    private func startSeededSession() {
        guard let seedData else { return }
        let requestedActiveSessionKey = sessionStore.activeSessionKey
        LaunchSeedFixtures.installRecordings(for: launchConfiguration.seedProfile)
        if let connectionError = seedData.connectionError {
            connectionStore.markError(connectionError)
        } else {
            connectionStore.markConnected(connId: seedData.connectionID)
        }
        sessionStore.replaceAll(seedData.sessions)
        let activeSessionKey = seedData.sessions.contains(where: { $0.key == requestedActiveSessionKey })
            ? requestedActiveSessionKey
            : seedData.activeSessionKey
        sessionStore.setActive(activeSessionKey)
        _ = installSeededMessages(for: activeSessionKey)
    }

    @discardableResult
    private func installSeededMessages(for sessionKey: String) -> Int {
        let messages = seedData?.messages(for: sessionKey) ?? []
        chatStore.replaceAllWithCursor(
            messages,
            oldest: messages.isEmpty ? nil : 0,
            hasMore: false,
            newest: messages.isEmpty ? nil : messages.count - 1
        )
        return messages.count
    }
}
