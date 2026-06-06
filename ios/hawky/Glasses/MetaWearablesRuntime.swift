import Foundation

#if canImport(MWDATCore)
import MWDATCore
#endif

enum MetaWearablesRuntime {
    private(set) static var configureError: String?

    static func configure() {
        #if canImport(MWDATCore)
        do {
            try Wearables.configure()
            configureError = nil
        } catch {
            configureError = error.localizedDescription
            NSLog("ios: Meta Wearables configure failed: \(error)")
        }
        #else
        configureError = "Meta Wearables DAT SDK is not linked."
        #endif
    }

    static func handleOpenURL(_ url: URL) async -> Bool {
        #if canImport(MWDATCore)
        do {
            return try await Wearables.shared.handleUrl(url)
        } catch {
            NSLog("ios: Meta Wearables URL handling failed: \(error)")
            return false
        }
        #else
        return false
        #endif
    }
}
