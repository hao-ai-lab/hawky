import Testing
import Foundation
@testable import hawky

// Covers task #19: the main "ios:main" gateway connection must survive gateway
// restarts. Exercises AppContainer's unexpected-close supervision — the seam
// URLSessionGatewayTransport fires when the socket dies without disconnect()
// being called — and the full-jitter reconnect loop it kicks off.
//
// Field context: after a gateway restart the live bridge sockets reconnected
// within seconds, but the main ChatClient socket stayed dead until force-quit
// (ConnectionStore stuck on .connected, so even the foreground path skipped
// start()). media.chunk.upload silently stopped and live recordings were lost.

// Mock transport that records the unexpected-close handler so tests can
// simulate a gateway restart, and counts connects so tests can observe the
// reconnect loop re-dialing the SAME instance (identity preservation is load-
// bearing: uploaders capture the transport reference at recording start).
final class SupervisedMockTransport: GatewayTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _connected = false
    private var _closeHandler: (@Sendable (Int, String) -> Void)?
    private(set) var connectCount = 0
    private(set) var sendCount = 0
    /// Number of upcoming connect() calls that should fail (simulates the
    /// gateway still booting while the reconnect loop is already dialing).
    var failConnects = 0

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return _connected
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        lock.lock()
        connectCount += 1
        let shouldFail = failConnects > 0
        if shouldFail { failConnects -= 1 } else { _connected = true }
        lock.unlock()
        if shouldFail {
            throw GatewayTransportError.closed(code: 1006, reason: "mock gateway still booting")
        }
        let json = #"{"connId":"mock","serverVersion":"test","methods":[]}"#
        return try JSONDecoder().decode(HelloPayload.self, from: Data(json.utf8))
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        lock.lock(); sendCount += 1; lock.unlock()
        let json = "{\"type\":\"res\",\"id\":\"\(frame.id)\",\"ok\":true}"
        return try JSONDecoder().decode(ResponseFrame.self, from: Data(json.utf8))
    }

    func events() -> AsyncStream<EventFrame> { AsyncStream { _ in } }

    func disconnect() async {
        lock.lock(); _connected = false; lock.unlock()
    }

    func setUnexpectedCloseHandler(_ handler: @escaping @Sendable (_ code: Int, _ reason: String) -> Void) {
        lock.lock(); _closeHandler = handler; lock.unlock()
    }

    /// Simulate the socket dying out from under the app (gateway restart):
    /// isConnected flips false, then the armed handler fires — same order as
    /// URLSessionGatewayTransport's read-loop failure path.
    func simulateUnexpectedClose(code: Int, reason: String) {
        lock.lock()
        _connected = false
        let handler = _closeHandler
        lock.unlock()
        handler?(code, reason)
    }
}

@Suite @MainActor
struct MainConnectionReconnectTests {

    // Poll until `condition` holds. The reconnect path hops through detached
    // Tasks (close handler → MainActor task → loop task), so assertions after
    // simulateUnexpectedClose must await convergence rather than fire inline.
    private func waitUntil(
        timeout: TimeInterval = 5,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        if !condition() { Issue.record("timed out waiting for condition") }
    }

    private func makeStartedContainer(mock: SupervisedMockTransport) async -> AppContainer {
        let container = AppContainer()
        try? KeychainStore.save(token: "test-token", for: container.gatewayURL)
        container.transportFactory = { mock }
        await container.start()
        return container
    }

    // Gateway restart → close handler fires → reconnect loop re-dials the same
    // transport instance and restores .connected. This is the exact device-
    // observed failure that previously required a force-quit.
    @Test func unexpectedCloseReconnectsAndRestoresStatus() async throws {
        let mock = SupervisedMockTransport()
        let container = await makeStartedContainer(mock: mock)
        defer { try? KeychainStore.delete(for: container.gatewayURL) }
        #expect(mock.connectCount == 1)

        mock.simulateUnexpectedClose(code: 1006, reason: "gateway restart")

        try await waitUntil {
            mock.connectCount >= 2 && !container._testIsReconnectLoopRunning
        }
        #expect(mock.isConnected)
        if case .connected = container.connectionStore.status {
            // ok — status mirror recovered, so the foreground path and the
            // status dot both see reality again.
        } else {
            Issue.record("expected .connected after reconnect, got \(container.connectionStore.status)")
        }
        // Post-connect handshake re-ran (session.list / session.history RPCs).
        #expect(mock.sendCount >= 2)
    }

    // First reconnect attempt fails (gateway still booting) → the loop must
    // back off and keep trying rather than give up. Backoff ceiling for the
    // second attempt is base * 2^1 = 2s, so this stays fast in CI.
    @Test func reconnectLoopRetriesAfterFailedAttempt() async throws {
        let mock = SupervisedMockTransport()
        let container = await makeStartedContainer(mock: mock)
        defer { try? KeychainStore.delete(for: container.gatewayURL) }

        mock.failConnects = 1
        mock.simulateUnexpectedClose(code: 1006, reason: "gateway restart")

        try await waitUntil(timeout: 10) {
            mock.connectCount >= 3 && !container._testIsReconnectLoopRunning
        }
        #expect(mock.isConnected)
    }

    // Deliberate teardown (clearToken) must not resurrect the connection: the
    // supervision generation is invalidated, so a straggler close notification
    // from the old socket is inert and status stays .idle.
    @Test func deliberateTeardownSuppressesReconnect() async throws {
        let mock = SupervisedMockTransport()
        let container = await makeStartedContainer(mock: mock)
        defer { try? KeychainStore.delete(for: container.gatewayURL) }

        await container.clearToken()
        #expect(container.connectionStore.status == .idle)

        mock.simulateUnexpectedClose(code: 1006, reason: "straggler close after teardown")

        // Give any (buggy) reconnect hop a chance to run, then assert nothing moved.
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(container.connectionStore.status == .idle)
        #expect(!container._testIsReconnectLoopRunning)
        #expect(mock.connectCount == 1)
    }
}
