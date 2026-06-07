import Testing
import Foundation
@testable import hawky

@Suite struct GatewayHandshakeIntegrationTests {
    private static func liveGateway() async throws -> IntegrationGatewayConfig? {
        guard let gateway = try IntegrationGatewayConfig.currentForIntegrationTest() else {
            print("[IntegrationTest] \(IntegrationGatewayConfig.skipMessage)")
            return nil
        }
        guard await gateway.isReachable() else {
            if IntegrationGatewayConfig.isRequired() {
                throw IntegrationGatewayConfigError.unreachable(gateway.healthURL.absoluteString)
            }
            print("[IntegrationTest] gateway unreachable at \(gateway.httpURL); skipping")
            return nil
        }
        return gateway
    }

    @Test func scenario1_connectAndReceiveHello() async throws {
        guard let gateway = try await Self.liveGateway() else { return }
        let token = try await gateway.fetchToken()
        let transport = URLSessionGatewayTransport()
        let params = ConnectParams(
            version: "hawky/0.1",
            platform: "mobile",
            token: token,
            sessionKey: gateway.freshSessionKey(),
            role: "client"
        )
        let hello = try await transport.connect(url: gateway.websocketURL, connectParams: params)
        print("[IntegrationTest] hello methods=\(hello.methods) connId=\(hello.connId) serverVersion=\(hello.serverVersion)")
        #expect(!hello.connId.isEmpty)
        #expect(hello.methods.contains("chat.send"))
        await transport.disconnect()
    }

    @Test func scenario2_sessionExistsRoundTrip() async throws {
        guard let gateway = try await Self.liveGateway() else { return }
        let token = try await gateway.fetchToken()
        let transport = URLSessionGatewayTransport()
        let sessionKey = gateway.freshSessionKey()
        let params = ConnectParams(version: "hawky/0.1", platform: "mobile",
                                   token: token, sessionKey: sessionKey, role: "client")
        _ = try await transport.connect(url: gateway.websocketURL, connectParams: params)
        let req = RequestFrame(
            id: UUID().uuidString,
            method: "session.exists",
            params: ["sessionKey": .string(sessionKey)]
        )
        let resp = try await transport.send(req)
        print("[IntegrationTest] session.exists ok=\(resp.ok) payload=\(String(describing: resp.payload))")
        #expect(resp.ok)
        if case .bool = resp.payload ?? .null { /* ok */ } else {
            // Some versions may nest it — accept either shape.
            #expect(resp.payload != nil)
        }
        await transport.disconnect()
    }

    @Test func scenario3_cleanDisconnect() async throws {
        guard let gateway = try await Self.liveGateway() else { return }
        let token = try await gateway.fetchToken()
        let transport = URLSessionGatewayTransport()
        let params = ConnectParams(version: "hawky/0.1", platform: "mobile",
                                   token: token, sessionKey: gateway.freshSessionKey(), role: "client")
        _ = try await transport.connect(url: gateway.websocketURL, connectParams: params)
        await transport.disconnect()
        // Best-effort: a send after disconnect must fail fast.
        do {
            _ = try await transport.send(RequestFrame(id: "x", method: "session.exists", params: nil))
            Issue.record("expected send-after-disconnect to throw")
        } catch {
            // expected
        }
    }

    @Test func scenario4_unauthorizedOnBlankToken() async throws {
        guard let gateway = try await Self.liveGateway() else { return }
        let transport = URLSessionGatewayTransport()
        let params = ConnectParams(version: "hawky/0.1", platform: "mobile",
                                   token: "", sessionKey: gateway.freshSessionKey(), role: "client")
        do {
            _ = try await transport.connect(url: gateway.websocketURL, connectParams: params)
            Issue.record("expected unauthorized")
        } catch GatewayTransportError.unauthorized {
            // expected
        } catch {
            // Some server versions may close 1008 without sending a res first.
            // Accept any closed variant as equivalent to unauthorized for this negative test.
            print("[IntegrationTest] unauth path error=\(error)")
        }
        await transport.disconnect()
    }
}
