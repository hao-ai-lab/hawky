import Testing
import Foundation
@testable import hawky

// Mock transport for AppContainer.switchSession flow tests.
// Flags:
//  - initialConnected: what isConnected returns before any action
//  - sendThrows: make send() throw to simulate a dead socket
final class MockTransport: GatewayTransport, @unchecked Sendable {
    var initialConnected: Bool = true
    var sendThrows: Bool = false
    private(set) var sendCount = 0
    private(set) var connectCount = 0
    private(set) var disconnected = false
    private(set) var lastConnectURL: URL?
    private(set) var lastPlatform: String?
    private var _connected: Bool = true
    private let lock = NSLock()
    private let (stream, continuation) = {
        let t = AsyncStream<EventFrame>.makeStream()
        return (t.stream, t.continuation)
    }()

    init(initialConnected: Bool = true, sendThrows: Bool = false) {
        self.initialConnected = initialConnected
        self.sendThrows = sendThrows
        self._connected = initialConnected
    }

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return _connected
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        connectCount += 1
        lastConnectURL = url
        lastPlatform = connectParams.platform
        lock.lock(); _connected = true; lock.unlock()
        let json = #"{"connId":"mock","serverVersion":"test","methods":[]}"#.data(using: .utf8)!
        return try JSONDecoder().decode(HelloPayload.self, from: json)
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        sendCount += 1
        if sendThrows {
            lock.lock(); _connected = false; lock.unlock()
            throw GatewayTransportError.closed(code: 57, reason: "ENOTCONN")
        }
        let json = "{\"type\":\"res\",\"id\":\"\(frame.id)\",\"ok\":true}".data(using: .utf8)!
        return try JSONDecoder().decode(ResponseFrame.self, from: json)
    }

    func events() -> AsyncStream<EventFrame> { stream }

    func disconnect() async {
        disconnected = true
        lock.lock(); _connected = false; lock.unlock()
    }
}

@Suite @MainActor
struct SwitchSessionTests {
    // Seed keychain so ensureConnected does not hit network for device auth.
    private func seedKeychain(for container: AppContainer) {
        try? KeychainStore.save(token: "test-token", for: container.gatewayURL)
    }

    @Test func staleTransportTriggersEnsureConnectedThenSucceeds() async throws {
        let container = AppContainer()
        seedKeychain(for: container)
        let stale = MockTransport(initialConnected: false)
        let fresh = MockTransport(initialConnected: true)
        container._testInstallTransport(stale)
        // Factory returns a fresh connected mock when ensureConnected rebuilds.
        container.transportFactory = { fresh }

        try await container.switchSession(to: "ios:other")

        #expect(stale.disconnected == true)
        #expect(fresh.connectCount == 1)
        #expect(fresh.sendCount >= 1) // session.resolve
        #expect(container.sessionStore.activeSessionKey == "ios:other")
        try? KeychainStore.delete(for: container.gatewayURL)
    }

    @Test func sendErrorSurfacesAsTypedSwitchFailed() async throws {
        let container = AppContainer()
        seedKeychain(for: container)
        let t = MockTransport(initialConnected: true, sendThrows: true)
        container._testInstallTransport(t)
        container.transportFactory = { t }

        var captured: AppContainerError?
        do {
            try await container.switchSession(to: "ios:other")
        } catch let e as AppContainerError {
            captured = e
        } catch {
            Issue.record("expected AppContainerError, got \(error)")
        }
        guard case .switchFailed(let reason) = captured else {
            Issue.record("expected .switchFailed")
            return
        }
        #expect(!reason.isEmpty)
        // Never leak raw NSPOSIX string.
        #expect(!reason.contains("NSPOSIX"))
        try? KeychainStore.delete(for: container.gatewayURL)
    }

    @Test func applyingGatewaySettingsUpdatesActiveGatewayAndReconnects() async throws {
        let originalRaw = UserDefaults.standard.string(forKey: "gatewayURL")
        let originalName = UserDefaults.standard.string(forKey: "deviceName")
        defer {
            if let originalRaw {
                UserDefaults.standard.set(originalRaw, forKey: "gatewayURL")
            } else {
                UserDefaults.standard.removeObject(forKey: "gatewayURL")
            }
            if let originalName {
                UserDefaults.standard.set(originalName, forKey: "deviceName")
            } else {
                UserDefaults.standard.removeObject(forKey: "deviceName")
            }
        }

        let container = AppContainer()
        let oldTransport = MockTransport(initialConnected: true)
        let fresh = MockTransport(initialConnected: true)
        container._testInstallTransport(oldTransport)
        container.transportFactory = { fresh }

        let nextURL = URL(string: "https://gateway.example.test:4242")!
        try? KeychainStore.save(token: "test-token", for: nextURL)
        defer { try? KeychainStore.delete(for: nextURL) }

        try await container.applyGatewaySettings(gatewayURL: nextURL, deviceName: "Junda Phone")

        #expect(container.gatewayURL == nextURL)
        #expect(UserDefaults.standard.string(forKey: "gatewayURL") == nextURL.absoluteString)
        #expect(UserDefaults.standard.string(forKey: "deviceName") == "Junda Phone")
        #expect(oldTransport.disconnected)
        #expect(fresh.connectCount == 1)
        #expect(fresh.lastConnectURL?.scheme == "wss")
        #expect(fresh.lastConnectURL?.host == "gateway.example.test")
        #expect(fresh.lastPlatform == "Junda Phone")
        if case .connected = container.connectionStore.status {
            // ok
        } else {
            Issue.record("expected connected status after applying gateway settings")
        }
    }
}
