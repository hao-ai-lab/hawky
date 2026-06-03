import Foundation
#if canImport(UIKit)
import UIKit
#endif

// BatteryCommand — reports battery level + state.
// UIDevice.batteryLevel returns -1.0 unless batteryMonitoringEnabled is true;
// we enable it transiently (cheap, no battery impact) before sampling.
struct BatteryCommand: NodeCommand {
    static let name = "device.battery"

    func invoke(args: JSONValue) async throws -> JSONValue {
        return await MainActor.run { Self.collect() }
    }

    @MainActor
    static func collect() -> JSONValue {
        #if canImport(UIKit)
        let dev = UIDevice.current
        let wasMonitoring = dev.isBatteryMonitoringEnabled
        if !wasMonitoring { dev.isBatteryMonitoringEnabled = true }
        let level = dev.batteryLevel
        let rawState = dev.batteryState
        if !wasMonitoring { dev.isBatteryMonitoringEnabled = false }

        let stateString: String
        switch rawState {
        case .unknown: stateString = "unknown"
        case .unplugged: stateString = "unplugged"
        case .charging: stateString = "charging"
        case .full: stateString = "full"
        @unknown default: stateString = "unknown"
        }
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        return .object([
            "level": .number(Double(level)),
            "state": .string(stateString),
            "lowPowerMode": .bool(lowPower),
        ])
        #else
        return .object([
            "level": .number(-1),
            "state": .string("unknown"),
            "lowPowerMode": .bool(false),
        ])
        #endif
    }
}
