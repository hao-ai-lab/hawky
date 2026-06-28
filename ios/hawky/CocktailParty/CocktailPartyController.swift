import Foundation

// =============================================================================
// CocktailPartyController — Live-session glue for Cocktail Party Mode (#627).
//
// Owns the per-session CocktailPartyRecognizer and turns RecognitionEvents into
// actions: known person → inject silent context; new person → inject context telling
// the model to learn + name them (via update_person_profile). DeepFace owns the DB,
// so there is no on-device store here. Side effects are injected closures so this
// stays decoupled + testable.
// =============================================================================

@MainActor
final class CocktailPartyController {
    private let recognizer: CocktailPartyRecognizer
    private var isActive = false

    /// Inject hidden context for the model WITHOUT triggering a response.
    var injectContext: ((_ text: String) async -> Void)?
    var log: ((_ text: String) -> Void)?

    init(recognizer: CocktailPartyRecognizer) {
        self.recognizer = recognizer
    }

    func start() {
        isActive = true
        recognizer.resetSessionState()
    }

    func stop() { isActive = false }

    func updateConfig(_ config: CocktailPartyConfig) { recognizer.updateConfig(config) }

    /// Feed one camera frame. No-op when inactive. Never throws.
    func handleFrame(_ jpeg: Data) async {
        guard isActive else { return }
        for event in await recognizer.process(jpeg: jpeg) {
            await handle(event)
        }
    }

    /// On-demand identify (identify_person tool): who is on camera? Picks the best of
    /// the recent frames locally, then ONE server call. Preserves suppressed results
    /// so rejected candidates are not described as new people.
    func identifyResult(amongFrames frames: [Data]) async -> FaceIdentifyResult {
        await recognizer.identifyOnlyResult(amongFrames: frames)
    }

    /// Compatibility helper for call sites that only need a matched person.
    func identify(amongFrames frames: [Data]) async -> LivePerson? {
        await recognizer.identifyOnly(amongFrames: frames)
    }

    /// Resolve the person on camera for a profile write across recent frames (one
    /// server call): identify, enroll under `name`, or preserve a suppressed face.
    func resolvePersonResult(amongFrames frames: [Data], name: String?) async -> FaceIdentifyResult {
        await recognizer.resolveOrEnrollResult(amongFrames: frames, name: name)
    }

    /// Compatibility helper for call sites that only need a matched/enrolled person.
    func resolvePerson(amongFrames frames: [Data], name: String?) async -> LivePerson? {
        await recognizer.resolveOrEnroll(amongFrames: frames, name: name)
    }

    private func handle(_ event: RecognitionEvent) async {
        // Background recognition is SILENT by design: it never volunteers a spoken
        // "quick aside" (that was the over-narration + it collided with active
        // responses). It only injects silent context so the model knows who's on
        // camera WHEN THE USER ASKS (identify_person speaks the answer on demand).
        switch event {
        case let .knownPerson(person):
            guard !person.name.isEmpty, person.name.lowercased() != "unknown" else { return }
            let recap = person.lastRecap.map { " Last time: \($0)." } ?? ""
            let facts = person.facts.isEmpty ? "" : " Known facts: \(person.facts.prefix(3).joined(separator: "; "))."
            log?("Recognized \(person.name) (silent)")
            await injectContext?(
                "FYI (do not say this unless asked): the person currently on camera is "
                + "\(person.name).\(facts)\(recap)"
            )

        case let .newPerson(person):
            log?("New face — provisional id \(person.id.prefix(8))")
            await injectContext?(
                "FYI (do not announce this): a new, unrecognized person is on camera "
                + "(provisional id \(person.id)). If the user tells you their name, call "
                + "update_person_profile with id \"\(person.id)\" and the name. Don't interrupt to ask."
            )
        }
    }
}
