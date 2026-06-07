import Testing
import Foundation
@testable import hawky

// Covers AppContainer.handleForegroundTransition — the scene-phase hook that
// rebuilds a stale transport or reloads history when the app comes back from
// background. The production path lives in ContentView.onChange(of: scenePhase).
@Suite @MainActor
struct ForegroundReconnectTests {

    // Status != .connected → must call start(), which goes through the transport factory.
    @Test func foregroundTriggersStartWhenDisconnected() async throws {
        let container = AppContainer()
        try? KeychainStore.save(token: "test-token", for: container.gatewayURL)
        defer { try? KeychainStore.delete(for: container.gatewayURL) }

        // Status starts in .idle — factory must be invoked by start().
        #expect(container.connectionStore.status == .idle)

        let fresh = MockTransport(initialConnected: true)
        container.transportFactory = { fresh }

        // Simulate: app went to background 2s ago, now foregrounded.
        container.noteBackgrounded()
        await container.handleForegroundTransition()

        #expect(fresh.connectCount == 1)
        if case .connected = container.connectionStore.status {
            // ok
        } else {
            Issue.record("expected connected status after foreground transition")
        }
    }

    // Already connected → head refresh should fire on every foreground transition
    // (unless debounced). Assert the transport's send() was invoked for session.history.
    @Test func foregroundRefreshesHeadWhenConnected() async throws {
        let container = AppContainer()
        let mock = MockTransport(initialConnected: true)
        container._testInstallTransport(mock)
        container.connectionStore.markConnected(connId: "test")

        var now = Date(timeIntervalSince1970: 1_000_000)
        container.nowProvider = { now }
        container.noteBackgrounded()
        now = now.addingTimeInterval(60)
        await container.handleForegroundTransition()

        #expect(mock.sendCount >= 1)
    }

    // Two rapid foreground transitions within the debounce window → only the
    // first refresh should hit the wire. Protects the gateway from swipe-spam.
    @Test func foregroundRefreshIsDebounced() async throws {
        let container = AppContainer()
        let mock = MockTransport(initialConnected: true)
        container._testInstallTransport(mock)
        container.connectionStore.markConnected(connId: "test")

        var now = Date(timeIntervalSince1970: 2_000_000)
        container.nowProvider = { now }
        container.noteBackgrounded()
        now = now.addingTimeInterval(5)
        await container.handleForegroundTransition()
        let afterFirst = mock.sendCount
        // Second transition 500ms later — inside the 2s debounce window.
        now = now.addingTimeInterval(0.5)
        container.noteBackgrounded()
        await container.handleForegroundTransition()
        #expect(mock.sendCount == afterFirst)
    }
}
