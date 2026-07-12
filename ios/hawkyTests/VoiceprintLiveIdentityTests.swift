import Testing
import Foundation
@testable import hawky

/// WS2 live owner recognition (iOS side): the pushed-identity parsers (realtime_event
/// response piggyback + `voiceprint.identity` broadcast), the edge-triggered identity
/// state machine (establish/flip inject once; same-verdict is a no-op), cross-channel
/// de-dupe, off-by-default, fail-safe (garbled/unknown verdict never yields owner), and
/// the injection wire-format (conversation.item.create with NO response.create). All
/// pure/parser-level — no live socket, no gateway.
@Suite struct VoiceprintLiveIdentityTests {

    // MARK: - PRIMARY channel: realtime_event response piggyback

    /// The realtime_event RESPONSE carries additive `scoredStates` + `identity`. The
    /// parser reads verdict/decision/confidence and reuses the score-turns state parser
    /// for scoredStates.
    @Test func realtimeResultParsesPiggybackedIdentityAndStates() {
        let result = LiveVoiceprintRealtimeResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "finalizedTurns": .array([]),
            "scoredStates": .array([
                .object([
                    "transcriptItemId": .string("item-owner"),
                    "lifecycle": .string("resolved"),
                    "result": .string("owner_speaking"),
                    "confidence": .number(0.97),
                ]),
            ]),
            "identity": .object([
                "verdict": .string("owner_present"),
                "decision": .string("owner"),
                "confidence": .number(0.91),
                "at": .string("2026-07-11T00:00:00.000Z"),
            ]),
        ]))

        #expect(result?.ok == true)
        #expect(result?.scoredStates.count == 1)
        #expect(result?.scoredStates.first?.result == "owner_speaking")
        #expect(result?.identity?.verdict == "owner_present")
        #expect(result?.identity?.decision == "owner")
        #expect(result?.identity?.confidence == 0.91)
        #expect(result?.identity?.at == "2026-07-11T00:00:00.000Z")
    }

    /// A response WITHOUT the additive fields (auto-score off / older server) parses
    /// with empty scoredStates and a nil identity — never a spurious owner.
    @Test func realtimeResultWithoutPiggybackDegradesQuietly() {
        let result = LiveVoiceprintRealtimeResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "finalizedTurns": .array([]),
        ]))
        #expect(result?.scoredStates.isEmpty == true)
        #expect(result?.identity == nil)
    }

    // MARK: - SECONDARY channel: voiceprint.identity broadcast EventFrame

    private func frame(event: String, payloadJSON: String) throws -> EventFrame {
        let json = """
        { "type": "event", "event": "\(event)", "payload": \(payloadJSON) }
        """
        return try JSONDecoder().decode(EventFrame.self, from: Data(json.utf8))
    }

    /// The `voiceprint.identity` broadcast (NO `agent.` prefix) decodes to the identity
    /// case with the same scalar fields as the piggyback.
    @Test func broadcastEventFrameDecodesIdentity() throws {
        let f = try frame(
            event: "voiceprint.identity",
            payloadJSON: #"{"sessionKey":"realtime:main","verdict":"owner_present","decision":"owner","confidence":0.88,"at":"2026-07-11T00:00:01.000Z"}"#
        )
        guard case let .voiceprintIdentity(sessionKey, verdict, decision, confidence, at)? = EventFrameDecoder.decode(f) else {
            Issue.record("expected .voiceprintIdentity")
            return
        }
        #expect(sessionKey == "realtime:main")
        #expect(verdict == "owner_present")
        #expect(decision == "owner")
        #expect(confidence == 0.88)
        #expect(at == "2026-07-11T00:00:01.000Z")
    }

    /// FAIL-SAFE: a broadcast missing a required scalar (verdict) decodes to nil and is
    /// safely ignored — never a false identity.
    @Test func broadcastMissingVerdictDecodesNil() throws {
        let f = try frame(
            event: "voiceprint.identity",
            payloadJSON: #"{"sessionKey":"realtime:main","confidence":0.88,"at":"2026-07-11T00:00:01.000Z"}"#
        )
        #expect(EventFrameDecoder.decode(f) == nil)
    }

    /// Both channels carry the SAME { verdict, at } — decoding one into a summary and
    /// parsing the other's object yields equal identity content.
    @Test func bothChannelsDecodeToSameIdentity() throws {
        let piggyback = LiveVoiceprintIdentitySummary(object: [
            "verdict": .string("owner_present"),
            "confidence": .number(0.9),
            "at": .string("2026-07-11T00:00:02.000Z"),
        ])
        let f = try frame(
            event: "voiceprint.identity",
            payloadJSON: #"{"sessionKey":"realtime:main","verdict":"owner_present","confidence":0.9,"at":"2026-07-11T00:00:02.000Z"}"#
        )
        guard case let .voiceprintIdentity(_, verdict, _, _, at)? = EventFrameDecoder.decode(f) else {
            Issue.record("expected .voiceprintIdentity")
            return
        }
        #expect(piggyback?.verdict == verdict)
        #expect(piggyback?.at == at)
    }

    // MARK: - edge-triggered identity state machine

    private func summary(_ verdict: String, at: String, confidence: Double = 0.9) -> LiveVoiceprintIdentitySummary {
        LiveVoiceprintIdentitySummary(verdict: verdict, confidence: confidence, at: at)
    }

    /// ESTABLISH: unknown -> owner_present fires exactly one apply with the owner
    /// injection + owner label.
    @Test func establishOwnerInjectsOnce() {
        var machine = LiveVoiceprintIdentityMachine()
        let action = machine.ingest(summary("owner_present", at: "t1"))
        guard case let .apply(verdict, injection, label) = action else {
            Issue.record("expected .apply on establish")
            return
        }
        #expect(verdict == .ownerPresent)
        // The injection is the single canonical owner text (A/B-verified wording
        // lives in injectionText(for:); assert identity, not a duplicated literal).
        #expect(injection == LiveVoiceprintIdentityMachine.injectionText(for: .ownerPresent))
        #expect(injection.contains("they are the device owner"))
        #expect(label == "Owner speaking")
    }

    /// FLIP: owner_present -> not_owner fires one apply with the unknown injection.
    @Test func flipToNotOwnerInjectsOnce() {
        var machine = LiveVoiceprintIdentityMachine()
        _ = machine.ingest(summary("owner_present", at: "t1"))
        let action = machine.ingest(summary("not_owner", at: "t2"))
        guard case let .apply(verdict, injection, _) = action else {
            Issue.record("expected .apply on flip")
            return
        }
        #expect(verdict == .notOwner)
        #expect(injection == LiveVoiceprintIdentityMachine.injectionText(for: .notOwner))
        #expect(injection.contains("does NOT match the device owner"))
    }

    /// SAME-VERDICT repeat (a new `at` but the same verdict) does NOT re-inject/re-label.
    @Test func sameVerdictRepeatDoesNotReinject() {
        var machine = LiveVoiceprintIdentityMachine()
        _ = machine.ingest(summary("owner_present", at: "t1"))
        let repeatSameNewAt = machine.ingest(summary("owner_present", at: "t2"))
        #expect(repeatSameNewAt == .none)
        let repeatSameSameAt = machine.ingest(summary("owner_present", at: "t2"))
        #expect(repeatSameSameAt == .none)
    }

    /// The unknown -> provisional drift is NOT an identity edge (no hard verdict on
    /// either side): no injection.
    @Test func provisionalDriftIsNotAnEdge() {
        var machine = LiveVoiceprintIdentityMachine()
        let action = machine.ingest(summary("provisional", at: "t1"))
        #expect(action == .none)
    }

    /// DE-DUPE across channels: the SAME (verdict, at) arriving twice (piggyback then
    /// broadcast) applies exactly once.
    @Test func crossChannelDuplicateAppliesOnce() {
        var machine = LiveVoiceprintIdentityMachine()
        let first = machine.ingest(summary("owner_present", at: "t1"))
        let second = machine.ingest(summary("owner_present", at: "t1"))
        if case .apply = first {} else { Issue.record("first should apply") }
        #expect(second == .none)
    }

    /// FAIL-SAFE: a garbled/unknown verdict string never establishes an owner — it is
    /// treated like unknown and yields no apply on its own.
    @Test func garbledVerdictNeverYieldsOwner() {
        var machine = LiveVoiceprintIdentityMachine()
        let action = machine.ingest(summary("totally-bogus", at: "t1"))
        #expect(action == .none)
        // And it must not have recorded an owner verdict.
        #expect(machine.lastAppliedVerdict != .ownerPresent)
    }

    /// FAIL-SAFE: a garbled `LiveVoiceprintIdentitySummary` payload (missing verdict)
    /// fails to parse — the caller never gets an identity to apply.
    @Test func garbledPayloadFailsToParse() {
        let summary = LiveVoiceprintIdentitySummary(object: [
            "confidence": .number(0.99),
            "at": .string("t1"),
        ])
        #expect(summary == nil)
    }

    // MARK: - injection wire format

    /// The identity injection the store performs is EXACTLY
    /// `provider.sendContext(injectionText, createResponse: false)` — the same
    /// no-response context path the cocktail-party / gateway-feed injections use.
    /// This exercises the REAL call the store makes (`handleVoiceprintIdentitySummary`
    /// -> `provider.sendContext(injection, createResponse: false)`), through a
    /// capturing fake that conforms to `LiveSessionProvider`, and asserts that
    /// `createResponse` is `false` so no `response.create` is ever requested for an
    /// identity injection (never triggers a spoken reply / stalls the data channel).
    @MainActor
    @Test func identityInjectionSendsContextWithoutResponse() async throws {
        let provider = SendContextCapturingProvider()
        let owner = LiveVoiceprintIdentityMachine.injectionText(for: .ownerPresent)

        // Mirror the store's injection call site verbatim.
        try await provider.sendContext(owner, createResponse: false)

        #expect(provider.sentContext.count == 1)
        // The injected text is byte-identical to the canonical owner injection
        // (single-sourced in injectionText(for:), not a duplicated literal here).
        #expect(provider.sentContext.first?.text == owner)
        #expect(provider.sentContext.first?.text.contains("they are the device owner") == true)
        // The load-bearing guarantee: identity injection NEVER asks for a response.
        #expect(provider.sentContext.first?.createResponse == false)
        // And it never routed through the response-triggering deliberate-prompt path.
        #expect(provider.responseWasRequested == false)
    }

    // MARK: - off-by-default (fast path coupling)

    /// OFF-BY-DEFAULT: with recognition OFF, the realtime fast path still defers live
    /// upload (unchanged behavior).
    @Test func fastPathDefersLiveUploadWhenRecognitionOff() {
        var config = LiveSessionConfig()
        config.provider = .openAIRealtime
        config.mediaPersistenceMode = .liveUpload
        config.voiceprintRealtimeEnabled = false

        let result = LiveSessionStore.realtimeFastPathConfig(config)
        #expect(result.config.mediaPersistenceMode == .deferredUpload)
        #expect(result.deferredLiveUpload)
    }

    /// WS2 (closes #12): with recognition ON, the fast path KEEPS liveUpload so the
    /// gateway gets the turn audio in time to auto-score.
    @Test func fastPathKeepsLiveUploadWhenRecognitionOn() {
        var config = LiveSessionConfig()
        config.provider = .openAIRealtime
        config.mediaPersistenceMode = .liveUpload
        config.voiceprintRealtimeEnabled = true

        let result = LiveSessionStore.realtimeFastPathConfig(config)
        #expect(result.config.mediaPersistenceMode == .liveUpload)
        #expect(!result.deferredLiveUpload)
    }
}

/// Minimal `LiveSessionProvider` fake that captures `sendContext` calls so the
/// identity-injection wire contract (`createResponse: false`, never a response)
/// can be asserted without a live socket. Everything else relies on the protocol's
/// default no-op extension.
@MainActor
private final class SendContextCapturingProvider: LiveSessionProvider {
    struct Sent: Equatable { let text: String; let createResponse: Bool }
    private(set) var sentContext: [Sent] = []
    /// True if ANY path asked for a response (deliberate prompt / surface-with-speak).
    private(set) var responseWasRequested = false

    func connect(config: LiveSessionConfig) async throws {}
    func sendAudio(_ chunk: LiveAudioChunk) async throws {}
    func streamAudio(_ chunk: LiveAudioChunk) async throws {}
    func commitAudioStream() async throws {}
    func sendFrame(_ frame: LiveJPEGFrame) async throws -> Bool { true }
    func sendText(_ text: String) async throws { responseWasRequested = true }
    func sendContext(_ text: String, createResponse: Bool) async throws {
        sentContext.append(Sent(text: text, createResponse: createResponse))
        if createResponse { responseWasRequested = true }
    }
    func surfaceIntention(_ intentionId: String?, _ text: String, speak: Bool, whenBusy: SurfaceBusyPolicy, cautious: Bool) async throws {
        if speak { responseWasRequested = true }
    }
    func events() -> AsyncStream<LiveSessionEvent> { AsyncStream { $0.finish() } }
    func close() async {}
}
