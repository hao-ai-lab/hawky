import XCTest

private enum UITestLaunch {
    static let argument = "--uitesting"
    static let onboardingArgument = "--uitesting-onboarding"
    static let firstRunIntroArgument = "--uitesting-first-run-intro"
    static let enabledEnvironmentKey = "IOS_UI_TESTING"
    static let tabsEnvironmentKey = "IOS_UI_TESTING_TABS"
    static let onboardingEnvironmentKey = "IOS_UI_TESTING_ONBOARDING"
    static let firstRunIntroEnvironmentKey = "IOS_UI_TESTING_FIRST_RUN_INTRO"
    static let liveMockEnvironmentKey = "IOS_UI_TESTING_LIVE_MOCK"
    static let liveProviderEnvironmentKey = "IOS_UI_TESTING_LIVE_PROVIDER"
    static let seedEnvironmentKey = "JC_SEED"
    static let enabledEnvironmentValue = "1"
}

private enum UITestTabLayout {
    static let primary = "live,chat,test,pipecat"
    static let secondary = "live2,pipecatRecording,gptrDemo,live"
}

private enum UITestSeed {
    static let sessionKey = "ios:main"
    static let sessionDisplayName = "main"
    static let chatPopulated = "chat-populated"
    static let mixed = "mixed"
    static let recordings = "recordings"
    static let error = "error"
    static let userBubbleIdentifier = "messageBubble.user.00000000-0000-0000-0000-000000000101"
    static let assistantBubbleIdentifier = "messageBubble.assistant.00000000-0000-0000-0000-000000000102"
    static let systemBubbleIdentifier = "messageBubble.system.00000000-0000-0000-0000-000000000103"
    static let userMessageText = "Seeded intake note for UI coverage."
    static let assistantMessageText = "Seeded assistant response with deterministic content."
    static let systemMessageText = "Seeded system notice for local UI mode."
    static let researchSessionKey = "ios:research"
    static let researchSessionDisplayName = "Research Notes"
    static let researchBubbleIdentifier = "messageBubble.assistant.00000000-0000-0000-0000-000000000202"
    static let researchMessageText = "Research session assistant answer."
    static let recordingFileName = "live-seed-ui-coverage.wav"
    static let recordingRowIdentifier = "recordings.history.row.live-seed-ui-coverage.wav"
    static let gatewayErrorText = "Seeded gateway error"
}

private enum UITestSpecs {
    static let launchesToLiveEmptyState = TestSpec(
        id: "launch.live.empty-state",
        title: "Deterministic launch shows Live empty state",
        purpose: "Verify the UI-test launch profile opens the app without persisted simulator state leaking into Live.",
        screens: ["live"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live opens without onboarding or intro"),
            .init(action: "Inspect Live empty state and primary tabs", expect: "Live empty state plus Live and Settings tabs are visible")
        ]
    )

    static let tabSwitchingShowsSettings = TestSpec(
        id: "tabs.settings.reachable",
        title: "Settings tab is reachable",
        purpose: "Verify the seeded tab bar can switch from Live to Settings.",
        screens: ["live", "settings"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live is the initial selected tab"),
            .init(action: "Tap Settings tab", expect: "Settings navigation root and Connection row appear")
        ]
    )

    static let liveControlsExposeStableIdentifiers = TestSpec(
        id: "live.controls.identifiers",
        title: "Live controls expose stable identifiers",
        purpose: "Verify the main Live controls can be selected by accessibility identifier.",
        screens: ["live"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live screen is available"),
            .init(action: "Inspect Live control identifiers", expect: "Agent, More, audio, visual, keyboard, and Start controls exist")
        ]
    )

    static let liveMockSessionCanStartAndStop = TestSpec(
        id: "live.mock.start-stop",
        title: "Mock Live session can start and stop",
        purpose: "Verify a connected in-session state through the mock Live provider.",
        screens: ["live"],
        steps: [
            .init(action: "Launch app with mock Live provider", expect: "Live screen is available with Start enabled"),
            .init(action: "Tap Start", expect: "Live enters an active state and Stop appears"),
            .init(action: "Tap Stop", expect: "Live returns to idle and Start appears")
        ],
        backendMode: .mockSeed
    )

    static let liveStartBlockedShowsAlert = TestSpec(
        id: "live.start.blocked-alert",
        title: "Blocked Live start explains itself",
        purpose: "Verify tapping Start with no OpenAI key pops the explanatory action alert instead of a disabled no-op.",
        screens: ["live"],
        steps: [
            .init(action: "Launch app with the default (non-mock) OpenAI provider and no saved key", expect: "Live opens with a tappable Start"),
            .init(action: "Tap Start", expect: "The can't-start alert appears with an Open Live Settings shortcut")
        ]
    )

    static let liveStartBlockedAlertOpensSettings = TestSpec(
        id: "live.start.blocked-alert.settings",
        title: "Blocked-start alert routes to Live Settings",
        purpose: "Verify the action alert's Open Live Settings button opens the Live settings sheet where the key is entered.",
        screens: ["live", "settings"],
        steps: [
            .init(action: "Launch app with the default (non-mock) OpenAI provider and no saved key", expect: "Live opens with a tappable Start"),
            .init(action: "Tap Start to surface the blocked alert", expect: "The can't-start alert appears"),
            .init(action: "Tap Open Live Settings", expect: "The Live settings form opens")
        ]
    )

    static let liveStartGeminiProviderShowsAlert = TestSpec(
        id: "live.start.gemini-blocked",
        title: "Unsupported provider explains itself on start",
        purpose: "Verify a not-yet-wired provider (Gemini) pops an acknowledge-only alert on Start — no Settings shortcut, since there's nothing to fix there.",
        screens: ["live"],
        steps: [
            .init(action: "Launch with the Live provider pinned to Gemini", expect: "Live opens with a tappable Start"),
            .init(action: "Tap Start", expect: "An alert explains Gemini isn't wired yet, with only a dismiss button")
        ]
    )

    static let liveStartAuthFailureShowsAlert = TestSpec(
        id: "live.start.auth-failure",
        title: "Rejected key on connect routes to Settings",
        purpose: "Verify an OpenAI auth failure (simulated 401) during connect surfaces the alert with an Open Live Settings shortcut, not a failure banner.",
        screens: ["live"],
        steps: [
            .init(action: "Launch with a saved key but a connect that 401s", expect: "Live opens with a tappable Start"),
            .init(action: "Tap Start and let the connect attempt fail", expect: "The auth-failure alert appears with an Open Live Settings shortcut")
        ]
    )

    static let liveStartCustomProviderShowsAlert = TestSpec(
        id: "live.start.custom-blocked",
        title: "Custom provider explains itself on start",
        purpose: "Verify the Custom provider (no adapter dialect) pops an acknowledge-only alert on Start — same no-Settings path as Gemini.",
        screens: ["live"],
        steps: [
            .init(action: "Launch with the Live provider pinned to Custom", expect: "Live opens with a tappable Start"),
            .init(action: "Tap Start", expect: "An alert explains Custom needs an adapter dialect, with only a dismiss button")
        ]
    )

    static let liveSendWhileDisconnectedShowsAlert = TestSpec(
        id: "live.send.not-connected",
        title: "Sending text before connecting explains itself",
        purpose: "Verify typing a message and sending while idle (no session) pops the 'Not connected' alert instead of silently no-oping.",
        screens: ["live"],
        steps: [
            .init(action: "Launch app at the Live empty state", expect: "Live opens idle"),
            .init(action: "Show the keyboard, type a message, and tap Send", expect: "A 'Not connected' alert appears")
        ]
    )

    static let primaryTabSetRendersMajorScreens = TestSpec(
        id: "tabs.primary.major-screens",
        title: "Primary tab set renders major screens",
        purpose: "Verify the configurable primary tab layout reaches each expected root screen.",
        screens: ["live", "chat", "probes", "pipecat", "settings"],
        steps: [
            .init(action: "Launch app with primary tab seed", expect: "Primary tabs are installed deterministically"),
            .init(action: "Visit Live, Chat, Probes, Pipecat, and Settings", expect: "Each tab exposes its screen identifier")
        ]
    )

    static let firstRunIntroIsReachable = TestSpec(
        id: "first-run-intro.reachable",
        title: "First-run intro is reachable",
        purpose: "Verify the intro cards explain Hawky, Live mode, setup, and controls without entering setup.",
        screens: ["first-run-intro", "first-run-intro.live-mode", "first-run-intro.setup", "first-run-intro.begin", "live"],
        steps: [
            .init(action: "Launch app in first-run intro mode", expect: "Intro is presented"),
            .init(action: "Advance through the intro cards", expect: "Set Up card exposes setup and explore actions")
        ]
    )

    static let firstRunIntroRunSetupOpensSetup = TestSpec(
        id: "first-run-intro.run-setup",
        title: "First-run intro opens setup",
        purpose: "Verify the intro's primary path opens the reusable setup wizard.",
        screens: ["first-run-intro", "onboarding", "onboarding.connection"],
        steps: [
            .init(action: "Launch app in first-run intro mode", expect: "Intro is presented"),
            .init(action: "Advance to Set Up and tap Set up now", expect: "Setup wizard opens at Connect"),
            .init(action: "Open connection details", expect: "Connection detail screen is reachable")
        ]
    )

    static let firstRunIntroEnterAppOpensLive = TestSpec(
        id: "first-run-intro.enter-app",
        title: "First-run intro can enter the app",
        purpose: "Verify users can skip setup from the intro and land on Live.",
        screens: ["first-run-intro", "live"],
        steps: [
            .init(action: "Launch app in first-run intro mode", expect: "Intro is presented"),
            .init(action: "Advance to Set Up and tap Explore first", expect: "App opens to Live")
        ]
    )

    static let setupFlowIsReachable = TestSpec(
        id: "setup.flow.reachable",
        title: "Setup flow is reachable",
        purpose: "Verify the reusable setup path remains navigable without camera or Meta app dependencies.",
        screens: ["onboarding", "onboarding.connection", "onboarding.live-provider", "onboarding.glasses", "onboarding.complete", "live"],
        steps: [
            .init(action: "Launch app in setup mode", expect: "Welcome step is presented"),
            .init(action: "Open and return from connection details", expect: "Connection detail screen is reachable"),
            .init(action: "Advance through provider and glasses setup", expect: "Setup complete step appears"),
            .init(action: "Complete setup", expect: "App returns to Live")
        ]
    )

    static let chatSessionsPaneShowsSeededSession = TestSpec(
        id: "chat.sessions.seeded-session",
        title: "Chat sessions pane shows seeded session",
        purpose: "Verify deterministic gateway seeding reaches the sessions pane.",
        screens: ["chat", "chat.sessions"],
        steps: [
            .init(action: "Launch app with primary tab seed", expect: "Chat tab is available"),
            .init(action: "Open the sessions pane", expect: "Seeded main session is listed")
        ],
        backendMode: .mockSeed,
        seedProfile: "empty"
    )

    static let chatPopulatedSeedRendersMessages = TestSpec(
        id: "chat.seed.chat-populated.messages",
        title: "Chat populated seed renders messages",
        purpose: "Verify a deterministic seed profile renders user, assistant, and system messages without a live gateway.",
        screens: ["chat"],
        steps: [
            .init(action: "Launch app with JC_SEED=chat-populated", expect: "Seeded local gateway state is installed"),
            .init(action: "Open Chat tab", expect: "Chat screen is available"),
            .init(action: "Inspect seeded chat transcript", expect: "User, assistant, and system seeded messages are visible")
        ],
        backendMode: .mockSeed,
        seedProfile: UITestSeed.chatPopulated
    )

    static let chatMixedSeedSwitchesSessions = TestSpec(
        id: "chat.seed.mixed.switch-session",
        title: "Mixed seed switches chat sessions",
        purpose: "Verify a deterministic multi-session seed can switch sessions and render session-specific history.",
        screens: ["chat", "chat.sessions"],
        steps: [
            .init(action: "Launch app with JC_SEED=mixed", expect: "Seeded multi-session local gateway state is installed"),
            .init(action: "Open Chat sessions pane", expect: "Seeded Research session is listed"),
            .init(action: "Select the seeded Research session", expect: "Research session becomes active and renders its seeded assistant message")
        ],
        backendMode: .mockSeed,
        seedProfile: UITestSeed.mixed
    )

    static let chatDeepLinkSelectsSeededSession = TestSpec(
        id: "chat.deeplink.seeded-session",
        title: "Chat deep link selects seeded session",
        purpose: "Verify hawky://chat/<session> opens Chat and activates the requested seeded session.",
        screens: ["chat"],
        steps: [
            .init(action: "Open hawky://chat/\(UITestSeed.researchSessionKey) with JC_SEED=mixed", expect: "Research session becomes active and renders its seeded assistant message")
        ],
        backendMode: .mockSeed,
        seedProfile: UITestSeed.mixed
    )

    static let recordingsSeedRendersRecording = TestSpec(
        id: "recordings.seed.recording-row",
        title: "Recordings seed renders recording row",
        purpose: "Verify the recordings history can render deterministic local recording fixtures without a live session.",
        screens: ["live", "live.recordings"],
        steps: [
            .init(action: "Open Recordings with JC_SEED=recordings", expect: "Recordings history is presented"),
            .init(action: "Inspect seeded recording list", expect: "Seeded recording row replaces the empty state")
        ],
        backendMode: .mockSeed,
        seedProfile: UITestSeed.recordings
    )

    static let connectionErrorSeedRendersStatus = TestSpec(
        id: "connection.seed.error-status",
        title: "Connection error seed renders status sheet",
        purpose: "Verify deterministic error seed state is visible through the connection debug sheet without a live gateway.",
        screens: ["chat"],
        steps: [
            .init(action: "Launch app with JC_SEED=error", expect: "Seeded local gateway error state is installed"),
            .init(action: "Open Chat and tap connection status", expect: "Connection debug sheet shows the seeded error")
        ],
        backendMode: .mockSeed,
        seedProfile: UITestSeed.error
    )

    static let secondaryTabSetRendersMajorScreens = TestSpec(
        id: "tabs.secondary.major-screens",
        title: "Secondary tab set renders major screens",
        purpose: "Verify less common tab roots remain reachable through a seeded layout.",
        screens: ["live2", "pipecat-recording", "gptr", "live", "settings"],
        steps: [
            .init(action: "Launch app with secondary tab seed", expect: "Secondary tabs are installed deterministically"),
            .init(action: "Visit Live2, Pipecat Recording, GPTRDemo, Live, and Settings", expect: "Each tab exposes its screen identifier")
        ]
    )

    static let settingsDetailPagesAreReachable = TestSpec(
        id: "settings.detail-pages.reachable",
        title: "Settings detail pages are reachable",
        purpose: "Verify every first-level Settings row opens and returns cleanly.",
        screens: ["settings", "settings.connection", "settings.agent", "settings.live", "settings.prompt", "settings.appearance", "settings.notifications", "settings.layout", "settings.about"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live is the initial selected tab"),
            .init(action: "Open Settings", expect: "Settings root is visible"),
            .init(action: "Open each Settings detail page and navigate back", expect: "Every detail page reaches its expected navigation title")
        ]
    )

    static let liveSheetsAreReachable = TestSpec(
        id: "live.sheets.reachable",
        title: "Live sheets and histories are reachable",
        purpose: "Verify Live secondary surfaces including settings, session list, and recordings history.",
        screens: ["live", "live.more", "live.settings", "live.sessions", "live.recordings"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live is the initial selected tab"),
            .init(action: "Open More", expect: "More sheet and Live Settings are reachable"),
            .init(action: "Open Live actions and sessions", expect: "Live Sessions list exposes summary, new, and export controls"),
            .init(action: "Open recordings history", expect: "Recordings empty state is visible")
        ]
    )

    static let chatContextAndProbesAreReachable = TestSpec(
        id: "chat.context.probes.reachable",
        title: "Chat context and probes are reachable",
        purpose: "Verify the compact Chat carousel exposes context actions and can navigate to Probes without relying on labels.",
        screens: ["chat", "chat.context", "probes"],
        steps: [
            .init(action: "Launch app with primary tab seed", expect: "Chat tab is available"),
            .init(action: "Swipe to the Chat context pane", expect: "Context actions and reload history control are visible"),
            .init(action: "Open Probes from Chat context", expect: "Probes screen exposes gateway and node probe controls")
        ]
    )

    static let pipecatControlsAreReachable = TestSpec(
        id: "pipecat.controls.reachable",
        title: "Pipecat controls are reachable",
        purpose: "Verify the Pipecat root page exposes its local-session controls and read-only diagnostic sections.",
        screens: ["pipecat"],
        steps: [
            .init(action: "Launch app with primary tab seed", expect: "Pipecat tab is available"),
            .init(action: "Open Pipecat tab", expect: "Pipecat root screen is visible"),
            .init(action: "Inspect Pipecat session controls", expect: "API key, model, prompt, toggles, start, and mic controls are selectable"),
            .init(action: "Scroll through Pipecat diagnostics", expect: "WebRTC, transcript, and events panels are reachable")
        ]
    )

    static let liveSettingsFormControlsAreReachable = TestSpec(
        id: "live.settings.controls.reachable",
        title: "Live settings controls are reachable",
        purpose: "Verify the full Live settings form exposes provider, recording, output, tools, bridge, and input controls.",
        screens: ["live", "live.more", "live.settings"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live screen is available"),
            .init(action: "Select Live tab", expect: "Live root screen is visible"),
            .init(action: "Open Live Settings from More", expect: "Live Settings sheet is presented"),
            .init(action: "Inspect model and credential controls", expect: "Provider, model, and direct OpenAI key controls are visible"),
            .init(action: "Scroll through advanced Live settings", expect: "Recording, response output, toolbox, bridge, and input controls are reachable")
        ]
    )

    static let settingsNestedControlsAreReachable = TestSpec(
        id: "settings.nested-controls.reachable",
        title: "Settings nested controls are reachable",
        purpose: "Verify Settings pages expose stable identifiers beyond first-level row navigation.",
        screens: ["settings", "settings.connection", "settings.agent", "settings.prompt", "settings.notifications", "settings.notification-sessions", "settings.layout"],
        steps: [
            .init(action: "Launch app with deterministic defaults", expect: "Live is the initial selected tab"),
            .init(action: "Open Settings", expect: "Settings root is visible"),
            .init(action: "Inspect Connection and Agent controls", expect: "Gateway, device, provider, model, and save controls are visible"),
            .init(action: "Inspect Prompt and Notifications controls", expect: "Prompt editor, ntfy controls, and trigger toggles are visible"),
            .init(action: "Open notification session filters and App Layout", expect: "Nested session toggles and tab layout controls are reachable")
        ]
    )

    static let secondaryDemoControlsAreReachable = TestSpec(
        id: "tabs.secondary.controls.reachable",
        title: "Secondary demo controls are reachable",
        purpose: "Verify Live2, Pipecat Recording, and GPTRDemo expose their important local controls and nested pages.",
        screens: ["live2", "live2.settings", "live2.recordings", "pipecat-recording", "gptr"],
        steps: [
            .init(action: "Launch app with secondary tab seed", expect: "Secondary demo tabs are installed deterministically"),
            .init(action: "Open Live2 tab", expect: "Live2 root screen is visible"),
            .init(action: "Inspect Live2 root controls", expect: "Camera, session, text, settings, recordings, and events controls are reachable"),
            .init(action: "Open Live2 Settings and Recordings", expect: "Nested Live2 configuration and recording history pages are reachable"),
            .init(action: "Inspect Pipecat Recording controls", expect: "Recording controls, folder, history, and events panels are reachable"),
            .init(action: "Inspect GPTRDemo controls", expect: "Transcription controls, archive, events, and history panels are reachable")
        ]
    )

    static let primaryDeepLinkScreenCases = ScreenManifest.shared.primaryDeepLinkScreenCases

    static let secondaryDeepLinkScreenCases = ScreenManifest.shared.secondaryDeepLinkScreenCases

    static let deepLinkScreenIDsUnderTest = [
        "live",
        "chat",
        "probes",
        "pipecat",
        "settings.connection",
        "settings.prompt",
        "settings.notification-sessions",
        "live.recordings",
        "live.summary",
        "live.glasses",
        "settings.layout",
        "live.sessions",
        "live.status",
        "live2",
        "pipecat-recording",
        "gptr",
    ]

    static let deepLinkScreenCasesUnderTest = deepLinkCases(deepLinkScreenIDsUnderTest)

    static var all: [TestSpec] {
        [
            launchesToLiveEmptyState,
            tabSwitchingShowsSettings,
            liveControlsExposeStableIdentifiers,
            liveMockSessionCanStartAndStop,
            liveStartBlockedShowsAlert,
            liveStartBlockedAlertOpensSettings,
            liveStartGeminiProviderShowsAlert,
            liveStartAuthFailureShowsAlert,
            liveStartCustomProviderShowsAlert,
            liveSendWhileDisconnectedShowsAlert,
            primaryTabSetRendersMajorScreens,
            firstRunIntroIsReachable,
            firstRunIntroRunSetupOpensSetup,
            firstRunIntroEnterAppOpensLive,
            setupFlowIsReachable,
            chatSessionsPaneShowsSeededSession,
            chatPopulatedSeedRendersMessages,
            chatMixedSeedSwitchesSessions,
            chatDeepLinkSelectsSeededSession,
            recordingsSeedRendersRecording,
            connectionErrorSeedRendersStatus,
            secondaryTabSetRendersMajorScreens,
            settingsDetailPagesAreReachable,
            liveSheetsAreReachable,
            chatContextAndProbesAreReachable,
            pipecatControlsAreReachable,
            liveSettingsFormControlsAreReachable,
            settingsNestedControlsAreReachable,
            secondaryDemoControlsAreReachable
        ] + deepLinkScreenCasesUnderTest.map(\.spec)
    }

    private static func deepLinkCases(_ ids: [String]) -> [DeepLinkScreenCase] {
        let casesByID = Dictionary(uniqueKeysWithValues: ScreenManifest.shared.allDeepLinkScreenCases.map { ($0.id, $0) })
        return ids.map { id in
            guard let screenCase = casesByID[id] else {
                preconditionFailure("Missing deep-link screen case \(id) in ScreenManifest.json")
            }
            return screenCase
        }
    }
}

final class AppUITests: XCTestCase {
    private var app: XCUIApplication!
    private var recorder: TestSpecRecorder?

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
        app = nil
        recorder = nil
    }

    func testScreenManifestAndSpecsAreComplete() throws {
        let manifest = ScreenManifest.shared
        manifest.validateManifest()

        let specs = UITestSpecs.all
        for spec in specs {
            manifest.validate(spec: spec)
        }
        manifest.assertAllScreensCovered(by: specs)

        let catalogIDs = Set((UITestSpecs.primaryDeepLinkScreenCases + UITestSpecs.secondaryDeepLinkScreenCases).map(\.id))
        let manifestCatalogIDs = Set(manifest.screens.compactMap { $0.catalog == nil ? nil : $0.id })
        XCTAssertEqual(catalogIDs, manifestCatalogIDs, "Deep-link catalog cases must be generated from every manifest screen with a catalog.")
    }

    func testLaunchesToLiveEmptyState() throws {
        let spec = UITestSpecs.launchesToLiveEmptyState
        launch(spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("live.emptyState").waitForExistence(timeout: 10))
            XCTAssertTrue(app.staticTexts["Talk to Hawky"].exists)
            XCTAssertTrue(app.tabBars.buttons["tab.live"].exists)
            XCTAssertTrue(app.tabBars.buttons["tab.settings"].exists)
        }
    }

    func testTabSwitchingShowsSettings() throws {
        let spec = UITestSpecs.tabSwitchingShowsSettings
        launch(spec: spec)

        step(spec.step(1)) {
            let settingsTab = app.tabBars.buttons["tab.settings"]
            XCTAssertTrue(settingsTab.waitForExistence(timeout: 10))
            settingsTab.tap()

            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("settings.connection.row").exists)
        }
    }

    func testLiveControlsExposeStableIdentifiers() throws {
        let spec = UITestSpecs.liveControlsExposeStableIdentifiers
        launch(spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("live.agentPill").waitForExistence(timeout: 10))
            XCTAssertTrue(element("live.more").exists)
            XCTAssertTrue(element("live.toggleAudio").exists)
            XCTAssertTrue(element("live.toggleVisual").exists)
            XCTAssertTrue(element("live.toggleKeyboard").exists)
            XCTAssertTrue(element("live.start").exists)
        }
    }

    func testLiveMockSessionCanStartAndStop() throws {
        let spec = UITestSpecs.liveMockSessionCanStartAndStop
        launch(liveMock: true, spec: spec)
        step(spec.step(1)) {
            assertTab("tab.live", shows: "screen.live")

            let start = element("live.start")
            XCTAssertTrue(start.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(
                waitUntilEnabled(start, timeout: 5),
                "Live start button did not become enabled\n\(app.debugDescription)"
            )
            start.tap()

            XCTAssertTrue(element("live.stop").waitForExistence(timeout: 10))
        }
        step(spec.step(2)) {
            element("live.stop").tap()
            XCTAssertTrue(element("live.start").waitForExistence(timeout: 10))
        }
    }

    /// Non-mock launch ⇒ the default OpenAI Realtime provider with no saved key,
    /// so `startBlockReason == .missingOpenAIKey`. Start stays enabled and a tap
    /// must surface the explanatory alert rather than silently no-op.
    func testLiveStartBlockedShowsAlert() throws {
        let spec = UITestSpecs.liveStartBlockedShowsAlert
        launch(spec: spec)
        step(spec.step(1)) {
            let start = element("live.start")
            XCTAssertTrue(start.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(
                waitUntilEnabled(start, timeout: 5),
                "Start must stay tappable so it can explain the blocker\n\(app.debugDescription)"
            )
            start.tap()
            XCTAssertTrue(
                element("live.actionAlert").waitForExistence(timeout: 5),
                "Blocked-start alert did not appear\n\(app.debugDescription)"
            )
            XCTAssertTrue(
                element("live.actionAlert.openSettings").exists,
                "Missing Open Live Settings shortcut on the blocked-start alert"
            )
        }
    }

    /// The blocked-start alert's Open Live Settings button should take the user
    /// straight to the Live settings form where the API key is entered.
    func testLiveStartBlockedAlertOpensSettings() throws {
        let spec = UITestSpecs.liveStartBlockedAlertOpensSettings
        launch(spec: spec)
        step(spec.step(1)) {
            let start = element("live.start")
            XCTAssertTrue(start.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(waitUntilEnabled(start, timeout: 5), app.debugDescription)
            start.tap()
            XCTAssertTrue(
                element("live.actionAlert.openSettings").waitForExistence(timeout: 5),
                "Blocked-start alert did not appear\n\(app.debugDescription)"
            )
        }
        step(spec.step(2)) {
            element("live.actionAlert.openSettings").tap()
            // The OpenAI API key field is exactly where the alert is routing the
            // user, and it renders for the default provider — assert on it.
            XCTAssertTrue(
                element("live.directOpenAIAPIKey").waitForExistence(timeout: 5),
                "Live Settings form did not open after Open Live Settings\n\(app.debugDescription)"
            )
        }
    }

    /// A not-yet-wired provider blocks at preflight with an acknowledge-only
    /// alert — no Open Live Settings shortcut, because there's no key to fix.
    func testLiveStartGeminiProviderShowsAlert() throws {
        let spec = UITestSpecs.liveStartGeminiProviderShowsAlert
        launch(liveProvider: "gemini", spec: spec)
        step(spec.step(1)) {
            let start = element("live.start")
            XCTAssertTrue(start.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(waitUntilEnabled(start, timeout: 5), app.debugDescription)
            start.tap()
            XCTAssertTrue(
                element("live.actionAlert").waitForExistence(timeout: 5),
                "Provider-unavailable alert did not appear\n\(app.debugDescription)"
            )
            XCTAssertTrue(
                element("live.actionAlert.dismiss").exists,
                "Acknowledge button missing on the provider-unavailable alert"
            )
            XCTAssertFalse(
                element("live.actionAlert.openSettings").exists,
                "Gemini block should not offer a Settings shortcut (nothing to fix there)"
            )
        }
    }

    /// A rejected/expired key surfaces only when the connect attempt fails, so
    /// this drives the connect path (via a stub that 401s) and asserts the alert
    /// offers the Open Live Settings shortcut.
    func testLiveStartAuthFailureShowsAlert() throws {
        let spec = UITestSpecs.liveStartAuthFailureShowsAlert
        launch(liveProvider: "auth-fail", spec: spec)
        step(spec.step(1)) {
            let start = element("live.start")
            XCTAssertTrue(start.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(waitUntilEnabled(start, timeout: 5), app.debugDescription)
            start.tap()
            // Connect runs (briefly) then the stub throws — give it room to fail.
            XCTAssertTrue(
                element("live.actionAlert.openSettings").waitForExistence(timeout: 10),
                "Auth-failure alert with Open Live Settings did not appear\n\(app.debugDescription)"
            )
        }
    }

    /// Custom provider: acknowledge-only alert, same no-Settings path as Gemini.
    func testLiveStartCustomProviderShowsAlert() throws {
        let spec = UITestSpecs.liveStartCustomProviderShowsAlert
        launch(liveProvider: "custom", spec: spec)
        step(spec.step(1)) {
            let start = element("live.start")
            XCTAssertTrue(start.waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(waitUntilEnabled(start, timeout: 5), app.debugDescription)
            start.tap()
            XCTAssertTrue(
                element("live.actionAlert").waitForExistence(timeout: 5),
                "Provider-unavailable alert did not appear\n\(app.debugDescription)"
            )
            XCTAssertTrue(element("live.actionAlert.dismiss").exists)
            XCTAssertFalse(
                element("live.actionAlert.openSettings").exists,
                "Custom block should not offer a Settings shortcut"
            )
        }
    }

    /// Typing + sending while idle (no connected session) pops the 'Not connected'
    /// alert instead of the Send button silently no-oping.
    func testLiveSendWhileDisconnectedShowsAlert() throws {
        let spec = UITestSpecs.liveSendWhileDisconnectedShowsAlert
        launch(spec: spec)
        step(spec.step(1)) {
            let showKeyboard = element("live.toggleKeyboard")
            XCTAssertTrue(showKeyboard.waitForExistence(timeout: 10), app.debugDescription)
            showKeyboard.tap()

            let field = element("live.testText")
            XCTAssertTrue(field.waitForExistence(timeout: 5), app.debugDescription)
            field.tap()
            field.typeText("hello there")

            let send = element("live.sendText")
            XCTAssertTrue(send.waitForExistence(timeout: 5), app.debugDescription)
            send.tap()

            XCTAssertTrue(
                element("live.actionAlert").waitForExistence(timeout: 5),
                "'Not connected' alert did not appear on send while idle\n\(app.debugDescription)"
            )
            XCTAssertTrue(element("live.actionAlert.dismiss").exists)
        }
    }

    func testPrimaryTabSetRendersMajorScreens() throws {
        let spec = UITestSpecs.primaryTabSetRendersMajorScreens
        launch(tabs: UITestTabLayout.primary, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.live", shows: "screen.live")
            XCTAssertTrue(element("live.emptyState").exists)

            assertTab("tab.chat", shows: "screen.chat")
            assertTab("tab.test", shows: "screen.test")
            assertTab("tab.pipecat", shows: "screen.pipecat")
            assertTab("tab.settings", shows: "screen.settings")
        }
    }

    func testFirstRunIntroIsReachable() throws {
        let spec = UITestSpecs.firstRunIntroIsReachable
        launch(firstRunIntro: true, spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("screen.firstRunIntro").waitForExistence(timeout: 10))
            XCTAssertTrue(element("firstRunIntro.card.overview").exists)
            tapFirstRunIntroContinue(expectedTitle: "Live Mode")
            XCTAssertTrue(element("firstRunIntro.card.liveMode").exists)
            tapFirstRunIntroContinue(expectedTitle: "Setup")
            XCTAssertTrue(element("firstRunIntro.card.setup").exists)
            tapFirstRunIntroContinue(expectedTitle: "Access")
            XCTAssertTrue(element("firstRunIntro.card.privacy").exists)
            tapFirstRunIntroContinue(expectedTitle: "Set Up")
            XCTAssertTrue(element("firstRunIntro.card.begin").exists)
            XCTAssertTrue(element("firstRunIntro.runSetup").exists)
            XCTAssertTrue(element("firstRunIntro.enterApp").exists)
        }
    }

    func testFirstRunIntroRunSetupOpensSetupFlow() throws {
        let spec = UITestSpecs.firstRunIntroRunSetupOpensSetup
        launch(firstRunIntro: true, spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("screen.firstRunIntro").waitForExistence(timeout: 10))
            advanceFirstRunIntroToSetupDecision()
            element("firstRunIntro.runSetup").tap()
            XCTAssertTrue(element("screen.onboarding").waitForExistence(timeout: 10))
            XCTAssertTrue(app.navigationBars["Connect"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("onboarding.connection.link").exists)
        }

        step(spec.step(2)) {
            element("onboarding.connection.link").tap()
            XCTAssertTrue(app.navigationBars["Hawky Connection"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("onboarding.connection.mode").exists)
            XCTAssertTrue(element("onboarding.verify").exists)
        }
    }

    func testFirstRunIntroEnterAppOpensLive() throws {
        let spec = UITestSpecs.firstRunIntroEnterAppOpensLive
        launch(firstRunIntro: true, spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("screen.firstRunIntro").waitForExistence(timeout: 10))
            advanceFirstRunIntroToSetupDecision()
            element("firstRunIntro.enterApp").tap()
            XCTAssertTrue(element("live.emptyState").waitForExistence(timeout: 10))
            XCTAssertTrue(app.tabBars.buttons["tab.live"].exists)
        }
    }

    func testSetupFlowIsReachable() throws {
        let spec = UITestSpecs.setupFlowIsReachable
        launch(onboarding: true, spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("screen.onboarding").waitForExistence(timeout: 10))
            XCTAssertTrue(element("onboarding.welcome.title").exists)
            XCTAssertTrue(app.buttons["Get Started"].exists)
            app.buttons["Get Started"].tap()

            XCTAssertTrue(app.navigationBars["Connect"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("onboarding.connection.link").exists)
            element("onboarding.connection.link").tap()
            XCTAssertTrue(app.navigationBars["Hawky Connection"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("onboarding.connection.mode").exists)
            XCTAssertTrue(element("onboarding.verify").exists)
            navigateBack(to: "Connect")
        }

        step(spec.step(2)) {
            tapOnboardingContinue(expectedTitle: "Live Provider")
            tapOnboardingContinue(expectedTitle: "Ray-Ban Meta")
            tapOnboardingContinue(expectedTitle: "All Set")
        }

        step(spec.step(3)) {
            XCTAssertTrue(app.buttons["Finish setup"].waitForExistence(timeout: 5))
            app.buttons["Finish setup"].tap()
            XCTAssertTrue(element("live.emptyState").waitForExistence(timeout: 10))
            XCTAssertTrue(app.tabBars.buttons["tab.live"].exists)
        }
    }

    func testChatSessionsPaneShowsSeededSession() throws {
        let spec = UITestSpecs.chatSessionsPaneShowsSeededSession
        launch(tabs: UITestTabLayout.primary, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.chat", shows: "screen.chat")
            // Confirm the chat surface is on screen before swiping so the
            // sessions carousel reveal does not race the swipe gesture.
            let chat = element("screen.chat")
            XCTAssertTrue(chat.waitForExistence(timeout: 5))
            chat.swipeRight()

            XCTAssertTrue(element("chatCarousel.sessions").waitForExistence(timeout: 5))
            XCTAssertTrue(element("chatCarousel.session.\(UITestSeed.sessionKey)").exists)
            XCTAssertTrue(app.staticTexts[UITestSeed.sessionDisplayName].exists)
        }
    }

    func testChatPopulatedSeedRendersMessages() throws {
        let spec = UITestSpecs.chatPopulatedSeedRendersMessages
        launch(tabs: UITestTabLayout.primary, seed: UITestSeed.chatPopulated, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.chat", shows: "screen.chat")
        }

        step(spec.step(2)) {
            assertElement(UITestSeed.userBubbleIdentifier)
            assertElement(UITestSeed.assistantBubbleIdentifier)
            assertElement(UITestSeed.systemBubbleIdentifier)
            assertText(containing: UITestSeed.userMessageText)
            assertText(containing: UITestSeed.assistantMessageText)
            assertText(containing: UITestSeed.systemMessageText)
        }
    }

    func testChatMixedSeedSwitchesSessions() throws {
        let spec = UITestSpecs.chatMixedSeedSwitchesSessions
        launch(tabs: UITestTabLayout.primary, seed: UITestSeed.mixed, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.chat", shows: "screen.chat")
            element("screen.chat").swipeRight()
            assertElement("chatCarousel.sessions")
            assertElement("chatCarousel.session.\(UITestSeed.researchSessionKey)")
            assertText(containing: UITestSeed.researchSessionDisplayName)
        }

        step(spec.step(2)) {
            let researchSession = app.buttons["chatCarousel.session.\(UITestSeed.researchSessionKey)"]
            XCTAssertTrue(researchSession.waitForExistence(timeout: 5), app.debugDescription)
            researchSession.tap()
            XCTAssertTrue(element("chatCarousel.chat").waitForExistence(timeout: 5), app.debugDescription)
            assertElement(UITestSeed.researchBubbleIdentifier)
            assertText(containing: UITestSeed.researchMessageText)
        }
    }

    func testChatDeepLinkSelectsSeededSession() throws {
        let spec = UITestSpecs.chatDeepLinkSelectsSeededSession
        prepareApp(tabs: UITestTabLayout.primary, seed: UITestSeed.mixed)
        begin(spec)

        step(spec.step(0)) {
            openDeepLink("hawky://chat/\(UITestSeed.researchSessionKey)")
            XCTAssertTrue(element("screen.chat").waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(element("chatCarousel.chat").waitForExistence(timeout: 5), app.debugDescription)
            assertElement(UITestSeed.researchBubbleIdentifier)
            assertText(containing: UITestSeed.researchMessageText)
        }
    }

    func testRecordingsSeedRendersRecording() throws {
        let spec = UITestSpecs.recordingsSeedRendersRecording
        prepareApp(tabs: UITestTabLayout.primary, seed: UITestSeed.recordings)
        begin(spec)

        step(spec.step(0)) {
            openDeepLink("hawky://recordings")
            XCTAssertTrue(app.navigationBars["Recordings"].waitForExistence(timeout: 5))
            assertElement("screen.recordingsHistory")
        }

        step(spec.step(1)) {
            assertElement(UITestSeed.recordingRowIdentifier)
            assertText(containing: UITestSeed.recordingFileName)
            XCTAssertFalse(app.staticTexts["No Recordings"].exists)
        }
    }

    func testConnectionErrorSeedRendersStatusSheet() throws {
        let spec = UITestSpecs.connectionErrorSeedRendersStatus
        launch(tabs: UITestTabLayout.primary, seed: UITestSeed.error, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.chat", shows: "screen.chat")
            let statusDot = app.buttons["connectionStatusDot"]
            XCTAssertTrue(statusDot.waitForExistence(timeout: 5), app.debugDescription)
            statusDot.tap()
            assertElement("connectionDebugSheet")
            assertElement("connectionDebugSheet.statusText")
            assertElement("connectionDebugSheet.lastError")
            assertText(containing: UITestSeed.gatewayErrorText)
        }
    }

    func testSecondaryTabSetRendersMajorScreens() throws {
        let spec = UITestSpecs.secondaryTabSetRendersMajorScreens
        launch(tabs: UITestTabLayout.secondary, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.live2", shows: "screen.live2")
            assertTab("tab.pipecatRecording", shows: "screen.pipecatRecording")
            XCTAssertTrue(app.navigationBars["Pipecat2"].waitForExistence(timeout: 5))

            assertTab("tab.gptrDemo", shows: "screen.gptrDemo")
            XCTAssertTrue(app.navigationBars["GPTRDemo"].waitForExistence(timeout: 5))

            assertTab("tab.live", shows: "screen.live")
            assertTab("tab.settings", shows: "screen.settings")
        }
    }

    func testSettingsDetailPagesAreReachable() throws {
        let spec = UITestSpecs.settingsDetailPagesAreReachable
        launch(spec: spec)
        step(spec.step(1)) {
            openSettings()
        }

        let pages: [(row: String, title: String)] = [
            ("settings.connection.row", "Connection"),
            ("settings.agent.row", "Agent"),
            ("settings.live.row", "Live"),
            ("settings.prompt.row", "Prompt"),
            ("settings.appearance.row", "Appearance"),
            ("settings.notifications.row", "Notifications"),
            ("settings.layout.row", "App Layout"),
            ("settings.about.row", "About")
        ]

        step(spec.step(2)) {
            for page in pages {
                openSettingsPage(row: page.row, title: page.title)
                navigateBackToSettings()
            }
        }
    }

    func testLiveSheetsAreReachable() throws {
        let spec = UITestSpecs.liveSheetsAreReachable
        launch(spec: spec)

        step(spec.step(1)) {
            XCTAssertTrue(element("live.more").waitForExistence(timeout: 10))
            element("live.more").tap()
            XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("live.moreSheet.settings").exists)
            element("live.moreSheet.settings").tap()
            XCTAssertTrue(app.navigationBars["Live Settings"].waitForExistence(timeout: 5))
            dismissPresentedSheet()
        }

        step(spec.step(2)) {
            XCTAssertTrue(element("live.agentPill").waitForExistence(timeout: 10))
            element("live.agentPill").tap()
            XCTAssertTrue(app.navigationBars["Live"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("live.actions.newSession").exists)
            XCTAssertTrue(element("live.actions.sessions").exists)
            element("live.actions.sessions").tap()
            XCTAssertTrue(app.navigationBars["Live Sessions"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("live.sessions.list").exists)
            XCTAssertTrue(element("live.sessions.summary").exists)
            XCTAssertTrue(element("live.sessions.new").exists)
            XCTAssertTrue(element("live.sessions.export").exists)
            XCTAssertTrue(app.staticTexts["Live Session"].exists)
            app.buttons["live.sessions.new"].tap()
            XCTAssertTrue(app.staticTexts["Live Session"].waitForExistence(timeout: 3))
            navigateBack(to: "Live")
        }

        step(spec.step(3)) {
            if !element("live.actions.status").exists {
                app.swipeUp()
            }
            XCTAssertTrue(element("live.actions.status").waitForExistence(timeout: 3))

            XCTAssertTrue(element("live.actions.recordings").waitForExistence(timeout: 5))
            app.buttons["live.actions.recordings"].tap()
            XCTAssertTrue(app.navigationBars["Recordings"].waitForExistence(timeout: 5))
            XCTAssertTrue(element("screen.recordingsHistory").exists)
            XCTAssertTrue(app.staticTexts["No Recordings"].exists)
            closeRecordingsHistory()
        }
    }

    func testChatContextAndProbesAreReachable() throws {
        let spec = UITestSpecs.chatContextAndProbesAreReachable
        launch(tabs: UITestTabLayout.primary, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.chat", shows: "screen.chat")
            element("screen.chat").swipeLeft()

            assertElement("chatCarousel.context")
            assertElement("chatCarousel.reloadHistory")
            assertElement("chatCarousel.openProbes")
        }

        step(spec.step(2)) {
            tapElement("chatCarousel.openProbes")
            XCTAssertTrue(app.navigationBars["Probes"].waitForExistence(timeout: 5))
            assertElement("tweak.run.all")
            assertElement("cap.invoke.all", maxSwipes: 2)
        }
    }

    func testDeepLinkLive() throws {
        assertDeepLinkScreen("live", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkChat() throws {
        assertDeepLinkScreen("chat", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkProbes() throws {
        assertDeepLinkScreen("probes", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkPipecat() throws {
        assertDeepLinkScreen("pipecat", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkSettingsConnection() throws {
        assertDeepLinkScreen("settings.connection", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkSettingsPrompt() throws {
        assertDeepLinkScreen("settings.prompt", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkSettingsNotificationSessions() throws {
        assertDeepLinkScreen("settings.notification-sessions", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkLiveRecordings() throws {
        assertDeepLinkScreen("live.recordings", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkLiveSummary() throws {
        assertDeepLinkScreen("live.summary", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkLiveGlasses() throws {
        assertDeepLinkScreen("live.glasses", tabs: UITestTabLayout.primary)
    }

    func testDeepLinkSettingsLayout() throws {
        assertDeepLinkScreen("settings.layout", tabs: UITestTabLayout.secondary)
    }

    func testDeepLinkLiveSessions() throws {
        assertDeepLinkScreen("live.sessions", tabs: UITestTabLayout.secondary)
    }

    func testDeepLinkLiveStatus() throws {
        assertDeepLinkScreen("live.status", tabs: UITestTabLayout.secondary)
    }

    func testDeepLinkLive2() throws {
        assertDeepLinkScreen("live2", tabs: UITestTabLayout.secondary)
    }

    func testDeepLinkPipecatRecording() throws {
        assertDeepLinkScreen("pipecat-recording", tabs: UITestTabLayout.secondary)
    }

    func testDeepLinkGPTR() throws {
        assertDeepLinkScreen("gptr", tabs: UITestTabLayout.secondary)
    }

    func testPipecatControlsAreReachable() throws {
        let spec = UITestSpecs.pipecatControlsAreReachable
        launch(tabs: UITestTabLayout.primary, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.pipecat", shows: "screen.pipecat")
        }

        step(spec.step(2)) {
            assertElement("pipecat.status")
            assertElement("pipecat.session")
            assertElement("pipecat.apiKey")
            assertElement("pipecat.apiKey.reveal")
            assertElement("pipecat.model")
            assertElement("pipecat.instructions")
            assertElement("pipecat.initialMessage")
            assertElement("pipecat.transcriptEnabled")
            assertElement("pipecat.startupGuard")
            assertElement("pipecat.connect")
            assertElement("pipecat.mic")
        }

        step(spec.step(3)) {
            assertElement("pipecat.webrtc", maxSwipes: 2)
            assertElement("pipecat.transcriptPanel", maxSwipes: 2)
            assertElement("pipecat.events", maxSwipes: 3)
        }
    }

    func testLiveSettingsFormControlsAreReachable() throws {
        let spec = UITestSpecs.liveSettingsFormControlsAreReachable
        launch(spec: spec)

        step(spec.step(1)) {
            assertTab("tab.live", shows: "screen.live")
        }

        step(spec.step(2)) {
            tapElement("live.more")
            XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))
            tapElement("live.moreSheet.settings")
            XCTAssertTrue(app.navigationBars["Live Settings"].waitForExistence(timeout: 5))
        }

        step(spec.step(3)) {
            assertElement("live.provider")
            assertElement("live.openAIModelPreset")
            assertElement("live.directOpenAIAPIKey")
            assertElement("live.directOpenAIAPIKey.reveal")
        }

        step(spec.step(4)) {
            assertElement("live.settings.mediaPersistence", maxSwipes: 3)
            assertElement("live.settings.backgroundCapture")
            assertAnyElement(["live.responseModality", "live.responseModality.fixed"], maxSwipes: 3)
            assertElement("live.realtimeVoice", maxSwipes: 2)
            assertElement("live.audioOutputDestination", maxSwipes: 2)
            assertElement("live.inputTranscriptionEnabled", maxSwipes: 2)
            assertElement("live.toolbox", maxSwipes: 4)
            assertElement("live.gatewayBridgeEnabled", maxSwipes: 4)
            assertElement("live.audioSource", maxSwipes: 4)
            dismissPresentedSheet()
        }
    }

    func testSettingsNestedControlsAreReachable() throws {
        let spec = UITestSpecs.settingsNestedControlsAreReachable
        launch(spec: spec)

        step(spec.step(1)) {
            openSettings()
        }

        step(spec.step(2)) {
            openSettingsPage(row: "settings.connection.row", title: "Connection")
            assertElement("settings.gatewayURL")
            assertElement("settings.deviceName")
            assertElement("settings.save")
            assertElement("settings.testConnection")
            assertElement("settings.tokenStatus", maxSwipes: 2)
            assertElement("settings.reauth")
            assertElement("settings.clearToken")
            navigateBackToSettings()

            openSettingsPage(row: "settings.agent.row", title: "Agent")
            assertElement("settings.agent.provider")
            assertElement("settings.agent.modelPicker")
            assertElement("settings.agent.apiBaseURL")
            assertElement("settings.agent.save")
            navigateBackToSettings()
        }

        step(spec.step(3)) {
            openSettingsPage(row: "settings.prompt.row", title: "Prompt")
            assertElement("live.prompt")
            assertElement("live.promptTitle")
            assertElement("live.promptInstructions")
            navigateBackToSettings()

            openSettingsPage(row: "settings.notifications.row", title: "Notifications")
            assertElement("settings.ntfy.enabled")
            assertElement("settings.ntfy.topic")
            assertElement("settings.ntfy.generate")
            assertElement("settings.ntfy.trigger.turn_complete", maxSwipes: 2)
            assertElement("settings.ntfy.testPush", maxSwipes: 2)
        }

        step(spec.step(4)) {
            tapElement("settings.ntfy.sessions.row", maxSwipes: 2)
            XCTAssertTrue(app.navigationBars["Sessions to notify"].waitForExistence(timeout: 5))
            assertElement("settings.ntfy.sessions.subpage")
            assertElement("settings.ntfy.sessions.allBadge")
            assertElement("settings.ntfy.sessions.toggle.\(UITestSeed.sessionKey)")
            navigateBack(to: "Notifications")
            navigateBackToSettings()

            openSettingsPage(row: "settings.layout.row", title: "App Layout")
            assertElement("settings.tabs.fixed.settings", maxSwipes: 2)
            assertElement("settings.tabs.hide.live", maxSwipes: 2)
            assertElement("settings.tabs.show.chat", maxSwipes: 3)
            navigateBackToSettings()
        }
    }

    func testSecondaryDemoControlsAreReachable() throws {
        let spec = UITestSpecs.secondaryDemoControlsAreReachable
        launch(tabs: UITestTabLayout.secondary, spec: spec)

        step(spec.step(1)) {
            assertTab("tab.live2", shows: "screen.live2")
        }

        step(spec.step(2)) {
            assertElement("live2.status")
            assertElement("live2.cameraPanel")
            assertElement("live2.preview")
            assertElement("live2.session")
            assertElement("live2.start")
            assertElement("live2.mic")
            assertElement("live2.textTurn", maxSwipes: 2)
            assertElement("live2.textDraft")
            assertElement("live2.sendUser")
            assertElement("live2.sendContext")
            assertElement("live2.settingsLink", maxSwipes: 2)
            assertElement("live2.recordingsLink")
        }

        step(spec.step(3)) {
            tapElement("live2.settingsLink")
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
            assertElement("live2.settings.modelPreset")
            assertElement("live2.settings.instructions")
            assertElement("live2.settings.initialMessage")
            assertElement("live2.settings.visualContext", maxSwipes: 2)
            assertElement("live2.settings.recordVideo")
            assertElement("live2.settings.camera")
            assertElement("live2.settings.visualFPS")
            navigateBack(to: "Live2")

            tapElement("live2.recordingsLink", maxSwipes: 2)
            XCTAssertTrue(app.navigationBars["Recordings"].waitForExistence(timeout: 5))
            assertElement("live2.recordings.current")
            assertElement("live2.recordings.empty")
            navigateBack(to: "Live2")
        }

        step(spec.step(4)) {
            assertTab("tab.pipecatRecording", shows: "screen.pipecatRecording")
            assertElement("pipecatRecording.status")
            assertElement("pipecatRecording.session")
            assertElement("pipecatRecording.apiKey")
            assertElement("pipecatRecording.model")
            assertElement("pipecatRecording.instructions")
            assertElement("pipecatRecording.initialMessage")
            assertElement("pipecatRecording.recordVideo")
            assertElement("pipecatRecording.sendVisualContext")
            assertElement("pipecatRecording.visualFPS")
            assertElement("pipecatRecording.start")
            assertElement("pipecatRecording.mic")
            assertElement("pipecatRecording.folder", maxSwipes: 2)
            assertElement("pipecatRecording.history", maxSwipes: 2)
            assertElement("pipecatRecording.events", maxSwipes: 3)
        }

        step(spec.step(5)) {
            assertTab("tab.gptrDemo", shows: "screen.gptrDemo")
            assertElement("gptr.status")
            assertElement("gptr.session")
            assertElement("gptr.apiKey")
            assertElement("gptr.apiKey.reveal")
            assertElement("gptr.model")
            assertElement("gptr.language")
            assertElement("gptr.delay")
            assertElement("gptr.transcriptionEnabled")
            assertElement("gptr.recordAudio")
            assertElement("gptr.autoCommit")
            assertElement("gptr.autoCommitSeconds")
            assertElement("gptr.includeBase64")
            assertElement("gptr.start")
            assertElement("gptr.commit")
            assertElement("gptr.transcriptPanel", maxSwipes: 2)
            assertElement("gptr.archive", maxSwipes: 2)
            assertElement("gptr.events", maxSwipes: 2)
            assertElement("gptr.history", maxSwipes: 3)
        }
    }

    private func launch(
        tabs: String? = nil,
        onboarding: Bool = false,
        firstRunIntro: Bool = false,
        liveMock: Bool = false,
        liveProvider: String? = nil,
        seed: String? = nil,
        spec: TestSpec? = nil
    ) {
        prepareApp(tabs: tabs, onboarding: onboarding, firstRunIntro: firstRunIntro, liveMock: liveMock, liveProvider: liveProvider, seed: seed)
        if let spec {
            begin(spec)
            step(spec.step(0)) {
                app.launch()
            }
        } else {
            app.launch()
        }
    }

    private func prepareApp(
        tabs: String? = nil,
        onboarding: Bool = false,
        firstRunIntro: Bool = false,
        liveMock: Bool = false,
        liveProvider: String? = nil,
        seed: String? = nil
    ) {
        app = XCUIApplication()
        app.launchArguments = [UITestLaunch.argument]
        if onboarding {
            app.launchArguments.append(UITestLaunch.onboardingArgument)
        }
        if firstRunIntro {
            app.launchArguments.append(UITestLaunch.firstRunIntroArgument)
        }
        app.launchEnvironment[UITestLaunch.enabledEnvironmentKey] = UITestLaunch.enabledEnvironmentValue
        if let tabs {
            app.launchEnvironment[UITestLaunch.tabsEnvironmentKey] = tabs
        }
        if onboarding {
            app.launchEnvironment[UITestLaunch.onboardingEnvironmentKey] = UITestLaunch.enabledEnvironmentValue
        }
        if firstRunIntro {
            app.launchEnvironment[UITestLaunch.firstRunIntroEnvironmentKey] = UITestLaunch.enabledEnvironmentValue
        }
        if liveMock {
            app.launchEnvironment[UITestLaunch.liveMockEnvironmentKey] = UITestLaunch.enabledEnvironmentValue
        }
        if let liveProvider {
            app.launchEnvironment[UITestLaunch.liveProviderEnvironmentKey] = liveProvider
        }
        if let seed {
            app.launchEnvironment[UITestLaunch.seedEnvironmentKey] = seed
        }
        addSystemAlertHandler()
    }

    private func begin(_ spec: TestSpec) {
        ScreenManifest.shared.validate(spec: spec)
        recorder = TestSpecRecorder(testCase: self, spec: spec)
        recorder?.attachSpec()
    }

    private func step(_ step: TestSpec.Step, body: () -> Void) {
        recorder?.record(step: step, body: body) ?? body()
    }

    private func assertDeepLinkScreen(
        _ id: String,
        tabs: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let screen = UITestSpecs.deepLinkScreenCasesUnderTest.first(where: { $0.id == id }) else {
            XCTFail("Missing deep-link screen case \(id)", file: file, line: line)
            return
        }

        prepareApp(tabs: tabs)
        begin(screen.spec)
        step(screen.spec.step(0)) {
            openDeepLink(screen.url, file: file, line: line)
            assertElement(screen.expectedIdentifier, maxSwipes: screen.maxSwipes, file: file, line: line)
        }
    }

    private func assertTab(_ identifier: String, shows screenIdentifier: String) {
        let tab = app.tabBars.buttons[identifier]
        // 15s rather than 10s: under full-suite load a cold launch can take ~8s
        // before the tab bar settles, occasionally tripping a 10s wait.
        XCTAssertTrue(tab.waitForExistence(timeout: 15), "Missing \(identifier)")
        tab.tap()
        XCTAssertTrue(element(screenIdentifier).waitForExistence(timeout: 5), "Missing \(screenIdentifier)")
    }

    @discardableResult
    private func assertElement(
        _ identifier: String,
        timeout: TimeInterval = 5,
        maxSwipes: Int = 0,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        let target = element(identifier)
        if waitForVisibleElement(target, timeout: timeout, maxSwipes: maxSwipes) {
            return target
        }
        XCTFail("Missing \(identifier)\n\(app.debugDescription)", file: file, line: line)
        return target
    }

    @discardableResult
    private func assertAnyElement(
        _ identifiers: [String],
        timeout: TimeInterval = 2,
        maxSwipes: Int = 0,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        if let target = firstExistingElement(identifiers) {
            return target
        }

        let initialTimeout = maxSwipes > 0 ? min(timeout, 1) : timeout
        for identifier in identifiers {
            let target = element(identifier)
            if target.waitForExistence(timeout: initialTimeout) {
                return target
            }
        }
        for _ in 0..<maxSwipes {
            app.swipeUp()
            if let target = firstExistingElement(identifiers) {
                return target
            }
            for identifier in identifiers {
                let target = element(identifier)
                if target.waitForExistence(timeout: 1) {
                    return target
                }
            }
        }
        XCTFail("Missing one of \(identifiers.joined(separator: ", "))\n\(app.debugDescription)", file: file, line: line)
        return element(identifiers.first ?? "")
    }

    private func waitForVisibleElement(
        _ target: XCUIElement,
        timeout: TimeInterval,
        maxSwipes: Int
    ) -> Bool {
        if target.exists {
            return true
        }

        // Scroll searches should not spend the full timeout before the first swipe.
        let initialTimeout = maxSwipes > 0 ? min(timeout, 1) : timeout
        if target.waitForExistence(timeout: initialTimeout) {
            return true
        }

        for _ in 0..<maxSwipes {
            app.swipeUp()
            if target.exists || target.waitForExistence(timeout: 1) {
                return true
            }
        }
        return false
    }

    private func firstExistingElement(_ identifiers: [String]) -> XCUIElement? {
        for identifier in identifiers {
            let target = element(identifier)
            if target.exists {
                return target
            }
        }
        return nil
    }

    private func assertText(
        containing text: String,
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        let target = app.descendants(matching: .any).matching(predicate).firstMatch
        XCTAssertTrue(
            target.waitForExistence(timeout: timeout),
            "Missing text containing \(text)\n\(app.debugDescription)",
            file: file,
            line: line
        )
    }

    @discardableResult
    private func tapElement(
        _ identifier: String,
        timeout: TimeInterval = 5,
        maxSwipes: Int = 0,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        let target = assertElement(identifier, timeout: timeout, maxSwipes: maxSwipes, file: file, line: line)
        target.tap()
        return target
    }

    private func openDeepLink(
        _ rawURL: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let url = URL(string: rawURL) else {
            XCTFail("Invalid deep link \(rawURL)", file: file, line: line)
            return
        }
        app.open(url)
    }

    private func openSettings() {
        assertTab("tab.settings", shows: "screen.settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    private func openSettingsPage(row identifier: String, title: String) {
        let row = assertElement(identifier, timeout: 2, maxSwipes: 4)
        row.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), "Missing \(title)")
    }

    private func navigateBackToSettings() {
        navigateBack(to: "Settings")
    }

    private func navigateBack(to title: String) {
        let labeledBack = app.navigationBars.buttons[title]
        if labeledBack.waitForExistence(timeout: 2) {
            labeledBack.tap()
        } else {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), "Missing \(title)")
    }

    private func tapOnboardingContinue(expectedTitle: String) {
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 5), "Missing onboarding.continue")
        continueButton.tap()
        XCTAssertTrue(app.navigationBars[expectedTitle].waitForExistence(timeout: 5), "Missing \(expectedTitle)")
    }

    private func tapFirstRunIntroContinue(expectedTitle: String) {
        let continueButton = element("firstRunIntro.continue")
        XCTAssertTrue(continueButton.waitForExistence(timeout: 5), "Missing firstRunIntro.continue")
        continueButton.tap()
        XCTAssertTrue(app.navigationBars[expectedTitle].waitForExistence(timeout: 5), "Missing \(expectedTitle)")
    }

    private func advanceFirstRunIntroToSetupDecision() {
        tapFirstRunIntroContinue(expectedTitle: "Live Mode")
        tapFirstRunIntroContinue(expectedTitle: "Setup")
        tapFirstRunIntroContinue(expectedTitle: "Access")
        tapFirstRunIntroContinue(expectedTitle: "Set Up")
        XCTAssertTrue(element("firstRunIntro.card.begin").exists)
    }

    private func closeRecordingsHistory() {
        let done = app.navigationBars["Recordings"].buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 2))
        done.tap()
        XCTAssertTrue(app.navigationBars["Live"].waitForExistence(timeout: 2))
        app.swipeDown()
    }

    private func dismissPresentedSheet() {
        let done = app.navigationBars.buttons["Done"]
        if done.waitForExistence(timeout: 2) {
            done.tap()
        } else {
            app.swipeDown()
        }
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.isEnabled {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return element.exists && element.isEnabled
    }

    private func addSystemAlertHandler() {
        addUIInterruptionMonitor(withDescription: "System permission alerts") { alert in
            for label in ["Open", "Don’t Allow", "Don't Allow", "Not Now", "OK", "Cancel"] {
                let button = alert.buttons[label]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
    }
}
