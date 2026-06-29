import Testing
import Foundation
@testable import hawky

@Suite struct CorrelatorTests {
    private func makeResponse(id: String, ok: Bool = true) -> ResponseFrame {
        // Build proper ResponseFrame via JSON decode.
        let json = #"{"type":"res","id":"\#(id)","ok":\#(ok)}"#
        return try! JSONDecoder().decode(ResponseFrame.self, from: Data(json.utf8))
    }

    @Test func registerAndResolve() async throws {
        let c = Correlator()
        let id = "r1"
        async let awaited = c.register(id: id)
        try await Task.sleep(nanoseconds: 5_000_000)
        await c.resolve(makeResponse(id: id))
        let r = try await awaited
        #expect(r.id == id)
        let count = await c.pendingCount()
        #expect(count == 0)
    }

    @Test func concurrentRegisterResolve() async throws {
        let c = Correlator()
        let ids = (0..<50).map { "id-\($0)" }
        await withTaskGroup(of: String?.self) { group in
            for id in ids {
                group.addTask {
                    do {
                        let r = try await c.register(id: id)
                        return r.id
                    } catch {
                        return nil
                    }
                }
            }
            // Shuffle and resolve concurrently.
            let shuffled = ids.shuffled()
            for id in shuffled {
                Task {
                    // Small staggered delay to exercise out-of-order arrival.
                    try? await Task.sleep(nanoseconds: UInt64.random(in: 0..<2_000_000))
                    await c.resolve(self.makeResponse(id: id))
                }
            }
            var got = Set<String>()
            for await result in group {
                if let id = result { got.insert(id) }
            }
            #expect(got.count == ids.count)
        }
        let pending = await c.pendingCount()
        #expect(pending == 0)
    }

    @Test func doubleResolveIsNoop() async throws {
        let c = Correlator()
        let id = "dup"
        async let awaited = c.register(id: id)
        try await Task.sleep(nanoseconds: 2_000_000)
        await c.resolve(makeResponse(id: id))
        _ = try await awaited
        // Second resolve must not crash.
        await c.resolve(makeResponse(id: id))
        let pending = await c.pendingCount()
        #expect(pending == 0)
    }

    @Test func timeoutFires() async throws {
        let c = Correlator(defaultTimeout: 0.05)
        let start = Date()
        do {
            _ = try await c.register(id: "t1")
            Issue.record("expected timeout")
        } catch {
            let elapsed = Date().timeIntervalSince(start)
            #expect(elapsed >= 0.04)
        }
        let pending = await c.pendingCount()
        #expect(pending == 0)
    }

    @Test func rejectAllWakesEveryone() async throws {
        let c = Correlator()
        let ids = (0..<10).map { "ra-\($0)" }
        await withTaskGroup(of: Bool.self) { group in
            for id in ids {
                group.addTask {
                    do {
                        _ = try await c.register(id: id)
                        return false
                    } catch {
                        return true
                    }
                }
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
            await c.rejectAll(error: GatewayTransportError.closed(code: 1006, reason: "gone"))
            var errors = 0
            for await ok in group { if ok { errors += 1 } }
            #expect(errors == ids.count)
        }
        let pending = await c.pendingCount()
        #expect(pending == 0)
    }
}
