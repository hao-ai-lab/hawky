import Foundation

#if DEBUG

enum UITestingSupport {
    static let launchArgument = "--uitesting"
    static let onboardingLaunchArgument = "--uitesting-onboarding"
    static let firstRunIntroLaunchArgument = "--uitesting-first-run-intro"
    static let enabledEnvironmentKey = "IOS_UI_TESTING"
    static let tabsEnvironmentKey = "IOS_UI_TESTING_TABS"
    static let onboardingEnvironmentKey = "IOS_UI_TESTING_ONBOARDING"
    static let firstRunIntroEnvironmentKey = "IOS_UI_TESTING_FIRST_RUN_INTRO"
    static let liveMockEnvironmentKey = "IOS_UI_TESTING_LIVE_MOCK"
    /// Pins the Live provider for deterministic error-path tests without touching
    /// the network. Values: "gemini" / "custom" (preflight-blocked providers) and
    /// "auth-fail" (openAIRealtime whose connect 401s via a stub).
    static let liveProviderEnvironmentKey = "IOS_UI_TESTING_LIVE_PROVIDER"
    static let seedEnvironmentKey = "JC_SEED"
    static let legacySeedEnvironmentKey = "IOS_UI_TESTING_SEED"
    static let enabledEnvironmentValue = "1"
    static let gatewayURLString = "http://127.0.0.1:4242"
    static let deviceName = "ui-test-simulator"
    static let connectionID = "ui-testing"
    static let seededSessionKey = "ios:main"
    static let seededSessionDisplayName = "main"

    static var isEnabled: Bool {
        isEnabled(processInfo: .processInfo)
    }

    static func launchConfiguration(processInfo: ProcessInfo = .processInfo) -> LaunchConfiguration? {
        guard isEnabled(processInfo: processInfo) else { return nil }

        let onboarding: LaunchConfiguration.OnboardingMode =
            showsOnboarding(processInfo: processInfo) ? .forceFirstRun : .completed
        let firstRunIntro: LaunchConfiguration.FirstRunIntroMode =
            showsFirstRunIntro(processInfo: processInfo) && !showsOnboarding(processInfo: processInfo)
            ? .forceFirstRun
            : .completed

        return LaunchConfiguration(
            onboarding: onboarding,
            firstRunIntro: firstRunIntro,
            glassesStep: .staticPreview,
            gateway: .seededLocal,
            liveProvider: usesMockLiveProvider(processInfo: processInfo) ? .mock : .configured,
            intro: .disabled,
            metaRuntimeEnabled: false,
            cameraAutostartEnabled: false,
            animationsEnabled: false,
            seedProfile: seedProfile(processInfo: processInfo),
            seededSession: .init(
                connectionID: connectionID,
                sessionKey: seededSessionKey,
                displayName: seededSessionDisplayName
            ),
            defaultGatewayURLString: gatewayURLString,
            defaultDeviceName: deviceName,
            tabConfigurationOverride: tabConfiguration(processInfo: processInfo)
        )
    }

    static func isEnabled(processInfo: ProcessInfo) -> Bool {
        return processInfo.arguments.contains(launchArgument)
            || processInfo.environment[enabledEnvironmentKey] == enabledEnvironmentValue
    }

    static func showsOnboarding(processInfo: ProcessInfo) -> Bool {
        guard isEnabled(processInfo: processInfo) else { return false }
        return processInfo.arguments.contains(onboardingLaunchArgument)
            || processInfo.environment[onboardingEnvironmentKey] == enabledEnvironmentValue
    }

    static func showsFirstRunIntro(processInfo: ProcessInfo) -> Bool {
        guard isEnabled(processInfo: processInfo) else { return false }
        return processInfo.arguments.contains(firstRunIntroLaunchArgument)
            || processInfo.environment[firstRunIntroEnvironmentKey] == enabledEnvironmentValue
    }

    static func usesMockLiveProvider(processInfo: ProcessInfo) -> Bool {
        guard isEnabled(processInfo: processInfo) else { return false }
        return processInfo.environment[liveMockEnvironmentKey] == enabledEnvironmentValue
    }

    /// The pinned Live provider override (lowercased), or nil when none is set.
    static func liveProviderOverride(processInfo: ProcessInfo = .processInfo) -> String? {
        guard isEnabled(processInfo: processInfo) else { return nil }
        let raw = processInfo.environment[liveProviderEnvironmentKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return (raw?.isEmpty == false) ? raw : nil
    }

    /// Whether to simulate an OpenAI auth (401) failure on connect.
    static func forcesLiveAuthFailure(processInfo: ProcessInfo = .processInfo) -> Bool {
        liveProviderOverride(processInfo: processInfo) == "auth-fail"
    }

    static func seedProfile(processInfo: ProcessInfo) -> LaunchConfiguration.SeedProfile {
        let raw = processInfo.environment[seedEnvironmentKey]
            ?? processInfo.environment[legacySeedEnvironmentKey]
        return LaunchConfiguration.SeedProfile(environmentValue: raw)
    }

    private static func tabConfiguration(processInfo: ProcessInfo) -> AppTabConfiguration {
        let rawTabs = processInfo.environment[tabsEnvironmentKey] ?? ""
        let requestedTabs = rawTabs
            .split(separator: ",")
            .compactMap { rawTab -> AppTab? in
                let value = String(rawTab)
                return AppTab.frontendValue(value) ?? AppTab(rawValue: value)
            }
            .filter { $0 != .settings }

        guard !requestedTabs.isEmpty else {
            return AppTabConfiguration.defaultValue
        }

        let visibleTabs = uniqueTabs(requestedTabs)
        let hiddenTabs = AppTab.allCases.filter { !visibleTabs.contains($0) && $0 != .settings }
        return AppTabConfiguration(
            visibleTabs: visibleTabs + [.settings],
            hiddenTabs: hiddenTabs,
            developerModeEnabled: true
        )
    }

    private static func uniqueTabs(_ tabs: [AppTab]) -> [AppTab] {
        var seen = Set<AppTab>()
        return tabs.filter { seen.insert($0).inserted }
    }
}

#endif
