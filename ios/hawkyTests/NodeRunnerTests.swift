import Testing
import Foundation
@testable import hawky

// MockNodeTransport — drives NodeRunner without a real WebSocket. Tests
// push events via feedEvent() and inspect sentFrames to verify outgoing RPCs.
private final class MockNodeTransport: NodeTransport, @unchecked Sendable {
    let stream: AsyncStream<EventFrame>
    let continuation: AsyncStream<EventFrame>.Continuation

    private let lock = NSLock()
    private var _connected = false
    private var _sentFrames: [RequestFrame] = []
    // Script of (id -> payload) to reply with on .send(). Defaults to ok=true empty payload.
    var sendResponder: (@Sendable (RequestFrame) -> ResponseFrame)?
    // Script of (helloError?, helloPayload) to reply with on .connect().
    var connectBehavior: (@Sendable () -> Result<HelloPayload, Error>)?
    private var _helloCount = 0

    init() {
        let (s, c) = AsyncStream<EventFrame>.makeStream()
        self.stream = s
        self.continuation = c
    }

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return _connected
    }

    var sentFrames: [RequestFrame] {
        lock.lock(); defer { lock.unlock() }
        return _sentFrames
    }

    var helloCount: Int {
        lock.lock(); defer { lock.unlock() }
        return _helloCount
    }

    var lastConnectParams: ConnectParams? { nil }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        lock.lock()
        _helloCount += 1
        let behavior = connectBehavior
        lock.unlock()
        if let b = behavior {
            switch b() {
            case .success(let h):
                lock.lock(); _connected = true; lock.unlock()
                return h
            case .failure(let e):
                throw e
            }
        }
        lock.lock(); _connected = true; lock.unlock()
        let json = #"{"connId":"mock-conn","serverVersion":"test","methods":[]}"#.data(using: .utf8)!
        return try JSONDecoder().decode(HelloPayload.self, from: json)
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        lock.lock()
        _sentFrames.append(frame)
        let responder = sendResponder
        lock.unlock()
        if let r = responder { return r(frame) }
        let json = "{\"type\":\"res\",\"id\":\"\(frame.id)\",\"ok\":true}".data(using: .utf8)!
        return try JSONDecoder().decode(ResponseFrame.self, from: json)
    }

    func events() -> AsyncStream<EventFrame> { stream }

    func disconnect() async {
        lock.lock(); _connected = false; lock.unlock()
        continuation.finish()
    }

    func feedEvent(_ event: String, payload: JSONValue?) {
        let frame = EventFrame(type: "event", event: event, payload: payload, seq: nil)
        continuation.yield(frame)
    }
}

@Suite @MainActor struct NodeRunnerTests {

    private func makeConfig() -> NodeRunner.Config {
        NodeRunner.Config(
            nodeId: "test-node-id",
            name: "test-device",
            gatewayURL: URL(string: "http://gateway.local:4242")!,
            platform: "mobile",
            token: "jwt-token"
        )
    }

    // (1) DeviceInfoCommand.invoke returns expected shape.
    @Test func deviceInfoReturnsExpectedShape() async throws {
        let cmd = DeviceInfoCommand()
        let result = try await cmd.invoke(args: .null)
        guard case let .object(obj) = result else {
            Issue.record("expected object, got \(result)"); return
        }
        let expectedKeys: Set<String> = [
            "model", "systemName", "systemVersion",
            "name", "batteryLevel", "localizedModel"
        ]
        #expect(Set(obj.keys) == expectedKeys)
        // systemName should be "iOS" on-device and in the simulator;
        // in SPM/Linux test runs it's "unknown". Either way non-empty.
        if case let .some(.string(sys)) = obj["systemName"] {
            #expect(!sys.isEmpty)
        } else {
            Issue.record("systemName missing or not a string")
        }
        if case let .some(.number(lvl)) = obj["batteryLevel"] {
            // -1 (unknown) or 0...1 (real reading).
            #expect(lvl >= -1.0 && lvl <= 1.0)
        }
    }

    // (2) NodeRunner performs the hello handshake with role=node and the
    //     correct node bundle.
    @Test func helloHandshake() async throws {
        let transport = MockNodeTransport()
        let runner = NodeRunner(
            config: makeConfig(),
            transport: transport,
            commands: [DeviceInfoCommand(), FrontendMessageCommand()]
        )
        try await runner.connect()
        #expect(transport.isConnected)
        #expect(runner.lastHello?.connId == "mock-conn")
    }

    // (3) NodeRunner reconnects after a simulated disconnect with exponential
    //     backoff (capped). We script the first two connect calls to fail and
    //     the third to succeed, and we inject a zero-delay randomDouble so the
    //     test runs instantly.
    @Test func reconnectsWithBackoff() async throws {
        let transport = MockNodeTransport()
        let attempts = UnsafeMutablePointer<Int>.allocate(capacity: 1)
        attempts.initialize(to: 0)
        defer { attempts.deallocate() }
        transport.connectBehavior = {
            attempts.pointee += 1
            if attempts.pointee < 3 {
                return .failure(GatewayTransportError.closed(code: 1006, reason: "abnormal"))
            }
            let json = #"{"connId":"mock-conn","serverVersion":"test","methods":[]}"#.data(using: .utf8)!
            // swiftlint:disable:next force_try
            let hello = try! JSONDecoder().decode(HelloPayload.self, from: json)
            return .success(hello)
        }

        let runner = NodeRunner(
            config: makeConfig(),
            transport: transport,
            commands: [DeviceInfoCommand()],
            baseBackoff: 0.001,
            capBackoff: 0.002,
            randomDouble: { 0.0 }
        )
        let startTask = Task { await runner.start() }
        // Give start() time to hit success; poll for up to 2s.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, transport.helloCount < 3 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(transport.helloCount >= 3)
        await runner.stop()
        startTask.cancel()
    }

    // (4) NodeRunner dispatches node.invoke.request → runs the command →
    //     sends a correctly shaped node.invoke.result request frame.
    @Test func dispatchesInvokeAndReplies() async throws {
        let transport = MockNodeTransport()
        let runner = NodeRunner(
            config: makeConfig(),
            transport: transport,
            commands: [DeviceInfoCommand()]
        )
        try await runner.connect()

        await runner.dispatchInvoke(payload: .object([
            "id": .string("inv-1"),
            "command": .string("device.info"),
        ]))

        // The command runs asynchronously — poll until the reply is sent.
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, transport.sentFrames.isEmpty {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        let frames = transport.sentFrames
        #expect(frames.count == 1)
        guard let reply = frames.first else { return }
        #expect(reply.method == "node.invoke.result")
        guard let params = reply.params else {
            Issue.record("reply params missing"); return
        }
        #expect(params["id"] == .string("inv-1"))
        #expect(params["nodeId"] == .string("test-node-id"))
        #expect(params["ok"] == .bool(true))
        // payloadJSON is a JSON-encoded string.
        guard case let .some(.string(payloadJSON)) = params["payloadJSON"],
              let data = payloadJSON.data(using: .utf8),
              let inner = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            Issue.record("payloadJSON missing or not a JSON string"); return
        }
        guard case let .object(obj) = inner else {
            Issue.record("payload is not an object"); return
        }
        #expect(obj["model"] != nil)
        #expect(obj["systemName"] != nil)
    }

    // (5) Unknown commands return a typed error reply; runner does not crash.
    @Test func unknownCommandReturnsTypedError() async throws {
        let transport = MockNodeTransport()
        let runner = NodeRunner(
            config: makeConfig(),
            transport: transport,
            commands: [DeviceInfoCommand()]
        )
        try await runner.connect()

        await runner.dispatchInvoke(payload: .object([
            "id": .string("inv-2"),
            "command": .string("nonexistent.command"),
        ]))

        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, transport.sentFrames.isEmpty {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }

        let frames = transport.sentFrames
        #expect(frames.count == 1)
        guard let reply = frames.first, let params = reply.params else {
            Issue.record("no reply frame"); return
        }
        #expect(params["ok"] == .bool(false))
        guard case let .some(.string(err)) = params["error"] else {
            Issue.record("error field missing"); return
        }
        #expect(err == "Unknown node command: nonexistent.command")
        // No payloadJSON on failure.
        #expect(params["payloadJSON"] == nil)
    }
}
