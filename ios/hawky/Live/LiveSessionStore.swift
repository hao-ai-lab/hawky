import Foundation
import ActivityKit
import AVFoundation
import CoreLocation
import MapKit
import Observation
import os
import SwiftUI
import UserNotifications
import WidgetKit

/// #481 where-reminder diagnostics. Visible in the device unified log regardless
/// of the in-app diagnostics setting (in-app append() is gated + capped at 40).
/// Stream with: log stream --predicate 'subsystem == "live.hawky" && category == "AmbientWhere"'
private let ambientWhereLog = Logger(subsystem: "live.hawky", category: "AmbientWhere")

enum SafetyCheckCopy {
    static let enabledMessage = "Safety Check on — watching for hazards."
}

/// Keeps the freshest captured camera frame for explicit media tools. This is
/// intentionally separate from the realtime visual send path because static
/// scene dedupe may suppress frames that "send a photo" still needs.
struct LiveToolCameraFrameCache {
    private var latest: (frame: LiveJPEGFrame, capturedAtNs: UInt64)?

    mutating func record(_ frame: LiveJPEGFrame, capturedAtNs: UInt64) {
        latest = (frame, capturedAtNs)
    }

    mutating func clear() {
        latest = nil
    }

    func freshFrame(isStreamingVisual: Bool, nowNs: UInt64, maxAgeNs: UInt64) -> LiveJPEGFrame? {
        guard isStreamingVisual,
              let latest,
              nowNs >= latest.capturedAtNs,
              nowNs - latest.capturedAtNs <= maxAgeNs else {
            return nil
        }
        return latest.frame
    }
}

/// Why a Live session can't be started right now. Surfaced to the UI so a tap
/// on the (no-longer-disabled) start button can explain the blocker instead of
/// silently doing nothing. Reading it is non-destructive — it never touches
/// `phase`, unlike `start()` which sets `.failed` once the user commits.
enum LiveStartBlock: Equatable {
    /// OpenAI Realtime is selected but no Direct API key is saved on this device.
    case missingOpenAIKey
    /// The selected provider has no working adapter yet (Gemini / Custom).
    case providerUnavailable(String)

    var message: String {
        switch self {
        case .missingOpenAIKey:
            return "OpenAI Realtime needs a Direct OpenAI API key saved on this iPhone."
        case .providerUnavailable(let detail):
            return detail
        }
    }

    /// Whether the blocker is fixable in Live Settings, so the alert can offer a
    /// shortcut there. Only the missing-key case has a setting to fill in.
    var isFixableInSettings: Bool {
        if case .missingOpenAIKey = self { return true }
        return false
    }
}

/// A user-facing error/blocked-action message, surfaced as the centered glass
/// dialog on the Live stage. This is the general channel any code path can use
/// to explain why an action didn't happen (instead of silently no-oping or
/// burying it in the transcript): set `LiveSessionStore.pendingUserAlert` via
/// `presentUserAlert(_:)`. The view renders whatever is pending.
struct LiveUserAlert: Identifiable, Equatable {
    let id: UUID
    var title: String
    var message: String
    /// Offer a shortcut into Live Settings (e.g. to enter the API key).
    var opensSettings: Bool

    init(id: UUID = UUID(), title: String, message: String, opensSettings: Bool = false) {
        self.id = id
        self.title = title
        self.message = message
        self.opensSettings = opensSettings
    }

    /// Can't start a Live session — built from the precondition that blocked it.
    static func startBlocked(_ reason: LiveStartBlock) -> LiveUserAlert {
        LiveUserAlert(
            title: "Can't start Live",
            message: reason.message,
            opensSettings: reason.isFixableInSettings
        )
    }

    /// Tried to send a message with no connected session.
    static let notConnected = LiveUserAlert(
        title: "Not connected",
        message: "Start a Live session before sending a message."
    )

    /// A call / another app grabbed the mic mid-session, so Live auto-paused.
    static let micInterrupted = LiveUserAlert(
        title: "Live paused",
        message: "The microphone is in use by a call or another app. Tap the play button to resume Live when you're done."
    )

    /// The provider rejected our credentials on connect. `message` comes from the
    /// thrown `LiveSessionProviderError.authenticationFailed`, so the wording lives
    /// in one place (the classifier) rather than being duplicated here.
    static func authenticationRejected(_ message: String) -> LiveUserAlert {
        LiveUserAlert(title: "Can't start Live", message: message, opensSettings: true)
    }

    /// Connected, mic requested on, but no audio is actually being captured a few
    /// seconds in — almost always another app (a call / Google Meet) holding the
    /// microphone since before start, so no interruption event fired.
    static let micUnavailable = LiveUserAlert(
        title: "No audio detected",
        message: "Hawky isn't hearing anything — another app (a call or Google Meet) may be using the microphone. End that call, then stop and start Live again."
    )
}

/// In-flight streaming transcript text, separate from the committed
/// `conversation` array (#623). A streaming bubble observes its own entry via
/// `text[entryID]`, so a per-token delta re-renders only that bubble instead of
/// the whole O(n) list. `scrollTick` is bumped (throttled in the store) so the
/// transcript can auto-scroll while text streams without the array changing.
@MainActor
@Observable
final class LiveStreamingText {
    /// entry id → in-flight text. Keyed so concurrent realtime items don't
    /// cross-talk. An entry is "streaming" iff its id is present here.
    var text: [UUID: String] = [:]
    /// Bumped to drive auto-scroll while streaming (the array doesn't change).
    var scrollTick: Int = 0
}

@MainActor
@Observable
final class LiveSessionStore {
    // `config` is the editable DRAFT: the UI binds to it and `start()` uses it.
    // `activeConfig` is a frozen snapshot taken at start() that the RUNNING
    // session reads, so settings edited mid-session apply to the next session,
    // not the one in flight. Read the running session's effective settings via
    // `liveConfig` (snapshot while active, draft while idle). (Live lifecycle)
    private(set) var config: LiveSessionConfig
    private(set) var activeConfig: LiveSessionConfig?
    var liveConfig: LiveSessionConfig { activeConfig ?? config }
    private(set) var phase: LiveSessionPhase = .idle
    /// Gateway (your Hawky machine) reachability for the active session. Drives the
    /// prominent bridge-offline banner so an unreachable machine no longer produces a
    /// "Connected" session with silently dead memory + tools.
    private(set) var bridgeStatus: LiveBridgeStatus = .idle
    private(set) var diagnostics = LiveSessionDiagnostics()
    /// The pending user-facing error dialog, or nil when none is showing. Set
    /// via `presentUserAlert(_:)` from anywhere (button preflight, start()
    /// failure, async fire-and-forget) and rendered by `LiveView`. The general
    /// replacement for silent guard-returns.
    private(set) var pendingUserAlert: LiveUserAlert?
    /// Committed transcript backing store. While an entry streams its `text` is
    /// empty here — the in-flight text lives in `streamingText` and is merged by
    /// `transcript`. The VIEW pairs this (for row structure) with `streamingText`
    /// (for the live bubble); every other reader should use `transcript`. (#623)
    private(set) var conversation: [LiveConversationEntry] = []

    /// The logical transcript: committed entries with any in-flight streaming
    /// text merged in. The single canonical read for consumers (persistence,
    /// summary, export, history replay) so none of them see an empty in-flight
    /// `text`. Non-destructive (doesn't mutate `conversation`, so no view
    /// re-render). Do NOT use this from the transcript view — it changes every
    /// token and would re-defeat the per-bubble rendering. (#623)
    var transcript: [LiveConversationEntry] {
        guard !streamingText.text.isEmpty else { return conversation }
        return conversation.map { entry in
            guard let live = streamingText.text[entry.id] else { return entry }
            var merged = entry
            merged.text = live
            return merged
        }
    }

    // Session whose journal still needs decoding; consumed once by
    // loadInitialConversationIfNeeded(). See that method for why this is NOT
    // done in init(). (#580)
    @ObservationIgnored private var pendingInitialLoadSessionID: UUID?
    @ObservationIgnored private var didStartInitialLoad = false
    private(set) var localSessions: [LiveLocalSession] = []
    private(set) var promptProfiles: [LivePromptProfile] = []
    private(set) var currentSessionID = UUID()
    private(set) var eventLog: [LiveEventLogEntry] = []
    private(set) var isRecordingAudioSample = false
    private(set) var recordedAudioBytes = 0
    private(set) var isStreamingAudio = false
    private(set) var isStreamingVisual = false
    private(set) var hasDirectOpenAIAPIKey = false
    /// True while the Live session's audio/video streams are also being
    /// persisted + uploaded via `recordingSink` (the "record what Live is
    /// streaming" feature, #363).
    private(set) var isRecording = false

    /// Cocktail Party Mode (#627): per-frame face recognition + silent context /
    /// enroll. Non-nil only while the session is connected with the mode enabled.
    private var cocktailParty: CocktailPartyController? {
        didSet { cocktailPartyActive = cocktailParty != nil }
    }
    /// Observable mirror of whether Cocktail Party Mode is running (drives the UI).
    private(set) var cocktailPartyActive = false
    /// Safety Check (#648): hazard-watch controller. Non-nil only while connected with
    /// Safety Check enabled.
    private var safety: SafetyController? {
        didSet { safetyActive = safety != nil }
    }
    /// Observable mirror of whether Safety Check is running (drives the UI).
    private(set) var safetyActive = false
    /// A small ring of the most recent camera frame JPEGs (newest last). The
    /// identify/resolve tools try these in order until one has a usable face — a
    /// single latest frame often flickers to no-face/blurry, which caused spurious
    /// "no face on camera" failures when naming someone.
    private var recentCameraFrames: [Data] = []
    private let maxRecentCameraFrames = 6

    /// Stay Silent: while true the realtime model keeps listening + transcribing
    /// but does not speak/respond (automatic responses + tools disabled via a live
    /// session.update). On release we ask for one spoken recap of the window.
    private(set) var staySilentActive = false
    /// Wall-clock start of the current silent window (for the release summary).
    @ObservationIgnored private var silenceStartedAt: Date?
    /// Transcript/events captured while Stay Silent was on, used for the recap.
    @ObservationIgnored private var silenceTranscript: [(timestamp: Date, role: String, text: String)] = []
    /// Frames sent during the silent window (surfaced in the recap prompt).
    @ObservationIgnored private var silenceFrameCount = 0

    /// Set by LiveView (which has the AppContainer) so the summarize_session
    /// tool can run LiveSessionSummarizer. Takes a scope string, returns the
    /// summary. nil = summarization unavailable (tool returns an error).
    var summarizeProvider: ((String) async throws -> String)?

    private var provider: LiveSessionProvider?
    private var eventTask: Task<Void, Never>?
    /// Fires ~4s after connect to warn if no mic audio is being captured (another
    /// app held the mic from before start). Backed by micChunksCaptured, which the
    /// parallel recording tap now feeds. Cancelled on stop/pause. (#673)
    private var micInputWatchdogTask: Task<Void, Never>?
    /// When a *running* session is auto-paused (mic interruption) or auto-stopped
    /// (backgrounded), we arm recovery: returning to the app — or the interruption
    /// ending — within this window auto-restarts Live. Cleared on user stop/resume
    /// /fresh start. unmute alone can't revive WebRTC's torn-down ADM, so recovery
    /// means a full restart. (#673)
    private var interruptedRecoveryDeadline: Date?
    /// The recording transport from the last start(), reused when auto-recovery
    /// restarts the session (scene-phase recovery has no `container` to read it).
    @ObservationIgnored private var lastRecordingTransport: GatewayTransport?
    private static let interruptedRecoveryWindow: TimeInterval = 180
    private var audioSampleRecorder: LiveAudioSampleRecorder?
    private var rawAudioTrackSegmentStartedAt: Date?
    /// The active iPhone camera capture, exposed read-only so the Live PiP
    /// preview can mount an `AVCaptureVideoPreviewLayer` on its session. `nil`
    /// when no iPhone visual stream is running. (#415)
    private(set) var visualCapture: VideoCapture?

    // Visual change gate (Live realtime repetition fix): a pluggable deduplicator
    // skips near-identical frames from a static scene instead of flooding the
    // realtime conversation with redundant input_image items. The instance is
    // (re)selected on each visual-stream start from `config.visualDedupEnabled`
    // (AverageHashDeduplicator vs PassThroughDeduplicator). See
    // VisualFrameDeduplicator.swift. (#612)
    private var visualDeduplicator: VisualFrameDeduplicator = PassThroughDeduplicator()
    private var visualFramesSkipped = 0
    /// Ray-Ban Meta camera stream, created lazily when the Live visual source
    /// is `.rayBanMeta`. Reuses the same DAT pipeline as Recording — frames are
    /// routed into `sendVisualFrame` instead of disk/upload.
    /// Ray-Ban camera stream, exposed read-only so the Live PiP preview can
    /// observe its `latestFrame` (glasses aren't an AVCaptureSession, so the PiP
    /// renders the published frame as an Image instead of a preview layer). (#415)
    private(set) var rayBanVideo: GlassesVideoStream?
    /// Records the active Live session's streams to disk + upload. It never taps
    /// audio itself; Live tees already-captured mic/camera frames into it.
    private let recordingSink = LiveRecordingSink()
    private var toolCameraFrames = LiveToolCameraFrameCache()
    private static let liveToolCameraFrameMaxAgeNs: UInt64 = 30_000_000_000
    /// Parallel mic capture used ONLY for recording when the provider owns the
    /// realtime mic (WebRTC) and therefore never tees PCM to `recordingSink`.
    /// nil for providers whose mic chunks already flow through `ingestAudio`.
    private var recordingMicSource: MicAudioSource?
    private var recordingMicTask: Task<Void, Never>?
    private let audioOutputPlayer = LiveRealtimeAudioOutputPlayer()
    private var currentAssistantEntryID: UUID?
    // Live streaming text, decoupled from the committed transcript (#623).
    // Assistant deltas arrive per token (tens/sec). Mutating the `conversation`
    // array per token re-rendered the whole O(n) list and heated the device.
    // Instead, in-flight text lives in `streamingText` (a separate @Observable),
    // so a per-token delta re-renders ONLY the streaming bubble that reads it.
    // The committed array is not mutated per token — only once when a turn
    // starts (isStreaming), on rare metadata changes, and at the commit handoff
    // when it finalizes (finishAssistantMessage). Keyed by entry id so
    // concurrent streams (multiple realtime items in flight) don't cross-talk.
    let streamingText = LiveStreamingText()
    @ObservationIgnored private var lastScrollTickAt: Date?
    private var currentUserAudioEntryID: UUID?
    private var transcriptEntryByItemID: [String: UUID] = [:]
    private var voiceprintRealtimeTask: Task<Void, Never>?
    private var voiceprintRealtimeTasks: [UUID: Task<Void, Never>] = [:]
    private var voiceprintRealtimeGeneration = 0
    private var voiceprintTranscriptItemIDsSent = Set<String>()
    private var voiceprintOpenSpeechWindowID: String?
    private var voiceprintClosedSpeechWindowIDs: [String] = []
    private var voiceprintSpeechWindowCounter = 0
    /// WS2 edge-triggered owner-identity state machine. Holds the last-applied
    /// verdict so the two push channels (realtime_event piggyback + `voiceprint.identity`
    /// broadcast) inject/relabel at most ONCE per genuine establish/flip and de-dupe
    /// against each other. Reset per session in `resetVoiceprintRealtimeState`.
    private var voiceprintIdentityMachine = LiveVoiceprintIdentityMachine()
    /// WS2 UI indicator: the current owner/speaker label, surfaced when recognition
    /// establishes/flips. nil until the first identity edge. OFF-BY-DEFAULT: stays nil
    /// unless `voiceprintRealtimeEnabled` is on and the gateway pushes an identity.
    private(set) var voiceprintIdentityLabel: String?
    /// Last VAD timestamp (ms) handed to the server voiceprint turn tracker, in the
    /// recording-offset time base. The tracker requires speech_stopped strictly after
    /// speech_started (`endMs > startMs`) and a finite time; the WebRTC transport emits
    /// arg-less VAD, so start/stop can resolve to the same recording offset (or nil during
    /// warm-up). This floor makes every emitted VAD timestamp finite and strictly
    /// monotonic while staying aligned to the recording/audio-artifact timeline.
    private var voiceprintLastVadOffsetMs: Double?
    /// Speech windows whose speech_stopped fired before the recording WAV was open
    /// (warm-up race). For WebRTC the parallel-mic WAV opens LAZILY on the first
    /// streamed chunk after `isStreamingAudio` flips (see startParallelMicRecording),
    /// so a first-turn speech_stopped can find `recordingSink.currentAudioArtifact ==
    /// nil` and would otherwise drop the artifact permanently — the server tracker
    /// defaults includeMissingAudio=false, so that turn never finalizes/scores. We
    /// stash the join keys here and late-bind the artifact once the WAV opens. Ordered
    /// + de-duped by join key; bounded (only warm-up turns land here, then it drains).
    private var voiceprintPendingAudioArtifactJoins: [(itemID: String?, speechWindowID: String?)] = []
    /// B1 on-device speaker embedder. Lazily resolved to the CoreML CAM++ model
    /// when `onDeviceEmbeddingEnabled` gates on and the binary is provisioned;
    /// nil/unavailable otherwise so the marker path is used. Not wired to any
    /// default-on behavior — see `resolvedSpeakerEmbedder`.
    @ObservationIgnored private var speakerEmbedder: SpeakerEmbedder?
    // Maps a Realtime output item_id → the assistant bubble it streams into, so
    // re-delivered transcripts for the same item update one bubble instead of
    // appending a duplicate.
    private var assistantEntryByItemID: [String: UUID] = [:]
    // Maps a tool call_id → its tool bubble, so a started→completed pair updates
    // one bubble instead of appending two.
    private var toolEntryByCallID: [String: UUID] = [:]
    private var defaultBrokerURL: URL?
    private var gatewayBridge: LiveGatewayBridge?
    private var activeChatSessionKey: String?
    private var gatewayBridgeStreamTask: Task<Void, Never>?
    private var liveActivity: Activity<LiveActivityAttributes>?
    private var liveActivityStartedAt: Date?
    private var liveControlObserverRegistered = false
    // Live Activity update coalescing (#lock-screen perf): structural changes (live/
    // recording/mic state) flush instantly; high-frequency text churn (transcript
    // context lines) is debounced so we don't burn the system's update budget.
    private var lastSentActivitySnapshot: ActivitySnapshot?
    private var pendingActivityContentState: LiveActivityAttributes.ContentState?
    private var pendingActivitySnapshot: ActivitySnapshot?
    private var activityCoalesceTask: Task<Void, Never>?
    private var lastActivityUpdateAt = Date.distantPast
    private var pausedAudioWasStreaming = false
    private var pausedVisualWasStreaming = false
    private var sessionMetadataSaveTask: Task<Void, Never>?
    private var lastOutputAudioDiagnosticsPublish = Date.distantPast
    private var outputAudioChunksReceivedTotal = 0
    private var outputAudioBytesReceivedTotal = 0
    private var outputAudioChunksPlayedTotal = 0
    private var outputAudioBytesPlayedTotal = 0
    private var outputAudioStatusTotal = "Idle"
    /// Tracks the in-flight transcript.append task for the most-recently finalized
    /// user turn so scan_intention can await it before querying the gateway window.
    private var pendingTranscriptAppend: Task<Void, Never>?
    private var bootContextInjectedSessionIDs = Set<UUID>()
    // M8 where-trigger: owns CoreLocation region monitoring for ambient `where` Intentions.
    private let ambientLocationManager = AmbientLocationManager()
    // #481: the most recent regions.update descriptor set + session, kept so we can
    // re-run handleRegionsUpdate after Always authorization is granted (the first
    // arm of a hard region fails when auth/CLLocationManager state isn't ready yet,
    // and CoreLocation has no "retry on grant" of its own — we drive it here).
    private var lastRegionsUpdate: (regions: [RegionsUpdateRegion], sessionKey: String)?
    private var audioSessionObserverTokens: [NSObjectProtocol] = []

    deinit {
        // Idempotent — safe whether or not we ever registered. Avoids a dangling
        // unretained pointer in the Darwin notify center after this store is gone.
        CFNotificationCenterRemoveEveryObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque()
        )
    }

    init(config: LiveSessionConfig = LiveProfileDefaults.load(), defaultBrokerURL: URL? = nil) {
        self.config = config
        self.defaultBrokerURL = defaultBrokerURL
        self.diagnostics.providerLabel = config.provider.label
        self.promptProfiles = LivePromptLibrary.load()
        startLiveControlCommandObservingIfNeeded()
        updateWidgetStatus(contextLine: WidgetStatusStore.read().contextLine)
        if let selectedPrompt = promptProfiles.first(where: { $0.id == config.selectedPromptID }) {
            self.config.promptTitle = selectedPrompt.title
            self.config.promptInstructions = selectedPrompt.instructions
        } else if let defaultPrompt = promptProfiles.first(where: { $0.id == LivePromptLibrary.defaultPromptID }) {
            self.config.selectedPromptID = defaultPrompt.id
            self.config.promptTitle = defaultPrompt.title
            self.config.promptInstructions = defaultPrompt.instructions
        }
        let archivedSessions = LiveSessionArchive.loadSummaries()
        self.localSessions = archivedSessions
        if let currentID = LiveSessionArchive.loadCurrentSessionID(),
           let current = archivedSessions.first(where: { $0.id == currentID }) {
            self.currentSessionID = current.id
            // Heavy journal decode deferred — see loadInitialConversationIfNeeded(). (#580)
            self.pendingInitialLoadSessionID = current.id
        } else if let current = archivedSessions.first {
            self.currentSessionID = current.id
            self.pendingInitialLoadSessionID = current.id
            LiveSessionArchive.saveCurrentSessionID(current.id)
        } else {
            let session = Self.makeEmptySession()
            self.currentSessionID = session.id
            self.localSessions = [session]
            LiveSessionArchive.save(self.localSessions)
            LiveSessionArchive.saveCurrentSessionID(session.id)
        }
        installAudioSessionObservers()
        refreshDirectOpenAIAPIKeyStatus()
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
    }

    func configureMockProviderIfNeeded(launchConfiguration: LaunchConfiguration) {
        guard launchConfiguration.liveProvider == .mock, !phase.isActive else { return }
        config.provider = .mock
        config.model = LiveProviderKind.mock.defaultModel
        config.openAIModelPreset = .custom
        config.audioInputEnabled = false
        config.audioSource = .systemDefault
        config.visualSource = .off
        config.visualCadence = .off
        config.mediaPersistenceMode = .off
        config.responseModality = .text
        config.toolsEnabled = false
        config.gatewayBridgeEnabled = false
        config.openingBehavior = .silent
        config.keepRunningOffscreen = false
        config.lockScreenMode = .off
        diagnostics.providerLabel = config.provider.label
        diagnostics.providerStatus = "Ready"
    }

    /// UI-testing provider override for deterministic error-path tests. Pins the
    /// provider so a tap on Start exercises a specific blocked/failed branch
    /// without the network: "gemini"/"custom" hit the preflight alert, "auth-fail"
    /// connects via a stub that 401s.
    func configureUITestingProviderOverrideIfNeeded() {
        #if DEBUG
        guard !phase.isActive, let override = UITestingSupport.liveProviderOverride() else { return }
        switch override {
        case "gemini":
            config.provider = .geminiLive
        case "custom":
            config.provider = .custom
        case "auth-fail":
            // Provider with a (forced-present) key so canStart passes; the stub
            // provider then throws on connect. Mute audio/visual/recording so the
            // path reaches connect() without a permission prompt.
            config.provider = .openAIRealtime
            hasDirectOpenAIAPIKey = true
            config.audioInputEnabled = false
            config.visualSource = .off
            config.visualCadence = .off
            config.mediaPersistenceMode = .off
            config.gatewayBridgeEnabled = false
            config.openingBehavior = .silent
            config.lockScreenMode = .off
        default:
            break
        }
        diagnostics.providerLabel = config.provider.label
        #endif
    }

    /// Decodes the resumed session's persisted conversation OFF the main thread,
    /// exactly once. Deliberately NOT done in init(): ContentView holds this
    /// store in `@State`, whose `= LiveSessionStore()` autoclosure re-runs on
    /// every ContentView struct rebuild (reconnect-loop @Observable churn, tab
    /// switches, scrolling). Decoding a long JSONL journal there re-parsed the
    /// whole transcript on the main thread on every rebuild — janking every tab
    /// and heating the device. Profiled: loadConversation/JSONDecoder/ISO8601 was
    /// the dominant hot path. (#580; same class of bug as #551.)
    func loadInitialConversationIfNeeded() async {
        guard !didStartInitialLoad else { return }
        didStartInitialLoad = true
        guard let id = pendingInitialLoadSessionID else { return }
        let loaded = await Task.detached(priority: .userInitiated) {
            LiveSessionArchive.loadConversation(sessionID: id)
        }.value
        // Apply only if nothing else took over this session meanwhile (a live
        // session began appending, or the user switched/created a session).
        guard currentSessionID == id, conversation.isEmpty else { return }
        conversation = loaded
        updateCurrentSessionSnapshot()
    }

    /// Non-destructive reason the session can't start, or nil when it can.
    /// `canStart` is just `startBlockReason == nil` — single source of truth so
    /// the UI can preflight a tap (and show the reason) without going through
    /// `start()`'s `.failed` side effect.
    var startBlockReason: LiveStartBlock? {
        guard !phase.isActive else { return nil }
        switch config.provider {
        case .mock:
            return nil
        case .openAIRealtime:
            return hasDirectOpenAIAPIKey ? nil : .missingOpenAIKey
        case .geminiLive:
            return .providerUnavailable("Gemini Live adapter is not wired yet.")
        case .custom:
            return .providerUnavailable("Custom live endpoints need an adapter dialect before they can start.")
        }
    }

    var canStart: Bool { startBlockReason == nil }

    /// Surface a user-facing error dialog. The single general entry point — any
    /// blocked action or swallowed failure can call this instead of no-oping.
    func presentUserAlert(_ alert: LiveUserAlert) {
        pendingUserAlert = alert
    }

    func dismissUserAlert() {
        pendingUserAlert = nil
    }

    var toolboxManifest: [LiveToolManifestItem] {
        LiveToolRegistry.default.manifest(config: config)
    }

    func testTool(name: String, argumentsJSON: String) async -> String {
        let context = LiveToolContext(
            config: config,
            gatewayBridge: gatewayBridge,
            awaitPendingTranscriptAppend: nil,
            latestCameraFrame: latestCameraFrameForTool
        )
        return await LiveToolRegistry.default.execute(name: name, argumentsJSON: argumentsJSON, context: context)
    }

    func updateProvider(_ provider: LiveProviderKind) {
        // Editing while a session runs stages into the draft `config` and takes
        // effect on the next session; the running session keeps its snapshot.
        config.provider = provider
        if config.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            LiveProviderKind.allCases.map(\.defaultModel).contains(config.model) {
            config.model = provider.defaultModel
        }
        if provider == .openAIRealtime {
            config.openAICredentialMode = .directAPIKey
            config.openAIModelPreset = LiveOpenAIModelPreset.preset(for: config.model)
            config.responseModality = .audio
            config.visualSource = .off
            config.visualCadence = .off
            // mediaPersistenceMode is NOT forced off here — recording works again
            // for the WebRTC provider via the parallel mic tap, so respect the
            // user's "Save Live media" setting (default .local).
            config.openingBehavior = .silent
        }
        // Don't relabel a running session's provider — that snapshot is fixed.
        if !phase.isActive {
            diagnostics.providerLabel = provider.label
        }
        persist()
    }

    func updateModel(_ model: String) {
        config.model = model
        config.openAIModelPreset = LiveOpenAIModelPreset.preset(for: model)
        persist()
    }

    func updateOpenAICredentialMode(_ mode: LiveOpenAICredentialMode) {
        config.openAICredentialMode = mode
        persist()
    }

    func updateOpenAIModelPreset(_ preset: LiveOpenAIModelPreset) {
        config.openAIModelPreset = preset
        if preset != .custom {
            config.model = preset.model
        }
        persist()
    }

    func saveDirectOpenAIAPIKey(_ key: String) {
        guard !phase.isActive else { return }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            clearDirectOpenAIAPIKey()
            return
        }
        do {
            try KeychainStore.saveOpenAIAPIKey(trimmed)
            hasDirectOpenAIAPIKey = true
            appendSystemMessage("Direct OpenAI key saved")
        } catch {
            let message = "Could not save Direct OpenAI key: \(error.localizedDescription)"
            diagnostics.lastError = message
            appendSystemMessage(message, level: .error)
        }
    }

    func clearDirectOpenAIAPIKey() {
        guard !phase.isActive else { return }
        do {
            try KeychainStore.deleteOpenAIAPIKey()
            hasDirectOpenAIAPIKey = false
            appendSystemMessage("Direct OpenAI key cleared")
        } catch {
            let message = "Could not clear Direct OpenAI key: \(error.localizedDescription)"
            diagnostics.lastError = message
            appendSystemMessage(message, level: .error)
        }
    }

    func refreshDirectOpenAIAPIKeyStatus() {
        #if DEBUG
        // Keep canStart passing in the auth-failure UI test so start() reaches
        // connect() (where the stub 401s) instead of the no-key preflight.
        if UITestingSupport.forcesLiveAuthFailure() {
            hasDirectOpenAIAPIKey = true
            return
        }
        #endif
        let key = (try? KeychainStore.loadOpenAIAPIKey()) ?? nil
        hasDirectOpenAIAPIKey = key?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    func updateSessionBrokerURL(_ url: String) {
        config.sessionBrokerURL = url
        persist()
    }

    func updateCustomEndpointURL(_ url: String) {
        config.customEndpointURL = url
        persist()
    }

    func updateCustomDialect(_ dialect: String) {
        config.customDialect = dialect
        persist()
    }

    func updateAudioSource(_ source: LiveAudioSource) {
        config.audioSource = source
        persist()
    }

    func updateAudioInputEnabled(_ enabled: Bool) {
        config.audioInputEnabled = enabled
        persist()
    }

    func toggleAudioInputIntent() async {
        if phase == .connected {
            await toggleAudioInput()
        } else {
            updateAudioInputEnabled(!config.audioInputEnabled)
        }
    }

    // MARK: - Stay Silent

    /// Toggle Stay Silent mode. Only meaningful on a connected session — while
    /// silent the model keeps listening + transcribing but does not respond; on
    /// release it gives one spoken recap of what happened during the window.
    func toggleStaySilentIntent() async {
        guard phase == .connected, let provider else {
            append("Stay Silent needs a connected Live session", level: .warning)
            return
        }
        if staySilentActive {
            await endStaySilent(provider: provider)
        } else {
            await beginStaySilent(provider: provider)
        }
    }

    private func beginStaySilent(provider: LiveSessionProvider) async {
        staySilentActive = true
        silenceStartedAt = Date()
        silenceTranscript.removeAll()
        silenceFrameCount = 0
        do {
            try await provider.setSilenceMode(true, config: config)
            appendSystemMessage("Stay Silent on — listening, not responding.", eventType: "stay_silent.on")
        } catch {
            staySilentActive = false
            append("Stay Silent failed to enable", level: .warning, detail: error.localizedDescription)
        }
    }

    private func endStaySilent(provider: LiveSessionProvider) async {
        appendSystemMessage("Stay Silent off — summarizing what happened.", eventType: "stay_silent.off")
        // The user's last utterance is often still being transcribed when they tap
        // off (server VAD + transcription are async). If we summarized now we'd miss
        // it (e.g. the "San Diego Zoo" sentence in the #stay-silent log). Keep
        // capturing for a short settle window + flush any in-flight transcript
        // append. staySilentActive stays true across the wait so finishUserTranscript
        // keeps appending late turns; captureSilenceWindowRecap() (called by the
        // summarize_silence tool) then snapshots the full window.
        try? await Task.sleep(nanoseconds: 1_200_000_000) // 1.2s settle for trailing speech
        await awaitPendingTranscriptAppend()
        staySilentActive = false

        do {
            // Restore normal config first (re-enables tools + auto responses), then
            // force exactly one recap turn that MUST call summarize_silence. The tool
            // pulls the captured window via silenceSummaryHook → captureSilenceWindowRecap,
            // so the recap goes through a visible tool call.
            try await provider.setSilenceMode(false, config: config)
            // The trigger note carries the captured window too, so the tools-off
            // fallback (plain recap, no summarize_silence) still has the content.
            let triggerNote = "Give me a concise recap of what we just talked about:\n\n\(captureSilenceWindowRecap())"
            try await provider.requestSilenceReleaseSummary(prompt: triggerNote)
        } catch {
            append("Stay Silent failed to disable", level: .warning, detail: error.localizedDescription)
        }
        // NOTE: do NOT clear the captured window here — the summarize_silence tool
        // runs asynchronously after this returns and reads it via the hook. It is
        // reset on the next beginStaySilent() and on stop().
    }

    /// Snapshot of the transcript/context captured while Stay Silent was on. Called
    /// by the summarize_silence tool (via silenceSummaryHook). Mirrors the web
    /// LiveLab buildSilenceSummaryPrompt payload.
    func captureSilenceWindowRecap() -> String {
        let lines: String
        if silenceTranscript.isEmpty {
            lines = "(No speech was captured)"
        } else {
            lines = silenceTranscript
                .map { "\($0.role): \($0.text)" }
                .joined(separator: "\n")
        }
        let visualContext = silenceFrameCount > 0
            ? " I also saw the live camera feed — use it if it helps give context to the recap."
            : ""
        return "Here's what I captured:\n\(lines)\(visualContext)"
    }

    // MARK: - Cocktail Party Mode (#627)

    /// The bridge + session key the person tools use to reach the DeepFace service.
    /// Set while Cocktail Party Mode is active so list/recall/update tools work.
    private var cocktailPartySessionKey: String?

    /// Stand up the face-recognition controller for this session when the mode is on
    /// and the Hawky bridge (needed to reach DeepFace) is available. Wires silent
    /// context injection back to the realtime provider. DeepFace owns the person DB;
    /// iOS only detects/crops faces and relays.
    private func setupCocktailPartyIfNeeded(config: LiveSessionConfig, provider: LiveSessionProvider) {
        cocktailParty = nil
        guard config.cocktailPartyEnabled else { return }
        guard let bridge = gatewayBridge else {
            appendSystemMessage("Cocktail Party Mode needs the Hawky bridge (for face recognition) — turn the bridge on.", level: .warning)
            return
        }
        let sessionKey = config.gatewayBridgeSessionKey
        cocktailPartySessionKey = sessionKey
        let client = BridgeFaceRecognitionClient(bridge: bridge, sessionKey: sessionKey)
        let cropper = VisionFaceCropper()
        let recognizer = CocktailPartyRecognizer(cropper: cropper, client: client)
        let controller = CocktailPartyController(recognizer: recognizer)
        controller.injectContext = { [weak provider] text in
            guard let provider else { return }
            // createResponse:false — context only, must NOT trigger a model turn.
            try? await provider.sendContext(text, createResponse: false)
        }
        controller.log = { [weak self] line in
            Task { @MainActor in self?.append(line, detail: "cocktail party") }
        }
        controller.start()
        cocktailParty = controller
        // Behavioral guardrail (#627): with the camera streaming, the model otherwise
        // narrates frames ("you look well-lit", "fix the glare") whenever VAD fires on
        // ambient noise. In Cocktail Party Mode it should stay quiet about the video
        // feed and only speak when the user talks to it. Injected as system context
        // (no response triggered).
        Task { [weak provider] in
            try? await provider?.sendContext(
                "Cocktail Party Mode is on. Do NOT describe or comment on the camera feed, lighting, framing, or what you see, and do not narrate images. Only speak when the user talks to you. If asked who is on camera, use identify_person and answer once. Otherwise stay silent.",
                createResponse: false
            )
        }
        appendSystemMessage("Cocktail Party Mode on — recognizing people on request.", eventType: "cocktail_party.on")
    }

    private func teardownCocktailParty() {
        cocktailParty?.stop()
        cocktailParty = nil
        cocktailPartySessionKey = nil
        recentCameraFrames.removeAll()
    }

    // MARK: - Safety Check (#648)

    /// Stand up Safety Check for this session. Detection runs OFF the realtime model:
    /// sampled camera frames are sent to a silent hazard classifier (gateway → vision
    /// service); only when it flags a genuine hazard do we inject a spoken warning.
    /// The realtime conversation is untouched — no polling response.create, no muting,
    /// so the model still talks to the user normally. (The old model-driven poll kept
    /// the floor busy and the model never responded — #648.)
    private func setupSafetyIfNeeded(config: LiveSessionConfig, provider: LiveSessionProvider) async {
        safety = nil
        guard config.safetyCheckEnabled else { return }
        guard let bridge = gatewayBridge else {
            // No bridge → no hazard classifier can run. connect() already set the
            // provider hard-quiet from safetyCheckEnabled; UNWIND it here, otherwise the
            // session is silenced (no greeting / proactive behavior) with no safety
            // pipeline behind it — a dead, mute session. (Codex review P2.)
            await provider.setHardQuiet(false)
            appendSystemMessage("Safety Check needs the Hawky bridge — turn the bridge on.", level: .warning)
            return
        }
        let sessionKey = config.gatewayBridgeSessionKey
        let classifier = BridgeHazardClassifier(bridge: bridge, sessionKey: sessionKey)
        let controller = SafetyController(classifier: classifier)
        controller.warn = { [weak self, weak provider] text in
            guard let provider else { return }
            // The only time Safety Check speaks: a real hazard. Spoken VERBATIM (no
            // model paraphrase / follow-up advice — that was the chattiness) and shown
            // as a distinct red safety bubble (eventType: "safety.warning"). The ⚠️
            // prefix makes the bubble unmistakable even if the red styling fails to
            // apply for any reason.
            try? await provider.speakSafetyWarning(text)
            await MainActor.run {
                self?.appendSystemMessage("⚠️ \(text)", level: .warning, eventType: "safety.warning")
            }
        }
        controller.log = { [weak self] line in
            Task { @MainActor in self?.append(line, detail: "safety") }
        }
        controller.start()
        safety = controller
        // Safety Check stays quiet WITHOUT slowing replies: we keep fast server-VAD
        // auto-response (the model answers your speech immediately), because camera
        // frames no longer trigger responses (SDK run_immediately fix) and hardQuiet
        // cancels any stray unprompted turn (greeting / bridge aside). We deliberately
        // do NOT call setVisualQuietMode(true) here — that forced manual response.create
        // and added a 6-8s round-trip per reply.
        await provider.setHardQuiet(true)
        appendSystemMessage(SafetyCheckCopy.enabledMessage, eventType: "safety.on")
    }

    private func teardownSafety() {
        safety?.stop()
        safety = nil
    }


    /// Toggle Safety Check live (Settings). Persists; applies/removes mid-session.
    func updateSafetyCheckEnabled(_ enabled: Bool) {
        config.safetyCheckEnabled = enabled
        persist()
        guard phase == .connected, let provider else { return }
        let cfg = liveConfig
        if enabled {
            // Engages hard-quiet (not manual-response) inside setupSafetyIfNeeded.
            Task { await setupSafetyIfNeeded(config: cfg, provider: provider) }
        } else {
            teardownSafety()
            // Lift hard-quiet (re-allow greeting/bridge asides), and restore
            // auto-response unless something else still wants it off.
            Task { [weak provider] in await provider?.setHardQuiet(false) }
            if !staySilentActive, !cfg.speakOnlyWhenSpokenTo, !isStreamingVisual {
                Task { [weak provider] in try? await provider?.setVisualQuietMode(false, config: cfg) }
            }
        }
    }

    /// Identify whoever is on the camera now (identify_person tool). Picks the best
    /// recent frame with a face LOCALLY, then does ONE server identify (was up to 6
    /// sequential gateway round-trips → slow). Preserves suppressed candidate
    /// results so the tool can distinguish rejected faces from genuinely new ones.
    func identifyLatestFrameResult() async -> FaceIdentifyResult {
        guard let cocktailParty else { return .noMatch }
        return await cocktailParty.identifyResult(amongFrames: recentCameraFrames)
    }

    /// Compatibility helper for call sites that only need a matched person.
    func identifyLatestFrame() async -> LivePerson? {
        if case let .person(person) = await identifyLatestFrameResult() {
            return person
        }
        return nil
    }

    /// Resolve the person on camera for a profile write (update_person_profile with no
    /// id): best recent frame locally, then ONE server identify/enroll. Preserves
    /// suppressed candidate results so a rejected face cannot fall back to a stale id.
    func resolveCameraPersonResult(name: String?) async -> FaceIdentifyResult {
        guard let cocktailParty else { return .noMatch }
        return await cocktailParty.resolvePersonResult(amongFrames: recentCameraFrames, name: name)
    }

    /// Compatibility helper for call sites that only need a matched/enrolled person.
    func resolveCameraPerson(name: String?) async -> LivePerson? {
        if case let .person(person) = await resolveCameraPersonResult(name: name) {
            return person
        }
        return nil
    }

    private func latestCameraFrameForTool() async -> LiveJPEGFrame? {
        toolCameraFrames.freshFrame(
            isStreamingVisual: isStreamingVisual,
            nowNs: Self.currentUptimeNanoseconds(),
            maxAgeNs: Self.liveToolCameraFrameMaxAgeNs
        )
    }

    /// A bridge for People-DB ops that works in ANY session state. The face DB is
    /// global on the server, so these don't need a live Live session — only a gateway
    /// URL. Reuse the live bridge if present, else build a short-lived one from the
    /// configured gateway. The session key is just a passthrough label for person RPCs.
    private func peopleBridge() -> (LiveGatewayBridge, String)? {
        let cfg = liveConfig
        let key = cocktailPartySessionKey
            ?? Self.resolvedRuntimeGatewayBridgeSessionKey(from: cfg, fallback: "people-db")
            ?? "people-db"
        if let bridge = gatewayBridge { return (bridge, key) }
        guard let url = defaultBrokerURL else { return nil }
        return (LiveGatewayBridge(gatewayURL: url), key)
    }

    /// A bridge + session key for owner voiceprint enrollment (B3). Works in any
    /// session state — enrollment is a workspace-global owner-template write, so it
    /// only needs a gateway URL. Reuse the live bridge if present, else build a
    /// short-lived one. Returns nil when no gateway is configured (offline).
    func voiceprintEnrollmentGateway() -> (VoiceprintEnrollmentGateway, String)? {
        let key = Self.resolvedRuntimeGatewayBridgeSessionKey(from: liveConfig, fallback: "realtime:main")
            ?? "realtime:main"
        if let bridge = gatewayBridge { return (bridge, key) }
        guard let url = defaultBrokerURL else { return nil }
        return (LiveGatewayBridge(gatewayURL: url), key)
    }

    // -------------------------------------------------------------------------
    // Owner-voiceprint enrollment listening session (B3, live-capture path).
    //
    // Enrollment must capture through the SAME live WebRTC pipeline recognition
    // scores — a standalone recorder is acoustically orthogonal to that domain
    // (docs/voiceprint-architecture.md, "capture-domain mismatch"). So the Voice
    // enrollment screen runs a REAL Live session, silenced, with recording forced
    // to live upload; the gateway then builds the template from the uploaded
    // `.segNNN.mic` segments via enroll_owner_from_recording.
    // -------------------------------------------------------------------------

    /// True while the silent enrollment listening session is running. Session-
    /// scoped; cleared by `stopEnrollmentListeningSession()`.
    private(set) var enrollmentListeningActive = false

    /// Base id of the current (or, after stop, most recent) Live recording — the
    /// WAV basename, which is byte-identical to the base of the uploaded
    /// `.segNNN.mic` segment media ids (e.g. "live-20260712-135209"). Reads the
    /// open recording's artifact while recording, and falls back to
    /// `lastRecordingURL` afterwards (the sink clears its recording id on stop
    /// but keeps the last URL readable).
    var currentRecordingBaseId: String? {
        if let artifact = recordingSink.currentAudioArtifact {
            return artifact.audioArtifactID
        }
        guard let url = recordingSink.lastRecordingURL else { return nil }
        let base = url.deletingPathExtension().lastPathComponent
        return base.isEmpty ? nil : base
    }

    /// Start a SILENT live listening session for owner-voiceprint enrollment.
    ///
    /// Reuses the one true `start()` path (never a forked second session) with
    /// TEMPORARY overrides passed via `configOverride`, which start() uses for
    /// the frozen `activeConfig` snapshot only — the draft `config` and its
    /// UserDefaults persistence are never touched, so nothing here can leak into
    /// the user's saved settings and there is nothing to restore beyond stop():
    /// - audioInputEnabled: on (the whole point is capturing the mic),
    /// - mediaPersistenceMode: .liveUpload (segments must reach the gateway
    ///   DURING the session for enroll_owner_from_recording to resolve them),
    /// - camera/video: off (voice only; also keeps Safety/CocktailParty visual
    ///   pipelines out of the session),
    /// - speakOnlyWhenSpokenTo: on + openingBehavior .silent, so the connect-time
    ///   session config already has auto-response off and no greeting — closing
    ///   the gap before the full silence update below lands.
    ///
    /// SILENCING CHOICE — Stay Silent's `setSilenceMode(true)`, NOT
    /// `safetyCheckEnabled`/hardQuiet: hardQuiet deliberately KEEPS server-VAD
    /// auto-response so the model still replies to the user's own speech turns
    /// (exactly what a 40s enrollment monologue would trigger), and enabling
    /// Safety Check also drags in the hazard-watch controller — a side feature.
    /// `setSilenceMode(true)` is the one mechanism that ONLY silences: it turns
    /// off auto-response AND the manual reply-on-user-turn path, sets
    /// tool_choice "none", and cancels any stray server turn. Its release-recap
    /// behavior never runs because we tear the session down while still silent.
    ///
    /// Returns false (with the session torn down) if the session, its recording,
    /// or the silence update could not be established — the flow FAILS CLOSED
    /// rather than listening non-silently or without upload.
    func startEnrollmentListeningSession(
        recordingTransport: GatewayTransport? = nil
    ) async -> Bool {
        guard !phase.isActive else { return false }
        var override = config
        override.audioInputEnabled = true
        override.mediaPersistenceMode = .liveUpload
        override.visualSource = .off
        override.visualCadence = .off
        // No visual input → no visual side features. Forced off explicitly so an
        // enabled setting can't wedge a camera pipeline into the listening session.
        override.cocktailPartyEnabled = false
        override.safetyCheckEnabled = false
        override.speakOnlyWhenSpokenTo = true
        override.openingBehavior = .silent
        await start(
            recordingTransport: recordingTransport ?? lastRecordingTransport,
            configOverride: override
        )
        guard phase == .connected, let provider else {
            await stop()
            return false
        }
        // No recording ⇒ no segments ever reach the gateway ⇒ enrollment can only
        // end in no_usable_segments. Fail now with the session torn down.
        guard isRecording else {
            await stop()
            return false
        }
        do {
            try await provider.setSilenceMode(true, config: liveConfig)
        } catch {
            // Couldn't silence — never run a listening session where the model
            // may talk over the user's enrollment speech.
            await stop()
            return false
        }
        enrollmentListeningActive = true
        appendSystemMessage("Voice enrollment: listening silently.", eventType: "voiceprint.enroll_listen.on")
        return true
    }

    /// Stop the enrollment listening session and return the recording base id to
    /// enroll from (nil when the recording never opened). The temporary session
    /// shape needs no explicit restore: it lived only in `activeConfig`, which
    /// `stop()` clears — the draft `config` and persisted settings were never
    /// modified. Silence is deliberately NOT released first; the session is torn
    /// down whole, so the model never gets a turn (and the Stay Silent release
    /// recap never runs).
    @discardableResult
    func stopEnrollmentListeningSession() async -> String? {
        let wasActive = enrollmentListeningActive
        enrollmentListeningActive = false
        // Read before stop() (the open artifact is definitive); the accessor's
        // lastRecordingURL fallback covers the post-stop re-read below, and also
        // the case where the session already auto-stopped (backgrounding /
        // provider failure) — the finished recording is still enrollable.
        let baseID = currentRecordingBaseId
        if wasActive || phase.isActive {
            await stop()
        }
        return baseID ?? currentRecordingBaseId
    }

    // -------------------------------------------------------------------------
    // Memory feature (#653): bridge access for the Live → More → Memory testing
    // tab. Like peopleBridge(), this works in any session state — the memory.*
    // RPCs are workspace-global, so they only need a gateway URL.
    // -------------------------------------------------------------------------

    private func memoryBridge(sessionKey overrideSessionKey: String? = nil) -> (LiveGatewayBridge, String)? {
        let overrideKey = overrideSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = (overrideKey?.isEmpty == false ? overrideKey : nil)
            ?? Self.resolvedRuntimeGatewayBridgeSessionKey(from: liveConfig, fallback: "realtime:main")
            ?? "realtime:main"
        if let bridge = gatewayBridge { return (bridge, key) }
        guard let url = defaultBrokerURL else { return nil }
        return (LiveGatewayBridge(gatewayURL: url), key)
    }

    /// Read the four-tier memory snapshot for the testing tab. nil if no gateway.
    func fetchMemorySnapshot() async -> LiveMemorySnapshot? {
        guard let (bridge, key) = memoryBridge() else { return nil }
        return await bridge.memorySnapshot(sessionKey: key)
    }

    /// Trigger distillation (scope "daily" | "global", mock skips the LLM). nil if no gateway.
    /// Used by the testing tab — daily distill targets the active bridge session.
    func distillMemory(scope: String, mock: Bool) async -> LiveMemoryDistillResult? {
        guard let (bridge, key) = memoryBridge() else { return nil }
        let target = scope == "daily" ? key : nil
        return await bridge.memoryDistill(sessionKey: key, scope: scope, mock: mock, targetSessionKey: target)
    }

    /// Memory feature (#653): auto-distill the just-ended Live session into the
    /// daily log. Called from stop(). Targets the bridge session key explicitly so
    /// the gateway distills the session that just ended instead of guessing from
    /// the most recently modified realtime log.
    /// Fire-and-forget, best-effort: never blocks teardown, swallows failures.
    func distillEndedSessionIntoDailyMemory(sessionKey: String? = nil) async {
        guard let (bridge, key) = memoryBridge(sessionKey: sessionKey) else { return }
        let result = await bridge.memoryDistill(sessionKey: key, scope: "daily", mock: false, targetSessionKey: key)
        if let result, result.ok {
            print("[memory] session-end distill ok → \(result.file)")
        } else {
            print("[memory] session-end distill skipped: \(result?.note ?? "no gateway / no transcript")")
        }
    }

    /// Fetch the people database for the UI (Profile Database tab). Works in any
    /// session state. Empty if no gateway is configured.
    func fetchPeople() async -> [LivePerson] {
        guard let (bridge, key) = peopleBridge() else { return [] }
        return await bridge.listPeople(sessionKey: key)
    }

    /// Wipe the entire people database (Profile Database tab Clear button). Works in
    /// any session state. Returns true on success.
    @discardableResult
    func clearPeople() async -> Bool {
        guard let (bridge, key) = peopleBridge() else { return false }
        return await bridge.clearPeople(sessionKey: key)
    }

    /// Toggle Cocktail Party Mode. Persists the preference and, when connected,
    /// stands up / tears down the recognizer live so the button works mid-session.
    func toggleCocktailPartyIntent() async {
        let enabling = !config.cocktailPartyEnabled
        config.cocktailPartyEnabled = enabling
        persist()
        guard phase == .connected, let provider else {
            // Not connected: preference saved; it takes effect on next session start.
            appendSystemMessage(enabling
                ? "Cocktail Party Mode will start with your next Live session."
                : "Cocktail Party Mode off.")
            return
        }
        if enabling {
            // Reuse the connect-time setup with the live config snapshot.
            var live = activeConfig ?? config
            live.cocktailPartyEnabled = true
            live.gatewayBridgeSessionKey = resolvedGatewayBridgeSessionKey(for: live)
            setupCocktailPartyIfNeeded(config: live, provider: provider)
        } else {
            teardownCocktailParty()
            appendSystemMessage("Cocktail Party Mode off.", eventType: "cocktail_party.off")
        }
    }

    func updateVisualSource(_ source: LiveVisualSource) {
        config.visualSource = source
        if source == .off {
            config.visualCadence = .off
        } else if config.visualCadence == .off {
            config.visualCadence = .fps1
        }
        persist()
    }

    func updateVisualCadence(_ cadence: LiveVisualCadence) {
        config.visualCadence = cadence
        if cadence != .off && config.visualSource == .off {
            config.visualSource = .iPhoneCamera
        }
        persist()
    }

    func toggleVisualInputIntent() async {
        if phase == .connected {
            await toggleVisualInput()
            return
        }

        if config.visualSource == .off {
            config.visualSource = .iPhoneCamera
            if config.visualCadence == .off {
                config.visualCadence = .fps1
            }
        } else {
            config.visualSource = .off
            config.visualCadence = .off
        }
        persist()
    }

    func configureIPhoneCameraDefaults() {
        guard !phase.isActive else { return }
        var changed = false
        if config.visualSource != .iPhoneCamera {
            config.visualSource = .iPhoneCamera
            changed = true
        }
        if config.visualCadence == .off {
            config.visualCadence = .fps1
            changed = true
        }
        if changed {
            persist()
        }
    }

    func updateCustomVisualFPS(_ fps: Double) {
        config.customVisualFPS = min(max(fps, 0.1), 5)
        persist()
    }

    func updateCameraPosition(_ position: LiveCameraPosition) async {
        guard config.cameraPosition != position else { return }
        config.cameraPosition = position
        persist()

        // Camera front/back is a live control (like mute), not a next-session
        // setting: restart the visual stream so the running session switches
        // immediately. The pipeline reads `config.cameraPosition` directly.
        guard phase == .connected else { return }
        guard isStreamingVisual else {
            diagnostics.visualStatus = "\(position.label) selected"
            appendSystemMessage(diagnostics.visualStatus)
            return
        }

        await stopVisualStream()
        if let provider {
            await startVisualStreamIfNeeded(provider: provider)
        }
    }

    func toggleCameraPosition() async {
        await updateCameraPosition(config.cameraPosition.toggled)
    }

    func updateMediaPersistenceMode(_ mode: LiveMediaPersistenceMode) {
        config.mediaPersistenceMode = mode
        persist()
    }

    func updateTurnDetectionMode(_ mode: LiveTurnDetectionMode) {
        config.turnDetectionMode = mode
        persist()
    }

    func updateVADThreshold(_ threshold: Double) {
        config.vadThreshold = min(max(threshold, 0), 1)
        persist()
    }

    func updateVADPrefixPaddingMs(_ milliseconds: Double) {
        config.vadPrefixPaddingMs = min(max(milliseconds, 0), 2_000)
        persist()
    }

    func updateVADSilenceDurationMs(_ milliseconds: Double) {
        config.vadSilenceDurationMs = min(max(milliseconds, 100), 2_000)
        persist()
    }

    func updateVADCreateResponse(_ enabled: Bool) {
        config.vadCreateResponse = enabled
        persist()
    }

    func updateVADInterruptResponse(_ enabled: Bool) {
        config.vadInterruptResponse = enabled
        config.bargeInPolicy = enabled ? .interruptAssistant : .letAssistantFinish
        persist()
    }

    func updateBargeInPolicy(_ policy: LiveBargeInPolicy) {
        config.bargeInPolicy = policy
        config.vadInterruptResponse = policy.interruptsRealtimeResponse
        persist()
    }

    func updateVADIdleTimeoutEnabled(_ enabled: Bool) {
        config.vadIdleTimeoutEnabled = enabled
        persist()
    }

    func updateVADIdleTimeoutMs(_ milliseconds: Double) {
        config.vadIdleTimeoutMs = min(max(milliseconds, 5_000), 30_000)
        persist()
    }

    func updateSemanticVADEagerness(_ eagerness: LiveSemanticVADEagerness) {
        config.semanticVADEagerness = eagerness
        persist()
    }

    func updatePromptPreset(_ preset: LivePromptPreset) {
        config.promptPreset = preset
        persist()
    }

    func updateCustomPrompt(_ prompt: String) {
        config.customPrompt = prompt
        persist()
    }

    func selectPrompt(_ promptID: String) {
        guard let profile = promptProfiles.first(where: { $0.id == promptID }) else { return }
        config.selectedPromptID = profile.id
        config.promptTitle = profile.title
        config.promptInstructions = profile.instructions
        persist()
    }

    func updateSelectedPromptTitle(_ title: String) {
        guard let index = editableSelectedPromptIndex() else { return }
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        promptProfiles[index].title = cleaned.isEmpty ? "Untitled prompt" : title
        config.promptTitle = promptProfiles[index].title
        savePromptProfiles()
        persist()
    }

    func updateSelectedPromptInstructions(_ instructions: String) {
        guard let index = editableSelectedPromptIndex() else { return }
        promptProfiles[index].instructions = instructions
        config.promptInstructions = instructions
        savePromptProfiles()
        persist()
    }

    func addPrompt() {
        let base = promptProfiles.first(where: { $0.id == config.selectedPromptID })
        let profile = LivePromptProfile(
            id: UUID().uuidString,
            title: "New prompt",
            instructions: base?.instructions ?? LivePromptPreset.concise.defaultInstructions,
            isBuiltIn: false
        )
        promptProfiles.append(profile)
        savePromptProfiles()
        selectPrompt(profile.id)
    }

    func deleteSelectedPrompt() {
        guard let index = promptProfiles.firstIndex(where: { $0.id == config.selectedPromptID }),
              !promptProfiles[index].isBuiltIn else { return }
        promptProfiles.remove(at: index)
        savePromptProfiles()
        selectPrompt(promptProfiles.first?.id ?? LivePromptLibrary.defaultPromptID)
    }

    private func editableSelectedPromptIndex() -> Int? {
        guard let index = promptProfiles.firstIndex(where: { $0.id == config.selectedPromptID }) else { return nil }
        guard promptProfiles[index].isBuiltIn else { return index }
        let copy = LivePromptProfile(
            id: UUID().uuidString,
            title: "\(promptProfiles[index].title) Copy",
            instructions: promptProfiles[index].instructions,
            isBuiltIn: false
        )
        promptProfiles.append(copy)
        config.selectedPromptID = copy.id
        config.promptTitle = copy.title
        config.promptInstructions = copy.instructions
        savePromptProfiles()
        persist()
        return promptProfiles.count - 1
    }

    func updateResponseModality(_ modality: LiveResponseModality) {
        config.responseModality = modality
        persist()
    }

    func updateReasoningEffort(_ effort: LiveReasoningEffort) {
        config.reasoningEffort = effort
        persist()
    }

    func updateMaxResponseOutputTokens(_ tokens: Int?) {
        config.maxResponseOutputTokens = tokens.map { min(max($0, 1), 4_096) }
        persist()
    }

    func updateToolChoice(_ choice: LiveToolChoice) {
        config.toolChoice = choice
        persist()
    }

    func updateParallelToolCallsEnabled(_ isEnabled: Bool) {
        config.parallelToolCallsEnabled = isEnabled
        persist()
    }

    func updateRealtimeVoice(_ voice: LiveRealtimeVoice) {
        config.realtimeVoice = voice
        persist()
    }

    func updateNoiseReduction(_ reduction: LiveNoiseReduction) {
        config.noiseReduction = reduction
        persist()
    }

    func updateAudioOutputDestination(_ destination: LiveAudioOutputDestination) {
        config.audioOutputDestination = destination
        // Speaker/earpiece is a live control (like mute and camera front/back):
        // switch the running output immediately, not at the next session.
        audioOutputPlayer.updateDestination(destination)
        persist()
    }

    func updateToolsEnabled(_ enabled: Bool) {
        config.toolsEnabled = enabled
        persist()
    }

    /// "Respond only when I talk" toggle. Persists, and applies live if connected:
    /// on → disable VAD auto-response; off → restore (unless Stay Silent / camera
    /// quiet still wants it off).
    func updateSpeakOnlyWhenSpokenTo(_ enabled: Bool) {
        config.speakOnlyWhenSpokenTo = enabled
        persist()
        guard phase == .connected, let provider else { return }
        let cfg = liveConfig
        if enabled {
            Task { [weak provider] in try? await provider?.setVisualQuietMode(true, config: cfg) }
        } else if !staySilentActive && !isStreamingVisual {
            // Only restore auto-response if nothing else needs it off.
            Task { [weak provider] in try? await provider?.setVisualQuietMode(false, config: cfg) }
        }
    }

    func configureGatewayBridge(gatewayURL: URL, activeChatSessionKey: String) {
        defaultBrokerURL = gatewayURL
        gatewayBridge = LiveGatewayBridge(gatewayURL: gatewayURL)
        self.activeChatSessionKey = activeChatSessionKey
    }

    func updateGatewayBridgeEnabled(_ enabled: Bool) {
        config.gatewayBridgeEnabled = enabled
        if enabled && config.gatewayBridgeSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            config.gatewayBridgeSessionMode = .fixed
            config.gatewayBridgeSessionKey = "realtime:main"
        }
        persist()
    }

    func updateGatewayBridgeRequired(_ required: Bool) {
        config.gatewayBridgeRequired = required
        persist()
    }

    func updateGatewayBridgeSessionMode(_ mode: LiveGatewayBridgeSessionMode) {
        config.gatewayBridgeSessionMode = mode
        switch mode {
        case .temporary:
            config.gatewayBridgeSessionKey = currentRealtimeBridgeSessionKey()
        case .activeChat:
            config.gatewayBridgeSessionKey = activeChatSessionKey ?? "ios:main"
        case .fixed:
            if config.gatewayBridgeSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                config.gatewayBridgeSessionKey = "realtime:main"
            }
        }
        persist()
    }

    func updateGatewayBridgeSessionKey(_ key: String) {
        config.gatewayBridgeSessionKey = key
        persist()
    }

    func updateGatewayBridgeFeedMode(_ mode: LiveGatewayBridgeFeedMode) {
        config.gatewayBridgeFeedMode = mode
        persist()
    }

    func updateOpeningBehavior(_ behavior: LiveOpeningBehavior) {
        config.openingBehavior = behavior
        persist()
    }

    func updateInputTranscriptionEnabled(_ enabled: Bool) {
        config.inputTranscriptionEnabled = enabled
        persist()
    }

    func updateInputTranscriptionModel(_ model: String) {
        config.inputTranscriptionModel = model
        persist()
    }

    func updateOutputTranscriptionEnabled(_ enabled: Bool) {
        config.outputTranscriptionEnabled = enabled
        persist()
    }

    func updateShowSystemMessages(_ enabled: Bool) {
        config.showSystemMessages = enabled
        persist()
    }

    func updateDiagnosticsLevel(_ level: LiveDiagnosticsLevel) {
        config.diagnosticsLevel = level
        persist()
    }

    func updateShowVisualFramesInTranscript(_ enabled: Bool) {
        config.showVisualFramesInTranscript = enabled
        persist()
    }

    /// Toggle live server-side owner recognition. When on (and an owner voice is
    /// enrolled), finalized live turns are scored against the owner template and the
    /// transcript shows who is speaking. Off by default.
    func updateVoiceprintRealtimeEnabled(_ enabled: Bool) {
        config.voiceprintRealtimeEnabled = enabled
        persist()
    }

    func updateVisualDedupEnabled(_ enabled: Bool) {
        config.visualDedupEnabled = enabled
        persist()
    }

    func updateKeepRunningOffscreen(_ enabled: Bool) {
        config.keepRunningOffscreen = enabled
        persist()
        append(enabled ? "Live will keep running offscreen" : "Live will stop when leaving the screen")
        appendSystemMessage(enabled ? "Live will keep running offscreen" : "Live will stop when leaving the screen")
    }

    func updateLockScreenMode(_ mode: LiveLockScreenMode) {
        config.lockScreenMode = mode
        persist()
        appendSystemMessage("Lock Screen controls: \(mode.label)")
        startLiveControlCommandObservingIfNeeded()
        updateWidgetStatus(contextLine: mode.description)
    }

    func updateEchoCancellationEnabled(_ enabled: Bool) {
        config.echoCancellationEnabled = enabled
        persist()
    }

    func handleViewDisappear() async {
        guard phase.isActive else { return }
        // Switching tabs keeps the Live session running: the capture session and
        // provider stay alive (the app is still foreground), and the camera
        // preview re-attaches to the same running session when the Live tab
        // reappears. This is decoupled from `keepRunningOffscreen`, which still
        // governs true backgrounding via handleScenePhaseChange.
        diagnostics.lastLifecycleEvent = lifecycleSummary("Left Live tab")
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
        append("Live kept running after leaving the tab")
        appendSystemMessage(diagnostics.lastLifecycleEvent)
    }

    func handleScenePhaseChange(from oldPhase: ScenePhase, to newPhase: ScenePhase) {
        // Auto-recovery on return must run even when phase is .idle — a background
        // stop already tore the session down — so it sits OUTSIDE the isActive
        // guard below. (#673)
        if newPhase == .active, oldPhase == .background || oldPhase == .inactive {
            Task { @MainActor in await recoverInterruptedSessionIfArmed() }
        }
        guard phase.isActive else { return }
        switch newPhase {
        case .background:
            if config.keepRunningOffscreen {
                diagnostics.lastLifecycleEvent = lifecycleSummary("App backgrounded")
                diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
                diagnostics.audioRoute = Self.audioRouteLabel()
                append("Live continuing in background")
                appendSystemMessage(diagnostics.lastLifecycleEvent)
            } else {
                // Auto-stop on background, but ARM recovery so returning within the
                // window auto-restarts (userInitiated:false keeps recovery armed —
                // only a manual Stop cancels it). (#673)
                armInterruptedRecovery()
                append("Stopping Live because the app moved to background")
                appendSystemMessage("Stopping Live because the app moved to background")
                Task { await stop(userInitiated: false) }
            }
        case .active:
            guard oldPhase == .background || oldPhase == .inactive else { return }
            diagnostics.lastLifecycleEvent = lifecycleSummary("App active")
            diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
            diagnostics.audioRoute = Self.audioRouteLabel()
            append("Live app active")
            appendSystemMessage(diagnostics.lastLifecycleEvent)
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    func startNewSession() {
        guard !phase.isActive else { return }
        // Switching session context dismisses any stale "can't start" alert.
        pendingUserAlert = nil
        saveCurrentSession()
        let session = Self.makeEmptySession()
        currentSessionID = session.id
        conversation = []
        currentAssistantEntryID = nil
        currentUserAudioEntryID = nil
        transcriptEntryByItemID = [:]
        assistantEntryByItemID = [:]
        toolEntryByCallID = [:]
        streamingText.text.removeAll()
        localSessions.insert(session, at: 0)
        if config.gatewayBridgeSessionMode == .temporary {
            config.gatewayBridgeSessionKey = currentRealtimeBridgeSessionKey()
            persist()
        }
        persistSessions()
    }

    func selectSession(_ session: LiveLocalSession) {
        guard !phase.isActive else { return }
        // Switching session context dismisses any stale "can't start" alert.
        pendingUserAlert = nil
        saveCurrentSession()
        currentSessionID = session.id
        conversation = LiveSessionArchive.loadConversation(sessionID: session.id)
        updateCurrentSessionSnapshot()
        currentAssistantEntryID = nil
        currentUserAudioEntryID = nil
        transcriptEntryByItemID = [:]
        assistantEntryByItemID = [:]
        toolEntryByCallID = [:]
        streamingText.text.removeAll()
        if config.gatewayBridgeSessionMode == .temporary {
            config.gatewayBridgeSessionKey = currentRealtimeBridgeSessionKey()
            persist()
        }
        LiveSessionArchive.saveCurrentSessionID(session.id)
    }

    func deleteSession(_ session: LiveLocalSession) {
        localSessions.removeAll { $0.id == session.id }
        if localSessions.isEmpty {
            let replacement = Self.makeEmptySession()
            localSessions = [replacement]
            currentSessionID = replacement.id
            conversation = []
        } else if currentSessionID == session.id {
            currentSessionID = localSessions[0].id
            conversation = LiveSessionArchive.loadConversation(sessionID: localSessions[0].id)
            updateCurrentSessionSnapshot()
        }
        persistSessions()
    }

    func archiveSession(_ session: LiveLocalSession) {
        guard !phase.isActive,
              let index = localSessions.firstIndex(where: { $0.id == session.id }) else { return }
        localSessions[index].isArchived = true
        if currentSessionID == session.id {
            if let replacement = localSessions.first(where: { !$0.isArchived }) {
                currentSessionID = replacement.id
                conversation = LiveSessionArchive.loadConversation(sessionID: replacement.id)
                updateCurrentSessionSnapshot()
            } else {
                let replacement = Self.makeEmptySession()
                localSessions.insert(replacement, at: 0)
                currentSessionID = replacement.id
                conversation = []
            }
        }
        persistSessions()
    }

    func toggleBookmark(_ session: LiveLocalSession) {
        guard let index = localSessions.firstIndex(where: { $0.id == session.id }) else { return }
        localSessions[index].isBookmarked.toggle()
        sortLocalSessions()
        persistSessions()
    }

    func renameSession(_ session: LiveLocalSession, title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let index = localSessions.firstIndex(where: { $0.id == session.id }) else { return }
        localSessions[index].title = trimmed
        sortLocalSessions()
        persistSessions()
    }

    /// `configOverride`, when non-nil, is the config this session runs with INSTEAD
    /// of the draft `config`. It is used verbatim for the session snapshot
    /// (`activeConfig`) but is NEVER written back to the draft or persisted (the
    /// only draft write below remains the resolved gatewayBridgeSessionKey), so
    /// temporary session shapes — e.g. the enrollment listening session — cannot
    /// leak into the user's saved settings.
    func start(
        recordingTransport: GatewayTransport? = nil,
        configOverride: LiveSessionConfig? = nil
    ) async {
        guard !phase.isActive else { return }
        // Remember the transport so auto-recovery (scene-phase, no container) can
        // restart with the same recording target; a fresh start cancels any
        // pending interruption recovery. (#673)
        lastRecordingTransport = recordingTransport
        cancelInterruptedRecovery()
        // Blocked preconditions surface as the centered alert (general channel),
        // not a `.failed` banner — the session never entered a failed state, it
        // just couldn't begin.
        if let block = startBlockReason {
            presentUserAlert(.startBlocked(block))
            diagnostics.lastError = block.message
            return
        }

        let startStartedAt = Date()
        var startTimingMarks: [String] = []
        func elapsedLabel(since date: Date) -> String {
            "\(Int(Date().timeIntervalSince(date) * 1000)) ms"
        }
        func recordStartTiming(_ label: String, since date: Date) {
            startTimingMarks.append("\(label): \(elapsedLabel(since: date))")
        }

        let prepareStartedAt = Date()
        var effectiveConfig = configOverride ?? config
        audioOutputPlayer.updateDestination(effectiveConfig.audioOutputDestination)
        if effectiveConfig.provider == .openAIRealtime {
            effectiveConfig.openAICredentialMode = .directAPIKey
            effectiveConfig.responseModality = .audio
            // Note: visualSource/visualCadence are intentionally NOT forced off
            // here. The provider ignores them (frames flow through sendFrame),
            // and the local camera capture follows the user's choice — forcing
            // them off was dead code masked by the pre-snapshot draft reads.
            //
            // mediaPersistenceMode is NO LONGER forced off. The WebRTC provider
            // owns the realtime mic so it never tees PCM to recordingSink;
            // startRecording now runs a parallel mic tap for these providers so the
            // user's record setting (default .local) actually produces a recording.
            // (Assistant audio still isn't captured client-side — the packaged
            // WebRTC headers don't expose decoded PCM for the remote track.)
            effectiveConfig.openingBehavior = .silent
            refreshDirectOpenAIAPIKeyStatus()
        }
        // WS2 (closes #12): live owner recognition needs the turn audio streamed to the
        // gateway DURING the session so the gateway auto-score sees it in time. Coerce
        // media persistence to liveUpload whenever recognition is on — .off/.local/
        // .deferredUpload all become .liveUpload. Applied to `effectiveConfig` (which
        // becomes `activeConfig`) so the parallel-mic gate and the voiceprint runtime
        // target — both of which require mediaPersistenceMode != .off — agree. This
        // "just works" instead of surfacing a disabled hint. OFF-BY-DEFAULT: gated on
        // `voiceprintRealtimeEnabled`, so flag off leaves the mode byte-for-byte
        // unchanged.
        if effectiveConfig.voiceprintRealtimeEnabled,
           effectiveConfig.mediaPersistenceMode != .liveUpload {
            appendSystemMessage(
                "Live owner recognition on — media set to live upload",
                detail: "Turn audio streams to your Hawky machine during the session so it can recognize the speaker."
            )
            effectiveConfig.mediaPersistenceMode = .liveUpload
        }
        effectiveConfig.bridgeAvailability = effectiveConfig.gatewayBridgeEnabled ? .available : .disabled
        phase = .connecting
        bridgeStatus = .idle
        toolCameraFrames.clear()
        // A start is now underway — clear any stale "can't start" alert so it
        // can't linger over a connecting/connected session.
        pendingUserAlert = nil
        updateWidgetStatus(liveState: .connecting)
        diagnostics = LiveSessionDiagnostics(
            providerLabel: effectiveConfig.provider.label,
            providerStatus: "Connecting",
            connectedAt: nil,
            lastLatencyMs: nil,
            audioChunksSent: 0,
            micChunksCaptured: 0,
            micBytesCaptured: 0,
            lastMicCaptureAt: nil,
            audioSessionStatus: Self.audioSessionStatusLabel(),
            audioRoute: Self.audioRouteLabel(),
            audioInterruptions: diagnostics.audioInterruptions,
            audioRouteChanges: diagnostics.audioRouteChanges,
            lastLifecycleEvent: "Starting",
            visualStatus: effectiveConfig.visualSource == .off ? "Off" : "Starting",
            visualFramesCaptured: 0,
            visualBytesCaptured: 0,
            lastVisualCaptureAt: nil,
            outputAudioChunksReceived: 0,
            outputAudioBytesReceived: 0,
            outputAudioChunksPlayed: 0,
            outputAudioBytesPlayed: 0,
            outputAudioStatus: "Idle",
            toolCallsReceived: 0,
            toolCallsCompleted: 0,
            lastToolCall: "None",
            framesSent: 0,
            reconnects: 0,
            lastModelEvent: "None",
            lastError: nil
        )
        resetOutputAudioDiagnosticsTotals()
        append("Connecting \(effectiveConfig.provider.label)")
        appendSystemMessage("Connecting \(effectiveConfig.provider.label)")
        recordStartTiming("prepare", since: prepareStartedAt)

        if effectiveConfig.gatewayBridgeEnabled {
            let bootContextStartedAt = Date()
            effectiveConfig.gatewayBridgeSessionKey = resolvedGatewayBridgeSessionKey(for: effectiveConfig)
            config.gatewayBridgeSessionKey = effectiveConfig.gatewayBridgeSessionKey
            persist()
            // Boot context and the prompt-registry persona (#512) are independent
            // gateway round-trips. Kick the persona off CONCURRENTLY so a slow or
            // unreachable gateway costs one timeout window, not two back-to-back
            // (the old serial pair was a big chunk of the start-up spinner when the
            // machine was offline). Capture the inputs as immutable copies first — the
            // child task must not read `effectiveConfig` while the main flow mutates it.
            let personaPromptId = effectiveConfig.promptPreset.promptRegistryId
            let personaSessionKey = effectiveConfig.gatewayBridgeSessionKey
            let personaBridge = gatewayBridge
            async let personaFetch: String? = {
                guard let personaPromptId, let personaBridge else { return nil }
                return await personaBridge.fetchPrompt(id: personaPromptId, sessionKey: personaSessionKey)
            }()
            // The boot-context fetch doubles as the gateway reachability probe. When
            // the machine is unreachable the WebRTC leg below still connects to
            // OpenAI, so without this check the session reads "Connected" with its
            // memory + tools silently dead. Required mode turns that into a hard fail.
            let bootResult = await fetchStartupBootContext(config: effectiveConfig)
            if case .loaded(let bootContext) = bootResult {
                effectiveConfig.startupBootContext = bootContext.context
                effectiveConfig.startupFirstContactActive = bootContext.firstContact.active
            }
            let bridgeDecision = Self.bridgeStartDecision(for: bootResult, required: effectiveConfig.gatewayBridgeRequired)
            effectiveConfig.bridgeAvailability = Self.bridgeAvailability(for: bridgeDecision)
            switch bridgeDecision {
            case .connected:
                bridgeStatus = .connected
            case .offline(let detail):
                bridgeStatus = .offline(detail)
            case .requiredFailure(let detail):
                // Await the concurrent persona task so it finishes/cancels cleanly
                // before we bail (it has already started — it's ~done by now).
                _ = await personaFetch
                failStartGatewayUnavailable(detail: detail)
                return
            }
            // Persona falls back to the bundled default when the fetch returns nil
            // (offline / gateway down). Already running — usually done by this point.
            if let persona = await personaFetch {
                effectiveConfig.fetchedPersona = persona
            }
            recordStartTiming("boot context", since: bootContextStartedAt)
        }
        let historyReplayTurns = turnsForHistoryReplay()
        journalRaw(
            direction: .sent,
            type: "history.replay.prepared",
            json: Self.historyReplayJSON(turns: historyReplayTurns, config: effectiveConfig),
            providerLabel: effectiveConfig.provider.label
        )
        let nextProvider = LiveSessionProviderFactory.makeProvider(for: effectiveConfig, gatewayBridge: gatewayBridge)
        resetVoiceprintRealtimeQueue()
        enqueueVoiceprintRealtimeResetIfNeeded(config: effectiveConfig)
        if nextProvider.seedsHistoryOnConnect {
            effectiveConfig.historyReplayTurns = historyReplayTurns
            journalRaw(
                direction: .sent,
                type: "history.replay.initial_messages",
                json: Self.initialMessagesJSON(turns: historyReplayTurns, config: effectiveConfig),
                providerLabel: effectiveConfig.provider.label
            )
        }
        // Wire the transcript-append await hook so scan_intention can wait for the
        // most-recently finalized turn to be appended before querying the gateway.
        if let rtProvider = nextProvider as? OpenAIRealtimeLiveSessionProvider {
            rtProvider.awaitPendingTranscriptAppend = { [weak self] in
                await self?.awaitPendingTranscriptAppend()
            }
            rtProvider.summarizeHook = { [weak self] scope in
                guard let self, let summarize = self.summarizeProvider else {
                    throw LiveSummaryError.agent("Summarization is not available.")
                }
                return try await summarize(scope)
            }
            rtProvider.silenceSummaryHook = { [weak self] in
                self?.captureSilenceWindowRecap() ?? "No Stay Silent window was captured."
            }
            rtProvider.cocktailPartyActiveHook = { [weak self] in self?.cocktailPartyActive ?? false }
            rtProvider.identifyOnCameraHook = { [weak self] in
                await self?.identifyLatestFrameResult() ?? .noMatch
            }
            rtProvider.resolveCameraPersonHook = { [weak self] name in
                await self?.resolveCameraPersonResult(name: name) ?? .noMatch
            }
            rtProvider.latestCameraFrameHook = { [weak self] in
                await self?.latestCameraFrameForTool()
            }
        }
        // Same hooks for the WebRTC (Pipecat) provider — the active realtime path.
        if let rtcProvider = nextProvider as? PipecatOpenAIRealtimeLiveSessionProvider {
            rtcProvider.awaitPendingTranscriptAppend = { [weak self] in
                await self?.awaitPendingTranscriptAppend()
            }
            rtcProvider.summarizeHook = { [weak self] scope in
                guard let self, let summarize = self.summarizeProvider else {
                    throw LiveSummaryError.agent("Summarization is not available.")
                }
                return try await summarize(scope)
            }
            rtcProvider.silenceSummaryHook = { [weak self] in
                self?.captureSilenceWindowRecap() ?? "No Stay Silent window was captured."
            }
            rtcProvider.cocktailPartyActiveHook = { [weak self] in self?.cocktailPartyActive ?? false }
            rtcProvider.identifyOnCameraHook = { [weak self] in
                await self?.identifyLatestFrameResult() ?? .noMatch
            }
            rtcProvider.resolveCameraPersonHook = { [weak self] name in
                await self?.resolveCameraPersonResult(name: name) ?? .noMatch
            }
            rtcProvider.latestCameraFrameHook = { [weak self] in
                await self?.latestCameraFrameForTool()
            }
        }
        provider = nextProvider

        eventTask?.cancel()
        eventTask = Task { [weak self, nextProvider] in
            for await event in nextProvider.events() {
                self?.handle(event)
            }
        }

        do {
            // Recording mic must start before connect() grabs the audio device —
            // two voice-processing engines fighting for the mic crash CoreAudio.
            await startRecordingIfNeeded(transport: recordingTransport, config: effectiveConfig)
            let connectStartedAt = Date()
            try await nextProvider.connect(config: effectiveConfig)
            recordStartTiming("provider connect", since: connectStartedAt)
            guard let currentProvider = provider,
                  currentProvider === nextProvider,
                  phase == .connecting else {
                await nextProvider.close()
                return
            }
            let sessionConfigStatus = nextProvider.sessionConfigStatus
            markStartupBootContextInjectedIfNeeded(effectiveConfig.startupBootContext)
            phase = .connected
            // Freeze the config this session is actually running with. The
            // running pipeline reads `liveConfig` (this snapshot) so settings
            // edited mid-session apply to the next session, not this one.
            activeConfig = effectiveConfig
            updateWidgetStatus(liveState: .on)
            diagnostics.connectedAt = Date()
            diagnostics.providerStatus = sessionConfigStatus.connectedProviderStatus
            diagnostics.sessionConfigStatus = sessionConfigStatus.diagnosticsLabel
            diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
            diagnostics.audioRoute = Self.audioRouteLabel()
            let connectedLevel: LiveEventLogEntry.Level
            let connectedDetail: String?
            switch sessionConfigStatus {
            case .unconfirmed(let detail):
                connectedLevel = .warning
                connectedDetail = detail
            default:
                connectedLevel = .info
                connectedDetail = nil
            }
            append(sessionConfigStatus.connectedMessage, level: connectedLevel, detail: connectedDetail)
            appendSystemMessage(sessionConfigStatus.connectedMessage, level: connectedLevel, detail: connectedDetail)
            // Replay recent turns so a reconnected/resumed session remembers the
            // conversation (Realtime starts blank otherwise). Skipped on a fresh
            // session that has no prior turns.
            let seedStartedAt = Date()
            if !nextProvider.seedsHistoryOnConnect {
                await seedHistoryIfNeeded(provider: nextProvider, turns: historyReplayTurns)
            } else if !historyReplayTurns.isEmpty {
                appendSystemMessage("Restored \(historyReplayTurns.count) prior turn\(historyReplayTurns.count == 1 ? "" : "s") of context")
            }
            recordStartTiming("seed history", since: seedStartedAt)
            // Assert QUIET first — BEFORE the Hawky bridge feed starts. The bridge
            // floods context items; if it runs before quiet is engaged, those appends
            // collide with the still-open startup response → the
            // conversation_already_has_active_response storm (and the model greets/
            // narrates). Engaging safety/visual-quiet up front closes that race.
            await setupSafetyIfNeeded(config: effectiveConfig, provider: nextProvider)
            if effectiveConfig.speakOnlyWhenSpokenTo {
                try? await nextProvider.setVisualQuietMode(true, config: effectiveConfig)
            }
            if effectiveConfig.gatewayBridgeEnabled {
                append("Hawky bridge: \(effectiveConfig.gatewayBridgeSessionKey)")
                appendSystemMessage("Hawky bridge: \(effectiveConfig.gatewayBridgeSessionKey)")
                if effectiveConfig.bridgeToolsAvailable {
                    bootstrapGatewayBridge(config: effectiveConfig)
                }
                startGatewayBridgeStreamIfNeeded(config: effectiveConfig, provider: nextProvider)
            }
            setupCocktailPartyIfNeeded(config: effectiveConfig, provider: nextProvider)
            // SKIP the opening greeting when quiet ("Respond only when I talk" OR Safety
            // Check). Only start it when neither quiet mode is on.
            if !effectiveConfig.speakOnlyWhenSpokenTo, !effectiveConfig.safetyCheckEnabled {
                let openingStartedAt = Date()
                await startOpeningIfNeeded(config: effectiveConfig, provider: nextProvider)
                recordStartTiming("opening", since: openingStartedAt)
            }
            if effectiveConfig.audioInputEnabled {
                let audioStartedAt = Date()
                await startAudioStream()
                recordStartTiming("audio input", since: audioStartedAt)
            } else {
                diagnostics.audioSessionStatus = "Audio input off"
                appendSystemMessage("Audio input off")
            }
            let visualStartedAt = Date()
            await startVisualStreamIfNeeded(provider: nextProvider)
            recordStartTiming("visual input", since: visualStartedAt)
            diagnostics.lastLifecycleEvent = "Started in \(elapsedLabel(since: startStartedAt))"
            append(
                "Start timing: \(elapsedLabel(since: startStartedAt))",
                detail: startTimingMarks.joined(separator: "\n")
            )
            // Connected with mic requested — watch for a connected-but-mute mic
            // (another app held it from before start, so no interruption fired). (#673)
            scheduleMicInputWatchdogIfNeeded()
        } catch {
            let message = error.localizedDescription
            guard let currentProvider = provider,
                  currentProvider === nextProvider,
                  phase == .connecting else {
                await nextProvider.close()
                return
            }
            activeConfig = nil
            diagnostics.providerStatus = "Failed"
            diagnostics.lastError = message
            await nextProvider.close()
            provider = nil
            // Recording may have started before connect (WebRTC mic-first ordering);
            // tear it down so a failed session doesn't leave the mic engine running.
            if isRecording { await stopRecording() }
            eventTask?.cancel()
            eventTask = nil
            gatewayBridgeStreamTask?.cancel()
            gatewayBridgeStreamTask = nil
            await stopVisualStream()
            recordStartTiming("failed total", since: startStartedAt)
            append(
                "Start timing failed",
                level: .error,
                detail: startTimingMarks.joined(separator: "\n")
            )

            // A rejected/expired key is the same user problem as having no key —
            // route it to the general alert with an Open Live Settings shortcut
            // (not the failure banner). The session never connected, so we settle
            // back to idle rather than leaving a sticky failed state.
            if case let LiveSessionProviderError.authenticationFailed(authMessage) = error {
                phase = .idle
                // Settle diagnostics to match the idle phase (don't leave a stale
                // "Failed" provider status behind the dismissible alert).
                diagnostics.providerStatus = "Idle"
                updateWidgetStatus(liveState: .off)
                // Reuse the thrown message (single-sourced in the classifier).
                presentUserAlert(.authenticationRejected(authMessage))
            } else {
                phase = .failed(message)
                updateWidgetStatus(liveState: .failed)
                append(message, level: .error)
                appendSystemMessage(message, level: .error)
            }
        }
    }

    /// Required-mode hard fail: the bridge is enabled and the user asked for the
    /// gateway to be mandatory, but it's unavailable (unreachable, or — in the
    /// theoretical pre-configuration window — not configured). Abort the start
    /// before the WebRTC leg connects to OpenAI so we don't present a "Connected"
    /// session whose machine-backed memory + tools are dead. Called from `start()`
    /// before the provider, recording, or event task are created, so teardown is
    /// minimal. `detail` carries the underlying cause and reads correctly for both.
    private func failStartGatewayUnavailable(detail: String) {
        let message = "Live needs your Hawky machine, but it's unavailable — \(detail)"
        phase = .failed(message)
        bridgeStatus = .offline(detail)
        activeConfig = nil
        updateWidgetStatus(liveState: .failed)
        diagnostics.providerStatus = "Failed"
        diagnostics.lastError = message
        diagnostics.lastLifecycleEvent = "Gateway unavailable (required)"
        append(message, level: .error)
        appendSystemMessage(
            "Your Hawky machine is unavailable",
            level: .error,
            detail: "\(detail)\n\nGateway connection is set to required, so Live did not start. Turn off \"Require gateway connection\" in Live Settings to connect without your machine."
        )
    }

    /// `userInitiated` distinguishes the user tapping Stop (cancels any pending
    /// auto-recovery) from an automatic stop (backgrounding) that wants to keep
    /// recovery armed. (#673)
    func stop(userInitiated: Bool = true) async {
        // Ending the session clears any pending notice (e.g. the mic-interrupted
        // "Live paused" card) so it can't linger over the idle stage. (#673 review)
        pendingUserAlert = nil
        cancelMicInputWatchdog()
        if userInitiated {
            cancelInterruptedRecovery()
        }
        // Stay Silent is session-scoped; reset it when the session ends. So is the
        // enrollment listening session — clearing it here covers non-user stops
        // (backgrounding, provider failure) as well as the explicit stop path.
        enrollmentListeningActive = false
        staySilentActive = false
        silenceStartedAt = nil
        silenceTranscript.removeAll()
        silenceFrameCount = 0
        // Cocktail Party Mode is session-scoped too (the profile DB persists; the
        // per-session recognizer/cooldowns do not).
        teardownCocktailParty()
        teardownSafety()
        resetVoiceprintRealtimeQueue()
        guard phase.isActive || provider != nil else {
            phase = .idle
            bridgeStatus = .idle
            return
        }
        let stopStartedAt = Date()
        var stopTimingMarks: [String] = []
        func elapsedLabel(since date: Date) -> String {
            "\(Int(Date().timeIntervalSince(date) * 1000)) ms"
        }
        func recordStopTiming(_ label: String, since date: Date) {
            stopTimingMarks.append("\(label): \(elapsedLabel(since: date))")
        }

        phase = .stopping
        diagnostics.providerStatus = "Stopping"
        diagnostics.lastLifecycleEvent = "Stopping"
        append("Stopping")
        if isRecording {
            let recordingStartedAt = Date()
            await stopRecording()
            recordStopTiming("recording", since: recordingStartedAt)
        }
        if isRecordingAudioSample {
            let sampleStartedAt = Date()
            _ = await stopAudioSample(send: false)
            recordStopTiming("audio sample", since: sampleStartedAt)
        }
        stopRawAudioTrackSegmentIfNeeded()
        if isStreamingAudio {
            let audioStartedAt = Date()
            await stopAudioStream()
            recordStopTiming("audio input", since: audioStartedAt)
        }
        if isStreamingVisual {
            let visualStartedAt = Date()
            await stopVisualStream()
            recordStopTiming("visual input", since: visualStartedAt)
        }
        let activeProvider = provider
        provider = nil
        gatewayBridgeStreamTask?.cancel()
        gatewayBridgeStreamTask = nil
        let providerCloseStartedAt = Date()
        await activeProvider?.close()
        recordStopTiming("provider close", since: providerCloseStartedAt)
        audioOutputPlayer.stop()
        eventTask?.cancel()
        eventTask = nil
        let endedSessionKey = Self.resolvedRuntimeGatewayBridgeSessionKey(
            from: liveConfig,
            fallback: "realtime:main"
        )
        // Land any in-flight streamed text into the committed entries and clear
        // the holder. (#623)
        commitStreamingText()
        lastScrollTickAt = nil
        currentAssistantEntryID = nil
        currentUserAudioEntryID = nil
        transcriptEntryByItemID = [:]
        assistantEntryByItemID = [:]
        toolEntryByCallID = [:]
        streamingText.text.removeAll()
        phase = .idle
        bridgeStatus = .idle
        activeConfig = nil
        pausedAudioWasStreaming = false
        pausedVisualWasStreaming = false
        updateWidgetStatus(liveState: .off, recordingState: .off)
        diagnostics.providerStatus = "Idle"
        diagnostics.lastLifecycleEvent = "Stopped in \(elapsedLabel(since: stopStartedAt))"
        append("Stopped")
        appendSystemMessage("Session stopped")
        let saveStartedAt = Date()
        saveCurrentSession()
        recordStopTiming("save", since: saveStartedAt)
        append(
            "Stop timing: \(elapsedLabel(since: stopStartedAt))",
            detail: stopTimingMarks.joined(separator: "\n")
        )

        // Memory feature (#653): auto-distill the just-ended session into the
        // daily log. Detached + best-effort so it never delays teardown or blocks
        // the UI; failures (no gateway, no transcript) are swallowed.
        Task.detached { [weak self, endedSessionKey] in
            await self?.distillEndedSessionIntoDailyMemory(sessionKey: endedSessionKey)
        }
    }

    func pause() async {
        guard phase == .connected else { return }
        cancelMicInputWatchdog()
        pausedAudioWasStreaming = isStreamingAudio
        pausedVisualWasStreaming = isStreamingVisual
        stopRawAudioTrackSegmentIfNeeded()
        if isStreamingAudio {
            await stopAudioStream(deactivateAudioSession: liveConfig.responseModality != .audio)
        }
        if isStreamingVisual {
            await stopVisualStream()
        }
        phase = .paused
        diagnostics.providerStatus = "Paused"
        diagnostics.lastLifecycleEvent = "Live paused"
        updateWidgetStatus(liveState: .paused, contextLine: "Live paused")
        append("Paused")
        appendSystemMessage("Live paused")
    }

    func resume() async {
        guard phase == .paused, let provider else { return }
        // Manual resume takes over — cancel any pending auto-recovery and clear the
        // "Live paused / mic in use" notice if it's still up. (#673)
        cancelInterruptedRecovery()
        pendingUserAlert = nil
        phase = .connected
        diagnostics.providerStatus = "Connected"
        diagnostics.lastLifecycleEvent = "Live resumed"
        updateWidgetStatus(liveState: .on, contextLine: "Live resumed")
        append("Resumed")
        appendSystemMessage("Live resumed")

        if pausedAudioWasStreaming {
            await startAudioStream()
        }
        if pausedVisualWasStreaming {
            await startVisualStreamIfNeeded(provider: provider)
        }
        pausedAudioWasStreaming = false
        pausedVisualWasStreaming = false
    }

    func sendTestText(_ text: String) async {
        guard phase == .connected, let provider else { return }
        do {
            append("You: \(text)")
            appendUserMessage(text)
            try await provider.sendText(text)
        } catch {
            let message = error.localizedDescription
            diagnostics.lastError = message
            append(message, level: .error)
            appendSystemMessage(message, level: .error)
        }
    }

    func playAudioOutputProbe() {
        do {
            let data = Self.sineWavePCM16(frequency: 660, duration: 0.45)
            let result = try audioOutputPlayer.play(data)
            diagnostics.outputAudioChunksPlayed += 1
            diagnostics.outputAudioBytesPlayed += result.bytes
            diagnostics.outputAudioStatus = "Probe played (\(byteLabel(result.bytes)))"
            diagnostics.lastModelEvent = diagnostics.outputAudioStatus
            append(diagnostics.outputAudioStatus)
            appendSystemMessage(diagnostics.outputAudioStatus)
        } catch {
            let message = "Audio output probe failed: \(error.localizedDescription)"
            diagnostics.outputAudioStatus = "Playback failed"
            diagnostics.lastError = message
            append(message, level: .error)
            appendSystemMessage(message, level: .error)
        }
    }

    func startAudioSample() async {
        guard phase == .connected, !isRecordingAudioSample, !isStreamingAudio else { return }
        let recorder = LiveAudioSampleRecorder(enableEchoCancellation: liveConfig.echoCancellationEnabled)
        audioSampleRecorder = recorder
        recordedAudioBytes = 0
        isRecordingAudioSample = true
        append("Recording iPhone mic sample")
        appendSystemMessage("Recording iPhone mic sample")

        do {
            try await recorder.start { [weak self] chunk in
                await self?.addRecordedAudioBytes(chunk.data.count)
            }
        } catch {
            isRecordingAudioSample = false
            audioSampleRecorder = nil
            let message = error.localizedDescription
            diagnostics.lastError = message
            append(message, level: .error)
            appendSystemMessage(message, level: .error)
        }
    }

    func startAudioStream() async {
        guard phase == .connected, !isRecordingAudioSample, !isStreamingAudio, let provider else { return }
        if provider.managesAudioInput {
            do {
                try await provider.setAudioInputEnabled(true)
                isStreamingAudio = true
                updateWidgetStatus()
                diagnostics.lastLifecycleEvent = "Provider audio input on"
                diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
                diagnostics.audioRoute = Self.audioRouteLabel()
                append("Listening")
                appendSystemMessage("Listening")
            } catch {
                let message = error.localizedDescription
                diagnostics.lastError = message
                append(message, level: .error)
                appendSystemMessage(message, level: .error)
            }
            return
        }
        let recorder = LiveAudioSampleRecorder(enableEchoCancellation: liveConfig.echoCancellationEnabled)
        audioSampleRecorder = recorder
        recordedAudioBytes = 0
        isStreamingAudio = true
        updateWidgetStatus()
        diagnostics.lastLifecycleEvent = "Starting audio stream"
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
        append(liveConfig.turnDetectionMode == .manual ? "Streaming mic (manual turn)" : "Listening")
        appendSystemMessage(liveConfig.turnDetectionMode == .manual ? "Recording audio turn" : "Listening")

        do {
            try await recorder.start { [weak self, provider] chunk in
                do {
                    try await provider.streamAudio(chunk)
                    await self?.addRecordedAudioBytes(chunk.data.count)
                    // Tee the same mic chunk to the recorder sink when the user
                    // has turned on record for this Live session.
                    await self?.recordingSink.ingestAudio(chunk)
                } catch {
                    await self?.handle(.error(error.localizedDescription))
                }
            }
        } catch {
            isStreamingAudio = false
            audioSampleRecorder = nil
            updateWidgetStatus()
            let message = error.localizedDescription
            diagnostics.lastError = message
            append(message, level: .error)
            appendSystemMessage(message, level: .error)
        }
    }

    func toggleAudioInput() async {
        guard phase == .connected else { return }
        if isStreamingAudio {
            await stopAudioStream(deactivateAudioSession: liveConfig.responseModality != .audio)
        } else {
            await startAudioStream()
        }
    }

    /// Toggle recording the active Live session's streams to disk + upload.
    /// `transport` is the gateway transport for remote upload (nil = local
    /// only). Recording tees the audio/video Live is already streaming — it
    /// does not start any new capture engine.
    func toggleRecording(transport: GatewayTransport?) async {
        if isRecording {
            await stopRecording()
        } else {
            guard phase == .connected, let provider else { return }
            if provider.managesAudioInput {
                appendSystemMessage(
                    "Recording can only be enabled before this Live session starts. Turn on Save Live media for the next session.",
                    level: .warning
                )
                return
            }
            let cfg = liveConfig
            await startRecording(transport: transport, deferredUploadTransport: nil, config: cfg)
        }
    }

    private func startRecordingIfNeeded(transport: GatewayTransport?, config: LiveSessionConfig) async {
        // WS2 (closes #12): when live owner recognition is on, `config` has already
        // been coerced to .liveUpload upstream (in `start`) so the parallel-mic gate
        // and the voiceprint runtime target agree. This switch therefore records with
        // the live transport for the recognition path without a second coercion here.
        switch config.mediaPersistenceMode {
        case .off:
            break
        case .local:
            await startRecording(transport: nil, deferredUploadTransport: nil, config: config)
        case .liveUpload:
            await startRecording(transport: transport, deferredUploadTransport: nil, config: config)
        case .deferredUpload:
            await startRecording(transport: nil, deferredUploadTransport: transport, config: config)
        }
    }

    private func startRecording(
        transport: GatewayTransport?,
        deferredUploadTransport: GatewayTransport?,
        config: LiveSessionConfig
    ) async {
        guard !isRecording else { return }
        let hasVideo = config.visualSource != .off
        // config, not liveConfig: this runs before connect freezes activeConfig.
        let source = Self.manifestSource(for: config.visualSource)
        recordingSink.clearLastRecordingResult()

        if provider?.managesAudioInput == true {
            // WebRTC owns the realtime mic, so capture a separate mic just for the
            // recording (awaited before connect — see the call site).
            let started = await startParallelMicRecording(
                transport: transport,
                deferredUploadTransport: deferredUploadTransport,
                hasVideo: hasVideo,
                source: source
            )
            guard started else { return }  // mic unavailable; stay not-recording
        } else {
            // Legacy providers already tee mic chunks into the sink — just open it.
            recordingSink.start(
                transport: transport,
                deferredUploadTransport: deferredUploadTransport,
                hasVideo: hasVideo,
                source: source,
                audioSampleRate: LiveRecordingSink.defaultSampleRate
            )
        }

        isRecording = true
        updateWidgetStatus(recordingState: .on)

        let destination: String
        if transport != nil {
            destination = "locally + live gateway upload"
        } else if deferredUploadTransport != nil {
            destination = "locally, gateway upload after stop"
        } else {
            destination = "locally"
        }
        appendSystemMessage("Saving Live media \(destination)\(hasVideo ? " (audio + video)" : " (audio)")")
    }

    /// Captures the user mic into the recording sink, in parallel with a WebRTC
    /// provider that owns the realtime mic. Awaited so its engine is up before the
    /// provider's. WAV opens lazily at the tap's hardware rate. Returns false if the
    /// mic can't start. Model audio isn't captured (no PCM from the WebRTC track).
    @discardableResult
    private func startParallelMicRecording(
        transport: GatewayTransport?,
        deferredUploadTransport: GatewayTransport?,
        hasVideo: Bool,
        source: RecordingManifest.VideoSource
    ) async -> Bool {
        let mic = MicAudioSource(enableVoiceProcessing: true)
        do {
            try await mic.start()
        } catch {
            appendSystemMessage(
                "Recording mic unavailable: \(error.localizedDescription)",
                level: .error
            )
            return false
        }
        recordingMicSource = mic
        recordingMicTask = Task { [weak self] in
            var sinkStarted = false
            for await chunk in mic.samples {
                guard let self else { break }
                if !sinkStarted {
                    // Wait until the realtime mic is actually enabled before
                    // opening the file, avoiding pre-connect warmup silence.
                    guard self.isStreamingAudio else { continue }
                    sinkStarted = true
                    self.recordingSink.start(
                        transport: transport,
                        deferredUploadTransport: deferredUploadTransport,
                        hasVideo: hasVideo,
                        source: source,
                        audioSampleRate: chunk.sampleRate
                    )
                    // The WAV (and thus currentAudioArtifact) is now open. Late-bind any
                    // warm-up turn whose speech_stopped fired before this point, so a
                    // first-turn artifact is not permanently lost (server tracker drops
                    // turns with no audio when includeMissingAudio is false).
                    self.flushPendingVoiceprintAudioArtifacts()
                }
                // Mic-health signal: the realtime mic flows through WebRTC, not
                // the sample recorder, so this parallel tap is the only
                // client-side proxy for "are we actually capturing audio." Count
                // real (non-muted) chunks so the no-audio watchdog can tell a
                // working session from one where another app holds the mic. This
                // was the missing wiring that made the watchdog false-fire. (#673)
                if self.isStreamingAudio {
                    self.addRecordedAudioBytes(chunk.pcm.count)
                }
                // Preserve the recording timeline while muted. The recording
                // mic stays running to avoid restarting a second VPIO engine
                // mid-session; muted periods become silence in the WAV.
                let pcm = self.isStreamingAudio
                    ? chunk.pcm
                    : Data(repeating: 0, count: chunk.pcm.count)
                self.recordingSink.ingestAudio(
                    LiveAudioChunk(
                        data: pcm,
                        formatDescription: "pcm16/mono/\(Int(chunk.sampleRate))",
                        capturedAt: Date()
                    )
                )
            }
        }
        return true
    }

    func stopRecording() async {
        guard isRecording else { return }
        isRecording = false
        updateWidgetStatus(recordingState: .off)
        recordingMicTask?.cancel()
        recordingMicTask = nil
        await recordingMicSource?.stop()
        recordingMicSource = nil
        await recordingSink.stop()
        if let url = recordingSink.lastRecordingURL {
            appendSystemMessage("Recording saved: \(url.lastPathComponent)")
            if recordingSink.lastDeferredUploadStarted {
                appendSystemMessage("Deferred media upload started")
            }
        } else {
            appendSystemMessage("Recording stopped")
        }
    }

    private func updateWidgetStatus(
        liveState: WidgetStatus.LiveState? = nil,
        recordingState: WidgetStatus.RecordingState? = nil,
        contextLine: String? = nil,
        detailLine: String? = nil
    ) {
        let previous = WidgetStatusStore.read()
        var status = previous
        if let liveState {
            status.liveState = liveState
        }
        if let recordingState {
            status.recordingState = recordingState
        }
        if let contextLine {
            status.contextLine = Self.lockScreenLine(contextLine)
        }
        if let detailLine {
            status.detailLine = Self.lockScreenLine(detailLine)
        }
        status.updatedAt = .now
        // The accessory widget only reads the stored status fields (not mic state), so
        // skip the cross-process write + extension reload when none of them changed —
        // this keeps per-token transcript churn from waking the widget needlessly.
        // The Live Activity is synced unconditionally; its snapshot dedup (which DOES
        // track mic state) decides whether an ActivityKit update is actually spent.
        let storedFieldsChanged = status.liveState != previous.liveState
            || status.recordingState != previous.recordingState
            || status.contextLine != previous.contextLine
            || status.detailLine != previous.detailLine
        if storedFieldsChanged {
            WidgetStatusStore.write(status)
            WidgetCenter.shared.reloadTimelines(ofKind: "HawkyLockScreenWidget")
        }
        syncLiveActivity(status: status)
    }

    private func syncLiveActivity(status: WidgetStatus) {
        let shouldShowActivity: Bool
        switch config.lockScreenMode {
        case .off:
            shouldShowActivity = false
        case .activeOnly:
            shouldShowActivity = status.liveState != .off || status.recordingState == .on
        case .alwaysControl:
            shouldShowActivity = true
        }
        let startedAt = liveActivityStartedAt ?? status.updatedAt
        if liveActivityStartedAt == nil {
            liveActivityStartedAt = startedAt
        }

        let contentState = LiveActivityAttributes.ContentState(
            liveState: status.liveState,
            recordingState: status.recordingState,
            audioInputEnabled: isStreamingAudio,
            contextLine: status.contextLine,
            detailLine: status.detailLine,
            startedAt: startedAt,
            updatedAt: status.updatedAt
        )

        guard shouldShowActivity else {
            activityCoalesceTask?.cancel()
            activityCoalesceTask = nil
            pendingActivityContentState = nil
            pendingActivitySnapshot = nil
            lastSentActivitySnapshot = nil
            let content = ActivityContent(state: contentState, staleDate: nil)
            liveActivity = nil
            liveActivityStartedAt = nil
            lastActivityUpdateAt = .distantPast
            // Snapshot the activities to end NOW. Enumerating inside the Task would also
            // catch an activity a quick stop→start requests in the meantime and kill it.
            let activitiesToEnd = Activity<LiveActivityAttributes>.activities
            Task {
                for activity in activitiesToEnd {
                    await activity.end(content, dismissalPolicy: .immediate)
                }
            }
            return
        }

        let snapshot = ActivitySnapshot(
            liveState: status.liveState,
            recordingState: status.recordingState,
            audioInputEnabled: isStreamingAudio,
            contextLine: status.contextLine,
            detailLine: status.detailLine
        )
        // Nothing the user can see changed — don't spend an update. Also drop any
        // trailing flush still holding a now-superseded value: the on-screen state
        // already matches `snapshot`, so committing the pending text would make it stale.
        if snapshot == lastSentActivitySnapshot {
            activityCoalesceTask?.cancel()
            activityCoalesceTask = nil
            pendingActivityContentState = nil
            pendingActivitySnapshot = nil
            return
        }

        pendingActivityContentState = contentState
        pendingActivitySnapshot = snapshot

        // Mic / live / recording state must reflect instantly; only transcript text
        // churn (same live+mic state) gets debounced.
        let isStructural = lastSentActivitySnapshot.map {
            $0.liveState != snapshot.liveState ||
            $0.recordingState != snapshot.recordingState ||
            $0.audioInputEnabled != snapshot.audioInputEnabled
        } ?? true

        let minInterval: TimeInterval = 1.2
        let elapsed = Date.now.timeIntervalSince(lastActivityUpdateAt)
        if isStructural || elapsed >= minInterval {
            activityCoalesceTask?.cancel()
            activityCoalesceTask = nil
            commitPendingActivityUpdate()
        } else if activityCoalesceTask == nil {
            // Trailing flush: lands the freshest text once the window elapses.
            let delay = minInterval - elapsed
            activityCoalesceTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                self.activityCoalesceTask = nil
                self.commitPendingActivityUpdate()
            }
        }
        // else: a trailing flush is already scheduled and will pick up the latest text.
    }

    private func commitPendingActivityUpdate() {
        guard let contentState = pendingActivityContentState,
              let snapshot = pendingActivitySnapshot else { return }
        pendingActivityContentState = nil
        pendingActivitySnapshot = nil
        lastSentActivitySnapshot = snapshot
        lastActivityUpdateAt = .now
        let content = ActivityContent(state: contentState, staleDate: nil)
        Task {
            if let activity = liveActivity ?? Activity<LiveActivityAttributes>.activities.first {
                liveActivity = activity
                await activity.update(content)
            } else if ActivityAuthorizationInfo().areActivitiesEnabled {
                do {
                    let attributes = LiveActivityAttributes(sessionTitle: "Hawky Live")
                    liveActivity = try Activity.request(
                        attributes: attributes,
                        content: content,
                        pushType: nil
                    )
                } catch {
                    NSLog("ios: live activity request failed: \(error)")
                }
            }
        }
    }

    private static func lockScreenLine(_ text: String) -> String {
        let collapsed = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: #"\\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard collapsed.count > 120 else { return collapsed }
        return String(collapsed.prefix(117)) + "..."
    }

    /// Snapshot of the Live Activity fields that actually drive its appearance (no
    /// timestamps), so we can skip redundant updates and tell structural changes apart
    /// from pure transcript-text churn.
    private struct ActivitySnapshot: Equatable {
        var liveState: WidgetStatus.LiveState
        var recordingState: WidgetStatus.RecordingState
        var audioInputEnabled: Bool
        var contextLine: String
        var detailLine: String
    }

    // Lock-screen control commands arrive via a cross-process Darwin notification
    // (posted by the Live Activity intent), so we consume them the instant a button is
    // tapped instead of waking on a 350 ms timer for the whole session. We register the
    // observer with an unretained self pointer and tear it down in deinit.
    private func startLiveControlCommandObservingIfNeeded() {
        if config.lockScreenMode == .off {
            stopLiveControlCommandObserving()
            return
        }
        guard !liveControlObserverRegistered else {
            // Already observing; still drain anything queued before this call.
            Task { await drainPendingLiveControlCommand() }
            return
        }
        liveControlObserverRegistered = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                let store = Unmanaged<LiveSessionStore>.fromOpaque(observer).takeUnretainedValue()
                Task { @MainActor in await store.drainPendingLiveControlCommand() }
            },
            LiveControlCommandStore.didEnqueueDarwinName,
            nil,
            .deliverImmediately
        )
        // A control tap can cold-launch the app to run the intent; the command may have
        // been enqueued before this observer existed, so drain once on registration.
        Task { await drainPendingLiveControlCommand() }
    }

    private func stopLiveControlCommandObserving() {
        guard liveControlObserverRegistered else { return }
        liveControlObserverRegistered = false
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(LiveControlCommandStore.didEnqueueDarwinName),
            nil
        )
    }

    /// Single executor for lock-screen control commands. This is the ONE place a
    /// pending command is destructively consumed and acted on (with phase guards +
    /// status feedback) — the Darwin observer, the register drain, and ContentView's
    /// foreground/deep-link hooks all funnel here so the action never runs twice or
    /// splits its side effects across two consumers. Returns whether a command was
    /// handled, so the caller (ContentView) can decide whether to surface the Live tab.
    @discardableResult
    func drainPendingLiveControlCommand() async -> Bool {
        guard let command = LiveControlCommandStore.consumePending() else { return false }
        switch command.action {
        case .openLive:
            updateWidgetStatus(contextLine: "Live opened")
        case .toggleMute:
            guard phase == .connected else {
                updateWidgetStatus(contextLine: "Live is not connected")
                return true
            }
            await toggleAudioInput()
            updateWidgetStatus(contextLine: isStreamingAudio ? "Mic unmuted" : "Mic muted")
        case .pauseLive:
            if phase == .connected {
                await pause()
            } else {
                updateWidgetStatus(contextLine: phase == .paused ? "Live already paused" : "Live is not connected")
            }
        case .resumeLive:
            if phase == .paused {
                await resume()
            } else {
                updateWidgetStatus(contextLine: phase == .connected ? "Live already running" : "Live is not paused")
            }
        case .stopLive:
            if phase.isActive || provider != nil {
                await stop()
                updateWidgetStatus(contextLine: "Live stopped")
            } else {
                updateWidgetStatus(contextLine: "Live already stopped")
            }
        }
        return true
    }

    private static func manifestSource(for source: LiveVisualSource) -> RecordingManifest.VideoSource {
        switch source {
        case .rayBanMeta: return .rayBan
        case .iPhoneCamera, .off: return .iPhone
        }
    }

    func stopAudioStream() async {
        await stopAudioStream(deactivateAudioSession: true)
    }

    private func stopAudioStream(deactivateAudioSession: Bool) async {
        guard isStreamingAudio else { return }
        isStreamingAudio = false
        updateWidgetStatus()
        diagnostics.lastLifecycleEvent = "Stopping audio stream"
        if provider?.managesAudioInput == true {
            do {
                try await provider?.setAudioInputEnabled(false)
            } catch {
                let message = error.localizedDescription
                diagnostics.lastError = message
                append(message, level: .error)
                appendSystemMessage(message, level: .error)
            }
            diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
            diagnostics.audioRoute = Self.audioRouteLabel()
            append("Stopped listening")
            appendSystemMessage("Stopped listening")
            return
        }
        let shouldCommit = liveConfig.turnDetectionMode == .manual
        let recorder = audioSampleRecorder
        audioSampleRecorder = nil
        _ = await recorder?.stop(shouldDeactivateSession: deactivateAudioSession)
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()

        if shouldCommit {
            do {
                append("Committing audio turn (\(recordedAudioBytes) bytes)")
                finishCurrentAudioTurn(byteCount: recordedAudioBytes)
                try await provider?.commitAudioStream()
            } catch {
                let message = error.localizedDescription
                diagnostics.lastError = message
                append(message, level: .error)
                appendSystemMessage(message, level: .error)
            }
        } else {
            do {
                let silenceMs = max(config.vadSilenceDurationMs + 250, 750)
                try await provider?.streamAudio(Self.silenceChunk(milliseconds: silenceMs))
            } catch {
                let message = error.localizedDescription
                diagnostics.lastError = message
                append(message, level: .error)
                appendSystemMessage(message, level: .error)
            }
            append("Stopped listening")
            appendSystemMessage("Stopped listening")
        }
        recordedAudioBytes = 0
    }

    func stopAndSendAudioSample() async {
        guard isRecordingAudioSample else { return }
        _ = await stopAudioSample(send: true)
    }

    private func stopAudioSample(send: Bool) async -> Bool {
        guard let recorder = audioSampleRecorder else {
            isRecordingAudioSample = false
            recordedAudioBytes = 0
            return false
        }

        isRecordingAudioSample = false
        audioSampleRecorder = nil
        let chunk = await recorder.stop()
        guard send, let chunk else {
            recordedAudioBytes = 0
            append("Audio sample discarded")
            return false
        }

        do {
            append("Sending audio sample (\(chunk.data.count) bytes)")
            appendUserMessage("Audio sample (\(byteLabel(chunk.data.count)))")
            try await provider?.sendAudio(chunk)
            recordedAudioBytes = 0
            return true
        } catch {
            let message = error.localizedDescription
            diagnostics.lastError = message
            append(message, level: .error)
            appendSystemMessage(message, level: .error)
            return false
        }
    }

    private func addRecordedAudioBytes(_ byteCount: Int) {
        recordedAudioBytes += byteCount
        diagnostics.micChunksCaptured += 1
        diagnostics.micBytesCaptured += byteCount
        diagnostics.lastMicCaptureAt = Date()
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
    }

    private func startVisualStreamIfNeeded(provider: LiveSessionProvider) async {
        guard !isStreamingVisual else { return }
        // Running session reads the frozen snapshot, so mid-session edits apply
        // to the next session, not this one.
        guard liveConfig.visualSource != .off else {
            diagnostics.visualStatus = "Off"
            return
        }

        let fps = liveConfig.effectiveVisualFPS
        guard fps > 0 else {
            diagnostics.visualStatus = "Off"
            return
        }

        // Select the frame deduplicator for this stream. Off → pass-through, so
        // cadence alone governs the send rate (pre-#612 behaviour).
        visualDeduplicator = liveConfig.visualDedupEnabled
            ? AverageHashDeduplicator()
            : PassThroughDeduplicator()

        switch liveConfig.visualSource {
        case .off:
            return
        case .iPhoneCamera:
            await startIPhoneVisualStream(provider: provider, fps: fps)
        case .rayBanMeta:
            await startRayBanVisualStream(provider: provider, fps: fps)
        }

        // Visual-quiet mode (#646): the root cause of the
        // conversation_already_has_active_response storm + over-narration is server
        // VAD auto-creating responses to camera frames / context injections. Disable
        // VAD auto-response while the camera streams via a session.update — frames +
        // context no longer trigger overlapping responses; the model still answers
        // your committed speech turns. Plus a prompt so it doesn't narrate the feed.
        if isStreamingVisual {
            let cfg = liveConfig
            Task { [weak provider] in
                try? await provider?.setVisualQuietMode(true, config: cfg)
                try? await provider?.sendContext(
                    "You can see a live camera feed. Treat it as silent background context: do NOT describe, narrate, or comment on what you see, the lighting, or the framing unless the user explicitly asks. Only respond when the user talks to you.",
                    createResponse: false
                )
            }
        }
    }

    private func startIPhoneVisualStream(provider: LiveSessionProvider, fps: Double) async {
        let capture = VideoCapture()
        capture.preferredFrameRate = max(1, Int(ceil(fps)))
        capture.cameraPosition = Self.capturePosition(for: config.cameraPosition)
        capture.keyframeIntervalNs = Self.visualFrameIntervalNanoseconds(fps: fps)
        capture.onKeyframe = { [weak self, provider] data, _ in
            Task { @MainActor [weak self, provider] in
                await self?.sendVisualFrame(data, provider: provider)
            }
        }
        visualCapture = capture
        isStreamingVisual = true
        diagnostics.visualStatus = "Starting \(config.cameraPosition.label) at \(Self.fpsLabel(fps))"
        appendSystemMessage(diagnostics.visualStatus)

        await capture.requestPermissionIfNeeded()
        guard !capture.permissionDenied else {
            diagnostics.visualStatus = "Camera permission denied"
            appendSystemMessage(diagnostics.visualStatus, level: .error)
            await stopVisualStream()
            return
        }

        await capture.start()
        diagnostics.visualStatus = "Streaming \(config.cameraPosition.label) at \(Self.fpsLabel(fps))"
        appendSystemMessage(diagnostics.visualStatus)
    }

    private func startRayBanVisualStream(provider: LiveSessionProvider, fps: Double) async {
        // Reuse the Recording DAT pipeline: GlassesVideoStream decodes + JPEG-
        // encodes frames off the main actor and emits keyframes via onKeyframe.
        // Here we route those keyframes into the realtime provider instead of
        // the keyframe uploader / disk.
        let video = rayBanVideo ?? GlassesVideoStream()
        rayBanVideo = video
        video.onKeyframe = { [weak self, provider] data, _ in
            Task { @MainActor [weak self, provider] in
                await self?.sendVisualFrame(data, provider: provider)
            }
        }
        isStreamingVisual = true
        diagnostics.visualStatus = "Starting Ray-Ban at \(Self.fpsLabel(fps))"
        appendSystemMessage(diagnostics.visualStatus)

        await video.start()
        guard video.isStreaming else {
            let message = video.errorMessage ?? "Ray-Ban video did not start. Check the glasses connection."
            diagnostics.visualStatus = message
            appendSystemMessage(message, level: .error)
            await stopVisualStream()
            return
        }
        diagnostics.visualStatus = "Streaming Ray-Ban at \(Self.fpsLabel(fps))"
        appendSystemMessage(diagnostics.visualStatus)
    }

    func toggleVisualInput() async {
        guard phase == .connected else { return }
        if isStreamingVisual {
            await stopVisualStream()
        } else if let provider {
            await startVisualStreamIfNeeded(provider: provider)
        }
    }

    private func sendVisualFrame(_ data: Data, provider: LiveSessionProvider) async {
        guard isStreamingVisual else { return }
        let capturedAt = Date()
        let capturedAtNs = Self.currentUptimeNanoseconds()
        let frame = LiveJPEGFrame(data: data, capturedAt: capturedAt)
        // Keep the freshest captured frame available for explicit photo-sharing
        // tools even when realtime visual dedupe suppresses static scenes.
        toolCameraFrames.record(frame, capturedAtNs: capturedAtNs)
        diagnostics.visualFramesCaptured += 1
        diagnostics.visualBytesCaptured += data.count
        diagnostics.lastVisualCaptureAt = capturedAt
        // Visual change gate: skip frames that are near-identical to the last one
        // we sent. A static scene otherwise floods the realtime conversation with
        // hundreds of redundant input_image items, which makes the model fixate
        // and repeat itself. The deduplicator (selected on stream start from
        // config.visualDedupEnabled) decides; PassThroughDeduplicator never skips.
        if !visualDeduplicator.shouldSend(data) {
            visualFramesSkipped += 1
            diagnostics.visualFramesSkipped = visualFramesSkipped
            return
        }
        // Only surface camera frames as transcript bubbles when explicitly
        // enabled (debug). Otherwise they stay an invisible model-input detail
        // (matches showVisualFramesInTranscript's documented intent) and never
        // accumulate in memory or on disk.
        if liveConfig.showVisualFramesInTranscript {
            appendVisualFrame(data)
        }
        // Tee the same visual frame to the recorder sink when recording is on.
        recordingSink.ingestFrame(frame)
        do {
            try await provider.sendFrame(frame)
            if staySilentActive { silenceFrameCount += 1 }
        } catch {
            let message = "Visual frame upload failed: \(error.localizedDescription)"
            diagnostics.lastError = message
            diagnostics.visualStatus = "Frame send failed"
            appendSystemMessage(message, level: .error)
        }
        // Cocktail Party Mode (#627): run face recognition on the same frame. The
        // controller rate-limits/dedups internally, so feeding every frame is fine.
        // Detached so recognition (which may call the gateway) never blocks the
        // visual stream cadence.
        if let cocktailParty {
            recentCameraFrames.append(data)
            if recentCameraFrames.count > maxRecentCameraFrames {
                recentCameraFrames.removeFirst(recentCameraFrames.count - maxRecentCameraFrames)
            }
            let frameData = data
            Task { await cocktailParty.handleFrame(frameData) }
        }
        // Safety Check (#648): a separate, silent pipeline — feed the same frame to the
        // hazard watcher, which rate-limits + classifies off the realtime model and
        // only surfaces a spoken warning on a real hazard. Detached so it never blocks
        // the visual stream or the conversation.
        if let safety {
            let frameData = data
            Task { await safety.handleFrame(frameData) }
        }
    }

    private func stopVisualStream() async {
        isStreamingVisual = false
        toolCameraFrames.clear()
        visualDeduplicator.reset()
        visualFramesSkipped = 0

        if let video = rayBanVideo {
            rayBanVideo = nil
            video.onKeyframe = nil
            await video.stop()
        }

        if let capture = visualCapture {
            visualCapture = nil
            capture.onKeyframe = nil
            capture.onSegment = nil
            await capture.stop()
        }

        // Restore VAD auto-response now that no camera frames are arriving (#646).
        // Skip while Stay Silent or "respond only when I talk" owns the response config.
        if !staySilentActive, !liveConfig.speakOnlyWhenSpokenTo, let provider {
            let cfg = liveConfig
            Task { [weak provider] in try? await provider?.setVisualQuietMode(false, config: cfg) }
        }

        diagnostics.visualStatus = config.visualSource == .off ? "Off" : "Stopped"
    }

    private static func visualFrameIntervalNanoseconds(fps: Double) -> UInt64 {
        let seconds = 1 / max(fps, 0.1)
        return UInt64(seconds * 1_000_000_000)
    }

    private static func fpsLabel(_ fps: Double) -> String {
        if abs(fps.rounded() - fps) < 0.01 {
            return "\(Int(fps.rounded())) fps"
        }
        return String(format: "%.1f fps", fps)
    }

    private static func capturePosition(for position: LiveCameraPosition) -> AVCaptureDevice.Position {
        switch position {
        case .back: return .back
        case .front: return .front
        }
    }

    private func installAudioSessionObservers() {
        guard audioSessionObserverTokens.isEmpty else { return }
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        audioSessionObserverTokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            Task { @MainActor [weak self] in
                self?.recordAudioInterruption(notification)
            }
        })
        audioSessionObserverTokens.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            Task { @MainActor [weak self] in
                self?.recordAudioRouteChange(notification)
            }
        })
        audioSessionObserverTokens.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: session,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.recordAudioServicesReset()
            }
        })
    }

    private func recordAudioInterruption(_ notification: Notification) {
        diagnostics.audioInterruptions += 1
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
        let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let type = rawType.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
        let label: String
        switch type {
        case .began: label = "began"
        case .ended: label = "ended"
        default: label = "unknown"
        }
        diagnostics.lastLifecycleEvent = lifecycleSummary("Audio interruption \(label)")
        appendSystemMessage(diagnostics.lastLifecycleEvent, level: .warning)

        // A call / another app grabbed the mic mid-session. iOS has already
        // deactivated our audio session, so Live can no longer hear the user —
        // auto-pause, surface a notice, and ARM recovery so we auto-restart when
        // the interruption ends or the user returns to the app. (#673)
        if Self.shouldAutoPause(forInterruptionType: type, phase: phase, isCapturingMic: isStreamingAudio) {
            Task { @MainActor in
                // Re-check after the actor hop: the phase may have changed (Stop
                // tapped, a second interruption). Only show the notice if pause()
                // actually transitioned us to .paused. (#673 review)
                guard phase == .connected else { return }
                await pause()
                if phase == .paused {
                    armInterruptedRecovery()
                    presentUserAlert(.micInterrupted)
                }
            }
        }

        // Interruption ended while we're still foregrounded — auto-restart now
        // rather than waiting for an app-active transition that won't come. (#673)
        if type == .ended {
            Task { @MainActor in await recoverInterruptedSessionIfArmed() }
        }
    }

    /// Whether an audio interruption should auto-pause Live: only when it's
    /// *beginning*, a session is actively connected, AND the mic is actually
    /// capturing — a text/listen-only session (mic off) has no mic to lose, so
    /// pausing it with a "microphone is in use" notice would be wrong. Not on the
    /// `.ended` edge (we don't auto-resume). Pure so it's unit-testable without a
    /// live audio session. (#673)
    static func shouldAutoPause(
        forInterruptionType type: AVAudioSession.InterruptionType?,
        phase: LiveSessionPhase,
        isCapturingMic: Bool
    ) -> Bool {
        type == .began && phase == .connected && isCapturingMic
    }

    // MARK: - No-audio watchdog (#673)

    /// After connecting we expect mic chunks to keep flowing. If none have arrived
    /// since the baseline while we're still connected + streaming, the mic is
    /// producing nothing — another app holds it. Pure so it's unit-testable. (#673)
    static func shouldWarnNoMicInput(
        capturedChunks: Int,
        baseline: Int,
        phase: LiveSessionPhase,
        isStreamingAudio: Bool
    ) -> Bool {
        phase == .connected && isStreamingAudio && capturedChunks <= baseline
    }

    /// Watches for a connected-but-mute mic (another app holding it from before
    /// start, so no interruption fired). Armed only when we have a capture signal
    /// — the parallel recording tap (mediaPersistenceMode != .off); without
    /// recording there's no client-side probe for the WebRTC-owned mic. (#673)
    private func scheduleMicInputWatchdogIfNeeded() {
        cancelMicInputWatchdog()
        let cfg = liveConfig
        guard cfg.audioInputEnabled, cfg.mediaPersistenceMode != .off else { return }
        let baseline = diagnostics.micChunksCaptured
        micInputWatchdogTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            if Self.shouldWarnNoMicInput(
                capturedChunks: diagnostics.micChunksCaptured,
                baseline: baseline,
                phase: phase,
                isStreamingAudio: isStreamingAudio
            ) {
                presentUserAlert(.micUnavailable)
            }
        }
    }

    private func cancelMicInputWatchdog() {
        micInputWatchdogTask?.cancel()
        micInputWatchdogTask = nil
    }

    // MARK: - Interrupted-session auto-recovery (#673)

    private func armInterruptedRecovery() {
        interruptedRecoveryDeadline = Date().addingTimeInterval(Self.interruptedRecoveryWindow)
    }

    private func cancelInterruptedRecovery() {
        interruptedRecoveryDeadline = nil
    }

    /// Whether a pending recovery is still valid (armed and within the window).
    /// Pure so it's unit-testable. (#673)
    static func shouldRecoverInterruptedSession(deadline: Date?, now: Date) -> Bool {
        guard let deadline else { return false }
        return now < deadline
    }

    /// Restart Live after an interruption/background stop, if recovery is armed and
    /// still in-window. A restart (not resume) because unmuting can't revive the
    /// WebRTC ADM; start() uses silent opening + history replay, so it's seamless.
    /// If the contending app still holds the mic, the restart simply reconnects
    /// without audio (same as any contended start) — no false alarm. (#673)
    func recoverInterruptedSessionIfArmed() async {
        guard Self.shouldRecoverInterruptedSession(deadline: interruptedRecoveryDeadline, now: Date()) else {
            interruptedRecoveryDeadline = nil
            return
        }
        interruptedRecoveryDeadline = nil
        // From a paused interruption we're still "active"; tear down before the
        // rebuild. From a background stop we're already idle.
        if phase.isActive {
            await stop(userInitiated: false)
        }
        guard phase == .idle else { return }
        appendSystemMessage("Reconnecting Live after interruption")
        await start(recordingTransport: lastRecordingTransport)
    }

    private func recordAudioRouteChange(_ notification: Notification) {
        diagnostics.audioRouteChanges += 1
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
        diagnostics.lastLifecycleEvent = "Audio route: route=\(diagnostics.audioRoute)"
        appendSystemMessage(diagnostics.lastLifecycleEvent)
    }

    private func recordAudioServicesReset() {
        diagnostics.audioSessionStatus = Self.audioSessionStatusLabel()
        diagnostics.audioRoute = Self.audioRouteLabel()
        diagnostics.lastLifecycleEvent = lifecycleSummary("Audio services reset")
        appendSystemMessage(diagnostics.lastLifecycleEvent, level: .warning)
    }

    private func lifecycleSummary(_ prefix: String) -> String {
        let lastMic = diagnostics.lastMicCaptureAt.map { Self.relativeTimeLabel(since: $0) } ?? "never"
        return "\(prefix): streaming=\(isStreamingAudio), micChunks=\(diagnostics.micChunksCaptured), lastMic=\(lastMic), route=\(diagnostics.audioRoute), session=\(diagnostics.audioSessionStatus)"
    }

    private static func audioSessionStatusLabel() -> String {
        let session = AVAudioSession.sharedInstance()
        return "\(session.category.rawValue) / \(session.mode.rawValue) / input=\(session.isInputAvailable ? "yes" : "no")"
    }

    private static func audioRouteLabel() -> String {
        let route = AVAudioSession.sharedInstance().currentRoute
        let inputs = route.inputs.map { $0.portName }.joined(separator: ", ")
        let outputs = route.outputs.map { $0.portName }.joined(separator: ", ")
        return "in: \(inputs.isEmpty ? "none" : inputs), out: \(outputs.isEmpty ? "none" : outputs)"
    }

    private static func relativeTimeLabel(since date: Date) -> String {
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 1 { return "now" }
        if seconds < 60 { return String(format: "%.0fs ago", seconds) }
        return String(format: "%.1fm ago", seconds / 60)
    }

    private static func silenceChunk(milliseconds: Double) -> LiveAudioChunk {
        let samples = max(1, Int(24_000 * milliseconds / 1_000))
        return LiveAudioChunk(
            data: Data(count: samples * MemoryLayout<Int16>.size),
            formatDescription: "pcm16/24000/mono",
            capturedAt: Date()
        )
    }

    private static func sineWavePCM16(frequency: Double, duration: Double, sampleRate: Double = 24_000) -> Data {
        let sampleCount = max(1, Int(duration * sampleRate))
        var samples: [Int16] = []
        samples.reserveCapacity(sampleCount)
        for index in 0..<sampleCount {
            let phase = 2 * Double.pi * frequency * Double(index) / sampleRate
            let scaled = 0.28 * sin(phase) * Double(Int16.max)
            samples.append(Int16(clamping: Int(scaled)).littleEndian)
        }
        return samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private func handle(_ event: LiveSessionEvent) {
        switch event {
        case .status(let status):
            diagnostics.providerStatus = status
            append(status)
        case .latency(let milliseconds):
            diagnostics.lastLatencyMs = milliseconds
        case .audioAccepted(let bytes):
            diagnostics.audioChunksSent += 1
            diagnostics.lastModelEvent = "Audio accepted (\(bytes) bytes)"
        case .frameAccepted(let bytes):
            diagnostics.framesSent += 1
            diagnostics.lastModelEvent = "Frame accepted (\(bytes) bytes)"
        case .text(let text):
            diagnostics.lastModelEvent = text
            appendAssistantMessage(text)
        case .textDelta(let itemID, let phase, let text, let detail, let eventType):
            diagnostics.lastModelEvent = text
            appendAssistantDelta(itemID: itemID, phase: phase, delta: text, detail: detail, eventType: eventType)
        case .textComplete(let itemID, let phase, let text, let detail, let eventType):
            diagnostics.lastModelEvent = text
            finishAssistantMessage(itemID: itemID, phase: phase, fallbackText: text, detail: detail, eventType: eventType)
        case .inputTranscriptDelta(let itemID, let text, let detail, let eventType):
            appendUserTranscriptDelta(itemID: itemID, delta: text, detail: detail, eventType: eventType)
        case .inputTranscriptComplete(let itemID, let text, let detail, let eventType):
            finishUserTranscript(itemID: itemID, transcript: text, detail: detail, eventType: eventType)
            enqueueFallbackVoiceprintTranscriptCompleted(itemID: itemID, transcript: text)
        case .outputAudioDelta(let data):
            publishOutputAudioDiagnostics(receivedBytes: data.count)
            if liveConfig.responseModality == .audio {
                do {
                    let result = try audioOutputPlayer.play(data)
                    publishOutputAudioDiagnostics(playedBytes: result.bytes)
                } catch {
                    let message = "Audio playback failed: \(error.localizedDescription)"
                    diagnostics.outputAudioStatus = "Playback failed"
                    diagnostics.lastError = message
                    append(message, level: .error)
                    appendSystemMessage(message, level: .error)
                }
            } else {
                append("Ignored output audio while response mode is Text", level: .warning)
            }
        case .toolCallStarted(let name, let callID, let arguments):
            diagnostics.toolCallsReceived += 1
            diagnostics.lastToolCall = "\(name) (\(shortID(callID)))"
            diagnostics.lastModelEvent = "Tool call: \(name)"
            append("Tool call: \(name)", detail: arguments)
            upsertToolCall(callID: callID, name: name, status: .started, source: .realtime, arguments: arguments)
        case .toolCallCompleted(let name, let callID, let output):
            diagnostics.toolCallsCompleted += 1
            diagnostics.lastToolCall = "\(name) complete (\(shortID(callID)))"
            diagnostics.lastModelEvent = "Tool result: \(name)"
            append("Tool result: \(name)", detail: output)
            let ok = !Self.toolOutputIndicatesError(output)
            // Surface the Hawky background agent's own tool calls, which arrive
            // inside session_send_message's result as a tool_events array
            // (e.g. ["start:web_fetch","ok:web_fetch"]).
            surfaceBackendToolEvents(from: output)
            upsertToolCall(callID: callID, name: name, status: ok ? .ok : .error, source: .realtime, output: output)
        case .reconnect(let count):
            diagnostics.reconnects = count
            append("Reconnect \(count)", level: .warning)
            appendSystemMessage("Reconnect \(count)", level: .warning)
        case .raw(let direction, let type, let json):
            journalRaw(direction: direction, type: type, json: json)
            appendVerbose("\(direction.rawValue): \(type)", detail: json)
            if direction == .received {
                handleRealtimeRawEvent(type, json: json)
                updateConversationState(forRawType: type)
            }
            if config.diagnosticsLevel == .verbose {
                appendSystemMessage("\(direction.rawValue): \(type)", detail: json, eventType: type)
            }
        case .error(let message):
            diagnostics.lastError = message
            append(message, level: .error)
            appendSystemMessage(message, level: .error)
        case .sessionConfigStatus(let status):
            // #677: the realtime media leg can connect while the session config
            // (persona/tools/VAD/transcription) silently failed to apply. Make that
            // observable so the session no longer reads as a clean Connected.
            diagnostics.sessionConfigStatus = status.diagnosticsLabel
            switch status {
            case .applied:
                append("Session configured")
            case .unconfirmed(let detail):
                let message = "Live session settings are not confirmed yet; continuing in degraded mode."
                diagnostics.lastError = message
                diagnostics.providerStatus = status.connectedProviderStatus
                append(message, level: .warning, detail: detail)
                appendSystemMessage(message, level: .warning, detail: detail)
            case .failed(let detail):
                let suffix = detail.map { ": \($0)" } ?? ""
                let message = "Live connected, but the session settings (persona, tools, voice) didn't apply\(suffix). Reconnect to retry."
                diagnostics.lastError = message
                append(message, level: .error)
                appendSystemMessage(message, level: .error)
                if phase == .connected {
                    presentUserAlert(LiveUserAlert(
                        title: "Live not fully configured",
                        message: message
                    ))
                }
            case .pending:
                diagnostics.providerStatus = "Configuring"
            case .notApplicable:
                break
            }
        }
    }

    private func handleRealtimeRawEvent(_ type: String, json: String) {
        if let event = prepareVoiceprintRealtimeEvent(rawType: type, rawJSON: json) {
            enqueueVoiceprintRealtimeEvent(event)
            if type == "conversation.item.input_audio_transcription.completed",
               let itemID = event.itemID {
                voiceprintTranscriptItemIDsSent.insert(itemID)
            }
            if type == "input_audio_buffer.speech_stopped" {
                enqueueCurrentVoiceprintAudioArtifact(
                    itemID: event.itemID,
                    speechWindowID: event.speechWindowID
                )
            }
        }

        switch type {
        case "input_audio_buffer.speech_started":
            startRawAudioTrackSegmentIfNeeded()
            guard config.bargeInPolicy.stopsLocalPlaybackOnSpeechStart else { return }
            audioOutputPlayer.stop()
            diagnostics.outputAudioStatus = "Interrupted by user speech"
            diagnostics.lastModelEvent = diagnostics.outputAudioStatus
            append(diagnostics.outputAudioStatus)
            appendSystemMessage("Interrupted assistant playback")
        case "input_audio_buffer.speech_stopped":
            stopRawAudioTrackSegmentIfNeeded()
        default:
            break
        }
    }

    private func prepareVoiceprintRealtimeEvent(rawType: String, rawJSON: String) -> LiveVoiceprintRealtimeEvent? {
        guard var event = Self.voiceprintRealtimeEvent(
            rawType: rawType,
            rawJSON: rawJSON,
            route: diagnostics.audioRoute,
            recordingOffsetMs: recordingSink.currentAudioOffsetMs
        ) else {
            return nil
        }

        switch rawType {
        case "input_audio_buffer.speech_started":
            if event.itemID == nil && event.speechWindowID == nil {
                event.speechWindowID = nextVoiceprintSpeechWindowID()
            }
            event.audioStartMs = nextMonotonicVoiceprintVadOffsetMs(candidate: event.audioStartMs)
            voiceprintOpenSpeechWindowID = event.speechWindowID ?? event.itemID
        case "input_audio_buffer.speech_stopped":
            if event.itemID == nil && event.speechWindowID == nil {
                event.speechWindowID = voiceprintOpenSpeechWindowID
            }
            event.audioEndMs = nextMonotonicVoiceprintVadOffsetMs(candidate: event.audioEndMs)
            appendVoiceprintClosedSpeechWindowID(event.speechWindowID ?? event.itemID)
            voiceprintOpenSpeechWindowID = nil
        default:
            break
        }
        return event
    }

    /// Resolve a recording-timeline-aligned, finite, strictly-monotonic VAD timestamp.
    ///
    /// `candidate` is the recording offset (or explicit JSON `audio_*_ms`) from the
    /// converter — the SAME time base as the audio artifact WAV, so a finalized turn
    /// window `[startMs, endMs]` maps to the correct recording segment. Two realities
    /// force the repair here rather than in the pure converter:
    ///  - Warm-up: the parallel mic tap opens the WAV lazily on the first streamed
    ///    chunk, so an early speech_started can arrive with a nil offset. Floor it to
    ///    the last emitted VAD offset (or 0 at session start) — still on the recording
    ///    timeline, just at its origin.
    ///  - Arg-less WebRTC VAD: start and stop can resolve to the identical recording
    ///    offset (no new frames written between them). The server turn tracker rejects
    ///    `endMs <= startMs`, so nudge strictly forward by 1ms. 1ms is inaudible and
    ///    keeps the window inside the same recording segment.
    private func nextMonotonicVoiceprintVadOffsetMs(candidate: Double?) -> Double {
        let next = Self.monotonicVoiceprintVadOffsetMs(
            candidate: candidate,
            last: voiceprintLastVadOffsetMs
        )
        voiceprintLastVadOffsetMs = next
        return next
    }

    /// Pure, unit-testable core of `nextMonotonicVoiceprintVadOffsetMs`. `last` is the
    /// previously emitted VAD offset (nil at session start). Returns a finite value that
    /// is `> last` (or `>= 1` when `last` is nil), preferring `candidate` when it is
    /// finite and already ahead of the monotonic floor.
    nonisolated static func monotonicVoiceprintVadOffsetMs(
        candidate: Double?,
        last: Double?
    ) -> Double {
        let floor = (last?.isFinite == true) ? last! : 0
        let base = (candidate?.isFinite == true) ? candidate! : floor
        return max(base, floor + 1)
    }

    private func enqueueFallbackVoiceprintTranscriptCompleted(itemID: String, transcript: String) {
        let trimmedItemID = itemID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedItemID.isEmpty else { return }
        guard !voiceprintTranscriptItemIDsSent.contains(trimmedItemID) else {
            _ = Self.consumeVoiceprintFallbackSpeechWindowID(
                forTranscriptItemID: trimmedItemID,
                from: &voiceprintClosedSpeechWindowIDs,
                transcriptAlreadySent: true
            )
            return
        }
        voiceprintTranscriptItemIDsSent.insert(trimmedItemID)
        let speechWindowID = Self.consumeVoiceprintFallbackSpeechWindowID(
            forTranscriptItemID: trimmedItemID,
            from: &voiceprintClosedSpeechWindowIDs,
            transcriptAlreadySent: false
        )
        enqueueVoiceprintRealtimeEvent(LiveVoiceprintRealtimeEvent(
            type: "conversation.item.input_audio_transcription.completed",
            itemID: trimmedItemID,
            speechWindowID: speechWindowID,
            audioStartMs: nil,
            audioEndMs: nil,
            transcript: transcript,
            audioArtifactID: nil,
            audioPath: nil,
            sampleRate: nil,
            route: diagnostics.audioRoute
        ))
    }

    private func appendVoiceprintClosedSpeechWindowID(_ id: String?) {
        guard let id = Self.cleanedString(id) else { return }
        guard !voiceprintClosedSpeechWindowIDs.contains(id) else { return }
        voiceprintClosedSpeechWindowIDs.append(id)
    }

    private func enqueueCurrentVoiceprintAudioArtifact(itemID: String?, speechWindowID: String?) {
        guard Self.cleanedString(itemID) != nil || Self.cleanedString(speechWindowID) != nil else { return }
        guard let artifact = recordingSink.currentAudioArtifact else {
            // Warm-up race: the parallel-mic WAV is not open yet (WebRTC opens it
            // lazily on the first streamed chunk). Stash the join keys and late-bind
            // when the WAV opens (flushPendingVoiceprintAudioArtifacts), so this turn
            // is not permanently lost. The artifact is the whole-session WAV; the
            // server slices by the turn's [startMs, endMs] window, and our VAD offsets
            // are floored at the WAV origin, so a late-bound first turn still maps to
            // the correct leading segment.
            recordPendingVoiceprintAudioArtifactJoin(itemID: itemID, speechWindowID: speechWindowID)
            return
        }
        enqueueVoiceprintRealtimeEvent(Self.voiceprintAudioArtifactEvent(
            itemID: itemID,
            speechWindowID: speechWindowID,
            artifact: artifact,
            route: diagnostics.audioRoute
        ))
    }

    private func recordPendingVoiceprintAudioArtifactJoin(itemID: String?, speechWindowID: String?) {
        // Off-by-default parity: only stash when the voiceprint realtime path is armed.
        // With the flag off, the artifact event would be dropped by enqueue anyway, so
        // stashing it would be dead state. This keeps flag-off behavior a pure no-op.
        guard Self.voiceprintRealtimeRuntimeTarget(activeConfig: activeConfig, draftConfig: config) != nil else {
            return
        }
        Self.appendPendingVoiceprintAudioArtifactJoin(
            itemID: itemID,
            speechWindowID: speechWindowID,
            into: &voiceprintPendingAudioArtifactJoins
        )
    }

    /// Pure, unit-testable core of the warm-up pending-join stash. Appends a cleaned
    /// (itemID, speechWindowID) pair to `pending` unless a pair with the same server
    /// join key (itemID first, else speechWindowID — matching voiceprintAudioArtifactEvent)
    /// is already queued, so a re-fired speech_stopped cannot double-bind the artifact.
    /// A pair with no usable join key is ignored.
    nonisolated static func appendPendingVoiceprintAudioArtifactJoin(
        itemID: String?,
        speechWindowID: String?,
        into pending: inout [(itemID: String?, speechWindowID: String?)]
    ) {
        let cleanItemID = cleanedString(itemID)
        let cleanWindowID = cleanedString(speechWindowID)
        guard let joinKey = cleanItemID ?? cleanWindowID else { return }
        let alreadyPending = pending.contains { entry in
            (cleanedString(entry.itemID) ?? cleanedString(entry.speechWindowID)) == joinKey
        }
        guard !alreadyPending else { return }
        pending.append((itemID: cleanItemID, speechWindowID: cleanWindowID))
    }

    /// Late-bind audio artifacts for warm-up turns whose speech_stopped fired before
    /// the recording WAV opened. Called once the WAV is available (first
    /// recordingSink.start). No-op when there is nothing pending or the artifact is
    /// still unavailable (defensive; the caller invokes this right after the WAV opens).
    private func flushPendingVoiceprintAudioArtifacts() {
        guard !voiceprintPendingAudioArtifactJoins.isEmpty else { return }
        guard let artifact = recordingSink.currentAudioArtifact else { return }
        let pending = voiceprintPendingAudioArtifactJoins
        voiceprintPendingAudioArtifactJoins.removeAll()
        let route = diagnostics.audioRoute
        for join in pending {
            enqueueVoiceprintRealtimeEvent(Self.voiceprintAudioArtifactEvent(
                itemID: join.itemID,
                speechWindowID: join.speechWindowID,
                artifact: artifact,
                route: route
            ))
        }
    }

    private func enqueueVoiceprintRealtimeEvent(_ event: LiveVoiceprintRealtimeEvent) {
        guard let bridge = gatewayBridge,
              let target = Self.voiceprintRealtimeRuntimeTarget(activeConfig: activeConfig, draftConfig: config) else {
            return
        }
        let previous = voiceprintRealtimeTask
        let generation = voiceprintRealtimeGeneration
        let taskID = UUID()
        let task = Task { @MainActor [weak self, bridge, event, previous, target, generation, taskID] in
            defer { self?.voiceprintRealtimeTasks.removeValue(forKey: taskID) }
            await previous?.value
            guard let self, !Task.isCancelled, self.voiceprintRealtimeGeneration == generation else { return }
            guard Self.voiceprintRealtimeRuntimeTarget(activeConfig: self.activeConfig, draftConfig: self.config) == target else { return }
            let result = await bridge.sendVoiceprintRealtimeEvent(
                event,
                sessionKey: target.sessionKey,
                mode: target.modeRaw
            )
            guard !Task.isCancelled, self.voiceprintRealtimeGeneration == generation, let result else { return }
            self.handleVoiceprintRealtimeResult(result)
        }
        voiceprintRealtimeTask = task
        voiceprintRealtimeTasks[taskID] = task
    }

    private func enqueueVoiceprintRealtimeResetIfNeeded(config: LiveSessionConfig) {
        guard let bridge = gatewayBridge,
              let target = Self.voiceprintRealtimeRuntimeTarget(activeConfig: nil, draftConfig: config) else {
            return
        }
        let previous = voiceprintRealtimeTask
        let generation = voiceprintRealtimeGeneration
        let taskID = UUID()
        let task = Task { @MainActor [weak self, bridge, previous, target, generation, taskID] in
            defer { self?.voiceprintRealtimeTasks.removeValue(forKey: taskID) }
            await previous?.value
            guard let self, !Task.isCancelled, self.voiceprintRealtimeGeneration == generation else { return }
            _ = await bridge.resetVoiceprintRealtime(
                sessionKey: target.sessionKey,
                mode: target.modeRaw
            )
            guard !Task.isCancelled, self.voiceprintRealtimeGeneration == generation else { return }
            self.appendVerbose("Voiceprint realtime buffer reset")
        }
        voiceprintRealtimeTask = task
        voiceprintRealtimeTasks[taskID] = task
    }

    private func resetVoiceprintRealtimeQueue() {
        voiceprintRealtimeGeneration += 1
        voiceprintRealtimeTask?.cancel()
        for task in voiceprintRealtimeTasks.values {
            task.cancel()
        }
        voiceprintRealtimeTask = nil
        voiceprintRealtimeTasks.removeAll()
        voiceprintTranscriptItemIDsSent.removeAll()
        voiceprintOpenSpeechWindowID = nil
        voiceprintClosedSpeechWindowIDs.removeAll()
        voiceprintSpeechWindowCounter = 0
        voiceprintLastVadOffsetMs = nil
        voiceprintPendingAudioArtifactJoins.removeAll()
        // Drop any cached embedder so a config change (flags off, or a newly
        // provisioned model) is re-resolved on the next finalized turn.
        speakerEmbedder = nil
        // WS2: reset the edge-triggered identity machine + UI indicator so a new
        // session starts from `unknown` and re-establishes cleanly.
        voiceprintIdentityMachine = LiveVoiceprintIdentityMachine()
        voiceprintIdentityLabel = nil
    }

    private func handleVoiceprintRealtimeResult(_ result: LiveVoiceprintRealtimeResult) {
        // WS2 PRIMARY identity channel: apply the piggybacked identity summary (if any)
        // through the edge-triggered state machine BEFORE the finalized-turn gate, so
        // an identity that arrives on a response carrying no NEW finalized turns still
        // establishes/flips. A nil summary is a no-op (fail-safe).
        if let identity = result.identity {
            handleVoiceprintIdentitySummary(identity)
        }
        // WS2: render the gateway's piggybacked per-turn recognition states as verbose
        // lines. These replace the old marker-path score_turns lines (that path is gone
        // — the gateway auto-scores now) with the SAME renderer, so per-turn recognition
        // still surfaces in the verbose log. Empty scoredStates → nothing logged.
        if !result.scoredStates.isEmpty {
            for line in Self.voiceprintRecognitionLines(
                states: result.scoredStates,
                total: result.scoredStates.count
            ) {
                appendVerbose(line)
            }
        }
        guard !result.finalizedTurns.isEmpty else { return }
        appendVerbose(
            "Voiceprint finalized \(result.finalizedTurns.count) turn\(result.finalizedTurns.count == 1 ? "" : "s")",
            detail: result.finalizedTurns
                .map { "\($0.transcriptItemID) \(Int($0.startMs))-\(Int($0.endMs))ms" }
                .joined(separator: "\n")
        )
        maybeAttachOnDeviceEmbeddings(finalizedTurns: result.finalizedTurns, sessionKey: result.sessionKey)
    }

    /// WS2 identity apply: the SINGLE place both push channels (realtime_event
    /// piggyback + `voiceprint.identity` broadcast) funnel through. The edge-trigger
    /// + de-dupe live entirely in `LiveVoiceprintIdentityMachine`, so this method just
    /// routes the machine's decision to the two side effects on an establish/flip:
    /// (1) UI — surface the owner/unknown indicator (retro-label), and (2) AGENT
    /// INJECTION — one no-response system context item so the answering Hawky knows who
    /// is speaking.
    ///
    /// OFF-BY-DEFAULT: gated on `voiceprintRealtimeEnabled` — flag off is a hard no-op.
    /// FAIL-SAFE: `.none` (de-dupe / below the edge / garbled verdict) does nothing; the
    /// injection is best-effort (`try?`) and never triggers a response or blocks the
    /// data channel, so an injection failure degrades quietly and never surfaces a
    /// false owner.
    private func handleVoiceprintIdentitySummary(_ summary: LiveVoiceprintIdentitySummary) {
        guard (activeConfig ?? config).voiceprintRealtimeEnabled else { return }
        let action = voiceprintIdentityMachine.ingest(summary)
        guard case let .apply(_, injection, label) = action else { return }

        // (1) UI retro-label / owner indicator.
        voiceprintIdentityLabel = label
        appendSystemMessage(
            "Speaker: \(label)",
            detail: summary.confidence.map { String(format: "confidence %.2f", $0) },
            eventType: "voiceprint.identity"
        )

        // (2) AGENT INJECTION: exactly ONE no-response context item. Never
        // `response.create`; best-effort so a send failure cannot stall the session.
        guard let provider else { return }
        Task { [weak self] in
            do {
                try await provider.sendContext(injection, createResponse: false)
            } catch {
                await MainActor.run {
                    self?.append("Voiceprint identity injection failed", level: .warning, detail: error.localizedDescription)
                }
            }
        }
    }

    /// B1/B2: OFF-BY-DEFAULT hook. When the on-device embedding gate is on AND a
    /// CoreML model is provisioned, produce score_turns turns carrying an on-device
    /// `sampleEmbedding` per turn, then submit them through the fail-closed liveness
    /// coordinator (B2): request a FRESH single-use A8 nonce, attach it, and call
    /// `identity.voiceprint.score_turns`.
    ///
    /// WS2: the gateway now AUTO-SCORES finalized turns server-side (config
    /// `voiceprint.live_scoring.auto_score_finalized`) and PUSHES identity back — so
    /// iOS no longer boomerangs marker-only score_turns for the server path (that
    /// would double-score). The safe rule: iOS submits score_turns ONLY when it has a
    /// REAL on-device embedding (embedded > 0); otherwise it relies on the gateway
    /// auto-score. Because the on-device embedder is inert in this open build
    /// (`resolvedSpeakerEmbedder` returns nil — no CoreML model), every turn produces
    /// zero embeddings today and NOTHING is submitted; the identity arrives via the
    /// pushed channels (`handleVoiceprintIdentitySummary`).
    ///
    /// When the model is absent (the default here), `resolvedSpeakerEmbedder` returns
    /// nil and this method returns after building markers-only turns — NOTHING requests
    /// a challenge or sends score_turns. B1 follow-up folded in: `embed()` (CoreML
    /// inference) runs OFF the @MainActor on a detached task so per-turn inference never
    /// blocks the store; the submission then hops back to the main actor. Never
    /// blocks/crashes the session.
    private func maybeAttachOnDeviceEmbeddings(
        finalizedTurns: [LiveVoiceprintFinalizedTurn],
        sessionKey: String
    ) {
        let cfg = activeConfig ?? config
        // Gate on `voiceprintRealtimeEnabled` + `gatewayBridge`. The embedder is
        // resolved OPTIONALLY: when it is nil (the default, no CoreML model) every turn
        // degrades to markers-only and iOS submits NOTHING — the gateway auto-scores.
        // When it is present, the turns that produce an embedding take the fail-closed
        // client-embedding (B2) path.
        guard cfg.voiceprintRealtimeEnabled, let bridge = gatewayBridge else { return }
        let embedder = resolvedSpeakerEmbedder(config: cfg)
        let modeRaw = cfg.mode.rawValue

        // Run CoreML inference OFF the main actor so per-turn embedding never blocks
        // @MainActor LiveSessionStore. `buildVoiceprintScoreTurns` is nonisolated and
        // Sendable-safe; the finalized turns + embedder are value types / Sendable.
        Task { [weak self, embedder, bridge, finalizedTurns, sessionKey, modeRaw] in
            let scoreTurns = await Task.detached(priority: .utility) {
                LiveSessionStore.buildVoiceprintScoreTurns(
                    sessionKey: sessionKey,
                    finalizedTurns: finalizedTurns,
                    embedder: embedder,
                    nonce: nil,
                    pcmForTurn: { _ in
                        // The finalized turn's PCM lives in the local WAV; extracting
                        // the exact [startMs, endMs] window is a device-only concern
                        // wired when the CAM++ model is provisioned. Until then the
                        // gate is closed (embedder unavailable), so this closure is
                        // never called in the default build and each turn degrades to
                        // markers-only — nothing is submitted.
                        nil
                    }
                )
            }.value

            let embedded = scoreTurns.filter { $0.embedding != nil }.count
            // WS2: NO on-device embedding produced → do NOT submit score_turns. The
            // gateway auto-scores the finalized turns itself (it already has the
            // liveUpload audio) and pushes identity back. Submitting here would
            // double-score. This is the default path in the open build (embedder inert).
            guard embedded > 0 else { return }

            // FAIL-CLOSED liveness binding: fresh single-use nonce → attach → submit.
            // Runs ONLY on turns that produced a real on-device embedding (Phase 2).
            let coordinator = VoiceprintLivenessCoordinator(gateway: bridge)
            let submission = await coordinator.submit(
                sessionKey: sessionKey,
                mode: modeRaw,
                turns: scoreTurns
            )
            let provider = embedder?.modelInfo.provider.rawValue ?? "on-device"
            await MainActor.run { [weak self] in
                self?.appendVerbose(Self.voiceprintSubmissionLog(
                    submission,
                    embedded: embedded,
                    total: scoreTurns.count,
                    provider: provider
                ))
            }
        }
    }

    /// Build the per-turn verbose recognition lines from a server-side score_turns
    /// result. Pure/static so it is unit-testable without a live session. FAIL-SAFE:
    /// a nil result or empty `states` yields a single neutral "no result" line and
    /// NEVER an owner line, so a transport error can never surface a false "owner".
    ///
    /// WS2: kept as a thin wrapper over `voiceprintRecognitionLines(states:total:)`
    /// so the score_turns-result shape (used by the on-device / B2 path and the test
    /// suite) and the piggybacked `scoredStates` shape (rendered from
    /// `handleVoiceprintRealtimeResult`) share one renderer.
    nonisolated static func voiceprintRecognitionLines(  // testable
        result: LiveVoiceprintScoreTurnsResult?,
        total: Int
    ) -> [String] {
        voiceprintRecognitionLines(states: result?.states ?? [], total: total)
    }

    /// Render per-turn verbose recognition lines from the pushed/scored states.
    /// Shared by both the score_turns-result wrapper above and the WS2 piggyback
    /// (`result.scoredStates`) path. FAIL-SAFE: empty `states` yields a single
    /// neutral "no result" line and NEVER an owner line.
    nonisolated static func voiceprintRecognitionLines(  // testable
        states: [LiveVoiceprintScoreTurnState],
        total: Int
    ) -> [String] {
        guard !states.isEmpty else {
            return ["Voiceprint recognition: no result for \(total) turn\(total == 1 ? "" : "s") — marker path"]
        }
        return states.map { state in
            let score = state.confidence.map { String(format: "%.2f", $0) }
            switch state.result {
            case "owner_speaking":
                return "🗣️ You (owner)" + (score.map { " · \($0)" } ?? "")
            case "possible_owner":
                return "Possibly you (owner)" + (score.map { " · \($0)" } ?? "")
            case "unknown_speaker", "unknown_cluster":
                return "Unknown speaker" + (score.map { " · \($0)" } ?? "")
            case "confirmed_person":
                return "Known person" + (score.map { " · \($0)" } ?? "")
            case let other?:
                return "Speaker: \(other)" + (score.map { " · \($0)" } ?? "")
            case nil:
                // No decision (skipped / pending / error lifecycle) — never "owner".
                let why = state.skipReason ?? state.lifecycle
                return "Voiceprint: \(state.transcriptItemID) not scored (\(why))"
            }
        }
    }

    /// Human-readable summary of one liveness submission for the verbose event log.
    nonisolated static func voiceprintSubmissionLog(
        _ submission: VoiceprintLivenessSubmission,
        embedded: Int,
        total: Int,
        provider: String
    ) -> String {
        switch submission {
        case .submittedWithNonce:
            return "Voiceprint on-device embeddings: \(embedded)/\(total) turns via \(provider) (nonce-bound)"
        case .markersOnly(let reason):
            let why = reason == .challengeExpired ? "nonce expired" : "no fresh nonce"
            return "Voiceprint embeddings withheld (\(why)) — marker path already covered \(total) turns"
        case .noEmbeddingTurns:
            return "Voiceprint on-device embeddings: 0/\(total) turns — marker path"
        }
    }

    // MARK: - B1 on-device speaker embedding

    /// Resolve the on-device speaker embedder for the effective config, or nil to
    /// use the marker path. This is the single OFF-BY-DEFAULT gate: it returns an
    /// embedder ONLY when the voiceprint side-channel is on, the new
    /// `onDeviceEmbeddingEnabled` toggle is on, AND a CoreML CAM++ model is
    /// actually provisioned (available). When the model is absent — the default
    /// state in this open repo — it returns nil and the caller keeps sending
    /// markers, so the session never blocks and default behavior is unchanged.
    private func resolvedSpeakerEmbedder(config: LiveSessionConfig) -> SpeakerEmbedder? {
        guard config.voiceprintRealtimeEnabled, config.onDeviceEmbeddingEnabled else {
            return nil
        }
        if let speakerEmbedder, speakerEmbedder.isAvailable {
            return speakerEmbedder
        }
        let embedder = CoreMLSpeakerEmbedder.available()
        speakerEmbedder = embedder
        return embedder.isAvailable ? embedder : nil
    }

    /// Build score_turns turn params for finalized turns, attaching an on-device
    /// `sampleEmbedding` when `embedder` produced one for that turn's PCM. Any
    /// per-turn embedding failure degrades that turn to markers-only (no crash,
    /// never blocks). Pure/static so it is unit-testable without a live session.
    ///
    /// `pcmForTurn` yields the finalized turn's mono float PCM + sample rate when
    /// available on-device; returning nil (e.g. media persistence off, WAV not yet
    /// flushed) leaves the turn markers-only. B2 later supplies the `nonce`.
    nonisolated static func buildVoiceprintScoreTurns(
        sessionKey: String,
        finalizedTurns: [LiveVoiceprintFinalizedTurn],
        embedder: SpeakerEmbedder?,
        nonce: String? = nil,
        pcmForTurn: (LiveVoiceprintFinalizedTurn) -> (samples: [Float], sampleRate: Double)?
    ) -> [LiveVoiceprintScoreTurn] {
        finalizedTurns.map { turn in
            var embedding: SpeakerEmbedding?
            if let embedder, embedder.isAvailable, let pcm = pcmForTurn(turn) {
                embedding = try? embedder.embed(pcm.samples, sampleRate: pcm.sampleRate)
            }
            return LiveVoiceprintScoreTurn(
                sessionKey: turn.sessionKey.isEmpty ? sessionKey : turn.sessionKey,
                transcriptItemID: turn.transcriptItemID,
                role: turn.role,
                text: turn.text,
                startMs: turn.startMs,
                endMs: turn.endMs,
                audioArtifactID: turn.audioArtifactID,
                audioPath: turn.audioPath,
                route: turn.route,
                embedding: embedding,
                nonce: nonce
            )
        }
    }

    private func nextVoiceprintSpeechWindowID() -> String {
        voiceprintSpeechWindowCounter += 1
        return "ios_speech_\(voiceprintSpeechWindowCounter)"
    }

    nonisolated static func voiceprintRealtimeEvent(
        rawType: String,
        rawJSON: String,
        route: String? = nil,
        recordingOffsetMs: Double? = nil
    ) -> LiveVoiceprintRealtimeEvent? {
        let object = rawJSONObject(rawJSON)
        let itemID = stringValue(object, keys: ["item_id", "itemId"])
        let speechWindowID = stringValue(object, keys: ["speech_window_id", "speechWindowId"])
        let eventRoute = stringValue(object, keys: ["route", "audio_route", "audioRoute"]) ?? cleanedString(route)
        let recordingOffset = finiteNumber(recordingOffsetMs)

        switch rawType {
        case "input_audio_buffer.speech_started":
            // The vendored WebRTC transport delegate is arg-less, so the provider
            // re-emits speech_started with an EMPTY JSON body ("{}"). Do NOT drop the
            // event when neither the raw JSON nor the recording offset carries a
            // timestamp: the window is still real and must reach the server. When the
            // recording offset is nil (parallel-mic warm-up), leave audioStartMs nil
            // here and let the MainActor caller (`prepareVoiceprintRealtimeEvent`)
            // stamp a recording-timeline-aligned, monotonic timestamp. Stamping here
            // when the offset IS available preserves the existing wire behavior.
            let audioStartMs = numberValue(object, keys: ["audio_start_ms", "start_ms", "at_ms"]) ?? recordingOffset
            return LiveVoiceprintRealtimeEvent(
                type: rawType,
                itemID: itemID,
                speechWindowID: speechWindowID,
                audioStartMs: audioStartMs,
                audioEndMs: nil,
                transcript: nil,
                audioArtifactID: nil,
                audioPath: nil,
                sampleRate: nil,
                route: eventRoute
            )
        case "input_audio_buffer.speech_stopped":
            // See speech_started: never drop an empty-JSON VAD stop. A nil audioEndMs
            // is repaired by the MainActor caller so endMs > startMs strictly, in the
            // same recording-offset time base as the audio artifact.
            let audioEndMs = numberValue(object, keys: ["audio_end_ms", "end_ms", "at_ms"]) ?? recordingOffset
            return LiveVoiceprintRealtimeEvent(
                type: rawType,
                itemID: itemID,
                speechWindowID: speechWindowID,
                audioStartMs: nil,
                audioEndMs: audioEndMs,
                transcript: nil,
                audioArtifactID: nil,
                audioPath: nil,
                sampleRate: nil,
                route: eventRoute
            )
        case "conversation.item.input_audio_transcription.completed":
            guard itemID != nil else { return nil }
            return LiveVoiceprintRealtimeEvent(
                type: rawType,
                itemID: itemID,
                speechWindowID: speechWindowID,
                audioStartMs: nil,
                audioEndMs: nil,
                transcript: stringValue(object, keys: ["transcript", "text"]),
                audioArtifactID: nil,
                audioPath: nil,
                sampleRate: nil,
                route: eventRoute
            )
        case "response.audio_transcript.done", "response.output_audio_transcript.done":
            let transcriptItemID = itemID ?? stringValue(object, keys: ["response_id", "responseId"])
            guard transcriptItemID != nil else { return nil }
            return LiveVoiceprintRealtimeEvent(
                type: rawType,
                itemID: transcriptItemID,
                speechWindowID: speechWindowID,
                audioStartMs: nil,
                audioEndMs: nil,
                transcript: stringValue(object, keys: ["transcript", "text"]),
                audioArtifactID: nil,
                audioPath: nil,
                sampleRate: nil,
                route: eventRoute
            )
        default:
            return nil
        }
    }

    nonisolated static func voiceprintAudioArtifactEvent(
        itemID: String?,
        speechWindowID: String?,
        artifact: LiveVoiceprintAudioArtifactReference,
        route: String? = nil
    ) -> LiveVoiceprintRealtimeEvent {
        let cleanItemID = cleanedString(itemID)
        let cleanSpeechWindowID = cleanedString(speechWindowID)
        let joinID = cleanItemID ?? cleanSpeechWindowID
        let artifactID = [artifact.audioArtifactID, joinID]
            .compactMap { cleanedString($0) }
            .joined(separator: ":")
        return LiveVoiceprintRealtimeEvent(
            type: "live_recording.audio_artifact",
            itemID: cleanItemID,
            speechWindowID: cleanSpeechWindowID,
            audioStartMs: nil,
            audioEndMs: nil,
            transcript: nil,
            audioArtifactID: artifactID,
            audioPath: artifact.audioPath,
            sampleRate: artifact.sampleRate,
            route: cleanedString(route)
        )
    }

    nonisolated static func consumeVoiceprintFallbackSpeechWindowID(
        forTranscriptItemID itemID: String,
        from closedSpeechWindowIDs: inout [String],
        transcriptAlreadySent: Bool
    ) -> String? {
        let cleanItemID = cleanedString(itemID) ?? itemID
        if transcriptAlreadySent {
            if let index = closedSpeechWindowIDs.firstIndex(of: cleanItemID) {
                closedSpeechWindowIDs.remove(at: index)
            } else if !closedSpeechWindowIDs.isEmpty {
                closedSpeechWindowIDs.removeFirst()
            }
            return nil
        }
        guard !closedSpeechWindowIDs.isEmpty else { return nil }
        return closedSpeechWindowIDs.removeFirst()
    }

    private func append(_ message: String, level: LiveEventLogEntry.Level = .info, detail: String? = nil) {
        guard config.diagnosticsLevel != .off else { return }
        eventLog.append(LiveEventLogEntry(date: Date(), level: level, message: message, detail: detail))
        if eventLog.count > 40 {
            eventLog.removeFirst(eventLog.count - 40)
        }
    }

    private func appendVerbose(_ message: String, level: LiveEventLogEntry.Level = .info, detail: String? = nil) {
        guard config.diagnosticsLevel == .verbose else { return }
        append(message, level: level, detail: detail)
    }

    /// #481: where-reminder trace into the in-app diagnostics event log. Always
    /// recorded (bypasses the diagnosticsLevel gate) since it is low-volume — only
    /// fires while arming/firing a location reminder — and the detailed os_log
    /// (`ambientWhereLog`, category "AmbientWhere") carries the same trace to the
    /// device unified log for deeper debugging. Not journaled to the conversation
    /// transcript, so it does not appear as a chat bubble to the user.
    private func appendWhere(_ message: String, level: LiveEventLogEntry.Level = .info, detail: String? = nil) {
        eventLog.append(LiveEventLogEntry(date: Date(), level: level, message: "[where] \(message)", detail: detail))
        if eventLog.count > 60 {
            eventLog.removeFirst(eventLog.count - 60)
        }
    }

    private func publishOutputAudioDiagnostics(receivedBytes: Int? = nil, playedBytes: Int? = nil) {
        if let receivedBytes {
            outputAudioChunksReceivedTotal += 1
            outputAudioBytesReceivedTotal += receivedBytes
            outputAudioStatusTotal = "Received \(byteLabel(receivedBytes)) audio chunk"
        }
        if let playedBytes {
            outputAudioChunksPlayedTotal += 1
            outputAudioBytesPlayedTotal += playedBytes
            outputAudioStatusTotal = "Playing output audio (\(byteLabel(playedBytes)))"
        }
        let now = Date()
        guard now.timeIntervalSince(lastOutputAudioDiagnosticsPublish) >= 0.25 else {
            return
        }
        diagnostics.outputAudioChunksReceived = outputAudioChunksReceivedTotal
        diagnostics.outputAudioBytesReceived = outputAudioBytesReceivedTotal
        diagnostics.outputAudioChunksPlayed = outputAudioChunksPlayedTotal
        diagnostics.outputAudioBytesPlayed = outputAudioBytesPlayedTotal
        diagnostics.outputAudioStatus = outputAudioStatusTotal
        diagnostics.lastModelEvent = outputAudioStatusTotal
        lastOutputAudioDiagnosticsPublish = now
        appendVerbose(outputAudioStatusTotal)
    }

    private func startRawAudioTrackSegmentIfNeeded() {
        guard rawAudioTrackSegmentStartedAt == nil else { return }
        guard provider?.managesAudioInput == true else { return }
        rawAudioTrackSegmentStartedAt = Date()
    }

    private func stopRawAudioTrackSegmentIfNeeded() {
        guard let startedAt = rawAudioTrackSegmentStartedAt else { return }
        rawAudioTrackSegmentStartedAt = nil
        let endedAt = Date()
        journalRaw(
            direction: .sent,
            type: "input_audio_buffer.append",
            json: Self.rawAudioAppendJSON(startedAt: startedAt, endedAt: endedAt)
        )
    }

    private func resetOutputAudioDiagnosticsTotals() {
        outputAudioChunksReceivedTotal = 0
        outputAudioBytesReceivedTotal = 0
        outputAudioChunksPlayedTotal = 0
        outputAudioBytesPlayedTotal = 0
        outputAudioStatusTotal = "Idle"
        lastOutputAudioDiagnosticsPublish = .distantPast
    }

    private func resolvedGatewayBridgeSessionKey(for config: LiveSessionConfig) -> String {
        switch config.gatewayBridgeSessionMode {
        case .temporary:
            return currentRealtimeBridgeSessionKey()
        case .activeChat:
            return activeChatSessionKey ?? "ios:main"
        case .fixed:
            let trimmed = config.gatewayBridgeSessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? "realtime:main" : trimmed
        }
    }

    // MARK: - M8 where-trigger helpers

    /// Geocode each named place, build CLCircularRegions (≤20 cap), push to
    /// AmbientLocationManager, and report arm success/failure back to the gateway.
    ///
    /// Fix 1: request Always auth before arming any hard background region. If
    ///   Always is not yet granted, report arm_failed for hard regions so the
    ///   gateway knows the region is not live; the onboarding UX re-arms after grant.
    /// Fix 4: cache coords for already-monitored regions so transient geocode
    ///   failures do not remove live regions from monitoring.
    /// Fix 5: pass isHard + label from the gateway descriptor to AmbientRegion so
    ///   local notifications fire for hard where intentions.
    /// Fix 6: arm ack is sent from AmbientLocationManager.onRegionMonitoringResult
    ///   (didStartMonitoringFor / monitoringDidFailFor), not immediately here.
    private func handleRegionsUpdate(
        _ regions: [RegionsUpdateRegion],
        sessionKey: String,
        bridge: LiveGatewayBridge
    ) async {
        ambientWhereLog.notice("handleRegionsUpdate enter: \(regions.count, privacy: .public) region(s), auth=\(Self.locationAuthString(self.ambientLocationManager.authorizationStatus), privacy: .public)")
        appendWhere("handleRegionsUpdate: \(regions.count) region(s), auth=\(Self.locationAuthString(ambientLocationManager.authorizationStatus))")
        // #481: remember this descriptor set so we can replay it after Always auth is
        // granted (see handleAuthorizedAlways). An empty set means "clear" — don't cache.
        if !regions.isEmpty {
            lastRegionsUpdate = (regions, sessionKey)
        }

        // #481: geocode ALL regions (not just the first 20). CoreLocation still only
        // monitors the nearest ≤20, but we hand the full geocoded superset to the
        // location manager so significant-location-change reprojection can pull in
        // regions beyond the cap as the user moves toward them.
        let maxRegions = 20
        if regions.count > maxRegions {
            append("Regions update: \(regions.count) region(s); CoreLocation monitors nearest \(maxRegions), rest tracked for reprojection", level: .info)
        }

        // Fix 6: wire the monitoring-result callback once per bridge session.
        // The callback is set each time regions are updated; it is idempotent.
        ambientLocationManager.onRegionMonitoringResult = { [weak self, bridge] intentionId, ok, reason in
            guard let self else { return }
            Task {
                do {
                    if ok {
                        ambientWhereLog.notice("sending region.armed ok:true for \(intentionId, privacy: .public)")
                        await MainActor.run { self.appendWhere("CoreLocation confirmed monitoring → sending region.armed ok:true (\(intentionId))") }
                        try await bridge.reportRegionArmed(intentionId: intentionId, ok: true, sessionKey: sessionKey)
                        ambientWhereLog.notice("region.armed ok:true SENT for \(intentionId, privacy: .public)")
                        await MainActor.run { self.appendWhere("region.armed ok:true SENT (\(intentionId))") }
                    } else {
                        ambientWhereLog.notice("sending region.armed ok:false (\(reason ?? "monitoring_failed", privacy: .public)) for \(intentionId, privacy: .public)")
                        await MainActor.run { self.appendWhere("sending region.armed ok:false (\(reason ?? "monitoring_failed")) (\(intentionId))", level: .warning) }
                        try await bridge.reportRegionArmed(intentionId: intentionId, ok: false, reason: reason ?? "monitoring_failed", sessionKey: sessionKey)
                    }
                } catch {
                    ambientWhereLog.error("region.armed report FAILED for \(intentionId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    await MainActor.run { self.appendWhere("region.armed report FAILED (\(intentionId))", level: .warning, detail: error.localizedDescription) }
                }
            }
        }

        let geocoder = CLGeocoder()
        var ambientRegions: [AmbientRegion] = []
        var geocodeFailedIntentionIds: [String] = []

        for region in regions {
            // Fix 1: for hard (background) regions, ensure Always auth before arming.
            if region.isHard {
                let hasAlways = ambientLocationManager.ensureAlwaysForBackgroundArm()
                if !hasAlways {
                    // #481: do NOT report ok:false here. arm_failed is a terminal state
                    // (no transition back to armed), so a premature failure ack would
                    // permanently kill the intention even after the user grants Always.
                    // Instead skip without acking — the intention stays in pending_arm
                    // and handleAuthorizedAlways() replays this region set once Always
                    // is granted, this time acking ok:true.
                    ambientWhereLog.notice("region arm DEFERRED (no Always auth yet): \(region.intentionId, privacy: .public) place=\(region.place, privacy: .public) auth=\(Self.locationAuthString(self.ambientLocationManager.authorizationStatus), privacy: .public)")
                    appendWhere("arm DEFERRED — no Always auth: \(region.place) (auth=\(Self.locationAuthString(ambientLocationManager.authorizationStatus)))", level: .warning)
                    continue
                }
            } else if ambientLocationManager.authorizationStatus == .notDetermined {
                // For soft regions, request WhenInUse on the first arm.
                ambientLocationManager.requestWhenInUseAuthorization()
            }

            // Fix 4: try to resolve coords — fall back to cache on transient failure.
            let coordinate: CLLocationCoordinate2D
            if let cached = ambientLocationManager.cachedCoordinate(for: region.intentionId) {
                // Region is already monitored — use cached coord to avoid unnecessary geocode.
                coordinate = cached
            } else {
                // #481: resolve the place name to coordinates. A bare POI/business
                // name like "Trader Joe's" fails plain CLGeocoder (it needs an
                // address); MKLocalSearch biased to the user's current location finds
                // the NEAREST matching business. Fall back to region-biased CLGeocoder.
                let hint = ambientLocationManager.currentLocationHint()
                if let resolved = await Self.resolvePlace(region.place, near: hint, geocoder: geocoder) {
                    coordinate = resolved
                    ambientWhereLog.notice("resolved \(region.place, privacy: .public) → \(resolved.latitude),\(resolved.longitude) (hint=\(hint != nil ? "yes" : "no", privacy: .public))")
                    appendWhere("resolved \(region.place) → \(resolved.latitude),\(resolved.longitude)")
                } else {
                    ambientWhereLog.error("geocode FAILED for \(region.place, privacy: .public) (after retry) — no ack sent, stays pending_arm")
                    appendWhere("geocode FAILED for \(region.place) (after retry) — no ack, stays pending_arm", level: .warning)
                    geocodeFailedIntentionIds.append(region.intentionId)
                    continue
                }
            }

            ambientRegions.append(AmbientRegion(
                id: region.intentionId,
                center: coordinate,
                radiusMeters: 150,
                // Fix 5: pass isHard/label from the gateway descriptor.
                isHard: region.isHard,
                label: region.label.isEmpty ? region.place : region.label,
                // #615: carry content so the entry notification shows the reminder.
                content: region.content
            ))
        }

        // #481: geocode failures are logged but NOT acked as ok:false. arm_failed is
        // terminal, so acking failure would permanently kill an intention whose place
        // is actually valid (transient CLGeocoder error). Staying silent leaves the
        // intention in pending_arm to hit the gateway's 10s ack timeout instead —
        // recoverable on the next regions.update / re-arm. We already retried once
        // (geocodeWithRetry) before landing here.
        if !geocodeFailedIntentionIds.isEmpty {
            append("geocode failed (no ack, will retry on re-arm): \(geocodeFailedIntentionIds.joined(separator: ", "))", level: .warning)
        }

        append("Arming \(ambientRegions.count) region(s) into CoreLocation (auth=\(Self.locationAuthString(ambientLocationManager.authorizationStatus)))", level: .info)

        // #481: hand the FULL geocoded superset to the manager; it projects the
        // nearest ≤20 into CoreLocation and keeps the rest for reprojection on
        // significant-location-change. Fix 6: ack is sent from the delegate callbacks.
        ambientWhereLog.notice("setDesiredRegions: handing \(ambientRegions.count, privacy: .public) geocoded region(s) to CoreLocation (ack will follow from didStartMonitoringFor)")
        appendWhere("handing \(ambientRegions.count) geocoded region(s) to CoreLocation (ack follows from didStartMonitoringFor)")
        ambientLocationManager.setDesiredRegions(ambientRegions)
    }

    /// #481: Resolve a `where` place name to coordinates.
    ///
    /// Bare POI / business names ("Trader Joe's", "Whole Foods", "the office") are
    /// the common case for location reminders, and plain `CLGeocoder` returns
    /// nothing for them — it geocodes ADDRESSES, not businesses, so the named place
    /// silently arm_failed (the root cause found in #481 device logs). `MKLocalSearch`
    /// IS the POI/business resolver; biased to the user's current location it returns
    /// the NEAREST matching store. Order:
    ///   1. MKLocalSearch biased to `origin` (nearest matching POI)              [best]
    ///   2. MKLocalSearch with no region bias (still resolves well-known names)
    ///   3. CLGeocoder region-biased, then unbiased (handles literal addresses)
    /// One retry on transient failure. Returns nil only if everything fails.
    private static func resolvePlace(
        _ place: String,
        near origin: CLLocationCoordinate2D?,
        geocoder: CLGeocoder
    ) async -> CLLocationCoordinate2D? {
        // Region used both to bias MKLocalSearch and CLGeocoder. ~50km span around
        // the user keeps the nearest store within range without over-constraining.
        let biasRegion: MKCoordinateRegion? = origin.map {
            MKCoordinateRegion(center: $0, latitudinalMeters: 50_000, longitudinalMeters: 50_000)
        }

        func localSearch(useRegion: Bool) async -> CLLocationCoordinate2D? {
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = place
            if useRegion, let biasRegion { request.region = biasRegion }
            do {
                let response = try await MKLocalSearch(request: request).start()
                // With a region bias MapKit already orders by relevance/proximity;
                // pick the nearest to origin when we have one, else the top hit.
                let items = response.mapItems
                if let origin {
                    let o = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
                    return items.min { a, b in
                        a.placemark.location.map { o.distance(from: $0) } ?? .greatestFiniteMagnitude
                            < (b.placemark.location.map { o.distance(from: $0) } ?? .greatestFiniteMagnitude)
                    }?.placemark.coordinate
                }
                return items.first?.placemark.coordinate
            } catch {
                return nil
            }
        }

        func clGeocode(useRegion: Bool) async -> CLLocationCoordinate2D? {
            do {
                let placemarks: [CLPlacemark]
                if useRegion, let origin {
                    let region = CLCircularRegion(center: origin, radius: 50_000, identifier: "geobias")
                    placemarks = try await geocoder.geocodeAddressString(place, in: region)
                } else {
                    placemarks = try await geocoder.geocodeAddressString(place)
                }
                return placemarks.first?.location?.coordinate
            } catch {
                return nil
            }
        }

        for attempt in 0..<2 {
            if let c = await localSearch(useRegion: true) { return c }
            if let c = await localSearch(useRegion: false) { return c }
            if let c = await clGeocode(useRegion: true) { return c }
            if let c = await clGeocode(useRegion: false) { return c }
            if attempt == 0 {
                try? await Task.sleep(nanoseconds: 400_000_000) // 0.4s backoff
            }
        }
        return nil
    }

    /// #481: Re-arm the most recent region set after the user grants Always
    /// authorization. The first arm of a hard `where` region fails when auth (or
    /// the lazily-created CLLocationManager's status) isn't ready yet; CoreLocation
    /// won't retry on its own, so when auth becomes Always we replay the last
    /// descriptor set. No-op if we never received one.
    private func handleAuthorizedAlways() async {
        guard let last = lastRegionsUpdate, let bridge = gatewayBridge else { return }
        append("Always authorization granted — re-arming \(last.regions.count) region(s)", level: .info)
        await handleRegionsUpdate(last.regions, sessionKey: last.sessionKey, bridge: bridge)
    }

    // MARK: Developer testing (#481) — mock location

    /// Developer-mode only: armed `where` regions a tester can simulate arriving at.
    /// Empty when no where reminders are active in this session.
    var mockableRegions: [AmbientRegion] {
        ambientLocationManager.allDesiredRegions
    }

    /// Developer-mode only: simulate arriving at a known region. Runs the real
    /// region-entry path (local notification + `region.entered` → gateway fires
    /// the intention), so this verifies the end-to-end reminder trigger on device
    /// without physically moving.
    func devSimulateArrival(intentionId: String) {
        append("DEV: simulating arrival at region \(intentionId)", level: .info)
        Task { await ambientLocationManager.simulateArrival(intentionId: intentionId) }
    }

    /// Developer-mode only: feed a mock device coordinate (as a significant-location
    /// change) to exercise reprojection of the nearest ≤20 regions.
    func devSimulateLocation(latitude: Double, longitude: Double) {
        append("DEV: simulating location \(latitude),\(longitude)", level: .info)
        ambientLocationManager.simulateLocationChange(
            CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        )
    }

    private static func locationAuthString(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "not_determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorized_always"
        case .authorizedWhenInUse: return "authorized_when_in_use"
        @unknown default: return "unknown"
        }
    }

    private func bootstrapGatewayBridge(config: LiveSessionConfig) {
        guard let gatewayBridge else {
            append("Hawky bridge is enabled but not configured", level: .warning)
            return
        }
        let sessionKey = config.gatewayBridgeSessionKey
        guard !LiveGatewayBridgeBootstrapLedger.contains(sessionKey) else {
            append("Hawky bridge already initialized", detail: sessionKey)
            appendSystemMessage("Hawky bridge already initialized", detail: sessionKey)
            return
        }
        Task { [weak self, gatewayBridge] in
            let response = await gatewayBridge.bootstrap(sessionKey: sessionKey, config: config)
            await MainActor.run {
                guard let self else { return }
                if let error = response.error {
                    // Logged only. `bridgeStatus` is owned by the feed-stream
                    // connection (the single source of truth); a one-shot bootstrap
                    // RPC failing while that stream is healthy must NOT flip the banner
                    // to offline — the feed reflects real reachability.
                    self.append("Hawky bridge bootstrap failed", level: .warning, detail: error)
                    self.appendSystemMessage("Hawky bridge bootstrap failed", level: .warning, detail: error)
                } else {
                    LiveGatewayBridgeBootstrapLedger.insert(sessionKey)
                    self.append("Hawky bridge ready", detail: response.text)
                    self.appendSystemMessage("Hawky bridge ready", detail: response.text)
                }
            }
        }
    }

    /// Outcome of the startup boot-context fetch. This doubles as the gateway
    /// reachability probe for the session: `.loaded`/`.skipped` mean the machine is
    /// reachable, `.failed` means it isn't (drives the offline banner or, in
    /// required mode, a hard start failure).
    enum LiveBootContextResult {
        case loaded(LiveFrontendBootContextResponse)
        case skipped
        case failed(String)
    }

    /// What a boot-context probe result means for the session, given the user's
    /// required-mode setting. Pure mapping extracted from `start()` so the
    /// soft-warn-vs-hard-fail branch — the heart of this fix — is unit-testable
    /// without driving the whole start path or a live gateway.
    enum LiveBridgeStartDecision: Equatable {
        case connected
        case offline(String)
        case requiredFailure(String)
    }

    struct LiveTranscriptAppendRuntimeTarget: Equatable {
        let sessionKey: String
        let modeRaw: String
    }

    struct LiveVoiceprintRealtimeRuntimeTarget: Equatable {
        let sessionKey: String
        let modeRaw: String
    }

    nonisolated static func bridgeStartDecision(for result: LiveBootContextResult, required: Bool) -> LiveBridgeStartDecision {
        switch result {
        case .loaded, .skipped:
            return .connected
        case .failed(let detail):
            return required ? .requiredFailure(detail) : .offline(detail)
        }
    }

    nonisolated static func bridgeAvailability(for decision: LiveBridgeStartDecision) -> LiveBridgeAvailability {
        switch decision {
        case .connected:
            return .available
        case .offline(let detail), .requiredFailure(let detail):
            return .offline(detail)
        }
    }

    nonisolated static func resolvedRuntimeGatewayBridgeSessionKey(
        from config: LiveSessionConfig,
        fallback: String? = nil
    ) -> String? {
        let sessionKey = config.gatewayBridgeSessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionKey.isEmpty else { return fallback }
        return sessionKey
    }

    nonisolated static func transcriptAppendRuntimeTarget(
        activeConfig: LiveSessionConfig?,
        draftConfig: LiveSessionConfig
    ) -> LiveTranscriptAppendRuntimeTarget? {
        let cfg = activeConfig ?? draftConfig
        guard cfg.modeLatentIntentionEnabled,
              let sessionKey = resolvedRuntimeGatewayBridgeSessionKey(from: cfg) else {
            return nil
        }
        return LiveTranscriptAppendRuntimeTarget(sessionKey: sessionKey, modeRaw: cfg.mode.rawValue)
    }

    nonisolated static func voiceprintRealtimeRuntimeTarget(
        activeConfig: LiveSessionConfig?,
        draftConfig: LiveSessionConfig
    ) -> LiveVoiceprintRealtimeRuntimeTarget? {
        let cfg = activeConfig ?? draftConfig
        guard cfg.gatewayBridgeEnabled,
              cfg.voiceprintRealtimeEnabled,
              cfg.audioInputEnabled,
              cfg.mediaPersistenceMode != .off,
              let sessionKey = resolvedRuntimeGatewayBridgeSessionKey(from: cfg) else {
            return nil
        }
        return LiveVoiceprintRealtimeRuntimeTarget(sessionKey: sessionKey, modeRaw: cfg.mode.rawValue)
    }

    private func fetchStartupBootContext(config: LiveSessionConfig) async -> LiveBootContextResult {
        guard !bootContextInjectedSessionIDs.contains(currentSessionID) else { return .skipped }
        guard let gatewayBridge else {
            append("Hawky boot context unavailable: bridge is not configured", level: .warning)
            appendSystemMessage("Hawky boot context unavailable", level: .warning, detail: "Bridge is not configured.")
            return .failed("Bridge is not configured.")
        }

        do {
            let response = try await gatewayBridge.fetchBootContext(sessionKey: config.gatewayBridgeSessionKey, config: config)
            let sourceText = response.sources.isEmpty ? "no source list" : response.sources.joined(separator: ", ")
            let detail = bootContextDetail(context: response.context, sources: response.sources, toolbox: response.toolbox, config: config)
            append("Loaded Hawky boot context", detail: "Sources: \(sourceText)\n\n\(response.context)")
            appendSystemMessage(
                "Hawky memory loaded",
                detail: detail,
                eventType: "hawky.boot_context.loaded"
            )
            if response.firstContact.active {
                appendSystemMessage(
                    "Hawky first contact active",
                    detail: "Reason: \(response.firstContact.reason)\nMarker: \(response.firstContact.markerFile ?? "none")",
                    eventType: "hawky.boot_context.loaded"
                )
            }
            for warning in response.warnings {
                append("Hawky boot context warning", level: .warning, detail: warning)
                appendSystemMessage("Hawky boot context warning", level: .warning, detail: warning)
            }
            return .loaded(response)
        } catch {
            // Escalated to .error: an unreachable gateway is the headline failure this
            // path was silently swallowing. The caller decides whether to hard-fail
            // the start (required mode) or continue with the offline banner.
            append("Hawky boot context failed", level: .error, detail: error.localizedDescription)
            appendSystemMessage("Hawky boot context failed", level: .error, detail: error.localizedDescription)
            return .failed(error.localizedDescription)
        }
    }

    private func startOpeningIfNeeded(config: LiveSessionConfig, provider: LiveSessionProvider) async {
        let message: String
        let title: String
        switch config.openingBehavior {
        case .silent:
            return
        case .firstContactOnly:
            guard config.startupFirstContactActive else { return }
            title = "Hawky first contact started"
            message = """
            First-contact startup: BOOTSTRAP.md is present in the Hawky workspace.
            Begin the identity-discovery conversation now, naturally and briefly, following BOOTSTRAP.md. Do not recite the boot context or use a canned product greeting.
            """
        case .checkInEverySession:
            if config.startupFirstContactActive {
                title = "Hawky first contact started"
                message = """
                First-contact startup: BOOTSTRAP.md is present in the Hawky workspace.
                Begin the identity-discovery conversation now, naturally and briefly, following BOOTSTRAP.md. Do not recite the boot context or use a canned product greeting.
                """
            } else {
                title = "Hawky opening check-in started"
                message = """
                Live startup check-in: the user has opened a new Live session.
                Start with one brief, natural check-in using the memory and identity context already loaded. Do not ask who the user is if USER.md identifies them. Do not recite the boot context. Do not use a canned product greeting.
                """
            }
        }
        do {
            try await provider.sendContext(message, createResponse: true)
            appendSystemMessage(
                title,
                detail: message,
                eventType: "hawky.boot_context.loaded"
            )
        } catch {
            append("Hawky opening failed", level: .warning, detail: error.localizedDescription)
            appendSystemMessage("Hawky opening failed", level: .warning, detail: error.localizedDescription)
        }
    }

    private func bootContextDetail(context: String, sources: [String], toolbox: String?, config: LiveSessionConfig) -> String {
        var previewConfig = config
        previewConfig.startupBootContext = context
        let sourceText = sources.isEmpty ? "no source list" : sources.joined(separator: ", ")
        let toolboxText = toolbox?.trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        Sources:
        \(sourceText)

        Toolbox:
        \(toolboxText?.isEmpty == false ? toolboxText! : "No toolbox manifest returned.")

        Fetched memory:
        \(context)

        Final Realtime instructions:
        \(previewConfig.resolvedInstructions)
        """
    }

    private func markStartupBootContextInjectedIfNeeded(_ context: String) {
        guard !context.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        bootContextInjectedSessionIDs.insert(currentSessionID)
    }

    /// Feed-stream reconnect backoff bounds (seconds). The first retry is fast so a
    /// brief blip recovers quickly; it caps so a hard-down gateway doesn't spin.
    nonisolated static let bridgeReconnectInitialBackoff: Double = 1
    nonisolated static let bridgeReconnectMaxBackoff: Double = 15
    /// A connection must stay healthy at least this long (seconds) before a drop is
    /// treated as "was a real connection" and the backoff resets to the fast floor.
    /// Below it, the connection was a flap (e.g. a gateway that accepts then cleanly
    /// closes) and the backoff keeps growing so we don't hammer it ~once a second.
    nonisolated static let bridgeReconnectStableThreshold: Double = 10

    /// Next reconnect delay after a connection ended: reset to the floor only if the
    /// connection was healthy long enough, otherwise grow toward the cap. Pure so the
    /// flap-vs-real-drop decision is unit-testable without driving the live stream.
    nonisolated static func nextReconnectBackoff(healthyFor: TimeInterval, current: Double) -> Double {
        healthyFor >= bridgeReconnectStableThreshold
            ? bridgeReconnectInitialBackoff
            : min(current * 2, bridgeReconnectMaxBackoff)
    }

    private func updateRuntimeBridgeAvailability(
        _ availability: LiveBridgeAvailability,
        provider explicitProvider: LiveSessionProvider? = nil
    ) async {
        guard phase.isActive, var cfg = activeConfig else { return }
        guard cfg.bridgeAvailability != availability else { return }
        cfg.bridgeAvailability = availability
        activeConfig = cfg
        do {
            try await (explicitProvider ?? provider)?.setBridgeAvailability(availability, config: cfg)
        } catch {
            append("Hawky bridge tool update failed", level: .warning, detail: error.localizedDescription)
            appendSystemMessage("Hawky bridge tool update failed", level: .warning, detail: error.localizedDescription)
        }
    }

    private func startGatewayBridgeStreamIfNeeded(config: LiveSessionConfig, provider: LiveSessionProvider) {
        // Start the bridge stream whenever the bridge is enabled so surface
        // intention deliveries (M6) arrive even in on-demand feed mode; the ordinary
        // background text/tool feed below is still gated on .followSession.
        let followSession = config.gatewayBridgeFeedMode == .followSession
        guard let gatewayBridge else {
            append("Hawky stream is enabled but bridge is not configured", level: .warning)
            return
        }

        // M8 where-trigger: wire AmbientLocationManager → bridge callbacks for this session.
        let sessionKey = config.gatewayBridgeSessionKey
        ambientLocationManager.onEvent = { [weak self, gatewayBridge] event in
            guard let self else { return }
            switch event {
            case .regionEntered(let regionID):
                Task {
                    do {
                        try await gatewayBridge.reportRegionEntered(intentionId: regionID, sessionKey: sessionKey)
                    } catch {
                        await MainActor.run {
                            self.append("region.entered failed: \(regionID)", level: .warning, detail: error.localizedDescription)
                        }
                    }
                }
            case .authorizationChanged(let status):
                Task {
                    do {
                        try await gatewayBridge.reportLocationAuth(status: Self.locationAuthString(status), sessionKey: sessionKey)
                    } catch {
                        await MainActor.run {
                            self.append("location.auth report failed", level: .warning, detail: error.localizedDescription)
                        }
                    }
                }
                // #481: once Always is granted, re-arm regions whose first arm failed
                // because auth/CLLocationManager state wasn't ready yet.
                if status == .authorizedAlways {
                    Task { await self.handleAuthorizedAlways() }
                }
            case .significantLocationChange(let coordinate):
                // #481: reproject the local ≤20-region budget around the new location
                // so the nearest where reminders stay monitored as the user moves.
                self.append("Significant location change: \(coordinate.latitude),\(coordinate.longitude) — reprojecting regions")
                self.ambientLocationManager.reproject(around: coordinate)
            case .monitoringError(let regionID, let error):
                self.append("Region monitoring error: \(regionID)", level: .warning, detail: error.localizedDescription)
            }
        }

        gatewayBridgeStreamTask?.cancel()
        gatewayBridgeStreamTask = Task { [weak self, gatewayBridge, provider] in
            var pendingText = ""
            var lastFlush = Date()

            func flush(reason: String) async {
                let text = pendingText.trimmingCharacters(in: .whitespacesAndNewlines)
                pendingText = ""
                lastFlush = Date()
                guard !text.isEmpty else { return }
                let context = Self.gatewayFeedContext(
                    sessionKey: sessionKey,
                    kind: "agent_text",
                    body: text,
                    note: "Silent background feed. Use for awareness; speak only selective progress or requested answers."
                )
                do {
                    try await provider.sendContext(context, createResponse: false)
                    await MainActor.run {
                        self?.append("Hawky feed text to Realtime (\(reason))", detail: text)
                    }
                } catch {
                    await MainActor.run {
                        self?.append("Hawky feed failed", level: .warning, detail: error.localizedDescription)
                    }
                }
            }

            // Consume one websocket connection until it ends or throws. Wrapped in the
            // reconnect loop below so a mid-session gateway drop no longer kills the
            // feed for the rest of the session.
            var reconnectBackoff = Self.bridgeReconnectInitialBackoff
            var connectedAt: Date?
            func consumeBridgeConnection() async throws {
                for try await event in await gatewayBridge.stream(sessionKey: sessionKey) {
                    guard !Task.isCancelled else { return }
                    // (Re)connected: the handshake completed, so the gateway is
                    // reachable — clear any offline state. Record when, so the loop can
                    // tell a real connection that later drops from an instant flap.
                    if case .connected = event {
                        connectedAt = Date()
                        await MainActor.run {
                            guard let self, self.phase.isActive else { return }
                            if self.bridgeStatus.isOffline {
                                self.append("Hawky feed reconnected", detail: "Your Hawky machine is reachable again.")
                                self.appendSystemMessage("Hawky machine back online")
                            }
                            self.bridgeStatus = .connected
                        }
                        await self?.updateRuntimeBridgeAvailability(.available, provider: provider)
                        continue
                    }
                    // M8 where-trigger: region arming descriptors — handle in any feed mode.
                    if case .regionsUpdate(let regions) = event {
                        ambientWhereLog.notice("stream received regions.update: \(regions.count, privacy: .public) region(s) [\(regions.map { $0.intentionId }.joined(separator: ","), privacy: .public)]")
                        await MainActor.run {
                            self?.appendWhere("stream received regions.update: \(regions.count) region(s)", detail: regions.map { "\($0.intentionId):\($0.place)" }.joined(separator: ", "))
                        }
                        await self?.handleRegionsUpdate(regions, sessionKey: sessionKey, bridge: gatewayBridge)
                        continue
                    }
                    // #482: hard timed-intention armed — schedule on-device local notification fallback.
                    if case .whenArmed(let intentionId, let fireDateISO, let title, let body) = event {
                        // Parse ISO 8601 with fractional-seconds support (gateway emits .000Z suffix).
                        let iso8601 = ISO8601DateFormatter()
                        iso8601.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                        let fireDate = iso8601.date(from: fireDateISO)
                            ?? ISO8601DateFormatter().date(from: fireDateISO) // fallback: no fractional seconds
                        if let fireDate = fireDate {
                            await self?.ambientLocationManager.scheduleWhenNotification(
                                intentionID: intentionId, title: title, body: body, fireDate: fireDate)
                        } else {
                            await MainActor.run {
                                self?.append("When notification: invalid fireDate \(fireDateISO)", level: .warning)
                            }
                        }
                        continue
                    }
                    // #482: timed intention delivered in-session or disarmed — cancel pending notification.
                    if case .whenDisarmed(let intentionId) = event {
                        UNUserNotificationCenter.current()
                            .removePendingNotificationRequests(withIdentifiers: ["ambient.when.\(intentionId)"])
                        await MainActor.run {
                            self?.append("When notification cancelled: \(intentionId)")
                        }
                        continue
                    }
                    // WS2 live owner recognition (SECONDARY channel): the edge-triggered
                    // `voiceprint.identity` broadcast. Route into the SAME identity state
                    // machine as the realtime_event piggyback (de-duped there) in any feed
                    // mode. FAIL-SAFE: handled behind the recognition flag; a garbled
                    // verdict never yields owner.
                    if case .voiceprintIdentity(_, let verdict, let decision, let confidence, let at) = event {
                        await MainActor.run {
                            self?.handleVoiceprintIdentitySummary(
                                LiveVoiceprintIdentitySummary(
                                    verdict: verdict,
                                    decision: decision,
                                    confidence: confidence,
                                    at: at
                                )
                            )
                        }
                        continue
                    }
                    // Surface intention deliveries (M6) are injected in any feed mode.
                    if case .intentionSurface(let intentionId, let text, let speak, let whenBusy, let cautious) = event {
                        let policy: SurfaceBusyPolicy
                        switch whenBusy {
                        case "cancel": policy = .cancelAndReplace
                        case "downgrade": policy = .downgradeToContext
                        default: policy = .queue
                        }
                        do {
                            // intentionId is threaded through so the realtime model can call intention_respond.
                            // cautious=true → latent suggestion; the realtime model renders it as
                            // a hedged question rather than a definitive assertion (prompt rendering
                            // lives in LiveModels and is out of scope here).
                            try await provider.surfaceIntention(intentionId, text, speak: speak, whenBusy: policy, cautious: cautious)
                            await MainActor.run { self?.append("Surface intention delivered to Realtime", detail: text) }
                        } catch {
                            await MainActor.run { self?.append("Surface delivery failed", level: .warning, detail: error.localizedDescription) }
                        }
                        continue
                    }
                    // Ordinary background feed only mirrors into the session in .followSession mode.
                    guard followSession else { continue }
                    switch event {
                    case .text(content: let chunk, replace: let replace):
                        pendingText = replace ? chunk : pendingText + chunk
                        if pendingText.count >= 700 || Date().timeIntervalSince(lastFlush) >= 1.25 {
                            await flush(reason: "batch")
                        }
                    case .toolStart(let name):
                        await flush(reason: "before tool")
                        let context = Self.gatewayFeedContext(
                            sessionKey: sessionKey,
                            kind: "tool_start",
                            body: name,
                            note: "Background Hawky started a tool. Do not invent the result."
                        )
                        try await provider.sendContext(context, createResponse: false)
                        await MainActor.run {
                            self?.append("Hawky feed tool to Realtime: \(name)")
                            // Backend tools have no stable call_id over this feed;
                            // key the bubble by name so its result can update it.
                            self?.upsertToolCall(callID: "gateway:\(name)", name: name, status: .started, source: .gateway)
                        }
                    case .toolResult(let name, let ok):
                        await MainActor.run {
                            self?.upsertToolCall(callID: "gateway:\(name)", name: name, status: ok ? .ok : .error, source: .gateway)
                        }
                    case .system(let message):
                        await flush(reason: "before system")
                        let context = Self.gatewayFeedContext(
                            sessionKey: sessionKey,
                            kind: "system",
                            body: message,
                            note: "Background system event. Mention only if operationally useful."
                        )
                        try await provider.sendContext(context, createResponse: false)
                    case .done:
                        await flush(reason: "done")
                    case .connected:
                        break // handled before the feed gate above
                    case .intentionSurface:
                        break // handled before the feed gate above
                    case .regionsUpdate:
                        break // handled before the feed gate above
                    case .whenArmed:
                        break // handled before the feed gate above (#482)
                    case .whenDisarmed:
                        break // handled before the feed gate above (#482)
                    case .voiceprintIdentity:
                        break // handled before the feed gate above (WS2)
                    case .error(let message):
                        await flush(reason: "before error")
                        await MainActor.run {
                            self?.append("Hawky feed error", level: .warning, detail: message)
                            self?.appendSystemMessage("Hawky feed error", level: .warning, detail: message)
                        }
                    }
                }
            }

            // Reconnect loop: the feed websocket has no built-in retry, so a
            // mid-session gateway drop previously killed the feed (and stuck the
            // offline banner) until the whole Live session was restarted. Keep
            // re-establishing it with backoff while the session stays active; the
            // `.connected` signal handled above clears offline on each reconnect.
            while !Task.isCancelled {
                let sessionActive = await MainActor.run { self?.phase.isActive ?? false }
                guard sessionActive else { break }
                connectedAt = nil
                do {
                    try await consumeBridgeConnection()
                } catch {
                    await MainActor.run {
                        guard let self, !Task.isCancelled, self.phase.isActive else { return }
                        // Shout only on the transition into offline; subsequent failed
                        // reconnect attempts stay quiet so a hard-down gateway doesn't
                        // spam the transcript every backoff interval.
                        if !self.bridgeStatus.isOffline {
                            self.append("Hawky feed stopped", level: .error, detail: error.localizedDescription)
                            self.appendSystemMessage("Hawky feed stopped", level: .error, detail: error.localizedDescription)
                        }
                        self.bridgeStatus = .offline(error.localizedDescription)
                    }
                    await self?.updateRuntimeBridgeAvailability(.offline(error.localizedDescription), provider: provider)
                }
                guard !Task.isCancelled else { break }
                // Reset to a fast retry only if the connection was healthy for a while;
                // a flap (connect → immediate clean close) keeps growing the backoff.
                let healthyFor = connectedAt.map { Date().timeIntervalSince($0) } ?? 0
                reconnectBackoff = Self.nextReconnectBackoff(healthyFor: healthyFor, current: reconnectBackoff)
                try? await Task.sleep(nanoseconds: UInt64(reconnectBackoff * 1_000_000_000))
            }
        }
    }

    nonisolated private static func gatewayFeedContext(sessionKey: String, kind: String, body: String, note: String) -> String {
        """
        [Hawky background session feed]
        session_key: \(sessionKey)
        event_kind: \(kind)
        note: \(note)

        \(body)
        """
    }

    private func appendUserMessage(_ message: String) {
        appendConversation(role: .user, text: message, level: .info, isStreaming: false)
        updateWidgetStatus(contextLine: "You: \(message)")
        currentAssistantEntryID = nil
    }

    private func appendVisualFrame(_ data: Data) {
        let detail = """
        {
          "type": "input_image",
          "frame_index": \(diagnostics.visualFramesCaptured),
          "bytes": \(data.count),
          "captured_at": "\(ISO8601DateFormatter().string(from: Date()))"
        }
        """
        let entry = LiveConversationEntry(
            role: .user,
            text: "Camera frame \(diagnostics.visualFramesCaptured) (\(byteLabel(data.count)))",
            level: .info,
            isStreaming: false,
            detail: detail,
            eventType: "conversation.item.create",
            imageData: data
        )
        conversation.append(entry)
        // Deliberately NOT journaled: camera frames are transient model input.
        // Persisting their raw JPEG imageData bloated the .jsonl to tens of MB
        // (≈25 KB/line), and the synchronous reload on the @MainActor init then
        // tripped the 0x8BADF00D watchdog. Kept in-memory only for the live
        // transcript; trimConversation() bounds the in-memory array.
        trimConversation()
    }

    func exportCurrentSessionJSONL() -> URL? {
        saveCurrentSession()
        guard let session = localSessions.first(where: { $0.id == currentSessionID }) else { return nil }
        return exportSessionDisplayJSONL(session)
    }

    func exportSessionDisplayJSONL(_ session: LiveLocalSession) -> URL? {
        saveCurrentSession()
        let refreshedSession = localSessions.first(where: { $0.id == session.id }) ?? session
        if let url = LiveSessionArchive.exportDisplayJSONL(for: refreshedSession) {
            return url
        }
        appendSystemMessage("Display export failed", level: .error)
        return nil
    }

    func exportSessionRawJSONL(_ session: LiveLocalSession) -> URL? {
        exportSessionRawBundle(session)?.archiveURL
    }

    func exportSessionRawBundle(_ session: LiveLocalSession) -> LiveSessionExportBundle? {
        saveCurrentSession()
        let refreshedSession = localSessions.first(where: { $0.id == session.id }) ?? session
        if let bundle = LiveSessionArchive.exportRawBundle(for: refreshedSession) {
            return bundle
        }
        appendSystemMessage("Raw export failed", level: .error)
        return nil
    }

    /// Rebuild the model's memory from the persisted transcript when resuming a
    /// session that already has turns. Only real user/assistant text is sent
    /// (system lines and camera-frame entries are skipped).
    private func turnsForHistoryReplay() -> [LiveHistoryTurn] {
        transcript.compactMap { entry in
            let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, entry.imageData == nil else { return nil }
            switch entry.role {
            case .user: return LiveHistoryTurn(role: .user, text: text)
            case .assistant: return LiveHistoryTurn(role: .assistant, text: text)
            case .system, .tool: return nil
            }
        }
    }

    private func seedHistoryIfNeeded(provider: LiveSessionProvider, turns: [LiveHistoryTurn]) async {
        guard !turns.isEmpty else { return }
        do {
            try await provider.seedHistory(turns)
            appendSystemMessage("Restored \(turns.count) prior turn\(turns.count == 1 ? "" : "s") of context")
        } catch {
            appendSystemMessage("Could not restore prior context: \(error.localizedDescription)", level: .warning)
        }
    }

    private func appendAssistantMessage(_ message: String) {
        appendConversation(role: .assistant, text: message, level: .info, isStreaming: false)
        currentAssistantEntryID = nil
    }

    private func appendAssistantDelta(itemID: String?, phase: String? = nil, delta: String, detail: String?, eventType: String?) {
        guard !delta.isEmpty else { return }
        // Prefer keying by the Realtime output item_id: one item == one bubble,
        // even across multiple deltas/redeliveries. Fall back to the single
        // "current" entry only when no item_id is provided (e.g. mock provider).
        let existingID: UUID? = itemID.flatMap { assistantEntryByItemID[$0] } ?? currentAssistantEntryID
        if let id = existingID,
           let index = conversation.firstIndex(where: { $0.id == id }) {
            // Event-driven (#623): grow the in-flight text in `streamingText`
            // (only the streaming bubble observes it), NOT `conversation` — so a
            // per-token delta doesn't re-render the whole list. Low-frequency
            // metadata stays on the committed entry, touched only when it
            // actually changes to avoid spurious array mutations.
            streamingText.text[id, default: ""] += delta
            if !conversation[index].isStreaming { conversation[index].isStreaming = true }
            if let detail, conversation[index].detail != detail { conversation[index].detail = detail }
            if let eventType, conversation[index].eventType != eventType { conversation[index].eventType = eventType }
            if let phase, conversation[index].phase != phase { conversation[index].phase = phase }
            scheduleStreamingScrollTick()
            return
        }
        // First delta for a new bubble: append a committed entry with empty text
        // and seed the in-flight text in the holder. The append mutates the array
        // once (fires auto-scroll); subsequent deltas don't.
        let entry = LiveConversationEntry(
            role: .assistant,
            text: "",
            level: .info,
            isStreaming: true,
            detail: detail,
            eventType: eventType,
            phase: phase
        )
        if let itemID { assistantEntryByItemID[itemID] = entry.id }
        currentAssistantEntryID = entry.id
        streamingText.text[entry.id] = delta
        conversation.append(entry)
        journal(entry)
        trimConversation()
    }

    /// Bump the scroll tick at most ~14 Hz so the transcript follows streaming
    /// text without scrolling on every token (the array itself doesn't change
    /// while streaming, so onChange(of: conversation) can't drive it). (#623)
    private func scheduleStreamingScrollTick() {
        let now = Date()
        if let last = lastScrollTickAt, now.timeIntervalSince(last) < 0.07 { return }
        lastScrollTickAt = now
        streamingText.scrollTick &+= 1
    }

    private func finishAssistantMessage(itemID: String? = nil, phase: String? = nil, fallbackText: String? = nil, detail: String? = nil, eventType: String? = nil) {
        // Resolve the bubble this completion belongs to: by item_id if we have
        // one, else the in-flight entry. This collapses the duplicate where a
        // response's transcript is re-delivered (e.g. commentary then
        // final_answer items carrying the same text) into one bubble.
        let targetID: UUID? = itemID.flatMap { assistantEntryByItemID[$0] } ?? currentAssistantEntryID
        if let id = targetID,
           let index = conversation.firstIndex(where: { $0.id == id }) {
            // Commit handoff (#623): land the streamed text into the committed
            // entry, preferring the authoritative full transcript from the done
            // event over the accumulated in-flight deltas (which can lag/differ).
            if let fallbackText, !fallbackText.isEmpty {
                conversation[index].text = fallbackText
            } else if let live = streamingText.text[id] {
                conversation[index].text = live
            }
            conversation[index].isStreaming = false
            conversation[index].detail = detail ?? conversation[index].detail
            conversation[index].eventType = eventType ?? conversation[index].eventType
            conversation[index].phase = phase ?? conversation[index].phase
            // Stop the bubble reading the holder; it now shows the committed text.
            streamingText.text[id] = nil
            journal(conversation[index])
            updateWidgetStatus(contextLine: "Agent: \(conversation[index].text)")
        } else if let fallbackText, !fallbackText.isEmpty {
            var entry = appendConversation(role: .assistant, text: fallbackText, level: .info, isStreaming: false, detail: detail, eventType: eventType)
            if let phase, let index = conversation.firstIndex(where: { $0.id == entry.id }) {
                conversation[index].phase = phase
                entry = conversation[index]
                journal(entry)
            }
            if let itemID { assistantEntryByItemID[itemID] = entry.id }
            updateWidgetStatus(contextLine: "Agent: \(entry.text)")
            return
        }
        currentAssistantEntryID = nil
    }

    private func appendUserTranscriptDelta(itemID: String, delta: String, detail: String?, eventType: String?) {
        guard !delta.isEmpty else { return }
        if let entryID = transcriptEntryByItemID[itemID],
           let index = conversation.firstIndex(where: { $0.id == entryID }) {
            conversation[index].text += delta
            conversation[index].isStreaming = true
            conversation[index].detail = detail ?? conversation[index].detail
            conversation[index].eventType = eventType ?? conversation[index].eventType
            return
        }
        let entry = LiveConversationEntry(
            role: .user,
            text: delta,
            level: .info,
            isStreaming: true,
            detail: detail,
            eventType: eventType
        )
        transcriptEntryByItemID[itemID] = entry.id
        currentUserAudioEntryID = entry.id
        conversation.append(entry)
        journal(entry)
        trimConversation()
    }

    private func finishUserTranscript(itemID: String, transcript: String, detail: String?, eventType: String?) {
        // Stay Silent: capture finalized user turns for the release recap.
        if staySilentActive {
            let captured = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !captured.isEmpty {
                silenceTranscript.append((timestamp: Date(), role: "user", text: captured))
            }
        }
        if let entryID = transcriptEntryByItemID[itemID],
           let index = conversation.firstIndex(where: { $0.id == entryID }) {
            if !transcript.isEmpty {
                conversation[index].text = transcript
            }
            conversation[index].isStreaming = false
            conversation[index].detail = detail ?? conversation[index].detail
            conversation[index].eventType = eventType ?? conversation[index].eventType
            journal(conversation[index])
            updateWidgetStatus(contextLine: "You: \(conversation[index].text)")
        } else if !transcript.isEmpty {
            appendConversation(role: .user, text: transcript, level: .info, isStreaming: false, detail: detail, eventType: eventType)
            updateWidgetStatus(contextLine: "You: \(transcript)")
        } else if eventType == "input_audio_buffer.speech_stopped" {
            let unavailableDetail = detail ?? "No transcription text was provided for this spoken turn."
            appendConversation(role: .user, text: "", level: .warning, isStreaming: false, detail: unavailableDetail, eventType: eventType)
            updateWidgetStatus(contextLine: "You spoke")
        }
        transcriptEntryByItemID[itemID] = nil
        currentUserAudioEntryID = nil
        scheduleSessionMetadataSave()

        // Fix(M6 §3.2 / P3c): Wire finalized user turns to the gateway latent
        // recognizer using the running session's immutable config snapshot.
        if let target = Self.transcriptAppendRuntimeTarget(activeConfig: activeConfig, draftConfig: config),
           !transcript.isEmpty,
           let bridge = gatewayBridge {
            let ts = ISO8601DateFormatter().string(from: Date())
            pendingTranscriptAppend = Task {
                try? await bridge.appendTranscript(
                    turns: [(role: "user", text: transcript, ts: ts)],
                    sessionKey: target.sessionKey,
                    mode: target.modeRaw
                )
            }
        }
    }

    /// Awaits the in-flight transcript append (if any) for the most-recently
    /// finalized user turn. Called by ScanIntentionTool so the gateway window
    /// is up-to-date before the scan RPC runs.
    func awaitPendingTranscriptAppend() async {
        await pendingTranscriptAppend?.value
    }

    /// Destructively land in-flight streamed text into the committed entries and
    /// clear the holder — for finalize-style paths (stop) where the turn won't
    /// finish normally. Reads elsewhere should use the non-destructive
    /// `transcript`. (#623)
    private func commitStreamingText() {
        guard !streamingText.text.isEmpty else { return }
        for (id, live) in streamingText.text {
            if let index = conversation.firstIndex(where: { $0.id == id }),
               conversation[index].text != live {
                conversation[index].text = live
            }
        }
        streamingText.text.removeAll()
    }

    private func finishCurrentAudioTurn(byteCount: Int) {
        let cfg = liveConfig
        if cfg.inputTranscriptionEnabled {
            if currentUserAudioEntryID == nil {
                let entry = LiveConversationEntry(
                    role: .user,
                    text: "Audio turn \(byteLabel(byteCount))",
                    level: .info,
                    isStreaming: true,
                    eventType: "input_audio_buffer.commit"
                )
                currentUserAudioEntryID = entry.id
                conversation.append(entry)
                journal(entry)
                trimConversation()
                updateWidgetStatus(contextLine: entry.text)
            }
        } else {
            appendUserMessage("Audio turn \(byteLabel(byteCount))")
        }
    }

    /// Create or update a tool-call bubble. `callID` ties a started→completed
    /// pair to one bubble; when nil (backend tools without an id) each call is
    /// its own bubble.
    private func upsertToolCall(
        callID: String?,
        name: String,
        status: LiveToolCallInfo.Status,
        source: LiveToolCallInfo.Source,
        arguments: String? = nil,
        output: String? = nil
    ) {
        let now = Date()
        // Update an existing bubble for this call id.
        if let callID, let id = toolEntryByCallID[callID],
           let index = conversation.firstIndex(where: { $0.id == id }) {
            var info = conversation[index].toolCall ?? LiveToolCallInfo(name: name, status: status, source: source)
            info.status = status
            info.callID = callID
            info.startedAt = info.startedAt ?? conversation[index].date
            if status != .started {
                info.completedAt = now
            }
            if let arguments { info.arguments = arguments }
            if let output { info.output = output }
            conversation[index].toolCall = info
            conversation[index].text = Self.toolBubbleText(info)
            conversation[index].detail = output ?? arguments ?? conversation[index].detail
            conversation[index].isStreaming = (status == .started)
            conversation[index].level = (status == .error) ? .error : .info
            journal(conversation[index])
            scheduleSessionMetadataSave()
            return
        }
        let info = LiveToolCallInfo(
            name: name,
            status: status,
            source: source,
            arguments: arguments,
            output: output,
            callID: callID,
            startedAt: now,
            completedAt: status == .started ? nil : now
        )
        let entry = LiveConversationEntry(
            date: now,
            role: .tool,
            text: Self.toolBubbleText(info),
            level: status == .error ? .error : .info,
            isStreaming: status == .started,
            detail: output ?? arguments,
            eventType: "tool",
            toolCall: info
        )
        if let callID { toolEntryByCallID[callID] = entry.id }
        conversation.append(entry)
        journal(entry)
        trimConversation()
    }

    /// Parse a session_send_message result's `tool_events` (e.g.
    /// ["start:web_fetch","ok:web_fetch"]) and surface each backend tool as its
    /// own "· via Hawky" bubble. start→ok/error for the same tool update one
    /// bubble.
    private func surfaceBackendToolEvents(from output: String) {
        guard let data = output.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let events = obj["tool_events"] as? [String] else {
            return
        }
        for event in events {
            // Format is "<status>:<toolName>", status ∈ start|ok|error.
            let parts = event.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            let rawStatus = parts[0]
            let toolName = parts[1]
            let status: LiveToolCallInfo.Status
            switch rawStatus {
            case "start": status = .started
            case "ok": status = .ok
            default: status = .error
            }
            upsertToolCall(callID: "gateway:\(toolName)", name: toolName, status: status, source: .gateway)
        }
    }

    private static func toolOutputIndicatesError(_ output: String) -> Bool {
        guard let data = output.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        if let ok = obj["ok"] as? Bool { return !ok }
        if obj["error"] != nil { return true }
        return false
    }

    private static func toolBubbleText(_ info: LiveToolCallInfo) -> String {
        let via = info.source == .gateway ? " · via Hawky" : ""
        switch info.status {
        case .started: return "\(info.name)\(via)"
        case .ok: return "\(info.name)\(via)"
        case .error: return "\(info.name)\(via) — failed"
        }
    }

    private func appendSystemMessage(
        _ message: String,
        level: LiveEventLogEntry.Level = .info,
        detail: String? = nil,
        eventType: String? = nil
    ) {
        guard conversation.last?.text != message || conversation.last?.role != .system else { return }
        appendConversation(role: .system, text: message, level: level, isStreaming: false, detail: detail, eventType: eventType)
        updateWidgetStatus(detailLine: message)
    }

    @discardableResult
    private func appendConversation(
        role: LiveConversationRole,
        text: String,
        level: LiveEventLogEntry.Level,
        isStreaming: Bool,
        detail: String? = nil,
        eventType: String? = nil
    ) -> LiveConversationEntry {
        let entry = LiveConversationEntry(
            role: role,
            text: text,
            level: level,
            isStreaming: isStreaming,
            detail: detail,
            eventType: eventType
        )
        conversation.append(entry)
        journal(entry)
        trimConversation()
        return entry
    }

    private func trimConversation() {
        var removed: Set<UUID> = []
        let maxSystemEntries = 80
        while conversation.filter({ $0.role == .system }).count > maxSystemEntries,
              let index = conversation.firstIndex(where: { $0.role == .system }) {
            removed.insert(conversation[index].id)
            conversation.remove(at: index)
        }

        let maxConversationEntries = 180
        while conversation.count > maxConversationEntries {
            if let index = conversation.firstIndex(where: { $0.role == .system }) {
                removed.insert(conversation[index].id)
                conversation.remove(at: index)
            } else {
                removed.insert(conversation[0].id)
                conversation.removeFirst()
            }
        }

        // Prune the item_id → entry maps (and any in-flight streamed text) for
        // trimmed entries. Otherwise these grow unbounded over a long session —
        // the conversation is capped at 180 but the maps kept every key forever,
        // leaking memory until the session ends. (memory)
        if !removed.isEmpty {
            transcriptEntryByItemID = transcriptEntryByItemID.filter { !removed.contains($0.value) }
            assistantEntryByItemID = assistantEntryByItemID.filter { !removed.contains($0.value) }
            toolEntryByCallID = toolEntryByCallID.filter { !removed.contains($0.value) }
            for id in removed { streamingText.text[id] = nil }
        }
        scheduleSessionMetadataSave()
    }

    private func updateConversationState(forRawType type: String) {
        switch type {
        case "response.created":
            currentAssistantEntryID = nil
        case "response.done", "response.cancelled", "response.failed":
            finishAssistantMessage()
        default:
            break
        }
    }

    private func persist() {
        LiveProfileDefaults.save(config)
    }

    private func savePromptProfiles() {
        LivePromptLibrary.save(promptProfiles)
    }

    private enum LiveGatewayBridgeBootstrapLedger {
        private static let key = "live.gatewayBridge.initializedSessionKeys"

        static func contains(_ sessionKey: String) -> Bool {
            initializedKeys().contains(normalize(sessionKey))
        }

        static func insert(_ sessionKey: String) {
            var keys = initializedKeys()
            keys.insert(normalize(sessionKey))
            UserDefaults.standard.set(Array(keys).sorted(), forKey: key)
        }

        private static func initializedKeys() -> Set<String> {
            Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
        }

        private static func normalize(_ sessionKey: String) -> String {
            sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private static func makeEmptySession() -> LiveLocalSession {
        let now = Date()
        return LiveLocalSession(
            id: UUID(),
            title: "Live Session",
            createdAt: now,
            updatedAt: now,
            conversation: []
        )
    }

    private static func makeRealtimeBridgeSessionKey() -> String {
        "realtime:\(UUID().uuidString.lowercased())"
    }

    private static func historyReplayJSON(turns: [LiveHistoryTurn], config: LiveSessionConfig) -> String {
        let userTurnCount = turns.filter { $0.role == .user }.count
        let assistantTurnCount = turns.filter { $0.role == .assistant }.count
        let payload: [String: Any] = [
            "assistant_turn_count": assistantTurnCount,
            "input_transcription_enabled": config.inputTranscriptionEnabled,
            "recovery_quality": recoveryQuality(userTurnCount: userTurnCount, assistantTurnCount: assistantTurnCount, config: config),
            "turn_count": turns.count,
            "user_turn_count": userTurnCount,
            "warnings": recoveryWarnings(userTurnCount: userTurnCount, assistantTurnCount: assistantTurnCount, config: config),
            "turns": turns.map { turn in
                [
                    "role": turn.role == .user ? "user" : "assistant",
                    "text": turn.text
                ]
            }
        ]
        return prettyJSON(payload)
    }

    private static func initialMessagesJSON(turns: [LiveHistoryTurn], config: LiveSessionConfig) -> String {
        let userTurnCount = turns.filter { $0.role == .user }.count
        let assistantTurnCount = turns.filter { $0.role == .assistant }.count
        let payload: [String: Any] = [
            "assistant_turn_count": assistantTurnCount,
            "input_transcription_enabled": config.inputTranscriptionEnabled,
            "option": "initial_messages",
            "recovery_quality": recoveryQuality(userTurnCount: userTurnCount, assistantTurnCount: assistantTurnCount, config: config),
            "user_turn_count": userTurnCount,
            "warnings": recoveryWarnings(userTurnCount: userTurnCount, assistantTurnCount: assistantTurnCount, config: config),
            "messages": turns.compactMap { turn -> [String: Any]? in
                let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return nil }
                return [
                    "role": turn.role == .user ? "user" : "assistant",
                    "content": text,
                    "expected_openai_content_type": turn.role == .user ? "input_text" : "output_text"
                ]
            }
        ]
        return prettyJSON(payload)
    }

    private static func rawAudioAppendJSON(startedAt: Date, endedAt: Date) -> String {
        prettyJSON([
            "type": "input_audio_buffer.append",
            "audio": "<webrtc_media_track>",
            "audio_ref": NSNull(),
            "audio_format": "webrtc/rtp",
            "byte_count": NSNull(),
            "capture_started_at": ISO8601DateFormatter().string(from: startedAt),
            "capture_ended_at": ISO8601DateFormatter().string(from: endedAt),
            "duration_ms": max(0, Int(endedAt.timeIntervalSince(startedAt) * 1000)),
            "normalized_from": "webrtc.local_audio_track",
            "wire_note": "In WebRTC mode, user audio is sent as RTP media. This normalized OpenAI-style marker records timing only; no PCM sidecar is captured by the current iOS Pipecat/OpenAI transport."
        ])
    }

    private static func recoveryQuality(
        userTurnCount: Int,
        assistantTurnCount: Int,
        config: LiveSessionConfig
    ) -> String {
        if userTurnCount > 0 { return "semantic" }
        if assistantTurnCount > 0 && !config.inputTranscriptionEnabled { return "assistant_only_lossy" }
        if assistantTurnCount > 0 { return "assistant_only" }
        return "empty"
    }

    private static func recoveryWarnings(
        userTurnCount: Int,
        assistantTurnCount: Int,
        config: LiveSessionConfig
    ) -> [String] {
        var warnings: [String] = []
        if userTurnCount == 0 && assistantTurnCount > 0 {
            warnings.append("No user text turns are available for replay.")
        }
        if !config.inputTranscriptionEnabled {
            warnings.append("User transcription is disabled; spoken user intent is not recoverable from the display log.")
        }
        return warnings
    }

    private static func prettyJSON(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return #"{"error":"Could not encode diagnostic payload"}"#
        }
        return text
    }

    private nonisolated static func rawJSONObject(_ rawJSON: String) -> [String: Any] {
        guard let data = rawJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }

    private nonisolated static func stringValue(_ object: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = cleanedString(object[key] as? String) {
                return value
            }
        }
        return nil
    }

    private nonisolated static func numberValue(_ object: [String: Any], keys: [String]) -> Double? {
        for key in keys {
            if let value = object[key] as? Double, value.isFinite {
                return value
            }
            if let value = object[key] as? Int {
                return Double(value)
            }
            if let value = object[key] as? NSNumber {
                let number = value.doubleValue
                if number.isFinite {
                    return number
                }
            }
        }
        return nil
    }

    private nonisolated static func finiteNumber(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return value
    }

    private nonisolated static func cleanedString(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private func currentRealtimeBridgeSessionKey() -> String {
        "realtime:\(currentSessionID.uuidString.lowercased())"
    }

    private func journal(_ entry: LiveConversationEntry) {
        guard let session = localSessions.first(where: { $0.id == currentSessionID }) else { return }
        LiveSessionArchive.append(entry: entry, to: session)
        scheduleSessionMetadataSave()
    }

    private func journalRaw(
        direction: LiveSessionEvent.Direction,
        type: String,
        json: String,
        providerLabel: String? = nil
    ) {
        guard let session = localSessions.first(where: { $0.id == currentSessionID }) else { return }
        let entry = LiveRawLogEntry(
            provider: providerLabel ?? config.provider.label,
            direction: direction,
            type: type,
            json: json
        )
        LiveSessionArchive.append(rawEntry: entry, to: session)
    }

    private func scheduleSessionMetadataSave() {
        sessionMetadataSaveTask?.cancel()
        sessionMetadataSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.saveCurrentSession()
        }
    }

    private func saveCurrentSession() {
        sessionMetadataSaveTask?.cancel()
        sessionMetadataSaveTask = nil
        guard let index = localSessions.firstIndex(where: { $0.id == currentSessionID }) else { return }
        // Persist the merged transcript so a save mid-stream stores the in-flight
        // text, not "" — non-destructively (no view re-render). (#623)
        let snapshot = transcript
        localSessions[index].conversation = snapshot
        localSessions[index].updatedAt = lastActivityDate(for: snapshot, fallback: localSessions[index].createdAt)
        localSessions[index].title = sessionTitle(for: snapshot, fallback: localSessions[index].title)
        sortLocalSessions()
        LiveSessionArchive.save(localSessions)
        LiveSessionArchive.saveCurrentSessionID(currentSessionID)
    }

    private func updateCurrentSessionSnapshot() {
        guard let index = localSessions.firstIndex(where: { $0.id == currentSessionID }) else { return }
        localSessions[index].conversation = conversation
    }

    private func persistSessions() {
        sortLocalSessions()
        LiveSessionArchive.save(localSessions)
        LiveSessionArchive.saveCurrentSessionID(currentSessionID)
    }

    private func sortLocalSessions() {
        localSessions.sort {
            if $0.isBookmarked != $1.isBookmarked {
                return $0.isBookmarked && !$1.isBookmarked
            }
            return $0.updatedAt > $1.updatedAt
        }
    }

    private func lastActivityDate(for conversation: [LiveConversationEntry], fallback: Date) -> Date {
        conversation.map(\.date).max() ?? fallback
    }

    private func sessionTitle(for conversation: [LiveConversationEntry], fallback: String) -> String {
        guard let first = conversation.first(where: { $0.role != .system && !$0.text.isEmpty }) else {
            return fallback
        }
        let trimmed = first.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 32 { return trimmed }
        return String(trimmed.prefix(32)) + "..."
    }

    private func byteLabel(_ bytes: Int) -> String {
        if bytes < 1024 {
            return "\(bytes) B"
        }
        return String(format: "%.1f KB", Double(bytes) / 1024.0)
    }

    private func shortID(_ id: String) -> String {
        if id.count <= 8 { return id }
        return String(id.prefix(8))
    }

    nonisolated private static func currentUptimeNanoseconds() -> UInt64 {
        UInt64(DispatchTime.now().uptimeNanoseconds)
    }

}

@MainActor
private final class LiveRealtimeAudioOutputPlayer {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var destination: LiveAudioOutputDestination = .auto
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24_000,
        channels: 1,
        interleaved: false
    )

    /// Update the desired output route. If a session is already active, the new
    /// route is applied immediately so the change takes effect mid-conversation;
    /// otherwise it is picked up the next time `ensureStarted` runs.
    func updateDestination(_ destination: LiveAudioOutputDestination) {
        self.destination = destination
        guard engine?.isRunning == true else { return }
        try? applyRoute(destination)
    }

    func play(_ data: Data) throws -> LiveRealtimeAudioPlaybackResult {
        guard !data.isEmpty, let format else {
            throw LiveRealtimeAudioPlaybackError.emptyChunk
        }
        try ensureStarted(format: format)
        guard let player else {
            throw LiveRealtimeAudioPlaybackError.playerUnavailable
        }
        let frameCount = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
              let destination = buffer.floatChannelData?[0] else {
            throw LiveRealtimeAudioPlaybackError.bufferCreationFailed
        }

        buffer.frameLength = frameCount
        data.withUnsafeBytes { rawBuffer in
            let source = rawBuffer.bindMemory(to: Int16.self)
            for index in 0..<Int(frameCount) {
                destination[index] = Float(Int16(littleEndian: source[index])) / 32_768.0
            }
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
        if !player.isPlaying {
            player.play()
        }
        return LiveRealtimeAudioPlaybackResult(bytes: Int(frameCount) * MemoryLayout<Int16>.size, frames: Int(frameCount))
    }

    func stop() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
    }

    /// Configure the shared audio session for the requested output destination.
    /// `mode: .voiceChat` keeps voice-processing (echo cancellation) on the
    /// input path; the category options and port override decide whether the
    /// reply plays through the loudspeaker, the receiver, or Bluetooth glasses.
    private func applyRoute(_ destination: LiveAudioOutputDestination) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: destination.playbackCategoryOptions
        )
        try session.setActive(true)
        if let override = destination.portOverride {
            try session.overrideOutputAudioPort(override)
        }
    }

    private func ensureStarted(format: AVAudioFormat) throws {
        if let engine, engine.isRunning { return }
        try applyRoute(destination)

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        // attach/connect/start raise an Obj-C NSException on a format mismatch,
        // which a Swift do/catch can't catch (it aborts the process). Guard the
        // whole graph setup so a bad format throws recoverably. (#673)
        try AudioGraphGuard.run {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
        }
        self.engine = engine
        self.player = player
    }
}

private struct LiveRealtimeAudioPlaybackResult {
    var bytes: Int
    var frames: Int
}

private enum LiveRealtimeAudioPlaybackError: LocalizedError {
    case emptyChunk
    case playerUnavailable
    case bufferCreationFailed

    var errorDescription: String? {
        switch self {
        case .emptyChunk:
            return "OpenAI returned an empty audio chunk."
        case .playerUnavailable:
            return "Audio player is unavailable."
        case .bufferCreationFailed:
            return "Could not create a playback buffer."
        }
    }
}
