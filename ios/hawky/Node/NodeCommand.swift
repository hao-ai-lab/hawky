import Foundation

// NodeCommand — a capability exposed to the Hawky gateway.
//
// The gateway calls the command by name via a `node.invoke.request` event;
// the runner routes to the matching implementation and sends back a
// `node.invoke.result` RPC carrying the returned JSON payload.
//
// Protocol reference: docs/research/node-protocol.md, invoke section.
protocol NodeCommand {
    /// Wire name (e.g. "device.info"). Must match the string advertised in
    /// the node.hello `commands` list and the name the gateway dispatches.
    static var name: String { get }

    /// Execute the command. `args` is the decoded `paramsJSON` payload from
    /// the gateway (may be `.null` or `.object([:])` when no params).
    /// Return a `JSONValue` that the runner re-encodes as `payloadJSON`.
    /// Throwing surfaces as `{ok: false, error: <message>}` to the gateway.
    func invoke(args: JSONValue) async throws -> JSONValue
}

/// Error type returned by the node runner when the gateway invokes a command
/// that was not registered. We mirror Hawky's wording so gateway-side log
/// grep works against both node runtimes.
/// Reference: hawky/src/node/commands.ts:604 ("Unknown node command: X").
enum NodeCommandError: Error, Equatable {
    case unknownCommand(String)
    case invalidArgs(String)

    var message: String {
        switch self {
        case .unknownCommand(let name): return "Unknown node command: \(name)"
        case .invalidArgs(let m): return "Invalid args: \(m)"
        }
    }
}
