import Testing
import Foundation
@testable import hawky

@Suite struct ChatClientIntegrationTests {
    private static func liveGateway() async throws -> IntegrationGatewayConfig? {
        guard let gateway = try IntegrationGatewayConfig.currentForIntegrationTest() else {
            print("[ChatClientIntegrationTest] \(IntegrationGatewayConfig.skipMessage)")
            return nil
        }
        guard await gateway.isReachable() else {
            if IntegrationGatewayConfig.isRequired() {
                throw IntegrationGatewayConfigError.unreachable(gateway.healthURL.absoluteString)
            }
            print("[ChatClientIntegrationTest] gateway unreachable at \(gateway.httpURL); skipping")
            return nil
        }
        return gateway
    }

    // Collect events from a stream with a hard ceiling so a stuck turn fails
    // loudly instead of hanging the test suite.
    private func collect(_ stream: AsyncStream<ChatEvent>, timeoutSeconds: Double = 60) async throws -> [ChatEvent] {
        try await withThrowingTaskGroup(of: [ChatEvent].self) { group in
            group.addTask {
                var out: [ChatEvent] = []
                for await ev in stream {
                    out.append(ev)
                    if case .done = ev { break }
                    if case .error = ev { break }
                }
                return out
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                throw GatewayTransportError.handshakeTimeout
            }
            let first = try await group.next()!
            group.cancelAll()
            return first
        }
    }

    @Test func scenarioA_sendHelloCollectsDeltasAndDone() async throws {
        guard let gateway = try await Self.liveGateway() else { return }
        let token = try await gateway.fetchToken()
        let sessionKey = "ios:chat-test-\(UUID().uuidString.prefix(8))"
        let transport = URLSessionGatewayTransport()
        _ = try await transport.connect(url: gateway.websocketURL, connectParams: ConnectParams(
            version: "hawky/0.1", platform: "mobile",
            token: token, sessionKey: sessionKey, role: "client"
        ))

        let client = ChatClient(transport: transport, sessionKey: sessionKey)
        let stream = try await client.send("hello")
        let events = try await collect(stream)

        let deltas = events.compactMap { ev -> String? in
            if case .text(content: let s, replace: _) = ev { return s }
            return nil
        }
        let concatenated = deltas.joined()
        print("[ChatClientIntegrationTest] A deltaCount=\(deltas.count) text=\(concatenated.prefix(200))")

        #expect(!deltas.isEmpty, "expected at least one agent.text delta — got zero")
        if case .done = events.last {
            // ok — terminal was done
        } else {
            Issue.record("expected terminal .done, got \(String(describing: events.last))")
        }

        await transport.disconnect()
    }

    @Test func scenarioB_secondSendOnSameClient() async throws {
        guard let gateway = try await Self.liveGateway() else { return }
        let token = try await gateway.fetchToken()
        let sessionKey = "ios:chat-test-\(UUID().uuidString.prefix(8))"
        let transport = URLSessionGatewayTransport()
        _ = try await transport.connect(url: gateway.websocketURL, connectParams: ConnectParams(
            version: "hawky/0.1", platform: "mobile",
            token: token, sessionKey: sessionKey, role: "client"
        ))

        let client = ChatClient(transport: transport, sessionKey: sessionKey)

        let first = try await client.send("hello")
        let firstEvents = try await collect(first)
        #expect(firstEvents.contains { if case .done = $0 { return true } else { return false } })

        // second send must succeed (in-flight cleared on terminal).
        let second = try await client.send("and again")
        let secondEvents = try await collect(second)
        let secondDeltas = secondEvents.compactMap { ev -> String? in
            if case .text(content: let s, replace: _) = ev { return s } else { return nil }
        }
        print("[ChatClientIntegrationTest] B deltaCount=\(secondDeltas.count)")
        #expect(secondEvents.contains { if case .done = $0 { return true } else { return false } })

        await transport.disconnect()
    }
}
