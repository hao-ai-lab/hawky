import Foundation

// =============================================================================
// OwnerEnrollmentModel — B3 owner voiceprint enrollment flow (testable logic).
//
// This is the SwiftUI-independent core of owner enrollment. It tracks recorded
// sources, enforces the FAIL-CLOSED biometric-consent gate, validates that enough
// VOICED speech was captured (guiding the user toward the server's >= 30s floor),
// assembles the exact `enroll_owner` params (server wire keys), and drives an
// explicit state machine (idle / recording / needsConsent / tooShort / submitting
// / enrolled / failed).
//
// It NEVER submits `enroll_owner` unless the user has explicitly granted biometric
// AND capture consent in this flow. Nothing about this flow flips
// `voiceprintRealtimeEnabled` or `onDeviceEmbeddingEnabled`; enrolling only sets up
// the template. Enabling live scoring stays a separate, still-off switch.
// =============================================================================

/// The gateway surface owner enrollment needs. Abstracted as a protocol so the
/// consent gate / param-assembly / state logic is unit-testable with a fake,
/// without a live `LiveGatewayBridge` actor. `LiveGatewayBridge` conforms below.
protocol VoiceprintEnrollmentGateway: Sendable {
    /// Upload a locally-recorded enrollment WAV to the gateway's media ingest so a
    /// subsequent `registerVoiceprintAudioArtifact(mediaID:)` with the SAME id can
    /// resolve it. Returns true when the upload was finalized on the gateway.
    ///
    /// Defaulted to a no-op (returns false) so gateways that cannot upload (the
    /// inert/offline gateway and unit-test fakes) do not need to implement it; the
    /// recorder then falls back to the local-path enrollment source.
    func uploadVoiceprintEnrollmentAudio(
        sessionKey: String,
        mediaID: String,
        wavPath: String,
        timeoutSeconds: TimeInterval
    ) async -> Bool

    /// Register a locally-recorded WAV so it can be referenced by `audioArtifactId`.
    func registerVoiceprintAudioArtifact(
        sessionKey: String,
        audioArtifactID: String,
        mediaID: String,
        sampleRate: Double?,
        route: String?,
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintAudioArtifactRegistration?

    /// Enroll the owner template from the assembled params.
    func enrollVoiceprintOwner(
        sessionKey: String,
        params: [String: JSONValue],
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEnrollmentResult?

    /// Append one more source to an existing owner template.
    func addVoiceprintEnrollmentClip(
        sessionKey: String,
        params: [String: JSONValue],
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEnrollmentResult?

    /// Enroll the owner template from a live listening session's uploaded
    /// recording segments (`enroll_owner_from_recording`). Defaulted to nil so
    /// inert/offline gateways and unit-test fakes keep compiling; the model's
    /// submit path then fails closed with a clear "could not reach" message.
    func enrollVoiceprintOwnerFromRecording(
        sessionKey: String,
        params: [String: JSONValue],
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEnrollmentResult?

    /// Query whether an owner template is already enrolled (+ scalar metadata) so
    /// the UI can show an "already enrolled" state. Defaulted to nil so inert /
    /// test gateways need not implement it (the UI then shows the first-time flow).
    func fetchOwnerTemplateStatus(
        sessionKey: String,
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintOwnerTemplateStatus?
}

extension LiveGatewayBridge: VoiceprintEnrollmentGateway {}

extension VoiceprintEnrollmentGateway {
    /// Default: no upload capability. Conformers that cannot deliver media to the
    /// gateway (inert/offline gateway, unit-test fakes) inherit this no-op so the
    /// recorder falls back to a local-path enrollment source.
    func uploadVoiceprintEnrollmentAudio(
        sessionKey: String,
        mediaID: String,
        wavPath: String,
        timeoutSeconds: TimeInterval
    ) async -> Bool { false }

    /// Default: status unknown (nil). Inert/test gateways inherit this, so the UI
    /// falls back to the first-time enrollment flow.
    func fetchOwnerTemplateStatus(
        sessionKey: String,
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintOwnerTemplateStatus? { nil }

    /// Default: from-recording enrollment unavailable (nil). Gateways that cannot
    /// run the RPC (inert/offline gateway, unit-test fakes) inherit this, and the
    /// model surfaces a "could not reach" failure instead of enrolling anything.
    func enrollVoiceprintOwnerFromRecording(
        sessionKey: String,
        params: [String: JSONValue],
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEnrollmentResult? { nil }
}

/// The biometric-consent snapshot for enrollment. All four keys are surfaced to
/// the server with the EXACT wire names it expects. `captureAllowed` and
/// `biometricAllowed` are the two the gate requires; the other two are recorded
/// as the user chose them (defaults deny export, allow memory promotion off).
struct OwnerEnrollmentConsent: Equatable {
    var captureAllowed: Bool
    var biometricAllowed: Bool
    var memoryPromotionAllowed: Bool
    var exportAllowed: Bool

    /// FAIL-CLOSED default: nothing is granted until the user explicitly opts in.
    static let denied = OwnerEnrollmentConsent(
        captureAllowed: false,
        biometricAllowed: false,
        memoryPromotionAllowed: false,
        exportAllowed: false
    )

    /// The two grants the consent gate REQUIRES before any enroll_owner submission.
    var satisfiesGate: Bool { captureAllowed && biometricAllowed }

    /// The `consent` object for the enroll_owner / add_enrollment_clip params, with
    /// the exact server keys.
    var jsonObject: [String: JSONValue] {
        [
            "captureAllowed": .bool(captureAllowed),
            "biometricAllowed": .bool(biometricAllowed),
            "memoryPromotionAllowed": .bool(memoryPromotionAllowed),
            "exportAllowed": .bool(exportAllowed),
        ]
    }
}

/// One recorded enrollment source: a registered audio artifact (preferred) or a
/// local audio path, with optional both-or-neither [startMs, endMs) and route.
/// `voicedMs` is the client's estimate of VOICED speech in this clip, used to
/// guide the user toward the server's >= 30s voiced floor before submitting.
struct OwnerEnrollmentSource: Equatable, Identifiable {
    let id: String
    var audioArtifactID: String?
    var audioPath: String?
    var startMs: Double?
    var endMs: Double?
    var route: String?
    /// Estimated VOICED speech duration (ms) for the guided-floor check.
    var voicedMs: Double

    init(
        id: String = UUID().uuidString,
        audioArtifactID: String? = nil,
        audioPath: String? = nil,
        startMs: Double? = nil,
        endMs: Double? = nil,
        route: String? = nil,
        voicedMs: Double
    ) {
        self.id = id
        self.audioArtifactID = audioArtifactID
        self.audioPath = audioPath
        self.startMs = startMs
        self.endMs = endMs
        self.route = route
        self.voicedMs = voicedMs
    }

    /// The `source` object for the enroll_owner `sources` array (and for
    /// add_enrollment_clip's single `source`). Keys match the server parser exactly:
    /// `audioArtifactId` / `audioPath` / `startMs` / `endMs` / `route`. `startMs`
    /// and `endMs` are emitted both-or-neither, matching the server's requirement.
    var jsonObject: [String: JSONValue] {
        var object: [String: JSONValue] = [:]
        object.setOptionalString("audioArtifactId", audioArtifactID)
        object.setOptionalString("audioPath", audioPath)
        if let startMs, let endMs {
            object["startMs"] = .number(startMs)
            object["endMs"] = .number(endMs)
        }
        object.setOptionalString("route", route)
        return object
    }
}

/// Pure param assembly for the two enrollment RPCs, kept free of the model so it
/// can be exercised directly in tests.
enum LiveVoiceprintEnrollmentRequest {
    /// `identity.voiceprint.enroll_owner` params. `sources` is NON-EMPTY (the
    /// caller guarantees at least one). `consent` carries the exact keys.
    static func enrollOwnerParams(
        sessionKey: String?,
        sources: [OwnerEnrollmentSource],
        consent: OwnerEnrollmentConsent,
        minSpeechMs: Double? = nil
    ) -> [String: JSONValue] {
        var params: [String: JSONValue] = [
            "sources": .array(sources.map { .object($0.jsonObject) }),
            "consent": .object(consent.jsonObject),
        ]
        params.setOptionalString("sessionKey", sessionKey)
        if let minSpeechMs {
            params["minSpeechMs"] = .number(minSpeechMs)
        }
        return params
    }

    /// `identity.voiceprint.enroll_owner_from_recording` params: the ordered base
    /// ids of the live listening sessions ("takes") to enroll together (e.g.
    /// "live-20260712-135209", the base of the uploaded `.segNNN.mic` segments)
    /// plus the same consent object. The server accepts 1..10 DISTINCT ids under
    /// the `recordingBaseIds` wire key; the stop/continue flow accumulates one
    /// per listening session.
    static func enrollOwnerFromRecordingParams(
        sessionKey: String?,
        recordingBaseIds: [String],
        consent: OwnerEnrollmentConsent,
        minSpeechMs: Double? = nil
    ) -> [String: JSONValue] {
        var params: [String: JSONValue] = [
            "recordingBaseIds": .array(recordingBaseIds.map { .string($0) }),
            "consent": .object(consent.jsonObject),
        ]
        params.setOptionalString("sessionKey", sessionKey)
        if let minSpeechMs {
            params["minSpeechMs"] = .number(minSpeechMs)
        }
        return params
    }

    /// `identity.voiceprint.add_enrollment_clip` params: a single `source`.
    static func addEnrollmentClipParams(
        sessionKey: String?,
        source: OwnerEnrollmentSource,
        consent: OwnerEnrollmentConsent,
        minSpeechMs: Double? = nil
    ) -> [String: JSONValue] {
        var params: [String: JSONValue] = [
            "source": .object(source.jsonObject),
            "consent": .object(consent.jsonObject),
        ]
        params.setOptionalString("sessionKey", sessionKey)
        if let minSpeechMs {
            params["minSpeechMs"] = .number(minSpeechMs)
        }
        return params
    }
}

/// Explicit enrollment states. `needsConsent` and `tooShort` are the two gates
/// that block a submission; nothing leaves the device in those states.
/// Upload/registration status of one captured source. A source starts `pending`
/// while its WAV is uploaded+registered in the background, becomes `uploaded` once
/// it is artifact-backed on the gateway, or `failed` if the upload could not be
/// finalized (in which case the local-path fallback source is enrolled as-is).
///
/// CORRECTNESS: `enroll_owner` can only resolve a source the gateway can see, so the
/// Enroll action must wait for every `pending` source before submitting.
enum OwnerEnrollmentUploadState: Equatable {
    case pending
    case uploaded
    case failed
}

enum OwnerEnrollmentState: Equatable {
    case idle
    case recording
    /// A source (or sources) is captured but the user has not granted the required
    /// biometric + capture consent. FAIL-CLOSED: nothing is submitted here.
    case needsConsent
    /// Consent is granted but the recorded VOICED speech is below the guided floor.
    /// Surface a "record more" prompt rather than letting the server reject.
    case tooShort
    case submitting
    case enrolled(LiveVoiceprintEnrollmentResult)
    case failed(String)
}

@MainActor
final class OwnerEnrollmentModel: ObservableObject {
    /// The guided VOICED-speech floor, in ms. The server clamps to a >= 30s VOICED
    /// floor the client cannot lower, and the sidecar counts VOICED duration at
    /// ~74% of clip length, so a >= 30s voiced target means guiding the user to
    /// record MORE than 30s of wall-clock audio. We use a small margin above 30s so
    /// a clip that just clears the client estimate still clears the server floor.
    nonisolated static let guidedVoicedFloorMs: Double = 32_000

    /// Fraction of listening wall-clock time counted as VOICED speech. Mirrors
    /// OwnerEnrollmentRecorder.voicedFraction (the server sidecar's ~74% voiced
    /// estimate) so the client's live progress tracks the server's VOICED floor.
    nonisolated static let voicedFraction: Double = 0.74

    /// The server's hard VOICED floor for enrollment (ms). The gateway clamps
    /// `minSpeechMs` to >= 30s, so the listening flow guides against exactly this
    /// value: at ~74% voiced fraction it means listening for ~40s of wall clock.
    /// The from-recording rejection's `speechMs` is measured against this floor
    /// to compute the "keep talking ~N more seconds" hint.
    nonisolated static let serverVoicedFloorMs: Double = 30_000

    /// The gateway rejects submissions with more than this many takes
    /// (enroll_owner_from_recording accepts 1..10 recordingBaseIds). The model
    /// enforces the same bound so the UI blocks an 11th take with honest copy
    /// instead of every submit failing with a generic transport error.
    nonisolated static let maxTakes = 10

    @Published private(set) var state: OwnerEnrollmentState = .idle
    @Published private(set) var sources: [OwnerEnrollmentSource] = []
    /// Per-source upload state, keyed by `OwnerEnrollmentSource.id`. A source is
    /// `pending` from the moment it is recorded until its background upload finishes
    /// (`uploaded`) or fails (`failed`). Drives the "finishing upload…" hint and,
    /// critically, gates Enroll: no submission while any source is `pending`.
    @Published private(set) var uploadStates: [String: OwnerEnrollmentUploadState] = [:]
    /// Explicit in-flow biometric consent. FAIL-CLOSED: starts fully denied. The
    /// UI toggles set `biometricAllowed`/`captureAllowed`; the flow refuses to
    /// submit until both are true.
    @Published var consent: OwnerEnrollmentConsent = .denied
    /// Existing owner-template status queried from the gateway on appear. nil =
    /// not yet queried / unknown; `.enrolled == false` = first-time flow;
    /// `.enrolled == true` = show the "already enrolled" summary + re-enroll CTA.
    @Published private(set) var existingEnrollment: LiveVoiceprintOwnerTemplateStatus?

    // MARK: - Listening-session flow state (enroll from a live recording)

    /// True while a silent live listening session is running (the store owns the
    /// actual session; this mirrors it for the UI + gate logic).
    @Published private(set) var isListening = false
    /// Wall-clock time of the IN-PROGRESS take only (ms). Advanced by a
    /// main-actor timer while listening (mirrors OwnerEnrollmentRecorder's
    /// elapsed counter — UI only, never the audio thread) and folded into
    /// `takeElapsedMs` when the take is committed on stop.
    @Published private(set) var listeningElapsedMs: Double = 0
    /// Ordered base ids of every captured take (e.g. "live-20260712-135209" —
    /// the base of the `.segNNN.mic` segments each listening session uploaded).
    /// Takes ACCUMULATE across stop/continue — "Continue recording" keeps what
    /// was recorded and adds to it — and `submitFromRecording()` enrolls them
    /// ALL together via `recordingBaseIds`. Only "Start over" / reset discards.
    @Published private(set) var capturedRecordingBaseIds: [String] = []
    /// Wall-clock duration (ms) of each captured take, parallel to
    /// `capturedRecordingBaseIds`. Feeds the client-side voiced estimate for
    /// takes the server has not counted yet. Always mutated alongside the
    /// published take list, so the UI republishes with it.
    private(set) var takeElapsedMs: [Double] = []
    /// SERVER-counted voiced speech (ms) from the last `not_enough_speech`
    /// rejection — the authoritative anchor the progress row is rebuilt on. It
    /// REPLACES the client estimates of the takes it counted (the first
    /// `takeCountAtLastRejection` takes); only takes recorded AFTER the
    /// rejection still contribute client estimates. Cleared on accept / reset.
    @Published private(set) var serverCountedSpeechMs: Double?
    /// How many leading takes `serverCountedSpeechMs` covers: the take count at
    /// the moment the server rejected. Takes at index >= this are newer than
    /// the anchor and keep their client estimates.
    private(set) var takeCountAtLastRejection: Int = 0

    private var listeningTimer: Timer?
    private var listeningStartedAt: Date?

    private let gateway: VoiceprintEnrollmentGateway
    private let sessionKey: String
    /// The guided VOICED floor this model enforces (ms). Exposed read-only so the UI
    /// can render a live "enough speech" threshold against the same value.
    let voicedFloorMs: Double

    init(
        gateway: VoiceprintEnrollmentGateway,
        sessionKey: String,
        voicedFloorMs: Double = OwnerEnrollmentModel.guidedVoicedFloorMs
    ) {
        self.gateway = gateway
        self.sessionKey = sessionKey
        self.voicedFloorMs = voicedFloorMs
    }

    /// Query the gateway for an existing owner template so the UI can show an
    /// "already enrolled" summary instead of a blank first-time flow. Best-effort:
    /// a nil result (offline / inert gateway / transport failure) simply leaves
    /// the first-time flow in place. Safe to call repeatedly (e.g. on appear and
    /// after a successful enroll).
    func loadEnrollmentStatus() async {
        let status = await gateway.fetchOwnerTemplateStatus(
            sessionKey: sessionKey,
            timeoutSeconds: 15
        )
        if let status {
            existingEnrollment = status
        }
    }

    /// Total estimated VOICED speech across all captured sources (ms).
    var totalVoicedMs: Double {
        sources.reduce(0) { $0 + $1.voicedMs }
    }

    /// Whether the captured audio clears the guided VOICED floor.
    var hasEnoughSpeech: Bool {
        totalVoicedMs >= voicedFloorMs
    }

    /// Remaining VOICED speech to record before the guided floor is met (ms, >= 0).
    var remainingVoicedMs: Double {
        max(0, voicedFloorMs - totalVoicedMs)
    }

    /// Whether any recorded source is still uploading. Enroll must not submit while
    /// true — a `pending` source is not yet resolvable on the gateway.
    var hasPendingUploads: Bool {
        uploadStates.values.contains(.pending)
    }

    /// Continuations parked in `awaitPendingUploads()` while uploads are in flight,
    /// resumed once no source is `pending`. Non-published: internal bookkeeping only.
    private var pendingUploadWaiters: [CheckedContinuation<Void, Never>] = []

    // MARK: - Recording lifecycle (UI-driven)

    /// Enter the recording state. Recording owner voice for enrollment is only ever
    /// begun from an explicit user action; it does not start on its own.
    func beginRecording() {
        state = .recording
    }

    /// Record a captured source and re-evaluate the gate. The recorder produces a
    /// registered audio artifact (or a local path) plus a VOICED-speech estimate.
    ///
    /// `uploadState` marks whether the source still needs a background upload before it
    /// can be enrolled. Defaults to `.uploaded` so existing callers/tests that hand in
    /// an already-artifact-backed source do not enter the pending-upload gate.
    func addRecordedSource(
        _ source: OwnerEnrollmentSource,
        uploadState: OwnerEnrollmentUploadState = .uploaded
    ) {
        sources.append(source)
        uploadStates[source.id] = uploadState
        refreshGateState()
    }

    /// Upgrade an already-recorded source in place once its background upload finishes.
    /// Preserves array position and marks the source `uploaded`. If the id is unknown
    /// (e.g. reset during upload) this is a no-op. Resumes any Enroll waiter that is
    /// blocked on pending uploads once none remain.
    func markSourceUploaded(id: String, upgraded: OwnerEnrollmentSource) {
        // No-op if the source was cleared (e.g. reset() during upload): do not
        // resurrect a phantom upload-state entry for a clip that no longer exists.
        guard uploadStates[id] != nil else { return }
        if let index = sources.firstIndex(where: { $0.id == id }) {
            sources[index] = upgraded
        }
        uploadStates[id] = .uploaded
        refreshGateState()
        resumePendingWaitersIfSettled()
    }

    /// Mark a source's background upload as failed. The local-path fallback source
    /// stays in place (it can still enroll from the file on an accessible device), so
    /// this only flips the upload state and unblocks any Enroll waiter.
    func markSourceUploadFailed(id: String) {
        guard uploadStates[id] != nil else { return }
        uploadStates[id] = .failed
        refreshGateState()
        resumePendingWaitersIfSettled()
    }

    /// Suspend until no source is `pending`. Returns immediately when nothing is in
    /// flight. Used by `submit()` so Enroll never fires against an unresolved source.
    func awaitPendingUploads() async {
        guard hasPendingUploads else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            pendingUploadWaiters.append(continuation)
        }
    }

    /// Resume all parked Enroll waiters once no upload is `pending`.
    private func resumePendingWaitersIfSettled() {
        guard !hasPendingUploads, !pendingUploadWaiters.isEmpty else { return }
        let waiters = pendingUploadWaiters
        pendingUploadWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    /// Recording could not begin (mic permission denied or session/engine setup
    /// failed). Surface a clear message and leave the flow re-recordable — if the user
    /// already has sources, fall back to the gate state so prior work is not lost.
    func recordingFailed(_ message: String) {
        if sources.isEmpty {
            state = .failed(message)
        } else {
            refreshGateState()
        }
    }

    /// Discard all captured sources and reset to idle (does not touch consent so the
    /// user's opt-in choice survives a re-record). Clears upload tracking, EVERY
    /// captured take, the server-count anchor, and unblocks any parked Enroll
    /// waiter so it does not hang after a reset. This is the "Start over" action —
    /// the ONLY path that discards accumulated takes.
    func reset() {
        sources.removeAll()
        uploadStates.removeAll()
        capturedRecordingBaseIds.removeAll()
        takeElapsedMs.removeAll()
        serverCountedSpeechMs = nil
        takeCountAtLastRejection = 0
        listeningElapsedMs = 0
        state = .idle
        resumePendingWaitersIfSettled()
    }

    /// Recompute the blocking state after a source / capture / consent change. Never
    /// advances past a gate on its own — `submit()` / `submitFromRecording()` are the
    /// only paths to the gateway.
    func refreshGateState() {
        switch state {
        case .submitting, .enrolled:
            // Do not stomp a terminal/in-flight state.
            return
        default:
            break
        }
        // A running listening session IS the recording state — consent toggles etc.
        // must not knock the flow back to idle while Hawky is still listening.
        if isListening {
            state = .recording
            return
        }
        // Listening-session flow: captured live takes gate on the SAME consent,
        // then on the server's voiced floor applied to the accumulated progress
        // (server anchor + client estimates). (The clip-based `sources` flow
        // below is untouched.)
        if !capturedRecordingBaseIds.isEmpty, sources.isEmpty {
            if !consent.satisfiesGate {
                state = .needsConsent
                return
            }
            if !hasEnoughListeningSpeech {
                state = .tooShort
                return
            }
            state = .recording
            return
        }
        guard !sources.isEmpty else {
            state = .idle
            return
        }
        if !consent.satisfiesGate {
            state = .needsConsent
            return
        }
        if !hasEnoughSpeech {
            state = .tooShort
            return
        }
        // Ready — but do NOT submit here. Leave in recording so the UI's explicit
        // submit button owns the transition to the gateway.
        state = .recording
    }

    // MARK: - Submission (fail-closed consent gate)

    /// Submit `enroll_owner`. Returns the parsed result, or nil if the submission
    /// was BLOCKED (no sources, consent not granted, or too little speech) or the
    /// transport failed. The consent gate is the core invariant: enroll_owner is
    /// NEVER sent unless `biometricAllowed == true` AND `captureAllowed == true`.
    @discardableResult
    func submit(minSpeechMs: Double? = nil) async -> LiveVoiceprintEnrollmentResult? {
        // 1. Must have at least one recorded source (server requires NON-EMPTY sources).
        guard !sources.isEmpty else {
            state = .idle
            return nil
        }
        // 2. FAIL-CLOSED consent gate. Withholding consent leaves the flow in
        //    needsConsent and submits NOTHING. Never enroll silently.
        guard consent.satisfiesGate else {
            state = .needsConsent
            return nil
        }
        // 3. Guided VOICED-speech floor. Block below the floor and surface tooShort
        //    rather than letting the server reject.
        guard hasEnoughSpeech else {
            state = .tooShort
            return nil
        }
        // 4. CORRECTNESS: enroll_owner can only resolve a source the gateway can see.
        //    Wait for every in-flight background upload before submitting so we never
        //    enroll against a still-uploading source. (The UI also disables Enroll
        //    while uploads are pending; this await is the belt to that suspenders.)
        state = .submitting
        // Wait out EVERY in-flight upload, including any that began while we were parked,
        // so a still-uploading (local-path) source can never reach enroll_owner.
        while hasPendingUploads {
            await awaitPendingUploads()
        }

        // Re-check the gates after the await: a reset (or a failed upload dropping the
        // voiced total below the floor) could have changed the picture while we waited.
        guard !sources.isEmpty else {
            state = .idle
            return nil
        }
        guard consent.satisfiesGate else {
            state = .needsConsent
            return nil
        }
        guard hasEnoughSpeech else {
            state = .tooShort
            return nil
        }
        let params = LiveVoiceprintEnrollmentRequest.enrollOwnerParams(
            sessionKey: sessionKey,
            sources: sources,
            consent: consent,
            minSpeechMs: minSpeechMs
        )
        let result = await gateway.enrollVoiceprintOwner(
            sessionKey: sessionKey,
            params: params,
            timeoutSeconds: 30
        )
        guard let result else {
            state = .failed("Could not reach the Hawky gateway to enroll your voice.")
            return nil
        }
        if result.accepted {
            state = .enrolled(result)
        } else {
            let detail = result.reasons.first ?? "Enrollment was not accepted (\(result.status ?? "unknown"))."
            state = .failed(detail)
        }
        return result
    }

    // MARK: - Listening-session flow (enroll from a live recording)

    /// The ONE speech-progress number every UI surface renders (ms). Built from:
    /// - the SERVER-counted voiced ms of the last `not_enough_speech` rejection,
    ///   which REPLACES the client estimates of the takes it counted (the first
    ///   `takeCountAtLastRejection` takes), plus
    /// - the client estimate (wall clock × ~0.74 voiced fraction) of any takes
    ///   recorded AFTER that rejection, plus
    /// - the in-progress take while listening.
    /// Guidance only until submit — the server's count stays authoritative.
    var speechProgressMs: Double {
        let anchoredTakeCount = serverCountedSpeechMs != nil ? takeCountAtLastRejection : 0
        let unanchoredElapsedMs = takeElapsedMs
            .dropFirst(min(anchoredTakeCount, takeElapsedMs.count))
            .reduce(0, +)
        return (serverCountedSpeechMs ?? 0)
            + (unanchoredElapsedMs + listeningElapsedMs) * Self.voicedFraction
    }

    /// Whether the accumulated speech progress clears the server floor.
    var hasEnoughListeningSpeech: Bool {
        speechProgressMs >= Self.serverVoicedFloorMs
    }

    /// Seconds of extra TALKING (voiced speech) still needed before the floor is
    /// met. Computed from the same accumulated progress the row renders, so a
    /// server rejection's exact count automatically drives the hint.
    var keepTalkingSeconds: Int {
        Int((max(0, Self.serverVoicedFloorMs - speechProgressMs) / 1000).rounded(.up))
    }

    /// True when the gateway's take bound is reached: no further takes may be
    /// recorded — the user must enroll what they have or start over. The view
    /// disables Continue recording with honest copy on this.
    var atTakeLimit: Bool {
        capturedRecordingBaseIds.count >= Self.maxTakes
    }

    /// Whether "Enroll my voice" may submit the captured takes: same fail-closed
    /// consent gate as the clip flow, plus at least one captured take, progress
    /// clearing the guided floor, and no take still being listened to.
    var canSubmitFromRecording: Bool {
        !capturedRecordingBaseIds.isEmpty
            && consent.satisfiesGate
            && hasEnoughListeningSpeech
            && !isListening
    }

    /// Begin a silent live listening session (the store runs the actual session
    /// with temporary overrides; see LiveSessionStore.startEnrollmentListeningSession).
    /// GUARD: refuses when no gateway is configured — without one the uploaded
    /// segments can never reach the machine, so listening would be pointless.
    /// Returns whether listening actually began.
    @discardableResult
    func startListening(
        store: LiveSessionStore,
        recordingTransport: GatewayTransport? = nil,
        recordingTransportProvider: GatewayTransportResolver? = nil
    ) async -> Bool {
        guard !isListening else { return true }
        // The gateway rejects >maxTakes ids outright; refusing here keeps the
        // user's audio instead of letting an 11th take doom every submit.
        guard !atTakeLimit else { return false }
        guard store.voiceprintEnrollmentGateway() != nil else {
            state = .failed("Hawky gateway is not reachable — connect first to enroll.")
            return false
        }
        // "Continue recording": captured takes and the server-count anchor are
        // KEPT — this session opens a fresh recording that accumulates on top.
        // Only the in-progress counter restarts; reset() is the discard path.
        listeningElapsedMs = 0
        state = .recording
        let started = await store.startEnrollmentListeningSession(
            recordingTransport: recordingTransport,
            recordingTransportProvider: recordingTransportProvider
        )
        guard started else {
            state = .failed("Could not start the listening session. Check the microphone permission and try again.")
            return false
        }
        isListening = true
        listeningStartedAt = Date()
        startListeningTimer()
        return true
    }

    /// Stop the listening session: capture the recording base id, tear the live
    /// session down (the store restores every temporary override), and re-evaluate
    /// the gates. Safe to call when not listening (no-op).
    func stopListening(store: LiveSessionStore) async {
        guard isListening else { return }
        isListening = false
        stopListeningTimer()
        let measuredMs = listeningStartedAt.map { Date().timeIntervalSince($0) * 1000 } ?? listeningElapsedMs
        listeningStartedAt = nil
        let baseID = await store.stopEnrollmentListeningSession()
        recordListeningCapture(recordingBaseId: baseID, elapsedMs: measuredMs)
    }

    /// Commit a finished listening take and re-evaluate the gates. Split out of
    /// `stopListening(store:)` so the flow is unit-testable without a live session.
    /// The take APPENDS to the captured list — earlier takes are never discarded
    /// here. A nil base id means the recording never opened (mic warm-up failure)
    /// — surface that as a clear failure (prior takes stay enrollable) instead of
    /// a dead-end idle state.
    func recordListeningCapture(recordingBaseId: String?, elapsedMs: Double) {
        // The take is committed (or dropped), so the in-progress counter must
        // stop contributing to speechProgressMs — its time now lives (or dies)
        // with the take entry.
        listeningElapsedMs = 0
        guard let recordingBaseId, !recordingBaseId.isEmpty else {
            state = .failed("No audio was captured — try again.")
            return
        }
        // Dedupe guard: the store's base-id accessor falls back to the LAST
        // recording's URL, so a session whose recording never opened could
        // re-yield a take already captured. The server requires distinct ids
        // (a duplicate would double-enroll the same audio), and its segments —
        // and estimate — are already counted, so drop the repeat entirely.
        guard !capturedRecordingBaseIds.contains(recordingBaseId) else {
            refreshGateState()
            return
        }
        capturedRecordingBaseIds.append(recordingBaseId)
        takeElapsedMs.append(max(0, elapsedMs))
        refreshGateState()
    }

    /// Submit `enroll_owner_from_recording` for ALL captured takes together, in
    /// the order they were recorded. Same FAIL-CLOSED consent gate as `submit()`:
    /// the RPC is NEVER sent unless `biometricAllowed && captureAllowed`. Returns
    /// the parsed result, or nil if the submission was blocked (still listening /
    /// no capture / no consent / too little speech) or the transport failed.
    @discardableResult
    func submitFromRecording(minSpeechMs: Double? = nil) async -> LiveVoiceprintEnrollmentResult? {
        // 1. The listening session must be fully stopped — its final segments only
        //    finish uploading on stop, so submitting mid-listen would enroll a
        //    truncated recording.
        guard !isListening else { return nil }
        // 2. Must have at least one captured take to enroll from.
        guard !capturedRecordingBaseIds.isEmpty else {
            state = .idle
            return nil
        }
        // 3. FAIL-CLOSED consent gate (identical to submit()). Withholding consent
        //    leaves the flow in needsConsent and submits NOTHING.
        guard consent.satisfiesGate else {
            state = .needsConsent
            return nil
        }
        // 4. Guided floor: block a capture the server would certainly reject and
        //    surface tooShort with a "keep talking" hint instead.
        guard hasEnoughListeningSpeech else {
            state = .tooShort
            return nil
        }
        state = .submitting
        let params = LiveVoiceprintEnrollmentRequest.enrollOwnerFromRecordingParams(
            sessionKey: sessionKey,
            recordingBaseIds: capturedRecordingBaseIds,
            consent: consent,
            minSpeechMs: minSpeechMs
        )
        // Longer budget than enroll_owner: the gateway resolves + embeds every
        // selected segment before answering.
        let result = await gateway.enrollVoiceprintOwnerFromRecording(
            sessionKey: sessionKey,
            params: params,
            timeoutSeconds: 60
        )
        guard let result else {
            state = .failed("Could not reach the Hawky gateway to enroll your voice.")
            return nil
        }
        if result.accepted {
            // The takes are now IN the template: clear them (and the anchor) so
            // the post-success screen cannot re-enroll the same audio or stack
            // new takes onto already-enrolled ones. A later re-enroll starts
            // fresh, exactly like the already-enrolled banner frames it.
            capturedRecordingBaseIds.removeAll()
            takeElapsedMs.removeAll()
            serverCountedSpeechMs = nil
            takeCountAtLastRejection = 0
            state = .enrolled(result)
        } else if result.reasons.contains("not_enough_speech") {
            // The takes uploaded fine but did not contain 30s of VOICED speech.
            // Anchor progress on the SERVER-counted speechMs — it replaces the
            // client estimates of every take counted so far (Continue-recording
            // takes after this rejection estimate on top of it) — and KEEP all
            // takes: tooShort is actionable ("Continue recording"), not terminal.
            // A rejection payload without speechMs (parse anomaly) leaves the
            // client estimates in place: anchoring ALL takes at 0 would show
            // "0s / 30s" despite real captured audio.
            if let serverSpeechMs = result.speechMs {
                serverCountedSpeechMs = serverSpeechMs
                takeCountAtLastRejection = capturedRecordingBaseIds.count
            }
            state = .tooShort
        } else {
            state = .failed(Self.recordingFailureMessage(for: result))
        }
        return result
    }

    /// Actionable copy for a non-accepted `enroll_owner_from_recording` result
    /// (not_enough_speech is routed to `.tooShort` before this is consulted).
    nonisolated static func recordingFailureMessage(for result: LiveVoiceprintEnrollmentResult) -> String {
        if result.reasons.contains("quality_rejected") {
            return "Too noisy — try somewhere quieter."
        }
        if result.reasons.contains("no_usable_segments") {
            return "Upload didn't complete — try again."
        }
        return result.reasons.first ?? "Enrollment was not accepted (\(result.status ?? "unknown"))."
    }

    // MARK: - Listening timer (live UI counter, main-actor only)

    /// 0.1s main-actor timer publishing `listeningElapsedMs` while listening —
    /// the same pattern as OwnerEnrollmentRecorder's elapsed counter. Drives ONLY
    /// the UI progress line; it never touches audio.
    private func startListeningTimer() {
        listeningTimer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isListening, let started = self.listeningStartedAt else { return }
                self.listeningElapsedMs = Date().timeIntervalSince(started) * 1000
            }
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        listeningTimer = timer
    }

    private func stopListeningTimer() {
        listeningTimer?.invalidate()
        listeningTimer = nil
    }
}
