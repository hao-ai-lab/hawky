import Testing
import Foundation
@testable import hawky

@Suite struct IntegrationGatewayConfigTests {
    @Test func returnsNilWhenLiveGatewayEnvironmentIsAbsent() throws {
        let config = try IntegrationGatewayConfig.current(environment: [:])

        #expect(config == nil)
    }

    @Test func parsesPrimaryLiveGatewayURL() throws {
        let config = try #require(try IntegrationGatewayConfig.current(environment: [
            IntegrationGatewayConfig.urlEnvironmentKey: "http://127.0.0.1:4242"
        ]))

        #expect(config.httpURL.absoluteString == "http://127.0.0.1:4242")
        #expect(config.websocketURL.absoluteString == "ws://127.0.0.1:4242/")
        #expect(config.healthURL.absoluteString == "http://127.0.0.1:4242/health")
    }

    @Test func acceptsLegacyLiveGatewayURLAlias() throws {
        let config = try #require(try IntegrationGatewayConfig.current(environment: [
            IntegrationGatewayConfig.legacyURLEnvironmentKey: "https://gateway.example.test"
        ]))

        #expect(config.websocketURL.absoluteString == "wss://gateway.example.test/")
    }

    @Test func rejectsMalformedLiveGatewayURL() {
        #expect(throws: IntegrationGatewayConfigError.invalidURL("ws://127.0.0.1:4242")) {
            _ = try IntegrationGatewayConfig.current(environment: [
                IntegrationGatewayConfig.urlEnvironmentKey: "ws://127.0.0.1:4242"
            ])
        }
    }

    @Test func requiredLiveTestsFailWhenGatewayURLIsMissing() {
        #expect(throws: IntegrationGatewayConfigError.missingRequiredURL(IntegrationGatewayConfig.skipMessage)) {
            _ = try IntegrationGatewayConfig.currentForIntegrationTest(environment: [
                IntegrationGatewayConfig.requiredEnvironmentKey: "1"
            ])
        }
    }

    @Test func requiredLiveTestsParseTruthyValues() {
        #expect(IntegrationGatewayConfig.isRequired(environment: [
            IntegrationGatewayConfig.requiredEnvironmentKey: "true"
        ]))
        #expect(IntegrationGatewayConfig.isRequired(environment: [
            IntegrationGatewayConfig.requiredEnvironmentKey: "required"
        ]))
        #expect(!IntegrationGatewayConfig.isRequired(environment: [
            IntegrationGatewayConfig.requiredEnvironmentKey: "0"
        ]))
    }
}
