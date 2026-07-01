import Foundation
import Testing
@testable import hawky

@MainActor
@Suite struct LiveSendPhotoToolTests {
    @Test func sendPhotoToolSchemaDoesNotAskModelForImageBytes() throws {
        var config = bridgeAvailableConfig()
        config.cocktailPartyEnabled = true

        let definitions = LiveToolRegistry.default.definitions(config: config)
        let definition = try #require(definitions.first { $0["name"] as? String == "send_photo" })
        let parameters = try #require(definition["parameters"] as? [String: Any])
        let properties = try #require(parameters["properties"] as? [String: Any])
        let required = parameters["required"] as? [String] ?? []

        #expect(properties["to"] != nil)
        #expect(properties["comment"] != nil)
        #expect(properties["image_base64"] == nil)
        #expect(!required.contains("image_base64"))
    }

    @Test func sendPhotoToolInvokesGatewayWithLatestCameraFrame() async throws {
        let url = uniqueGatewayURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = SendPhotoRecordingGatewayTransportStore(payload: .success)
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { SendPhotoRecordingGatewayTransport(recorder: recorder) }
        )
        let frameData = Data([0xff, 0xd8, 0xff, 0x01])
        let context = LiveToolContext(
            config: bridgeAvailableConfig(sessionKey: "ios-live-photo"),
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            latestCameraFrame: {
                LiveJPEGFrame(data: frameData, capturedAt: Date())
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "send_photo",
            argumentsJSON: #"{"to":"C0TEAM00001","comment":"from ios"}"#,
            context: context
        )
        let output = try jsonObject(json)
        let frames = recorder.sentFrames()
        let sent = try #require(frames.first)
        let args = try #require(objectParam(sent, "args"))

        #expect(output["ok"] as? Bool == true)
        #expect(output["tool"] as? String == "send_photo")
        #expect(recorder.connectPlatforms() == ["ios-live-send-photo"])
        #expect(frames.count == 1)
        #expect(sent.method == "tool.invoke")
        #expect(stringParam(sent, "tool_name") == "send_photo")
        #expect(stringParam(sent, "session_key") == "ios-live-photo")
        #expect(stringValue(args["image_base64"]) == frameData.base64EncodedString())
        #expect(stringValue(args["to"]) == "C0TEAM00001")
        #expect(stringValue(args["comment"]) == "from ios")
        #expect(stringValue(args["platform"]) == "slack")
    }

    @Test func sendPhotoToolDoesNotCallGatewayWhenFrameIsMissing() async throws {
        let url = uniqueGatewayURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = SendPhotoRecordingGatewayTransportStore(payload: .success)
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { SendPhotoRecordingGatewayTransport(recorder: recorder) }
        )
        let context = LiveToolContext(
            config: bridgeAvailableConfig(),
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            latestCameraFrame: { nil }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "send_photo",
            argumentsJSON: "{}",
            context: context
        )
        let output = try jsonObject(json)
        let error = try #require(output["error"] as? String)

        #expect(output["ok"] as? Bool == false)
        #expect(error.contains("No camera frame"))
        #expect(recorder.sentFrames().isEmpty)
    }

    @Test func sendPhotoToolSurfacesGatewayUploadErrors() async throws {
        let url = uniqueGatewayURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = SendPhotoRecordingGatewayTransportStore(payload: .failure("slack adapter is registered but not ready"))
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { SendPhotoRecordingGatewayTransport(recorder: recorder) }
        )
        let context = LiveToolContext(
            config: bridgeAvailableConfig(),
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            latestCameraFrame: {
                LiveJPEGFrame(data: Data([0xff, 0xd8, 0xff]), capturedAt: Date())
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "send_photo",
            argumentsJSON: "{}",
            context: context
        )
        let output = try jsonObject(json)
        let error = try #require(output["error"] as? String)

        #expect(output["ok"] as? Bool == false)
        #expect(error.contains("slack adapter"))
        #expect(recorder.sentFrames().count == 1)
    }

    @Test func sendPhotoToolDoesNotTreatAmbiguousRecipientAsDelivered() async throws {
        let url = uniqueGatewayURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = SendPhotoRecordingGatewayTransportStore(payload: .ambiguousRecipient)
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { SendPhotoRecordingGatewayTransport(recorder: recorder) }
        )
        let context = LiveToolContext(
            config: bridgeAvailableConfig(),
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            latestCameraFrame: {
                LiveJPEGFrame(data: Data([0xff, 0xd8, 0xff]), capturedAt: Date())
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "send_photo",
            argumentsJSON: #"{"to":"alex"}"#,
            context: context
        )
        let output = try jsonObject(json)
        let error = try #require(output["error"] as? String)

        #expect(output["ok"] as? Bool == false)
        #expect(output["ambiguous"] as? Bool == true)
        #expect(error.contains("Multiple slack matches"))
        #expect((output["candidates"] as? [[String: Any]])?.count == 2)
        #expect(recorder.sentFrames().count == 1)
    }

    @Test func sendPhotoToolRejectsUnsupportedPlatformBeforeGatewayCall() async throws {
        let url = uniqueGatewayURL()
        try KeychainStore.save(token: "test-token", for: url)
        defer { try? KeychainStore.delete(for: url) }

        let recorder = SendPhotoRecordingGatewayTransportStore(payload: .success)
        let bridge = LiveGatewayBridge(
            gatewayURL: url,
            transportFactory: { SendPhotoRecordingGatewayTransport(recorder: recorder) }
        )
        let context = LiveToolContext(
            config: bridgeAvailableConfig(),
            gatewayBridge: bridge,
            awaitPendingTranscriptAppend: nil,
            latestCameraFrame: {
                LiveJPEGFrame(data: Data([0xff, 0xd8, 0xff]), capturedAt: Date())
            }
        )

        let json = await LiveToolRegistry.default.execute(
            name: "send_photo",
            argumentsJSON: #"{"platform":"discord"}"#,
            context: context
        )
        let output = try jsonObject(json)
        let error = try #require(output["error"] as? String)

        #expect(output["ok"] as? Bool == false)
        #expect(error.contains("Slack"))
        #expect(recorder.sentFrames().isEmpty)
    }

    @Test func cameraFrameCacheKeepsFreshToolFrameSeparateFromStreamingState() {
        let firstFrame = LiveJPEGFrame(data: Data([0x01]), capturedAt: Date(timeIntervalSince1970: 1))
        let secondFrame = LiveJPEGFrame(data: Data([0x02]), capturedAt: Date(timeIntervalSince1970: 2))
        var cache = LiveToolCameraFrameCache()

        cache.record(firstFrame, capturedAtNs: 100)
        cache.record(secondFrame, capturedAtNs: 200)

        #expect(cache.freshFrame(isStreamingVisual: true, nowNs: 250, maxAgeNs: 100) == secondFrame)
        #expect(cache.freshFrame(isStreamingVisual: false, nowNs: 250, maxAgeNs: 100) == nil)
        #expect(cache.freshFrame(isStreamingVisual: true, nowNs: 301, maxAgeNs: 100) == nil)
        #expect(cache.freshFrame(isStreamingVisual: true, nowNs: 199, maxAgeNs: 100) == nil)

        cache.clear()
        #expect(cache.freshFrame(isStreamingVisual: true, nowNs: 250, maxAgeNs: 100) == nil)
    }

    private func bridgeAvailableConfig(sessionKey: String = "ios-live") -> LiveSessionConfig {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        config.gatewayBridgeSessionKey = sessionKey
        return config
    }

    private func uniqueGatewayURL() -> URL {
        URL(string: "https://gateway-\(UUID().uuidString).example")!
    }
}

private enum SendPhotoToolPayload {
    case success
    case failure(String)
    case ambiguousRecipient

    var json: JSONValue {
        switch self {
        case .success:
            return .object([
                "ok": .bool(true),
                "result": .object([
                    "type": .string("text"),
                    "content": .string("ok: photo sent to C0TEAM00001 on slack with caption."),
                    "metadata": .object([
                        "platform": .string("slack"),
                        "to": .string("C0TEAM00001"),
                        "bytes": .number(4),
                        "messageId": .string("file1"),
                    ]),
                ]),
            ])
        case .failure(let message):
            return .object([
                "ok": .bool(false),
                "error": .string(message),
            ])
        case .ambiguousRecipient:
            return .object([
                "ok": .bool(true),
                "result": .object([
                    "type": .string("text"),
                    "content": .string("Multiple slack matches for \"alex\" — ask the user which one, then resend with their id."),
                    "metadata": .object([
                        "ambiguous": .bool(true),
                        "candidates": .array([
                            .object([
                                "id": .string("U0AAAAAAAA1"),
                                "label": .string("Alex A"),
                                "kind": .string("user"),
                            ]),
                            .object([
                                "id": .string("U0BBBBBBBB1"),
                                "label": .string("Alex B"),
                                "kind": .string("user"),
                            ]),
                        ]),
                    ]),
                ]),
            ])
        }
    }
}

private final class SendPhotoRecordingGatewayTransportStore: @unchecked Sendable {
    private let lock = NSLock()
    private let payload: SendPhotoToolPayload
    private var frames: [RequestFrame] = []
    private var platforms: [String] = []

    init(payload: SendPhotoToolPayload) {
        self.payload = payload
    }

    func recordConnect(_ params: ConnectParams) {
        lock.lock()
        platforms.append(params.platform)
        lock.unlock()
    }

    func recordSend(_ frame: RequestFrame) {
        lock.lock()
        frames.append(frame)
        lock.unlock()
    }

    func sentFrames() -> [RequestFrame] {
        lock.lock()
        defer { lock.unlock() }
        return frames
    }

    func connectPlatforms() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return platforms
    }

    func responsePayload(for frame: RequestFrame) -> JSONValue {
        frame.method == "tool.invoke" ? payload.json : .object([:])
    }
}

private final class SendPhotoRecordingGatewayTransport: GatewayTransport, @unchecked Sendable {
    private let recorder: SendPhotoRecordingGatewayTransportStore
    var isConnected: Bool { true }

    init(recorder: SendPhotoRecordingGatewayTransportStore) {
        self.recorder = recorder
    }

    func connect(url: URL, connectParams: ConnectParams) async throws -> HelloPayload {
        recorder.recordConnect(connectParams)
        return HelloPayload(connId: "test-conn", serverVersion: "test", methods: [])
    }

    func send(_ frame: RequestFrame) async throws -> ResponseFrame {
        try await send(frame, timeout: nil)
    }

    func send(_ frame: RequestFrame, timeout: TimeInterval?) async throws -> ResponseFrame {
        recorder.recordSend(frame)
        return ResponseFrame(
            type: "res",
            id: frame.id,
            ok: true,
            payload: recorder.responsePayload(for: frame),
            error: nil
        )
    }

    func events() -> AsyncStream<EventFrame> {
        AsyncStream { continuation in continuation.finish() }
    }

    func disconnect() async {}
}

private func objectParam(_ frame: RequestFrame, _ key: String) -> [String: JSONValue]? {
    guard case let .object(object)? = frame.params?[key] else { return nil }
    return object
}

private func stringParam(_ frame: RequestFrame, _ key: String) -> String? {
    stringValue(frame.params?[key])
}

private func stringValue(_ value: JSONValue?) -> String? {
    guard case let .string(text)? = value else { return nil }
    return text
}

private func jsonObject(_ text: String) throws -> [String: Any] {
    guard let data = text.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        throw NSError(domain: "LiveSendPhotoToolTests", code: 1)
    }
    return object
}
