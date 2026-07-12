import Foundation

enum GatewayTransportError: Error, Equatable {
    case handshakeTimeout
    case unauthorized
    case closed(code: Int, reason: String)
    case decodeError(message: String)
    case notConnected
    case abandoned

    static func == (lhs: GatewayTransportError, rhs: GatewayTransportError) -> Bool {
        switch (lhs, rhs) {
        case (.handshakeTimeout, .handshakeTimeout),
             (.unauthorized, .unauthorized),
             (.notConnected, .notConnected),
             (.abandoned, .abandoned):
            return true
        case let (.closed(a, b), .closed(c, d)):
            return a == c && b == d
        case let (.decodeError(a), .decodeError(b)):
            return a == b
        default:
            return false
        }
    }
}

protocol GatewayTransport: Sendable {
    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload
    func send(_ frame: RequestFrame) async throws -> ResponseFrame
    /// Send awaiting the RPC response with a custom correlator timeout. Needed
    /// for long-running RPCs like `chat.send`, whose response only arrives after
    /// a full background agent turn (can exceed the default 30s). `nil` uses the
    /// correlator default.
    func send(_ frame: RequestFrame, timeout: TimeInterval?) async throws -> ResponseFrame
    func events() -> AsyncStream<EventFrame>
    func disconnect() async
    // True iff a successful hello has been received and no subsequent send/read error or disconnect
    // has been observed. Used by callers to short-circuit RPCs on a known-dead socket.
    var isConnected: Bool { get }
    /// Register a callback fired at most once per established connection when the
    /// socket dies WITHOUT the client asking for it (gateway restart, network drop,
    /// read/send error). Never fired for `disconnect()` or handshake failures — those
    /// surface synchronously to the caller. This is the seam AppContainer uses to
    /// supervise the main ("ios:main") connection and reconnect with backoff; without
    /// it a gateway restart silently killed the lifeline until the app was force-quit.
    /// Default implementation is a no-op (mocks / wrappers that don't detect closes).
    func setUnexpectedCloseHandler(_ handler: @escaping @Sendable (_ code: Int, _ reason: String) -> Void)
}

typealias GatewayTransportResolver = @MainActor @Sendable () async -> GatewayTransport?

extension GatewayTransport {
    /// Default: ignore the custom timeout (use the plain send). Concrete
    /// transports that support per-call timeouts override this.
    func send(_ frame: RequestFrame, timeout: TimeInterval?) async throws -> ResponseFrame {
        try await send(frame)
    }

    var isConnected: Bool { false }

    /// Default: no close detection. Concrete transports that own a real socket
    /// (URLSessionGatewayTransport) override this and invoke the handler from
    /// their read/send failure paths.
    func setUnexpectedCloseHandler(_ handler: @escaping @Sendable (_ code: Int, _ reason: String) -> Void) {}
}
