import XCTest

struct TestSpec {
    enum BackendMode: String {
        case pureUI = "pure-ui"
        case mockSeed = "mock+seed"
        case liveIntegration = "live-integration"
    }

    struct Step {
        let action: String
        let expect: String
    }

    let id: String
    let title: String
    let purpose: String
    let screens: [String]
    let steps: [Step]
    let backendMode: BackendMode
    let seedProfile: String?

    init(
        id: String,
        title: String,
        purpose: String,
        screens: [String],
        steps: [Step],
        backendMode: BackendMode = .pureUI,
        seedProfile: String? = nil
    ) {
        self.id = id
        self.title = title
        self.purpose = purpose
        self.screens = screens
        self.steps = steps
        self.backendMode = backendMode
        self.seedProfile = seedProfile
    }

    func step(_ index: Int, file: StaticString = #filePath, line: UInt = #line) -> Step {
        guard steps.indices.contains(index) else {
            XCTFail("Missing step \(index) for \(id)", file: file, line: line)
            return .init(
                action: "Missing declared step \(index)",
                expect: "Update TestSpec for \(id) before relying on this report"
            )
        }
        return steps[index]
    }

    var markdown: String {
        var lines = [
            "# \(title)",
            "",
            "- id: \(id)",
            "- purpose: \(purpose)",
            "- screens: \(screens.joined(separator: ", "))",
            "- backend: \(backendMode.rawValue)",
            "- seed: \(seedProfile ?? "none")",
            "",
            "## Steps"
        ]
        for (index, step) in steps.enumerated() {
            lines.append("\(index + 1). \(step.action) -> \(step.expect)")
        }
        return lines.joined(separator: "\n")
    }
}

final class TestSpecRecorder {
    private weak var testCase: XCTestCase?
    private let spec: TestSpec
    private var stepIndex = 0

    init(testCase: XCTestCase, spec: TestSpec) {
        self.testCase = testCase
        self.spec = spec
    }

    func attachSpec() {
        ScreenManifest.shared.validate(spec: spec)
        let attachment = XCTAttachment(string: spec.markdown)
        attachment.name = "test-spec-\(spec.id)"
        attachment.lifetime = .keepAlways
        testCase?.add(attachment)
    }

    func record(step: TestSpec.Step, body: () -> Void) {
        stepIndex += 1
        var completed = false
        defer {
            attachStepResult(
                step,
                actual: completed
                    ? "step completed; see screenshot captured after this action"
                    : "step ended before completion; inspect failure details and screenshot"
            )
        }
        body()
        completed = true
    }

    func recordActivity(spec activitySpec: TestSpec, body: () -> Void) {
        ScreenManifest.shared.validate(spec: activitySpec)
        XCTContext.runActivity(named: activitySpec.title) { activity in
            attachActivitySpec(activitySpec, to: activity)
            var completed = false
            defer {
                attachActivityResult(
                    activitySpec,
                    to: activity,
                    actual: completed
                        ? "activity completed; see screenshot captured after this screen case"
                        : "activity ended before completion; inspect failure details and screenshot"
                )
            }
            body()
            completed = true
        }
    }

    private func attachStepResult(_ step: TestSpec.Step, actual: String) {
        let note = XCTAttachment(
            string: """
            action: \(step.action)
            expected: \(step.expect)
            actual: \(actual)
            """
        )
        note.name = "\(spec.id)-step-\(stepIndex)-expected-actual"
        note.lifetime = .keepAlways
        testCase?.add(note)

        let screenshot = XCUIScreen.main.screenshot()
        let image = XCTAttachment(screenshot: screenshot)
        image.name = "\(spec.id)-step-\(stepIndex)-screenshot"
        image.lifetime = .keepAlways
        testCase?.add(image)
    }

    private func attachActivitySpec(_ activitySpec: TestSpec, to activity: XCTActivity) {
        let attachment = XCTAttachment(string: activitySpec.markdown)
        attachment.name = "activity-\(attachmentID(for: activitySpec))-spec"
        attachment.lifetime = .keepAlways
        activity.add(attachment)
    }

    private func attachActivityResult(_ activitySpec: TestSpec, to activity: XCTActivity, actual: String) {
        let step = activitySpec.steps.first
        let note = XCTAttachment(
            string: """
            action: \(step?.action ?? activitySpec.title)
            expected: \(step?.expect ?? activitySpec.purpose)
            actual: \(actual)
            """
        )
        note.name = "activity-\(attachmentID(for: activitySpec))-expected-actual"
        note.lifetime = .keepAlways
        activity.add(note)

        let screenshot = XCUIScreen.main.screenshot()
        let image = XCTAttachment(screenshot: screenshot)
        image.name = "activity-\(attachmentID(for: activitySpec))-screenshot"
        image.lifetime = .keepAlways
        activity.add(image)
    }

    private func attachmentID(for spec: TestSpec) -> String {
        spec.id.replacingOccurrences(of: ".", with: "_")
    }
}
