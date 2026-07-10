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
        if let audioArtifactID, !audioArtifactID.isEmpty {
            object["audioArtifactId"] = .string(audioArtifactID)
        }
        if let audioPath, !audioPath.isEmpty {
            object["audioPath"] = .string(audioPath)
        }
        if let startMs, let endMs {
            object["startMs"] = .number(startMs)
            object["endMs"] = .number(endMs)
        }
        if let route, !route.isEmpty {
            object["route"] = .string(route)
        }
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
        if let sessionKey, !sessionKey.isEmpty {
            params["sessionKey"] = .string(sessionKey)
        }
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
        if let sessionKey, !sessionKey.isEmpty {
            params["sessionKey"] = .string(sessionKey)
        }
        if let minSpeechMs {
            params["minSpeechMs"] = .number(minSpeechMs)
        }
        return params
    }
}

/// Explicit enrollment states. `needsConsent` and `tooShort` are the two gates
/// that block a submission; nothing leaves the device in those states.
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
    static let guidedVoicedFloorMs: Double = 32_000

    @Published private(set) var state: OwnerEnrollmentState = .idle
    @Published private(set) var sources: [OwnerEnrollmentSource] = []
    /// Explicit in-flow biometric consent. FAIL-CLOSED: starts fully denied. The
    /// UI toggles set `biometricAllowed`/`captureAllowed`; the flow refuses to
    /// submit until both are true.
    @Published var consent: OwnerEnrollmentConsent = .denied

    private let gateway: VoiceprintEnrollmentGateway
    private let sessionKey: String
    private let voicedFloorMs: Double

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

    // MARK: - Recording lifecycle (UI-driven)

    /// Enter the recording state. Recording owner voice for enrollment is only ever
    /// begun from an explicit user action; it does not start on its own.
    func beginRecording() {
        state = .recording
    }

    /// Record a captured source and re-evaluate the gate. The recorder produces a
    /// registered audio artifact (or a local path) plus a VOICED-speech estimate.
    func addRecordedSource(_ source: OwnerEnrollmentSource) {
        sources.append(source)
        refreshGateState()
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
    /// user's opt-in choice survives a re-record).
    func reset() {
        sources.removeAll()
        state = .idle
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

        state = .submitting
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
