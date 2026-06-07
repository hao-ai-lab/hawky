import AVFoundation
import Testing
@testable import hawky

@Suite struct LiveAudioOutputDestinationTests {
    /// `.glasses` must not force the loudspeaker — that's the whole point of the
    /// setting: keep the reply off the speaker so it doesn't echo back into the
    /// mic. It still allows the Bluetooth HFP route so the glasses can play it.
    @Test func glassesRouteAvoidsLoudspeaker() {
        let opts = LiveAudioOutputDestination.glasses.playbackCategoryOptions
        #expect(opts.contains(.allowBluetoothHFP))
        #expect(!opts.contains(.defaultToSpeaker))
        #expect(LiveAudioOutputDestination.glasses.portOverride == AVAudioSession.PortOverride.none)
    }

    /// `.speaker` explicitly overrides to the loudspeaker port.
    @Test func speakerRouteForcesLoudspeaker() {
        #expect(LiveAudioOutputDestination.speaker.portOverride == .speaker)
        #expect(LiveAudioOutputDestination.speaker.playbackCategoryOptions.contains(.defaultToSpeaker))
    }

    /// `.auto` preserves today's behaviour (system default → loudspeaker) so the
    /// setting is backwards compatible when unset.
    @Test func autoMatchesLegacyDefault() {
        let opts = LiveAudioOutputDestination.auto.playbackCategoryOptions
        #expect(opts.contains(.defaultToSpeaker))
        #expect(opts.contains(.allowBluetoothHFP))
        #expect(LiveAudioOutputDestination.auto.portOverride == AVAudioSession.PortOverride.none)
    }

    /// Default config value and a save → load round-trip through UserDefaults.
    @Test func persistsAcrossLoadAndSave() {
        #expect(LiveSessionConfig().audioOutputDestination == .auto)

        let suiteName = "tests.liveOutput"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("Failed to create test UserDefaults suite")
            return
        }
        defaults.removePersistentDomain(forName: suiteName)

        var config = LiveSessionConfig()
        config.audioOutputDestination = .glasses
        LiveProfileDefaults.save(config, defaults: defaults)

        let loaded = LiveProfileDefaults.load(defaults: defaults)
        #expect(loaded.audioOutputDestination == .glasses)

        defaults.removePersistentDomain(forName: suiteName)
    }
}
