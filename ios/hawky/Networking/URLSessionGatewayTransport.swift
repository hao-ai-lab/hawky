import Foundation
import os

// URLSessionGatewayTransport — real WebSocket client.
// Hardening notes (critical rules):
//  - iOS compat: do NOT set `Sec-WebSocket-Extensions: permessage-deflate`.
//    Let URLSession default; the server explicitly disables deflate for iOS.
//  - Every unparseable inbound frame is logged with raw JSON, never silently dropped.
//  - Token lives at params.token top-level in the connect frame (never nested under auth).
final class URLSessionGatewayTransport: GatewayTransport, @unchecked Sendable {
    private let session: URLSession
    private let correlator: Correlator
    private let handshakeTimeoutSeconds: TimeInterval

    private struct State {
        var task: URLSessionWebSocketTask?
        var readLoopTask: Task<Void, Never>?
        var eventContinuation: AsyncStream<EventFrame>.Continuation?
        var eventStream: AsyncStream<EventFrame>?
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
        let startedAt = Date()
        var request = URLRequest(url: url)
        CloudflareAccessStore.applyHeaders(to: &request, requestURL: url)
        // DO NOT set Sec-WebSocket-Extensions here — Hardening note: iOS deflate compat.
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
        // WARNING: token at params.token top-level — Hardening note: token placement.
        // Never nest under `auth`. The server reads `params.token` directly.
        var params: [String: JSONValue] = [
            "version": .string(connectParams.version),
            "platform": .string(connectParams.platform),
            "token": .string(connectParams.token),
            "sessionKey": .string(connectParams.sessionKey),
            "role": .string(connectParams.role ?? "client")
        ]
        // M6 §3.6: forward the ambient mode so the gateway gates latent recognition
        // correctly. Without this the gateway defaults conn.mode to "quiet" and the
        // recognizer never runs. (This manual dict previously dropped `mode`.)
        if let mode = connectParams.mode {
            params["mode"] = .string(mode)
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
            // Handshake failed — close with 4000 and propagate.
            ws.cancel(with: .init(rawValue: 4000) ?? .normalClosure, reason: nil)
            await correlator.rejectAll(error: GatewayTransportError.handshakeTimeout)
            Self.logConnect(
                url: url,
                platform: connectParams.platform,
                sessionKey: connectParams.sessionKey,
                ok: false,
                duration: Date().timeIntervalSince(startedAt),
                error: "\(error)"
            )
            throw error
        }

        if response.ok {
            guard let payload = response.payload else {
                throw GatewayTransportError.decodeError(message: "hello missing payload")
            }
            let hello = try decodeHello(from: payload)
            state.withLock { $0.connected = true }
            Self.logConnect(
                url: url,
                platform: connectParams.platform,
                sessionKey: connectParams.sessionKey,
                ok: true,
                duration: Date().timeIntervalSince(startedAt),
                error: nil
            )
            return hello
        } else {
            Self.logConnect(
                url: url,
                platform: connectParams.platform,
                sessionKey: connectParams.sessionKey,
                ok: false,
                duration: Date().timeIntervalSince(startedAt),
                error: response.error?.message
            )
            if response.error?.code == "UNAUTHORIZED" {
                // Do not retry — caller (ReconnectingTransport) must decide.
                throw GatewayTransportError.unauthorized
            }
            throw GatewayTransportError.decodeError(message: response.error?.message ?? "connect failed")
        }
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        try await send(frame, timeout: nil)
    }

    func send(_ frame: RequestFrame, timeout: TimeInterval?) async throws -> ResponseFrame {
        let ws = state.withLock { $0.task }
        guard let ws else { throw GatewayTransportError.notConnected }
        let startedAt = Date()
        let summary = Self.summarize(frame: frame)
        let pendingBefore = await correlator.pendingCount()
        async let registered = correlator.register(id: frame.id, timeout: timeout)
        let encodeStartedAt = Date()
        let encoded: (message: URLSessionWebSocketTask.Message, byteCount: Int)
        do {
            encoded = try encode(frame: frame)
        } catch {
            state.withLock { $0.connected = false }
            Self.logSend(
                method: frame.method,
                ok: false,
                duration: Date().timeIntervalSince(startedAt),
                error: "\(error)",
                diagnostics: SendDiagnostics(
                    summary: summary,
                    requestBytes: nil,
                    pendingBefore: pendingBefore,
                    pendingAfter: await correlator.pendingCount(),
                    encodeDuration: Date().timeIntervalSince(encodeStartedAt),
                    socketSendDuration: nil,
                    responseWaitDuration: nil
                )
            )
            throw error
        }
        let encodeDuration = Date().timeIntervalSince(encodeStartedAt)
        let sendStartedAt = Date()
        do {
            try await ws.send(encoded.message)
        } catch {
            state.withLock { $0.connected = false }
            Self.logSend(
                method: frame.method,
                ok: false,
                duration: Date().timeIntervalSince(startedAt),
                error: "\(error)",
                diagnostics: SendDiagnostics(
                    summary: summary,
                    requestBytes: encoded.byteCount,
                    pendingBefore: pendingBefore,
                    pendingAfter: await correlator.pendingCount(),
                    encodeDuration: encodeDuration,
                    socketSendDuration: Date().timeIntervalSince(sendStartedAt),
                    responseWaitDuration: nil
                )
            )
            throw error
        }
        let socketSendDuration = Date().timeIntervalSince(sendStartedAt)
        let waitStartedAt = Date()
        do {
            let response = try await registered
            Self.logSend(
                method: frame.method,
                ok: response.ok,
                duration: Date().timeIntervalSince(startedAt),
                error: response.error?.message,
                diagnostics: SendDiagnostics(
                    summary: summary,
                    requestBytes: encoded.byteCount,
                    pendingBefore: pendingBefore,
                    pendingAfter: await correlator.pendingCount(),
                    encodeDuration: encodeDuration,
                    socketSendDuration: socketSendDuration,
                    responseWaitDuration: Date().timeIntervalSince(waitStartedAt)
                )
            )
            return response
        } catch {
            Self.logSend(
                method: frame.method,
                ok: false,
                duration: Date().timeIntervalSince(startedAt),
                error: "\(error)",
                diagnostics: SendDiagnostics(
                    summary: summary,
                    requestBytes: encoded.byteCount,
                    pendingBefore: pendingBefore,
                    pendingAfter: await correlator.pendingCount(),
                    encodeDuration: encodeDuration,
                    socketSendDuration: socketSendDuration,
                    responseWaitDuration: Date().timeIntervalSince(waitStartedAt)
                )
            )
            throw error
        }
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
        try await ws.send(try encode(frame: frame).message)
    }

    private func encode(frame: RequestFrame) throws -> (message: URLSessionWebSocketTask.Message, byteCount: Int) {
        let data = try JSONEncoder().encode(frame)
        guard let str = String(data: data, encoding: .utf8) else {
            throw GatewayTransportError.decodeError(message: "failed to stringify frame")
        }
        return (.string(str), data.count)
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
                    // Socket closed / errored — propagate to correlator and exit.
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
                // Hardening note: log unknown frames with full raw payload; do NOT throw.
                NSLog("[GatewayTransport] unknown frame: \(rawJSON)")
                DebugFrameLog.shared.append(raw: rawJSON, reason: "unknown frame type")
            }
        } catch {
            // Parse failure — log raw JSON and continue. Never tear down the socket on a bad frame.
            NSLog("[GatewayTransport] parse failed: \(error) raw=\(raw)")
            DebugFrameLog.shared.append(raw: raw, reason: "parse failed: \(error)")
        }
    }

    private static func logConnect(
        url: URL,
        platform: String,
        sessionKey: String,
        ok: Bool,
        duration: TimeInterval,
        error: String?
    ) {
        let host = url.host ?? url.absoluteString
        let ms = Int((duration * 1000).rounded())
        let suffix = error.map { " error=\($0.prefix(120))" } ?? ""
        NSLog("[GatewayTransport] connect \(ok ? "ok" : "error") platform=\(platform) host=\(host) session=\(sessionKey) duration_ms=\(ms)\(suffix)")
    }

    private struct SendDiagnostics {
        let summary: FrameSummary
        let requestBytes: Int?
        let pendingBefore: Int
        let pendingAfter: Int
        let encodeDuration: TimeInterval?
        let socketSendDuration: TimeInterval?
        let responseWaitDuration: TimeInterval?
    }

    private struct FrameSummary {
        let mediaKind: String?
        let mime: String?
        let mediaID: String?
        let sessionKey: String?
        let base64Chars: Int?
    }

    private static func summarize(frame: RequestFrame) -> FrameSummary {
        guard let params = frame.params else {
            return FrameSummary(
                mediaKind: nil,
                mime: nil,
                mediaID: nil,
                sessionKey: nil,
                base64Chars: nil
            )
        }
        func string(_ key: String) -> String? {
            if case .string(let value)? = params[key] { return value }
            return nil
        }
        let bytesLen: Int?
        if case .string(let bytes)? = params["bytes"] {
            bytesLen = bytes.count
        } else {
            bytesLen = nil
        }
        return FrameSummary(
            mediaKind: string("media_kind"),
            mime: string("mime"),
            mediaID: string("media_id"),
            sessionKey: string("session_key"),
            base64Chars: bytesLen
        )
    }

    private static func logSend(
        method: String,
        ok: Bool,
        duration: TimeInterval,
        error: String?,
        diagnostics: SendDiagnostics
    ) {
        let ms = Int((duration * 1000).rounded())
        let isMediaChunk = method == "media.chunk.upload"
        guard !isMediaChunk || !ok || ms >= 500 else { return }
        let suffix = error.map { " error=\($0.prefix(120))" } ?? ""
        let encode = diagnostics.encodeDuration.map { " encode_ms=\(Int(($0 * 1000).rounded()))" } ?? ""
        let socket = diagnostics.socketSendDuration.map { " ws_send_ms=\(Int(($0 * 1000).rounded()))" } ?? ""
        let wait = diagnostics.responseWaitDuration.map { " wait_ms=\(Int(($0 * 1000).rounded()))" } ?? ""
        let requestBytes = diagnostics.requestBytes.map { " request_bytes=\($0)" } ?? ""
        let b64 = diagnostics.summary.base64Chars.map { " b64_chars=\($0)" } ?? ""
        let mediaKind = diagnostics.summary.mediaKind.map { " media_kind=\($0)" } ?? ""
        let mime = diagnostics.summary.mime.map { " mime=\($0.prefix(40))" } ?? ""
        let mediaID = diagnostics.summary.mediaID.map { " media_id=\($0.prefix(64))" } ?? ""
        let sessionKey = diagnostics.summary.sessionKey.map { " session_key=\($0.prefix(64))" } ?? ""
        NSLog("[GatewayTransport] rpc \(ok ? "ok" : "error") method=\(method) duration_ms=\(ms) pending_before=\(diagnostics.pendingBefore) pending_after=\(diagnostics.pendingAfter)\(encode)\(socket)\(wait)\(requestBytes)\(b64)\(mediaKind)\(mime)\(mediaID)\(sessionKey)\(suffix)")
    }
}
