import Testing
import Foundation
@testable import hawky

@Suite struct SettingsValidationTests {
    @Test func acceptsHTTP() {
        #expect(validateGatewayURL("http://gateway.example.test:4242"))
    }
    @Test func acceptsHTTPS() {
        #expect(validateGatewayURL("https://gateway.example.com"))
    }
    @Test func acceptsTrailingPath() {
        #expect(validateGatewayURL("http://hao.local:4242/v1"))
    }
    @Test func trimsWhitespace() {
        #expect(validateGatewayURL("  https://x.y  "))
    }
    @Test func rejectsEmpty() {
        #expect(!validateGatewayURL(""))
    }
    @Test func rejectsNonURL() {
        #expect(!validateGatewayURL("not a url"))
    }
    @Test func rejectsWrongScheme() {
        #expect(!validateGatewayURL("ws://hao.local:4242"))
        #expect(!validateGatewayURL("file:///tmp"))
    }
    @Test func rejectsSchemeOnly() {
        #expect(!validateGatewayURL("http://"))
    }

    @Test func defaultTabConfigurationShowsLiveAndSettingsOnly() {
        let config = AppTabConfiguration.load(encoded: "", legacyRaw: "")

        #expect(config.visibleTabs == [.live, .settings])
        #expect(config.hiddenTabs == [.pipecat, .pipecatRecording, .gptrDemo, .chat, .test, .live2])
        #expect(config.developerModeEnabled == false)
    }

    @Test func legacyTabOrderMigratesWithoutLosingProbes() {
        let config = AppTabConfiguration.load(encoded: "", legacyRaw: AppTabOrder.testFirst.rawValue)

        // The legacy order lists both .live and .recording; recording collapses
        // into live, and developer-mode-only tabs stay hidden unless explicitly
        // surfaced by migration.
        #expect(config.visibleTabs == [.test, .chat, .live, .pipecat, .settings])
        #expect(config.hiddenTabs == [.live2, .pipecatRecording, .gptrDemo])
        #expect(config.developerModeEnabled)
    }

    @Test func tabConfigurationCanHideAndReorderVisibleTabs() {
        var config = AppTabConfiguration.defaultValue
        config.show(.chat)
        config.setDeveloperModeEnabled(true)
        config.moveVisibleTabs(from: IndexSet(integer: 0), to: 2)
        config.hide(.test)

        #expect(config.visibleTabs == [.chat, .live, .settings])
        #expect(config.hiddenTabs == [.pipecat, .pipecatRecording, .gptrDemo, .live2, .test])
        #expect(config.developerModeEnabled)
    }

    @Test func savedLive2TabRequiresDeveloperMode() {
        let rawConfig = AppTabConfiguration(
            visibleTabs: [.chat, .live2, .settings],
            hiddenTabs: [.test, .live],
            developerModeEnabled: false
        ).encodedStorageValue
        let config = AppTabConfiguration.load(encoded: rawConfig, legacyRaw: "")

        #expect(config.visibleTabs == [.chat, .settings])
        #expect(config.hiddenTabs == [.test, .live, .live2, .pipecat, .pipecatRecording, .gptrDemo])
        #expect(config.developerModeEnabled == false)
    }

    @Test func appDeepLinksParseTabRoutes() throws {
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://live"))) == .live(.root))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://tab/live2"))) == .tab(.live2))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://pipecat"))) == .tab(.pipecat))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://gptr"))) == .tab(.gptrDemo))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://probes"))) == .tab(.test))
    }

    @Test func appDeepLinksParseLiveRoutes() throws {
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://recordings"))) == .live(.recordings))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://live/recordings"))) == .live(.recordings))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://live/summary"))) == .live(.summary))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://live/glasses"))) == .live(.glasses))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://live/status"))) == .live(.status))
    }

    @Test func appDeepLinksParseSettingsRoutes() throws {
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://settings/connection"))) == .settings(.connection))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://settings/app-layout"))) == .settings(.layout))
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://settings/notification-sessions"))) == .settings(.notificationSessions))
        #expect(SettingsRoute.notificationSessions.navigationPath == [.notifications, .notificationSessions])
    }

    @Test func appDeepLinksRejectUnknownRoutes() throws {
        #expect(AppDeepLink(url: try #require(URL(string: "https://example.com/settings"))) == nil)
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://tab/not-a-tab"))) == nil)
        #expect(AppDeepLink(url: try #require(URL(string: "hawky://not-a-route"))) == nil)
    }

    @Test func seedProfilesParseEnvironmentValues() {
        #expect(LaunchConfiguration.SeedProfile(environmentValue: nil) == .empty)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "") == .empty)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "chat-populated") == .chatPopulated)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "chat_populated") == .chatPopulated)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "sessions") == .sessions)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "mixed") == .mixed)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "error") == .error)
        #expect(LaunchConfiguration.SeedProfile(environmentValue: "unknown") == .empty)
    }

    @MainActor
    @Test func launchSeedFixturesProvideDeterministicMixedContent() {
        let data = LaunchSeedFixtures.data(for: .mixed, fallbackSession: uiTestSeededSession)

        #expect(data.sessions.map(\.key).contains("ios:research"))
        #expect(data.messages(for: "ios:main").map(\.text).contains("Seeded assistant response with deterministic content."))
        #expect(data.messages(for: "ios:research").map(\.text).contains("Research session assistant answer."))
        #expect(data.messages(for: "ios:main").first?.id.uuidString == "00000000-0000-0000-0000-000000000101")
    }

    @MainActor
    @Test func seededLocalContainerSwitchesSessionsWithoutGateway() async throws {
        let container = AppContainer(launchConfiguration: uiTestLaunchConfiguration(seed: .mixed))

        await container.start()

        #expect(container.sessionStore.sessions.count == 4)
        #expect(container.chatStore.messages.map(\.text).contains("Seeded assistant response with deterministic content."))

        try await container.switchSession(to: "ios:research")

        #expect(container.sessionStore.activeSessionKey == "ios:research")
        #expect(container.chatStore.messages.map(\.text).contains("Research session assistant answer."))
    }

    @Test func savedGlassesTabIsDroppedAfterMerge() {
        // Existing installs that still have the standalone Glasses tab in their
        // saved configuration must migrate cleanly: glasses is dropped from
        // both visible and hidden, nothing else lost.
        let rawConfig = AppTabConfiguration(
            visibleTabs: [.chat, .live, .glasses, .settings],
            hiddenTabs: [.test],
            developerModeEnabled: false
        ).encodedStorageValue
        let config = AppTabConfiguration.load(encoded: rawConfig, legacyRaw: "")

        #expect(!config.visibleTabs.contains(.glasses))
        #expect(!config.hiddenTabs.contains(.glasses))
        #expect(config.visibleTabs == [.chat, .live, .settings])
        #expect(config.hiddenTabs.contains(.pipecat))
        #expect(config.hiddenTabs.contains(.pipecatRecording))
        #expect(config.hiddenTabs.contains(.gptrDemo))
    }

    @Test func savedRecordingTabMigratesIntoLive() {
        // The standalone Recording tab was removed; recording now happens inside
        // Live. Saved configurations referencing "recording" must collapse it
        // into Live without duplicating Live or leaving a phantom tab.
        let rawConfig = AppTabConfiguration(
            visibleTabs: [.chat, .live, .recording, .settings],
            hiddenTabs: [.test],
            developerModeEnabled: false
        ).encodedStorageValue
        let config = AppTabConfiguration.load(encoded: rawConfig, legacyRaw: "")

        #expect(!config.visibleTabs.contains(.recording))
        #expect(!config.hiddenTabs.contains(.recording))
        #expect(config.visibleTabs == [.chat, .live, .settings])
    }

    @Test func savedRecordingTabWithoutLiveStillYieldsSingleLive() {
        // A saved config that had Recording visible but Live hidden (an older
        // layout) must still surface exactly one Live tab after migration.
        let rawConfig = AppTabConfiguration(
            visibleTabs: [.chat, .recording, .settings],
            hiddenTabs: [.test, .live],
            developerModeEnabled: false
        ).encodedStorageValue
        let config = AppTabConfiguration.load(encoded: rawConfig, legacyRaw: "")

        #expect(config.visibleTabs.filter { $0 == .live }.count == 1)
        #expect(!config.visibleTabs.contains(.recording))
        #expect(config.visibleTabs == [.chat, .live, .settings])
    }

    @Test func realtimeDemoTabsRequireDeveloperMode() {
        for tab in [AppTab.pipecat, .pipecatRecording, .gptrDemo] {
            var config = AppTabConfiguration(
                visibleTabs: [.live, tab, .settings],
                hiddenTabs: [],
                developerModeEnabled: false
            )

            config = config.sanitized()

            #expect(!config.visibleTabs.contains(tab))
            #expect(config.hiddenTabs.contains(tab))
            #expect(!config.isVisible(tab))
        }
    }

    @Test func hiddenRealtimeDemoTabsCannotBeShownWithoutDeveloperMode() {
        for tab in [AppTab.pipecat, .pipecatRecording, .gptrDemo] {
            var config = AppTabConfiguration.defaultValue

            config.show(tab)

            #expect(!config.visibleTabs.contains(tab))
            #expect(config.hiddenTabs.contains(tab))
            #expect(config.developerModeEnabled == false)
        }
    }

    @Test func backgroundCapturePolicyDefaultsReleaseSafe() {
        #expect(BackgroundCapturePolicy.defaultPolicy == .off)
        #expect(BackgroundCapturePolicy(storedValue: "") == .off)
        #expect(BackgroundCapturePolicy(storedValue: "unknown") == .off)
    }

    @Test func backgroundCapturePolicyDecodesAudioOnly() {
        let policy = BackgroundCapturePolicy(storedValue: "audio_only")
        #expect(policy == .audioOnly)
        #expect(policy.allowsBackgroundAudio)
    }

    @Test func onboardingAutoPresentsOnlyForFreshInstall() {
        let suiteName = "onboarding-fresh-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(OnboardingState.shouldAutoPresent(defaults: defaults))

        defaults.set("http://gateway.example.test:4242", forKey: "gatewayURL")
        #expect(!OnboardingState.shouldAutoPresent(defaults: defaults))
    }

    @Test func onboardingCompletedSuppressesFutureAutoPresentation() {
        let suiteName = "onboarding-complete-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        OnboardingState.markCompleted(defaults: defaults)

        #expect(!OnboardingState.shouldAutoPresent(defaults: defaults))
        #expect(defaults.bool(forKey: OnboardingState.completedKey))
        #expect(!defaults.bool(forKey: OnboardingState.skippedKey))
        #expect(!defaults.bool(forKey: OnboardingState.presentKey))
    }

    @Test func firstRunIntroAutoPresentsOnlyUntilCompleted() {
        let suiteName = "first-run-intro-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(FirstRunIntroState.shouldAutoPresent(defaults: defaults))

        FirstRunIntroState.markCompleted(defaults: defaults)

        #expect(!FirstRunIntroState.shouldAutoPresent(defaults: defaults))
        #expect(defaults.bool(forKey: FirstRunIntroState.completedKey))
        #expect(!defaults.bool(forKey: FirstRunIntroState.presentKey))
    }

    @Test func liveKeepRunningOffscreenDefaultsOff() {
        let suiteName = "live-offscreen-defaults-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let config = LiveProfileDefaults.load(defaults: defaults)

        #expect(config.keepRunningOffscreen == false)
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func liveKeepRunningOffscreenPersists() {
        let suiteName = "live-offscreen-persists-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        var config = LiveSessionConfig()
        config.keepRunningOffscreen = true

        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.keepRunningOffscreen)
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func liveGatewayBridgeRequiredDefaultsOff() {
        let suiteName = "live-bridge-required-defaults-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let config = LiveProfileDefaults.load(defaults: defaults)

        // Default: an unreachable gateway warns but still connects to OpenAI.
        #expect(config.gatewayBridgeRequired == false)
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func liveGatewayBridgeRequiredPersists() {
        let suiteName = "live-bridge-required-persists-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        var config = LiveSessionConfig()
        config.gatewayBridgeRequired = true

        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.gatewayBridgeRequired)
        defaults.removePersistentDomain(forName: suiteName)
    }

    // Core of the bug fix: how a gateway reachability result maps to session state.
    @Test func bridgeReachableProducesConnected() {
        #expect(LiveSessionStore.bridgeStartDecision(for: .skipped, required: false) == .connected)
        #expect(LiveSessionStore.bridgeStartDecision(for: .skipped, required: true) == .connected)
    }

    @Test func bridgeUnreachableDefaultModeContinuesOffline() {
        // required OFF: an unreachable gateway warns but the session still connects.
        #expect(
            LiveSessionStore.bridgeStartDecision(for: .failed("handshake timeout"), required: false)
                == .offline("handshake timeout")
        )
    }

    @Test func bridgeUnreachableRequiredModeHardFails() {
        // required ON: an unreachable gateway aborts the start with the cause attached.
        #expect(
            LiveSessionStore.bridgeStartDecision(for: .failed("handshake timeout"), required: true)
                == .requiredFailure("handshake timeout")
        )
    }

    @Test func transcriptAppendUsesActiveRuntimeConfigWhenDraftChanges() throws {
        var active = LiveSessionConfig()
        active.gatewayBridgeSessionKey = " realtime:A "
        active.mode = .ambient

        var draft = active
        draft.gatewayBridgeSessionKey = "realtime:B"
        draft.mode = .quiet

        let target = try #require(
            LiveSessionStore.transcriptAppendRuntimeTarget(activeConfig: active, draftConfig: draft)
        )

        #expect(target.sessionKey == "realtime:A")
        #expect(target.modeRaw == AmbientMode.ambient.rawValue)
    }

    @Test func transcriptAppendFallsBackToDraftOnlyWhenIdle() throws {
        var draft = LiveSessionConfig()
        draft.gatewayBridgeSessionKey = " realtime:draft "
        draft.mode = .ambient

        let target = try #require(
            LiveSessionStore.transcriptAppendRuntimeTarget(activeConfig: nil, draftConfig: draft)
        )

        #expect(target.sessionKey == "realtime:draft")
        #expect(target.modeRaw == AmbientMode.ambient.rawValue)

        draft.mode = .quiet
        #expect(LiveSessionStore.transcriptAppendRuntimeTarget(activeConfig: nil, draftConfig: draft) == nil)
    }

    @Test func bridgeAvailabilityMapsFromStartDecision() {
        #expect(LiveSessionStore.bridgeAvailability(for: .connected) == .available)
        #expect(LiveSessionStore.bridgeAvailability(for: .offline("timeout")) == .offline("timeout"))
        #expect(LiveSessionStore.bridgeAvailability(for: .requiredFailure("timeout")) == .offline("timeout"))
    }

    @Test func bridgeToolsAreExposedOnlyWhenBridgeIsAvailable() {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.cocktailPartyEnabled = true
        config.bridgeAvailability = .available
        let bridgeBackedToolNames = [
            "session_get_info",
            "session_send_message",
            "send_photo",
            "memory_search",
            "memory_append",
            "create_intention",
            "scan_intention",
            "intention_respond",
            "identify_person",
            "list_people",
            "recall_person",
            "update_person_profile",
            "confirm_identity_candidate",
            "reject_identity_candidate",
        ]

        let availableNames = Set(LiveToolRegistry.default.definitions(config: config).compactMap { $0["name"] as? String })
        #expect(availableNames.contains("get_current_time"))
        for name in bridgeBackedToolNames {
            #expect(availableNames.contains(name))
        }

        config.bridgeAvailability = .offline("handshake timeout")
        let offlineNames = Set(LiveToolRegistry.default.definitions(config: config).compactMap { $0["name"] as? String })
        #expect(offlineNames.contains("get_current_time"))
        for name in bridgeBackedToolNames {
            #expect(!offlineNames.contains(name))
        }
    }

    // De-productization (#694): the get_live_session_settings payload exposes the
    // gateway bridge status under gateway_* keys, not the old hawky_* names.
    @MainActor
    @Test func liveSessionSettingsToolUsesGatewayPrefixedKeys() async {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .available
        let context = LiveToolContext(config: config, gatewayBridge: nil, awaitPendingTranscriptAppend: nil)

        let json = await LiveToolRegistry.default.execute(
            name: "get_live_session_settings",
            argumentsJSON: "{}",
            context: context
        )

        #expect(json.contains("\"gateway_bridge_enabled\""))
        #expect(json.contains("\"gateway_bridge_availability\""))
        #expect(json.contains("\"gateway_session_key\""))
        #expect(json.contains("\"gateway_feed_mode\""))
        #expect(!json.contains("hawky_"))
    }

    @Test func offlineBridgeInstructionsReplaceBridgeToolContract() {
        var config = LiveSessionConfig()
        config.gatewayBridgeEnabled = true
        config.bridgeAvailability = .offline("handshake timeout")

        let instructions = config.resolvedInstructions

        #expect(instructions.contains("HAWKY BRIDGE OFFLINE"))
        #expect(instructions.contains("handshake timeout"))
        #expect(!instructions.contains("You can collaborate with a separate Hawky background agent through local tools."))
    }

    // Feed reconnect backoff: a real connection that drops retries fast; a flap grows.
    @Test func reconnectBackoffResetsAfterAStableConnection() {
        // Healthy past the stability threshold → back to the fast floor.
        #expect(LiveSessionStore.nextReconnectBackoff(healthyFor: 30, current: 8)
            == LiveSessionStore.bridgeReconnectInitialBackoff)
    }

    @Test func reconnectBackoffGrowsOnFlapAndHardDown() {
        // Never connected this attempt (hard down) → grow.
        #expect(LiveSessionStore.nextReconnectBackoff(healthyFor: 0, current: 1) == 2)
        // Connected but closed before the threshold (flap) → still grow.
        #expect(LiveSessionStore.nextReconnectBackoff(healthyFor: 2, current: 4) == 8)
    }

    @Test func reconnectBackoffCapsAtMax() {
        #expect(LiveSessionStore.nextReconnectBackoff(healthyFor: 0, current: 8)
            == LiveSessionStore.bridgeReconnectMaxBackoff)
        #expect(LiveSessionStore.nextReconnectBackoff(healthyFor: 0, current: 15)
            == LiveSessionStore.bridgeReconnectMaxBackoff)
    }

    @Test func liveOpenAIDirectFallbackSettingsPersist() {
        let suiteName = "live-openai-direct-persists-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        var config = LiveSessionConfig()
        config.provider = .openAIRealtime
        config.openAICredentialMode = .directAPIKey
        config.openAIModelPreset = .realtime2
        config.model = LiveOpenAIModelPreset.realtime2.model

        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.openAICredentialMode == .directAPIKey)
        #expect(reloaded.openAIModelPreset == .realtime2)
        #expect(reloaded.model == "gpt-realtime-2")
        defaults.removePersistentDomain(forName: suiteName)
    }

    @Test func liveVisualSettingsPersistForOpenAIRealtime() {
        let suiteName = "live-openai-visual-persists-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var config = LiveSessionConfig()
        config.provider = .openAIRealtime
        config.visualSource = .iPhoneCamera
        config.visualCadence = .fps0_5
        config.cameraPosition = .front

        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.provider == .openAIRealtime)
        #expect(reloaded.visualSource == .iPhoneCamera)
        #expect(reloaded.visualCadence == .fps0_5)
        #expect(reloaded.cameraPosition == .front)
        #expect(reloaded.effectiveVisualFPS == 0.5)
    }

    @Test func liveMediaPersistenceDefaultIsFilledOnlyWhenAbsent() {
        let suiteName = "live-media-default-absent-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(LiveProviderKind.openAIRealtime.rawValue, forKey: "live.provider")

        let config = LiveProfileDefaults.load(defaults: defaults)

        #expect(config.mediaPersistenceMode == .local)
        #expect(defaults.string(forKey: "live.mediaPersistenceMode") == LiveMediaPersistenceMode.local.rawValue)
    }

    @Test func liveMediaPersistenceMigrationPreservesExplicitOff() {
        let suiteName = "live-media-explicit-off-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(LiveProviderKind.openAIRealtime.rawValue, forKey: "live.provider")
        defaults.set(LiveMediaPersistenceMode.off.rawValue, forKey: "live.mediaPersistenceMode")

        let config = LiveProfileDefaults.load(defaults: defaults)

        #expect(config.mediaPersistenceMode == .off)
        #expect(defaults.string(forKey: "live.mediaPersistenceMode") == LiveMediaPersistenceMode.off.rawValue)
    }
}

private let uiTestSeededSession = LaunchConfiguration.SeededSession(
    connectionID: "ui-testing",
    sessionKey: "ios:main",
    displayName: "main"
)

private func uiTestLaunchConfiguration(seed: LaunchConfiguration.SeedProfile) -> LaunchConfiguration {
    LaunchConfiguration(
        onboarding: .completed,
        firstRunIntro: .completed,
        glassesStep: .staticPreview,
        gateway: .seededLocal,
        liveProvider: .configured,
        intro: .disabled,
        metaRuntimeEnabled: false,
        cameraAutostartEnabled: false,
        animationsEnabled: false,
        seedProfile: seed,
        seededSession: uiTestSeededSession,
        defaultGatewayURLString: "http://127.0.0.1:4242",
        defaultDeviceName: "ui-test-simulator",
        tabConfigurationOverride: nil
    )
}
