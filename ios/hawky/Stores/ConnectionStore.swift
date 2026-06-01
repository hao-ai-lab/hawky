import Foundation
import Observation

// Pure state mirror for the websocket lifecycle. Does not own the transport — the
// transport layer (ChatClient, Step 7) calls markX() to push updates here so views
// can observe without coupling to URLSession internals.
@MainActor
@Observable
final class ConnectionStore {
    enum Status: Equatable {
        case idle
        case connecting
        case connected(connId: String)
        case error(String)
        case abandoned
    }

    var status: Status = .idle
    var lastError: String? = nil

    func markIdle() {
        status = .idle
        lastError = nil
    }

    func markConnecting() {
        status = .connecting
        lastError = nil
    }

    func markConnected(connId: String) {
        status = .connected(connId: connId)
        lastError = nil
    }

    func markError(_ message: String) {
        status = .error(message)
        lastError = message
    }

    func markAbandoned() {
        status = .abandoned
    }
}
