import Foundation

struct ConnectParams: Encodable {
    let version: String
    let platform: String
    let token: String
    let sessionKey: String
    let role: String?
    /// Node host metadata — populated only when role == "node".
    /// See hawky/src/gateway/protocol.ts:60-65 and
    /// docs/research/node-protocol.md for the handshake.
    let node: NodeBundle?
    /// Ambient mode wire (M6 §3.6). Matches ConnectParams.mode on the gateway.
    /// Values: "quiet" | "ambient" | "directive". Absent → gateway defaults to "quiet".
    let mode: String?

    struct NodeBundle: Encodable {
        let nodeId: String
        let name: String
        let commands: [String]
    }

    init(version: String,
         platform: String,
         token: String,
         sessionKey: String,
         role: String? = nil,
         node: NodeBundle? = nil,
         mode: String? = nil) {
        self.version = version
        self.platform = platform
        self.token = token
        self.sessionKey = sessionKey
        self.role = role
        self.node = node
        self.mode = mode
    }
}

struct HelloPayload: Decodable {
    let connId: String
    let serverVersion: String
    let methods: [String]
}

struct ChatSendParams: Encodable {
    let message: String
    let sessionKey: String
}
