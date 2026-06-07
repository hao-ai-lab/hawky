import Testing
import Foundation
@testable import hawky

@Suite struct DeviceAuthClientTests {
    // Each test uses a unique baseURL so the shared StubURLProtocol registry
    // does not race when Swift Testing runs tests in parallel.
    private func uniqueBase() -> URL {
        URL(string: "http://test-\(UUID().uuidString).local")!
    }

    private func makeClient(baseURL: URL) -> DeviceAuthClient {
        DeviceAuthClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
    }

    @Test func returnsTokenOn200Ok() async throws {
        let base = uniqueBase()
        let body = #"{"ok":true,"token":"abc.def.ghi"}"#.data(using: .utf8)!
        StubURLProtocol.set(url: base.appendingPathComponent("auth/device"), statusCode: 200, body: body)
        let token = try await makeClient(baseURL: base).fetchToken()
        #expect(token == "abc.def.ghi")
    }

    @Test func throwsUnauthorizedOn401() async throws {
        let base = uniqueBase()
        StubURLProtocol.set(url: base.appendingPathComponent("auth/device"), statusCode: 401, body: Data("{}".utf8))
        await #expect(throws: DeviceAuthError.unauthorized) {
            _ = try await makeClient(baseURL: base).fetchToken()
        }
    }

    @Test func throwsNotOkWhenOkFalse() async throws {
        let base = uniqueBase()
        let body = #"{"ok":false,"error":"nope"}"#.data(using: .utf8)!
        StubURLProtocol.set(url: base.appendingPathComponent("auth/device"), statusCode: 200, body: body)
        do {
            _ = try await makeClient(baseURL: base).fetchToken()
            Issue.record("expected throw")
        } catch let DeviceAuthError.notOk(msg) {
            #expect(msg == "nope")
        }
    }

    @Test func throwsMalformedOnBadJSON() async throws {
        let base = uniqueBase()
        StubURLProtocol.set(url: base.appendingPathComponent("auth/device"), statusCode: 200, body: Data("not json".utf8))
        await #expect(throws: DeviceAuthError.unexpectedBody(contentType: "application/json")) {
            _ = try await makeClient(baseURL: base).fetchToken()
        }
    }

    @Test func throwsHttpStatusOn500() async throws {
        let base = uniqueBase()
        StubURLProtocol.set(url: base.appendingPathComponent("auth/device"), statusCode: 500, body: Data("{}".utf8))
        await #expect(throws: DeviceAuthError.httpStatus(500)) {
            _ = try await makeClient(baseURL: base).fetchToken()
        }
    }
}
