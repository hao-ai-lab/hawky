import Foundation
import Testing
@testable import hawky

@Suite @MainActor
struct KeyframeUploaderTests {
    @Test func sendsFramesThroughMediaChunkLiveFramePath() async throws {
        let transport = MockGatewayTransport()
        let uploader = KeyframeUploader()

        uploader.start(transport: transport, captureId: "rec-20260529-120000")
        uploader.ingest(jpegBytes: Data([0xFF, 0xD8, 0xFF]), capturedAtNs: 123_456)
        await uploader.stop()

        #expect(transport.sentFrames.count == 1)
        let frame = try #require(transport.sentFrames.first)
        #expect(frame.method == "media.chunk.upload")
        let params = try #require(frame.params)
        #expect(params["session_key"] == .string("rec-20260529-120000"))
        #expect(params["media_kind"] == .string("frame"))
        #expect(params["mime"] == .string("image/jpeg"))
        #expect(params["ts_captured_ns"] == .number(123_456))
        #expect(params["bytes"] == .string(Data([0xFF, 0xD8, 0xFF]).base64EncodedString()))
    }

    @Test func localOnlyModeDoesNotQueueFrames() async throws {
        let uploader = KeyframeUploader()

        uploader.start(transport: nil, captureId: "rec-20260529-120000")
        uploader.ingest(jpegBytes: Data([0xFF, 0xD8, 0xFF]), capturedAtNs: 123_456)
        await uploader.stop()

        #expect(uploader.queueDepth == 0)
        #expect(uploader.droppedCount == 0)
    }

    @Test func audioUploaderResetDropsPendingDisconnectedSegments() async throws {
        let transport = MockGatewayTransport()
        transport.isConnected = false
        let uploader = Uploader()

        uploader.start(transport: transport, mediaId: "rec-20260529-120000.mic")
        uploader.ingest(
            chunk: AudioChunk(
                pcm: Data(repeating: 0x01, count: 4_000),
                timestamp: 0,
                sampleRate: 100
            ),
            capturedAtNs: 123_456
        )
        await uploader.stop()
        #expect(transport.sentFrames.isEmpty)

        transport.isConnected = true
        uploader.reset()
        await uploader.stop()

        #expect(transport.sentFrames.isEmpty)
    }
}

@Suite
struct ReconnectingTransportTests {
    @Test func forwardsCustomSendTimeoutToUnderlyingTransport() async throws {
        let underlying = TimeoutCapturingGatewayTransport()
        let transport = ReconnectingTransport(factory: { underlying })
        _ = try await transport.connect(
            url: URL(string: "ws://localhost:4242")!,
            connectParams: ConnectParams(
                version: "1",
                platform: "test",
                token: "token",
                sessionKey: "ios:test",
                role: "client"
            )
        )

        _ = try await transport.send(
            RequestFrame(id: "timeout-test", method: "test.method", params: nil),
            timeout: 42
        )

        #expect(underlying.observedTimeouts == [42])
    }
}

private final class MockGatewayTransport: GatewayTransport, @unchecked Sendable {
    var sentFrames: [RequestFrame] = []
    var isConnected: Bool = true

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        HelloPayload(connId: "test", serverVersion: "test", methods: [])
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        sentFrames.append(frame)
        return ResponseFrame(
            type: "res",
            id: frame.id,
            ok: true,
            payload: .object(["ok": .bool(true)]),
            error: nil
        )
    }

    func events() -> AsyncStream<EventFrame> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func disconnect() async {}
}

private final class TimeoutCapturingGatewayTransport: GatewayTransport, @unchecked Sendable {
    private(set) var observedTimeouts: [TimeInterval?] = []
    var isConnected: Bool = false

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        isConnected = true
        return HelloPayload(connId: "timeout-test", serverVersion: "test", methods: [])
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        try await send(frame, timeout: nil)
    }

    func send(_ frame: RequestFrame, timeout: TimeInterval?) async throws -> ResponseFrame {
        observedTimeouts.append(timeout)
        return ResponseFrame(
            type: "res",
            id: frame.id,
            ok: true,
            payload: .object(["ok": .bool(true)]),
            error: nil
        )
    }

    func events() -> AsyncStream<EventFrame> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func disconnect() async {
        isConnected = false
    }
}
