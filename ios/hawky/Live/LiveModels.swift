import Foundation
import AVFAudio

enum LiveProviderKind: String, CaseIterable, Identifiable, Equatable {
    case mock
    case openAIRealtime = "openai_realtime"
    case geminiLive = "gemini_live"
    case custom

    static var allCases: [LiveProviderKind] {
        [
            // .mock, // Keep the mock provider implemented, but hide it from Live settings for now.
            .openAIRealtime,
            .geminiLive,
            .custom
        ]
    }

    var id: String { rawValue }

    var label: String {
        switch self {
        case .mock: return "Mock local"
        case .openAIRealtime: return "OpenAI Realtime"
        case .geminiLive: return "Gemini Live"
        case .custom: return "Custom"
        }
    }

    var defaultModel: String {
        switch self {
        case .mock: return "mock-live"
        case .openAIRealtime: return "gpt-realtime-2"
        case .geminiLive: return "gemini-live"
        case .custom: return ""
        }
    }

    var supportsVisualContext: Bool {
        true
    }

    var canStartLocally: Bool {
        self == .mock
    }
}

enum LiveOpenAICredentialMode: String, CaseIterable, Identifiable, Equatable {
    case gatewayBroker = "gateway_broker"
    case directAPIKey = "direct_api_key"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .gatewayBroker: return "Gateway broker"
        case .directAPIKey: return "Direct OpenAI key"
        }
    }

    var shortLabel: String {
        switch self {
        case .gatewayBroker: return "Broker"
        case .directAPIKey: return "Direct"
        }
    }
}

enum LiveOpenAIModelPreset: String, CaseIterable, Identifiable, Equatable {
    case realtime2 = "gpt-realtime-2"
    case realtimeMini20251215 = "gpt-realtime-mini-2025-12-15"
    case realtimeMini20251006 = "gpt-realtime-mini-2025-10-06"
    case realtimeMini = "gpt-realtime-mini"
    case realtime20250828 = "gpt-realtime-2025-08-28"
    case realtime15 = "gpt-realtime-1.5"
    case realtime = "gpt-realtime"
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .realtime2: return "gpt-realtime-2"
        case .realtimeMini20251215: return "gpt-realtime-mini-2025-12-15"
        case .realtimeMini20251006: return "gpt-realtime-mini-2025-10-06"
        case .realtimeMini: return "gpt-realtime-mini"
        case .realtime20250828: return "gpt-realtime-2025-08-28"
        case .realtime15: return "gpt-realtime-1.5"
        case .realtime: return "gpt-realtime"
        case .custom: return "Custom"
        }
    }

    var model: String {
        switch self {
        case .realtime2: return "gpt-realtime-2"
        case .realtimeMini20251215: return "gpt-realtime-mini-2025-12-15"
        case .realtimeMini20251006: return "gpt-realtime-mini-2025-10-06"
        case .realtimeMini: return "gpt-realtime-mini"
        case .realtime20250828: return "gpt-realtime-2025-08-28"
        case .realtime15: return "gpt-realtime-1.5"
        case .realtime: return "gpt-realtime"
        case .custom: return ""
        }
    }

    static func preset(for model: String) -> LiveOpenAIModelPreset {
        let cleaned = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return allCases.first { $0.model == cleaned } ?? .custom
    }

    /// Presets a user can pick. `.custom` reveals a free-form model field.
    static var selectableCases: [LiveOpenAIModelPreset] {
        allCases
    }
}

enum LiveAudioSource: String, CaseIterable, Identifiable, Equatable {
    case systemDefault = "system_default"
    case iPhoneMic = "iphone_mic"
    case glassesHFP = "glasses_hfp"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .systemDefault: return "System default"
        case .iPhoneMic: return "iPhone mic"
        case .glassesHFP: return "Glasses HFP"
        }
    }
}

/// Where the Realtime voice reply is played back. Routing the agent's voice to
/// the glasses (or forcing the earpiece) keeps it off the loudspeaker, which is
/// the main source of echo bleeding back into the mic during a Live session.
enum LiveAudioOutputDestination: String, CaseIterable, Identifiable, Equatable {
    /// Follow whatever the system picks (current behaviour: loudspeaker via
    /// `.defaultToSpeaker`). Convenient, but most prone to echo.
    case auto
    /// Force the built-in loudspeaker.
    case speaker
    /// Prefer connected Bluetooth glasses / headset (HFP). Falls back to the
    /// receiver if no Bluetooth route is available.
    case glasses

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .speaker: return "Speaker"
        case .glasses: return "Glasses"
        }
    }

    /// Category options to apply on the playback `AVAudioSession`.
    ///
    /// `.allowBluetoothHFP` is kept on every route so a glasses mic can still be
    /// used for input; `.defaultToSpeaker` is only added when we explicitly want
    /// the loudspeaker. For `.glasses` we deliberately omit `.defaultToSpeaker`
    /// so the system honours the connected Bluetooth output instead of the
    /// loudspeaker.
    var playbackCategoryOptions: AVAudioSession.CategoryOptions {
        switch self {
        case .auto, .speaker:
            return [.defaultToSpeaker, .allowBluetoothHFP]
        case .glasses:
            return [.allowBluetoothHFP]
        }
    }

    /// Explicit output-port override applied after the session is active.
    /// `nil` means "leave the system route as chosen by the category options".
    var portOverride: AVAudioSession.PortOverride? {
        switch self {
        case .speaker: return .speaker
        case .auto, .glasses: return AVAudioSession.PortOverride.none
        }
    }
}

enum LiveVisualSource: String, CaseIterable, Identifiable, Equatable {
    case off
    case iPhoneCamera = "iphone_camera"
    case rayBanMeta = "rayban_meta"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off: return "Off"
        case .iPhoneCamera: return "iPhone camera"
        case .rayBanMeta: return "Ray-Ban Meta"
        }
    }
}

enum LiveVisualCadence: String, CaseIterable, Identifiable, Equatable {
    case off
    case fps0_2 = "fps_0_2"
    case fps0_5 = "fps_0_5"
    case fps1 = "fps_1"
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off: return "Off"
        case .fps0_2: return "0.2 fps"
        case .fps0_5: return "0.5 fps"
        case .fps1: return "1 fps"
        case .custom: return "Custom"
        }
    }

    func framesPerSecond(customFPS: Double) -> Double {
        switch self {
        case .off: return 0
        case .fps0_2: return 0.2
        case .fps0_5: return 0.5
        case .fps1: return 1
        case .custom: return customFPS
        }
    }
}

enum LiveMediaPersistenceMode: String, CaseIterable, Identifiable, Equatable {
    case local
    case liveUpload = "live_upload"
    case deferredUpload = "deferred_upload"
    case off

    var id: String { rawValue }

    var label: String {
        switch self {
        case .local: return "Save locally"
        case .liveUpload: return "Save + upload live"
        case .deferredUpload: return "Save, upload after stop"
        case .off: return "Do not save"
        }
    }

    var description: String {
        switch self {
        case .local:
            return "Live audio and video are saved on this iPhone only."
        case .liveUpload:
            return "Live audio and video are saved locally and uploaded while the session is running."
        case .deferredUpload:
            return "Live audio and video are saved locally, then uploaded to the Hawky gateway after Live stops."
        case .off:
            return "Live audio and video are not recorded as media files."
        }
    }
}

enum LiveTurnDetectionMode: String, CaseIterable, Identifiable, Equatable {
    case manual
    case serverVAD = "server_vad"
    case semanticVAD = "semantic_vad"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .manual: return "Manual"
        case .serverVAD: return "Server VAD"
        case .semanticVAD: return "Semantic VAD"
        }
    }
}

enum LiveSemanticVADEagerness: String, CaseIterable, Identifiable, Equatable {
    case auto
    case low
    case medium
    case high

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        }
    }
}

enum LiveBargeInPolicy: String, CaseIterable, Identifiable, Equatable {
    case interruptAssistant = "interrupt_assistant"
    case letAssistantFinish = "let_assistant_finish"
    case fullDuplex = "full_duplex"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .interruptAssistant: return "Interrupt assistant"
        case .letAssistantFinish: return "Let assistant finish"
        case .fullDuplex: return "Full duplex"
        }
    }

    var description: String {
        switch self {
        case .interruptAssistant:
            return "When you speak, stop assistant audio immediately and let the next user turn drive the next answer."
        case .letAssistantFinish:
            return "Keep playing the current assistant response while your speech is still transcribed for the next turn."
        case .fullDuplex:
            return "Experimental: keep listening and speaking at the same time. Best for testing overlap-capable models."
        }
    }

    var interruptsRealtimeResponse: Bool {
        self == .interruptAssistant
    }

    var stopsLocalPlaybackOnSpeechStart: Bool {
        self == .interruptAssistant
    }
}

enum LiveResponseModality: String, CaseIterable, Identifiable, Equatable {
    case text
    case audio

    var id: String { rawValue }

    var label: String {
        switch self {
        case .text: return "Text"
        case .audio: return "Voice"
        }
    }
}

enum LiveNoiseReduction: String, CaseIterable, Identifiable, Equatable {
    case none
    case nearField = "near_field"
    case farField = "far_field"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: return "None"
        case .nearField: return "Near field"
        case .farField: return "Far field"
        }
    }
}

enum LiveReasoningEffort: String, CaseIterable, Identifiable, Equatable {
    case none
    case low
    case medium
    case high
    case xhigh

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: return "None"
        case .xhigh: return "X high"
        default: return rawValue.capitalized
        }
    }
}

enum LiveToolChoice: String, CaseIterable, Identifiable, Equatable {
    case auto
    case none
    case required

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .none: return "None"
        case .required: return "Required"
        }
    }
}

enum LiveCameraPosition: String, CaseIterable, Identifiable, Equatable {
    case back
    case front

    var id: String { rawValue }

    var label: String {
        switch self {
        case .back: return "Back camera"
        case .front: return "Front camera"
        }
    }

    var toggled: LiveCameraPosition {
        switch self {
        case .back: return .front
        case .front: return .back
        }
    }
}

enum LiveRealtimeVoice: String, CaseIterable, Identifiable, Equatable {
    case marin
    case cedar
    case alloy
    case ash
    case ballad
    case coral
    case echo
    case sage
    case shimmer
    case verse

    var id: String { rawValue }

    var label: String { rawValue.capitalized }
}

enum LivePromptPreset: String, CaseIterable, Identifiable, Equatable {
    case concise
    case fieldObserver = "field_observer"
    case debugPartner = "debug_partner"
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .concise: return "Concise assistant"
        case .fieldObserver: return "Field observer"
        case .debugPartner: return "Debug partner"
        case .custom: return "Custom"
        }
    }

    var defaultInstructions: String {
        switch self {
        case .concise:
            return "You are Hawky Live, a concise realtime assistant. Answer directly, keep responses short, and ask one clarifying question only when needed."
        case .fieldObserver:
            return "You are Hawky Live, helping during an ambient field session. Notice useful visual or audio context, summarize uncertainty plainly, and keep guidance practical."
        case .debugPartner:
            return "You are Hawky Live in diagnostics mode. Be brief, call out what signal you received, and mention likely setup issues when the stream seems empty or inconsistent."
        case .custom:
            return ""
        }
    }

    /// Gateway prompt-registry id (#512) for built-in personas, so the app can
    /// fetch the persona text at session start. nil for `.custom` (user's own).
    var promptRegistryId: String? {
        switch self {
        case .concise: return "live.persona.concise"
        case .fieldObserver: return "live.persona.field_observer"
        case .debugPartner: return "live.persona.debug_partner"
        case .custom: return nil
        }
    }
}

// M4 Modes (§5). Three detents on one dial. At this stage, mode changes ONLY
// whether latent intention is enabled (modeLatentIntentionEnabled).
enum AmbientMode: String, CaseIterable, Identifiable, Equatable {
    case quiet
    case ambient
    case directive

    var id: String { rawValue }

    var label: String {
        switch self {
        case .quiet: return "Quiet"
        case .ambient: return "Ambient"
        case .directive: return "Directive"
        }
    }
}

enum LiveGatewayBridgeSessionMode: String, CaseIterable, Identifiable, Equatable {
    case temporary = "temporary"
    case fixed = "fixed"
    case activeChat = "active_chat"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .temporary: return "New realtime channel"
        case .fixed: return "Fixed channel"
        case .activeChat: return "Active Chat channel"
        }
    }

    var description: String {
        switch self {
        case .temporary:
            return "Creates a fresh realtime:<id> Hawky channel for each Live session."
        case .fixed:
            return "Reuses the channel named below."
        case .activeChat:
            return "Uses the currently selected Chat channel when Live starts."
        }
    }
}

enum LiveGatewayBridgeFeedMode: String, CaseIterable, Identifiable, Equatable {
    case onDemand = "on_demand"
    case followSession = "follow_session"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .onDemand: return "On demand tools"
        case .followSession: return "Follow session stream"
        }
    }

    var description: String {
        switch self {
        case .onDemand:
            return "Realtime asks Hawky only when it needs background help."
        case .followSession:
            return "Realtime also receives Hawky text and tool-start progress as silent context."
        }
    }
}

enum LiveOpeningBehavior: String, CaseIterable, Identifiable, Equatable {
    case silent = "silent"
    case firstContactOnly = "first_contact_only"
    case checkInEverySession = "check_in_every_session"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .silent: return "Silent"
        case .firstContactOnly: return "First contact only"
        case .checkInEverySession: return "Check in every session"
        }
    }

    var description: String {
        switch self {
        case .silent:
            return "Live waits for you to speak first."
        case .firstContactOnly:
            return "Live speaks first only when Hawky is in first-contact onboarding."
        case .checkInEverySession:
            return "Live starts with a brief memory-aware check-in each time a new Live session starts."
        }
    }
}

enum LiveLockScreenMode: String, CaseIterable, Identifiable, Equatable {
    case off = "off"
    case activeOnly = "active_only"
    case alwaysControl = "always_control"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off: return "Off"
        case .activeOnly: return "Active only"
        case .alwaysControl: return "Always show control"
        }
    }

    var description: String {
        switch self {
        case .off:
            return "Do not show a Hawky Live Activity."
        case .activeOnly:
            return "Show the Lock Screen card only while Live or recording is active."
        case .alwaysControl:
            return "Keep an experimental control card visible after the app has launched, even when Live is idle."
        }
    }
}

/// Reachability of the Hawky gateway (your machine) for the current Live session,
/// tracked independently of `LiveSessionPhase` because the Realtime/WebRTC leg talks
/// to OpenAI directly and connects even when the gateway is down. Without this, an
/// unreachable machine produced a "Connected" session whose memory + tools were
/// silently dead. `.offline` drives the prominent bridge-offline banner.
enum LiveBridgeStatus: Equatable {
    /// Bridge disabled, or no connection attempt has been made yet this session.
    case idle
    /// Gateway reachable — boot context loaded (or already loaded earlier this session).
    case connected
    /// Bridge enabled but the gateway could not be reached; the session continued
    /// anyway (required-mode off). The associated text is a user-facing detail.
    case offline(String)

    var isOffline: Bool {
        if case .offline = self { return true }
        return false
    }
}

/// Runtime capability state for the model-facing Hawky bridge surface. This is
/// separate from `LiveBridgeStatus`, which drives UI diagnostics. Availability
/// controls whether Realtime instructions and tool definitions advertise
/// gateway-backed capabilities.
enum LiveBridgeAvailability: Equatable {
    case disabled
    case available
    case offline(String)

    var toolsAvailable: Bool {
        if case .available = self { return true }
        return false
    }

    var diagnosticsLabel: String {
        switch self {
        case .disabled:
            return "disabled"
        case .available:
            return "available"
        case .offline:
            return "offline"
        }
    }
}

enum LiveSessionPhase: Equatable {
    case idle
    case connecting
    case connected
    case paused
    case stopping
    case failed(String)

    var label: String {
        switch self {
        case .idle: return "Idle"
        case .connecting: return "Connecting"
        case .connected: return "Connected"
        case .paused: return "Paused"
        case .stopping: return "Stopping"
        case .failed: return "Failed"
        }
    }

    var isActive: Bool {
        switch self {
        case .connecting, .connected, .paused, .stopping: return true
        case .idle, .failed: return false
        }
    }
}

struct LiveSessionConfig: Equatable {
    var provider: LiveProviderKind = .openAIRealtime
    var model: String = LiveProviderKind.openAIRealtime.defaultModel
    var openAICredentialMode: LiveOpenAICredentialMode = .directAPIKey
    var openAIModelPreset: LiveOpenAIModelPreset = .realtime2
    var sessionBrokerURL: String = ""
    var customEndpointURL: String = ""
    var customDialect: String = ""
    var audioInputEnabled: Bool = true
    var audioSource: LiveAudioSource = .systemDefault
    var visualSource: LiveVisualSource = .off
    var visualCadence: LiveVisualCadence = .off
    var customVisualFPS: Double = 1
    /// When true, near-identical frames are skipped before send (#612). When
    /// false, cadence alone governs the send rate. Default off — opt-in.
    var visualDedupEnabled: Bool = false
    var cameraPosition: LiveCameraPosition = .back
    var mediaPersistenceMode: LiveMediaPersistenceMode = .local
    var turnDetectionMode: LiveTurnDetectionMode = .serverVAD
    var vadThreshold: Double = 0.5
    var vadPrefixPaddingMs: Double = 300
    var vadSilenceDurationMs: Double = 500
    var vadCreateResponse: Bool = true
    var vadInterruptResponse: Bool = true
    var bargeInPolicy: LiveBargeInPolicy = .interruptAssistant
    var vadIdleTimeoutEnabled: Bool = false
    var vadIdleTimeoutMs: Double = 10_000
    var semanticVADEagerness: LiveSemanticVADEagerness = .auto
    /// M4 ambient mode. Controls latentIntentionEnabled (deferred latent path).
    var mode: AmbientMode = .ambient
    var promptPreset: LivePromptPreset = .concise
    var customPrompt: String = ""
    var selectedPromptID: String = LivePromptLibrary.defaultPromptID
    var promptTitle: String = LivePromptPreset.concise.label
    var promptInstructions: String = LivePromptPreset.concise.defaultInstructions
    var responseModality: LiveResponseModality = .text
    var reasoningEffort: LiveReasoningEffort = .low
    var maxResponseOutputTokens: Int?
    var toolChoice: LiveToolChoice = .auto
    var parallelToolCallsEnabled: Bool = true
    var realtimeVoice: LiveRealtimeVoice = .marin
    var noiseReduction: LiveNoiseReduction = .farField
    var audioOutputDestination: LiveAudioOutputDestination = .auto
    // Default ON: tools + bridge are both required for the realtime model to
    // reach Hawky (e.g. session_send_message → Slack, summarize_session).
    // With either off the model can only chat. Users can still turn them off
    // in Live Settings.
    var toolsEnabled: Bool = true
    var gatewayBridgeEnabled: Bool = true
    /// When the bridge is enabled, require the gateway (your Hawky machine) to be
    /// reachable for a Live session to start. Off (default): if the gateway is
    /// unreachable, Live still connects to OpenAI Realtime and surfaces a prominent
    /// "bridge offline" banner so you know your machine's memory + tools are missing.
    /// On: an unreachable gateway fails the whole Live start with a clear error
    /// instead of silently connecting without your machine.
    var gatewayBridgeRequired: Bool = false
    /// Disabled by default until the owner enrollment and biometric consent UI can
    /// explicitly turn on the voice identity side-channel.
    var voiceprintRealtimeEnabled: Bool = false
    /// B1 on-device speaker embedding. When on (AND voiceprintRealtimeEnabled is on
    /// AND a CoreML speaker model is provisioned on the device), finalized turns
    /// carry an on-device `sampleEmbedding` in the score_turns params so the gateway
    /// can score a client embedding directly against the owner template — no raw
    /// audio leaves the phone. Default OFF: with this off (or the model absent) the
    /// session keeps sending markers and the server scores as before. The default
    /// app behavior is unchanged.
    var onDeviceEmbeddingEnabled: Bool = false
    /// Cocktail Party Mode (#627): when on, the Live session runs on-device face
    /// detection on each camera frame, matches against the local person DB, and
    /// proactively recalls known people / enrolls new ones. Off by default; needs
    /// the camera + Hawky bridge (DeepFace embeddings) to do anything.
    var cocktailPartyEnabled: Bool = false
    /// "Respond only when I talk": when on, VAD auto-response is disabled
    /// (create_response:false) for the whole session — the model replies only after
    /// you actually speak, never volunteering on ambient noise or camera frames.
    /// Reuses the visual-quiet session.update mechanism. Off by default.
    var speakOnlyWhenSpokenTo: Bool = false
    /// Safety Check (#648): when on, the Live session stays silent (visual-quiet) and
    /// the model watches the camera, calling report_hazard + warning the user only on
    /// a genuine danger (fire, unattended stove, etc.). Needs the camera. Off by default.
    var safetyCheckEnabled: Bool = false
    // Default to a fresh realtime channel per Live session. A fixed channel
    // (realtime:main) accumulates history, which made the background agent (a)
    // hallucinate "already sent" and skip re-sending, and (b) reuse a stale/wrong
    // recipient id from earlier turns. A new channel each time keeps it clean.
    var gatewayBridgeSessionMode: LiveGatewayBridgeSessionMode = .temporary
    var gatewayBridgeSessionKey: String = "realtime:main"
    var gatewayBridgeFeedMode: LiveGatewayBridgeFeedMode = .onDemand
    /// Runtime-only bridge capability state. This is derived at Live start from
    /// bridge preflight, then updated by the bridge feed reconnect loop. It is not
    /// persisted; settings only persist whether the bridge is enabled/required.
    var bridgeAvailability: LiveBridgeAvailability = .available
    var openingBehavior: LiveOpeningBehavior = .firstContactOnly
    var inputTranscriptionEnabled: Bool = false
    var inputTranscriptionModel: String = "gpt-4o-mini-transcribe"
    var outputTranscriptionEnabled: Bool = true
    var keepRunningOffscreen: Bool = false
    var lockScreenMode: LiveLockScreenMode = .alwaysControl
    var showSystemMessages: Bool = true
    var diagnosticsLevel: LiveDiagnosticsLevel = .basic
    /// Run hardware acoustic echo cancellation (voice-processing I/O) on the mic
    /// so the model's loudspeaker reply doesn't loop back into the input. On by
    /// default — needed for hands-free speaker use; harmless on headphones.
    var echoCancellationEnabled: Bool = true
    /// Debug-only: when true, the raw JPEG keyframes sent to the model are also
    /// shown as "Camera frame N" image bubbles in the transcript. Off by default
    /// — the live video now surfaces via the PiP/fullscreen preview instead, and
    /// the frames stay an invisible model-input detail. (#415)
    var showVisualFramesInTranscript: Bool = false
    /// Transient backend-provided startup context for the current Live start.
    /// This is intentionally not persisted in user settings; it is fetched from
    /// the gateway just before the Realtime session is created.
    var startupBootContext: String = ""
    /// Transient first-contact marker derived from the backend workspace's
    /// BOOTSTRAP.md presence. Used to let Realtime speak first during onboarding.
    var startupFirstContactActive: Bool = false
    /// Transient replay turns for transports that need history at connection
    /// setup time, such as OpenAI Realtime WebRTC.
    var historyReplayTurns: [LiveHistoryTurn] = []
    /// Transient persona text fetched from the gateway prompt registry (#512) for
    /// the active built-in preset, fetched just before the Realtime session
    /// starts. nil → fall back to the bundled `defaultInstructions`. Not persisted.
    var fetchedPersona: String?

    var effectiveVisualFPS: Double {
        visualCadence.framesPerSecond(customFPS: customVisualFPS)
    }

    /// M4: mode changes ONLY whether latent intention is enabled.
    /// No other settings (modality / reasoning / bridge-feed / prompt) are affected.
    var modeLatentIntentionEnabled: Bool {
        mode == .quiet ? false : true
    }

    var bridgeToolsAvailable: Bool {
        gatewayBridgeEnabled && bridgeAvailability.toolsAvailable
    }

    var resolvedInstructions: String {
        let base: String
        let custom = customPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let fetched = fetchedPersona?.trimmingCharacters(in: .whitespacesAndNewlines)
        if promptPreset == .custom, !custom.isEmpty {
            base = custom
        } else if let fetched, !fetched.isEmpty {
            // Persona fetched from the gateway prompt registry (#512) — lets the
            // built-in persona be tuned server-side without an app rebuild. Only
            // used for non-custom presets; falls through to bundled defaults when
            // the fetch failed (offline / gateway down).
            base = fetched
        } else if promptPreset != .concise {
            base = promptPreset.defaultInstructions
        } else {
            base = promptInstructions
        }
        var sections = [base]
        if bridgeToolsAvailable {
            sections.append(realtimeBridgeInstructions)
        } else if gatewayBridgeEnabled, case .offline(let reason) = bridgeAvailability {
            sections.append(Self.realtimeBridgeOfflineInstructions(reason: reason))
        }
        let bootContext = startupBootContext.trimmingCharacters(in: .whitespacesAndNewlines)
        if !bootContext.isEmpty {
            sections.append(bootContext)
        }
        // Safety Check (#648): hard-quiet. Even when the model does respond (only on the
        // user's own speech turn), it must NOT lead with a greeting or volunteer
        // commentary about the camera. This reinforces the transport-level suppression
        // (hardQuiet) so the model's own content also stays quiet.
        if safetyCheckEnabled {
            sections.append(
                "SAFETY CHECK QUIET MODE: Do NOT greet, do NOT introduce yourself, and do "
                + "NOT start any conversation on your own. Do NOT describe, narrate, or "
                + "comment on the camera feed. Stay silent until the user speaks to you, "
                + "then answer their question briefly and stop. The system will separately "
                + "deliver any safety hazard warning — you do not need to volunteer one."
            )
        }
        return sections.joined(separator: "\n\n")
    }

    static func realtimeBridgeOfflineInstructions(reason: String) -> String {
        let detail = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        HAWKY BRIDGE OFFLINE: The user's Hawky machine is currently unreachable\(detail.isEmpty ? "." : " (\(detail)).")
        Gateway-backed Hawky tools are not available right now. Do not claim you can send Slack/app messages, save durable backend memory, create reminders, scan intentions, or delegate work to the Hawky background agent until the bridge reconnects and those tools are advertised again.
        You can still answer with the live OpenAI voice session and any local iPhone tools that remain available.
        """
    }

    var realtimeBridgeInstructions: String {
        """
        You can collaborate with a separate Hawky background agent through local tools.
        You are the frontend realtime agent: keep the live conversation responsive, decide what to speak immediately, and use the background agent for longer reasoning, tools, files, nodes, or durable work.
        Use session_send_message when backend help is useful. Set frontend_delivery to context_only, stream_to_frontend, or urgent_frontend depending on whether the response should stay silent, be shown/spoken soon, or interrupt urgently.
        SENDING MESSAGES TO OTHER PEOPLE / APPS. You CAN send messages to Slack (and other connected apps) — the background agent has that ability. When the user asks to send/post a message to someone or somewhere outside this app (e.g. "send a Slack DM to xinkai", "post to #general", "message my team"), DO NOT say you can't. You MUST ACTUALLY CALL the session_send_message tool — saying "I'll send it", "我会让后台发", or "I'll have the background agent send it" WITHOUT calling the tool is a FAILURE. The moment you have the recipient and the text, CALL session_send_message in the SAME turn (do not end your turn first), with a clear instruction for the background agent, e.g. message="Send a Slack DM to xinkai saying: 你好". Include the platform (Slack), the recipient/channel, and the exact text. Do NOT claim it was sent until the tool returns a success result — if you have not called the tool, it has NOT been sent. If the recipient or channel is ambiguous, ask ONE short clarifying question first, then call the tool. After the tool reports success, confirm to the user that it was sent. REPEATS ARE ALLOWED: sending the same text to the same person again is fine. You MAY briefly note "you already sent that — send again?" and, once the user confirms (or if they clearly already asked to send it again), you MUST call the tool and send it. Never silently refuse or skip just because an identical message went earlier. When re-sending, make it explicit, e.g. message="Send this Slack DM AGAIN (resend, duplicates are fine) to xinkai saying: 你好".
        SENDING THE CURRENT CAMERA PHOTO. When the user asks to send/share/post what the camera currently sees as a picture/photo/image to Slack, call send_photo directly, not session_send_message. Do not supply image bytes; iOS attaches the latest camera frame automatically. If send_photo reports no frame, ask the user to turn the camera on and try again.
        If the Hawky feed mode is follow_session, you may receive silent context items containing background session text and tool-start progress. Do not read all of this aloud. Summarize only meaningful progress, urgent blockers, or answers the user asked about. If the user barges in, prioritize their live speech and use the latest feed context to answer what is safe to say now.
        TIMED INTENTIONS (follow exactly). Call the create_intention tool ONLY when the user EXPLICITLY asks to be reminded or alerted to do something at a specific time they state (e.g. "remind me to drink water in 1 minute", "take my pills at 8pm", "buy milk at 1pm tomorrow") — NEVER session_send_message. Fill content with a short imperative ("Take your pills") and when with the time exactly as they gave it ("8pm", "in 10 minutes", "tomorrow at 9am"). Only call it once you have an actionable time; if the time is missing or vague ("later", "soon"), ask ONE short question to get it first — never guess a time. If the tool returns needs_clarification, ask the user the question it provides. When it succeeds, tell the user definitively that it's set. Later you may receive a fired intention as injected context — deliver it to the user directly and assertively (they set it themselves).
        DO NOT proactively offer or suggest setting a reminder, and DO NOT ask "should I set a reminder?". If the user merely MENTIONS a need, task, or problem in passing WITHOUT asking to be reminded at a time (e.g. "we're out of coffee", "my passport expires next month", "I should really call the dentist", "the car needs an oil change"), just respond naturally and conversationally — do not offer a reminder and do not call create_intention. The system already notices such intentions on its own in the background; your job is only to act on EXPLICIT timed requests.
        LATENT INTENTIONS (scan_intention tool). The system continuously detects background needs from conversation context (e.g. "we're out of coffee" → buy coffee). PROACTIVELY use scan_intention at conversational inflection points — topic shifts, when the user is wrapping up, or when they mention a place — to pull any armed latent intentions that are currently relevant; if matches are returned, surface the highest-confidence one naturally and conversationally (e.g. "By the way, you wanted to…"), one at a time, and do not surface if the conversation context is unrelated. ALSO call scan_intention IMMEDIATELY whenever the user EXPLICITLY asks what they need, asks for a shopping list / to-do list / errands, or asks you to compile their pending needs — in that case read back ALL returned matches as the list (not just one); if it returns nothing, say their list is empty.
        AMBIENT SUGGESTIONS. When you receive a surfaced suggestion with a [intention_id:…] tag (e.g. "Surface [intention_id:abc]: call the dentist"), present it naturally to the user. If the user clearly accepts (says yes, agrees, confirms), call intention_respond with action "confirm". If the user clearly declines (says no, not now, ignore), call intention_respond with action "decline". Only call it on an explicit verbal response; do not guess.
        SPEAK LIKE A PERSON, NOT A SYSTEM. Every reply is user-facing and plain. Translate any status or error from the background agent into ONE short, human sentence about what it means for the user — e.g. "I couldn't send that — Slack isn't connected yet." Keep internal details to yourself: session ids and keys, file paths, config keys, gateway or backend internals, model names, and setup or restart steps.
        The bound Hawky session key is \(gatewayBridgeSessionKey.isEmpty ? "not set yet" : gatewayBridgeSessionKey). Use it internally only.
        """
    }

    func effectiveSessionBrokerURL(defaultURL: URL?) -> String {
        let override = sessionBrokerURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !override.isEmpty {
            return override
        }
        return defaultURL?.absoluteString ?? ""
    }

    // MARK: - Stay Silent (observation mode)

    /// Layered onto the base instructions while Stay Silent is enabled. Mirrors the
    /// web LiveLab STAY_SILENT_PROMPT: keep listening/transcribing, don't respond.
    static let staySilentPrompt =
        "Stay Silent mode is enabled. You are in observation mode: keep listening, transcribing, and updating conversation context, but do not speak, write visible assistant text, call tools, or otherwise respond until Stay Silent mode is disabled. Preserve useful details for the release summary."

    /// Append the Stay Silent observation-mode prompt to the base instructions.
    static func instructionsForSilence(_ instructions: String) -> String {
        "\(instructions)\n\n# Stay Silent\n\(staySilentPrompt)"
    }
}

struct LivePromptProfile: Identifiable, Codable, Equatable {
    var id: String
    var title: String
    var instructions: String
    var isBuiltIn: Bool
}

enum LivePromptLibrary {
    static let defaultPromptID = "concise"
    private static let customPromptsKey = "live.promptProfiles"

    static var builtInProfiles: [LivePromptProfile] {
        LivePromptPreset.allCases
            .filter { $0 != .custom }
            .map {
                LivePromptProfile(
                    id: $0.rawValue,
                    title: $0.label,
                    instructions: $0.defaultInstructions,
                    isBuiltIn: true
                )
            }
    }

    static func load(defaults: UserDefaults = .standard) -> [LivePromptProfile] {
        let customProfiles: [LivePromptProfile]
        if let data = defaults.data(forKey: customPromptsKey),
           let decoded = try? JSONDecoder().decode([LivePromptProfile].self, from: data) {
            customProfiles = decoded.map {
                LivePromptProfile(id: $0.id, title: $0.title, instructions: $0.instructions, isBuiltIn: false)
            }
        } else {
            customProfiles = []
        }
        return builtInProfiles + customProfiles
    }

    static func save(_ profiles: [LivePromptProfile], defaults: UserDefaults = .standard) {
        let customProfiles = profiles.filter { !$0.isBuiltIn }
        guard let data = try? JSONEncoder().encode(customProfiles) else { return }
        defaults.set(data, forKey: customPromptsKey)
    }
}

struct LiveSessionDiagnostics: Equatable {
    var providerLabel: String = "None"
    var providerStatus: String = "Idle"
    var connectedAt: Date?
    var lastLatencyMs: Double?
    var audioChunksSent: Int = 0
    var micChunksCaptured: Int = 0
    var micBytesCaptured: Int = 0
    var lastMicCaptureAt: Date?
    var audioSessionStatus: String = "Idle"
    var audioRoute: String = "Unknown"
    var audioInterruptions: Int = 0
    var audioRouteChanges: Int = 0
    var lastLifecycleEvent: String = "None"
    var visualStatus: String = "Off"
    var visualFramesCaptured: Int = 0
    var visualFramesSkipped: Int = 0
    var visualBytesCaptured: Int = 0
    var lastVisualCaptureAt: Date?
    var outputAudioChunksReceived: Int = 0
    var outputAudioBytesReceived: Int = 0
    var outputAudioChunksPlayed: Int = 0
    var outputAudioBytesPlayed: Int = 0
    var outputAudioStatus: String = "Idle"
    var toolCallsReceived: Int = 0
    var toolCallsCompleted: Int = 0
    var lastToolCall: String = "None"
    var framesSent: Int = 0
    var reconnects: Int = 0
    var lastModelEvent: String = "None"
    var lastError: String?
    /// #677: realtime session-config application state — "unknown" until the server
    /// acks our session.update ("applied") or it fails ("failed"). Surfaces a
    /// connected-but-unconfigured session that would otherwise look healthy.
    var sessionConfigStatus: String = "unknown"
}

enum LiveRealtimeSessionConfigStatus: Equatable {
    case notApplicable
    case pending
    case applied
    case unconfirmed(detail: String?)
    case failed(detail: String?)

    var diagnosticsLabel: String {
        switch self {
        case .notApplicable: return "not_applicable"
        case .pending: return "pending"
        case .applied: return "applied"
        case .unconfirmed: return "unconfirmed"
        case .failed: return "failed"
        }
    }

    var connectedProviderStatus: String {
        switch self {
        case .unconfirmed:
            return "Connected (session config unconfirmed)"
        case .failed:
            return "Session config failed"
        default:
            return "Connected"
        }
    }

    var connectedMessage: String {
        switch self {
        case .unconfirmed:
            return "Connected (session config unconfirmed)"
        case .failed:
            return "Session config failed"
        default:
            return "Connected"
        }
    }
}

enum LiveSessionEvent: Equatable {
    case status(String)
    case latency(milliseconds: Double)
    case audioAccepted(bytes: Int)
    case frameAccepted(bytes: Int)
    case text(String)
    case textDelta(itemID: String?, phase: String?, text: String, detail: String?, eventType: String?)
    case textComplete(itemID: String?, phase: String?, text: String, detail: String?, eventType: String?)
    case inputTranscriptDelta(itemID: String, text: String, detail: String?, eventType: String?)
    case inputTranscriptComplete(itemID: String, text: String, detail: String?, eventType: String?)
    case outputAudioDelta(Data)
    case toolCallStarted(name: String, callID: String, arguments: String?)
    case toolCallCompleted(name: String, callID: String, output: String)
    case reconnect(count: Int)
    case raw(direction: Direction, type: String, json: String)
    case error(String)
    /// #677: whether the realtime session config (persona/tools/VAD/transcription) was
    /// actually applied. `applied` = server acked our session.update; `failed` =
    /// it failed to apply; `unconfirmed` = no ack/error arrived before the startup
    /// guard timed out, so the transport is usable but not cleanly configured.
    case sessionConfigStatus(LiveRealtimeSessionConfigStatus)

    enum Direction: String, Codable, Equatable {
        case sent
        case received
    }
}

enum LiveConversationRole: String, Codable, Equatable {
    case user
    case assistant
    case system
    /// A tool invocation surfaced as its own bubble (realtime model's tool calls
    /// and the Hawky background agent's tool calls).
    case tool
}

/// Details of a tool call shown in a `.tool` conversation entry.
struct LiveToolCallInfo: Codable, Equatable {
    enum Status: String, Codable, Equatable {
        case started
        case ok
        case error
    }
    /// "realtime" = the on-device realtime model called the tool;
    /// "gateway" = the background gateway agent called it.
    enum Source: String, Codable, Equatable {
        case realtime
        case gateway

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            switch raw {
            case "realtime": self = .realtime
            // #694 de-productization: sessions persisted before the rename
            // stored the backend source as "Hawky"/"hawky"; decode it as .gateway so
            // historical tool calls keep rendering correctly after upgrade.
            case "gateway", "Hawky", "hawky": self = .gateway
            default:
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Unknown LiveToolCallInfo.Source: \(raw)"
                )
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }
    var name: String
    var status: Status
    var source: Source
    var arguments: String?
    var output: String?
    var callID: String?
    var startedAt: Date?
    var completedAt: Date?
}

struct LiveConversationEntry: Identifiable, Codable, Equatable {
    let id: UUID
    var date: Date
    var role: LiveConversationRole
    var text: String
    var level: LiveEventLogEntry.Level
    var isStreaming: Bool
    var detail: String?
    var eventType: String?
    var imageData: Data?
    /// Realtime output phase for assistant turns: "commentary" (think-aloud) or
    /// "final_answer". nil for user/system entries and providers that don't
    /// report a phase. Drives the bubble tint so the two read differently.
    var phase: String?
    /// Tool-call details for `.tool` entries; nil otherwise.
    var toolCall: LiveToolCallInfo?

    init(
        id: UUID = UUID(),
        date: Date = Date(),
        role: LiveConversationRole,
        text: String,
        level: LiveEventLogEntry.Level,
        isStreaming: Bool,
        detail: String? = nil,
        eventType: String? = nil,
        imageData: Data? = nil,
        phase: String? = nil,
        toolCall: LiveToolCallInfo? = nil
    ) {
        self.id = id
        self.date = date
        self.role = role
        self.text = text
        self.level = level
        self.isStreaming = isStreaming
        self.detail = detail
        self.eventType = eventType
        self.imageData = imageData
        self.phase = phase
        self.toolCall = toolCall
    }
}

struct LiveRawLogEntry: Identifiable, Codable, Equatable {
    let id: UUID
    var date: Date
    var provider: String
    var direction: LiveSessionEvent.Direction
    var type: String
    var json: String

    init(
        id: UUID = UUID(),
        date: Date = Date(),
        provider: String,
        direction: LiveSessionEvent.Direction,
        type: String,
        json: String
    ) {
        self.id = id
        self.date = date
        self.provider = provider
        self.direction = direction
        self.type = type
        self.json = json
    }
}

struct LiveEventLogEntry: Identifiable, Equatable {
    let id = UUID()
    let date: Date
    let level: Level
    let message: String
    let detail: String?

    enum Level: String, Codable, Equatable {
        case info
        case warning
        case error
    }
}

struct LiveSessionExportBundle {
    var archiveURL: URL
    var previewURL: URL
}

private struct LiveSessionExportManifest: Codable {
    var version: Int
    var exportedAt: Date
    var sessionID: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var transcriptEntries: Int
    var userEntries: Int
    var assistantEntries: Int
    var toolEntries: Int
    var systemEntries: Int
    var rawEvents: Int
    var files: [String]
    var warnings: [String]
}

private struct LiveSessionTranscriptExportLine: Codable {
    var timestamp: Date
    var role: String
    var text: String
    var eventType: String?
    var level: String
    var phase: String?
    var source: String
    var transcriptionStatus: String?
    var detail: String?
    var toolCall: LiveToolCallInfo?

    enum CodingKeys: String, CodingKey {
        case timestamp
        case role
        case text
        case eventType = "event_type"
        case level
        case phase
        case source
        case transcriptionStatus = "transcription_status"
        case detail
        case toolCall = "tool_call"
    }
}

struct LiveLocalSession: Identifiable, Codable, Equatable {
    var id: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var isBookmarked: Bool
    var isArchived: Bool
    var conversation: [LiveConversationEntry]

    init(
        id: UUID,
        title: String,
        createdAt: Date,
        updatedAt: Date,
        isBookmarked: Bool = false,
        isArchived: Bool = false,
        conversation: [LiveConversationEntry]
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.isBookmarked = isBookmarked
        self.isArchived = isArchived
        self.conversation = conversation
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case createdAt
        case updatedAt
        case isBookmarked
        case isArchived
        case conversation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        isBookmarked = try container.decodeIfPresent(Bool.self, forKey: .isBookmarked) ?? false
        isArchived = try container.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        conversation = try container.decode([LiveConversationEntry].self, forKey: .conversation)
    }
}

struct LiveAudioChunk: Equatable {
    var data: Data
    var formatDescription: String
    var capturedAt: Date
}

struct LiveJPEGFrame: Equatable {
    var data: Data
    var capturedAt: Date
}

enum LiveProfileDefaults {
    private static let providerKey = "live.provider"
    private static let modelKey = "live.model"
    private static let openAICredentialModeKey = "live.openAICredentialMode"
    private static let openAIModelPresetKey = "live.openAIModelPreset"
    private static let brokerKey = "live.sessionBrokerURL"
    private static let customEndpointKey = "live.customEndpointURL"
    private static let customDialectKey = "live.customDialect"
    private static let audioInputEnabledKey = "live.audioInputEnabled"
    private static let audioSourceKey = "live.audioSource"
    private static let visualSourceKey = "live.visualSource"
    private static let visualCadenceKey = "live.visualCadence"
    private static let customVisualFPSKey = "live.customVisualFPS"
    private static let visualDedupEnabledKey = "live.visualDedupEnabled"
    private static let cameraPositionKey = "live.cameraPosition"
    private static let mediaPersistenceModeKey = "live.mediaPersistenceMode"
    private static let mediaPersistenceUnforcedMigrationKey = "live.mediaPersistence.unforcedV1"
    private static let turnDetectionModeKey = "live.turnDetectionMode"
    private static let vadThresholdKey = "live.vadThreshold"
    private static let vadPrefixPaddingMsKey = "live.vadPrefixPaddingMs"
    private static let vadSilenceDurationMsKey = "live.vadSilenceDurationMs"
    private static let vadCreateResponseKey = "live.vadCreateResponse"
    private static let vadInterruptResponseKey = "live.vadInterruptResponse"
    private static let bargeInPolicyKey = "live.bargeInPolicy"
    private static let vadIdleTimeoutEnabledKey = "live.vadIdleTimeoutEnabled"
    private static let vadIdleTimeoutMsKey = "live.vadIdleTimeoutMs"
    private static let semanticVADEagernessKey = "live.semanticVADEagerness"
    private static let ambientModeKey = "live.ambientMode"
    private static let promptPresetKey = "live.promptPreset"
    private static let customPromptKey = "live.customPrompt"
    private static let selectedPromptIDKey = "live.selectedPromptID"
    private static let promptTitleKey = "live.promptTitle"
    private static let promptInstructionsKey = "live.promptInstructions"
    private static let responseModalityKey = "live.responseModality"
    private static let reasoningEffortKey = "live.reasoningEffort"
    private static let maxResponseOutputTokensKey = "live.maxResponseOutputTokens"
    private static let toolChoiceKey = "live.toolChoice"
    private static let parallelToolCallsEnabledKey = "live.parallelToolCallsEnabled"
    private static let realtimeVoiceKey = "live.realtimeVoice"
    private static let noiseReductionKey = "live.noiseReduction"
    private static let audioOutputDestinationKey = "live.audioOutputDestination"
    private static let toolsEnabledKey = "live.toolsEnabled"
    private static let gatewayBridgeEnabledKey = "live.gatewayBridgeEnabled"
    private static let gatewayBridgeRequiredKey = "live.gatewayBridgeRequired"
    private static let cocktailPartyEnabledKey = "live.cocktailPartyEnabled"
    private static let speakOnlyWhenSpokenToKey = "live.speakOnlyWhenSpokenTo"
    private static let safetyCheckEnabledKey = "live.safetyCheckEnabled"
    private static let gatewayBridgeSessionModeKey = "live.gatewayBridgeSessionMode"
    private static let gatewayBridgeSessionKeyKey = "live.gatewayBridgeSessionKey"
    private static let gatewayBridgeFeedModeKey = "live.gatewayBridgeFeedMode"
    private static let openingBehaviorKey = "live.openingBehavior"
    private static let inputTranscriptionEnabledKey = "live.inputTranscriptionEnabled"
    private static let inputTranscriptionModelKey = "live.inputTranscriptionModel"
    private static let outputTranscriptionEnabledKey = "live.outputTranscriptionEnabled"
    private static let keepRunningOffscreenKey = "live.keepRunningOffscreen"
    private static let lockScreenModeKey = "live.lockScreenMode"
    private static let showSystemMessagesKey = "live.showSystemMessages"
    private static let diagnosticsLevelKey = "live.diagnosticsLevel"
    private static let echoCancellationEnabledKey = "live.echoCancellationEnabled"
    private static let showVisualFramesInTranscriptKey = "live.showVisualFramesInTranscript"
    private static let voiceprintRealtimeEnabledKey = "live.voiceprintRealtimeEnabled"

    static func load(defaults: UserDefaults = .standard) -> LiveSessionConfig {
        var config = LiveSessionConfig()
        if let raw = defaults.string(forKey: providerKey),
           let provider = LiveProviderKind(rawValue: raw) {
            config.provider = provider == .mock ? .openAIRealtime : provider
        }
        config.model = defaults.string(forKey: modelKey) ?? config.provider.defaultModel
        if let raw = defaults.string(forKey: openAICredentialModeKey),
           let mode = LiveOpenAICredentialMode(rawValue: raw) {
            config.openAICredentialMode = mode
        }
        if let raw = defaults.string(forKey: openAIModelPresetKey),
           let preset = LiveOpenAIModelPreset(rawValue: raw) {
            config.openAIModelPreset = preset
        } else {
            config.openAIModelPreset = LiveOpenAIModelPreset.preset(for: config.model)
        }
        config.sessionBrokerURL = defaults.string(forKey: brokerKey) ?? ""
        config.customEndpointURL = defaults.string(forKey: customEndpointKey) ?? ""
        config.customDialect = defaults.string(forKey: customDialectKey) ?? ""
        if defaults.object(forKey: audioInputEnabledKey) != nil {
            config.audioInputEnabled = defaults.bool(forKey: audioInputEnabledKey)
        }
        if let raw = defaults.string(forKey: audioSourceKey),
           let source = LiveAudioSource(rawValue: raw) {
            config.audioSource = source
        }
        if let raw = defaults.string(forKey: visualSourceKey),
           let source = LiveVisualSource(rawValue: raw) {
            config.visualSource = source
        }
        if let raw = defaults.string(forKey: visualCadenceKey),
           let cadence = LiveVisualCadence(rawValue: raw) {
            config.visualCadence = cadence
        }
        let fps = defaults.double(forKey: customVisualFPSKey)
        if fps > 0 {
            config.customVisualFPS = fps
        }
        if let raw = defaults.string(forKey: cameraPositionKey),
           let position = LiveCameraPosition(rawValue: raw) {
            config.cameraPosition = position
        }
        let storedMediaPersistenceMode = defaults.string(forKey: mediaPersistenceModeKey)
        if let raw = storedMediaPersistenceMode,
           let mode = LiveMediaPersistenceMode(rawValue: raw) {
            config.mediaPersistenceMode = mode
        } else if storedMediaPersistenceMode == "remote" {
            config.mediaPersistenceMode = .liveUpload
        }
        if let raw = defaults.string(forKey: turnDetectionModeKey),
           let mode = LiveTurnDetectionMode(rawValue: raw) {
            config.turnDetectionMode = mode
        }
        let threshold = defaults.double(forKey: vadThresholdKey)
        if threshold > 0 {
            config.vadThreshold = min(max(threshold, 0), 1)
        }
        let prefixPadding = defaults.double(forKey: vadPrefixPaddingMsKey)
        if prefixPadding > 0 {
            config.vadPrefixPaddingMs = min(max(prefixPadding, 0), 2_000)
        }
        let silenceDuration = defaults.double(forKey: vadSilenceDurationMsKey)
        if silenceDuration > 0 {
            config.vadSilenceDurationMs = min(max(silenceDuration, 100), 2_000)
        }
        if defaults.object(forKey: vadCreateResponseKey) != nil {
            config.vadCreateResponse = defaults.bool(forKey: vadCreateResponseKey)
        }
        if defaults.object(forKey: vadInterruptResponseKey) != nil {
            config.vadInterruptResponse = defaults.bool(forKey: vadInterruptResponseKey)
        }
        if let raw = defaults.string(forKey: bargeInPolicyKey),
           let policy = LiveBargeInPolicy(rawValue: raw) {
            config.bargeInPolicy = policy
        } else if defaults.object(forKey: vadInterruptResponseKey) != nil {
            config.bargeInPolicy = config.vadInterruptResponse ? .interruptAssistant : .letAssistantFinish
        }
        config.vadInterruptResponse = config.bargeInPolicy.interruptsRealtimeResponse
        config.vadIdleTimeoutEnabled = defaults.bool(forKey: vadIdleTimeoutEnabledKey)
        let idleTimeout = defaults.double(forKey: vadIdleTimeoutMsKey)
        if idleTimeout > 0 {
            config.vadIdleTimeoutMs = min(max(idleTimeout, 5_000), 30_000)
        }
        if let raw = defaults.string(forKey: semanticVADEagernessKey),
           let eagerness = LiveSemanticVADEagerness(rawValue: raw) {
            config.semanticVADEagerness = eagerness
        }
        if let raw = defaults.string(forKey: ambientModeKey),
           let ambientMode = AmbientMode(rawValue: raw) {
            config.mode = ambientMode
        }
        if let raw = defaults.string(forKey: promptPresetKey),
           let preset = LivePromptPreset(rawValue: raw) {
            config.promptPreset = preset
        }
        config.customPrompt = defaults.string(forKey: customPromptKey) ?? ""
        config.selectedPromptID = defaults.string(forKey: selectedPromptIDKey) ?? config.selectedPromptID
        config.promptTitle = defaults.string(forKey: promptTitleKey) ?? config.promptTitle
        config.promptInstructions = defaults.string(forKey: promptInstructionsKey) ?? config.promptInstructions
        if let raw = defaults.string(forKey: responseModalityKey),
           let modality = LiveResponseModality(rawValue: raw) {
            config.responseModality = modality
        }
        if let raw = defaults.string(forKey: reasoningEffortKey),
           let effort = LiveReasoningEffort(rawValue: raw) {
            config.reasoningEffort = effort
        }
        if defaults.object(forKey: maxResponseOutputTokensKey) != nil {
            let tokens = defaults.integer(forKey: maxResponseOutputTokensKey)
            config.maxResponseOutputTokens = min(max(tokens, 1), 4_096)
        }
        if let raw = defaults.string(forKey: toolChoiceKey),
           let choice = LiveToolChoice(rawValue: raw) {
            config.toolChoice = choice
        }
        if defaults.object(forKey: parallelToolCallsEnabledKey) != nil {
            config.parallelToolCallsEnabled = defaults.bool(forKey: parallelToolCallsEnabledKey)
        }
        if let raw = defaults.string(forKey: realtimeVoiceKey),
           let voice = LiveRealtimeVoice(rawValue: raw) {
            config.realtimeVoice = voice
        }
        if let raw = defaults.string(forKey: noiseReductionKey),
           let reduction = LiveNoiseReduction(rawValue: raw) {
            config.noiseReduction = reduction
        }
        if let raw = defaults.string(forKey: audioOutputDestinationKey),
           let destination = LiveAudioOutputDestination(rawValue: raw) {
            config.audioOutputDestination = destination
        }
        // One-time migration: tools + bridge defaults flipped to ON. Older
        // installs may carry a stale persisted `false` (often never deliberately
        // set) that would otherwise defeat the new default and silently break the
        // realtime→Hawky→Slack path. Clear those stale `false`s once so the
        // default takes effect; a user can still turn them off afterward (which
        // re-persists `false` and survives, since the migration only runs once).
        let liveDefaultsOnMigrationKey = "live.toolsAndBridge.defaultOnMigrated.v2"
        if !defaults.bool(forKey: liveDefaultsOnMigrationKey) {
            for key in [toolsEnabledKey, gatewayBridgeEnabledKey] {
                if defaults.object(forKey: key) != nil && defaults.bool(forKey: key) == false {
                    defaults.removeObject(forKey: key)
                }
            }
            defaults.set(true, forKey: liveDefaultsOnMigrationKey)
        }
        if defaults.object(forKey: toolsEnabledKey) != nil {
            config.toolsEnabled = defaults.bool(forKey: toolsEnabledKey)
        }
        if defaults.object(forKey: gatewayBridgeEnabledKey) != nil {
            config.gatewayBridgeEnabled = defaults.bool(forKey: gatewayBridgeEnabledKey)
        }
        if defaults.object(forKey: gatewayBridgeRequiredKey) != nil {
            config.gatewayBridgeRequired = defaults.bool(forKey: gatewayBridgeRequiredKey)
        }
        if defaults.object(forKey: voiceprintRealtimeEnabledKey) != nil {
            config.voiceprintRealtimeEnabled = defaults.bool(forKey: voiceprintRealtimeEnabledKey)
        }
        if defaults.object(forKey: cocktailPartyEnabledKey) != nil {
            config.cocktailPartyEnabled = defaults.bool(forKey: cocktailPartyEnabledKey)
        }
        if defaults.object(forKey: speakOnlyWhenSpokenToKey) != nil {
            config.speakOnlyWhenSpokenTo = defaults.bool(forKey: speakOnlyWhenSpokenToKey)
        }
        if defaults.object(forKey: safetyCheckEnabledKey) != nil {
            config.safetyCheckEnabled = defaults.bool(forKey: safetyCheckEnabledKey)
        }
        if let raw = defaults.string(forKey: gatewayBridgeSessionModeKey),
           let mode = LiveGatewayBridgeSessionMode(rawValue: raw) {
            config.gatewayBridgeSessionMode = mode
        }
        config.gatewayBridgeSessionKey = defaults.string(forKey: gatewayBridgeSessionKeyKey) ?? ""
        if config.gatewayBridgeSessionMode == .fixed,
           config.gatewayBridgeSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            config.gatewayBridgeSessionKey = "realtime:main"
        }
        if let raw = defaults.string(forKey: gatewayBridgeFeedModeKey),
           let mode = LiveGatewayBridgeFeedMode(rawValue: raw) {
            config.gatewayBridgeFeedMode = mode
        }
        if let raw = defaults.string(forKey: openingBehaviorKey),
           let behavior = LiveOpeningBehavior(rawValue: raw) {
            config.openingBehavior = behavior
        }
        if defaults.object(forKey: inputTranscriptionEnabledKey) != nil {
            config.inputTranscriptionEnabled = defaults.bool(forKey: inputTranscriptionEnabledKey)
        }
        config.inputTranscriptionModel = defaults.string(forKey: inputTranscriptionModelKey) ?? config.inputTranscriptionModel
        if defaults.object(forKey: outputTranscriptionEnabledKey) != nil {
            config.outputTranscriptionEnabled = defaults.bool(forKey: outputTranscriptionEnabledKey)
        }
        if defaults.object(forKey: showSystemMessagesKey) != nil {
            config.showSystemMessages = defaults.bool(forKey: showSystemMessagesKey)
        }
        if let raw = defaults.string(forKey: diagnosticsLevelKey),
           let level = LiveDiagnosticsLevel(rawValue: raw) {
            config.diagnosticsLevel = level
        }
        if defaults.object(forKey: showVisualFramesInTranscriptKey) != nil {
            config.showVisualFramesInTranscript = defaults.bool(forKey: showVisualFramesInTranscriptKey)
        }
        if defaults.object(forKey: visualDedupEnabledKey) != nil {
            config.visualDedupEnabled = defaults.bool(forKey: visualDedupEnabledKey)
        }
        if defaults.object(forKey: keepRunningOffscreenKey) != nil {
            config.keepRunningOffscreen = defaults.bool(forKey: keepRunningOffscreenKey)
        }
        if let raw = defaults.string(forKey: lockScreenModeKey),
           let mode = LiveLockScreenMode(rawValue: raw) {
            config.lockScreenMode = mode
        }
        if defaults.object(forKey: echoCancellationEnabledKey) != nil {
            config.echoCancellationEnabled = defaults.bool(forKey: echoCancellationEnabledKey)
        }
        if config.provider == .openAIRealtime {
            config.openAICredentialMode = .directAPIKey
            config.responseModality = .audio
            config.openingBehavior = .silent
        }
        // One-time default fill for OpenAI Realtime installs that do not have an
        // explicit "Save Live media" setting yet. Preserve any saved value,
        // including .off, because that may be a deliberate privacy choice.
        if !defaults.bool(forKey: mediaPersistenceUnforcedMigrationKey) {
            if config.provider == .openAIRealtime, storedMediaPersistenceMode == nil {
                config.mediaPersistenceMode = .local
                defaults.set(config.mediaPersistenceMode.rawValue, forKey: mediaPersistenceModeKey)
            }
            defaults.set(true, forKey: mediaPersistenceUnforcedMigrationKey)
        }
        return config
    }

    static func save(_ config: LiveSessionConfig, defaults: UserDefaults = .standard) {
        defaults.set(config.provider.rawValue, forKey: providerKey)
        defaults.set(config.model, forKey: modelKey)
        defaults.set(config.openAICredentialMode.rawValue, forKey: openAICredentialModeKey)
        defaults.set(config.openAIModelPreset.rawValue, forKey: openAIModelPresetKey)
        defaults.set(config.sessionBrokerURL, forKey: brokerKey)
        defaults.set(config.customEndpointURL, forKey: customEndpointKey)
        defaults.set(config.customDialect, forKey: customDialectKey)
        defaults.set(config.audioInputEnabled, forKey: audioInputEnabledKey)
        defaults.set(config.audioSource.rawValue, forKey: audioSourceKey)
        defaults.set(config.visualSource.rawValue, forKey: visualSourceKey)
        defaults.set(config.visualCadence.rawValue, forKey: visualCadenceKey)
        defaults.set(config.customVisualFPS, forKey: customVisualFPSKey)
        defaults.set(config.visualDedupEnabled, forKey: visualDedupEnabledKey)
        defaults.set(config.cameraPosition.rawValue, forKey: cameraPositionKey)
        defaults.set(config.mediaPersistenceMode.rawValue, forKey: mediaPersistenceModeKey)
        defaults.set(config.turnDetectionMode.rawValue, forKey: turnDetectionModeKey)
        defaults.set(config.vadThreshold, forKey: vadThresholdKey)
        defaults.set(config.vadPrefixPaddingMs, forKey: vadPrefixPaddingMsKey)
        defaults.set(config.vadSilenceDurationMs, forKey: vadSilenceDurationMsKey)
        defaults.set(config.vadCreateResponse, forKey: vadCreateResponseKey)
        defaults.set(config.vadInterruptResponse, forKey: vadInterruptResponseKey)
        defaults.set(config.bargeInPolicy.rawValue, forKey: bargeInPolicyKey)
        defaults.set(config.vadIdleTimeoutEnabled, forKey: vadIdleTimeoutEnabledKey)
        defaults.set(config.vadIdleTimeoutMs, forKey: vadIdleTimeoutMsKey)
        defaults.set(config.semanticVADEagerness.rawValue, forKey: semanticVADEagernessKey)
        defaults.set(config.mode.rawValue, forKey: ambientModeKey)
        defaults.set(config.promptPreset.rawValue, forKey: promptPresetKey)
        defaults.set(config.customPrompt, forKey: customPromptKey)
        defaults.set(config.selectedPromptID, forKey: selectedPromptIDKey)
        defaults.set(config.promptTitle, forKey: promptTitleKey)
        defaults.set(config.promptInstructions, forKey: promptInstructionsKey)
        defaults.set(config.responseModality.rawValue, forKey: responseModalityKey)
        defaults.set(config.reasoningEffort.rawValue, forKey: reasoningEffortKey)
        if let maxResponseOutputTokens = config.maxResponseOutputTokens {
            defaults.set(maxResponseOutputTokens, forKey: maxResponseOutputTokensKey)
        } else {
            defaults.removeObject(forKey: maxResponseOutputTokensKey)
        }
        defaults.set(config.toolChoice.rawValue, forKey: toolChoiceKey)
        defaults.set(config.parallelToolCallsEnabled, forKey: parallelToolCallsEnabledKey)
        defaults.set(config.realtimeVoice.rawValue, forKey: realtimeVoiceKey)
        defaults.set(config.noiseReduction.rawValue, forKey: noiseReductionKey)
        defaults.set(config.audioOutputDestination.rawValue, forKey: audioOutputDestinationKey)
        defaults.set(config.toolsEnabled, forKey: toolsEnabledKey)
        defaults.set(config.gatewayBridgeEnabled, forKey: gatewayBridgeEnabledKey)
        defaults.set(config.gatewayBridgeRequired, forKey: gatewayBridgeRequiredKey)
        defaults.set(config.voiceprintRealtimeEnabled, forKey: voiceprintRealtimeEnabledKey)
        defaults.set(config.cocktailPartyEnabled, forKey: cocktailPartyEnabledKey)
        defaults.set(config.speakOnlyWhenSpokenTo, forKey: speakOnlyWhenSpokenToKey)
        defaults.set(config.safetyCheckEnabled, forKey: safetyCheckEnabledKey)
        defaults.set(config.gatewayBridgeSessionMode.rawValue, forKey: gatewayBridgeSessionModeKey)
        defaults.set(config.gatewayBridgeSessionKey, forKey: gatewayBridgeSessionKeyKey)
        defaults.set(config.gatewayBridgeFeedMode.rawValue, forKey: gatewayBridgeFeedModeKey)
        defaults.set(config.openingBehavior.rawValue, forKey: openingBehaviorKey)
        defaults.set(config.inputTranscriptionEnabled, forKey: inputTranscriptionEnabledKey)
        defaults.set(config.inputTranscriptionModel, forKey: inputTranscriptionModelKey)
        defaults.set(config.outputTranscriptionEnabled, forKey: outputTranscriptionEnabledKey)
        defaults.set(config.keepRunningOffscreen, forKey: keepRunningOffscreenKey)
        defaults.set(config.lockScreenMode.rawValue, forKey: lockScreenModeKey)
        defaults.set(config.showSystemMessages, forKey: showSystemMessagesKey)
        defaults.set(config.diagnosticsLevel.rawValue, forKey: diagnosticsLevelKey)
        defaults.set(config.echoCancellationEnabled, forKey: echoCancellationEnabledKey)
        defaults.set(config.showVisualFramesInTranscript, forKey: showVisualFramesInTranscriptKey)
    }
}

enum LiveSessionArchive {
    private static let sessionsKey = "live.localSessions"
    private static let currentSessionIDKey = "live.currentSessionID"
    private static let metadataFileName = "sessions.json"

    private struct LiveLocalSessionMetadata: Codable {
        var id: UUID
        var title: String
        var createdAt: Date
        var updatedAt: Date
        var isBookmarked: Bool
        var isArchived: Bool

        init(_ session: LiveLocalSession) {
            id = session.id
            title = session.title
            createdAt = session.createdAt
            updatedAt = session.updatedAt
            isBookmarked = session.isBookmarked
            isArchived = session.isArchived
        }

        func session(conversation: [LiveConversationEntry] = []) -> LiveLocalSession {
            LiveLocalSession(
                id: id,
                title: title,
                createdAt: createdAt,
                updatedAt: updatedAt,
                isBookmarked: isBookmarked,
                isArchived: isArchived,
                conversation: conversation
            )
        }
    }

    private struct LiveSessionJournalLine: Codable {
        var kind: String
        var sessionID: UUID
        var sessionTitle: String?
        var date: Date
        var entry: LiveConversationEntry?
        var rawEntry: LiveRawLogEntry?
    }

    static func load(defaults: UserDefaults = .standard) -> [LiveLocalSession] {
        if let metadata = loadMetadataFile() {
            return metadata
                .map { item in
                    item.session(conversation: loadConversation(sessionID: item.id))
                }
                .map(normalizedActivityDate)
                .sorted { $0.updatedAt > $1.updatedAt }
        }

        guard let data = defaults.data(forKey: sessionsKey),
              let sessions = try? JSONDecoder().decode([LiveLocalSession].self, from: data) else {
            return []
        }
        let normalized = sessions
            .map(normalizedActivityDate)
            .sorted { $0.updatedAt > $1.updatedAt }
        normalized.forEach { replaceConversation($0.conversation, for: $0) }
        save(normalized, defaults: defaults)
        return normalized
    }

    static func loadSummaries(defaults: UserDefaults = .standard) -> [LiveLocalSession] {
        if let metadata = loadMetadataFile() {
            return metadata
                .map { $0.session() }
                .sorted { $0.updatedAt > $1.updatedAt }
        }

        return load(defaults: defaults)
    }

    static func save(_ sessions: [LiveLocalSession], defaults: UserDefaults = .standard) {
        saveMetadata(sessions)
        defaults.removeObject(forKey: sessionsKey)
    }

    static func replaceConversation(_ conversation: [LiveConversationEntry], for session: LiveLocalSession) {
        let url = journalURL(for: session.id)
        try? FileManager.default.createDirectory(at: archiveDirectory(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: url)
        conversation.forEach { append(entry: $0, to: session) }
    }

    static func append(entry: LiveConversationEntry, to session: LiveLocalSession) {
        let line = LiveSessionJournalLine(
            kind: "conversation.entry",
            sessionID: session.id,
            sessionTitle: session.title,
            date: entry.date,
            entry: entry,
            rawEntry: nil
        )
        append(line: line, to: session.id)
    }

    static func append(rawEntry: LiveRawLogEntry, to session: LiveLocalSession) {
        let line = LiveSessionJournalLine(
            kind: "raw.event",
            sessionID: session.id,
            sessionTitle: session.title,
            date: rawEntry.date,
            entry: nil,
            rawEntry: rawEntry
        )
        append(line: line, to: session.id, raw: true)
    }

    static func exportDisplayJSONL(for session: LiveLocalSession) -> URL? {
        let source = journalURL(for: session.id)
        if FileManager.default.fileExists(atPath: source.path) {
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("live-session-\(session.id.uuidString.lowercased())-display.jsonl")
            return copyFilteredJSONL(from: source, to: url, kind: "conversation.entry")
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-session-\(session.id.uuidString.lowercased())-display.jsonl")
        let lines = session.conversation.compactMap { entry -> String? in
            let line = LiveSessionJournalLine(
                kind: "conversation.entry",
                sessionID: session.id,
                sessionTitle: session.title,
                date: entry.date,
                entry: entry,
                rawEntry: nil
            )
            guard let data = try? lineEncoder.encode(line),
                  let string = String(data: data, encoding: .utf8) else {
                return nil
            }
            return string
        }
        do {
            try (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }

    static func exportRawJSONL(for session: LiveLocalSession) -> URL? {
        exportRawBundle(for: session)?.archiveURL
    }

    static func exportRawBundle(for session: LiveLocalSession) -> LiveSessionExportBundle? {
        let transcriptSource = journalURL(for: session.id)
        let rawSource = rawJournalURL(for: session.id)
        let exportDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-session-\(session.id.uuidString.lowercased())-export", isDirectory: true)
        let archiveURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-session-\(session.id.uuidString.lowercased())-export.zip")
        let manifestURL = exportDirectory.appendingPathComponent("manifest.json")
        let transcriptJSONLURL = exportDirectory.appendingPathComponent("transcript.jsonl")
        let transcriptTextURL = exportDirectory.appendingPathComponent("transcript.txt")
        let rawEventsURL = exportDirectory.appendingPathComponent("raw-events.jsonl")
        try? FileManager.default.removeItem(at: exportDirectory)
        try? FileManager.default.removeItem(at: archiveURL)
        try? FileManager.default.createDirectory(at: exportDirectory, withIntermediateDirectories: true)

        let transcriptEntries = exportConversationEntries(from: transcriptSource, fallback: session.conversation)
        guard writeTranscriptJSONL(transcriptEntries, to: transcriptJSONLURL) != nil,
              writeTranscriptText(transcriptEntries, session: session, to: transcriptTextURL) != nil else {
            return nil
        }

        var files = ["manifest.json", "transcript.jsonl", "transcript.txt"]
        var rawEventCount = 0
        if FileManager.default.fileExists(atPath: rawSource.path) {
            rawEventCount = writeRawEventJSONL(from: rawSource, to: rawEventsURL) ?? 0
            if rawEventCount > 0 {
                files.append("raw-events.jsonl")
            } else {
                try? FileManager.default.removeItem(at: rawEventsURL)
            }
        }

        let warnings = exportWarnings(for: session, entries: transcriptEntries, rawEventCount: rawEventCount)
        let manifest = exportManifest(
            for: session,
            entries: transcriptEntries,
            rawEventCount: rawEventCount,
            files: files,
            warnings: warnings
        )
        guard writePrettyJSON(manifest, to: manifestURL) != nil else {
            return nil
        }
        do {
            try LocalZipArchive.zipDirectory(at: exportDirectory, to: archiveURL)
            return LiveSessionExportBundle(archiveURL: archiveURL, previewURL: exportDirectory)
        } catch {
            return nil
        }
    }

    static func loadCurrentSessionID(defaults: UserDefaults = .standard) -> UUID? {
        guard let raw = defaults.string(forKey: currentSessionIDKey) else { return nil }
        return UUID(uuidString: raw)
    }

    static func saveCurrentSessionID(_ id: UUID, defaults: UserDefaults = .standard) {
        defaults.set(id.uuidString, forKey: currentSessionIDKey)
    }

    private static func normalizedActivityDate(_ session: LiveLocalSession) -> LiveLocalSession {
        var normalized = session
        normalized.updatedAt = session.conversation.map(\.date).max() ?? session.createdAt
        return normalized
    }

    private static var lineEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static var lineDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static func archiveDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("LiveSessions", isDirectory: true)
    }

    private static func metadataURL() -> URL {
        archiveDirectory().appendingPathComponent(metadataFileName)
    }

    private static func journalURL(for sessionID: UUID) -> URL {
        archiveDirectory().appendingPathComponent("\(sessionID.uuidString.lowercased()).jsonl")
    }

    private static func rawJournalURL(for sessionID: UUID) -> URL {
        archiveDirectory().appendingPathComponent("\(sessionID.uuidString.lowercased())-raw.jsonl")
    }

    private static func loadMetadataFile() -> [LiveLocalSessionMetadata]? {
        let url = metadataURL()
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode([LiveLocalSessionMetadata].self, from: data)
    }

    private static func saveMetadata(_ sessions: [LiveLocalSession]) {
        let metadata = sessions.map(LiveLocalSessionMetadata.init)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(metadata) else { return }
        try? FileManager.default.createDirectory(at: archiveDirectory(), withIntermediateDirectories: true)
        try? data.write(to: metadataURL(), options: .atomic)
    }

    /// Upper bound on how many bytes of a session journal we read back. Reading
    /// the whole file on the @MainActor init path tripped the 0x8BADF00D
    /// watchdog once legacy journals grew to tens of MB. We only ever display
    /// the most recent entries (trimConversation caps the array), so reading the
    /// tail is both sufficient and self-healing for oversized legacy files.
    private static let maxJournalReadBytes = 4 * 1024 * 1024

    /// Read at most `maxJournalReadBytes` from the end of the journal, starting
    /// at a clean line boundary (drops the partial first line). A leading `\n`
    /// can never split a UTF-8 multibyte sequence, so the remainder decodes
    /// cleanly.
    private static func readJournalTail(at url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        if size <= UInt64(maxJournalReadBytes) {
            try? handle.seek(toOffset: 0)
            guard let data = try? handle.readToEnd() else { return nil }
            return String(data: data, encoding: .utf8)
        }
        try? handle.seek(toOffset: size - UInt64(maxJournalReadBytes))
        guard let data = try? handle.readToEnd() else { return nil }
        if let newline = data.firstIndex(of: 0x0A) {
            return String(data: Data(data[(newline + 1)...]), encoding: .utf8)
        }
        return String(data: data, encoding: .utf8)
    }

    static func loadConversation(sessionID: UUID) -> [LiveConversationEntry] {
        let url = journalURL(for: sessionID)
        guard let text = readJournalTail(at: url) else { return [] }
        var entriesByID: [UUID: LiveConversationEntry] = [:]
        var orderedIDs: [UUID] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = line.data(using: .utf8),
                  let journalLine = try? lineDecoder.decode(LiveSessionJournalLine.self, from: data),
                  journalLine.kind == "conversation.entry",
                  let entry = journalLine.entry else {
                continue
            }
            if entriesByID[entry.id] == nil {
                orderedIDs.append(entry.id)
            }
            entriesByID[entry.id] = entry
        }
        return orderedIDs.compactMap { entriesByID[$0] }
    }

    private static func append(line: LiveSessionJournalLine, to sessionID: UUID, raw: Bool = false) {
        try? FileManager.default.createDirectory(at: archiveDirectory(), withIntermediateDirectories: true)
        guard let data = try? lineEncoder.encode(line) else { return }
        let url = raw ? rawJournalURL(for: sessionID) : journalURL(for: sessionID)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
        try? handle.write(contentsOf: Data("\n".utf8))
    }

    private static func copyFilteredJSONL(from source: URL, to destination: URL, kind: String) -> URL? {
        guard let text = try? String(contentsOf: source, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line -> String? in
            guard let data = line.data(using: .utf8),
                  let journalLine = try? lineDecoder.decode(LiveSessionJournalLine.self, from: data),
                  journalLine.kind == kind else {
                return nil
            }
            return String(line)
        }
        do {
            try (lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n"))
                .write(to: destination, atomically: true, encoding: .utf8)
            return destination
        } catch {
            return nil
        }
    }

    private static func exportConversationEntries(from source: URL, fallback: [LiveConversationEntry]) -> [LiveConversationEntry] {
        guard let text = try? String(contentsOf: source, encoding: .utf8) else { return fallback }
        var entriesByID: [UUID: LiveConversationEntry] = [:]
        var orderedIDs: [UUID] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = line.data(using: .utf8),
                  let journalLine = try? lineDecoder.decode(LiveSessionJournalLine.self, from: data),
                  journalLine.kind == "conversation.entry",
                  let entry = journalLine.entry else {
                continue
            }
            if entriesByID[entry.id] == nil {
                orderedIDs.append(entry.id)
            }
            entriesByID[entry.id] = entry
        }
        let entries = orderedIDs.compactMap { entriesByID[$0] }
        return entries.isEmpty ? fallback : entries
    }

    private static func writeTranscriptJSONL(_ entries: [LiveConversationEntry], to destination: URL) -> URL? {
        let lines = entries.compactMap { entry -> String? in
            let line = transcriptExportLine(for: entry)
            guard let data = try? lineEncoder.encode(line),
                  let text = String(data: data, encoding: .utf8) else {
                return nil
            }
            return text
        }
        do {
            try (lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n"))
                .write(to: destination, atomically: true, encoding: .utf8)
            return destination
        } catch {
            return nil
        }
    }

    private static func writeTranscriptText(
        _ entries: [LiveConversationEntry],
        session: LiveLocalSession,
        to destination: URL
    ) -> URL? {
        let formatter = ISO8601DateFormatter()
        var chunks: [String] = [
            session.title,
            "Session: \(session.id.uuidString)",
            "Created: \(formatter.string(from: session.createdAt))",
            "Updated: \(formatter.string(from: session.updatedAt))",
            ""
        ]
        for entry in entries {
            let role = entry.role.rawValue.uppercased()
            let timestamp = formatter.string(from: entry.date)
            let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayText = text.isEmpty ? "[no transcript text captured]" : text
            chunks.append("[\(timestamp)] \(role): \(displayText)")
            if let eventType = entry.eventType, !eventType.isEmpty {
                chunks.append("  event: \(eventType)")
            }
            if let detail = entry.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
                chunks.append("  detail: \(detail)")
            }
            chunks.append("")
        }
        do {
            try chunks.joined(separator: "\n").write(to: destination, atomically: true, encoding: .utf8)
            return destination
        } catch {
            return nil
        }
    }

    private static func writeRawEventJSONL(from source: URL, to destination: URL) -> Int? {
        guard let text = try? String(contentsOf: source, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line -> String? in
            guard let data = line.data(using: .utf8),
                  let journalLine = try? lineDecoder.decode(LiveSessionJournalLine.self, from: data),
                  journalLine.kind == "raw.event",
                  let rawEntry = journalLine.rawEntry else {
                return nil
            }
            return rawExportLine(rawEntry: rawEntry, journalLine: journalLine)
        }
        do {
            try (lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n"))
                .write(to: destination, atomically: true, encoding: .utf8)
            return lines.count
        } catch {
            return nil
        }
    }

    private static func transcriptExportLine(for entry: LiveConversationEntry) -> LiveSessionTranscriptExportLine {
        let trimmed = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return LiveSessionTranscriptExportLine(
            timestamp: entry.date,
            role: entry.role.rawValue,
            text: trimmed,
            eventType: entry.eventType,
            level: entry.level.rawValue,
            phase: entry.phase,
            source: "live.transcript",
            transcriptionStatus: transcriptionStatus(for: entry, trimmedText: trimmed),
            detail: entry.detail,
            toolCall: entry.toolCall
        )
    }

    private static func transcriptionStatus(for entry: LiveConversationEntry, trimmedText: String) -> String? {
        guard entry.role == .user else { return nil }
        if trimmedText.isEmpty {
            return "unavailable"
        }
        if let eventType = entry.eventType, eventType.contains("transcription") {
            return "final"
        }
        return "text"
    }

    private static func exportManifest(
        for session: LiveLocalSession,
        entries: [LiveConversationEntry],
        rawEventCount: Int,
        files: [String],
        warnings: [String]
    ) -> LiveSessionExportManifest {
        LiveSessionExportManifest(
            version: 1,
            exportedAt: Date(),
            sessionID: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            transcriptEntries: entries.count,
            userEntries: entries.filter { $0.role == .user }.count,
            assistantEntries: entries.filter { $0.role == .assistant }.count,
            toolEntries: entries.filter { $0.role == .tool }.count,
            systemEntries: entries.filter { $0.role == .system }.count,
            rawEvents: rawEventCount,
            files: files,
            warnings: warnings
        )
    }

    private static func exportWarnings(
        for session: LiveLocalSession,
        entries: [LiveConversationEntry],
        rawEventCount: Int
    ) -> [String] {
        var warnings: [String] = []
        if entries.isEmpty {
            warnings.append("No transcript entries were captured for this Live session.")
        }
        if entries.contains(where: { $0.role == .user && $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            warnings.append("One or more spoken user turns have no transcription text.")
        }
        if entries.contains(where: { $0.role == .assistant }) && !entries.contains(where: { $0.role == .user && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            warnings.append("Assistant turns exist, but no non-empty user transcript turns were captured.")
        }
        if rawEventCount == 0 {
            warnings.append("No provider raw events were captured; transcript.jsonl is the authoritative export.")
        }
        if session.conversation.count > entries.count {
            warnings.append("The persisted transcript journal was shorter than the in-memory session snapshot.")
        }
        return warnings
    }

    private static func writePrettyJSON<T: Encodable>(_ value: T, to destination: URL) -> URL? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(value)
            try data.write(to: destination, options: .atomic)
            return destination
        } catch {
            return nil
        }
    }

    private static func rawExportLine(rawEntry: LiveRawLogEntry, journalLine: LiveSessionJournalLine) -> String? {
        var event: [String: Any] = [:]
        if let data = rawEntry.json.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            event = object
        } else {
            event = ["raw": rawEntry.json]
        }
        if event["type"] == nil {
            event["type"] = rawEntry.type
        }
        event["_gateway"] = [
            "archive_event_id": rawEntry.id.uuidString,
            "direction": rawEntry.direction.rawValue,
            "observed_at": ISO8601DateFormatter().string(from: rawEntry.date),
            "provider": rawEntry.provider,
            "session_id": journalLine.sessionID.uuidString,
            "source": "live.raw_export"
        ]
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }
        return string
    }

}

private enum LocalZipArchive {
    private struct Entry {
        var url: URL
        var path: String
        var isDirectory: Bool
    }

    private struct CentralDirectoryEntry {
        var pathData: Data
        var crc32: UInt32
        var size: UInt32
        var offset: UInt32
        var dosTime: UInt16
        var dosDate: UInt16
        var isDirectory: Bool
    }

    static func zipDirectory(at sourceURL: URL, to destinationURL: URL) throws {
        let rootName = sourceURL.lastPathComponent.isEmpty ? "export" : sourceURL.lastPathComponent
        let entries = try directoryEntries(at: sourceURL, rootName: rootName)
        var output = Data()
        var centralDirectory: [CentralDirectoryEntry] = []

        for entry in entries {
            let pathData = Data(entry.path.utf8)
            let payload = entry.isDirectory ? Data() : try Data(contentsOf: entry.url)
            let crc = entry.isDirectory ? 0 : CRC32.checksum(payload)
            let size = UInt32(payload.count)
            let offset = UInt32(output.count)
            let stamp = dosDateTime(for: entry.url)

            output.appendUInt32(0x04034b50)
            output.appendUInt16(20)
            output.appendUInt16(0)
            output.appendUInt16(0)
            output.appendUInt16(stamp.time)
            output.appendUInt16(stamp.date)
            output.appendUInt32(crc)
            output.appendUInt32(size)
            output.appendUInt32(size)
            output.appendUInt16(UInt16(pathData.count))
            output.appendUInt16(0)
            output.append(pathData)
            output.append(payload)

            centralDirectory.append(CentralDirectoryEntry(
                pathData: pathData,
                crc32: crc,
                size: size,
                offset: offset,
                dosTime: stamp.time,
                dosDate: stamp.date,
                isDirectory: entry.isDirectory
            ))
        }

        let centralOffset = UInt32(output.count)
        for entry in centralDirectory {
            output.appendUInt32(0x02014b50)
            output.appendUInt16(20)
            output.appendUInt16(20)
            output.appendUInt16(0)
            output.appendUInt16(0)
            output.appendUInt16(entry.dosTime)
            output.appendUInt16(entry.dosDate)
            output.appendUInt32(entry.crc32)
            output.appendUInt32(entry.size)
            output.appendUInt32(entry.size)
            output.appendUInt16(UInt16(entry.pathData.count))
            output.appendUInt16(0)
            output.appendUInt16(0)
            output.appendUInt16(0)
            output.appendUInt16(0)
            output.appendUInt32(entry.isDirectory ? 0x10 : 0)
            output.appendUInt32(entry.offset)
            output.append(entry.pathData)
        }
        let centralSize = UInt32(output.count) - centralOffset

        output.appendUInt32(0x06054b50)
        output.appendUInt16(0)
        output.appendUInt16(0)
        output.appendUInt16(UInt16(centralDirectory.count))
        output.appendUInt16(UInt16(centralDirectory.count))
        output.appendUInt32(centralSize)
        output.appendUInt32(centralOffset)
        output.appendUInt16(0)

        try output.write(to: destinationURL, options: .atomic)
    }

    private static func directoryEntries(at sourceURL: URL, rootName: String) throws -> [Entry] {
        var entries = [Entry(url: sourceURL, path: "\(rootName)/", isDirectory: true)]
        let children = try FileManager.default.contentsOfDirectory(
            at: sourceURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            entries.append(contentsOf: try directoryEntries(at: child, prefix: "\(rootName)/"))
        }
        return entries
    }

    private static func directoryEntries(at url: URL, prefix: String) throws -> [Entry] {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey])
        let isDirectory = values.isDirectory == true
        let path = prefix + url.lastPathComponent + (isDirectory ? "/" : "")
        var entries = [Entry(url: url, path: path, isDirectory: isDirectory)]
        guard isDirectory else { return entries }

        let children = try FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            entries.append(contentsOf: try directoryEntries(at: child, prefix: path))
        }
        return entries
    }

    private static func dosDateTime(for url: URL) -> (date: UInt16, time: UInt16) {
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
        let components = Calendar(identifier: .gregorian).dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: modified
        )
        // Intermediate Int locals: folding the whole DOS-time packing into one
        // UInt16(...) expression tripped the Swift type-checker's "unable to
        // type-check in reasonable time" heuristic. Splitting it keeps the same
        // math but lets inference resolve quickly.
        let year = max(components.year ?? 1980, 1980)
        let month = components.month ?? 1
        let day = components.day ?? 1
        let hour = components.hour ?? 0
        let minute = components.minute ?? 0
        let second = components.second ?? 0
        let datePacked: Int = ((year - 1980) << 9) | (month << 5) | day
        let timePacked: Int = (hour << 11) | (minute << 5) | (second / 2)
        return (UInt16(datePacked), UInt16(timePacked))
    }
}

private enum CRC32 {
    private static let table: [UInt32] = (0..<256).map { value in
        var crc = UInt32(value)
        for _ in 0..<8 {
            if crc & 1 == 1 {
                crc = 0xedb88320 ^ (crc >> 1)
            } else {
                crc >>= 1
            }
        }
        return crc
    }

    static func checksum(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data {
            let index = Int((crc ^ UInt32(byte)) & 0xff)
            crc = table[index] ^ (crc >> 8)
        }
        return crc ^ 0xffffffff
    }
}

private extension Data {
    mutating func appendUInt16(_ value: UInt16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }

    mutating func appendUInt32(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

enum LiveDiagnosticsLevel: String, CaseIterable, Identifiable, Codable, Equatable {
    case off
    case basic
    case verbose

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off: return "Off"
        case .basic: return "Basic"
        case .verbose: return "Verbose"
        }
    }
}
