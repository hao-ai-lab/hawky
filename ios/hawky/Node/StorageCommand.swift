import Foundation

// StorageCommand — reports filesystem capacity/usage via FileManager.
// FileManager.attributesOfFileSystem returns .systemSize and .systemFreeSize
// as NSNumbers (Int64-backed). usedBytes = total - free.
struct StorageCommand: NodeCommand {
    static let name = "device.storage"

    func invoke(args: JSONValue) async throws -> JSONValue {
        let path = NSHomeDirectory()
        let attrs = try FileManager.default.attributesOfFileSystem(forPath: path)
        let total = (attrs[.systemSize] as? NSNumber)?.int64Value ?? 0
        let free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        let used = max(0, total - free)
        return .object([
            "totalBytes": .number(Double(total)),
            "freeBytes": .number(Double(free)),
            "usedBytes": .number(Double(used)),
        ])
    }
}
