import Foundation
import UIKit

struct GPTRTranscriptSession: Identifiable, Equatable {
    let id: String
    let folderURL: URL
    let startedAt: Date
    let audioURL: URL
    let transcriptURL: URL
    let finalTranscriptURL: URL
    let openAIEventsURL: URL
    let outboundEventsURL: URL
    let manifestURL: URL
    let audioBytes: UInt64

    var folderName: String { folderURL.lastPathComponent }
}

struct GPTRTranscriptEvent: Identifiable, Equatable {
    let id = UUID()
    let timestamp: Date
    let direction: String
    let type: String
    let summary: String
}

@MainActor
final class GPTRTranscriptDemoStore: ObservableObject {
    @Published var apiKey: String = UserDefaults.standard.string(forKey: apiKeyKey)
        ?? ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
        ?? ""
    @Published var model: String = UserDefaults.standard.string(forKey: modelKey) ?? "gpt-realtime-whisper"
    @Published var language: String = UserDefaults.standard.string(forKey: languageKey) ?? "en"
    @Published var delay: String = UserDefaults.standard.string(forKey: delayKey) ?? "medium"
    @Published var autoCommitSeconds: Double = UserDefaults.standard.double(forKey: commitSecondsKey) == 0
        ? 4
        : UserDefaults.standard.double(forKey: commitSecondsKey)
    @Published var transcriptionEnabled = UserDefaults.standard.object(forKey: transcriptionEnabledKey) as? Bool ?? true
    @Published var recordAudio = UserDefaults.standard.object(forKey: recordAudioKey) as? Bool ?? true
    @Published var autoCommitEnabled = UserDefaults.standard.object(forKey: autoCommitEnabledKey) as? Bool ?? true
    @Published var includeBase64InOutboundLog = UserDefaults.standard.object(forKey: includeBase64Key) as? Bool ?? false
    @Published var showInboundEvents = true
    @Published var showOutboundEvents = true
    @Published var showTranscriptEvents = true
    @Published private(set) var isRunning = false
    @Published private(set) var stateLabel = "Idle"
    @Published private(set) var liveTranscript = ""
    @Published private(set) var finalTranscript = ""
    @Published private(set) var audioBytes = 0
    @Published private(set) var pendingAudioBytes = 0
    @Published private(set) var activeFolderURL: URL?
    @Published private(set) var events: [GPTRTranscriptEvent] = []
    @Published private(set) var sessions: [GPTRTranscriptSession] = []

    private static let apiKeyKey = "gptr.openaiAPIKey"
    private static let modelKey = "gptr.model"
    private static let languageKey = "gptr.language"
    private static let delayKey = "gptr.delay"
    private static let commitSecondsKey = "gptr.autoCommitSeconds"
    private static let transcriptionEnabledKey = "gptr.transcriptionEnabled"
    private static let recordAudioKey = "gptr.recordAudio"
    private static let autoCommitEnabledKey = "gptr.autoCommitEnabled"
    private static let includeBase64Key = "gptr.includeBase64"

    private var recorder: LiveAudioSampleRecorder?
    private var webSocket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var commitTask: Task<Void, Never>?
    private var archive: GPTRTranscriptArchive?
    private var sequence = 0
    private var audioSampleOffset = 0

    var canStart: Bool {
        !isRunning && (!transcriptionEnabled || !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var historyRootURL: URL {
        Self.makeHistoryRootURL()
    }

    init() {
        reloadSessions()
    }

    func saveDrafts() {
        UserDefaults.standard.set(apiKey, forKey: Self.apiKeyKey)
        UserDefaults.standard.set(model, forKey: Self.modelKey)
        UserDefaults.standard.set(language, forKey: Self.languageKey)
        UserDefaults.standard.set(delay, forKey: Self.delayKey)
        UserDefaults.standard.set(autoCommitSeconds, forKey: Self.commitSecondsKey)
        UserDefaults.standard.set(transcriptionEnabled, forKey: Self.transcriptionEnabledKey)
        UserDefaults.standard.set(recordAudio, forKey: Self.recordAudioKey)
        UserDefaults.standard.set(autoCommitEnabled, forKey: Self.autoCommitEnabledKey)
        UserDefaults.standard.set(includeBase64InOutboundLog, forKey: Self.includeBase64Key)
    }

    func start() async {
        guard canStart else {
            appendEvent(direction: "local", type: "start.blocked", summary: "Add an OpenAI key or disable transcription.")
            return
        }
        saveDrafts()
        stateLabel = "Starting"
        isRunning = true
        liveTranscript = ""
        finalTranscript = ""
        audioBytes = 0
        pendingAudioBytes = 0
        audioSampleOffset = 0
        sequence = 0

        do {
            let archive = try GPTRTranscriptArchive(recordAudio: recordAudio)
            self.archive = archive
            activeFolderURL = archive.folderURL
            appendEvent(direction: "local", type: "archive.started", summary: archive.folderURL.lastPathComponent)

            if transcriptionEnabled {
                try await connectWebSocket()
            }

            let recorder = LiveAudioSampleRecorder(enableEchoCancellation: true)
            self.recorder = recorder
            try await recorder.start { [weak self] chunk in
                await self?.handleAudioChunk(chunk)
            }

            startCommitLoopIfNeeded()
            stateLabel = transcriptionEnabled ? "Streaming" : "Recording"
        } catch {
            appendEvent(direction: "local", type: "start.failed", summary: error.localizedDescription)
            await stop()
        }
    }

    func stop() async {
        guard isRunning || recorder != nil || webSocket != nil || archive != nil else { return }
        stateLabel = "Stopping"
        commitTask?.cancel()
        commitTask = nil

        if pendingAudioBytes > 0 {
            await commitAudio(reason: "stop")
        }

        _ = await recorder?.stop()
        recorder = nil
        receiveTask?.cancel()
        receiveTask = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        archive?.finish(
            audioBytes: audioBytes,
            finalTranscript: finalTranscript,
            transcriptionEnabled: transcriptionEnabled,
            model: model
        )
        archive = nil
        activeFolderURL = nil
        pendingAudioBytes = 0
        isRunning = false
        stateLabel = "Idle"
        reloadSessions()
    }

    func commitAudio(reason: String = "manual") async {
        guard transcriptionEnabled, webSocket != nil, pendingAudioBytes > 0 else { return }
        let bytes = pendingAudioBytes
        pendingAudioBytes = 0
        await sendJSON(
            [
                "type": "input_audio_buffer.commit"
            ],
            outboundType: "input_audio_buffer.commit",
            summary: "\(bytes) pending bytes, reason=\(reason)"
        )
    }

    func clearEvents() {
        events.removeAll()
    }

    func diagnosticsText() -> String {
        """
        GPTRDemo diagnostics
        state: \(stateLabel)
        running: \(isRunning)
        model: \(model)
        language: \(language)
        delay: \(delay)
        transcription_enabled: \(transcriptionEnabled)
        record_audio: \(recordAudio)
        auto_commit: \(autoCommitEnabled)
        active_folder: \(activeFolderURL?.path ?? "none")
        audio_bytes: \(audioBytes)
        pending_audio_bytes: \(pendingAudioBytes)
        final_transcript:
        \(finalTranscript)
        """
    }

    func reloadSessions() {
        sessions = Self.loadSessions()
    }

    private func connectWebSocket() async throws {
        guard let url = URL(string: "wss://api.openai.com/v1/realtime?intent=transcription") else {
            throw GPTRTranscriptError.invalidURL
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        webSocket = task
        task.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
        await sendJSON(sessionUpdatePayload(), outboundType: "session.update", summary: "model=\(model)")
    }

    private func sessionUpdatePayload() -> [String: Any] {
        var transcription: [String: Any] = [
            "model": model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "gpt-realtime-whisper" : model.trimmingCharacters(in: .whitespacesAndNewlines)
        ]
        let trimmedLanguage = language.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedLanguage.isEmpty {
            transcription["language"] = trimmedLanguage
        }
        if delay != "default" {
            transcription["delay"] = delay
        }
        return [
            "type": "session.update",
            "session": [
                "type": "transcription",
                "audio": [
                    "input": [
                        "format": [
                            "type": "audio/pcm",
                            "rate": 24_000
                        ],
                        "transcription": transcription,
                        "turn_detection": NSNull()
                    ]
                ],
                "include": ["item.input_audio_transcription.logprobs"]
            ]
        ]
    }

    private func handleAudioChunk(_ chunk: LiveAudioChunk) async {
        sequence += 1
        let startSample = audioSampleOffset
        let sampleCount = chunk.data.count / MemoryLayout<Int16>.size
        audioSampleOffset += sampleCount
        audioBytes += chunk.data.count
        pendingAudioBytes += chunk.data.count

        if recordAudio {
            archive?.appendAudio(chunk.data)
        }

        guard transcriptionEnabled, webSocket != nil else { return }
        var payload: [String: Any] = [
            "type": "input_audio_buffer.append",
            "audio": chunk.data.base64EncodedString()
        ]
        let audioRef = "audio.wav#sample=\(startSample)..\(audioSampleOffset)"
        await sendJSON(
            payload,
            outboundType: "input_audio_buffer.append",
            summary: "\(chunk.data.count) bytes \(audioRef)",
            audioRef: audioRef,
            audioBytes: chunk.data.count
        )
        payload.removeAll()
    }

    private func startCommitLoopIfNeeded() {
        guard autoCommitEnabled, transcriptionEnabled else { return }
        let interval = max(1, autoCommitSeconds)
        commitTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                await self?.commitAudio(reason: "auto")
            }
        }
    }

    private func sendJSON(
        _ payload: [String: Any],
        outboundType: String,
        summary: String,
        audioRef: String? = nil,
        audioBytes: Int? = nil
    ) async {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        webSocket?.send(.string(text)) { [weak self] error in
            guard let self else { return }
            Task { @MainActor in
                if let error {
                    self.appendEvent(direction: "out", type: "\(outboundType).failed", summary: error.localizedDescription)
                    return
                }
                var logPayload = payload
                if !self.includeBase64InOutboundLog, logPayload["audio"] != nil {
                    logPayload["audio"] = "<base64 omitted>"
                }
                self.archive?.appendOutbound(type: outboundType, payload: logPayload, audioRef: audioRef, audioBytes: audioBytes)
                self.appendEvent(direction: "out", type: outboundType, summary: summary)
            }
        }
    }

    private func receiveLoop() async {
        while !Task.isCancelled {
            do {
                guard let webSocket else { return }
                let message = try await webSocket.receive()
                switch message {
                case .string(let text):
                    handleInbound(text)
                case .data(let data):
                    handleInbound(String(data: data, encoding: .utf8) ?? "")
                @unknown default:
                    appendEvent(direction: "in", type: "unknown", summary: "Unknown WebSocket message")
                }
            } catch {
                if isRunning {
                    stateLabel = "Socket error"
                    appendEvent(direction: "in", type: "receive.failed", summary: error.localizedDescription)
                }
                return
            }
        }
    }

    private func handleInbound(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            appendEvent(direction: "in", type: "invalid_json", summary: text.prefix(80).description)
            return
        }
        let type = json["type"] as? String ?? "unknown"
        archive?.appendInbound(type: type, payload: json)
        switch type {
        case "conversation.item.input_audio_transcription.delta", "transcript.text.delta":
            let delta = (json["delta"] as? String) ?? (json["text"] as? String) ?? ""
            liveTranscript += delta
            archive?.appendTranscript(event: "delta", text: delta, payload: json)
            appendEvent(direction: "transcript", type: type, summary: delta)
        case "conversation.item.input_audio_transcription.completed", "transcript.text.done":
            let transcript = (json["transcript"] as? String) ?? (json["text"] as? String) ?? liveTranscript
            if !finalTranscript.isEmpty {
                finalTranscript += "\n"
            }
            finalTranscript += transcript
            liveTranscript = ""
            archive?.appendTranscript(event: "completed", text: transcript, payload: json)
            appendEvent(direction: "transcript", type: type, summary: transcript)
        case "conversation.item.input_audio_transcription.failed":
            appendEvent(direction: "in", type: type, summary: "Transcription failed")
        case "error":
            let message = errorSummary(for: json)
            stateLabel = "OpenAI error"
            webSocket?.cancel(with: .unsupportedData, reason: Data(message.utf8))
            webSocket = nil
            appendEvent(direction: "in", type: type, summary: message)
        default:
            appendEvent(direction: "in", type: type, summary: summary(for: json))
        }
    }

    private func appendEvent(direction: String, type: String, summary: String) {
        events.insert(GPTRTranscriptEvent(timestamp: Date(), direction: direction, type: type, summary: summary), at: 0)
        if events.count > 200 {
            events.removeLast(events.count - 200)
        }
    }

    private func summary(for json: [String: Any]) -> String {
        if let itemID = json["item_id"] as? String {
            return itemID
        }
        if let eventID = json["event_id"] as? String {
            return eventID
        }
        return ""
    }

    private func errorSummary(for json: [String: Any]) -> String {
        guard let error = json["error"] as? [String: Any] else {
            return String(describing: json)
        }
        let message = error["message"] as? String ?? "Unknown OpenAI error"
        if let code = error["code"] as? String, !code.isEmpty {
            return "\(code): \(message)"
        }
        return message
    }

    fileprivate nonisolated static func makeHistoryRootURL() -> URL {
        let root = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gptr-recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private static func loadSessions() -> [GPTRTranscriptSession] {
        let root = makeHistoryRootURL()
        let folders = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.creationDateKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        return folders.compactMap { folder in
            guard (try? folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return nil }
            let manifest = folder.appendingPathComponent("manifest.json")
            guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
            let created = (try? folder.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date.distantPast
            let audio = folder.appendingPathComponent("audio.wav")
            return GPTRTranscriptSession(
                id: folder.lastPathComponent,
                folderURL: folder,
                startedAt: created,
                audioURL: audio,
                transcriptURL: folder.appendingPathComponent("transcript.live.jsonl"),
                finalTranscriptURL: folder.appendingPathComponent("transcript.final.jsonl"),
                openAIEventsURL: folder.appendingPathComponent("openai-events.jsonl"),
                outboundEventsURL: folder.appendingPathComponent("outbound-events.jsonl"),
                manifestURL: manifest,
                audioBytes: byteCount(at: audio)
            )
        }
        .sorted { $0.startedAt > $1.startedAt }
    }

    private static func byteCount(at url: URL) -> UInt64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return attrs?[.size] as? UInt64 ?? 0
    }
}

private enum GPTRTranscriptError: LocalizedError {
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Could not build Realtime transcription WebSocket URL."
        }
    }
}

private final class GPTRTranscriptArchive {
    let folderURL: URL
    private let sessionID: String
    private let startedAt: Date
    private let audioURL: URL
    private let manifestURL: URL
    private let transcriptURL: URL
    private let finalTranscriptURL: URL
    private let openAIEventsURL: URL
    private let outboundEventsURL: URL
    private var audioSink: WavFileSink?
    private var transcriptHandle: FileHandle?
    private var finalTranscriptHandle: FileHandle?
    private var openAIEventsHandle: FileHandle?
    private var outboundEventsHandle: FileHandle?

    init(recordAudio: Bool) throws {
        let stamp = Self.captureStamp(Date())
        sessionID = "gptr-\(stamp)"
        startedAt = Date()
        folderURL = GPTRTranscriptDemoStore.makeHistoryRootURL()
            .appendingPathComponent(sessionID, isDirectory: true)
        audioURL = folderURL.appendingPathComponent("audio.wav")
        manifestURL = folderURL.appendingPathComponent("manifest.json")
        transcriptURL = folderURL.appendingPathComponent("transcript.live.jsonl")
        finalTranscriptURL = folderURL.appendingPathComponent("transcript.final.jsonl")
        openAIEventsURL = folderURL.appendingPathComponent("openai-events.jsonl")
        outboundEventsURL = folderURL.appendingPathComponent("outbound-events.jsonl")

        try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
        transcriptHandle = try Self.openEmptyFile(transcriptURL)
        finalTranscriptHandle = try Self.openEmptyFile(finalTranscriptURL)
        openAIEventsHandle = try Self.openEmptyFile(openAIEventsURL)
        outboundEventsHandle = try Self.openEmptyFile(outboundEventsURL)
        if recordAudio {
            let sink = WavFileSink()
            try sink.open(format: .wavMono(sampleRate: 24_000), url: audioURL)
            audioSink = sink
        }
        writeManifest(finalized: false, audioBytes: 0, finalTranscript: "", transcriptionEnabled: true, model: "gpt-realtime-whisper")
    }

    func appendAudio(_ data: Data) {
        try? audioSink?.write(chunk: AudioChunk(pcm: data, timestamp: Date().timeIntervalSince1970, sampleRate: 24_000))
    }

    func appendOutbound(type: String, payload: [String: Any], audioRef: String?, audioBytes: Int?) {
        var entry: [String: Any] = [
            "timestamp": Self.iso.string(from: Date()),
            "direction": "out",
            "type": type,
            "payload": payload
        ]
        if let audioRef { entry["audio_ref"] = audioRef }
        if let audioBytes { entry["audio_bytes"] = audioBytes }
        writeJSONLine(entry, to: outboundEventsHandle)
    }

    func appendInbound(type: String, payload: [String: Any]) {
        writeJSONLine([
            "timestamp": Self.iso.string(from: Date()),
            "direction": "in",
            "type": type,
            "payload": payload
        ], to: openAIEventsHandle)
    }

    func appendTranscript(event: String, text: String, payload: [String: Any]) {
        let entry: [String: Any] = [
            "timestamp": Self.iso.string(from: Date()),
            "event": event,
            "text": text,
            "item_id": payload["item_id"] ?? NSNull(),
            "payload": payload
        ]
        writeJSONLine(entry, to: transcriptHandle)
        if event == "completed" {
            writeJSONLine(entry, to: finalTranscriptHandle)
        }
    }

    func finish(audioBytes: Int, finalTranscript: String, transcriptionEnabled: Bool, model: String) {
        try? audioSink?.close()
        audioSink = nil
        try? transcriptHandle?.close()
        try? finalTranscriptHandle?.close()
        try? openAIEventsHandle?.close()
        try? outboundEventsHandle?.close()
        writeManifest(
            finalized: true,
            audioBytes: audioBytes,
            finalTranscript: finalTranscript,
            transcriptionEnabled: transcriptionEnabled,
            model: model
        )
    }

    private func writeManifest(
        finalized: Bool,
        audioBytes: Int,
        finalTranscript: String,
        transcriptionEnabled: Bool,
        model: String
    ) {
        let payload: [String: Any] = [
            "id": sessionID,
            "started_at": Self.iso.string(from: startedAt),
            "finalized_at": finalized ? Self.iso.string(from: Date()) : NSNull(),
            "mode": "openai.realtime.transcription.websocket",
            "model": model,
            "sample_rate": 24_000,
            "audio_file": FileManager.default.fileExists(atPath: audioURL.path) ? "audio.wav" : NSNull(),
            "audio_bytes": audioBytes,
            "transcription_enabled": transcriptionEnabled,
            "transcript_live_file": "transcript.live.jsonl",
            "transcript_final_file": "transcript.final.jsonl",
            "openai_events_file": "openai-events.jsonl",
            "outbound_events_file": "outbound-events.jsonl",
            "final_transcript": finalTranscript
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) else {
            return
        }
        try? data.write(to: manifestURL, options: .atomic)
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

    private static func openEmptyFile(_ url: URL) throws -> FileHandle {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        return try FileHandle(forWritingTo: url)
    }

    private static let iso = ISO8601DateFormatter()

    private static func captureStamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }
}
