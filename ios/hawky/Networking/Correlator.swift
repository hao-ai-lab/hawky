import Foundation

actor Correlator {
    private var pending: [String: CheckedContinuation<ResponseFrame, Error>] = [:]
    private var timers: [String: Task<Void, Never>] = [:]
    private let defaultTimeout: TimeInterval

    init(defaultTimeout: TimeInterval = 30) {
        self.defaultTimeout = defaultTimeout
    }

    func register(id: String, timeout: TimeInterval? = nil) async throws -> ResponseFrame {
        let t = timeout ?? defaultTimeout
        return try await withCheckedThrowingContinuation { cont in
            // Guard against duplicate id registration — reject the new one, leave old one alone.
            if pending[id] != nil {
                cont.resume(throwing: GatewayTransportError.decodeError(message: "duplicate id registered: \(id)"))
                return
            }
            pending[id] = cont
            let task = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(t * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.fireTimeout(id: id)
            }
            timers[id] = task
        }
    }

    func resolve(_ frame: ResponseFrame) {
        guard let cont = pending.removeValue(forKey: frame.id) else {
            // Idempotent: extra resolves (duplicate res from server, or post-timeout) are logged & ignored.
            NSLog("[Correlator] ignoring resolve for unknown id=\(frame.id)")
            return
        }
        timers.removeValue(forKey: frame.id)?.cancel()
        cont.resume(returning: frame)
    }

    func reject(id: String, error: Error) {
        guard let cont = pending.removeValue(forKey: id) else { return }
        timers.removeValue(forKey: id)?.cancel()
        cont.resume(throwing: error)
    }

    func rejectAll(error: Error) {
        let all = pending
        pending.removeAll()
        for (_, task) in timers { task.cancel() }
        timers.removeAll()
        for (_, cont) in all { cont.resume(throwing: error) }
    }

    private func fireTimeout(id: String) {
        guard let cont = pending.removeValue(forKey: id) else { return }
        timers.removeValue(forKey: id)
        cont.resume(throwing: GatewayTransportError.decodeError(message: "request timed out: \(id)"))
    }

    func pendingCount() -> Int { pending.count }
}
