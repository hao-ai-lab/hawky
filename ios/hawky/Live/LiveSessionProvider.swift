import Foundation
import PipecatClientIOS
import PipecatClientIOSOpenAIRealtimeWebrtc

/// Cocktail Party Mode debug tracing. Compiled out of release builds; the
/// `@autoclosure` means the interpolated string is never even built in release.
@inline(__always)
private func cocktailDebugLog(_ message: @autoclosure () -> String) {
    #if DEBUG
    print(message())
    #endif
}

// STATIC REVIEW ONLY — no Swift/Xcode in CI; verified by grep.
/// One prior turn to replay into a fresh Realtime session so the model resumes
/// with memory of the conversation so far.
struct LiveHistoryTurn: Equatable {
    enum Role: Equatable { case user, assistant }
    let role: Role
    let text: String
}

@MainActor
protocol LiveSessionProvider: AnyObject {
    var managesAudioInput: Bool { get }
    var seedsHistoryOnConnect: Bool { get }
    var sessionConfigStatus: LiveRealtimeSessionConfigStatus { get }
    func connect(config: LiveSessionConfig) async throws
    func setAudioInputEnabled(_ enabled: Bool) async throws
    func sendAudio(_ chunk: LiveAudioChunk) async throws
    func streamAudio(_ chunk: LiveAudioChunk) async throws
    func commitAudioStream() async throws
    func sendFrame(_ frame: LiveJPEGFrame) async throws
    func sendText(_ text: String) async throws
    func sendContext(_ text: String, createResponse: Bool) async throws
    /// Replay prior conversation turns (no response triggered) so a reconnected
    /// or resumed session remembers context. No-op for providers that don't
    /// support it.
    func seedHistory(_ turns: [LiveHistoryTurn]) async throws
    /// Inject a surface message with floor-guard semantics (§5).
    /// `intentionId` is threaded end-to-end so the realtime model can call intention_respond.
    /// `cautious` is true for latent-origin suggestions; the realtime model renders them
    /// as hedged questions rather than definitive assertions (prompt rendering in LiveModels).
    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws
    /// Stay Silent (Hawky): push a live `session.update` that toggles whether the
    /// model speaks. When `silent` is true VAD/transcription stay active but
    /// automatic responses are disabled (create_response:false, tool_choice:none)
    /// and the observation-mode prompt is layered on; false restores normal config.
    /// No-op for providers that don't support a mid-session update.
    func setSilenceMode(_ silent: Bool, config: LiveSessionConfig) async throws
    /// Stay Silent (Hawky): on release, inject the captured silence transcript as
    /// user context and force exactly one recap turn via a constrained `response.create`.
    func requestSilenceReleaseSummary(prompt: String) async throws
    /// Visual-quiet (#646): while the camera streams, disable VAD auto-response so
    /// frames/context can't trigger overlapping responses (the active-response error).
    /// Keeps the normal persona + tools; the model still answers committed speech turns.
    func setVisualQuietMode(_ quiet: Bool, config: LiveSessionConfig) async throws
    /// Bridge capability update: push a live `session.update` so model-facing
    /// instructions/tools match the current Hawky gateway availability.
    func setBridgeAvailability(_ availability: LiveBridgeAvailability, config: LiveSessionConfig) async throws
    /// Safety Check (#648): speak a hazard warning VERBATIM. Unlike surfaceIntention
    /// (which hands text to the model to paraphrase into a "natural aside" — making it
    /// chatty), this forces the model to say exactly `text` and stop: no elaboration,
    /// no follow-up advice, no tool calls. Floor-guarded like surfaceIntention.
    func speakSafetyWarning(_ text: String) async throws
    /// Safety Check hard-quiet (#648): when on, suppress ALL unprompted model speech
    /// (greeting, bridge asides/intentions, openings). Only the user's own speech turn
    /// and verbatim hazard warnings produce audio. No-op for providers without it.
    func setHardQuiet(_ on: Bool) async
    func events() -> AsyncStream<LiveSessionEvent>
    func close() async
}

extension LiveSessionProvider {
    var managesAudioInput: Bool { false }
    var seedsHistoryOnConnect: Bool { false }
    var sessionConfigStatus: LiveRealtimeSessionConfigStatus { .notApplicable }
    func setAudioInputEnabled(_ enabled: Bool) async throws {}
    func seedHistory(_ turns: [LiveHistoryTurn]) async throws {}
    func surfaceIntention(_ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy) async throws {
        try await surfaceIntention(nil, text, speak: speak, whenBusy: whenBusy, cautious: false)
    }
    func surfaceIntention(_ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {
        try await surfaceIntention(nil, text, speak: speak, whenBusy: whenBusy, cautious: cautious)
    }
    // Stay Silent defaults: no-op for providers that can't push a mid-session update.
    func setSilenceMode(_ silent: Bool, config: LiveSessionConfig) async throws {}
    func requestSilenceReleaseSummary(prompt: String) async throws {}
    func setVisualQuietMode(_ quiet: Bool, config: LiveSessionConfig) async throws {}
    func setBridgeAvailability(_ availability: LiveBridgeAvailability, config: LiveSessionConfig) async throws {}
    // Safety Check default: fall back to a plain spoken aside for providers that can't
    // force a constrained response.create.
    func speakSafetyWarning(_ text: String) async throws {
        try await surfaceIntention(nil, text, speak: true, whenBusy: .cancelAndReplace, cautious: false)
    }
    func setHardQuiet(_ on: Bool) async {}
}

enum LiveSessionProviderError: LocalizedError, Equatable {
    case adapterUnavailable(String)
    case invalidConfig(String)
    case sessionConfigurationFailed(String)
    /// The provider rejected our credentials (HTTP 401/403) — typically a wrong
    /// or expired API key. Distinct from `invalidConfig` so the UI can route it
    /// to the "fix your key in Settings" flow.
    case authenticationFailed(String)

    var errorDescription: String? {
        switch self {
        case .adapterUnavailable(let message),
             .invalidConfig(let message),
             .sessionConfigurationFailed(let message),
             .authenticationFailed(let message):
            return message
        }
    }
}

enum LiveSessionProviderFactory {
    @MainActor
    static func makeProvider(for config: LiveSessionConfig, gatewayBridge: LiveGatewayBridge? = nil) -> LiveSessionProvider {
        #if DEBUG
        // UI-testing seam: simulate an OpenAI 401 on connect so the auth-failure
        // → alert path is testable without the network.
        if UITestingSupport.forcesLiveAuthFailure() {
            return AuthFailingLiveSessionProvider()
        }
        #endif
        switch config.provider {
        case .mock:
            return MockLiveSessionProvider()
        case .openAIRealtime:
            return PipecatOpenAIRealtimeLiveSessionProvider(gatewayBridge: gatewayBridge)
        case .geminiLive:
            return DisabledLiveSessionProvider(
                message: "Gemini Live adapter is not wired yet. Configure a session broker before enabling it."
            )
        case .custom:
            return DisabledLiveSessionProvider(
                message: "Custom live endpoints need an adapter dialect before they can start."
            )
        }
    }
}

final class DisabledLiveSessionProvider: LiveSessionProvider {
    private let message: String

    init(message: String) {
        self.message = message
    }

    func connect(config: LiveSessionConfig) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func setAudioInputEnabled(_ enabled: Bool) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func sendAudio(_ chunk: LiveAudioChunk) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func streamAudio(_ chunk: LiveAudioChunk) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func commitAudioStream() async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func sendFrame(_ frame: LiveJPEGFrame) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func sendText(_ text: String) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func sendContext(_ text: String, createResponse: Bool) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {
        throw LiveSessionProviderError.adapterUnavailable(message)
    }

    func events() -> AsyncStream<LiveSessionEvent> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func close() async {}
}

#if DEBUG
/// UI-testing stub that throws an auth failure the moment it's asked to connect,
/// so the "rejected/expired key → alert with Open Live Settings" path can be
/// exercised deterministically without hitting OpenAI.
final class AuthFailingLiveSessionProvider: LiveSessionProvider {
    func connect(config: LiveSessionConfig) async throws {
        throw LiveSessionProviderError.authenticationFailed("Simulated 401 for UI testing.")
    }
    func setAudioInputEnabled(_ enabled: Bool) async throws {}
    func sendAudio(_ chunk: LiveAudioChunk) async throws {}
    func streamAudio(_ chunk: LiveAudioChunk) async throws {}
    func commitAudioStream() async throws {}
    func sendFrame(_ frame: LiveJPEGFrame) async throws {}
    func sendText(_ text: String) async throws {}
    func sendContext(_ text: String, createResponse: Bool) async throws {}
    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {}
    func events() -> AsyncStream<LiveSessionEvent> {
        AsyncStream { $0.finish() }
    }
    func close() async {}
}
#endif

final class MockLiveSessionProvider: LiveSessionProvider {
    private var continuation: AsyncStream<LiveSessionEvent>.Continuation?
    private var heartbeatTask: Task<Void, Never>?
    private lazy var eventStream: AsyncStream<LiveSessionEvent> = AsyncStream { continuation in
        self.continuation = continuation
    }

    func connect(config: LiveSessionConfig) async throws {
        continuation?.yield(.status("Connected to \(config.model)"))
        continuation?.yield(.latency(milliseconds: 38))
        heartbeatTask = Task { [weak self] in
            var tick = 1
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard !Task.isCancelled else { return }
                self?.continuation?.yield(.text("Mock live event \(tick)"))
                self?.continuation?.yield(.latency(milliseconds: Double(35 + (tick % 4) * 7)))
                tick += 1
            }
        }
    }

    func setAudioInputEnabled(_ enabled: Bool) async throws {
        continuation?.yield(.status(enabled ? "Listening" : "Audio input off"))
    }

    func sendAudio(_ chunk: LiveAudioChunk) async throws {
        continuation?.yield(.audioAccepted(bytes: chunk.data.count))
    }

    func streamAudio(_ chunk: LiveAudioChunk) async throws {
        continuation?.yield(.audioAccepted(bytes: chunk.data.count))
    }

    func commitAudioStream() async throws {
        continuation?.yield(.text("Mock audio turn committed"))
    }

    func sendFrame(_ frame: LiveJPEGFrame) async throws {
        continuation?.yield(.frameAccepted(bytes: frame.data.count))
    }

    func sendText(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        continuation?.yield(.text("Echo: \(trimmed)"))
    }

    func sendContext(_ text: String, createResponse: Bool) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        continuation?.yield(.status("Context: \(trimmed)"))
    }

    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        continuation?.yield(.status("Surface[\(speak ? "speak" : "context")\(cautious ? "/cautious" : "")]: \(trimmed)"))
    }

    func events() -> AsyncStream<LiveSessionEvent> {
        eventStream
    }

    func close() async {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        continuation?.yield(.status("Closed"))
        continuation?.finish()
        continuation = nil
    }
}

final class PipecatOpenAIRealtimeLiveSessionProvider: NSObject, LiveSessionProvider, RTVIClientDelegate, LLMHelperDelegate {
    var managesAudioInput: Bool { true }
    var seedsHistoryOnConnect: Bool { true }

    private var continuation: AsyncStream<LiveSessionEvent>.Continuation?
    private lazy var eventStream: AsyncStream<LiveSessionEvent> = AsyncStream { continuation in
        self.continuation = continuation
    }
    private var client: RTVIClient?
    private var transport: OpenAIRealtimeTransport?
    private var llmHelper: LLMHelper?
    private var currentConfig = LiveSessionConfig()
    private var startupGuardWaitingForFirstBotStop = false
    private var pendingAudioInputEnabled = false
    private var currentAssistantTranscriptItemID: String?
    /// True while the assistant is producing a response. Appending context to the
    /// conversation during this window throws `conversation_already_has_active_response`,
    /// so context-only injections (createResponse:false) are buffered and flushed on
    /// onBotStoppedSpeaking. (#627: background-feed / cocktail context error storm.)
    private var botSpeaking = false
    private var pendingContextInjections: [String] = []
    private let maxPendingContextInjections = 20
    /// Safety Check (#648): a hazard warning that arrived while the floor was busy.
    /// Held SEPARATELY from pendingContextInjections so it's still spoken VERBATIM
    /// (constrained response.create) on flush, not paraphrased like a context aside.
    /// Only the latest is kept — a stale hazard shouldn't fire after the scene moved on.
    private var pendingSafetyWarning: String?
    /// The warning whose response.create we just sent (cleared once its turn starts). If
    /// the server rejects it async with active_response, onError re-arms
    /// pendingSafetyWarning from this so the hazard isn't dropped.
    private var lastWarningInFlight: String?
    /// "Respond only when I talk": when true, VAD auto-response is off, so we must
    /// explicitly fire response.create when the user finishes a turn — otherwise the
    /// model never replies. Set by setVisualQuietMode.
    private var manualResponseMode = false
    /// Safety Check hard-quiet (#648): when true, suppress ALL unprompted model speech
    /// — the first-contact greeting, Hawky bridge asides/intentions, opening prompts.
    /// The ONLY speech allowed is (a) a reply to the user's own speech turn
    /// (onUserStoppedSpeaking) and (b) a verbatim hazard warning (fireSafetyWarning).
    /// Set by setHardQuiet(); checked in every force-response path.
    private var hardQuiet = false
    /// Stay Silent (#671): when true, the model must NOT respond — it only listens.
    /// setSilenceMode already disables server-VAD auto-response (create_response:false),
    /// but we ALSO track it here so the app's MANUAL response.create path
    /// (onUserStoppedSpeaking, when "respond only when I talk" is on) is suppressed,
    /// and any stray server turn is canceled in onBotStartedSpeaking. Set by
    /// setSilenceMode(); cleared when Stay Silent is released.
    private var silentModeActive = false
    /// Safety Check hard-quiet: counts turns we EXPLICITLY authorized (a reply to the
    /// user's speech, or a verbatim safety warning). When hardQuiet is on and the bot
    /// starts a turn with no authorization pending, it's an unsanctioned server turn
    /// (greeting / narration) → we cancel it immediately. Decremented on bot-start.
    private var sanctionedTurnCredits = 0
    /// Watchdog so botSpeaking can't get stuck true (which would block all frames):
    /// if onBotStoppedSpeaking never arrives, auto-clear + flush after this long.
    private var floorBusyWatchdog: Task<Void, Never>?
    /// #677: true once the server has acked our data-channel `session.update` with a
    /// `session.updated` event — i.e. the persona/tools/VAD/transcription config was
    /// actually applied. Until then the WebRTC media leg can be "connected" while the
    /// session is unconfigured. Reset each connect().
    private var sessionConfigConfirmed = false
    /// #677: fires if neither a `session.updated` ack nor a config error arrives within
    /// the window after connect — a soft "settings not confirmed" signal (the hard,
    /// reliable failure comes through onError as `session_config_failed:`).
    private var sessionConfigWatchdog: Task<Void, Never>?
    /// #677: latches once `session_config_failed:` is reported, so a late `session.updated`
    /// ack (initial_messages threw after session.update succeeded) can't flip it back to
    /// "applied". Reset each connect().
    private var sessionConfigFailed = false
    private var currentSessionConfigStatus: LiveRealtimeSessionConfigStatus = .notApplicable
    private var sessionConfigWaiter: CheckedContinuation<LiveRealtimeSessionConfigStatus, Never>?
    private let gatewayBridge: LiveGatewayBridge?
    private let toolRegistry = LiveToolRegistry.default
    /// Set by LiveSessionStore so summarize_session can run LiveSessionSummarizer.
    var summarizeHook: ((String) async throws -> String)?
    /// Set by LiveSessionStore so scan tools see the latest transcript window.
    var awaitPendingTranscriptAppend: (() async -> Void)?
    /// Set by LiveSessionStore so summarize_silence returns the captured window.
    var silenceSummaryHook: (() async -> String)?
    /// Set by LiveSessionStore; true while Cocktail Party Mode is active (gates person tools).
    var cocktailPartyActiveHook: (@MainActor () -> Bool)?
    /// Set by LiveSessionStore; identifies whoever is on camera now (identify_person tool).
    var identifyOnCameraHook: (@MainActor () async -> FaceIdentifyResult)?
    /// Set by LiveSessionStore; resolve+enroll the camera person for a profile write.
    var resolveCameraPersonHook: (@MainActor (String?) async -> FaceIdentifyResult)?

    /// Build the tool-execution context from the provider's current config + hooks.
    /// MainActor-isolated because the cocktail-party hook runs on the main actor.
    @MainActor
    private func makeLiveToolContext() -> LiveToolContext {
        LiveToolContext(
            config: currentConfig,
            gatewayBridge: gatewayBridge,
            awaitPendingTranscriptAppend: awaitPendingTranscriptAppend,
            summarize: summarizeHook,
            silenceSummary: silenceSummaryHook,
            cocktailPartyActive: cocktailPartyActiveHook?() ?? false,
            identifyOnCamera: identifyOnCameraHook,
            resolveCameraPerson: resolveCameraPersonHook
        )
    }

    init(gatewayBridge: LiveGatewayBridge? = nil) {
        self.gatewayBridge = gatewayBridge
        super.init()
    }

    var sessionConfigStatus: LiveRealtimeSessionConfigStatus {
        currentSessionConfigStatus
    }

    func connect(config: LiveSessionConfig) async throws {
        currentConfig = config
        guard let apiKey = try KeychainStore.loadOpenAIAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !apiKey.isEmpty else {
            throw LiveSessionProviderError.invalidConfig("OpenAI Realtime needs a Direct OpenAI API key saved on this iPhone.")
        }

        let options = Self.makeOptions(config: config, apiKey: apiKey, micEnabled: false)
        let transport = OpenAIRealtimeTransport(options: options)
        let client = RTVIClient(transport: transport, options: options)
        client.delegate = self
        self.client = client
        self.transport = transport
        // Register the LLM helper so we can inject text turns (typed messages)
        // over the WebRTC data channel via append_to_messages, AND receive the
        // model's function calls (onLLMFunctionCall) so tools actually execute.
        let helper = try? client.registerHelper(service: "llm", helper: LLMHelper.self)
        helper?.delegate = self
        self.llmHelper = helper
        startupGuardWaitingForFirstBotStop = false
        botSpeaking = false
        // Only "Respond only when I talk" needs manual response.create on user-stop.
        // Safety Check does NOT: now that camera frames no longer trigger responses
        // (SDK run_immediately fix), we keep fast server-VAD auto-response for the
        // user's speech and rely on hardQuiet to cancel any stray unprompted turn.
        // (Manual mode added a server→phone→server round-trip → 6-8s reply latency.)
        manualResponseMode = config.speakOnlyWhenSpokenTo
        floorBusyWatchdog?.cancel()
        floorBusyWatchdog = nil
        pendingContextInjections.removeAll()
        pendingSafetyWarning = nil
        lastWarningInFlight = nil
        // Hard-quiet baked in from connect config when Safety Check is on, so the
        // first-contact greeting / bridge nudges are suppressed from the very first turn.
        hardQuiet = config.safetyCheckEnabled
        sanctionedTurnCredits = 0
        pendingAudioInputEnabled = config.audioInputEnabled
        // #677: assume unconfigured until the server acks our session.update. The base
        // session in the SDP offer carries minimal config; persona/tools/VAD are applied
        // over the data channel in the SDK's updateSession() AFTER session.created, and a
        // local send failure there is otherwise invisible (the session still "connects").
        sessionConfigConfirmed = false
        sessionConfigFailed = false
        currentSessionConfigStatus = .pending
        sessionConfigWaiter = nil
        sessionConfigWatchdog?.cancel()
        sessionConfigWatchdog = nil
        do {
            try await client.start()
        } catch {
            // The Pipecat SDK wraps connect failures in an opaque StartBotError;
            // the real cause (e.g. a 401 from /v1/realtime/calls with a bad key) is
            // buried in its RTVIError underlying chain. Classify it so a rejected
            // key routes to the auth alert + Settings shortcut instead of a generic
            // "StartBotError" banner.
            throw Self.classifyStartFailure(error)
        }
        continuation?.yield(.status("WebRTC session started"))

        let configStatus = await waitForSessionConfigStatus()
        switch configStatus {
        case .applied, .unconfirmed:
            break
        case .failed(let detail):
            let suffix = detail.map { ": \($0)" } ?? ""
            throw LiveSessionProviderError.sessionConfigurationFailed(
                "OpenAI Realtime session settings failed to apply\(suffix)"
            )
        case .notApplicable, .pending:
            break
        }
    }

    private func waitForSessionConfigStatus(timeoutNanoseconds: UInt64 = 8_000_000_000) async -> LiveRealtimeSessionConfigStatus {
        switch currentSessionConfigStatus {
        case .applied, .unconfirmed, .failed, .notApplicable:
            return currentSessionConfigStatus
        case .pending:
            break
        }
        return await withCheckedContinuation { continuation in
            sessionConfigWaiter = continuation
            // #677: arm a soft watchdog. If no session.updated ack (and no config error)
            // arrives, surface an "unconfirmed" status so a silently-unconfigured
            // session is visible instead of reading as a clean Connected. Do not throw
            // here: the official Realtime error event is the hard-failure signal.
            sessionConfigWatchdog?.cancel()
            sessionConfigWatchdog = Task { [weak self] in
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                await MainActor.run {
                    self?.reportSessionConfigUnconfirmedIfNeeded()
                }
            }
        }
    }

    private func finishSessionConfigStatus(_ status: LiveRealtimeSessionConfigStatus) {
        currentSessionConfigStatus = status
        sessionConfigWatchdog?.cancel()
        sessionConfigWatchdog = nil
        continuation?.yield(.sessionConfigStatus(status))
        sessionConfigWaiter?.resume(returning: status)
        sessionConfigWaiter = nil
    }

    /// #677: the server acked our session.update (a `session.updated` event over the
    /// data channel) — persona/tools/VAD config is live. Called from onServerMessage.
    private func markSessionConfigConfirmed() {
        // #677: don't let a late ack overwrite an already-reported config failure.
        guard !sessionConfigConfirmed, !sessionConfigFailed else { return }
        sessionConfigConfirmed = true
        finishSessionConfigStatus(.applied)
    }

    /// #677: watchdog fired without an ack or a config error. Soft signal only (the
    /// hard failure path is onError → `session_config_failed:`), so a slow-but-working
    /// session isn't wrongly flagged as failed.
    private func reportSessionConfigUnconfirmedIfNeeded() {
        guard !sessionConfigConfirmed, !sessionConfigFailed else { return }
        finishSessionConfigStatus(.unconfirmed(detail: "Timed out waiting for session.updated."))
        continuation?.yield(.status("Session config not confirmed — settings may not have applied"))
    }

    /// Unwraps the RTVIError underlying-error chain and maps OpenAI auth rejections
    /// to `.authenticationFailed` (so the UI offers "Open Live Settings"); other
    /// failures become `.invalidConfig` carrying the most specific message we can
    /// recover, rather than the SDK's opaque "StartBotError".
    static func classifyStartFailure(_ error: Error) -> Error {
        var messages: [String] = []
        var current: Error? = error
        var depth = 0
        while let e = current, depth < 6 {
            if let rtvi = e as? RTVIError {
                if !rtvi.message.isEmpty { messages.append(rtvi.message) }
                current = rtvi.underlyingError
            } else {
                messages.append((e as NSError).localizedDescription)
                current = nil
            }
            depth += 1
        }
        let combined = messages.joined(separator: " ").lowercased()
        let looksLikeAuth = combined.contains("401")
            || combined.contains("403")
            || combined.contains("invalid_api_key")
            || combined.contains("incorrect api key")
            || combined.contains("unauthorized")
            || combined.contains("authenticating")
        if looksLikeAuth {
            return LiveSessionProviderError.authenticationFailed(
                "OpenAI rejected the saved API key — it may be wrong or expired. Update it in Live Settings."
            )
        }
        let detail = messages.first(where: { !$0.isEmpty }) ?? error.localizedDescription
        return LiveSessionProviderError.invalidConfig("Couldn't start the Live session: \(detail)")
    }

    func setAudioInputEnabled(_ enabled: Bool) async throws {
        guard let client else { return }
        pendingAudioInputEnabled = enabled
        guard !startupGuardWaitingForFirstBotStop else {
            if !enabled {
                try await client.enableMic(enable: false)
                continuation?.yield(.status("Audio input off"))
            } else {
                continuation?.yield(.status("Mic pending until assistant finishes"))
            }
            return
        }
        try await client.enableMic(enable: enabled)
        continuation?.yield(.status(enabled ? "Listening" : "Audio input off"))
    }

    func sendAudio(_ chunk: LiveAudioChunk) async throws {
        throw LiveSessionProviderError.adapterUnavailable("WebRTC Live captures mic audio through the provider-owned track.")
    }

    func streamAudio(_ chunk: LiveAudioChunk) async throws {
        throw LiveSessionProviderError.adapterUnavailable("WebRTC Live captures mic audio through the provider-owned track.")
    }

    func commitAudioStream() async throws {}

    func sendFrame(_ frame: LiveJPEGFrame) async throws {
        guard let client else {
            throw LiveSessionProviderError.adapterUnavailable("Visual frames unavailable — WebRTC client not connected.")
        }
        // Appending an input_image while a response is active throws
        // conversation_already_has_active_response. Frames are disposable (another
        // arrives next tick), so drop this one rather than error-storm. (#627)
        if botSpeaking { cocktailDebugLog("[cocktail-frame] dropped (busy)"); return }
        cocktailDebugLog("[cocktail-frame] send")
        let base64 = frame.data.base64EncodedString()
        // Inject a user message with an input_image content block over the data
        // channel (append_to_messages, run_immediately:false → adds visual
        // context without forcing a response). The OpenAI WebRTC transport's
        // conversationContent parses {type:"input_image", image_url}.
        let messages: Value = .array([
            .object([
                "role": .string("user"),
                "content": .array([
                    .object([
                        "type": .string("input_image"),
                        "image_url": .string("data:image/jpeg;base64,\(base64)")
                    ])
                ])
            ])
        ])
        // Defensive: even with the botSpeaking guard, a response can be active in a
        // race. Frames are disposable, so swallow append errors (the next frame
        // retries) instead of surfacing conversation_already_has_active_response.
        do {
            _ = try await client.action(action: ActionRequest(
                service: "llm",
                action: "append_to_messages",
                arguments: [
                    Argument(name: "messages", value: messages),
                    Argument(name: "run_immediately", value: .boolean(false))
                ]
            ))
            continuation?.yield(.frameAccepted(bytes: frame.data.count))
        } catch {
            // Drop silently; a fresh frame arrives next tick.
        }
    }

    func sendText(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let llmHelper else {
            throw LiveSessionProviderError.adapterUnavailable("Text turns unavailable — LLM helper not registered.")
        }
        // Inject a user turn over the WebRTC data channel and run a response.
        // Mark the floor busy so concurrent frames/context buffer instead of colliding.
        markFloorBusy()
        try await llmHelper.appendToMessages(
            message: LLMContextMessage(role: "user", content: trimmed),
            runImmediately: true
        )
    }

    func sendContext(_ text: String, createResponse: Bool) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let llmHelper else {
            throw LiveSessionProviderError.adapterUnavailable("Context injection unavailable — LLM helper not registered.")
        }
        // Safety Check hard-quiet (#648): a deliberate prompt (createResponse:true —
        // greeting / opening / bridge nudge) would make the model speak unprompted.
        // Downgrade it to context-only so it still conditions the model but does NOT
        // trigger a response. User speech + hazard warnings are the only allowed audio.
        let createResponse = createResponse && !hardQuiet
        // Context-only injections (createResponse:false — background-agent feed,
        // Cocktail Party notices) must NOT happen while a response is active or the
        // Realtime API throws `conversation_already_has_active_response`. Buffer them
        // and flush on onBotStoppedSpeaking. They're injected as a "system" item so
        // they condition the model WITHOUT becoming a pending user turn that VAD
        // would answer. Only a deliberate prompt (createResponse:true) is a user
        // message meant to get a reply; that one is sent immediately.
        if !createResponse {
            func buffer() {
                pendingContextInjections.append(trimmed)
                if pendingContextInjections.count > maxPendingContextInjections {
                    pendingContextInjections.removeFirst(pendingContextInjections.count - maxPendingContextInjections)
                }
            }
            if botSpeaking {
                buffer()
                return
            }
            // Defensive: if a response is active in a race, re-buffer instead of
            // surfacing conversation_already_has_active_response.
            do {
                try await llmHelper.appendToMessages(
                    message: LLMContextMessage(role: "system", content: trimmed),
                    runImmediately: false
                )
            } catch {
                buffer()
            }
            return
        }
        // We're about to trigger a response (e.g. the opening greeting). Mark the
        // floor busy NOW so frames/context that arrive before onBotStartedSpeaking
        // fires get buffered instead of colliding (the startup error burst).
        markFloorBusy()
        try await llmHelper.appendToMessages(
            message: LLMContextMessage(role: "user", content: trimmed),
            runImmediately: true
        )
    }

    /// Mark the response floor busy + arm a watchdog so it can't stick. Any path
    /// that triggers a response (greeting, sendText, VAD turn-end) calls this so
    /// concurrent frames/context buffer instead of colliding.
    private func markFloorBusy() {
        cocktailDebugLog("[cocktail-floor] markFloorBusy (was \(botSpeaking))")
        botSpeaking = true
        floorBusyWatchdog?.cancel()
        floorBusyWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000) // 8s safety
            // Force the floor clear + run the idle path (which prioritizes a pending
            // safety warning) so a buffered hazard can't get stuck if bot-stopped never
            // arrives after an interrupt/cancel.
            await self?.clearFloor()
        }
    }

    /// Clear the floor (assistant idle) + flush buffered context.
    private func clearFloor() async {
        cocktailDebugLog("[cocktail-floor] clearFloor (buffered=\(pendingContextInjections.count))")
        floorBusyWatchdog?.cancel()
        floorBusyWatchdog = nil
        botSpeaking = false
        // Safety Check (#648): a hazard warning takes priority — speak it first (still
        // verbatim), then flush ordinary context. Cleared so it fires at most once.
        if let warning = pendingSafetyWarning {
            pendingSafetyWarning = nil
            await fireSafetyWarning(warning)
            return
        }
        await flushPendingContextInjections()
    }

    /// Flush buffered context-only injections once the assistant is idle. Called
    /// from onBotStoppedSpeaking. Best-effort; failures are dropped.
    private func flushPendingContextInjections() async {
        guard !botSpeaking, let llmHelper, !pendingContextInjections.isEmpty else { return }
        let items = pendingContextInjections
        pendingContextInjections.removeAll()
        for item in items {
            try? await llmHelper.appendToMessages(
                message: LLMContextMessage(role: "system", content: item),
                runImmediately: false
            )
        }
    }

    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {
        // WebRTC surface (ambient intentions). Floor-guarded + never throws the
        // active-response error: if the assistant is busy, buffer for the next idle
        // window; if a response is active in a race, swallow (re-buffer) instead of
        // surfacing conversation_already_has_active_response. (Cocktail recall no
        // longer uses this path — it's silent context now.)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let llmHelper else { return }
        // Safety Check hard-quiet (#648): ambient/bridge asides must NOT speak. Inject
        // the raw fact as silent context (so it still conditions the model) but never
        // trigger a response. Only user speech + hazard warnings make audio.
        let speak = speak && !hardQuiet
        if hardQuiet {
            do {
                try await llmHelper.appendToMessages(
                    message: LLMContextMessage(role: "system", content: trimmed),
                    runImmediately: false
                )
            } catch {
                pendingContextInjections.append(trimmed)
            }
            return
        }
        let prompt = cautious
            ? "Relay this to the user as a brief, hedged aside (don't over-assert): \(trimmed)"
            : "Relay this to the user as a brief, natural aside: \(trimmed)"
        if botSpeaking {
            pendingContextInjections.append(prompt)
            return
        }
        if speak { markFloorBusy() }
        do {
            try await llmHelper.appendToMessages(
                message: LLMContextMessage(role: "user", content: prompt),
                runImmediately: speak
            )
        } catch {
            pendingContextInjections.append(prompt)
        }
    }

    /// Safety Check (#648): speak the hazard warning VERBATIM via a constrained
    /// response.create — no paraphrase, no follow-up advice, no tool calls. A hazard is
    /// higher priority than whatever the model is saying, so if it's mid-response we
    /// INTERRUPT IMMEDIATELY: cancel the active turn and fire the warning right away
    /// (don't wait for the current sentence / onBotStoppedSpeaking — that let the last
    /// response finish playing first). Buffer it first so the rare async active_response
    /// race is still recoverable via clearFloor.
    func speakSafetyWarning(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, transport != nil else { return }
        pendingSafetyWarning = trimmed
        // TOP PRIORITY: a hazard preempts everything. Drop any buffered context/asides
        // so nothing gets injected ahead of the warning, and cancel whatever the model
        // is currently doing so the warning's turn starts immediately.
        pendingContextInjections.removeAll()
        if botSpeaking {
            botSpeaking = false
            try? transport?.sendCancelResponse()
        }
        await fireSafetyWarning(trimmed)
    }

    /// Issue exactly one spoken turn that says `text` and nothing else. Swallows an
    /// active-response race (re-buffers) rather than throwing the active-response error.
    private func fireSafetyWarning(_ text: String) async {
        guard let transport else { return }
        markFloorBusy()
        let responseFields: [String: Value?] = [
            "output_modalities": .array([.string("audio")]),
            "tool_choice": .string("none"),
            // Force verbatim delivery. The Realtime model will narrate `instructions`,
            // so we tell it to speak EXACTLY this line and stop — no added safety tips.
            "instructions": .string(
                "Say exactly this and then stop, adding nothing: \"\(text)\". "
                + "Do not elaborate, do not give extra safety advice, do not ask a question."
            )
        ]
        // This turn IS authorized — don't let the hard-quiet guard cancel it.
        sanctionedTurnCredits += 1
        do {
            try transport.sendCreateResponse(response: .object(responseFields))
            // Sent → consume the buffered copy (avoid a clearFloor duplicate) but track
            // it in-flight so onError can re-arm it on an async active_response rejection.
            if pendingSafetyWarning == text { pendingSafetyWarning = nil }
            lastWarningInFlight = text
        } catch {
            // Local send failed → keep buffered for the next idle window.
            sanctionedTurnCredits = max(0, sanctionedTurnCredits - 1)
            pendingSafetyWarning = text
        }
    }

    // MARK: - LLMHelperDelegate (function calls over WebRTC)

    nonisolated func onLLMFunctionCall(functionCallData: LLMFunctionCallData, onResult: ((Value) async -> Void)) async {
        let name = functionCallData.functionName
        let callID = functionCallData.toolCallID
        cocktailDebugLog("[cocktail-tool] onLLMFunctionCall \(name)")
        // Serialize the args Value back to a JSON string for the tool registry.
        let argsJSON: String
        if let data = try? JSONEncoder().encode(functionCallData.args),
           let str = String(data: data, encoding: .utf8) {
            argsJSON = str
        } else {
            argsJSON = "{}"
        }
        // Emit the same tool-call events as the WebSocket path so the UI shows a
        // tool bubble (started → ok/error) via upsertToolCall.
        let context = await MainActor.run { () -> LiveToolContext in
            self.continuation?.yield(.toolCallStarted(name: name, callID: callID, arguments: argsJSON))
            return self.makeLiveToolContext()
        }
        let resultString = await toolRegistry.execute(name: name, argumentsJSON: argsJSON, context: context)
        await MainActor.run {
            self.continuation?.yield(.toolCallCompleted(name: name, callID: callID, output: resultString))
        }
        // The realtime model expects a JSON result; pass it through as a Value
        // (object if parseable, else a string).
        let resultValue: Value
        if let data = resultString.data(using: .utf8), let decoded = try? JSONDecoder().decode(Value.self, from: data) {
            resultValue = decoded
        } else {
            resultValue = .string(resultString)
        }
        await onResult(resultValue)
    }

    func events() -> AsyncStream<LiveSessionEvent> {
        eventStream
    }

    func close() async {
        startupGuardWaitingForFirstBotStop = false
        pendingAudioInputEnabled = false
        currentAssistantTranscriptItemID = nil
        sessionConfigWatchdog?.cancel()
        sessionConfigWatchdog = nil
        sessionConfigConfirmed = false
        sessionConfigFailed = false
        currentSessionConfigStatus = .notApplicable
        sessionConfigWaiter?.resume(returning: .notApplicable)
        sessionConfigWaiter = nil
        do {
            try await client?.disconnect()
        } catch {
            continuation?.yield(.error(error.localizedDescription))
        }
        client = nil
        transport = nil
        llmHelper = nil
        continuation?.yield(.status("Closed"))
        continuation?.finish()
        continuation = nil
    }

    private static func makeOptions(config: LiveSessionConfig, apiKey: String, micEnabled: Bool) -> RTVIClientOptions {
        let model = Self.resolvedModel(config)
        // Start the session QUIET (create_response:false) ONLY for "Respond only when
        // I talk" (it drives replies manually). Safety Check keeps fast server-VAD
        // auto-response — frames no longer trigger responses (SDK fix), and hardQuiet
        // cancels any stray greeting — so it does NOT pay the manual round-trip latency.
        let autoResponseOverride: Bool? =
            config.speakOnlyWhenSpokenTo ? false : nil
        let sessionConfig = Self.buildSessionConfig(config: config, silent: false, autoResponseOverride: autoResponseOverride)

        let options: [Option] = [
            Option(name: "api_key", value: .string(apiKey)),
            Option(name: "model", value: .string(model)),
            Option(name: "initial_messages", value: .array(Self.initialMessages(config.historyReplayTurns))),
            Option(name: "session_config", value: sessionConfig)
        ]

        return RTVIClientOptions(
            enableMic: micEnabled,
            enableCam: false,
            params: RTVIClientParams(config: [
                ServiceConfig(service: "llm", options: options)
            ])
        )
    }

    private static func resolvedModel(_ config: LiveSessionConfig) -> String {
        let trimmed = config.model.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? LiveProviderKind.openAIRealtime.defaultModel : trimmed
    }

    /// Build the `session` object for a `session.update` / connect-time config.
    /// When `silent` is true (Stay Silent): VAD/transcription stay active but
    /// automatic responses are disabled (create_response/interrupt_response:false),
    /// tool_choice is "none", and the observation-mode prompt is layered on. Reused
    /// at connect time (silent:false) and for the live toggle.
    /// - silent: Stay Silent — observation prompt + tool_choice:none + no auto-response.
    /// - autoResponseOverride: when non-nil, force create_response/interrupt_response
    ///   to this value WITHOUT the silence prompt/tool changes. Used by visual-quiet
    ///   mode: while the camera streams we set false so frames/context don't trigger
    ///   overlapping responses (conversation_already_has_active_response), but the
    ///   normal persona + tools stay and the model still answers committed speech turns.
    static func buildSessionConfig(config: LiveSessionConfig, silent: Bool, autoResponseOverride: Bool? = nil) -> Value {
        let model = Self.resolvedModel(config)
        let voice = config.realtimeVoice.rawValue
        let autoResponse = autoResponseOverride ?? (silent ? false : config.vadCreateResponse)
        let createResponse = autoResponse
        let interruptResponse = silent ? false : (autoResponseOverride == false ? false : config.vadInterruptResponse)

        let turnDetection: Value?
        switch config.turnDetectionMode {
        case .manual:
            turnDetection = nil
        case .serverVAD:
            turnDetection = .object([
                "type": .string("server_vad"),
                "threshold": .number(config.vadThreshold),
                // #668: these are integer-only fields in the OpenAI Realtime API.
                // Pipecat's Value has only .number(Double); a non-whole Double (e.g.
                // slider drift 499.999) serializes as a DECIMAL, which OpenAI rejects
                // with invalid_type — taking down the whole session.update, including
                // the transcription config, so user speech never gets transcribed.
                // Round to a whole Double so JSONEncoder emits "500", not "500.0001".
                "prefix_padding_ms": .number(config.vadPrefixPaddingMs.rounded()),
                "silence_duration_ms": .number(config.vadSilenceDurationMs.rounded()),
                "create_response": .boolean(createResponse),
                "interrupt_response": .boolean(interruptResponse)
            ])
        case .semanticVAD:
            turnDetection = .object([
                "type": .string("semantic_vad"),
                "eagerness": .string(config.semanticVADEagerness.rawValue),
                "create_response": .boolean(createResponse),
                "interrupt_response": .boolean(interruptResponse)
            ])
        }
        var inputAudioConfig: [String: Value?] = [
            "turn_detection": turnDetection,
            "noise_reduction": Self.pipecatNoiseReductionPayload(config: config)
        ]
        if config.inputTranscriptionEnabled {
            let transcriptionModel = config.inputTranscriptionModel.trimmingCharacters(in: .whitespacesAndNewlines)
            inputAudioConfig["transcription"] = .object([
                "model": .string(transcriptionModel.isEmpty ? "gpt-4o-mini-transcribe" : transcriptionModel)
            ])
        }

        let instructions = silent
            ? LiveSessionConfig.instructionsForSilence(config.resolvedInstructions)
            : config.resolvedInstructions

        var sessionConfig: [String: Value?] = [
            "type": .string("realtime"),
            "model": .string(model),
            "instructions": .string(instructions),
            "output_modalities": .array([.string("audio")]),
            "tool_choice": .string(silent ? "none" : "auto"),
            "audio": .object([
                "input": .object(inputAudioConfig),
                "output": .object([
                    "voice": .string(voice)
                ])
            ])
        ]
        // Hand the realtime model its tools (session_send_message, summarize_session,
        // etc.) so it can actually call them — without this the WebRTC session has
        // instructions but no tools, so the model can only chat. Gated on the
        // Local tools toggle, mirroring the WebSocket provider.
        if config.toolsEnabled {
            let toolValues = Self.toolDefinitionValues(config: config)
            if !toolValues.isEmpty {
                sessionConfig["tools"] = .array(toolValues)
            }
        }
        return .object(sessionConfig)
    }

    // MARK: - Stay Silent (live session.update over the data channel)

    func setSilenceMode(_ silent: Bool, config: LiveSessionConfig) async throws {
        currentConfig = config
        guard let transport else {
            throw LiveSessionProviderError.adapterUnavailable("Stay Silent unavailable — realtime transport not connected.")
        }
        // #671: track silent state locally so the manual response.create path
        // (onUserStoppedSpeaking) is suppressed and stray server turns are canceled.
        // Set BEFORE sending the update so any in-flight user-stop can't slip a turn
        // through; cleared here when releasing so the recap turn that follows is allowed.
        silentModeActive = silent
        let session = Self.buildSessionConfig(config: config, silent: silent)
        try transport.sendSessionUpdate(session: session)
        continuation?.yield(.status(silent ? "Stay Silent on" : "Stay Silent off"))
    }

    func setVisualQuietMode(_ quiet: Bool, config: LiveSessionConfig) async throws {
        currentConfig = config
        guard let transport else { return }
        // quiet=true → create_response/interrupt_response:false so frames/ambient noise
        // can't trigger responses. But with auto-response off the model won't reply to
        // your speech either — so we set manualResponseMode and explicitly fire
        // response.create when the USER finishes a turn (onUserStoppedSpeaking). That's
        // the "respond only when I talk" behavior. quiet=false restores VAD auto-response.
        manualResponseMode = quiet
        let session = Self.buildSessionConfig(config: config, silent: false, autoResponseOverride: quiet ? false : nil)
        try transport.sendSessionUpdate(session: session)
        continuation?.yield(.status(quiet ? "Respond-only-when-spoken-to on" : "Respond-only-when-spoken-to off"))
    }

    func setBridgeAvailability(_ availability: LiveBridgeAvailability, config: LiveSessionConfig) async throws {
        var updatedConfig = config
        updatedConfig.bridgeAvailability = availability
        currentConfig = updatedConfig
        guard let transport else { return }
        let autoResponseOverride = manualResponseMode ? false : nil
        let session = Self.buildSessionConfig(
            config: updatedConfig,
            silent: silentModeActive,
            autoResponseOverride: autoResponseOverride
        )
        try transport.sendSessionUpdate(session: session)
        continuation?.yield(.status("Hawky bridge tools \(availability.toolsAvailable ? "available" : "unavailable")"))
    }

    func setHardQuiet(_ on: Bool) async {
        // Suppress every unprompted-speech path (greeting, bridge asides/intentions,
        // openings). Combined with manualResponseMode (set via setVisualQuietMode), the
        // model then speaks ONLY on the user's own speech turn + verbatim hazard warnings.
        hardQuiet = on
        continuation?.yield(.status(on ? "Safety Check quiet on" : "Safety Check quiet off"))
    }

    func requestSilenceReleaseSummary(prompt: String) async throws {
        guard let transport else {
            throw LiveSessionProviderError.adapterUnavailable("Stay Silent summary unavailable — realtime transport not connected.")
        }
        // Inject a short trigger note (no response), then FORCE exactly one recap
        // turn. When tools are enabled the model MUST call summarize_silence — the
        // tool returns the captured window (via the store hook), so the recap goes
        // through a real, VISIBLE tool call (bubble), then the model speaks it. When
        // tools are off, fall back to a plain spoken recap from the inline note.
        try transport.sendUserContext(text: prompt)
        var responseFields: [String: Value?] = [
            "output_modalities": .array([.string("audio")]),
            "instructions": .string("Call summarize_silence once, then give a natural one-sentence-to-paragraph recap of what we just discussed. Lead with the key point, mention follow-ups if any, and skip technical details.")
        ]
        if currentConfig.toolsEnabled {
            responseFields["tool_choice"] = .object([
                "type": .string("function"),
                "name": .string("summarize_silence")
            ])
        } else {
            responseFields["tool_choice"] = .string("none")
        }
        // #671: this recap turn IS authorized — make sure the onBotStartedSpeaking
        // guard doesn't cancel it. setSilenceMode(false) already cleared
        // silentModeActive, but that guard ALSO fires on hardQuiet (Safety Check), an
        // independent flag the release path doesn't touch. Without a credit, releasing
        // Stay Silent while Safety Check is on would cancel the recap and the user would
        // hear nothing. Mirrors fireSafetyWarning.
        //
        // Only grant the credit when a gate is actually active. The guard consumes a
        // credit ONLY inside `if hardQuiet || silentModeActive`, so granting one when
        // neither is set would leak an uncounted credit that could later authorize an
        // unprompted turn if Safety Check is enabled mid-session.
        let recapNeedsCredit = hardQuiet || silentModeActive
        if recapNeedsCredit { sanctionedTurnCredits += 1 }
        do {
            try transport.sendCreateResponse(response: .object(responseFields))
        } catch {
            // Send failed → no turn will start, so reclaim the credit (don't leak a
            // free pass to a future unprompted turn under hard-quiet).
            if recapNeedsCredit { sanctionedTurnCredits = max(0, sanctionedTurnCredits - 1) }
            throw error
        }
    }


    private static func pipecatNoiseReductionPayload(config: LiveSessionConfig) -> Value? {
        switch config.noiseReduction {
        case .none:
            return nil
        case .nearField, .farField:
            return .object(["type": .string(config.noiseReduction.rawValue)])
        }
    }

    /// Convert the frontend tool registry's OpenAI-format definitions
    /// ([[String: Any]]) into Pipecat `Value`s for the realtime session config.
    /// Goes through JSON so the dynamic dicts decode into the Codable `Value`.
    private static func toolDefinitionValues(config: LiveSessionConfig) -> [Value] {
        let defs = LiveToolRegistry.default.definitions(config: config)
        guard !defs.isEmpty else { return [] }
        do {
            let data = try JSONSerialization.data(withJSONObject: defs)
            return try JSONDecoder().decode([Value].self, from: data)
        } catch {
            NSLog("[LiveSessionProvider] failed to encode tool definitions: \(error)")
            return []
        }
    }

    private static func initialMessages(_ turns: [LiveHistoryTurn]) -> [Value] {
        turns.compactMap { turn in
            let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return .object([
                "role": .string(turn.role == .user ? "user" : "assistant"),
                "content": .string(text)
            ])
        }
    }

    nonisolated func onTransportStateChanged(state: TransportState) {
        Task { @MainActor in continuation?.yield(.status("WebRTC: \(state.description)")) }
    }

    nonisolated func onConnected() {
        Task { @MainActor in continuation?.yield(.status("WebRTC connected")) }
    }

    nonisolated func onDisconnected() {
        Task { @MainActor in continuation?.yield(.status("WebRTC disconnected")) }
    }

    nonisolated func onBotReady(botReadyData: BotReadyData) {
        Task { @MainActor in continuation?.yield(.status("WebRTC bot ready")) }
    }

    nonisolated func onUserStartedSpeaking() {
        Task { @MainActor in
            continuation?.yield(.raw(direction: .received, type: "input_audio_buffer.speech_started", json: "{}"))
        }
    }

    nonisolated func onUserStoppedSpeaking() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let wasBusy = self.botSpeaking
            // The user's turn just ended → a response is about to start. Mark the floor
            // busy NOW so frames/context appended in this gap are buffered, not collided
            // (conversation_already_has_active_response). Cleared on bot-stopped.
            self.markFloorBusy()
            // #671: in Stay Silent the model must NOT reply to the user's turn. Do NOT
            // grant a sanctioned credit (so onBotStartedSpeaking cancels any stray turn)
            // and do NOT fire the manual response.create below. We still mark the floor
            // and emit the speech_stopped signal so transcription/UI stay correct.
            if !self.silentModeActive {
                // The user spoke → the model's reply turn is AUTHORIZED. Grant a hard-quiet
                // credit so the response that follows (whether server-VAD auto-fires it, or
                // we trigger it manually below) is NOT canceled as an unprompted turn.
                self.sanctionedTurnCredits += 1
                // "Respond only when I talk": auto-response is off, so explicitly trigger
                // the reply now that the user finished — but only if no response is already
                // running (avoid an overlapping response.create). With auto-response ON
                // (Safety Check), the server fires it itself; we just granted the credit.
                if self.manualResponseMode, !wasBusy {
                    try? self.transport?.sendCreateResponse()
                }
            }
            continuation?.yield(.raw(direction: .received, type: "input_audio_buffer.speech_stopped", json: "{}"))
            if !currentConfig.inputTranscriptionEnabled {
                continuation?.yield(.inputTranscriptComplete(
                    itemID: "webrtc_voice_\(UUID().uuidString)",
                    text: "",
                    detail: nil,
                    eventType: "input_audio_buffer.speech_stopped"
                ))
            }
        }
    }

    nonisolated func onBotStartedSpeaking(participant: Participant) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Suppress unprompted model turns under either gate:
            //  - Safety Check hard-quiet (#648): only user replies + verbatim hazard
            //    warnings are allowed; greetings/narration are canceled.
            //  - Stay Silent (#671): NO conversational replies; only a sanctioned turn
            //    (today: a verbatim hazard warning, which fireSafetyWarning grants) may
            //    speak — so safety overrides silence, but ordinary conversation does not.
            // A turn is authorized iff it carries a sanctioned credit. One credit per
            // turn, so this check runs ONCE even when both gates are active (a double
            // decrement would wrongly cancel an authorized hazard warning).
            if self.hardQuiet || self.silentModeActive {
                if self.sanctionedTurnCredits > 0 {
                    self.sanctionedTurnCredits -= 1
                } else {
                    try? self.transport?.sendCancelResponse()
                    let reason = self.silentModeActive ? "Stay Silent" : "Safety quiet"
                    self.continuation?.yield(.status("\(reason): canceled unprompted turn"))
                    return
                }
            }
            // A turn actually started → the in-flight warning (if any) is being spoken;
            // stop tracking it so a later error doesn't wrongly re-arm it.
            self.lastWarningInFlight = nil
            markFloorBusy()
            currentAssistantTranscriptItemID = "webrtc_assistant_\(UUID().uuidString)"
            continuation?.yield(.status("Assistant speaking"))
            guard pendingAudioInputEnabled, let client else { return }
            startupGuardWaitingForFirstBotStop = true
            do {
                try await client.enableMic(enable: false)
                continuation?.yield(.status("Mic muted while assistant speaks"))
            } catch {
                continuation?.yield(.error(error.localizedDescription))
            }
        }
    }

    nonisolated func onBotStoppedSpeaking(participant: Participant) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await clearFloor()
            continuation?.yield(.status("Assistant stopped speaking"))
            if currentConfig.outputTranscriptionEnabled,
               let itemID = currentAssistantTranscriptItemID {
                continuation?.yield(.textComplete(
                    itemID: itemID,
                    phase: nil,
                    text: "",
                    detail: nil,
                    eventType: "webrtc.bot_speech_stopped"
                ))
            }
            await releaseStartupGuardIfNeeded()
        }
    }

    nonisolated func onBotTranscript(data: String) {
        Task { @MainActor in
            guard currentConfig.outputTranscriptionEnabled else { return }
            let itemID = currentAssistantTranscriptItemID ?? "webrtc_assistant_\(UUID().uuidString)"
            currentAssistantTranscriptItemID = itemID
            continuation?.yield(.textComplete(
                itemID: itemID,
                phase: nil,
                text: data,
                detail: nil,
                eventType: "webrtc.bot_transcript"
            ))
            currentAssistantTranscriptItemID = nil
        }
    }

    nonisolated func onBotTTSText(data: BotTTSText) {
        Task { @MainActor in
            guard currentConfig.outputTranscriptionEnabled else { return }
            let itemID = currentAssistantTranscriptItemID ?? "webrtc_assistant_\(UUID().uuidString)"
            currentAssistantTranscriptItemID = itemID
            continuation?.yield(.textDelta(
                itemID: itemID,
                phase: nil,
                text: data.text,
                detail: nil,
                eventType: "webrtc.bot_tts_text"
            ))
        }
    }

    nonisolated func onUserTranscript(data: Transcript) {
        Task { @MainActor in
            guard currentConfig.inputTranscriptionEnabled else { return }
            continuation?.yield(.inputTranscriptComplete(
                itemID: "webrtc_user_\(UUID().uuidString)",
                text: data.text,
                detail: nil,
                eventType: "webrtc.user_transcript"
            ))
        }
    }

    nonisolated func onError(message: String) {
        let tag = message.contains("active_response") ? "ACTIVE-RESPONSE" : "other"
        cocktailDebugLog("[cocktail-err] onError(\(tag)): \(message.prefix(90))")
        Task { @MainActor [weak self] in
            guard let self else { return }
            // #677: the vendored transport forwards a swallowed session.update /
            // initial_messages send failure with this marker. It means the WebRTC media
            // leg connected but the persona/tools/VAD/transcription config did NOT apply
            // — surface it as a config failure (not a generic error) so the store can
            // stop reporting a clean Connected.
            if message.hasPrefix("session_config_failed:") {
                self.sessionConfigConfirmed = false
                self.sessionConfigFailed = true
                let detail = String(message.dropFirst("session_config_failed:".count))
                    .trimmingCharacters(in: .whitespaces)
                self.finishSessionConfigStatus(.failed(detail: detail.isEmpty ? nil : detail))
                return
            }
            // If a safety warning's immediate create lost the race to a still-active
            // response (the error arrives async, after fireSafetyWarning already sent),
            // re-arm it so clearFloor delivers it on the next response.done.
            if message.contains("active_response"), let last = self.lastWarningInFlight {
                self.pendingSafetyWarning = last
            }
            self.continuation?.yield(.error(message))
        }
    }

    /// #677: every OpenAI data-channel message is forwarded by the transport as a
    /// SERVER_MESSAGE → here. We only care about `session.updated` — the server's ack
    /// that our session.update was applied — which confirms persona/tools/VAD are live.
    /// The cheap type check runs in the nonisolated context so we only hop to the main
    /// actor for the one event we care about (this fires for ALL server messages).
    nonisolated func onServerMessage(data: Value) {
        guard case .object(let dict) = data,
              case .string(let type)? = dict["type"],
              type == "session.updated" else { return }
        Task { @MainActor [weak self] in
            self?.markSessionConfigConfirmed()
        }
    }

    private func releaseStartupGuardIfNeeded() async {
        guard startupGuardWaitingForFirstBotStop, let client else { return }
        startupGuardWaitingForFirstBotStop = false
        do {
            try await client.enableMic(enable: pendingAudioInputEnabled)
            continuation?.yield(.status(pendingAudioInputEnabled ? "WebRTC startup guard released" : "Audio input off"))
        } catch {
            continuation?.yield(.error(error.localizedDescription))
        }
    }
}

final class OpenAIRealtimeLiveSessionProvider: NSObject, LiveSessionProvider {
    private var continuation: AsyncStream<LiveSessionEvent>.Continuation?
    private lazy var eventStream: AsyncStream<LiveSessionEvent> = AsyncStream { continuation in
        self.continuation = continuation
    }
    private var webSocket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    /// Set while the session is tearing down. Trailing sends that race with
    /// close() (e.g. the final silence/commit) would otherwise hit a nil socket
    /// and surface a spurious "socket is not connected" error after a session
    /// that worked fine. When closing, such sends are silently ignored.
    private var isClosing = false
    private var currentConfig = LiveSessionConfig()
    private var functionCallArgumentsByCallID: [String: String] = [:]
    // Each Realtime output item's phase ("commentary" vs "final_answer"), used
    // to tag transcript events so the UI can tint the two kinds of bubble
    // differently. Both are shown — audio plays both, so the text must match.
    private var phaseByItemID: [String: String] = [:]
    private let toolRegistry = LiveToolRegistry.default
    private let gatewayBridge: LiveGatewayBridge?
    /// Hook set by LiveSessionStore so tool execution can await the in-flight
    /// transcript append before running scan_intention (Fix: scan race M10 §3.1).
    var awaitPendingTranscriptAppend: (() async -> Void)?
    /// Hook set by LiveSessionStore so the summarize_session tool can run
    /// LiveSessionSummarizer (which needs the store + gateway container).
    var summarizeHook: ((String) async throws -> String)?
    /// Hook set by LiveSessionStore so summarize_silence returns the captured window.
    var silenceSummaryHook: (() async -> String)?
    /// Hook set by LiveSessionStore; true while Cocktail Party Mode is active.
    var cocktailPartyActiveHook: (@MainActor () -> Bool)?
    /// Hook set by LiveSessionStore; identifies whoever is on camera now.
    var identifyOnCameraHook: (@MainActor () async -> FaceIdentifyResult)?
    /// Hook set by LiveSessionStore; resolve+enroll the camera person for a write.
    var resolveCameraPersonHook: (@MainActor (String?) async -> FaceIdentifyResult)?

    /// Build the tool-execution context from the provider's current config + hooks.
    private func makeLiveToolContext() -> LiveToolContext {
        LiveToolContext(
            config: currentConfig,
            gatewayBridge: gatewayBridge,
            awaitPendingTranscriptAppend: awaitPendingTranscriptAppend,
            summarize: summarizeHook,
            silenceSummary: silenceSummaryHook,
            cocktailPartyActive: cocktailPartyActiveHook?() ?? false,
            identifyOnCamera: identifyOnCameraHook,
            resolveCameraPerson: resolveCameraPersonHook
        )
    }

    // Floor-guard state (§5) — pure state machine
    private var floorGuard = SurfaceStateMachine()

    init(gatewayBridge: LiveGatewayBridge? = nil) {
        self.gatewayBridge = gatewayBridge
        super.init()
    }

    func connect(config: LiveSessionConfig) async throws {
        isClosing = false
        currentConfig = config
        continuation?.yield(.status(secretRequestStatus(for: config)))
        let secret: OpenAIRealtimeBrokerResponse
        switch config.openAICredentialMode {
        case .gatewayBroker:
            let brokerURL = try makeBrokerURL(from: config.sessionBrokerURL)
            secret = try await requestBrokerClientSecret(config: config, brokerURL: brokerURL)
        case .directAPIKey:
            secret = try await requestDirectClientSecret(config: config)
        }
        let token = try secret.clientSecretValue()
        let socketURL = secret.websocketURL ?? URL(
            string: "wss://api.openai.com/v1/realtime?model=\(Self.urlEncoded(secret.resolvedModel(default: config.model)))"
        )
        guard let socketURL else {
            throw LiveSessionProviderError.invalidConfig("OpenAI Realtime broker did not return a WebSocket URL")
        }

        var request = URLRequest(url: socketURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        webSocket = task
        task.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
        continuation?.yield(.status("Connected to \(secret.resolvedModel(default: config.model))"))
        try await sendJSON([
            "type": "session.update",
            "session": Self.sessionUpdatePayload(config: config),
        ])
    }

    func setBridgeAvailability(_ availability: LiveBridgeAvailability, config: LiveSessionConfig) async throws {
        var updatedConfig = config
        updatedConfig.bridgeAvailability = availability
        currentConfig = updatedConfig
        try await sendJSON([
            "type": "session.update",
            "session": Self.sessionUpdatePayload(config: updatedConfig),
        ])
        continuation?.yield(.status("Hawky bridge tools \(availability.toolsAvailable ? "available" : "unavailable")"))
    }

    private static func sessionUpdatePayload(config: LiveSessionConfig) -> [String: Any] {
        let modality = config.responseModality.rawValue
        var payload: [String: Any] = [
            "type": "realtime",
            "output_modalities": [modality],
            "instructions": config.resolvedInstructions,
            "reasoning": ["effort": config.reasoningEffort.rawValue],
            "max_response_output_tokens": maxResponseOutputTokensPayload(config: config),
            "parallel_tool_calls": config.parallelToolCallsEnabled,
            "audio": [
                "input": [
                    "format": [
                        "type": "audio/pcm",
                        "rate": 24_000,
                    ],
                    "transcription": inputTranscriptionPayload(config: config),
                    "noise_reduction": noiseReductionPayload(config: config),
                    "turn_detection": turnDetectionPayload(config: config),
                ],
                "output": [
                    "format": [
                        "type": "audio/pcm",
                        "rate": 24_000,
                    ],
                    "voice": config.realtimeVoice.rawValue,
                ],
            ],
        ]
        if config.toolsEnabled {
            payload["tools"] = LiveToolRegistry.default.definitions(config: config)
            payload["tool_choice"] = config.toolChoice.rawValue
        } else {
            payload["tool_choice"] = LiveToolChoice.none.rawValue
        }
        return payload
    }

    private static func responsePayload(config: LiveSessionConfig) -> [String: Any] {
        return [
            "output_modalities": [config.responseModality.rawValue],
        ]
    }

    private static func inputTranscriptionPayload(config: LiveSessionConfig) -> Any {
        guard config.inputTranscriptionEnabled else { return NSNull() }
        let model = config.inputTranscriptionModel.trimmingCharacters(in: .whitespacesAndNewlines)
        return [
            "model": model.isEmpty ? "gpt-4o-mini-transcribe" : model,
        ]
    }

    private static func maxResponseOutputTokensPayload(config: LiveSessionConfig) -> Any {
        guard let tokens = config.maxResponseOutputTokens else { return "inf" }
        return min(max(tokens, 1), 4_096)
    }

    private static func noiseReductionPayload(config: LiveSessionConfig) -> Any {
        switch config.noiseReduction {
        case .none:
            return NSNull()
        case .nearField, .farField:
            return ["type": config.noiseReduction.rawValue]
        }
    }

    private static func turnDetectionPayload(config: LiveSessionConfig) -> Any {
        switch config.turnDetectionMode {
        case .manual:
            return NSNull()
        case .serverVAD:
            var payload: [String: Any] = [
                "type": "server_vad",
                "threshold": config.vadThreshold,
                "prefix_padding_ms": Int(config.vadPrefixPaddingMs.rounded()),
                "silence_duration_ms": Int(config.vadSilenceDurationMs.rounded()),
                "create_response": config.vadCreateResponse,
                "interrupt_response": config.vadInterruptResponse,
            ]
            if config.vadIdleTimeoutEnabled {
                payload["idle_timeout_ms"] = Int(config.vadIdleTimeoutMs.rounded())
            }
            return payload
        case .semanticVAD:
            return [
                "type": "semantic_vad",
                "eagerness": config.semanticVADEagerness.rawValue,
                "create_response": config.vadCreateResponse,
                "interrupt_response": config.vadInterruptResponse,
            ]
        }
    }

    func sendAudio(_ chunk: LiveAudioChunk) async throws {
        let base64 = chunk.data.base64EncodedString()
        try await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    [
                        "type": "input_audio",
                        "audio": base64,
                    ],
                ],
            ],
        ])
        continuation?.yield(.audioAccepted(bytes: chunk.data.count))
        try await sendJSON([
            "type": "response.create",
            "response": Self.responsePayload(config: currentConfig),
        ])
    }

    func streamAudio(_ chunk: LiveAudioChunk) async throws {
        try await sendJSON([
            "type": "input_audio_buffer.append",
            "audio": chunk.data.base64EncodedString(),
        ], logRaw: false)
        continuation?.yield(.audioAccepted(bytes: chunk.data.count))
    }

    func commitAudioStream() async throws {
        try await sendJSON(["type": "input_audio_buffer.commit"])
        try await sendJSON([
            "type": "response.create",
            "response": Self.responsePayload(config: currentConfig),
        ])
    }

    func sendFrame(_ frame: LiveJPEGFrame) async throws {
        let base64 = frame.data.base64EncodedString()
        try await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    [
                        "type": "input_image",
                        "image_url": "data:image/jpeg;base64,\(base64)",
                    ],
                ],
            ],
        ])
        continuation?.yield(.frameAccepted(bytes: frame.data.count))
    }

    func sendText(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    [
                        "type": "input_text",
                        "text": trimmed,
                    ],
                ],
            ],
        ])
        try await sendJSON([
            "type": "response.create",
            "response": Self.responsePayload(config: currentConfig),
        ])
    }

    func sendContext(_ text: String, createResponse: Bool) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    [
                        "type": "input_text",
                        "text": trimmed,
                    ],
                ],
            ],
        ])
        if createResponse {
            try await sendJSON([
                "type": "response.create",
                "response": Self.responsePayload(config: currentConfig),
            ])
        }
    }

    func seedHistory(_ turns: [LiveHistoryTurn]) async throws {
        for turn in turns {
            let trimmed = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            // User turns use input_text; assistant turns use output_text so the
            // model treats them as its own prior replies. No response.create —
            // we only rebuild the conversation, we don't trigger a new answer.
            let role = turn.role == .user ? "user" : "assistant"
            let contentType = turn.role == .user ? "input_text" : "output_text"
            try await sendJSON([
                "type": "conversation.item.create",
                "item": [
                    "type": "message",
                    "role": role,
                    "content": [
                        [
                            "type": contentType,
                            "text": trimmed,
                        ],
                    ],
                ],
            ])
        }
    }

    /// Inject a surface background message with floor-guard semantics (§5).
    /// Always adds a role:"user" conversation item with "Surface: " prefix.
    /// If !speak, returns after the item.create (voiceStatus: context).
    /// If speak and floor is free, fires response.create.
    /// If speak and floor is busy, applies whenBusy strategy.
    /// `intentionId` is forwarded from the delivery chain so the model can call intention_respond.
    /// `cautious` is forwarded from the delivery chain; prompt rendering uses it in LiveModels.
    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // cautious=true → hedged framing so the model phrases it as a
        // question rather than a definitive assertion.
        // Include intentionId so the model can call intention_respond.
        let idTag = intentionId.map { " [intention_id:\($0)]" } ?? ""
        let prefixed = cautious
            ? "Gently suggest (ask, don't assert)\(idTag): \(trimmed)"
            : "Surface\(idTag): \(trimmed)"

        // Step 1: Always add context item (role:"user" — only documented role for message items)
        try await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [
                    [
                        "type": "input_text",
                        "text": prefixed,
                    ],
                ],
            ],
        ])

        // Step 2: Consult the pure floor-guard state machine
        let action = floorGuard.floorAction(
            speak: speak,
            floorFree: !floorGuard.responseActive,
            whenBusy: whenBusy,
            text: prefixed
        )

        switch action {
        case .contextOnly:
            break // item already added; no response.create

        case .speakNow:
            try await sendJSON([
                "type": "response.create",
                "response": Self.responsePayload(config: currentConfig),
            ])

        case .cancelThenSpeak:
            try await sendJSON(["type": "response.cancel"])
            if let itemId = floorGuard.currentAssistantItemId {
                try await sendJSON([
                    "type": "conversation.item.truncate",
                    "item_id": itemId,
                    "content_index": 0,
                    "audio_end_ms": floorGuard.playedMs,
                ])
            }
            try await sendJSON([
                "type": "response.create",
                "response": Self.responsePayload(config: currentConfig),
            ])

        case .enqueue:
            break // item is now in floorGuard.queuedSurface; drained on response.done
        }
    }

    /// Drain the surface queue on response.done (called from handle()).
    /// Dequeues exactly one surviving item per response gap; the rest remain
    /// in the queue and are drained on the next response.done.
    private func drainSurfaceQueue() {
        guard let next = floorGuard.markResponseDone(), !floorGuard.responseActive else { return }
        Task { [weak self] in
            guard let self else { return }
            guard !self.floorGuard.responseActive else { return }
            do {
                try await self.sendJSON([
                    "type": "response.create",
                    "response": Self.responsePayload(config: self.currentConfig),
                ])
            } catch {
                // best effort; don't crash the session
            }
            _ = next // item text available here for context injection if needed
        }
    }

    func events() -> AsyncStream<LiveSessionEvent> {
        eventStream
    }

    func close() async {
        isClosing = true
        receiveTask?.cancel()
        receiveTask = nil
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        functionCallArgumentsByCallID.removeAll()
        phaseByItemID.removeAll()
        continuation?.yield(.status("Closed"))
        continuation?.finish()
        continuation = nil
    }

    private func requestBrokerClientSecret(config: LiveSessionConfig, brokerURL: URL) async throws -> OpenAIRealtimeBrokerResponse {
        var request = URLRequest(url: brokerURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // Attach device token as Bearer auth, mirroring the WebSocket connect
        // params.token flow. Token is keyed to the gateway base URL (origin only).
        if let gatewayBase = brokerOriginURL(from: brokerURL),
           let token = (try? KeychainStore.load(for: gatewayBase)) ?? nil,
           !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": config.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? LiveProviderKind.openAIRealtime.defaultModel
                : config.model,
            "reasoning_effort": config.reasoningEffort.rawValue,
            "max_response_output_tokens": Self.maxResponseOutputTokensPayload(config: config),
            "tool_choice": config.toolsEnabled ? config.toolChoice.rawValue : LiveToolChoice.none.rawValue,
            "parallel_tool_calls": config.parallelToolCallsEnabled,
            "expires_after_seconds": 600,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw LiveSessionProviderError.invalidConfig("OpenAI Realtime broker returned a non-HTTP response")
        }
        let decoded = try JSONDecoder().decode(OpenAIRealtimeBrokerResponse.self, from: data)
        guard (200..<300).contains(http.statusCode), decoded.isOK else {
            throw LiveSessionProviderError.invalidConfig(decoded.error ?? "OpenAI Realtime broker failed with HTTP \(http.statusCode)")
        }
        return decoded
    }

    private func requestDirectClientSecret(config: LiveSessionConfig) async throws -> OpenAIRealtimeBrokerResponse {
        guard let apiKey = try KeychainStore.loadOpenAIAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !apiKey.isEmpty else {
            throw LiveSessionProviderError.invalidConfig("Direct OpenAI key is not saved on this iPhone")
        }

        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/realtime/client_secrets")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("hawky-ios-live-direct", forHTTPHeaderField: "OpenAI-Safety-Identifier")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "session": [
                "type": "realtime",
                "model": config.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? LiveProviderKind.openAIRealtime.defaultModel
                    : config.model,
                "instructions": config.resolvedInstructions,
                "reasoning": ["effort": config.reasoningEffort.rawValue],
                "max_response_output_tokens": Self.maxResponseOutputTokensPayload(config: config),
                "parallel_tool_calls": config.parallelToolCallsEnabled,
                "audio": [
                    "output": [
                        "voice": config.realtimeVoice.rawValue,
                    ],
                ],
            ],
            "expires_after": [
                "anchor": "created_at",
                "seconds": 600,
            ],
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw LiveSessionProviderError.invalidConfig("OpenAI returned a non-HTTP response")
        }
        let decoded = try JSONDecoder().decode(OpenAIRealtimeBrokerResponse.self, from: data)
        guard (200..<300).contains(http.statusCode) else {
            throw LiveSessionProviderError.invalidConfig(decoded.error ?? "OpenAI direct client secret failed with HTTP \(http.statusCode)")
        }
        return decoded
    }

    private func secretRequestStatus(for config: LiveSessionConfig) -> String {
        switch config.openAICredentialMode {
        case .gatewayBroker:
            return "Requesting OpenAI Realtime client secret from gateway"
        case .directAPIKey:
            return "Requesting OpenAI Realtime client secret directly"
        }
    }

    private func makeBrokerURL(from raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else {
            throw LiveSessionProviderError.invalidConfig("Session broker URL is required")
        }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/api/live/openai/client-secret"
        }
        guard let url = components.url else {
            throw LiveSessionProviderError.invalidConfig("Session broker URL is invalid")
        }
        return url
    }

    /// Returns scheme+host+port of a broker URL — the gateway base URL used as
    /// the KeychainStore key for the device token.
    private func brokerOriginURL(from brokerURL: URL) -> URL? {
        var comps = URLComponents(url: brokerURL, resolvingAgainstBaseURL: false)
        comps?.path = ""
        comps?.query = nil
        comps?.fragment = nil
        return comps?.url
    }

    private func sendJSON(_ object: [String: Any], logRaw: Bool = true) async throws {
        guard let webSocket else {
            // A trailing send racing with teardown — ignore quietly so the user
            // doesn't see a "not connected" error after a session that worked.
            if isClosing { return }
            throw LiveSessionProviderError.invalidConfig("OpenAI Realtime socket is not connected")
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else {
            throw LiveSessionProviderError.invalidConfig("Could not encode Realtime event")
        }
        let eventType = (object["type"] as? String) ?? "unknown"
        if logRaw {
            continuation?.yield(.raw(direction: .sent, type: eventType, json: Self.prettyJSONString(from: data) ?? text))
        }
        try await send(text, on: webSocket)
    }

    private func receiveLoop() async {
        while !Task.isCancelled, let webSocket {
            do {
                let message = try await receive(on: webSocket)
                handle(message)
            } catch {
                if !Task.isCancelled {
                    continuation?.yield(.error(error.localizedDescription))
                }
                return
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String?
        switch message {
        case .string(let value):
            text = value
        case .data(let data):
            text = String(data: data, encoding: .utf8)
        @unknown default:
            text = nil
        }
        guard let text,
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            return
        }
        let prettyJSON = Self.prettyJSONString(redactingAudioDeltaFrom: object) ?? Self.prettyJSONString(from: data) ?? text
        continuation?.yield(.raw(direction: .received, type: type, json: prettyJSON))

        switch type {
        case "session.created", "session.updated":
            continuation?.yield(.status(type))
        case "response.output_item.added":
            // Capture each output item's phase (transcript tagging) AND mark the
            // current assistant item id for the floor-guard truncation (§5).
            // These were two duplicate `case` labels — the second was unreachable,
            // so the floor-guard never saw the item id. Merged into one.
            if let item = object["item"] as? [String: Any],
               let itemID = item["id"] as? String {
                if let phase = item["phase"] as? String {
                    phaseByItemID[itemID] = phase
                }
                floorGuard.markOutputItemAdded(itemId: itemID)
            }
        case "conversation.item.input_audio_transcription.delta":
            if let itemID = object["item_id"] as? String,
               let delta = object["delta"] as? String,
               !delta.isEmpty {
                continuation?.yield(.inputTranscriptDelta(itemID: itemID, text: delta, detail: prettyJSON, eventType: type))
            }
        case "conversation.item.input_audio_transcription.completed":
            if let itemID = object["item_id"] as? String,
               let transcript = object["transcript"] as? String {
                continuation?.yield(.inputTranscriptComplete(itemID: itemID, text: transcript, detail: prettyJSON, eventType: type))
            }
        case "response.output_audio.delta":
            if let delta = object["delta"] as? String,
               let data = Data(base64Encoded: delta) {
                continuation?.yield(.outputAudioDelta(data))
            }
        case "response.function_call_arguments.delta":
            if let callID = object["call_id"] as? String,
               let delta = object["delta"] as? String {
                functionCallArgumentsByCallID[callID, default: ""] += delta
            }
        case "response.function_call_arguments.done":
            handleFunctionCallDone(object: object)
        case "response.output_text.delta", "response.output_audio_transcript.delta":
            if let delta = object["delta"] as? String, !delta.isEmpty {
                let itemID = object["item_id"] as? String
                continuation?.yield(.textDelta(itemID: itemID, phase: itemID.flatMap { phaseByItemID[$0] }, text: delta, detail: prettyJSON, eventType: type))
            }
        case "response.output_text.done", "response.output_audio_transcript.done":
            let itemID = object["item_id"] as? String
            let phase = itemID.flatMap { phaseByItemID[$0] }
            if let text = object["text"] as? String, !text.isEmpty {
                continuation?.yield(.textComplete(itemID: itemID, phase: phase, text: text, detail: prettyJSON, eventType: type))
            } else if let transcript = object["transcript"] as? String, !transcript.isEmpty {
                continuation?.yield(.textComplete(itemID: itemID, phase: phase, text: transcript, detail: prettyJSON, eventType: type))
            }
        case "response.created":
            // Floor-guard: mark floor busy (§5).
            // NOTE(mac-verify): confirm event name is "response.created" on device.
            floorGuard.markResponseStarted()
            continuation?.yield(.status(type))
        case "response.done":
            drainSurfaceQueue()
            continuation?.yield(.status("Response done"))
        case "error":
            let message = ((object["error"] as? [String: Any])?["message"] as? String) ?? "OpenAI Realtime error"
            continuation?.yield(.error(message))
        default:
            continuation?.yield(.status(type))
        }
    }

    private func handleFunctionCallDone(object: [String: Any]) {
        guard let callID = object["call_id"] as? String else { return }
        let name = (object["name"] as? String) ?? "unknown_tool"
        let arguments = (object["arguments"] as? String) ?? functionCallArgumentsByCallID[callID] ?? "{}"
        functionCallArgumentsByCallID[callID] = nil
        continuation?.yield(.toolCallStarted(name: name, callID: callID, arguments: arguments))

        Task { [weak self] in
            guard let self else { return }
            do {
                let context = self.makeLiveToolContext()
                let output = await self.toolRegistry.execute(name: name, argumentsJSON: arguments, context: context)
                try await self.sendFunctionCallOutput(callID: callID, output: output)
                self.continuation?.yield(.toolCallCompleted(name: name, callID: callID, output: output))
            } catch {
                let output = LiveToolRegistry.jsonString([
                    "ok": false,
                    "error": error.localizedDescription,
                    "tool": name,
                ])
                try? await self.sendFunctionCallOutput(callID: callID, output: output)
                self.continuation?.yield(.toolCallCompleted(name: name, callID: callID, output: output))
            }
        }
    }

    private func sendFunctionCallOutput(callID: String, output: String) async throws {
        try await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": callID,
                "output": output,
            ],
        ])
        try await sendJSON([
            "type": "response.create",
            "response": Self.responsePayload(config: currentConfig),
        ])
    }

    private func send(_ text: String, on webSocket: URLSessionWebSocketTask) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            webSocket.send(.string(text)) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func receive(on webSocket: URLSessionWebSocketTask) async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            webSocket.receive { result in
                switch result {
                case .success(let message):
                    continuation.resume(returning: message)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func urlEncoded(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }

    private static func prettyJSONString(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              JSONSerialization.isValidJSONObject(object),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else {
            return nil
        }
        return String(data: pretty, encoding: .utf8)
    }

    private static func prettyJSONString(redactingAudioDeltaFrom object: [String: Any]) -> String? {
        guard object["type"] as? String == "response.output_audio.delta",
              let delta = object["delta"] as? String else {
            return nil
        }
        var redacted = object
        redacted["delta"] = "<redacted base64 audio: \(delta.count) chars>"
        guard JSONSerialization.isValidJSONObject(redacted),
              let pretty = try? JSONSerialization.data(withJSONObject: redacted, options: [.prettyPrinted, .sortedKeys]) else {
            return nil
        }
        return String(data: pretty, encoding: .utf8)
    }
}

private struct OpenAIRealtimeBrokerResponse: Decodable {
    let ok: Bool?
    let error: String?
    let model: String?
    let websocketURL: URL?
    let clientSecret: OpenAIRealtimeClientSecret?
    let directValue: String?
    let session: OpenAIRealtimeSession?

    enum CodingKeys: String, CodingKey {
        case ok
        case error
        case model
        case websocketURL = "websocket_url"
        case clientSecret = "client_secret"
        case directValue = "value"
        case session
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        websocketURL = try container.decodeIfPresent(URL.self, forKey: .websocketURL)
        clientSecret = try container.decodeIfPresent(OpenAIRealtimeClientSecret.self, forKey: .clientSecret)
        directValue = try container.decodeIfPresent(String.self, forKey: .directValue)
        session = try container.decodeIfPresent(OpenAIRealtimeSession.self, forKey: .session)
        if let stringError = try? container.decodeIfPresent(String.self, forKey: .error) {
            error = stringError
        } else if let objectError = try? container.decodeIfPresent(OpenAIRealtimeError.self, forKey: .error) {
            error = objectError.message
        } else {
            error = nil
        }
    }

    var isOK: Bool {
        ok ?? (error == nil)
    }

    func clientSecretValue() throws -> String {
        if let value = directValue, !value.isEmpty { return value }
        if let value = clientSecret?.value, !value.isEmpty { return value }
        if let value = clientSecret?.clientSecret?.value, !value.isEmpty { return value }
        throw LiveSessionProviderError.invalidConfig("OpenAI Realtime broker response did not include a client secret")
    }

    func resolvedModel(default fallback: String) -> String {
        model ?? session?.model ?? fallback
    }
}

private struct OpenAIRealtimeSession: Decodable {
    let model: String?
}

private struct OpenAIRealtimeError: Decodable {
    let message: String?
}

private struct OpenAIRealtimeClientSecret: Decodable {
    let value: String?
    let clientSecret: Nested?

    enum CodingKeys: String, CodingKey {
        case value
        case clientSecret = "client_secret"
    }

    struct Nested: Decodable {
        let value: String?
    }
}
