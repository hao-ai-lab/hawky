import Foundation
import Security

struct CloudflareAccessCredentials: Equatable {
    var clientId: String
    var clientSecret: String

    var isComplete: Bool {
        !clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum CloudflareAccessStore {
    private static let clientIdService = "live.hawky.cloudflareAccess.clientId"
    private static let clientSecretService = "live.hawky.cloudflareAccess.clientSecret"

    static func load(for gatewayURL: URL) throws -> CloudflareAccessCredentials? {
        let clientId = try loadValue(service: clientIdService, gatewayURL: gatewayURL) ?? ""
        let clientSecret = try loadValue(service: clientSecretService, gatewayURL: gatewayURL) ?? ""
        guard !clientId.isEmpty || !clientSecret.isEmpty else { return nil }
        return CloudflareAccessCredentials(clientId: clientId, clientSecret: clientSecret)
    }

    static func save(_ credentials: CloudflareAccessCredentials, for gatewayURL: URL) throws {
        let clientId = credentials.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientSecret = credentials.clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        try saveValue(clientId, service: clientIdService, gatewayURL: gatewayURL)
        try saveValue(clientSecret, service: clientSecretService, gatewayURL: gatewayURL)
    }

    static func delete(for gatewayURL: URL) throws {
        try deleteValue(service: clientIdService, gatewayURL: gatewayURL)
        try deleteValue(service: clientSecretService, gatewayURL: gatewayURL)
    }

    static func applyHeaders(to request: inout URLRequest, gatewayURL: URL) {
        guard let credentials = try? load(for: gatewayURL), credentials.isComplete else { return }
        request.setValue(credentials.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(credentials.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }

    static func applyHeaders(to request: inout URLRequest, requestURL: URL) {
        guard let gatewayURL = normalizedGatewayURL(from: requestURL) else { return }
        applyHeaders(to: &request, gatewayURL: gatewayURL)
    }

    static func normalizedGatewayURL(from url: URL) -> URL? {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = comps.scheme?.lowercased() else { return nil }
        switch scheme {
        case "wss": comps.scheme = "https"
        case "ws": comps.scheme = "http"
        case "https", "http": break
        default: return nil
        }
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }

    private static func account(for gatewayURL: URL) -> String {
        KeychainStore.account(for: normalizedGatewayURL(from: gatewayURL) ?? gatewayURL)
    }

    private static func saveValue(_ value: String, service: String, gatewayURL: URL) throws {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: gatewayURL),
        ]
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.unexpectedStatus(addStatus) }
            return
        }
        throw KeychainError.unexpectedStatus(status)
    }

    private static func loadValue(service: String, gatewayURL: URL) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: gatewayURL),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        guard let data = out as? Data, let str = String(data: data, encoding: .utf8) else {
            throw KeychainError.dataCorrupt
        }
        return str
    }

    private static func deleteValue(service: String, gatewayURL: URL) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: gatewayURL),
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return }
        throw KeychainError.unexpectedStatus(status)
    }
}
