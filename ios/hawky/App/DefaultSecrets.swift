import Foundation

/// Reads optional local-only prefill values from a bundled, gitignored
/// `DefaultSecrets.plist`. Used to pre-populate onboarding's Default connection
/// (so the maintainer's device fills in the known Cloudflare Access service
/// token automatically). When the file is absent — CI, a fresh clone, or any
/// other build — every accessor returns nil and onboarding starts empty.
enum DefaultSecrets {
    private static let values: [String: String] = {
        guard let url = Bundle.main.url(forResource: "DefaultSecrets", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let raw = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dict = raw as? [String: Any] else {
            return [:]
        }
        return dict.compactMapValues { $0 as? String }
    }()

    private static func nonEmpty(_ key: String) -> String? {
        let value = (values[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    static var cloudflareAccessClientId: String? { nonEmpty("CloudflareAccessClientId") }
    static var cloudflareAccessClientSecret: String? { nonEmpty("CloudflareAccessClientSecret") }

    /// Both Cloudflare Access fields, only when both are present.
    static var cloudflareAccess: (id: String, secret: String)? {
        guard let id = cloudflareAccessClientId, let secret = cloudflareAccessClientSecret else { return nil }
        return (id, secret)
    }
}
