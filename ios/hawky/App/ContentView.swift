import SwiftUI
import UIKit
import UserNotifications

private enum LaunchOverlay: Identifiable {
    case firstRunIntro
    case setup

    var id: String {
        switch self {
        case .firstRunIntro: return "firstRunIntro"
        case .setup: return "setup"
        }
    }
}

struct ContentView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppTabConfiguration.storageKey) private var tabConfigurationRaw: String = ""
    @AppStorage(AppTabConfiguration.legacyTabOrderKey) private var legacyTabOrderRaw: String = ""
    @AppStorage(OnboardingState.presentKey) private var presentOnboarding: Bool = false
    @ObservedObject private var frontendTabs = FrontendTabStore.shared
    @State private var didPrewarmKeyboard = false
    @State private var didEvaluateOnboarding = false
    @State private var didConfigureLaunchLive = false
    @State private var liveStore = LiveSessionStore()
    @State private var launchOverlay: LaunchOverlay?
    @State private var setupStartsAtConnection = false
    private let launchConfiguration: LaunchConfiguration

    init(launchConfiguration: LaunchConfiguration = .current()) {
        self.launchConfiguration = launchConfiguration
        _launchOverlay = State(initialValue: launchConfiguration.forcesOnboardingOverlay ? .setup : nil)
    }

    var body: some View {
        TabView(selection: $frontendTabs.selectedTab) {
            tabs
        }
        .overlay {
            if launchOverlay == .firstRunIntro {
                FirstRunIntroView(
                    onRunSetup: {
                        setupStartsAtConnection = true
                        launchOverlay = .setup
                    },
                    onEnterApp: {
                        setupStartsAtConnection = false
                        launchOverlay = nil
                    }
                )
                .background(Color(.systemBackground))
                .ignoresSafeArea()
                .zIndex(100)
            } else if launchOverlay == .setup {
                OnboardingView(liveStore: liveStore, onComplete: {
                    setupStartsAtConnection = false
                    launchOverlay = nil
                }, glassesStep: launchConfiguration.glassesStep, startsAtConnection: setupStartsAtConnection)
                .environment(container)
                .background(Color(.systemBackground))
                .ignoresSafeArea()
                .zIndex(100)
            }
        }
        .background(TabBarAccessibilityConfigurator(tabs: tabConfiguration.visibleTabs))
        .background(ConversationScreenshotSceneInstaller(provider: conversationScreenshotSnapshot))
        .tint(DesignTokens.accent)
        .onAppear {
            // #589 belt-and-suspenders: ensure the foreground-notification delegate
            // is installed even if the AppDelegate adaptor's didFinishLaunching
            // timing didn't take. Idempotent.
            UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
            configureLaunchLiveIfNeeded()
            refreshTabConfigurationCache()
            frontendTabs.ensureSelectedTabVisible(in: tabConfiguration)
            if ProcessInfo.processInfo.arguments.contains("--pipecat-autoconnect"),
               tabConfiguration.isVisible(.pipecat) {
                frontendTabs.selectedTab = .pipecat
            }
            applyPendingLiveControlCommandIfNeeded()
            // Evaluate auto-present exactly once per launch. onAppear can fire
            // again when tabs re-appear, which otherwise re-toggles the cover.
            if !didEvaluateOnboarding {
                didEvaluateOnboarding = true
                if launchConfiguration.suppressesAutomaticOnboarding {
                    presentOnboarding = false
                }
                if launchOverlay == nil {
                    if launchConfiguration.forcesFirstRunIntroOverlay ||
                        (launchConfiguration.firstRunIntro == .automatic && FirstRunIntroState.shouldAutoPresent()) {
                        presentLaunchOverlayWithoutAnimation(.firstRunIntro)
                    }
                }
            }
        }
        .onChange(of: presentOnboarding) { _, isPresenting in
            // Once onboarding closes, run the deferred keyboard prewarm (skipped
            // earlier so it wouldn't flash onboarding's bottom button).
            if !isPresenting && !didPrewarmKeyboard {
                didPrewarmKeyboard = true
                Task {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    await MainActor.run { KeyboardPrewarm.run() }
                }
            }
        }
        .onChange(of: launchOverlay) { _, overlay in
            if overlay == nil && !presentOnboarding && !didPrewarmKeyboard {
                didPrewarmKeyboard = true
                Task {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    await MainActor.run { KeyboardPrewarm.run() }
                }
            }
        }
        .onChange(of: tabConfigurationRaw) { _, _ in
            refreshTabConfigurationCache()
            frontendTabs.ensureSelectedTabVisible(in: tabConfiguration)
        }
        .onChange(of: legacyTabOrderRaw) { _, _ in
            refreshTabConfigurationCache()
            frontendTabs.ensureSelectedTabVisible(in: tabConfiguration)
        }
        // start() fires on app root so connection runs before any tab is touched.
        .task {
            await container.start()
        }
        // Decode the resumed Live session's transcript once, off the main thread.
        // Kept out of LiveSessionStore.init() so ContentView's @State autoclosure
        // re-running doesn't re-decode the journal on the main thread. (#580)
        .task {
            await liveStore.loadInitialConversationIfNeeded()
        }
        // One-shot keyboard prewarm. After the first UI settle we briefly make a
        // hidden UITextField first responder so the user's first tap on the chat
        // composer doesn't pay UIKit's lazy keyboard-init cost (~200-800ms).
        .task {
            guard !didPrewarmKeyboard else { return }
            try? await Task.sleep(nanoseconds: 400_000_000)
            // Skip the prewarm while intro/setup is up: it briefly makes a hidden
            // text field first responder, which raises+drops the keyboard and
            // shifts the safe area, making the bottom button flash. Run it once
            // the launch overlay is dismissed (still well before the user's
            // first chat tap).
            guard !presentOnboarding, launchOverlay == nil else { return }
            didPrewarmKeyboard = true
            await MainActor.run { KeyboardPrewarm.run() }
        }
        // Reconnect / history-refresh on foreground. Only fires on transitions
        // FROM .inactive or .background TO .active — not on every .active event
        // (e.g. the initial launch is .active without a prior phase, which we skip).
        .onChange(of: scenePhase) { oldPhase, newPhase in
            switch (oldPhase, newPhase) {
            case (.background, .active), (.inactive, .active):
                Task { await container.handleForegroundTransition() }
            case (.active, .inactive), (.active, .background),
                 (.inactive, .background):
                container.noteBackgrounded()
            default:
                break
            }
            liveStore.handleScenePhaseChange(from: oldPhase, to: newPhase)
            if newPhase == .active {
                applyPendingLiveControlCommandIfNeeded()
            }
        }
        .onOpenURL { url in
            handleDeepLink(url)
        }
        .fullScreenCover(isPresented: $presentOnboarding) {
            OnboardingView(liveStore: liveStore, glassesStep: launchConfiguration.glassesStep)
                .environment(container)
        }
    }

    // Cache the decoded+sanitized tab configuration. AppTabConfiguration.load()
    // does a JSON decode plus a multi-pass sanitize() that profiled as the top
    // main-thread hot path once re-run on every ContentView body eval (reconnect
    // churn / tab switches). Decode once; refresh only when the stored raw value
    // changes. (#580)
    @State private var tabConfigurationCache: AppTabConfiguration?

    private var tabConfiguration: AppTabConfiguration {
        tabConfigurationCache ?? AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        )
    }

    private func presentLaunchOverlayWithoutAnimation(_ overlay: LaunchOverlay) {
        var txn = Transaction()
        txn.disablesAnimations = true
        withTransaction(txn) { launchOverlay = overlay }
    }

    private func configureLaunchLiveIfNeeded() {
        guard !didConfigureLaunchLive else { return }
        didConfigureLaunchLive = true
        liveStore.configureMockProviderIfNeeded(launchConfiguration: launchConfiguration)
        liveStore.configureUITestingProviderOverrideIfNeeded()
    }

    private func refreshTabConfigurationCache() {
        tabConfigurationCache = AppTabConfiguration.load(
            encoded: tabConfigurationRaw,
            legacyRaw: legacyTabOrderRaw
        )
    }

    private func applyPendingLiveControlCommandIfNeeded() {
        // The store is the single consumer/executor (phase guards + status feedback);
        // here we only surface the Live tab when it actually handled a pending command.
        // This is the foreground/deep-link fallback for when the instant Darwin path
        // didn't already drain it in the background.
        Task {
            if await liveStore.drainPendingLiveControlCommand() {
                frontendTabs.selectedTab = .live
            }
        }
    }

    private func handleDeepLink(_ url: URL) {
        guard let deepLink = AppDeepLink(url: url) else { return }
        switch deepLink {
        case .live(let route):
            frontendTabs.openLive(route, source: "deep-link")
            if route == .root {
                applyPendingLiveControlCommandIfNeeded()
            }
        case .tab(let tab):
            frontendTabs.open(tab, source: "deep-link")
            if tab == .live {
                applyPendingLiveControlCommandIfNeeded()
            }
        case .chat(let sessionKey):
            frontendTabs.openChat(sessionKey: sessionKey, source: "deep-link")
        case .settings(let route):
            frontendTabs.openSettings(route, source: "deep-link")
        }
    }

    @MainActor
    private func conversationScreenshotSnapshot() async -> ConversationScreenshotSnapshot? {
        switch frontendTabs.selectedTab {
        case .chat:
            return await container.conversationScreenshotSnapshot()
        case .live:
            return liveStore.conversationScreenshotSnapshot()
        default:
            return nil
        }
    }

    @ViewBuilder
    private var tabs: some View {
        // `tabConfiguration` is already sanitized (load() sanitizes), so read
        // `.visibleTabs` directly — `.visibleTabsForRendering` would re-run the
        // expensive sanitize() on every body eval. (#580)
        ForEach(tabConfiguration.visibleTabs) { tab in
            tabView(tab)
        }
    }

    @ViewBuilder
    private func tabView(_ tab: AppTab) -> some View {
        switch tab {
        case .chat:
            chatTab
        case .test:
            testTab
        case .live:
            liveTab
        case .live2:
            live2Tab
        case .pipecat:
            pipecatTab
        case .pipecatRecording:
            pipecatRecordingTab
        case .gptrDemo:
            gptrDemoTab
        case .recording, .glasses:
            // Deprecated standalone tabs (recording, glasses) all folded into
            // Live. They never appear in visibleTabsForRendering
            // (sanitized() drops/remaps them); these cases only satisfy the
            // exhaustive switch.
            liveTab
        case .settings:
            settingsTab
        }
    }

    private var chatTab: some View {
        NavigationStack {
            ChatView()
        }
        .tabItem {
            Label("Chat", systemImage: "message")
                .accessibilityIdentifier("tab.chat")
        }
        .accessibilityIdentifier("screen.chat")
        .tag(AppTab.chat)
    }

    private var testTab: some View {
        NavigationStack {
            TestView()
                .navigationTitle("Probes")
                .navigationBarTitleDisplayMode(.inline)
        }
        .tabItem {
            Label {
                Text(AppTab.test.label)
            } icon: {
                Image("TabIconProbes")
                    .renderingMode(.original)
            }
                .accessibilityIdentifier("tab.test")
        }
        .accessibilityIdentifier("screen.test")
        .tag(AppTab.test)
    }

    private var liveTab: some View {
        NavigationStack {
            LiveView(
                store: liveStore,
                defaultBrokerURL: container.gatewayURL,
                cameraInputMode: true,
                cameraAutostartEnabled: launchConfiguration.cameraAutostartEnabled,
                metaRuntimeEnabled: launchConfiguration.metaRuntimeEnabled
            )
        }
        .tabItem {
            Label {
                Text(AppTab.live.label)
            } icon: {
                Image("TabIconLive")
                    .renderingMode(.original)
            }
                .accessibilityIdentifier("tab.live")
        }
        .accessibilityIdentifier("screen.live")
        .tag(AppTab.live)
    }

    private var live2Tab: some View {
        NavigationStack {
            Live2View()
        }
        .tabItem {
            Label(AppTab.live2.label, systemImage: AppTab.live2.systemImage)
                .accessibilityIdentifier("tab.live2")
        }
        .accessibilityIdentifier("screen.live2")
        .tag(AppTab.live2)
    }

    private var pipecatTab: some View {
        NavigationStack {
            PipecatView()
        }
        .tabItem {
            Label(AppTab.pipecat.label, systemImage: AppTab.pipecat.systemImage)
                .accessibilityIdentifier("tab.pipecat")
        }
        .accessibilityIdentifier("screen.pipecat")
        .tag(AppTab.pipecat)
    }

    private var pipecatRecordingTab: some View {
        NavigationStack {
            PipecatRecordingView()
        }
        .tabItem {
            Label(AppTab.pipecatRecording.label, systemImage: AppTab.pipecatRecording.systemImage)
                .accessibilityIdentifier("tab.pipecatRecording")
        }
        .accessibilityIdentifier("screen.pipecatRecording")
        .tag(AppTab.pipecatRecording)
    }

    private var gptrDemoTab: some View {
        NavigationStack {
            GPTRTranscriptDemoView()
        }
        .tabItem {
            Label(AppTab.gptrDemo.label, systemImage: AppTab.gptrDemo.systemImage)
                .accessibilityIdentifier("tab.gptrDemo")
        }
        .accessibilityIdentifier("screen.gptrDemo")
        .tag(AppTab.gptrDemo)
    }

    private var settingsTab: some View {
        SettingsView()
            .environment(liveStore)
        .tabItem {
            Label {
                Text(AppTab.settings.label)
            } icon: {
                Image("TabIconSettings")
                    .renderingMode(.original)
            }
                .accessibilityIdentifier("tab.settings")
        }
        .accessibilityIdentifier("screen.settings")
        .tag(AppTab.settings)
    }
}

// SwiftUI's tabItem identifiers do not reliably reach UITabBarItem, so stamp
// the UIKit items directly for agent and XCUITest selectors.
private struct TabBarAccessibilityConfigurator: UIViewControllerRepresentable {
    let tabs: [AppTab]

    func makeUIViewController(context: Context) -> Controller {
        Controller(tabs: tabs)
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.tabs = tabs
    }

    final class Controller: UIViewController {
        var tabs: [AppTab] {
            didSet { applyIdentifiers() }
        }

        init(tabs: [AppTab]) {
            self.tabs = tabs
            super.init(nibName: nil, bundle: nil)
            view.isHidden = true
            view.isUserInteractionEnabled = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            applyIdentifiers()
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            applyIdentifiers()
        }

        private func applyIdentifiers() {
            guard let items = activeTabBarController()?.tabBar.items else { return }
            let tabsByLabel = Dictionary(uniqueKeysWithValues: tabs.map { ($0.label, $0) })
            for item in items {
                guard let title = item.title, let tab = tabsByLabel[title] else { continue }
                item.accessibilityLabel = tab.label
                item.accessibilityIdentifier = "tab.\(tab.rawValue)"
            }
        }

        private func activeTabBarController() -> UITabBarController? {
            if let tabBarController {
                return tabBarController
            }

            var current = parent
            while let controller = current {
                if let tabBarController = controller as? UITabBarController {
                    return tabBarController
                }
                current = controller.parent
            }

            return UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow)
                .flatMap { Self.findTabBarController(in: $0.rootViewController) }
        }

        private static func findTabBarController(in controller: UIViewController?) -> UITabBarController? {
            guard let controller else { return nil }
            if let tabBarController = controller as? UITabBarController {
                return tabBarController
            }
            if let presented = findTabBarController(in: controller.presentedViewController) {
                return presented
            }
            for child in controller.children {
                if let tabBarController = findTabBarController(in: child) {
                    return tabBarController
                }
            }
            return nil
        }
    }
}
