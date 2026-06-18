import Foundation

// =============================================================================
// SafetyController — Live-session glue for Safety Check mode (#648).
//
// A SEPARATE silent pipeline behind the normal session: the store feeds camera
// frames here; the SafetyWatcher classifies them off the realtime model and gates
// hazards; on a real one, the controller surfaces ONE proactive spoken warning —
// the only time Safety Check speaks. The conversation is otherwise untouched.
// Side effects are injected closures so this stays decoupled + testable.
// =============================================================================

@MainActor
final class SafetyController {
    private let watcher: SafetyWatcher
    private var isActive = false

    /// Speak a proactive hazard warning to the user.
    var warn: ((_ text: String) async -> Void)?
    var log: ((_ text: String) -> Void)?

    /// - watcher: a watcher already configured with a classifier. The convenience
    ///   init below builds one from a classifier.
    init(watcher: SafetyWatcher) {
        self.watcher = watcher
    }

    /// Build with a classifier directly (production path).
    convenience init(watcher: SafetyWatcher? = nil, classifier: HazardClassifier, config: SafetyConfig = .default) {
        self.init(watcher: watcher ?? SafetyWatcher(classifier: classifier, config: config))
    }

    var active: Bool { isActive }

    func start() {
        isActive = true
        watcher.resetSessionState()
    }

    func stop() { isActive = false }

    func updateConfig(_ config: SafetyConfig) { watcher.updateConfig(config) }

    /// Feed one camera frame. No-op when inactive. Surfaces a warning only on a real,
    /// gated hazard. Never throws.
    func handleFrame(_ jpeg: Data) async {
        guard isActive else { return }
        if case let .hazard(a) = await watcher.process(jpeg: jpeg) {
            log?("Hazard (\(a.kind), \(a.severity)): \(a.warning)")
            await warn?(a.warning)
        }
    }
}
