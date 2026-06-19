import Foundation
import Testing
@testable import hawky

// =============================================================================
// Tests for Safety Check mode (#648). Safety Check is a SEPARATE silent pipeline:
// camera frames → HazardClassifier (off the realtime model) → SafetyWatcher gates
// (severity + dedup + rate-limit) → SafetyController surfaces ONE spoken warning,
// only on a real hazard. Fully deterministic — a FakeHazardClassifier returns
// canned assessments, so no camera/model/network is needed.
// =============================================================================

/// Deterministic classifier: returns the next queued assessment (or .safe). Records
/// how many frames it was asked to assess so tests can verify rate-limiting.
private final class FakeHazardClassifier: HazardClassifier, @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [HazardAssessment]
    private var fallback: HazardAssessment
    private(set) var calls = 0

    init(_ queue: [HazardAssessment] = [], fallback: HazardAssessment = .safe) {
        self.queue = queue
        self.fallback = fallback
    }

    func assess(jpeg: Data) async -> HazardAssessment {
        lock.lock(); defer { lock.unlock() }
        calls += 1
        return queue.isEmpty ? fallback : queue.removeFirst()
    }
}

private let frame = Data([0xFF, 0xD8, 0xFF])

@MainActor
@Suite struct SafetyWatcherTests {
    private func watcher(_ classifier: HazardClassifier, _ build: (inout SafetyConfig) -> Void = { _ in }, clock: @escaping () -> Date = { Date() }) -> SafetyWatcher {
        var cfg = SafetyConfig.default
        cfg.minSeverity = .medium
        build(&cfg)
        return SafetyWatcher(classifier: classifier, config: cfg, clock: clock)
    }

    @Test func belowMinSeverityIsSilent() {
        let w = watcher(FakeHazardClassifier())
        #expect(w.gate(HazardAssessment(severity: .low, kind: "clutter", warning: "messy")) == nil)
        #expect(w.gate(HazardAssessment(severity: .none, kind: "", warning: "")) == nil)
    }

    @Test func severeHazardSurfacesOnceThenAfterCooldown() {
        var now = Date(timeIntervalSince1970: 1000)
        let w = watcher(FakeHazardClassifier(), { $0.perHazardCooldown = 60 }, clock: { now })
        let h = HazardAssessment(severity: .high, kind: "unattended_stove", warning: "Stove is on, unattended.")

        if case let .hazard(a) = w.gate(h) { #expect(a.kind == "unattended_stove") }
        else { Issue.record("expected hazard event") }

        now = now.addingTimeInterval(10)
        #expect(w.gate(h) == nil)                  // within cooldown → suppressed

        now = now.addingTimeInterval(100)
        #expect(w.gate(h) != nil)                  // past cooldown → warns again
    }

    @Test func differentHazardKindsBothSurface() {
        let w = watcher(FakeHazardClassifier())
        #expect(w.gate(HazardAssessment(severity: .high, kind: "fire", warning: "Fire!")) != nil)
        #expect(w.gate(HazardAssessment(severity: .high, kind: "knife", warning: "Knife near the edge.")) != nil)
    }

    @Test func mediumThresholdLetsMediumThrough() {
        let w = watcher(FakeHazardClassifier())
        #expect(w.gate(HazardAssessment(severity: .medium, kind: "water_near_outlet", warning: "Water near the outlet.")) != nil)
    }

    @Test func processClassifiesAndGates() async {
        let fake = FakeHazardClassifier([HazardAssessment(severity: .high, kind: "fire", warning: "Fire!")])
        let w = watcher(fake)
        let event = await w.process(jpeg: frame)
        guard case let .hazard(a)? = event else { Issue.record("expected hazard"); return }
        #expect(a.kind == "fire")
        #expect(fake.calls == 1)
    }

    @Test func benignFrameStaysSilent() async {
        let fake = FakeHazardClassifier(fallback: .safe)
        let w = watcher(fake)
        #expect(await w.process(jpeg: frame) == nil)
    }

    @Test func rateLimitsRapidFrames() async {
        var now = Date(timeIntervalSince1970: 5000)
        let fake = FakeHazardClassifier(fallback: HazardAssessment(severity: .high, kind: "fire", warning: "Fire!"))
        let w = watcher(fake, { $0.minFrameInterval = 4.0; $0.perHazardCooldown = 0 }, clock: { now })

        _ = await w.process(jpeg: frame)           // assessed
        _ = await w.process(jpeg: frame)           // within interval → skipped, not classified
        #expect(fake.calls == 1)

        now = now.addingTimeInterval(5)            // past the frame interval
        _ = await w.process(jpeg: frame)
        #expect(fake.calls == 2)
    }

    @Test func severityParsing() {
        #expect(HazardSeverity(label: "high") == .high)
        #expect(HazardSeverity(label: "MEDIUM") == .medium)
        #expect(HazardSeverity(label: "minor") == .low)
        #expect(HazardSeverity(label: "nonsense") == .none)
    }
}

@MainActor
@Suite struct SafetyControllerTests {
    private func make(_ classifier: HazardClassifier, cooldown: TimeInterval = 60) -> (SafetyController, () -> [String]) {
        var cfg = SafetyConfig.default
        cfg.minSeverity = .medium
        cfg.perHazardCooldown = cooldown
        cfg.minFrameInterval = 0          // don't rate-limit in controller tests
        let controller = SafetyController(classifier: classifier, config: cfg)
        var warned: [String] = []
        controller.warn = { warned.append($0) }
        return (controller, { warned })
    }

    @Test func warnsOnHazardWhenActive() async {
        let fake = FakeHazardClassifier([HazardAssessment(severity: .high, kind: "fire", warning: "There's a fire — get out.")])
        let (controller, warned) = make(fake)
        controller.start()
        await controller.handleFrame(frame)
        #expect(warned() == ["There's a fire — get out."])
    }

    @Test func inactiveControllerIgnoresFrames() async {
        let fake = FakeHazardClassifier([HazardAssessment(severity: .high, kind: "fire", warning: "Fire!")])
        let (controller, warned) = make(fake)
        // not started
        await controller.handleFrame(frame)
        #expect(warned().isEmpty)
        #expect(fake.calls == 0)          // never even classifies when inactive
    }

    @Test func lowSeverityDoesNotWarn() async {
        let fake = FakeHazardClassifier([HazardAssessment(severity: .low, kind: "clutter", warning: "A bit messy.")])
        let (controller, warned) = make(fake)
        controller.start()
        await controller.handleFrame(frame)
        #expect(warned().isEmpty)
    }

    @Test func benignFramesNeverWarn() async {
        let fake = FakeHazardClassifier(fallback: .safe)
        let (controller, warned) = make(fake)
        controller.start()
        await controller.handleFrame(frame)
        await controller.handleFrame(frame)
        #expect(warned().isEmpty)
    }

    @Test func duplicateHazardDeduped() async {
        let h = HazardAssessment(severity: .high, kind: "stove", warning: "Stove on.")
        let fake = FakeHazardClassifier([h, h])
        let (controller, warned) = make(fake)
        controller.start()
        await controller.handleFrame(frame)
        await controller.handleFrame(frame)
        #expect(warned() == ["Stove on."])     // second is deduped within cooldown
    }
}

@MainActor
@Suite struct SafetyCheckPersistenceTests {
    @Test func defaultsOffAndPersists() {
        let d = UserDefaults(suiteName: "safety-test-\(UUID().uuidString)")!
        #expect(LiveProfileDefaults.load(defaults: d).safetyCheckEnabled == false)
        var c = LiveProfileDefaults.load(defaults: d)
        c.safetyCheckEnabled = true
        LiveProfileDefaults.save(c, defaults: d)
        #expect(LiveProfileDefaults.load(defaults: d).safetyCheckEnabled == true)
    }
}
