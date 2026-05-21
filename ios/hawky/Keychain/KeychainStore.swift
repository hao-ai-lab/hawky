import Foundation
import Security
import CryptoKit

enum KeychainError: Error, Equatable {
    case unexpectedStatus(OSStatus)
    case dataCorrupt
}

enum KeychainStore {
    static let service = "live.hawky.deviceToken"
    private static let openAIService = "live.hawky.openai"
    private static let openAIAccount = "realtime-api-key"

    // Account suffix matches Hawky's filename convention (device-auth.ts:298-302):
    // first 12 hex chars of SHA-256(gatewayURL). Keeps tokens scoped per gateway.
    static func account(for gatewayURL: URL) -> String {
        // Normalize to origin (scheme://host[:port]) so trailing slashes / paths
        // don't key the same gateway under different accounts — otherwise the
        // device token saved under "https://gw/" is invisible to a load against
        // the origin-stripped broker URL "https://gw", causing 401 (#526 review).
        return accountHash(canonicalOrigin(gatewayURL) ?? gatewayURL.absoluteString)
    }

    /// Legacy account = hash of the full URL string (pre-normalization). Kept so
    /// load() can migrate a token saved by an older build.
    private static func legacyAccount(for gatewayURL: URL) -> String {
        accountHash(gatewayURL.absoluteString)
    }

    private static func accountHash(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(12))
    }

    private static func canonicalOrigin(_ url: URL) -> String? {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = comps.scheme?.lowercased(),
              let host = comps.host?.lowercased() else { return nil }
        if let port = comps.port { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    static func save(token: String, for gatewayURL: URL) throws {
        let acct = account(for: gatewayURL)
        let data = Data(token.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: acct
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

    static func load(for gatewayURL: URL) throws -> String? {
        if let v = try loadRaw(account: account(for: gatewayURL)) { return v }
        // Migration: an older build saved under the full-URL account. If found
        // there, re-save under the normalized account and return it (#526 review).
        let legacy = legacyAccount(for: gatewayURL)
        if legacy != account(for: gatewayURL), let v = try loadRaw(account: legacy) {
            try? save(token: v, for: gatewayURL)
            return v
        }
        return nil
    }

    private static func loadRaw(account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
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

    static func delete(for gatewayURL: URL) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: gatewayURL)
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return }
        throw KeychainError.unexpectedStatus(status)
    }

    static func saveOpenAIAPIKey(_ key: String) throws {
        try saveGenericPassword(key, service: openAIService, account: openAIAccount)
    }

    static func loadOpenAIAPIKey() throws -> String? {
        try loadGenericPassword(service: openAIService, account: openAIAccount)
    }

    static func deleteOpenAIAPIKey() throws {
        try deleteGenericPassword(service: openAIService, account: openAIAccount)
    }

    private static func saveGenericPassword(_ value: String, service: String, account: String) throws {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
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

    private static func loadGenericPassword(service: String, account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
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

    private static func deleteGenericPassword(service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return }
        throw KeychainError.unexpectedStatus(status)
    }
}
