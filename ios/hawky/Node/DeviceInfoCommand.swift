import Foundation
#if canImport(UIKit)
import UIKit
#endif

// DeviceInfoCommand — reports iOS device metadata to the Hawky gateway.
//
// Payload shape intentionally diverges from the macOS reference
// (hawky/src/node/commands.ts:461-508). iOS cannot provide os.cpus(),
// df, uname -r, etc.; UIDevice is the native source of truth. The gateway
// forwards payloadJSON opaquely to the caller (node-registry.ts:375-389),
// so a differing shape is safe at the protocol layer — downstream callers
// must branch on the node's platform.
struct DeviceInfoCommand: NodeCommand {
    static let name = "device.info"

    func invoke(args: JSONValue) async throws -> JSONValue {
        return await MainActor.run { Self.collect() }
    }

    /// Collect UIDevice fields on the main actor (UIDevice is MainActor-isolated).
    /// Broken out so tests can call it without an async boundary.
    @MainActor
    static func collect() -> JSONValue {
        #if canImport(UIKit)
        let dev = UIDevice.current
        // batteryMonitoringEnabled must be true for batteryLevel to be
        // meaningful; when false iOS returns -1.0. We enable it transiently;
        // it's cheap and does not affect battery life.
        let wasMonitoring = dev.isBatteryMonitoringEnabled
        if !wasMonitoring { dev.isBatteryMonitoringEnabled = true }
        let level = dev.batteryLevel  // -1.0 if unknown
        if !wasMonitoring { dev.isBatteryMonitoringEnabled = false }

        return .object([
            "model": .string(dev.model),
            "systemName": .string(dev.systemName),
            "systemVersion": .string(dev.systemVersion),
            "name": .string(dev.name),
            "batteryLevel": .number(Double(level)),
            "localizedModel": .string(dev.localizedModel),
        ])
        #else
        return .object([
            "model": .string("unknown"),
            "systemName": .string("unknown"),
            "systemVersion": .string("unknown"),
            "name": .string("unknown"),
            "batteryLevel": .number(-1),
            "localizedModel": .string("unknown"),
        ])
        #endif
    }
}
