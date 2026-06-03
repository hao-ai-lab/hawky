import Foundation
import Network
import os

// NetworkCommand — one-shot NWPathMonitor probe.
// Creates a monitor, awaits the first pathUpdate, cancels, returns summary.
// No SSID (requires entitlement). Times out at 2s with a "none" fallback.
struct NetworkCommand: NodeCommand {
    static let name = "device.network"

    func invoke(args: JSONValue) async throws -> JSONValue {
        let path = await Self.firstPath(timeout: 2.0)
        let connType: String
        if let p = path {
            if p.status != .satisfied {
                connType = "none"
            } else if p.usesInterfaceType(.wifi) {
                connType = "wifi"
            } else if p.usesInterfaceType(.cellular) {
                connType = "cellular"
            } else if p.usesInterfaceType(.wiredEthernet) {
                connType = "wired"
            } else {
                connType = "none"
            }
        } else {
            connType = "none"
        }
        return .object([
            "connectionType": .string(connType),
            "isExpensive": .bool(path?.isExpensive ?? false),
            "isConstrained": .bool(path?.isConstrained ?? false),
        ])
    }

    /// Awaits the first NWPath emission or returns nil after `timeout` seconds.
    static func firstPath(timeout: TimeInterval) async -> NWPath? {
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "network.probe")
        return await withCheckedContinuation { (cont: CheckedContinuation<NWPath?, Never>) in
            let didResume = OSAllocatedUnfairLock<Bool>(initialState: false)
            @Sendable func finish(_ p: NWPath?) {
                let shouldResume = didResume.withLock { flag -> Bool in
                    if flag { return false }
                    flag = true
                    return true
                }
                guard shouldResume else { return }
                monitor.cancel()
                cont.resume(returning: p)
            }
            monitor.pathUpdateHandler = { path in finish(path) }
            monitor.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }
}
