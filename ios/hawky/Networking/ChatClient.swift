import Foundation

enum ChatClientError: Error, Equatable {
    case sendInFlight
    case transport(String)
}

// ChatClient — high-level chat API on top of GatewayTransport.
//
// Contract (§5 of ios-transport-contract.md): `chat.send` RPC returns a `res`
// meaning the server queued the turn. The terminal signal is an `agent.done`
// event. We therefore subscribe to transport.events() BEFORE sending, filter
// for this session's `agent.*` events, and finish the stream on `.done` or
// `.error`.
//
// MVP: one active send per ChatClient. A second send while one is in flight
// throws `.sendInFlight` — caller must await the prior stream's completion.
actor ChatClient {
    private let transport: GatewayTransport
    private let sessionKey: String
    private var inFlight = false

    init(transport: GatewayTransport, sessionKey: String) {
        self.transport = transport
        self.sessionKey = sessionKey
    }

    func send(_ text: String) throws -> AsyncStream<ChatEvent> {
        if inFlight { throw ChatClientError.sendInFlight }
        inFlight = true

        let (stream, continuation) = AsyncStream<ChatEvent>.makeStream()
        let transport = self.transport
        let sessionKey = self.sessionKey

        // Subscribe BEFORE sending so we don't miss early deltas.
        let events = transport.events()

        let forwarder = Task {
            for await frame in events {
                guard let ev = EventFrameDecoder.decode(frame) else {
                    // Unknown or non-agent event — ignore. Transport logs unknowns.
                    continue
                }
                continuation.yield(ev)
                switch ev {
                case .done, .error:
                    continuation.finish()
                    return
                default:
                    continue
                }
            }
            continuation.finish()
        }

        let sender = Task {
            let params: [String: JSONValue] = [
                "message": .string(text),
                "sessionKey": .string(sessionKey)
            ]
            let frame = RequestFrame(id: UUID().uuidString, method: "chat.send", params: params)
            do {
                let resp = try await transport.send(frame)
                if !resp.ok {
                    let code = resp.error?.code ?? "unknown"
                    let msg = resp.error?.message ?? "chat.send failed"
                    continuation.yield(.error(code: code, message: msg))
                    continuation.finish()
                }
                // ok=true: server queued the turn; wait for agent.done via forwarder.
            } catch {
                continuation.yield(.error(code: "transport", message: "\(error)"))
                continuation.finish()
            }
        }

        continuation.onTermination = { _ in
            forwarder.cancel()
            sender.cancel()
            Task { await self.clearInFlight() }
        }

        return stream
    }

    private func clearInFlight() {
        inFlight = false
    }
}
