import Testing
@testable import hawky

@Suite struct LiveRealtimeSessionConfigStatusTests {
    @Test func appliedStatusFormatsAsCleanConnected() {
        let status = LiveRealtimeSessionConfigStatus.applied

        #expect(status.diagnosticsLabel == "applied")
        #expect(status.connectedProviderStatus == "Connected")
        #expect(status.connectedMessage == "Connected")
    }

    @Test func unconfirmedStatusFormatsAsDegradedConnected() {
        let status = LiveRealtimeSessionConfigStatus.unconfirmed(detail: "Timed out waiting for session.updated.")

        #expect(status.diagnosticsLabel == "unconfirmed")
        #expect(status.connectedProviderStatus == "Connected (session config unconfirmed)")
        #expect(status.connectedMessage == "Connected (session config unconfirmed)")
    }

    @Test func failedStatusFormatsAsFailure() {
        let status = LiveRealtimeSessionConfigStatus.failed(detail: "invalid session.update")

        #expect(status.diagnosticsLabel == "failed")
        #expect(status.connectedProviderStatus == "Session config failed")
        #expect(status.connectedMessage == "Session config failed")
    }
}
