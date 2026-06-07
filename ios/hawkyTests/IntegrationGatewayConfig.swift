import Foundation
@testable import hawky

enum IntegrationGatewayConfigError: LocalizedError, Equatable {
    case invalidURL(String)
    case missingRequiredURL(String)
    case unreachable(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let raw):
            return "Invalid integration gateway URL: \(raw)"
        case .missingRequiredURL(let message):
            return message
        case .unreachable(let url):
            return "Live gateway is not reachable at \(url)"
        }
    }
}

struct IntegrationGatewayConfig: Equatable {
    static let urlEnvironmentKey = "IOS_INTEGRATION_GATEWAY_URL"
    static let legacyURLEnvironmentKey = "IOS_LIVE_GATEWAY_URL"
    static let requiredEnvironmentKey = "IOS_LIVE_TESTS_REQUIRED"
    static let defaultLocalURLString = "http://127.0.0.1:4242"

    let httpURL: URL
    let websocketURL: URL

    static func current(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> IntegrationGatewayConfig? {
        let raw = (environment[urlEnvironmentKey] ?? environment[legacyURLEnvironmentKey])?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let raw, !raw.isEmpty else { return nil }
        guard
            let url = URL(string: raw),
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host,
            !host.isEmpty
        else {
            throw IntegrationGatewayConfigError.invalidURL(raw)
        }
        return IntegrationGatewayConfig(httpURL: url)
    }

    static func currentForIntegrationTest(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> IntegrationGatewayConfig? {
        guard let config = try current(environment: environment) else {
            if isRequired(environment: environment) {
                throw IntegrationGatewayConfigError.missingRequiredURL(skipMessage)
            }
            return nil
        }
        return config
    }

    static func isRequired(environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        switch environment[requiredEnvironmentKey]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "required":
            return true
        default:
            return false
        }
    }

    init(httpURL: URL) {
        self.httpURL = httpURL

        var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false)
        switch components?.scheme?.lowercased() {
        case "https":
            components?.scheme = "wss"
        case "http":
            components?.scheme = "ws"
        default:
            break
        }
        if components?.path.isEmpty == true {
            components?.path = "/"
        }
        self.websocketURL = components?.url ?? httpURL
    }

    var healthURL: URL {
        httpURL.appendingPathComponent("health")
    }

    func isReachable(timeout: TimeInterval = 2) async -> Bool {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = timeout
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    func fetchToken() async throws -> String {
        try await DeviceAuthClient(baseURL: httpURL).fetchToken()
    }

    func freshSessionKey(prefix: String = "ios:test") -> String {
        "\(prefix)-\(UUID().uuidString.prefix(8))"
    }

    static var skipMessage: String {
        "Set \(urlEnvironmentKey)=\(defaultLocalURLString) to run live gateway integration tests."
    }
}
