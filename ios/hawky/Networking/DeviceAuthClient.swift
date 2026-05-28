import Foundation

enum DeviceAuthError: Error, Equatable {
    case unauthorized
    case httpStatus(Int)
    case malformedResponse
    case notOk(String?)
    /// Got a 2xx whose body wasn't the expected JSON (e.g. a Cloudflare Access
    /// HTML login page served with a 200). `contentType` distinguishes this
    /// from a genuinely malformed gateway reply.
    case unexpectedBody(contentType: String)
}

/// URLSession delegate that re-attaches Cloudflare Access service-token headers
/// when a request is redirected.
///
/// Cloudflare Access answers an unauthenticated request to a gated path with a
/// 302 to its login domain. `URLSession`'s automatic redirect handling strips
/// custom `CF-Access-*` request headers across that hop, so the followed request
/// lands on the Cloudflare login HTML page instead of the gateway — which the
/// JSON decoder then rejects as a malformed response. By intercepting the
/// redirect and copying the `CF-Access-*` headers onto the new request, the
/// service token survives the hop and the gateway authenticates us.
private final class CloudflareAccessRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        var followUp = request
        if let original = task.originalRequest {
            for field in ["CF-Access-Client-Id", "CF-Access-Client-Secret"] {
                if let value = original.value(forHTTPHeaderField: field) {
                    followUp.setValue(value, forHTTPHeaderField: field)
                }
            }
        }
        completionHandler(followUp)
    }
}

struct DeviceAuthClient {
    let baseURL: URL
    let session: URLSession

    /// Shared session that preserves Cloudflare Access headers across redirects.
    private static let cloudflareAwareSession: URLSession = {
        URLSession(
            configuration: .default,
            delegate: CloudflareAccessRedirectDelegate(),
            delegateQueue: nil
        )
    }()

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.session = session ?? DeviceAuthClient.cloudflareAwareSession
    }

    private struct AuthResponse: Decodable {
        let ok: Bool
        let token: String?
        let error: String?
    }

    func fetchToken() async throws -> String {
        let url = baseURL.appendingPathComponent("auth/device")
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        CloudflareAccessStore.applyHeaders(to: &req, gatewayURL: baseURL)
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw DeviceAuthError.malformedResponse }
        switch http.statusCode {
        case 200...299: break
        case 401, 403: throw DeviceAuthError.unauthorized
        default: throw DeviceAuthError.httpStatus(http.statusCode)
        }
        guard let decoded = try? JSONDecoder().decode(AuthResponse.self, from: data) else {
            let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? "unknown"
            throw DeviceAuthError.unexpectedBody(contentType: contentType)
        }
        guard decoded.ok else { throw DeviceAuthError.notOk(decoded.error) }
        guard let token = decoded.token, !token.isEmpty else { throw DeviceAuthError.malformedResponse }
        return token
    }

    func acquireAndStore() async throws -> String {
        let token = try await fetchToken()
        try KeychainStore.save(token: token, for: baseURL)
        return token
    }
}
