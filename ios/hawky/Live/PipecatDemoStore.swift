import AVFoundation
import Foundation
import os
import PipecatClientIOS
import PipecatClientIOSOpenAIRealtimeWebrtc

@MainActor
final class PipecatDemoStore: NSObject, ObservableObject, RTVIClientDelegate {
    @Published var apiKey: String = UserDefaults.standard.string(forKey: PipecatDemoStore.apiKeyStorageKey)
        ?? ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
        ?? ""
    @Published var model: String = UserDefaults.standard.string(forKey: PipecatDemoStore.modelStorageKey) ?? "gpt-realtime-2"
    @Published var instructions: String = UserDefaults.standard.string(forKey: PipecatDemoStore.instructionsStorageKey)
        ?? "You are a fast, interruptible iOS voice agent. Keep replies short and ask one useful follow-up."
    @Published var initialMessage: String = UserDefaults.standard.string(forKey: PipecatDemoStore.initialMessageStorageKey)
        ?? "Say hello, then ask me to interrupt you so we can test barge-in and echo cancellation."
    @Published var stateLabel = "Disconnected"
    @Published var micEnabled = true
    @Published var isConnecting = false
    @Published var transcriptEnabled = UserDefaults.standard.object(forKey: PipecatDemoStore.transcriptEnabledStorageKey) as? Bool ?? false
    @Published var startupGuardEnabled = UserDefaults.standard.object(forKey: PipecatDemoStore.startupGuardEnabledStorageKey) as? Bool ?? true
    @Published var events: [PipecatDemoEvent] = [
        PipecatDemoEvent("Ready to connect a direct OpenAI Realtime WebRTC session.")
    ]
    @Published var userTranscript = ""
    @Published var botTranscript = ""

    private static let apiKeyStorageKey = "pipecat.openaiAPIKey"
    private static let modelStorageKey = "pipecat.model"
    private static let instructionsStorageKey = "pipecat.instructions"
    private static let initialMessageStorageKey = "pipecat.initialMessage"
    private static let transcriptEnabledStorageKey = "pipecat.transcriptEnabled"
    private static let startupGuardEnabledStorageKey = "pipecat.startupGuardEnabled"
    private static var didAutoConnectThisLaunch = false

    private var client: RTVIClient?
    private let logger = Logger(subsystem: "live.hawky", category: "Pipecat")
    private var startupGuardWaitingForFirstBotStop = false

    var canConnect: Bool {
        !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isConnecting
    }

    var isConnected: Bool {
        client?.isConnected() ?? false
    }

    func saveDrafts() {
        UserDefaults.standard.set(apiKey, forKey: Self.apiKeyStorageKey)
        UserDefaults.standard.set(model, forKey: Self.modelStorageKey)
        UserDefaults.standard.set(instructions, forKey: Self.instructionsStorageKey)
        UserDefaults.standard.set(initialMessage, forKey: Self.initialMessageStorageKey)
        UserDefaults.standard.set(transcriptEnabled, forKey: Self.transcriptEnabledStorageKey)
        UserDefaults.standard.set(startupGuardEnabled, forKey: Self.startupGuardEnabledStorageKey)
    }

    func connect() async {
        guard canConnect else {
            append("Add an OpenAI API key before connecting.")
            return
        }
        saveDrafts()
        isConnecting = true
        stateLabel = "Connecting"
        startupGuardWaitingForFirstBotStop = startupGuardEnabled
        append("Starting \(model) over Pipecat OpenAI WebRTC.")
        if startupGuardEnabled {
            append("Startup guard armed: mic stays muted until the first bot greeting ends.")
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
            stateLabel = "Error"
            append("Connect failed: \(errorDescription(error))")
            self.client = nil
        }
        isConnecting = false
    }

    func connectFromLaunchArgument() async {
        guard !Self.didAutoConnectThisLaunch else { return }
        Self.didAutoConnectThisLaunch = true
        await connect()
    }

    func disconnect() async {
        guard let client else { return }
        append("Disconnecting.")
        do {
            try await client.disconnect()
        } catch {
            append("Disconnect failed: \(errorDescription(error))")
        }
        self.client = nil
        startupGuardWaitingForFirstBotStop = false
        stateLabel = "Disconnected"
        micEnabled = true
    }

    func setMicEnabled(_ enabled: Bool) async {
        guard let client else {
            micEnabled = enabled
            return
        }
        do {
            try await client.enableMic(enable: enabled)
            if enabled {
                startupGuardWaitingForFirstBotStop = false
            }
            micEnabled = client.isMicEnabled
            append(micEnabled ? "Mic unmuted." : "Mic muted.")
        } catch {
            append("Mic toggle failed: \(errorDescription(error))")
        }
    }

    func diagnosticsText() -> String {
        let lines = events
            .sorted { $0.date < $1.date }
            .map { "[\(Self.timestampFormatter.string(from: $0.date))] \($0.message)" }
            .joined(separator: "\n")
        let raw = """
        PipeCat diagnostics
        state: \(stateLabel)
        model: \(model.trimmingCharacters(in: .whitespacesAndNewlines))
        has_api_key: \(!apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        mic_enabled: \(micEnabled)
        transcript_enabled: \(transcriptEnabled)
        startup_guard_enabled: \(startupGuardEnabled)
        connected: \(isConnected)
        user_transcript: \(userTranscript)
        bot_transcript: \(botTranscript)

        events:
        \(lines)
        """
        return Self.redactSecrets(raw)
    }

    func clearEvents() {
        events = []
        userTranscript = ""
        botTranscript = ""
    }

    func setTranscriptEnabled(_ enabled: Bool) {
        transcriptEnabled = enabled
        saveDrafts()
        if !enabled {
            userTranscript = ""
            botTranscript = ""
        }
        append(enabled ? "Transcript enabled." : "Transcript disabled.")
    }

    func setStartupGuardEnabled(_ enabled: Bool) {
        startupGuardEnabled = enabled
        saveDrafts()
        append(enabled ? "Startup guard enabled." : "Startup guard disabled.")
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
            enableMic: !startupGuardEnabled,
            enableCam: false,
            params: RTVIClientParams(config: [
                ServiceConfig(service: "llm", options: llmOptions)
            ])
        )
    }

    private func append(_ message: String) {
        let redacted = Self.redactSecrets(message)
        logger.info("\(redacted, privacy: .public)")
        print("[PipeCat] \(redacted)")
        events.insert(PipecatDemoEvent(redacted), at: 0)
        if events.count > 80 {
            events.removeLast(events.count - 80)
        }
    }

    private func errorDescription(_ error: Error) -> String {
        if let rtviError = error as? RTVIError {
            return describeRTVIError(rtviError)
        }

        let nsError = error as NSError
        var parts = [String]()
        parts.append(error.localizedDescription)
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error {
            parts.append("underlying: \(underlying.localizedDescription)")
        }
        let failureReason = nsError.localizedFailureReason
        if let failureReason, !failureReason.isEmpty {
            parts.append("reason: \(failureReason)")
        }
        return parts.joined(separator: " | ")
    }

    private func describeRTVIError(_ error: RTVIError) -> String {
        var parts = [error.message]
        var current = error.underlyingError
        var depth = 0
        while let nested = current, depth < 8 {
            if let nestedRTVI = nested as? RTVIError {
                parts.append(nestedRTVI.message)
                current = nestedRTVI.underlyingError
            } else {
                parts.append(nested.localizedDescription)
                current = (nested as NSError).userInfo[NSUnderlyingErrorKey] as? Error
            }
            depth += 1
        }
        return parts.joined(separator: " | ")
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
        Task { @MainActor in
            stateLabel = "Disconnected"
            append("Disconnected.")
        }
    }

    nonisolated func onBotReady(botReadyData: BotReadyData) {
        Task { @MainActor in append("Bot ready.") }
    }

    nonisolated func onUserStartedSpeaking() {
        Task { @MainActor in append("User started speaking.") }
    }

    nonisolated func onUserStoppedSpeaking() {
        Task { @MainActor in append("User stopped speaking.") }
    }

    nonisolated func onBotStartedSpeaking(participant: Participant) {
        Task { @MainActor in append("Bot started speaking.") }
    }

    nonisolated func onBotStoppedSpeaking(participant: Participant) {
        Task { @MainActor in
            append("Bot stopped speaking.")
            await armMicAfterStartupGuardIfNeeded()
        }
    }

    nonisolated func onUserTranscript(data: Transcript) {
        Task { @MainActor in
            guard transcriptEnabled else { return }
            userTranscript = data.text
            append("You: \(data.text)")
        }
    }

    nonisolated func onBotTranscript(data: String) {
        Task { @MainActor in
            guard transcriptEnabled else { return }
            botTranscript = data
            append("Bot: \(data)")
        }
    }

    nonisolated func onBotTTSText(data: BotTTSText) {
        Task { @MainActor in
            guard transcriptEnabled else { return }
            botTranscript += data.text
        }
    }

    nonisolated func onError(message: String) {
        Task { @MainActor in
            stateLabel = "Error"
            append("Error: \(message)")
        }
    }

    private func armMicAfterStartupGuardIfNeeded() async {
        guard startupGuardWaitingForFirstBotStop, let client else { return }
        startupGuardWaitingForFirstBotStop = false
        do {
            try await client.enableMic(enable: true)
            micEnabled = client.isMicEnabled
            append("Startup guard released: mic unmuted.")
        } catch {
            append("Startup guard release failed: \(errorDescription(error))")
        }
    }
}

@MainActor
final class Live2SessionStore: NSObject, ObservableObject, RTVIClientDelegate {
    @Published var model: String = UserDefaults.standard.string(forKey: modelStorageKey) ?? "gpt-realtime-2"
    @Published var modelPreset: LiveOpenAIModelPreset = LiveOpenAIModelPreset.preset(
        for: UserDefaults.standard.string(forKey: modelStorageKey) ?? "gpt-realtime-2"
    )
    @Published var instructions: String = UserDefaults.standard.string(forKey: instructionsStorageKey)
        ?? "You are Hawky Live2: a fast, interruptible voice agent. Keep replies short. If you hear your own previous speech through the microphone, ignore it and wait for the user."
    @Published var initialMessage: String = UserDefaults.standard.string(forKey: initialMessageStorageKey)
        ?? "Say hello briefly, then wait."
    @Published var visualContextEnabled: Bool = UserDefaults.standard.object(forKey: visualContextEnabledStorageKey) as? Bool ?? true
    @Published var visualContextFPS: Double = UserDefaults.standard.object(forKey: visualContextFPSStorageKey) as? Double ?? 1.0
    @Published var recordVideo: Bool = UserDefaults.standard.object(forKey: recordVideoStorageKey) as? Bool ?? false
    @Published var cameraPosition: LiveCameraPosition = LiveCameraPosition(rawValue: UserDefaults.standard.string(forKey: cameraPositionStorageKey) ?? "") ?? .back
    @Published var stateLabel = "Idle"
    @Published var isRunning = false
    @Published var isConnecting = false
    @Published var micEnabled = true
    @Published private(set) var cameraEnabled = false
    @Published private(set) var capture: VideoCapture?
    @Published private(set) var framesCaptured = 0
    @Published private(set) var framesSent = 0
    @Published private(set) var activeFolderURL: URL?
    @Published private(set) var activeAudioBytes: UInt64 = 0
    @Published private(set) var activeVideoBytes: UInt64 = 0
    @Published private(set) var activeKeyframeCount = 0
    @Published private(set) var sessions: [PipecatRecordingSession] = []
    @Published private(set) var lastError: String?
    @Published var visibleEventKinds: Set<PipecatDemoEventKind> = Set(PipecatDemoEventKind.allCases)
    @Published var events: [PipecatDemoEvent] = [
        PipecatDemoEvent("Ready to start Live2.")
    ]

    private static let modelStorageKey = "live2.model"
    private static let instructionsStorageKey = "live2.instructions"
    private static let initialMessageStorageKey = "live2.initialMessage"
    private static let visualContextEnabledStorageKey = "live2.visualContextEnabled"
    private static let visualContextFPSStorageKey = "live2.visualContextFPS"
    private static let recordVideoStorageKey = "live2.recordVideo"
    private static let cameraPositionStorageKey = "live2.cameraPosition"

    private let logger = Logger(subsystem: "live.hawky", category: "Live2")
    private var client: RTVIClient?
    private var archive: PipecatArchiveRecorder?
    private var visualFrameSendFailures = 0

    var canStart: Bool {
        !isConnecting && !isRunning && hasSavedOpenAIKey
    }

    var hasSavedOpenAIKey: Bool {
        guard let key = try? KeychainStore.loadOpenAIAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }
        return !key.isEmpty
    }

    override init() {
        super.init()
        reloadSessions()
    }

    var historyRootURL: URL {
        PipecatRecordingDemoStore.makeHistoryRootURL()
    }

    func saveDrafts() {
        UserDefaults.standard.set(model, forKey: Self.modelStorageKey)
        UserDefaults.standard.set(instructions, forKey: Self.instructionsStorageKey)
        UserDefaults.standard.set(initialMessage, forKey: Self.initialMessageStorageKey)
        UserDefaults.standard.set(visualContextEnabled, forKey: Self.visualContextEnabledStorageKey)
        UserDefaults.standard.set(Self.clampedVisualFPS(visualContextFPS), forKey: Self.visualContextFPSStorageKey)
        UserDefaults.standard.set(recordVideo, forKey: Self.recordVideoStorageKey)
        UserDefaults.standard.set(cameraPosition.rawValue, forKey: Self.cameraPositionStorageKey)
    }

    func reloadSessions() {
        sessions = PipecatRecordingDemoStore.loadSessions()
    }

    func start() async {
        guard !isRunning && !isConnecting else { return }
        guard let apiKey = try? KeychainStore.loadOpenAIAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !apiKey.isEmpty else {
            append("Save a Direct OpenAI API key in Settings > Live before starting.")
            return
        }

        saveDrafts()
        isConnecting = true
        stateLabel = "Connecting"
        lastError = nil
        framesCaptured = 0
        framesSent = 0
        activeAudioBytes = 0
        activeVideoBytes = 0
        activeKeyframeCount = 0
        activeFolderURL = nil
        capture = nil
        cameraEnabled = false
        visualFrameSendFailures = 0
        append("Starting Live2 WebRTC session.")

        do {
            let archive = PipecatArchiveRecorder(
                recordVideo: recordVideo,
                sendVisualContext: visualContextEnabled,
                visualContextFPS: Self.clampedVisualFPS(visualContextFPS),
                cameraPosition: Self.capturePosition(for: cameraPosition)
            )
            archive.onStats = { [weak self] stats in
                guard let self else { return }
                self.activeAudioBytes = stats.audioBytes
                self.activeVideoBytes = stats.videoBytes
                self.activeKeyframeCount = stats.keyframeCount
                self.framesCaptured = stats.keyframeCount
                self.framesSent = stats.visualFramesSent
            }
            archive.onVisualKeyframe = { [weak self] data, index, _ in
                Task { @MainActor [weak self] in
                    await self?.sendVisualFrame(data, frameIndex: index)
                }
            }
            try await archive.start()
            self.archive = archive
            activeFolderURL = archive.folderURL
            capture = archive.capture
            cameraEnabled = archive.capture != nil
            append("Recording folder: \(archive.folderURL.lastPathComponent)")
        } catch {
            let message = errorDescription(error)
            lastError = message
            stateLabel = "Recording error"
            append("Recording failed to start: \(message)")
            isConnecting = false
            return
        }

        let options = makeOptions(apiKey: apiKey)
        let transport = OpenAIRealtimeTransport(options: options)
        let client = RTVIClient(transport: transport, options: options)
        client.delegate = self
        self.client = client

        do {
            try await client.start()
            micEnabled = client.isMicEnabled
            isRunning = true
            stateLabel = client.state.description
            append("WebRTC session started.")
        } catch {
            let message = errorDescription(error)
            lastError = message
            stateLabel = "Error"
            append("Start failed: \(message)")
            self.client = nil
            if let archive {
                _ = await archive.stop()
            }
            archive = nil
            activeFolderURL = nil
            capture = nil
            cameraEnabled = false
        }

        isConnecting = false
    }

    func stop() async {
        guard isRunning || isConnecting || client != nil || capture != nil else { return }
        stateLabel = "Stopping"
        append("Stopping Live2.")

        if let client {
            do {
                try await client.disconnect()
            } catch {
                append("Disconnect failed: \(errorDescription(error))")
            }
        }

        self.client = nil

        if let archive {
            let finished = await archive.stop()
            append("Saved \(finished.folderURL.lastPathComponent).")
        }
        archive = nil
        activeFolderURL = nil
        capture = nil
        cameraEnabled = false
        isRunning = false
        isConnecting = false
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
            append("Mic toggle failed: \(errorDescription(error))")
        }
    }

    func setCameraEnabled(_ enabled: Bool) async {
        visualContextEnabled = enabled
        saveDrafts()
        guard isRunning || isConnecting else { return }
        append(enabled ? "Visual context will be on for the next Live2 session." : "Visual context will be off for the next Live2 session.")
    }

    func setRecordVideo(_ enabled: Bool) {
        recordVideo = enabled
        saveDrafts()
        if isRunning || isConnecting {
            append("Video recording changes apply to the next Live2 session.")
        }
    }

    func setCameraPosition(_ position: LiveCameraPosition) {
        guard cameraPosition != position else { return }
        cameraPosition = position
        saveDrafts()
        append("Camera set to \(position.label.lowercased()).")
        guard isRunning || isConnecting, let archive else { return }
        Task { @MainActor [weak self, archive] in
            await archive.setCameraPosition(Self.capturePosition(for: position))
            self?.capture = archive.capture
            self?.cameraEnabled = archive.capture != nil
        }
    }

    func setModelPreset(_ preset: LiveOpenAIModelPreset) {
        modelPreset = preset
        if preset != .custom {
            model = preset.model
        }
        saveDrafts()
    }

    func toggleEventKind(_ kind: PipecatDemoEventKind) {
        if visibleEventKinds.contains(kind), visibleEventKinds.count > 1 {
            visibleEventKinds.remove(kind)
        } else {
            visibleEventKinds.insert(kind)
        }
    }

    func clearEvents() {
        events = [PipecatDemoEvent("Events cleared.")]
    }

    func sendText(_ text: String, createResponse: Bool = true) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard client?.isConnected() == true else {
            append("Connect before sending text.")
            return
        }

        let message: Value = .object([
            "role": .string("user"),
            "content": .array([
                .object([
                    "type": .string("input_text"),
                    "text": .string(trimmed)
                ])
            ])
        ])

        do {
            try await appendMessages([message], createResponse: createResponse)
            append(createResponse ? "Sent text turn." : "Added text context.")
        } catch {
            append("Text send failed: \(errorDescription(error))")
        }
    }

    func diagnosticsText() -> String {
        let lines = events
            .sorted { $0.date < $1.date }
            .map { "[\(Self.timestampFormatter.string(from: $0.date))] \($0.message)" }
            .joined(separator: "\n")
        return """
        Live2 diagnostics
        state: \(stateLabel)
        running: \(isRunning)
        has_openai_key: \(hasSavedOpenAIKey)
        model: \(model.trimmingCharacters(in: .whitespacesAndNewlines))
        mic_enabled: \(micEnabled)
        camera_enabled: \(cameraEnabled)
        camera_position: \(cameraPosition.label)
        visual_context_enabled: \(visualContextEnabled)
        visual_context_fps: \(Self.fpsLabel(visualContextFPS))
        record_video: \(recordVideo)
        active_folder: \(activeFolderURL?.path ?? "none")
        audio_bytes: \(activeAudioBytes)
        video_bytes: \(activeVideoBytes)
        keyframes: \(activeKeyframeCount)
        frames_captured: \(framesCaptured)
        frames_sent: \(framesSent)
        last_error: \(lastError ?? "none")

        events:
        \(lines)
        """
    }

    private func makeOptions(apiKey: String) -> RTVIClientOptions {
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let activeModel = trimmedModel.isEmpty ? "gpt-realtime-2" : trimmedModel
        let trimmedInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedInitialMessage = initialMessage.trimmingCharacters(in: .whitespacesAndNewlines)

        let llmOptions: [Option] = [
            Option(name: "api_key", value: .string(apiKey)),
            Option(name: "model", value: .string(activeModel)),
            Option(name: "initial_messages", value: .array([
                .object([
                    "role": .string("user"),
                    "content": .string(trimmedInitialMessage.isEmpty ? "Say hello briefly, then wait." : trimmedInitialMessage)
                ])
            ])),
            Option(name: "session_config", value: .object([
                "type": .string("realtime"),
                "model": .string(activeModel),
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
        guard visualContextEnabled else { return }
        guard client?.isConnected() == true else { return }

        let imageURL = "data:image/jpeg;base64,\(data.base64EncodedString())"
        let message: Value = .object([
            "role": .string("user"),
            "content": .array([
                .object([
                    "type": .string("input_text"),
                    "text": .string("Live2 visual frame \(frameIndex). Treat this as ambient visual context; do not respond just because this frame arrived.")
                ]),
                .object([
                    "type": .string("input_image"),
                    "image_url": .string(imageURL)
                ])
            ])
        ])

        do {
            try await appendMessages([message], createResponse: false)
            archive?.recordVisualFrameSent(
                frameIndex: frameIndex,
                bytes: data.count,
                fps: Self.clampedVisualFPS(visualContextFPS)
            )
            if framesSent == 1 || framesSent % 5 == 0 {
                append("Sent image frame \(frameIndex) at \(Self.fpsLabel(visualContextFPS)).", kind: .image)
            }
        } catch {
            visualFrameSendFailures += 1
            let message = errorDescription(error)
            lastError = message
            if visualFrameSendFailures <= 3 {
                append("Visual frame send failed: \(message)", kind: .error)
            }
        }
    }

    private func appendMessages(_ messages: [Value], createResponse: Bool) async throws {
        guard let client else { return }
        let action = ActionRequest(
            service: "llm",
            action: "append_to_messages",
            arguments: [
                Option(name: "messages", value: .array(messages)),
                Option(name: "create_response", value: .boolean(createResponse))
            ]
        )
        _ = try await client.action(action: action)
    }

    private func append(_ message: String, kind: PipecatDemoEventKind = .system) {
        let redacted = Self.redactSecrets(message)
        logger.info("\(redacted, privacy: .public)")
        print("[Live2] \(redacted)")
        events.insert(PipecatDemoEvent(redacted, kind: kind), at: 0)
        if events.count > 100 {
            events.removeLast(events.count - 100)
        }
    }

    private func errorDescription(_ error: Error) -> String {
        if let rtviError = error as? RTVIError {
            return rtviError.message
        }
        return error.localizedDescription
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

    private static func visualIntervalNanoseconds(fps: Double) -> UInt64 {
        let clamped = clampedVisualFPS(fps)
        return UInt64((1.0 / clamped) * 1_000_000_000)
    }

    private static func capturePosition(for position: LiveCameraPosition) -> AVCaptureDevice.Position {
        switch position {
        case .back: return .back
        case .front: return .front
        }
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
            append("Transport: \(state.description)", kind: .transport)
        }
    }

    nonisolated func onConnected() {
        Task { @MainActor in append("Connected.", kind: .transport) }
    }

    nonisolated func onDisconnected() {
        Task { @MainActor in
            stateLabel = "Disconnected"
            append("Disconnected.", kind: .transport)
        }
    }

    nonisolated func onBotReady(botReadyData: BotReadyData) {
        Task { @MainActor in append("Bot ready.", kind: .transport) }
    }

    nonisolated func onUserStartedSpeaking() {
        Task { @MainActor in
            append("User started speaking.", kind: .speech)
            archive?.appendMessage(role: "user", event: "speech_started")
        }
    }

    nonisolated func onUserStoppedSpeaking() {
        Task { @MainActor in
            append("User stopped speaking.", kind: .speech)
            archive?.appendMessage(role: "user", event: "speech_stopped")
        }
    }

    nonisolated func onBotStartedSpeaking(participant: Participant) {
        Task { @MainActor in
            append("Assistant started speaking.", kind: .speech)
            archive?.appendMessage(role: "assistant", event: "audio_started")
        }
    }

    nonisolated func onBotStoppedSpeaking(participant: Participant) {
        Task { @MainActor in
            append("Assistant stopped speaking.", kind: .speech)
            archive?.appendMessage(role: "assistant", event: "audio_stopped")
        }
    }

    nonisolated func onUserTranscript(data: Transcript) {
        Task { @MainActor in
            append("You: \(data.text)", kind: .userTranscript)
            archive?.appendMessage(role: "user", event: data.final == true ? "transcript_final" : "transcript_delta", text: data.text)
        }
    }

    nonisolated func onBotTranscript(data: String) {
        Task { @MainActor in
            append("Assistant: \(data)", kind: .assistantTranscript)
            archive?.appendMessage(role: "assistant", event: "transcript_final", text: data)
        }
    }

    nonisolated func onBotTTSText(data: BotTTSText) {
        Task { @MainActor in
            append("Assistant delta: \(data.text)", kind: .assistantDelta)
            archive?.appendMessage(role: "assistant", event: "transcript_delta", text: data.text)
        }
    }

    nonisolated func onServerMessage(data: Value) {
        Task { @MainActor in
            archive?.appendOpenAIEvent(data)
        }
    }

    nonisolated func onError(message: String) {
        Task { @MainActor in
            lastError = message
            stateLabel = "Error"
            append("Error: \(message)", kind: .error)
        }
    }
}

enum PipecatDemoEventKind: String, CaseIterable, Identifiable, Equatable {
    case system
    case transport
    case speech
    case userTranscript
    case assistantTranscript
    case assistantDelta
    case image
    case error

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .transport: return "Transport"
        case .speech: return "Speech"
        case .userTranscript: return "You"
        case .assistantTranscript: return "Assistant"
        case .assistantDelta: return "Assistant Delta"
        case .image: return "Images"
        case .error: return "Errors"
        }
    }
}

struct PipecatDemoEvent: Identifiable, Equatable {
    let id = UUID()
    let message: String
    let kind: PipecatDemoEventKind
    let date: Date

    init(_ message: String, kind: PipecatDemoEventKind = .system, date: Date = Date()) {
        self.message = message
        self.kind = kind
        self.date = date
    }
}
