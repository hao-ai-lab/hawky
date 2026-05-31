import Foundation
import os

// ReconnectingTransport — wraps a GatewayTransport factory with full-jitter exponential backoff.
// Hardening note: doubling-only backoff with no jitter caused thundering-herd
// reconnects and 30 s stalls on brief server blips. Full jitter fixes both.
// Not retried: .unauthorized and explicit policy close (1008) — caller must re-auth.
final class ReconnectingTransport: GatewayTransport, @unchecked Sendable {
    private let factory: @Sendable () -> GatewayTransport
    private let baseDelay: TimeInterval
    private let capDelay: TimeInterval
    private let totalBudget: TimeInterval
    private let randomDouble: @Sendable () -> Double

    private struct State {
        var underlying: GatewayTransport?
        var lastURL: URL?
        var lastParams: ConnectParams?
        var stopped = false
        var pumpTask: Task<Void, Never>?
    }
    private let state = OSAllocatedUnfairLock<State>(initialState: State())
    private let eventStream: AsyncStream<EventFrame>
    private let eventContinuation: AsyncStream<EventFrame>.Continuation

    init(factory: @escaping @Sendable () -> GatewayTransport,
         baseDelay: TimeInterval = 2,
         capDelay: TimeInterval = 30,
         totalBudget: TimeInterval = 15 * 60,
         randomDouble: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }) {
        self.factory = factory
        self.baseDelay = baseDelay
        self.capDelay = capDelay
        self.totalBudget = totalBudget
        self.randomDouble = randomDouble
        let (s, c) = AsyncStream<EventFrame>.makeStream()
        self.eventStream = s
        self.eventContinuation = c
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        state.withLock {
            $0.lastURL = url
            $0.lastParams = connectParams
            $0.stopped = false
        }

        let t = factory()
        do {
            let hello = try await t.connect(url: url, connectParams: connectParams)
            adopt(t)
            return hello
        } catch let e as GatewayTransportError {
            switch e {
            case .unauthorized, .closed(1008, _):
                throw e
            default:
                break
            }
            return try await retryConnect(startedAt: Date())
        }
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        let t = state.withLock { $0.underlying }
        guard let t else { throw GatewayTransportError.notConnected }
        return try await t.send(frame)
    }

    func events() -> AsyncStream<EventFrame> { eventStream }

    var isConnected: Bool {
        let t = state.withLock { $0.underlying }
        return t?.isConnected ?? false
    }

    func disconnect() async {
        let (t, pump) = state.withLock { s -> (GatewayTransport?, Task<Void, Never>?) in
            s.stopped = true
            let t = s.underlying
            let pump = s.pumpTask
            s.underlying = nil
            s.pumpTask = nil
            return (t, pump)
        }
        pump?.cancel()
        if let t { await t.disconnect() }
        eventContinuation.finish()
    }

    // MARK: - internals

    private func adopt(_ t: GatewayTransport) {
        let prev = state.withLock { s -> Task<Void, Never>? in
            let prev = s.pumpTask
            s.underlying = t
            return prev
        }
        prev?.cancel()
        let src = t.events()
        let cont = eventContinuation
        let task = Task.detached {
            for await ev in src {
                cont.yield(ev)
            }
        }
        state.withLock { $0.pumpTask = task }
    }

    private func retryConnect(startedAt: Date) async throws -> HelloPayload {
        var attempt = 0
        while true {
            let (isStopped, url, params) = state.withLock { s -> (Bool, URL?, ConnectParams?) in
                (s.stopped, s.lastURL, s.lastParams)
            }
            if isStopped { throw GatewayTransportError.abandoned }
            if Date().timeIntervalSince(startedAt) >= totalBudget {
                throw GatewayTransportError.abandoned
            }
            // Full jitter: next = random(0, min(cap, base * 2^n))
            let ceiling = min(capDelay, baseDelay * pow(2.0, Double(attempt)))
            let delay = randomDouble() * ceiling
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            attempt += 1

            guard let url, let params else {
                throw GatewayTransportError.notConnected
            }
            let t = factory()
            do {
                let hello = try await t.connect(url: url, connectParams: params)
                adopt(t)
                return hello
            } catch let e as GatewayTransportError {
                switch e {
                case .unauthorized, .closed(1008, _):
                    throw e
                default:
                    continue
                }
            } catch {
                continue
            }
        }
    }
}
