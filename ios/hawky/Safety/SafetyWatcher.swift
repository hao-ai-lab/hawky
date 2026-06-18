import Foundation

// =============================================================================
// SafetyWatcher — silent hazard-watch brain for Safety Check mode (#648).
//
// Safety Check is a SEPARATE pipeline that runs behind the normal session: it
// samples camera frames, asks a HazardClassifier (off the realtime model — a gateway
// vision call) whether the scene is dangerous, and emits a warning ONLY for a
// genuine, high-enough-severity hazard, deduped by kind so a persistent flame isn't
// announced every frame. The realtime conversation is untouched (no polling
// response.create that would block the model). All deps injected → deterministic +
// testable without a camera or network.
// =============================================================================

enum HazardSeverity: Int, Comparable, Equatable {
    case none = 0
    case low = 1
    case medium = 2
    case high = 3

    static func < (lhs: HazardSeverity, rhs: HazardSeverity) -> Bool { lhs.rawValue < rhs.rawValue }

    init(label: String) {
        switch label.lowercased() {
        case "high", "critical", "danger": self = .high
        case "medium", "moderate": self = .medium
        case "low", "minor": self = .low
        default: self = .none
        }
    }
}

/// One hazard assessment of a frame.
struct HazardAssessment: Equatable {
    var severity: HazardSeverity
    /// Short hazard category/key used for dedup (e.g. "unattended_stove", "knife").
    var kind: String
    /// One-line spoken warning + suggested action.
    var warning: String

    static let safe = HazardAssessment(severity: .none, kind: "", warning: "")
}

/// Assesses whether a frame shows a hazard. Real impl is a gateway vision call (off
/// the realtime model); tests inject a deterministic fake.
protocol HazardClassifier: Sendable {
    func assess(jpeg: Data) async -> HazardAssessment
}

struct SafetyConfig: Equatable {
    /// Minimum severity that triggers a spoken warning. Below this → stay silent.
    var minSeverity: HazardSeverity = .medium
    /// Don't re-warn about the same hazard kind within this window.
    var perHazardCooldown: TimeInterval = 30
    /// Classify at most one frame per this interval. Set to ~1s so Safety Check runs
    /// at the camera's 1 fps (every frame is classified) for fast hazard detection.
    /// Slightly under 1.0 so a 1fps frame is never skipped by jitter. Raise it to cut
    /// vision-call cost; lower has no effect above the camera fps.
    var minFrameInterval: TimeInterval = 0.9

    static let `default` = SafetyConfig()
}

/// What the watcher decided for a frame.
enum SafetyEvent: Equatable {
    /// A hazard worth warning about (off cooldown, ≥ minSeverity).
    case hazard(HazardAssessment)
}

@MainActor
final class SafetyWatcher {
    private let classifier: HazardClassifier
    private var config: SafetyConfig
    private let clock: () -> Date

    private var lastWarnedKindAt: [String: Date] = [:]
    private var lastProcessedFrameAt: Date?
    private var inFlight = false

    init(
        classifier: HazardClassifier,
        config: SafetyConfig = .default,
        clock: @escaping () -> Date = { Date() }
    ) {
        self.classifier = classifier
        self.config = config
        self.clock = clock
    }

    func updateConfig(_ config: SafetyConfig) { self.config = config }

    func resetSessionState() {
        lastWarnedKindAt.removeAll()
        lastProcessedFrameAt = nil
        inFlight = false
    }

    /// Assess one frame (rate-limited). Returns a hazard event worth surfacing, or nil
    /// (safe scene, below severity, rate-limited, on cooldown, or overlapping). The
    /// classifier runs OFF the realtime model, so this never blocks the conversation.
    func process(jpeg: Data) async -> SafetyEvent? {
        let now = clock()
        if inFlight { return nil }
        if let last = lastProcessedFrameAt, now.timeIntervalSince(last) < config.minFrameInterval {
            return nil
        }
        lastProcessedFrameAt = now
        inFlight = true
        defer { inFlight = false }

        let assessment = await classifier.assess(jpeg: jpeg)
        return gate(assessment)
    }

    /// Severity gate + dedup for an assessment. Exposed for tests.
    func gate(_ assessment: HazardAssessment) -> SafetyEvent? {
        guard assessment.severity >= config.minSeverity, assessment.severity > .none else {
            return nil
        }
        let key = assessment.kind.isEmpty ? assessment.warning : assessment.kind
        if let last = lastWarnedKindAt[key], clock().timeIntervalSince(last) < config.perHazardCooldown {
            return nil
        }
        lastWarnedKindAt[key] = clock()
        return .hazard(assessment)
    }
}
