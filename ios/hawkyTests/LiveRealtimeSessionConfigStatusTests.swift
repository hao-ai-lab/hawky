import Foundation
import Testing
@testable import hawky

@Suite struct LiveRealtimeSessionConfigStatusTests {
    @Test func appliedStatusFormatsAsCleanConnected() {
        let status = LiveRealtimeSessionConfigStatus.applied

        #expect(status.diagnosticsLabel == "applied")
        #expect(status.connectedProviderStatus == "Connected")
        #expect(status.connectedMessage == "Connected")
    }

    @Test func unconfirmedStatusFormatsAsDegradedConnected() {
        let status = LiveRealtimeSessionConfigStatus.unconfirmed(detail: "Timed out waiting for session.updated.")

        #expect(status.diagnosticsLabel == "unconfirmed")
        #expect(status.connectedProviderStatus == "Connected (session config unconfirmed)")
        #expect(status.connectedMessage == "Connected (session config unconfirmed)")
    }

    @Test func failedStatusFormatsAsFailure() {
        let status = LiveRealtimeSessionConfigStatus.failed(detail: "invalid session.update")

        #expect(status.diagnosticsLabel == "failed")
        #expect(status.connectedProviderStatus == "Session config failed")
        #expect(status.connectedMessage == "Session config failed")
    }
}

@MainActor
private final class FrameFeederMockProvider: LiveSessionProvider {
    private let sendDelayNs: UInt64
    private let sendResult: Bool
    private let stream: AsyncStream<LiveSessionEvent>

    private(set) var sentFrames: [LiveJPEGFrame] = []

    init(sendDelayNs: UInt64 = 0, sendResult: Bool = true) {
        self.sendDelayNs = sendDelayNs
        self.sendResult = sendResult
        self.stream = AsyncStream { continuation in
            continuation.finish()
        }
    }

    func connect(config: LiveSessionConfig) async throws {}
    func setAudioInputEnabled(_ enabled: Bool) async throws {}
    func sendAudio(_ chunk: LiveAudioChunk) async throws {}
    func streamAudio(_ chunk: LiveAudioChunk) async throws {}
    func commitAudioStream() async throws {}

    func sendFrame(_ frame: LiveJPEGFrame) async throws -> Bool {
        sentFrames.append(frame)
        if sendDelayNs > 0 {
            try? await Task.sleep(nanoseconds: sendDelayNs)
        }
        return sendResult
    }

    func sendText(_ text: String) async throws {}
    func sendContext(_ text: String, createResponse: Bool) async throws {}
    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {}
    func events() -> AsyncStream<LiveSessionEvent> { stream }
    func close() async {}
}

@Suite struct LiveRealtimeFastPathTests {
    @Test func openAIRealtimeDefersLiveUploadAtRuntime() {
        var config = LiveSessionConfig()
        config.provider = .openAIRealtime
        config.mediaPersistenceMode = .liveUpload

        let result = LiveSessionStore.realtimeFastPathConfig(config)

        #expect(result.config.mediaPersistenceMode == .deferredUpload)
        #expect(result.deferredLiveUpload)
        #expect(config.mediaPersistenceMode == .liveUpload)
    }

    @Test func openAIRealtimeLeavesLocalAndOffModesUnchanged() {
        var config = LiveSessionConfig()
        config.provider = .openAIRealtime

        config.mediaPersistenceMode = .local
        var result = LiveSessionStore.realtimeFastPathConfig(config)
        #expect(result.config.mediaPersistenceMode == .local)
        #expect(!result.deferredLiveUpload)

        config.mediaPersistenceMode = .off
        result = LiveSessionStore.realtimeFastPathConfig(config)
        #expect(result.config.mediaPersistenceMode == .off)
        #expect(!result.deferredLiveUpload)
    }

    @Test func nonRealtimeProviderKeepsLiveUploadMode() {
        var config = LiveSessionConfig()
        config.provider = .geminiLive
        config.mediaPersistenceMode = .liveUpload

        let result = LiveSessionStore.realtimeFastPathConfig(config)

        #expect(result.config.mediaPersistenceMode == .liveUpload)
        #expect(!result.deferredLiveUpload)
    }
}

@Suite struct LiveTimelineStoreTests {
    @Test func speechWindowSnapshotsNearestVisualFrames() {
        let timeline = LiveTimelineStore()

        let first = timeline.noteVisualFrame(
            capturedAtNs: 1_000_000_000,
            capturedAt: Date(timeIntervalSince1970: 1),
            byteCount: 10
        )
        let second = timeline.noteVisualFrame(
            capturedAtNs: 1_800_000_000,
            capturedAt: Date(timeIntervalSince1970: 2),
            byteCount: 20
        )
        let speech = timeline.noteSpeechStarted(atNs: 1_500_000_000, realtimeItemID: "item_1")
        let snapshot = timeline.noteSpeechStopped(atNs: 2_000_000_000)

        #expect(speech.id == "ios_speech_1")
        #expect(snapshot?.speechWindowID == "ios_speech_1")
        #expect(snapshot?.realtimeItemID == "item_1")
        #expect(snapshot?.visualFrameRefs.map(\.id) == [first.id, second.id])
    }

    @Test func realtimeSentAndTranscriptUpdateExistingSnapshot() {
        let timeline = LiveTimelineStore()

        let frame = timeline.noteVisualFrame(
            capturedAtNs: 1_000,
            capturedAt: Date(timeIntervalSince1970: 1),
            byteCount: 10
        )
        _ = timeline.noteSpeechStarted(atNs: 900, realtimeItemID: "item_1")
        _ = timeline.noteSpeechStopped(atNs: 1_100)

        timeline.markVisualFrameSentToRealtime(id: frame.id, atNs: 1_200)
        timeline.attachTranscript(itemID: "item_1", transcript: "look at this")

        #expect(timeline.hasRealtimeVisualSent(within: 500, nowNs: 1_500))
        #expect(timeline.turnSnapshots.last?.transcript == "look at this")
        #expect(timeline.turnSnapshots.last?.visualFrameRefs.last?.sentToRealtimeAtNs == 1_200)
    }
}

@Suite @MainActor
struct RealtimeFrameFeederTests {
    @Test func busyProviderKeepsOnlyLatestPendingFrame() async throws {
        let feeder = RealtimeFrameFeeder(frameTTL: 10)
        let provider = FrameFeederMockProvider(sendDelayNs: 40_000_000)

        feeder.offer(LiveJPEGFrame(data: Data([1]), capturedAt: Date()), provider: provider, onError: { _ in })
        feeder.offer(LiveJPEGFrame(data: Data([2]), capturedAt: Date()), provider: provider, onError: { _ in })
        feeder.offer(LiveJPEGFrame(data: Data([3]), capturedAt: Date()), provider: provider, onError: { _ in })

        await waitForFrameFeeder(provider: provider, feeder: feeder, expectedFrameCount: 2)

        #expect(provider.sentFrames.map(\.data) == [Data([1]), Data([3])])
        #expect(feeder.busyDropCount == 1)
        #expect(!feeder.isBusy)
    }

    @Test func expiredFrameDropsWithoutStartingSend() {
        let feeder = RealtimeFrameFeeder(frameTTL: 0.5)
        let provider = FrameFeederMockProvider()

        feeder.offer(
            LiveJPEGFrame(data: Data([9]), capturedAt: Date().addingTimeInterval(-2)),
            provider: provider,
            onError: { _ in }
        )

        #expect(provider.sentFrames.isEmpty)
        #expect(feeder.expiredDropCount == 1)
        #expect(!feeder.isBusy)
    }

    @Test func providerDroppedFrameDoesNotAcknowledgeSent() async {
        let feeder = RealtimeFrameFeeder(frameTTL: 10)
        let provider = FrameFeederMockProvider(sendResult: false)
        var acknowledgedFrames: [LiveJPEGFrame] = []

        feeder.offer(
            LiveJPEGFrame(data: Data([7]), capturedAt: Date()),
            provider: provider,
            onSent: { acknowledgedFrames.append($0) },
            onError: { _ in }
        )

        await waitForFrameFeeder(provider: provider, feeder: feeder, expectedFrameCount: 1)

        #expect(provider.sentFrames.map(\.data) == [Data([7])])
        #expect(acknowledgedFrames.isEmpty)
        #expect(!feeder.isBusy)
    }

    private func waitForFrameFeeder(
        provider: FrameFeederMockProvider,
        feeder: RealtimeFrameFeeder,
        expectedFrameCount: Int
    ) async {
        for _ in 0..<50 {
            if provider.sentFrames.count >= expectedFrameCount, !feeder.isBusy { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

@Suite struct LiveVoiceprintBridgeContractTests {
    @Test func realtimeEventParamsUseGatewayContractKeys() throws {
        let event = LiveVoiceprintRealtimeEvent(
            type: "input_audio_buffer.speech_started",
            itemID: "rt_voiceprint_swift",
            speechWindowID: nil,
            audioStartMs: 1200,
            audioEndMs: nil,
            transcript: nil,
            audioArtifactID: nil,
            audioPath: nil,
            sampleRate: nil,
            route: "airpods"
        )

        let params = LiveVoiceprintRealtimeEvent.params(
            sessionKey: "live:voiceprint-swift",
            event: event,
            includeMissingAudio: true
        )
        let eventObject = try #require(params["event"])

        #expect(params["sessionKey"] == .string("live:voiceprint-swift"))
        #expect(params["includeMissingAudio"] == .bool(true))
        guard case let .object(object) = eventObject else {
            Issue.record("event must be an object")
            return
        }
        #expect(object["type"] == .string("input_audio_buffer.speech_started"))
        #expect(object["item_id"] == .string("rt_voiceprint_swift"))
        #expect(object["audio_start_ms"] == .number(1200))
        #expect(object["route"] == .string("airpods"))
        #expect(object["speech_window_id"] == nil)
    }

    @Test func realtimeResultDecodesFinalizedTurnsWithoutSamples() throws {
        let payload: JSONValue = .object([
            "ok": .bool(true),
            "sessionKey": .string("live:voiceprint-swift"),
            "pendingSpeechWindows": .number(0),
            "pendingTranscripts": .number(1),
            "finalizedTurns": .array([
                .object([
                    "sessionKey": .string("live:voiceprint-swift"),
                    "transcriptItemId": .string("rt_voiceprint_swift"),
                    "role": .string("user"),
                    "text": .string("owner spoke here"),
                    "startMs": .number(1000),
                    "endMs": .number(2300),
                    "audioArtifactId": .string("audio_voiceprint_swift"),
                    "audioPath": .string("/tmp/audio_voiceprint_swift.wav"),
                    "route": .string("iphone_mic"),
                    "speechWindowId": .string("rt_voiceprint_swift"),
                ]),
            ]),
        ])

        let result = try #require(LiveVoiceprintRealtimeResult(payload: payload))

        #expect(result.ok)
        #expect(result.sessionKey == "live:voiceprint-swift")
        #expect(result.pendingSpeechWindows == 0)
        #expect(result.pendingTranscripts == 1)
        #expect(result.finalizedTurns.count == 1)
        #expect(result.finalizedTurns[0].transcriptItemID == "rt_voiceprint_swift")
        #expect(result.finalizedTurns[0].audioArtifactID == "audio_voiceprint_swift")
        #expect(result.finalizedTurns[0].speechWindowID == "rt_voiceprint_swift")
    }

    @Test func rawRealtimeParserPreservesStableJoinKeys() throws {
        let event = try #require(LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_started",
            rawJSON: """
            {
              "type": "input_audio_buffer.speech_started",
              "item_id": "rt_voiceprint_raw",
              "audio_start_ms": 420,
              "route": "airpods"
            }
            """,
            route: "iphone_mic"
        ))

        #expect(event.type == "input_audio_buffer.speech_started")
        #expect(event.itemID == "rt_voiceprint_raw")
        #expect(event.audioStartMs == 420)
        #expect(event.route == "airpods")
    }

    @Test func rawTranscriptParserRequiresItemID() {
        let event = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "conversation.item.input_audio_transcription.completed",
            rawJSON: #"{"transcript":"missing item id"}"#,
            route: "iphone_mic"
        )

        #expect(event == nil)
    }

    @Test func rawSpeechParserRequiresRecordingRelativeOffsets() {
        let event = LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_started",
            rawJSON: "{}",
            route: "iphone_mic"
        )

        #expect(event == nil)
    }

    @Test func rawSpeechParserUsesRecordingOffsetFallback() throws {
        let event = try #require(LiveSessionStore.voiceprintRealtimeEvent(
            rawType: "input_audio_buffer.speech_stopped",
            rawJSON: "{}",
            route: "iphone_mic",
            recordingOffsetMs: 1550
        ))

        #expect(event.audioEndMs == 1550)
        #expect(event.route == "iphone_mic")
    }

    @Test func fallbackSpeechWindowQueueConsumesClosedWindowsInOrder() {
        var closedSpeechWindowIDs = ["speech_1", "speech_2"]

        let first = LiveSessionStore.consumeVoiceprintFallbackSpeechWindowID(
            forTranscriptItemID: "transcript_1",
            from: &closedSpeechWindowIDs,
            transcriptAlreadySent: false
        )
        let second = LiveSessionStore.consumeVoiceprintFallbackSpeechWindowID(
            forTranscriptItemID: "transcript_2",
            from: &closedSpeechWindowIDs,
            transcriptAlreadySent: false
        )

        #expect(first == "speech_1")
        #expect(second == "speech_2")
        #expect(closedSpeechWindowIDs.isEmpty)
    }

    @Test func fallbackSpeechWindowQueueMirrorsRawTranscriptConsumption() {
        var explicitItemWindows = ["rt_a", "rt_b"]
        let explicitDuplicate = LiveSessionStore.consumeVoiceprintFallbackSpeechWindowID(
            forTranscriptItemID: "rt_b",
            from: &explicitItemWindows,
            transcriptAlreadySent: true
        )

        var fifoWindows = ["speech_1", "speech_2"]
        let fifoDuplicate = LiveSessionStore.consumeVoiceprintFallbackSpeechWindowID(
            forTranscriptItemID: "rt_without_window",
            from: &fifoWindows,
            transcriptAlreadySent: true
        )

        #expect(explicitDuplicate == nil)
        #expect(explicitItemWindows == ["rt_a"])
        #expect(fifoDuplicate == nil)
        #expect(fifoWindows == ["speech_2"])
    }

    @Test func audioArtifactEventUsesTurnScopedArtifactID() {
        let event = LiveSessionStore.voiceprintAudioArtifactEvent(
            itemID: "rt_voiceprint_artifact",
            speechWindowID: nil,
            artifact: LiveVoiceprintAudioArtifactReference(
                audioArtifactID: "live-20260624-voice",
                audioPath: "/tmp/live-20260624-voice.wav",
                sampleRate: 48_000
            ),
            route: "iphone_mic"
        )

        #expect(event.type == "live_recording.audio_artifact")
        #expect(event.itemID == "rt_voiceprint_artifact")
        #expect(event.audioArtifactID == "live-20260624-voice:rt_voiceprint_artifact")
        #expect(event.audioPath == "/tmp/live-20260624-voice.wav")
        #expect(event.sampleRate == 48_000)
    }

    @Test func runtimeTargetRequiresBridgeAndSavedAudio() {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.gatewayBridgeSessionMode = .fixed
        config.gatewayBridgeSessionKey = "realtime:voiceprint-target"
        config.audioInputEnabled = true
        config.mediaPersistenceMode = .local

        #expect(LiveSessionStore.voiceprintRealtimeRuntimeTarget(
            activeConfig: config,
            draftConfig: LiveSessionConfig()
        ) == nil)

        config.voiceprintRealtimeEnabled = true
        let target = LiveSessionStore.voiceprintRealtimeRuntimeTarget(
            activeConfig: config,
            draftConfig: LiveSessionConfig()
        )
        #expect(target?.sessionKey == "realtime:voiceprint-target")

        config.mediaPersistenceMode = .off
        #expect(LiveSessionStore.voiceprintRealtimeRuntimeTarget(
            activeConfig: config,
            draftConfig: LiveSessionConfig()
        ) == nil)
    }
}
