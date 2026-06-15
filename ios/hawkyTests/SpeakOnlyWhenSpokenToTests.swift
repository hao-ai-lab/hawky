import Foundation
import Testing
import PipecatClientIOS
@testable import hawky

// =============================================================================
// Tests for "Respond only when I talk" (#649): the session config must disable VAD
// auto-response (create_response/interrupt_response:false) so the model never speaks
// unprompted, and the flag must persist. The actual response.create-on-user-stop
// (manualResponseMode) is exercised at the provider level; here we lock down the
// config shape + persistence, which is what regressed (the toggle did nothing
// because the connect-time config still had create_response:true).
// =============================================================================

/// Pull `audio.input.turn_detection.<key>` (a Bool) out of a built session config.
private func turnDetectionBool(_ session: Value, _ key: String) -> Bool? {
    guard case let .object(root)? = .some(session),
          case let .object(audio)? = root["audio"] ?? nil,
          case let .object(input)? = audio["input"] ?? nil,
          case let .object(td)? = input["turn_detection"] ?? nil,
          case let .boolean(value)? = td[key] ?? nil
    else { return nil }
    return value
}

@MainActor
@Suite struct SpeakOnlyWhenSpokenToConfigTests {
    private func config(speakOnly: Bool) -> LiveSessionConfig {
        var c = LiveSessionConfig()
        c.speakOnlyWhenSpokenTo = speakOnly
        c.turnDetectionMode = .serverVAD   // VAD path carries create_response
        c.vadCreateResponse = true         // normally on
        c.vadInterruptResponse = true
        return c
    }

    @Test func normalSessionKeepsAutoResponse() {
        let session = PipecatOpenAIRealtimeLiveSessionProvider.buildSessionConfig(
            config: config(speakOnly: false), silent: false
        )
        #expect(turnDetectionBool(session, "create_response") == true)
        #expect(turnDetectionBool(session, "interrupt_response") == true)
    }

    @Test func speakOnlyOverrideDisablesAutoResponse() {
        // This is the connect-time path makeOptions uses when speakOnlyWhenSpokenTo
        // is on. It MUST start the session quiet.
        let session = PipecatOpenAIRealtimeLiveSessionProvider.buildSessionConfig(
            config: config(speakOnly: true), silent: false, autoResponseOverride: false
        )
        #expect(turnDetectionBool(session, "create_response") == false)
        #expect(turnDetectionBool(session, "interrupt_response") == false)
    }

    @Test func staySilentAlsoDisablesAutoResponse() {
        let session = PipecatOpenAIRealtimeLiveSessionProvider.buildSessionConfig(
            config: config(speakOnly: false), silent: true
        )
        #expect(turnDetectionBool(session, "create_response") == false)
    }

    @Test func semanticVADHonorsOverride() {
        var c = config(speakOnly: true)
        c.turnDetectionMode = .semanticVAD
        let session = PipecatOpenAIRealtimeLiveSessionProvider.buildSessionConfig(
            config: c, silent: false, autoResponseOverride: false
        )
        #expect(turnDetectionBool(session, "create_response") == false)
    }
}

@MainActor
@Suite struct SpeakOnlyWhenSpokenToPersistenceTests {
    private func makeDefaults() -> UserDefaults {
        let d = UserDefaults(suiteName: "speak-only-test-\(UUID().uuidString)")!
        return d
    }

    @Test func defaultsOff() {
        let d = makeDefaults()
        let loaded = LiveProfileDefaults.load(defaults: d)
        #expect(loaded.speakOnlyWhenSpokenTo == false)
    }

    @Test func persistsRoundTrip() {
        let d = makeDefaults()
        var c = LiveProfileDefaults.load(defaults: d)
        c.speakOnlyWhenSpokenTo = true
        LiveProfileDefaults.save(c, defaults: d)
        let reloaded = LiveProfileDefaults.load(defaults: d)
        #expect(reloaded.speakOnlyWhenSpokenTo == true)
    }
}
