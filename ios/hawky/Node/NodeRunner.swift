import Foundation

// NodeRunner — owns the node-role WebSocket, performs the Hawky handshake,
// dispatches invoke requests to NodeCommand implementations, and reconnects
// with full-jitter exponential backoff on disconnect.
//
// Wire protocol (see docs/research/node-protocol.md):
//   1. Open WS at <gatewayURL>/ws
//   2. RPC { method: "connect",
//            params: { version, platform, token, role: "node",
//                      node: { nodeId, name, commands } } }
//      → HelloPayload with connId, serverVersion, methods.
//   3. Incoming events:
//        - "tick"                  — liveness probe; reset timer
//        - "node.invoke.request"   — dispatch to command registry
//        - "node.invoke.cancel"    — cancel in-flight invoke
//   4. Outgoing reply: RPC { method: "node.invoke.result",
//                            params: { id, nodeId, ok, payloadJSON?, error? } }
//
// Close codes:
//   1008 — auth rejected. Re-auth via onAuthFailed, then reconnect.
//   4001 — evicted by another node with the same nodeId. STOP, do not reconnect.
//   anything else — reconnect with full-jitter exponential backoff.

@MainActor
final class NodeRunner {

    // Status surfaced to the UI. `registering` = pre-hello; `connected` = hello
    // received, reader active; `disconnected` = reader exited, backoff pending.
    enum Status: Equatable { case registering, connected, disconnected, stopped }

    // MARK: - Configuration

    struct Config {
        /// Persisted node identifier (UUID). Stable across launches.
        let nodeId: String
        /// Human-readable name displayed in the gateway's node list.
        let name: String
        /// Base http(s) URL of the gateway. `/ws` is appended for the socket.
        let gatewayURL: URL
        /// Client platform string. Gateway uses it for diagnostics.
        let platform: String
        /// Initial device JWT. May be refreshed via onAuthFailed.
        var token: String
    }

    // MARK: - State

    private var config: Config
    private let transport: NodeTransport
    private let commands: [String: any NodeCommand]

    // Backoff parameters — full jitter, matches ReconnectingTransport's policy
    // and hawky/src/node/runner.ts:24-25 (1s base, 30s cap).
    private let baseBackoff: TimeInterval
    private let capBackoff: TimeInterval
    private let randomDouble: @Sendable () -> Double

    private var readerTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var activeInvokes: [String: Task<Void, Never>] = [:]
    private var stopped = false
    private(set) var lastHello: HelloPayload?
    /// Exposed for tests — current reconnect attempt count (resets on success).
    private(set) var attempt: Int = 0
    /// UI-visible registration status. Updated at each lifecycle transition.
    private(set) var status: Status = .disconnected
    /// Persisted nodeId, surfaced for UI display.
    var nodeId: String { config.nodeId }

    /// Called when the gateway rejects our token (close 1008). Must return a
    /// fresh token or nil; nil means give up and stay disconnected.
    var onAuthFailed: (@Sendable () async -> String?)?
    /// Called when another process evicts us (close 4001). Terminal.
    var onEvicted: (@MainActor @Sendable () -> Void)?

    // MARK: - Init

    init(config: Config,
         transport: NodeTransport,
         commands: [any NodeCommand],
         baseBackoff: TimeInterval = 1.0,
         capBackoff: TimeInterval = 30.0,
         randomDouble: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }) {
        self.config = config
        self.transport = transport
        self.baseBackoff = baseBackoff
        self.capBackoff = capBackoff
        self.randomDouble = randomDouble
        var map: [String: any NodeCommand] = [:]
        for cmd in commands { map[type(of: cmd).name] = cmd }
        self.commands = map
    }

    // MARK: - Derived

    /// Translate http(s) → ws(s) and append /ws path, matching
    /// hawky/src/node/runner.ts:79-82.
    private var websocketURL: URL {
        var comps = URLComponents(url: config.gatewayURL, resolvingAgainstBaseURL: false)!
        switch comps.scheme {
        case "https": comps.scheme = "wss"
        case "http": comps.scheme = "ws"
        default: break
        }
        let base = comps.url ?? config.gatewayURL
        if base.path.hasSuffix("/ws") || base.path.hasSuffix("/ws/") {
            return base
        }
        return base.appendingPathComponent("ws")
    }

    private var advertisedCommands: [String] {
        commands.keys.sorted()
    }

    // MARK: - Public lifecycle

    /// Connect once, register with the node registry, and start the event
    /// reader loop. Throws on handshake failure. Callers can ignore the
    /// error and call start() again to enter the reconnect loop instead.
    func connect() async throws {
        stopped = false
        let params = ConnectParams(
            version: "1",
            platform: config.platform,
            token: config.token,
            sessionKey: "",
            role: "node",
            node: ConnectParams.NodeBundle(
                nodeId: config.nodeId,
                name: config.name,
                commands: advertisedCommands
            )
        )
        self.status = .registering
        let hello = try await transport.connect(url: websocketURL, connectParams: params)
        self.lastHello = hello
        self.attempt = 0
        self.status = .connected
        startReader()
    }

    /// Connect and retry forever with full-jitter backoff. Returns only when
    /// `stop()` is called or the runner is evicted.
    func start() async {
        stopped = false
        while !stopped {
            do {
                try await connect()
                // Wait until the reader task exits (disconnect / error).
                await readerTask?.value
                readerTask = nil
                self.status = .disconnected
                if stopped { return }
            } catch GatewayTransportError.unauthorized {
                if let refresher = onAuthFailed, let fresh = await refresher() {
                    config.token = fresh
                    attempt = 0
                    continue
                }
                NSLog("[NodeRunner] auth failed and no refresher; stopping")
                return
            } catch {
                if stopped { return }
            }

            if stopped { return }
            await sleepBackoff()
        }
    }

    /// Stop reconnecting and close the socket. Idempotent.
    func stop() async {
        stopped = true
        reconnectTask?.cancel()
        reconnectTask = nil
        readerTask?.cancel()
        readerTask = nil
        for (_, t) in activeInvokes { t.cancel() }
        activeInvokes.removeAll()
        await transport.disconnect()
        self.status = .stopped
    }

    // MARK: - Event reader

    private func startReader() {
        readerTask?.cancel()
        let stream = transport.events()
        readerTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                await self.handle(event: event)
            }
        }
    }

    private func handle(event: EventFrame) async {
        switch event.event {
        case "tick":
            // Liveness; no action needed at MVP scope. Future: tick watchdog.
            return
        case "node.invoke.request":
            await dispatchInvoke(payload: event.payload)
        case "node.invoke.cancel":
            cancelInvoke(payload: event.payload)
        case "agent.system_message",
             "agent.text",
             "agent.tool_use_start",
             "agent.tool_result",
             "agent.done":
            // Benign agent-loop events emitted by hawky; hawky's NodeRunner
            // only handles node.invoke.* RPCs, so these are expected no-ops.
            return
        default:
            NSLog("[NodeRunner] unhandled event: \(event.event)")
        }
    }

    // MARK: - Invoke dispatch

    /// Exposed for tests. Parses an invoke payload, dispatches to a command,
    /// and sends `node.invoke.result` back.
    func dispatchInvoke(payload: JSONValue?) async {
        guard case let .object(obj) = payload ?? .null,
              case let .some(.string(invokeId)) = obj["id"],
              case let .some(.string(command)) = obj["command"] else {
            NSLog("[NodeRunner] invalid node.invoke.request payload")
            return
        }
        let argsJSON: JSONValue
        if case let .some(.string(paramsJSON)) = obj["paramsJSON"],
           let data = paramsJSON.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(JSONValue.self, from: data) {
            argsJSON = decoded
        } else {
            argsJSON = .null
        }

        let task = Task { [weak self] in
            guard let self else { return }
            await self.runAndReply(invokeId: invokeId, command: command, args: argsJSON)
        }
        activeInvokes[invokeId] = task
    }

    private func runAndReply(invokeId: String, command: String, args: JSONValue) async {
        defer { activeInvokes.removeValue(forKey: invokeId) }
        guard let handler = commands[command] else {
            await sendResult(id: invokeId,
                             ok: false,
                             payload: nil,
                             error: NodeCommandError.unknownCommand(command).message)
            return
        }
        do {
            let payload = try await handler.invoke(args: args)
            await sendResult(id: invokeId, ok: true, payload: payload, error: nil)
        } catch {
            let message = (error as? NodeCommandError)?.message ?? "\(error)"
            await sendResult(id: invokeId, ok: false, payload: nil, error: message)
        }
    }

    private func cancelInvoke(payload: JSONValue?) {
        guard case let .object(obj) = payload ?? .null,
              case let .some(.string(id)) = obj["id"] else { return }
        activeInvokes[id]?.cancel()
        activeInvokes.removeValue(forKey: id)
    }

    /// Send `node.invoke.result` back to the gateway. NOTE: this is a
    /// `req` frame, not `res` — the node initiates the RPC even though it's
    /// a reply. See docs/research/node-protocol.md gotcha #1.
    private func sendResult(id: String, ok: Bool, payload: JSONValue?, error: String?) async {
        var params: [String: JSONValue] = [
            "id": .string(id),
            "nodeId": .string(config.nodeId),
            "ok": .bool(ok),
        ]
        if let payload, ok {
            // payloadJSON is a JSON-encoded STRING, not an object.
            // docs/research/node-protocol.md gotcha #2.
            if let data = try? JSONEncoder().encode(payload),
               let str = String(data: data, encoding: .utf8) {
                params["payloadJSON"] = .string(str)
            }
        }
        if let error {
            params["error"] = .string(error)
        }
        let frame = RequestFrame(id: "node-req-\(UUID().uuidString)",
                                 method: "node.invoke.result",
                                 params: params)
        do {
            _ = try await transport.send(frame)
        } catch {
            NSLog("[NodeRunner] failed to send invoke result: \(error)")
        }
    }

    // MARK: - Backoff

    private func sleepBackoff() async {
        let ceiling = min(capBackoff, baseBackoff * pow(2.0, Double(attempt)))
        let delay = randomDouble() * ceiling
        attempt = min(attempt + 1, 16)  // cap attempt at 2^16 even though ceiling caps anyway
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
    }
}
