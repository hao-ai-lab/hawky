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

    // MARK: - #18 live turn-taking cadence defaults

    /// #18: a fresh install now defaults to semantic VAD (eagerness auto) so short
    /// mid-sentence pauses don't trigger a reply.
    @Test func liveTurnDetectionDefaultsToSemanticVAD() {
        let suiteName = "live-turn-default-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let config = LiveProfileDefaults.load(defaults: defaults)

        #expect(config.turnDetectionMode == .semanticVAD)
        #expect(config.semanticVADEagerness == .auto)
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// #18 (review finding, line 1645): a LEGACY install's persisted `server_vad`
    /// is genuinely ambiguous — it is indistinguishable from a deliberate Server VAD
    /// choice, since the old build persisted the default too. Silently flipping it
    /// would stomp a real user choice, so the fix PRESERVES the stored value on a
    /// legacy install (detected via the provider key the old `save` always wrote).
    /// The new semantic default reaches only fresh installs.
    @Test func liveTurnDetectionPreservesLegacyServerVADChoice() {
        let suiteName = "live-turn-legacy-preserve-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        // Simulate a pre-#18 legacy install: provider key present (every old `save`
        // wrote it) AND server_vad persisted, migration flag absent.
        defaults.set(LiveProviderKind.openAIRealtime.rawValue, forKey: "live.provider")
        defaults.set(LiveTurnDetectionMode.serverVAD.rawValue, forKey: "live.turnDetectionMode")

        let loaded = LiveProfileDefaults.load(defaults: defaults)
        // NOT stomped to semantic_vad: the legacy choice survives.
        #expect(loaded.turnDetectionMode == .serverVAD)
    }

    /// #18: an ORPHANED `server_vad` key with NO provider key is treated as a fresh
    /// install (fail-closed: it never ran the old build's `save`, which would have
    /// written the provider key), so it takes the new semantic default rather than a
    /// stale VAD value. Guards against the fix accidentally honoring stray keys.
    @Test func liveTurnDetectionIgnoresOrphanedServerVADOnFreshInstall() {
        let suiteName = "live-turn-orphan-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        // No provider key -> not a legacy install -> orphaned VAD key ignored.
        defaults.set(LiveTurnDetectionMode.serverVAD.rawValue, forKey: "live.turnDetectionMode")

        let loaded = LiveProfileDefaults.load(defaults: defaults)
        #expect(loaded.turnDetectionMode == .semanticVAD)
    }

    /// #18: a user who DELIBERATELY picks Server VAD and saves keeps it across
    /// reloads. A full `save` writes the provider key, so the reload sees a legacy
    /// install and honors the stored value.
    @Test func liveTurnDetectionDeliberateServerVADSurvivesReload() {
        let suiteName = "live-turn-deliberate-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        var config = LiveSessionConfig()
        config.turnDetectionMode = .serverVAD
        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.turnDetectionMode == .serverVAD)
    }

    /// #18: the response cap now defaults to a voice-friendly 800 tokens.
    @Test func liveMaxResponseTokensDefaultsToVoiceCap() {
        let suiteName = "live-maxtok-default-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let config = LiveProfileDefaults.load(defaults: defaults)

        #expect(config.maxResponseOutputTokens == 800)
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// #18: a deliberate "unlimited" (nil) choice must survive a save/reload — it is
    /// persisted as the sentinel 0 so it is distinct from a never-set fresh install
    /// (which would otherwise re-apply the 800 default).
    @Test func liveMaxResponseTokensUnlimitedSurvivesReload() {
        let suiteName = "live-maxtok-unlimited-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        var config = LiveSessionConfig()
        config.maxResponseOutputTokens = nil

        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.maxResponseOutputTokens == nil)
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// #18 (review finding, line 1710): a LEGACY install whose user had chosen
    /// "Unlimited" on the OLD build has NO persisted token key (old `save` did
    /// removeObject for nil). Resolving an absent key to the new 800 default would
    /// silently cap them. The fix detects the legacy install (provider key present)
    /// and resolves an absent token key to nil (unlimited), preserving old behavior.
    @Test func liveMaxResponseTokensLegacyUnlimitedStaysUnlimited() {
        let suiteName = "live-maxtok-legacy-unlimited-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        // Legacy install: provider key present, NO token key (old nil-as-absent).
        defaults.set(LiveProviderKind.openAIRealtime.rawValue, forKey: "live.provider")

        let loaded = LiveProfileDefaults.load(defaults: defaults)
        // NOT silently capped at 800: the old "unlimited" behavior is preserved.
        #expect(loaded.maxResponseOutputTokens == nil)
    }

    /// #18 (review finding, line 1731): the legacy-unlimited resolution must be
    /// COMMITTED to disk on first load, not re-derived every time. The two legacy
    /// token states are byte-identical on disk, so the chosen resolution has to be
    /// persisted (sentinel 0) to (a) make the migration idempotent/durable and (b)
    /// stop a future change to the legacy-detection heuristic from silently
    /// re-deciding. After the first load the token key is present, so a SECOND load
    /// takes the concrete sentinel-0 branch — independent of `isLegacyInstall` — and
    /// still resolves to nil (unlimited).
    @Test func liveMaxResponseTokensLegacyUnlimitedIsPersistedForward() {
        let suiteName = "live-maxtok-legacy-persist-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        // Legacy install: provider key present, NO token key.
        defaults.set(LiveProviderKind.openAIRealtime.rawValue, forKey: "live.provider")
        #expect(defaults.object(forKey: "live.maxResponseOutputTokens") == nil)

        let first = LiveProfileDefaults.load(defaults: defaults)
        #expect(first.maxResponseOutputTokens == nil)
        // The resolution is now committed as the sentinel 0, not left absent.
        #expect(defaults.object(forKey: "live.maxResponseOutputTokens") != nil)
        #expect(defaults.integer(forKey: "live.maxResponseOutputTokens") == 0)

        // A second load reaches the concrete sentinel-0 branch and still yields nil,
        // even if we now remove the provider key (heuristic can no longer re-decide).
        defaults.removeObject(forKey: "live.provider")
        let second = LiveProfileDefaults.load(defaults: defaults)
        #expect(second.maxResponseOutputTokens == nil)
    }

    /// #18 (review finding, line 1665): the vestigial semantic-VAD migration version
    /// key was removed. It was written-but-never-read, so it did nothing functional
    /// while inviting a future dev to treat it as a real one-time guard. Regression:
    /// a fresh load must NOT resurrect any `live.turnDetection.semanticDefault.v1`
    /// key (the legacy-vs-fresh discrimination is done entirely by provider-key
    /// presence, and the flip is idempotent by construction).
    @Test func liveSemanticVADMigrationKeyIsNotWritten() {
        let suiteName = "live-turn-nokey-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        _ = LiveProfileDefaults.load(defaults: defaults)

        #expect(defaults.object(forKey: "live.turnDetection.semanticDefault.v1") == nil)
    }

    /// #18: a FRESH install (no provider key, no token key) takes the new 800 voice
    /// default — the legacy-unlimited preservation must not leak into fresh installs.
    @Test func liveMaxResponseTokensFreshInstallTakesVoiceDefault() {
        let suiteName = "live-maxtok-fresh-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let loaded = LiveProfileDefaults.load(defaults: defaults)
        #expect(loaded.maxResponseOutputTokens == 800)
    }

    /// #18: an explicit numeric cap round-trips and is clamped to the valid range.
    @Test func liveMaxResponseTokensNumericCapPersists() {
        let suiteName = "live-maxtok-numeric-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        var config = LiveSessionConfig()
        config.maxResponseOutputTokens = 1_200

        LiveProfileDefaults.save(config, defaults: defaults)
        let reloaded = LiveProfileDefaults.load(defaults: defaults)

        #expect(reloaded.maxResponseOutputTokens == 1_200)
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// #18: the WebRTC `session.update` cap value maps nil -> "inf" and a numeric
    /// cap -> a whole number (integer-only field in the Realtime API). MainActor
    /// because the provider (and thus its static helper) is MainActor-isolated.
    @MainActor
    @Test func liveWebRTCMaxResponseTokensValueMapping() {
        var config = LiveSessionConfig()

        config.maxResponseOutputTokens = 800
        #expect(
            PipecatOpenAIRealtimeLiveSessionProvider.maxResponseOutputTokensValue(config: config)
                == .number(800))

        config.maxResponseOutputTokens = nil
        #expect(
            PipecatOpenAIRealtimeLiveSessionProvider.maxResponseOutputTokensValue(config: config)
                == .string("inf"))

        // Above-range caps clamp to 4096 rather than being forwarded verbatim.
        config.maxResponseOutputTokens = 99_999
        #expect(
            PipecatOpenAIRealtimeLiveSessionProvider.maxResponseOutputTokensValue(config: config)
                == .number(4096))
    }

    /// #18 (review finding, line 2123): the gateway-BROKER client-secret mint path
    /// must NOT send `max_response_output_tokens`, matching the direct mint path.
    /// The GA `/v1/realtime/client_secrets` session schema rejects it, so leaving it
    /// on the broker path was a latent inconsistency that would resurface the mint
    /// rejection if a future broker refactor stopped stripping it. The cap is applied
    /// by the post-connect `session.update` instead. MainActor because the provider
    /// (and thus its static helper) is MainActor-isolated.
    @MainActor
    @Test func liveBrokerClientSecretBodyOmitsMaxResponseOutputTokens() {
        var config = LiveSessionConfig()
        config.maxResponseOutputTokens = 800
        let body = OpenAIRealtimeLiveSessionProvider.brokerClientSecretBody(config: config)
        #expect(body["max_response_output_tokens"] == nil)

        // Even an explicit "unlimited" (nil) must not resurrect the field.
        config.maxResponseOutputTokens = nil
        let unlimitedBody = OpenAIRealtimeLiveSessionProvider.brokerClientSecretBody(config: config)
        #expect(unlimitedBody["max_response_output_tokens"] == nil)
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

    @Test func transcriptAppendIsDisabledForRecordSuppressedSessions() {
        // The enrollment listening session sets conversationJournalingEnabled
        // false: the user's enrollment monologue must never append to the
        // gateway session transcript, even in ambient mode.
        var active = LiveSessionConfig()
        active.gatewayBridgeSessionKey = "realtime:enroll"
        active.mode = .ambient
        active.conversationJournalingEnabled = false

        #expect(
            LiveSessionStore.transcriptAppendRuntimeTarget(activeConfig: active, draftConfig: LiveSessionConfig()) == nil
        )
    }

    @Test func conversationRecordSuppressionFollowsActiveConfigAndFailsOpenByDefault() {
        // FAIL-CLOSED default the right way around: a default config journals
        // (nothing is suppressed unless an override asks for it)…
        let draft = LiveSessionConfig()
        #expect(!LiveSessionStore.conversationRecordSuppressed(activeConfig: nil, draftConfig: draft))

        // …and the ACTIVE session snapshot wins over the draft, so a mid-session
        // settings edit can never flip journaling for the running session.
        var active = draft
        active.conversationJournalingEnabled = false
        #expect(LiveSessionStore.conversationRecordSuppressed(activeConfig: active, draftConfig: draft))
        #expect(!LiveSessionStore.conversationRecordSuppressed(activeConfig: draft, draftConfig: active))
    }

    @Test func widgetDetailLineIsSuppressedWhenTheRecordIsSuppressed() {
        // Regression: appendSystemMessage used to persist the free-text detailLine
        // ("Connecting OpenAI…", the bridge session key, "Session stopped") to the
        // cross-process WidgetStatusStore / lock-screen widget UNCONDITIONALLY,
        // even during the silent owner-voiceprint enrollment session whose whole
        // purpose is to leave no trace. The persist gate must follow the same
        // record-suppression latch as the chat record.
        //
        // FAIL-CLOSED: a suppressed record never persists the detailLine…
        #expect(!LiveSessionStore.widgetDetailLinePersistAllowed(recordSuppressed: true))
        // …and a normal (non-suppressed) session still shows lock-screen status.
        #expect(LiveSessionStore.widgetDetailLinePersistAllowed(recordSuppressed: false))
    }

    @Test func widgetUserContextLineIsSuppressedWhenTheRecordIsSuppressed() {
        // Regression: appendUserMessage dropped the chat entry under record
        // suppression (via appendConversation's central guard) but still pushed
        // "You: <message>" to the cross-process WidgetStatusStore / lock-screen
        // widget UNCONDITIONALLY. During the silent owner-voiceprint enrollment
        // session, an injected/typed user turn would leak its text to the lock
        // screen even though the session must leave no trace. The user
        // contextLine now routes through the SAME persist gate as the system
        // detailLine, so the two widget writes suppress in lockstep.
        //
        // FAIL-CLOSED: a suppressed record never persists the user context line…
        #expect(!LiveSessionStore.widgetDetailLinePersistAllowed(recordSuppressed: true))
        // …and a normal (non-suppressed) session still shows the "You: …" line.
        #expect(LiveSessionStore.widgetDetailLinePersistAllowed(recordSuppressed: false))
    }

    @Test func widgetAssistantContextLineIsSuppressedWhenTheRecordIsSuppressed() {
        // Regression: finishAssistantMessage dropped the chat bubble under record
        // suppression (via appendConversation's central guard) but still pushed
        // "Agent: <text>" to the cross-process WidgetStatusStore / lock-screen
        // widget UNCONDITIONALLY on BOTH the by-id commit-handoff branch and the
        // lone-response.done fallbackText branch. During the silent owner-
        // voiceprint enrollment session, a provider greeting/quirk that slips past
        // speakOnlyWhenSpokenTo + openingBehavior=.silent would then leak the
        // model's words to the lock screen even though the session must leave no
        // trace. Both assistant contextLine writes now route through the SAME
        // persist gate as the user contextLine and the system detailLine, so every
        // widget write suppresses in lockstep.
        //
        // FAIL-CLOSED: a suppressed record never persists the assistant context line…
        #expect(!LiveSessionStore.widgetDetailLinePersistAllowed(recordSuppressed: true))
        // …and a normal (non-suppressed) session still shows the "Agent: …" line.
        #expect(LiveSessionStore.widgetDetailLinePersistAllowed(recordSuppressed: false))
    }

    @Test func enrollmentListeningOverrideIsSilentUploadedAndRecordSuppressed() {
        // Pin the enrollment listening session's temporary config shape: audio
        // captured + live-uploaded, camera and visual side features off, fully
        // silent, and — the leak fix — journaling suppressed so nothing of the
        // enrollment lands in the chat record. The user's draft stays untouched.
        var base = LiveSessionConfig()
        base.visualSource = .iPhoneCamera
        base.visualCadence = .fps1
        base.cocktailPartyEnabled = true
        base.safetyCheckEnabled = true
        base.mediaPersistenceMode = .local

        let override = LiveSessionStore.enrollmentListeningConfigOverride(from: base)
        #expect(override.audioInputEnabled)
        #expect(override.mediaPersistenceMode == .liveUpload)
        #expect(override.visualSource == .off)
        #expect(override.visualCadence == .off)
        #expect(!override.cocktailPartyEnabled)
        #expect(!override.safetyCheckEnabled)
        #expect(override.speakOnlyWhenSpokenTo)
        #expect(override.openingBehavior == .silent)
        #expect(!override.conversationJournalingEnabled)
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

    @MainActor
    @Test func liveToolRegistryRejectsMalformedArgumentJSON() async throws {
        let context = LiveToolContext(config: LiveSessionConfig(), gatewayBridge: nil, awaitPendingTranscriptAppend: nil)

        let malformed = await LiveToolRegistry.default.execute(
            name: "get_current_time",
            argumentsJSON: "{",
            context: context
        )
        let malformedOutput = try jsonObject(malformed)

        #expect(malformedOutput["ok"] as? Bool == false)
        #expect(malformedOutput["tool"] as? String == "get_current_time")
        #expect(malformedOutput["error"] as? String == "Tool arguments must be valid JSON.")

        let nonObject = await LiveToolRegistry.default.execute(
            name: "get_current_time",
            argumentsJSON: "[]",
            context: context
        )
        let nonObjectOutput = try jsonObject(nonObject)

        #expect(nonObjectOutput["ok"] as? Bool == false)
        #expect(nonObjectOutput["tool"] as? String == "get_current_time")
        #expect(nonObjectOutput["error"] as? String == "Tool arguments must be a JSON object.")
    }

    @MainActor
    @Test func liveToolRegistryStillAcceptsEmptyObjectArguments() async throws {
        let context = LiveToolContext(config: LiveSessionConfig(), gatewayBridge: nil, awaitPendingTranscriptAppend: nil)

        let json = await LiveToolRegistry.default.execute(
            name: "get_current_time",
            argumentsJSON: "{}",
            context: context
        )
        let output = try jsonObject(json)

        #expect(output["ok"] as? Bool == true)
        #expect(output["tool"] as? String == "get_current_time")
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

private func jsonObject(_ text: String) throws -> [String: Any] {
    let data = try #require(text.data(using: .utf8))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}
