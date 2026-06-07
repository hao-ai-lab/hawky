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
