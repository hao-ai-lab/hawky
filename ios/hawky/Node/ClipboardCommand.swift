import Foundation
#if canImport(UIKit)
import UIKit
#endif

@MainActor
protocol ClipboardReading {
    var hasStrings: Bool { get }
    var strings: [String]? { get }
    var string: String? { get }
}

#if canImport(UIKit)
extension UIPasteboard: ClipboardReading {}
#endif

// ClipboardCommand — reads UIPasteboard.general.
// iOS 14+ displays a system banner on first pasteboard read; that's the OS's
// privacy UX and is acceptable.
struct ClipboardCommand: NodeCommand {
    static let name = "clipboard.read"

    func invoke(args: JSONValue) async throws -> JSONValue {
        return await MainActor.run { Self.collect() }
    }

    @MainActor
    static func collect() -> JSONValue {
        #if canImport(UIKit)
        return collect(pasteboard: UIPasteboard.general)
        #else
        return emptyResult
        #endif
    }

    @MainActor
    static func collect(pasteboard pb: ClipboardReading) -> JSONValue {
        // `hasStrings` is a lightweight existence check that does NOT require
        // the iOS 14+ paste-consent grant. If it's false, we short-circuit and
        // avoid touching `.string` / `.strings`, which would surface a
        // `PBErrorDomain Code=13 "Operation not authorized"` NSError in the
        // console when the user hasn't granted (or has let the grant expire).
        let hasStrings = pb.hasStrings
        guard hasStrings else {
            return emptyResult
        }
        let strings = pb.strings ?? []
        let text = pb.string
        let authorized = text != nil || !strings.isEmpty
        return .object([
            "text": text.map { .string($0) } ?? .null,
            "hasStrings": .bool(hasStrings),
            "stringsCount": .number(Double(strings.count)),
            "authorized": .bool(authorized),
        ])

    }

    private static var emptyResult: JSONValue {
        return .object([
            "text": .null,
            "hasStrings": .bool(false),
            "stringsCount": .number(0),
            "authorized": .bool(false),
        ])
    }
}
