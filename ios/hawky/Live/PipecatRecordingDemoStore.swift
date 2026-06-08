import AVFoundation
import Foundation
import os
import PipecatClientIOS
import PipecatClientIOSOpenAIRealtimeWebrtc

struct PipecatRecordingSession: Identifiable, Equatable {
    let id: String
    let folderURL: URL
    let startedAt: Date
    let audioURL: URL
    let videoURL: URL
    let manifestURL: URL
    let messagesURL: URL
    let openAIEventsURL: URL
    let keyframesDirectoryURL: URL
    let audioBytes: UInt64
    let videoBytes: UInt64
    let keyframeCount: Int

    var folderName: String { folderURL.lastPathComponent }
}

@MainActor
final class PipecatRecordingDemoStore: NSObject, ObservableObject, RTVIClientDelegate {
    @Published var apiKey: String = UserDefaults.standard.string(forKey: apiKeyStorageKey)
        ?? ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
        ?? ""
    @Published var model: String = UserDefaults.standard.string(forKey: modelStorageKey) ?? "gpt-realtime-2"
    @Published var instructions: String = UserDefaults.standard.string(forKey: instructionsStorageKey)
        ?? "You are a fast iOS voice agent. Keep replies short and stay interruptible."
    @Published var initialMessage: String = UserDefaults.standard.string(forKey: initialMessageStorageKey)
        ?? "Say hello in one sentence, then wait for me."
    @Published var stateLabel = "Idle"
    @Published var isRunning = false
    @Published var micEnabled = true
    @Published var recordVideo = true
    @Published var sendVisualContext = UserDefaults.standard.object(forKey: visualContextEnabledStorageKey) as? Bool ?? true
    @Published var visualContextFPS = UserDefaults.standard.object(forKey: visualContextFPSStorageKey) as? Double ?? 1.0
    @Published var events: [PipecatRecordingEvent] = [
        PipecatRecordingEvent("Ready to start WebRTC plus local recording.")
    ]
    @Published private(set) var sessions: [PipecatRecordingSession] = []
    @Published private(set) var activeFolderURL: URL?
    @Published private(set) var activeAudioBytes: UInt64 = 0
    @Published private(set) var activeVideoBytes: UInt64 = 0
    @Published private(set) var activeKeyframeCount: Int = 0
    @Published private(set) var activeSentFrameCount: Int = 0

    private static let apiKeyStorageKey = "pipecatRecording.openaiAPIKey"
    private static let modelStorageKey = "pipecatRecording.model"
    private static let instructionsStorageKey = "pipecatRecording.instructions"
    private static let initialMessageStorageKey = "pipecatRecording.initialMessage"
    private static let visualContextEnabledStorageKey = "pipecatRecording.visualContextEnabled"
    private static let visualContextFPSStorageKey = "pipecatRecording.visualContextFPS"

    private let logger = Logger(subsystem: "live.hawky", category: "PipecatRecording")
    private var client: RTVIClient?
    private var archive: PipecatArchiveRecorder?
    private var visualFrameSendFailures = 0

    var canStart: Bool {
        !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isRunning
    }

    var historyRootURL: URL {
        Self.makeHistoryRootURL()
    }

    override init() {
        super.init()
        reloadSessions()
    }

    func saveDrafts() {
        UserDefaults.standard.set(apiKey, forKey: Self.apiKeyStorageKey)
        UserDefaults.standard.set(model, forKey: Self.modelStorageKey)
        UserDefaults.standard.set(instructions, forKey: Self.instructionsStorageKey)
        UserDefaults.standard.set(initialMessage, forKey: Self.initialMessageStorageKey)
        UserDefaults.standard.set(sendVisualContext, forKey: Self.visualContextEnabledStorageKey)
        UserDefaults.standard.set(Self.clampedVisualFPS(visualContextFPS), forKey: Self.visualContextFPSStorageKey)
    }

    func start() async {
        guard canStart else {
            append("Add an OpenAI API key before starting.")
            return
        }
        saveDrafts()
        stateLabel = "Starting"
        isRunning = true
        activeAudioBytes = 0
        activeVideoBytes = 0
        activeKeyframeCount = 0
        activeSentFrameCount = 0
        visualFrameSendFailures = 0

        do {
            let archive = PipecatArchiveRecorder(
                recordVideo: recordVideo,
                sendVisualContext: sendVisualContext,
                visualContextFPS: Self.clampedVisualFPS(visualContextFPS)
            )
            archive.onStats = { [weak self] stats in
                guard let self else { return }
                self.activeAudioBytes = stats.audioBytes
                self.activeVideoBytes = stats.videoBytes
                self.activeKeyframeCount = stats.keyframeCount
                self.activeSentFrameCount = stats.visualFramesSent
            }
            archive.onVisualKeyframe = { [weak self] data, index, _ in
                Task { @MainActor [weak self] in
                    await self?.sendVisualFrame(data, frameIndex: index)
                }
            }
            try await archive.start()
            self.archive = archive
            activeFolderURL = archive.folderURL
            append("Recording folder: \(archive.folderURL.lastPathComponent)")
        } catch {
            stateLabel = "Recording error"
            isRunning = false
            append("Recording failed to start: \(error.localizedDescription)")
            return
        }

        let options = makeOptions()
        let transport = OpenAIRealtimeTransport(options: options)
        let client = RTVIClient(transport: transport, options: options)
        client.delegate = self
        self.client = client

        do {
            try await client.start()
            micEnabled = client.isMicEnabled
            stateLabel = client.state.description
            append("WebRTC session started.")
        } catch {
            append("WebRTC failed: \(describe(error))")
            await stop()
        }
    }

    func stop() async {
        guard isRunning || client != nil || archive != nil else { return }
        stateLabel = "Stopping"
        append("Stopping session.")

        if let client {
            do {
                try await client.disconnect()
            } catch {
                append("WebRTC disconnect failed: \(describe(error))")
            }
        }
        self.client = nil

        if let archive {
            let finished = await archive.stop()
            append("Saved \(finished.folderURL.lastPathComponent).")
        }
        archive = nil
        activeFolderURL = nil
        isRunning = false
        micEnabled = true
        stateLabel = "Idle"
        reloadSessions()
    }

    func setMicEnabled(_ enabled: Bool) async {
        guard let client else {
            micEnabled = enabled
            return
        }
        do {
            try await client.enableMic(enable: enabled)
            micEnabled = client.isMicEnabled
            append(micEnabled ? "Mic unmuted." : "Mic muted.")
        } catch {
            append("Mic toggle failed: \(describe(error))")
        }
    }

    func reloadSessions() {
        sessions = Self.loadSessions()
    }

    func diagnosticsText() -> String {
        let eventLines = events
            .sorted { $0.date < $1.date }
            .map { "[\(Self.timestampFormatter.string(from: $0.date))] \($0.message)" }
            .joined(separator: "\n")
        let raw = """
        Pipecat recording diagnostics
        state: \(stateLabel)
        running: \(isRunning)
        model: \(model.trimmingCharacters(in: .whitespacesAndNewlines))
        has_api_key: \(!apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        active_folder: \(activeFolderURL?.path ?? "none")
        audio_bytes: \(activeAudioBytes)
        video_bytes: \(activeVideoBytes)
        keyframes: \(activeKeyframeCount)
        visual_context_enabled: \(sendVisualContext)
        visual_context_fps: \(Self.fpsLabel(Self.clampedVisualFPS(visualContextFPS)))
        visual_frames_sent: \(activeSentFrameCount)
        history_root: \(historyRootURL.path)

        events:
        \(eventLines)
        """
        return Self.redactSecrets(raw)
    }

    private func makeOptions() -> RTVIClientOptions {
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedInitialMessage = initialMessage.trimmingCharacters(in: .whitespacesAndNewlines)

        let llmOptions: [Option] = [
            Option(name: "api_key", value: .string(trimmedKey)),
            Option(name: "model", value: .string(trimmedModel.isEmpty ? "gpt-realtime-2" : trimmedModel)),
            Option(name: "initial_messages", value: .array([
                .object([
                    "role": .string("user"),
                    "content": .string(trimmedInitialMessage)
                ])
            ])),
            Option(name: "session_config", value: .object([
                "type": .string("realtime"),
                "model": .string(trimmedModel.isEmpty ? "gpt-realtime-2" : trimmedModel),
                "instructions": .string(trimmedInstructions),
                "output_modalities": .array([.string("audio")]),
                "audio": .object([
                    "input": .object([
                        "turn_detection": .object([
                            "type": .string("semantic_vad"),
                            "eagerness": .string("low"),
                            "create_response": .boolean(true),
                            "interrupt_response": .boolean(true)
                        ])
                    ]),
                    "output": .object([
                        "voice": .string("marin")
                    ])
                ])
            ]))
        ]

        return RTVIClientOptions(
            enableMic: true,
            enableCam: false,
            params: RTVIClientParams(config: [
                ServiceConfig(service: "llm", options: llmOptions)
            ])
        )
    }

    private func sendVisualFrame(_ data: Data, frameIndex: Int) async {
        guard sendVisualContext else { return }
        guard let client, client.isConnected() else { return }

        let imageURL = "data:image/jpeg;base64,\(data.base64EncodedString())"
        let message: Value = .object([
            "role": .string("user"),
            "content": .array([
                .object([
                    "type": .string("input_text"),
                    "text": .string("Pipecat2 visual context frame \(frameIndex). Use this image as ambient visual context; do not reply just because this frame arrived.")
                ]),
                .object([
                    "type": .string("input_image"),
                    "image_url": .string(imageURL)
                ])
            ])
        ])

        let action = ActionRequest(
            service: "llm",
            action: "append_to_messages",
            arguments: [
                Option(name: "messages", value: .array([message])),
                Option(name: "create_response", value: .boolean(false))
            ]
        )

        do {
            _ = try await client.action(action: action)
            archive?.recordVisualFrameSent(
                frameIndex: frameIndex,
                bytes: data.count,
                fps: Self.clampedVisualFPS(visualContextFPS)
            )
            if activeSentFrameCount == 1 || activeSentFrameCount % 10 == 0 {
                append("Sent visual frame \(frameIndex) to the agent.")
            }
        } catch {
            visualFrameSendFailures += 1
            if visualFrameSendFailures <= 3 {
                append("Visual frame send failed: \(describe(error))")
            }
        }
    }

    private func append(_ message: String) {
        let redacted = Self.redactSecrets(message)
        logger.info("\(redacted, privacy: .public)")
        print("[PipecatRecording] \(redacted)")
        events.insert(PipecatRecordingEvent(redacted), at: 0)
        if events.count > 100 {
            events.removeLast(events.count - 100)
        }
    }

    private func describe(_ error: Error) -> String {
        if let rtviError = error as? RTVIError {
            return rtviError.message
        }
        return error.localizedDescription
    }

    static func makeHistoryRootURL() -> URL {
        let root = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("pipecat-recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    static func clampedVisualFPS(_ value: Double) -> Double {
        min(5.0, max(0.25, value))
    }

    static func fpsLabel(_ value: Double) -> String {
        let clamped = clampedVisualFPS(value)
        if clamped.rounded() == clamped {
            return "\(Int(clamped)) FPS"
        }
        return String(format: "%.2g FPS", clamped)
    }

    static func loadSessions() -> [PipecatRecordingSession] {
        let root = makeHistoryRootURL()
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.creationDateKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []

        return urls.compactMap { folder in
            guard (try? folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                return nil
            }
            let manifest = folder.appendingPathComponent("manifest.json")
            guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
            let audio = folder.appendingPathComponent("audio.wav")
            let video = folder.appendingPathComponent("camera.mp4")
            let messages = folder.appendingPathComponent("messages.jsonl")
            let openAIEvents = folder.appendingPathComponent("openai-events.jsonl")
            let keyframes = folder.appendingPathComponent("keyframes", isDirectory: true)
            let created = (try? folder.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date.distantPast
            let audioBytes = byteCount(at: audio)
            let videoBytes = byteCount(at: video)
            let keyframeCount = ((try? FileManager.default.contentsOfDirectory(
                at: keyframes,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )) ?? []).filter { $0.pathExtension.lowercased() == "jpg" }.count
            return PipecatRecordingSession(
                id: folder.lastPathComponent,
                folderURL: folder,
                startedAt: created,
                audioURL: audio,
                videoURL: video,
                manifestURL: manifest,
                messagesURL: messages,
                openAIEventsURL: openAIEvents,
                keyframesDirectoryURL: keyframes,
                audioBytes: audioBytes,
                videoBytes: videoBytes,
                keyframeCount: keyframeCount
            )
        }
        .sorted { $0.startedAt > $1.startedAt }
    }

    private static func byteCount(at url: URL) -> UInt64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return attrs?[.size] as? UInt64 ?? 0
    }

    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()

    private static func redactSecrets(_ raw: String) -> String {
        raw.replacingOccurrences(
            of: #"sk-[A-Za-z0-9_\-]{12,}"#,
            with: "[redacted-openai-key]",
            options: .regularExpression
        )
    }

    nonisolated func onTransportStateChanged(state: TransportState) {
        Task { @MainActor in
            stateLabel = state.description
            append("Transport: \(state.description)")
        }
    }

    nonisolated func onConnected() {
        Task { @MainActor in append("Connected.") }
    }

    nonisolated func onDisconnected() {
        Task { @MainActor in append("Disconnected.") }
    }

    nonisolated func onBotReady(botReadyData: BotReadyData) {
        Task { @MainActor in append("Bot ready.") }
    }

    nonisolated func onUserStartedSpeaking() {
        Task { @MainActor in
            append("User started speaking.")
            archive?.appendMessage(role: "user", event: "speech_started")
        }
    }

    nonisolated func onUserStoppedSpeaking() {
        Task { @MainActor in
            append("User stopped speaking.")
            archive?.appendMessage(role: "user", event: "speech_stopped")
        }
    }

    nonisolated func onBotStartedSpeaking(participant: Participant) {
        onBotStartedSpeaking()
    }

    nonisolated func onBotStartedSpeaking() {
        Task { @MainActor in
            append("Bot started speaking.")
            archive?.appendMessage(role: "assistant", event: "audio_started")
        }
    }

    nonisolated func onBotStoppedSpeaking(participant: Participant) {
        onBotStoppedSpeaking()
    }

    nonisolated func onBotStoppedSpeaking() {
        Task { @MainActor in
            append("Bot stopped speaking.")
            archive?.appendMessage(role: "assistant", event: "audio_stopped")
        }
    }

    nonisolated func onUserTranscript(data: Transcript) {
        Task { @MainActor in
            append("User transcript: \(data.text)")
            archive?.appendMessage(role: "user", event: data.final == true ? "transcript_final" : "transcript_delta", text: data.text)
        }
    }

    nonisolated func onBotTranscript(data: String) {
        Task { @MainActor in
            append("Assistant transcript: \(data)")
            archive?.appendMessage(role: "assistant", event: "transcript_final", text: data)
        }
    }

    nonisolated func onBotTTSText(data: BotTTSText) {
        Task { @MainActor in
            archive?.appendMessage(role: "assistant", event: "transcript_delta", text: data.text)
        }
    }

    nonisolated func onTracksUpdated(tracks: Tracks) {
        Task { @MainActor in
            archive?.appendMessage(
                role: "system",
                event: "tracks_updated",
                metadata: [
                    "has_local_audio_track": tracks.local.audio != nil,
                    "has_bot_audio_track": tracks.bot?.audio != nil
                ]
            )
        }
    }

    nonisolated func onServerMessage(data: Value) {
        Task { @MainActor in
            archive?.appendOpenAIEvent(data)
        }
    }

    nonisolated func onError(message: String) {
        Task { @MainActor in
            stateLabel = "Error"
            append("Error: \(message)")
        }
    }
}

struct PipecatRecordingEvent: Identifiable, Equatable {
    let id = UUID()
    let message: String
    let date: Date

    init(_ message: String, date: Date = Date()) {
        self.message = message
        self.date = date
    }
}

struct PipecatArchiveStats {
    var audioBytes: UInt64 = 0
    var videoBytes: UInt64 = 0
    var keyframeCount: Int = 0
    var visualFramesSent: Int = 0
}

@MainActor
final class PipecatArchiveRecorder {
    let folderURL: URL
    var capture: VideoCapture? { videoCapture }
    var onStats: ((PipecatArchiveStats) -> Void)?
    var onVisualKeyframe: ((Data, Int, UInt64) -> Void)?

    private let recordVideo: Bool
    private let sendVisualContext: Bool
    private let visualContextFPS: Double
    private var cameraPosition: AVCaptureDevice.Position
    private let audioURL: URL
    private let videoURL: URL
    private let manifestURL: URL
    private let messagesURL: URL
    private let openAIEventsURL: URL
    private let keyframesURL: URL
    private let sessionID: String
    private let startedAt: Date
    private let source = MicAudioSource(sampleRate: 48_000, enableVoiceProcessing: true)
    private let sink = WavFileSink()
    private var videoCapture: VideoCapture?
    private var videoHandle: FileHandle?
    private var messagesHandle: FileHandle?
    private var openAIEventsHandle: FileHandle?
    private var pumpTask: Task<Void, Never>?
    private var stats = PipecatArchiveStats()
    private var videoSegmentCount = 0

    init(
        recordVideo: Bool,
        sendVisualContext: Bool,
        visualContextFPS: Double,
        cameraPosition: AVCaptureDevice.Position = .back
    ) {
        self.recordVideo = recordVideo
        self.sendVisualContext = sendVisualContext
        self.visualContextFPS = PipecatRecordingDemoStore.clampedVisualFPS(visualContextFPS)
        self.cameraPosition = cameraPosition
        let stamp = Self.captureStamp(Date())
        self.sessionID = "pipecat-\(stamp)"
        self.startedAt = Date()
        self.folderURL = PipecatRecordingDemoStore.makeHistoryRootURL()
            .appendingPathComponent(sessionID, isDirectory: true)
        self.audioURL = folderURL.appendingPathComponent("audio.wav")
        self.videoURL = folderURL.appendingPathComponent("camera.mp4")
        self.manifestURL = folderURL.appendingPathComponent("manifest.json")
        self.messagesURL = folderURL.appendingPathComponent("messages.jsonl")
        self.openAIEventsURL = folderURL.appendingPathComponent("openai-events.jsonl")
        self.keyframesURL = folderURL.appendingPathComponent("keyframes", isDirectory: true)
    }

    func start() async throws {
        try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: keyframesURL, withIntermediateDirectories: true)
        try openJSONLFiles()
        activateAudioSession()
        try sink.open(format: .wavMono(sampleRate: 48_000), url: audioURL)
        try await source.start()
        startAudioPump()
        if recordVideo {
            try startVideoFile()
        }
        if recordVideo || sendVisualContext {
            await startVideoCapture()
        }
        writeManifest(finalized: false)
    }

    func stop() async -> PipecatRecordingSession {
        let pump = pumpTask
        pumpTask = nil
        pump?.cancel()
        await source.stop()
        _ = await pump?.value
        try? sink.close()
        await videoCapture?.stop()
        videoCapture = nil
        try? videoHandle?.close()
        videoHandle = nil
        try? messagesHandle?.close()
        messagesHandle = nil
        try? openAIEventsHandle?.close()
        openAIEventsHandle = nil
        writeManifest(finalized: true)
        deactivateAudioSession()
        return PipecatRecordingSession(
            id: sessionID,
            folderURL: folderURL,
            startedAt: startedAt,
            audioURL: audioURL,
            videoURL: videoURL,
            manifestURL: manifestURL,
            messagesURL: messagesURL,
            openAIEventsURL: openAIEventsURL,
            keyframesDirectoryURL: keyframesURL,
            audioBytes: stats.audioBytes,
            videoBytes: stats.videoBytes,
            keyframeCount: stats.keyframeCount
        )
    }

    func recordVisualFrameSent(frameIndex: Int, bytes: Int, fps: Double) {
        stats.visualFramesSent += 1
        onStats?(stats)
        appendMessage(
            role: "system",
            event: "visual_frame_sent",
            metadata: [
                "frame_index": frameIndex,
                "bytes": bytes,
                "visual_context_fps": fps
            ]
        )
    }

    func setCameraPosition(_ position: AVCaptureDevice.Position) async {
        guard cameraPosition != position else { return }
        cameraPosition = position
        await videoCapture?.stop()
        videoCapture = nil
        if recordVideo || sendVisualContext {
            await startVideoCapture()
        }
    }

    func appendMessage(
        role: String,
        event: String,
        text: String? = nil,
        metadata: [String: Any] = [:]
    ) {
        var payload: [String: Any] = [
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "role": role,
            "event": event
        ]
        if let text {
            payload["content"] = text
        }
        for (key, value) in metadata {
            payload[key] = value
        }
        writeJSONLine(payload, to: messagesHandle)
    }

    func appendOpenAIEvent(_ value: Value) {
        var payload: [String: Any] = [
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "direction": "inbound",
            "source": "openai.realtime.webrtc_data_channel"
        ]
        if let object = Self.jsonObject(from: value) {
            payload["event"] = object
        } else {
            payload["event"] = String(describing: value)
        }
        writeJSONLine(payload, to: openAIEventsHandle)
    }

    private func openJSONLFiles() throws {
        FileManager.default.createFile(atPath: messagesURL.path, contents: nil)
        FileManager.default.createFile(atPath: openAIEventsURL.path, contents: nil)
        messagesHandle = try FileHandle(forWritingTo: messagesURL)
        openAIEventsHandle = try FileHandle(forWritingTo: openAIEventsURL)
        appendMessage(
            role: "system",
            event: "archive_started",
            metadata: [
                "audio_file": "audio.wav",
                "record_video": recordVideo,
                "visual_context_enabled": sendVisualContext,
                "visual_context_fps": visualContextFPS,
                "assistant_audio_file": NSNull(),
                "assistant_audio_note": "Not captured yet. OpenAI Realtime WebRTC assistant audio arrives as a remote RTCAudioTrack, and the packaged iOS WebRTC headers do not expose a Swift RTCAudioSink for decoded PCM."
            ]
        )
    }

    private func startAudioPump() {
        nonisolated(unsafe) let pumpSource = source
        nonisolated(unsafe) let pumpSink = sink
        pumpTask = Task.detached(priority: .userInitiated) { [weak self] in
            for await chunk in pumpSource.samples {
                if Task.isCancelled { break }
                do {
                    try pumpSink.write(chunk: chunk)
                } catch {
                    print("[PipecatArchiveRecorder] audio write failed: \(error)")
                    break
                }
                let bytes = UInt64(chunk.pcm.count)
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.stats.audioBytes += bytes
                    self.onStats?(self.stats)
                }
            }
        }
    }

    private func startVideoFile() throws {
        FileManager.default.createFile(atPath: videoURL.path, contents: nil)
        videoHandle = try FileHandle(forWritingTo: videoURL)
    }

    private func startVideoCapture() async {
        let capture = VideoCapture()
        capture.preferredFrameRate = max(1, Int(ceil(visualContextFPS)))
        capture.cameraPosition = cameraPosition
        let archiveIntervalNs: UInt64 = 2_000_000_000
        capture.keyframeIntervalNs = sendVisualContext
            ? min(archiveIntervalNs, Self.visualIntervalNanoseconds(fps: visualContextFPS))
            : archiveIntervalNs
        capture.onSegment = { [weak self] data, _ in
            guard let self else { return }
            do {
                try self.videoHandle?.write(contentsOf: data)
                if self.recordVideo {
                    self.stats.videoBytes += UInt64(data.count)
                    self.videoSegmentCount += 1
                    self.onStats?(self.stats)
                }
            } catch {
                print("[PipecatArchiveRecorder] video write failed: \(error)")
            }
        }
        capture.onKeyframe = { [weak self] data, ns in
            guard let self else { return }
            let index = self.stats.keyframeCount + 1
            let url = self.keyframesURL.appendingPathComponent(String(format: "frame-%04d.jpg", index))
            do {
                try data.write(to: url, options: .atomic)
                self.stats.keyframeCount = index
                self.onStats?(self.stats)
                if self.sendVisualContext {
                    self.onVisualKeyframe?(data, index, ns)
                }
            } catch {
                print("[PipecatArchiveRecorder] keyframe write failed at \(ns): \(error)")
            }
        }
        await capture.requestPermissionIfNeeded()
        await capture.start()
        videoCapture = capture
    }

    private func writeManifest(finalized: Bool) {
        let payload: [String: Any] = [
            "id": sessionID,
            "started_at": ISO8601DateFormatter().string(from: startedAt),
            "finalized_at": finalized ? ISO8601DateFormatter().string(from: Date()) : NSNull(),
            "audio_file": "audio.wav",
            "video_file": recordVideo ? "camera.mp4" : NSNull(),
            "audio_bytes": stats.audioBytes,
            "video_bytes": stats.videoBytes,
            "video_segments": videoSegmentCount,
            "keyframes": stats.keyframeCount,
            "visual_context_enabled": sendVisualContext,
            "visual_context_fps": visualContextFPS,
            "visual_context_sent_frames": stats.visualFramesSent,
            "visual_context_transport": sendVisualContext ? "openai.conversation.item.input_image" : NSNull(),
            "messages_file": "messages.jsonl",
            "openai_events_file": "openai-events.jsonl",
            "assistant_audio_file": NSNull(),
            "assistant_audio_captured": false,
            "notes": "Pipecat OpenAI WebRTC demo recording. audio.wav is a parallel local mic tap only; assistant output audio is not captured yet because it arrives as a remote WebRTC audio track without a public Swift PCM sink in the packaged WebRTC framework. Camera keyframes are saved locally and, when visual_context_enabled is true, sent to the agent as input_image conversation items without forcing a response. Assistant/user text and raw OpenAI Realtime events are archived in JSONL sidecars."
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) else {
            return
        }
        try? data.write(to: manifestURL, options: .atomic)
    }

    private func activateAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
        )
        try? session.setActive(true)
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func captureStamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }

    private static func visualIntervalNanoseconds(fps: Double) -> UInt64 {
        let clampedFPS = PipecatRecordingDemoStore.clampedVisualFPS(fps)
        return UInt64((1_000_000_000.0 / clampedFPS).rounded())
    }

    private func writeJSONLine(_ payload: [String: Any], to handle: FileHandle?) {
        guard let handle,
              JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return
        }
        handle.write(data)
        handle.write(Data("\n".utf8))
    }

    private static func jsonObject(from value: Value) -> Any? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }
}
