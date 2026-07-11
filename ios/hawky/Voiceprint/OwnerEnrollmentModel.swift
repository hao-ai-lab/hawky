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
    /// user's opt-in choice survives a re-record). Clears upload tracking and unblocks
    /// any parked Enroll waiter so it does not hang after a reset.
    func reset() {
        sources.removeAll()
        uploadStates.removeAll()
        state = .idle
        resumePendingWaitersIfSettled()
    }

    /// Recompute the blocking state after a source or consent change. Never advances
    /// past a gate on its own — `submit()` is the only path to the gateway.
    func refreshGateState() {
        switch state {
        case .submitting, .enrolled:
            // Do not stomp a terminal/in-flight state.
            return
        default:
            break
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
}
