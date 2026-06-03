import Foundation
import os

// NodeTransport — WebSocket carrier for the Hawky node role.
//
// Separate from the client GatewayTransport because a single Hawky
// connection is either client-bound (session, ChatClient) or node-bound
// (registry, invoke dispatch) — not both. We reuse the RequestFrame /
// ResponseFrame / EventFrame / JSONValue types but keep the state machine
// independent.
//
// Protocol reference: docs/research/node-protocol.md — the node handshake
// is identical to the client except `role="node"` and a `node` bundle.

/// Interface the NodeRunner uses to talk to the gateway. Tests inject a
/// mock that drives events synchronously without a real socket.
protocol NodeTransport: AnyObject, Sendable {
    /// Open a WebSocket and send `connect` with role="node". Returns the
    /// gateway's HelloPayload on success. Throws on transport failure or
    /// a non-ok response.
    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload

    /// Send an RPC request frame and await the matching response.
    func send(_ frame: RequestFrame) async throws -> ResponseFrame

    /// Server-initiated events (tick, node.invoke.request, node.invoke.cancel).
    func events() -> AsyncStream<EventFrame>

    /// Close the WebSocket. Idempotent.
    func disconnect() async

    /// True iff the socket has received a successful hello and has not
    /// since observed an error.
    var isConnected: Bool { get }
}

// MARK: - URLSession implementation

/// Real WebSocket NodeTransport backed by URLSessionWebSocketTask.
/// Mirrors URLSessionGatewayTransport's hardening notes:
///  - No `Sec-WebSocket-Extensions: permessage-deflate` header.
///  - `params.token` at top level (never nested under auth).
///  - Unknown frames logged to NSLog, never silently dropped.
final class URLSessionNodeTransport: NodeTransport, @unchecked Sendable {
    private let session: URLSession
    private let correlator: Correlator
    private let handshakeTimeoutSeconds: TimeInterval

    private struct State {
        var task: URLSessionWebSocketTask?
        var readLoopTask: Task<Void, Never>?
        var eventStream: AsyncStream<EventFrame>?
        var eventContinuation: AsyncStream<EventFrame>.Continuation?
        var closed = false
        var connected = false
    }
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    var isConnected: Bool {
        state.withLock { $0.connected && !$0.closed }
    }

    init(session: URLSession = .shared,
         correlator: Correlator = Correlator(),
         handshakeTimeoutSeconds: TimeInterval = 10) {
        self.session = session
        self.correlator = correlator
        self.handshakeTimeoutSeconds = handshakeTimeoutSeconds
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        var request = URLRequest(url: url)
        CloudflareAccessStore.applyHeaders(to: &request, requestURL: url)
        let ws = session.webSocketTask(with: request)

        let (stream, continuation) = AsyncStream<EventFrame>.makeStream()

        state.withLock {
            $0.task = ws
            $0.eventStream = stream
            $0.eventContinuation = continuation
            $0.closed = false
        }

        ws.resume()
        startReadLoop(ws: ws)

        let id = UUID().uuidString
        var params: [String: JSONValue] = [
            "version": .string(connectParams.version),
            "platform": .string(connectParams.platform),
            "token": .string(connectParams.token),
            "role": .string(connectParams.role ?? "node")
        ]
        if let node = connectParams.node {
            params["node"] = .object([
                "nodeId": .string(node.nodeId),
                "name": .string(node.name),
                "commands": .array(node.commands.map { .string($0) })
            ])
        }
        let frame = RequestFrame(id: id, method: "connect", params: params)

        let response: ResponseFrame
        do {
            try await encodeAndSend(frame: frame, on: ws)
            response = try await withThrowingTaskGroup(of: ResponseFrame.self) { [correlator, handshakeTimeoutSeconds] group in
                group.addTask { try await correlator.register(id: id) }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(handshakeTimeoutSeconds * 1_000_000_000))
                    throw GatewayTransportError.handshakeTimeout
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
        } catch {
            ws.cancel(with: .init(rawValue: 4000) ?? .normalClosure, reason: nil)
            await correlator.rejectAll(error: GatewayTransportError.handshakeTimeout)
            throw error
        }

        if response.ok {
            guard let payload = response.payload else {
                throw GatewayTransportError.decodeError(message: "hello missing payload")
            }
            let hello = try decodeHello(from: payload)
            state.withLock { $0.connected = true }
            return hello
        } else {
            if response.error?.code == "UNAUTHORIZED" {
                throw GatewayTransportError.unauthorized
            }
            throw GatewayTransportError.decodeError(message: response.error?.message ?? "connect failed")
        }
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        let ws = state.withLock { $0.task }
        guard let ws else { throw GatewayTransportError.notConnected }
        async let registered = correlator.register(id: frame.id)
        do {
            try await encodeAndSend(frame: frame, on: ws)
        } catch {
            state.withLock { $0.connected = false }
            throw error
        }
        return try await registered
    }

    func events() -> AsyncStream<EventFrame> {
        state.withLock { s in
            if let existing = s.eventStream { return existing }
            let (stream, continuation) = AsyncStream<EventFrame>.makeStream()
            s.eventStream = stream
            s.eventContinuation = continuation
            return stream
        }
    }

    func disconnect() async {
        let (ws, loop, cont) = state.withLock { s -> (URLSessionWebSocketTask?, Task<Void, Never>?, AsyncStream<EventFrame>.Continuation?) in
            let ws = s.task
            let loop = s.readLoopTask
            let cont = s.eventContinuation
            s.task = nil
            s.readLoopTask = nil
            s.eventContinuation = nil
            s.eventStream = nil
            s.closed = true
            s.connected = false
            return (ws, loop, cont)
        }
        loop?.cancel()
        ws?.cancel(with: .normalClosure, reason: nil)
        cont?.finish()
        await correlator.rejectAll(error: GatewayTransportError.closed(code: 1000, reason: "client"))
    }

    // MARK: - internals

    private func encodeAndSend(frame: RequestFrame, on ws: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(frame)
        guard let str = String(data: data, encoding: .utf8) else {
            throw GatewayTransportError.decodeError(message: "failed to stringify frame")
        }
        try await ws.send(.string(str))
    }

    private func decodeHello(from payload: JSONValue) throws -> HelloPayload {
        let data = try JSONEncoder().encode(payload)
        do {
            return try JSONDecoder().decode(HelloPayload.self, from: data)
        } catch {
            throw GatewayTransportError.decodeError(message: "hello decode: \(error)")
        }
    }

    private func startReadLoop(ws: URLSessionWebSocketTask) {
        let task = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let msg = try await ws.receive()
                    let data: Data
                    switch msg {
                    case .string(let s): data = Data(s.utf8)
                    case .data(let d): data = d
                    @unknown default: continue
                    }
                    await self.handleIncoming(data: data)
                } catch {
                    let closeCode = ws.closeCode.rawValue
                    let reason = (ws.closeReason.flatMap { String(data: $0, encoding: .utf8) }) ?? "\(error)"
                    await self.correlator.rejectAll(error: GatewayTransportError.closed(code: closeCode, reason: reason))
                    let cont = self.state.withLock { s -> AsyncStream<EventFrame>.Continuation? in
                        let c = s.eventContinuation
                        s.eventContinuation = nil
                        s.eventStream = nil
                        s.connected = false
                        return c
                    }
                    cont?.finish()
                    return
                }
            }
        }
        state.withLock { $0.readLoopTask = task }
    }

    private func handleIncoming(data: Data) async {
        let raw = String(data: data, encoding: .utf8) ?? "<non-utf8 \(data.count) bytes>"
        do {
            let frame = try JSONDecoder().decode(IncomingFrame.self, from: data)
            switch frame {
            case .response(let r):
                await correlator.resolve(r)
            case .event(let e):
                let cont = state.withLock { $0.eventContinuation }
                cont?.yield(e)
            case .unknown(let rawJSON):
                NSLog("[NodeTransport] unknown frame: \(rawJSON)")
            }
        } catch {
            NSLog("[NodeTransport] parse failed: \(error) raw=\(raw)")
        }
    }
}
