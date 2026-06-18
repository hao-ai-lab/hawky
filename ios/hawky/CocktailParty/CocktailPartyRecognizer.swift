import Foundation

// =============================================================================
// CocktailPartyRecognizer — per-frame recognition brain (#627).
//
// DeepFace owns matching, so per frame this: crops faces on-device (FaceCropper),
// asks the service to identify each crop, enrolls unknowns, and applies dedup/
// cooldown so the same person doesn't emit recognition context every frame. All deps (cropper,
// client, clock, config) are injected so the flow is deterministic + testable.
// =============================================================================

/// The recognition service (DeepFace via the gateway). Injected so tests fake it.
protocol FaceRecognitionClient: Sendable {
    func identify(cropBase64: String) async -> LivePerson?
    func enroll(cropBase64: String, name: String) async -> LivePerson?
}

/// Production client: routes identify/enroll to the gateway's face tools (→ DeepFace)
/// through the live Hawky bridge.
struct BridgeFaceRecognitionClient: FaceRecognitionClient {
    let bridge: LiveGatewayBridge
    let sessionKey: String

    func identify(cropBase64: String) async -> LivePerson? {
        await bridge.identifyFace(imageBase64: cropBase64, sessionKey: sessionKey)
    }
    func enroll(cropBase64: String, name: String) async -> LivePerson? {
        await bridge.enrollFace(imageBase64: cropBase64, name: name, personId: nil, sessionKey: sessionKey)
    }
}

struct CocktailPartyConfig: Equatable {
    /// Don't re-emit the same known person within this window.
    var perPersonCooldown: TimeInterval = 120
    /// Process at most one frame per this interval (the stream may run several fps).
    var minFrameInterval: TimeInterval = 1.5
    /// After enrolling an unknown face, don't enroll another unknown for this long
    /// (dedup safety net against duplicate profiles for one person).
    var enrollCooldown: TimeInterval = 20

    static let `default` = CocktailPartyConfig()
}

/// What the recognizer decided for a frame — consumed by the controller.
enum RecognitionEvent: Equatable {
    /// A known person appeared (off cooldown): inject silent context.
    case knownPerson(person: LivePerson)
    /// A new face was enrolled: the model should learn who they are.
    case newPerson(person: LivePerson)
}

@MainActor
final class CocktailPartyRecognizer {
    private let cropper: FaceCropper
    private let client: FaceRecognitionClient
    private var config: CocktailPartyConfig
    private let clock: () -> Date

    /// personID → last time we emitted this known person.
    private var lastAnnounced: [String: Date] = [:]
    private var lastProcessedFrameAt: Date?
    /// Time of the last enroll of an UNKNOWN face. Within enrollCooldown we don't
    /// enroll another unknown — prevents the "6 profiles for one face" storm if the
    /// service briefly fails to match a just-enrolled person across frames.
    private var lastUnknownEnrollAt: Date?
    /// Guards against overlapping frame processing (identify is async + slow).
    private var inFlight = false

    init(
        cropper: FaceCropper,
        client: FaceRecognitionClient,
        config: CocktailPartyConfig = .default,
        clock: @escaping () -> Date = { Date() }
    ) {
        self.cropper = cropper
        self.client = client
        self.config = config
        self.clock = clock
    }

    func updateConfig(_ config: CocktailPartyConfig) { self.config = config }

    /// Locally (on-device Vision, no server) pick the first of `frames` (newest-first)
    /// that yields a usable face crop. Cheap — avoids issuing multiple slow gateway
    /// round-trips just to skip no-face frames.
    private func bestCrop(amongFrames frames: [Data]) async -> Data? {
        for jpeg in frames.reversed() {
            if let crop = await cropper.bestFaceCrop(in: jpeg) { return crop }
        }
        return nil
    }

    /// On-demand identify (identify_person tool). Picks the best recent frame LOCALLY,
    /// then does exactly ONE server identify — fast. Pure lookup, no enroll.
    func identifyOnly(amongFrames frames: [Data]) async -> LivePerson? {
        guard let crop = await bestCrop(amongFrames: frames) else { return nil }
        return await client.identify(cropBase64: crop.base64EncodedString())
    }

    /// Resolve the person on camera for a profile write: best local frame, then ONE
    /// server identify, else enroll (under `name`). One round-trip on the hot path.
    func resolveOrEnroll(amongFrames frames: [Data], name: String?) async -> LivePerson? {
        guard let crop = await bestCrop(amongFrames: frames) else { return nil }
        let base64 = crop.base64EncodedString()
        if let known = await client.identify(cropBase64: base64) { return known }
        return await client.enroll(cropBase64: base64, name: name?.isEmpty == false ? name! : "Unknown")
    }

    /// Single-frame variants (used by the per-frame background loop).
    func identifyOnly(jpeg: Data) async -> LivePerson? {
        guard let crop = await cropper.bestFaceCrop(in: jpeg) else { return nil }
        return await client.identify(cropBase64: crop.base64EncodedString())
    }

    func resolveOrEnroll(jpeg: Data, name: String?) async -> LivePerson? {
        guard let crop = await cropper.bestFaceCrop(in: jpeg) else { return nil }
        let base64 = crop.base64EncodedString()
        if let known = await client.identify(cropBase64: base64) { return known }
        return await client.enroll(cropBase64: base64, name: name?.isEmpty == false ? name! : "Unknown")
    }

    func resetSessionState() {
        lastAnnounced.removeAll()
        lastProcessedFrameAt = nil
        lastUnknownEnrollAt = nil
        inFlight = false
    }

    /// Process one JPEG frame. Returns events worth acting on (may be empty: no
    /// faces, rate-limited, or all on cooldown). Never throws.
    func process(jpeg: Data) async -> [RecognitionEvent] {
        let now = clock()
        if inFlight { return [] }
        if let last = lastProcessedFrameAt, now.timeIntervalSince(last) < config.minFrameInterval {
            return []
        }
        lastProcessedFrameAt = now
        inFlight = true
        defer { inFlight = false }

        // Send a well-framed, upscaled crop of the largest face (not the raw frame,
        // where the face is only 50–100px in a cluttered 640×360 image → weak
        // embeddings + fragmentation). The server still detects + quality-gates on it.
        guard let crop = await cropper.bestFaceCrop(in: jpeg) else { return [] }
        let base64 = crop.base64EncodedString()

        var events: [RecognitionEvent] = []
        // 1) Retrieve from the DB. Known → recall (off cooldown).
        if let known = await client.identify(cropBase64: base64) {
            if let last = lastAnnounced[known.id], clock().timeIntervalSince(last) < config.perPersonCooldown {
                return []
            }
            lastAnnounced[known.id] = clock()
            events.append(.knownPerson(person: known))
            return events
        }
        // 2) Unknown → enroll ONCE, then back off. The cooldown stops the same
        // unrecognized face from spawning a new profile every frame; once the service
        // can match the fresh enrollment, later frames take the known path. (The
        // service also de-dupes + quality-gates, so a bad frame just no-ops.)
        if let last = lastUnknownEnrollAt, clock().timeIntervalSince(last) < config.enrollCooldown {
            return []
        }
        if let enrolled = await client.enroll(cropBase64: base64, name: "Unknown") {
            lastUnknownEnrollAt = clock()
            lastAnnounced[enrolled.id] = clock()
            events.append(.newPerson(person: enrolled))
        }
        return events
    }
}
