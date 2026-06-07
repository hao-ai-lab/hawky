import XCTest
@testable import hawky

// =============================================================================
// a wrong/expired OpenAI key fails inside the Pipecat SDK as an opaque
// StartBotError whose real cause ("Failed while authenticating: …401…
// invalid_api_key") is buried in the RTVIError underlying chain.
// `classifyStartFailure` must map that to `.authenticationFailed` (so the UI
// offers "Open Live Settings") and everything else to `.invalidConfig` carrying
// a specific message — never the bare "StartBotError". The UI test only feeds a
// pre-classified stub, so these tests cover the classifier's real string inputs.
// (Signature takes a plain `Error`, so we exercise it with NSError messages
// without depending on the Pipecat error types.)
//
// XCTest (not Swift Testing) so it runs under the xcodebuild/CI path.
// =============================================================================
@MainActor
final class LiveStartFailureClassificationTests: XCTestCase {
    private func error(_ message: String) -> NSError {
        NSError(domain: "test", code: 0, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func isAuth(_ error: Error) -> Bool {
        if case LiveSessionProviderError.authenticationFailed = error { return true }
        return false
    }

    private func isInvalidConfig(_ error: Error) -> Bool {
        if case LiveSessionProviderError.invalidConfig = error { return true }
        return false
    }

    func testAuthRejectionsMapToAuthenticationFailed() {
        let authMessages = [
            "Failed while authenticating: {\"error\":{\"code\":\"invalid_api_key\"}}",
            "OpenAI returned HTTP 401",
            "Request unauthorized (403)",
            "Incorrect API key provided",
        ]
        for message in authMessages {
            let mapped = PipecatOpenAIRealtimeLiveSessionProvider.classifyStartFailure(error(message))
            XCTAssertTrue(isAuth(mapped), "Expected .authenticationFailed for: \(message)")
        }
    }

    func testNetworkFailureMapsToInvalidConfigWithDetail() {
        let mapped = PipecatOpenAIRealtimeLiveSessionProvider.classifyStartFailure(
            error("The network connection was lost.")
        )
        XCTAssertTrue(isInvalidConfig(mapped))
        // The specific cause is preserved, not replaced by an opaque "StartBotError".
        XCTAssertEqual(
            (mapped as? LiveSessionProviderError)?.errorDescription?.contains("network connection"),
            true
        )
    }
}
