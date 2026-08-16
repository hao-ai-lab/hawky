import Testing
import Foundation
@testable import hawky

/// Listening-session enrollment tests (enroll_owner_from_recording). Exercise the
/// FAIL-CLOSED consent gate, the exact from-recording param shape (recordingBaseId
/// + consent keys), the guided-floor gate, the not_enough_speech → tooShort mapping
/// with the server-counted "keep talking N more seconds" hint, the actionable
/// failure copy for quality/upload rejections, and the additive segment-count
/// parsing — all against a fake gateway, independent of SwiftUI and of any live
/// session (the capture is injected via recordListeningCapture). The clip-based
/// flow keeps its own coverage in OwnerEnrollmentTests.
@Suite @MainActor struct OwnerEnrollmentModelTests {

    // MARK: - Fake gateway

    /// Records every enroll_owner_from_recording call so tests can assert whether
    /// the RPC fired and inspect the params it carried. Scripts the result so
    /// rejection/failure paths can be simulated. The clip-flow methods return nil
    /// (this suite never uses them).
    private final class FakeRecordingEnrollmentGateway: VoiceprintEnrollmentGateway, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var fromRecordingCalls: [[String: JSONValue]] = []
        var result: LiveVoiceprintEnrollmentResult?

        init(result: LiveVoiceprintEnrollmentResult?) {
            self.result = result
        }

        func registerVoiceprintAudioArtifact(
            sessionKey: String, audioArtifactID: String, mediaID: String,
            sampleRate: Double?, route: String?, timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintAudioArtifactRegistration? { nil }

        func enrollVoiceprintOwner(
            sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintEnrollmentResult? { nil }

        func addVoiceprintEnrollmentClip(
            sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintEnrollmentResult? { nil }

        func enrollVoiceprintOwnerFromRecording(
            sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintEnrollmentResult? {
            lock.lock(); fromRecordingCalls.append(params); lock.unlock()
            return result
        }
    }

    // MARK: - Helpers

    private func acceptedResult(speechMs: Double = 34_000) -> LiveVoiceprintEnrollmentResult {
        LiveVoiceprintEnrollmentResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "status": .string("accepted"),
            "templateRef": .string("owner-template-1"),
            "sourceCount": .number(9),
            "speechMs": .number(speechMs),
            "segmentsConsidered": .number(14),
            "segmentsUsed": .number(9),
            "segmentsQualityRejected": .number(3),
            "segmentsCapped": .number(1),
            "segmentsAfterGap": .number(1),
        ]))!
    }

    private func rejectedResult(reasons: [String], speechMs: Double = 0) -> LiveVoiceprintEnrollmentResult {
        LiveVoiceprintEnrollmentResult(payload: .object([
            "ok": .bool(false),
            "sessionKey": .string("realtime:main"),
            "status": .string("rejected"),
            "reasons": .array(reasons.map { .string($0) }),
            "speechMs": .number(speechMs),
            "sourceCount": .number(0),
        ]))!
    }

    private let fullConsent = OwnerEnrollmentConsent(
        captureAllowed: true, biometricAllowed: true,
        memoryPromotionAllowed: false, exportAllowed: false
    )

    /// A wall-clock listening duration whose ~74% voiced estimate clears the 30s
    /// server floor (30_000 / 0.74 ≈ 40.5s → use 45s).
    // Clears the 60s guided target: 85s * 0.74 = 62.9s voiced estimate.
    private let longEnoughElapsedMs: Double = 85_000

    // MARK: - Consent gate blocks submitFromRecording (fail-closed)

    @Test func consentGateBlocksSubmitFromRecordingUntilGranted() async {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")

        // A finished capture with enough speech, but NO consent.
        model.recordListeningCapture(recordingBaseId: "live-20260712-135209", elapsedMs: longEnoughElapsedMs)
        #expect(model.state == .needsConsent)

        // Submitting with no consent must NOT call the gateway.
        let blocked = await model.submitFromRecording()
        #expect(blocked == nil)
        #expect(model.state == .needsConsent)
        #expect(gateway.fromRecordingCalls.isEmpty)

        // Partial consent (capture only, no biometric) is STILL blocked — fail-closed.
        model.consent.captureAllowed = true
        model.refreshGateState()
        _ = await model.submitFromRecording()
        #expect(gateway.fromRecordingCalls.isEmpty)
        #expect(model.state == .needsConsent)

        // Only once BOTH biometric + capture are granted does the RPC fire.
        model.consent.biometricAllowed = true
        model.refreshGateState()
        let result = await model.submitFromRecording()
        #expect(result?.accepted == true)
        #expect(gateway.fromRecordingCalls.count == 1)
        if case .enrolled = model.state {} else {
            Issue.record("expected enrolled state, got \(model.state)")
        }
    }

    // MARK: - Exact param shape: recordingBaseId + consent keys + sessionKey

    @Test func fromRecordingParamsCarryBaseIdAndExactConsentKeys() async {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.recordListeningCapture(recordingBaseId: "live-20260712-135209", elapsedMs: longEnoughElapsedMs)
        model.consent = fullConsent
        model.refreshGateState()

        _ = await model.submitFromRecording(minSpeechMs: 30_000)
        #expect(gateway.fromRecordingCalls.count == 1)
        let params = gateway.fromRecordingCalls[0]

        #expect(params["recordingBaseIds"] == .array([.string("live-20260712-135209")]))
        #expect(params["sessionKey"] == .string("realtime:main"))
        #expect(params["minSpeechMs"] == .number(30_000))
        // NEVER a sources array on this method — the gateway selects segments itself.
        #expect(params["sources"] == nil)

        guard case let .some(.object(consent)) = params["consent"] else {
            Issue.record("consent missing / not an object"); return
        }
        #expect(consent["captureAllowed"] == .bool(true))
        #expect(consent["biometricAllowed"] == .bool(true))
        #expect(consent["memoryPromotionAllowed"] == .bool(false))
        #expect(consent["exportAllowed"] == .bool(false))
    }

    // MARK: - Guided floor blocks a capture the server would reject

    @Test func tooShortCaptureBlocksSubmissionBelowVoicedFloor() async {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent

        // 20s wall clock ≈ 14.8s voiced — well below the 30s server floor.
        model.recordListeningCapture(recordingBaseId: "live-short", elapsedMs: 20_000)
        #expect(model.state == .tooShort)
        #expect(!model.hasEnoughListeningSpeech)
        #expect(!model.canSubmitFromRecording)

        let blocked = await model.submitFromRecording()
        #expect(blocked == nil)
        #expect(model.state == .tooShort)
        #expect(gateway.fromRecordingCalls.isEmpty)

        // The keep-talking hint (no server rejection yet → client estimate):
        // 60s target - 14.8 = 45.2 → rounded up to 46.
        #expect(model.keepTalkingSeconds == 46)
    }

    // MARK: - not_enough_speech rejection → tooShort with server-counted hint

    @Test func notEnoughSpeechRejectionMapsToTooShortWithServerHint() async {
        let gateway = FakeRecordingEnrollmentGateway(
            result: rejectedResult(reasons: ["not_enough_speech"], speechMs: 21_000)
        )
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent
        model.recordListeningCapture(recordingBaseId: "live-20260712-135209", elapsedMs: longEnoughElapsedMs)

        let result = await model.submitFromRecording()
        #expect(result?.accepted == false)
        #expect(gateway.fromRecordingCalls.count == 1)
        // Actionable, not terminal: tooShort so the UI says "keep talking".
        #expect(model.state == .tooShort)
        // The hint anchors to the SERVER speechMs (60s target - 21 = 39s), not the
        // client's wall-clock estimate (which cleared the floor) — and the
        // rejected take is KEPT so "Continue recording" adds to it.
        #expect(model.serverCountedSpeechMs == 21_000)
        #expect(model.keepTalkingSeconds == 39)
        #expect(model.capturedRecordingBaseIds == ["live-20260712-135209"])
    }

    // MARK: - Actionable failure copy for quality / upload rejections

    @Test func qualityAndUploadRejectionsSurfaceActionableCopy() async {
        // quality_rejected → "too noisy" guidance.
        let noisy = FakeRecordingEnrollmentGateway(
            result: rejectedResult(reasons: ["quality_rejected"])
        )
        let model = OwnerEnrollmentModel(gateway: noisy, sessionKey: "realtime:main")
        model.consent = fullConsent
        model.recordListeningCapture(recordingBaseId: "live-noisy", elapsedMs: longEnoughElapsedMs)
        _ = await model.submitFromRecording()
        #expect(model.state == .failed("Too noisy — try somewhere quieter."))

        // no_usable_segments → the upload never landed; retrying is the fix.
        let unuploaded = FakeRecordingEnrollmentGateway(
            result: rejectedResult(reasons: ["no_usable_segments"])
        )
        let model2 = OwnerEnrollmentModel(gateway: unuploaded, sessionKey: "realtime:main")
        model2.consent = fullConsent
        model2.recordListeningCapture(recordingBaseId: "live-lost", elapsedMs: longEnoughElapsedMs)
        _ = await model2.submitFromRecording()
        #expect(model2.state == .failed("Upload didn't complete — try again."))

        // Transport failure (nil result) fails closed with the reach message.
        let offline = FakeRecordingEnrollmentGateway(result: nil)
        let model3 = OwnerEnrollmentModel(gateway: offline, sessionKey: "realtime:main")
        model3.consent = fullConsent
        model3.recordListeningCapture(recordingBaseId: "live-offline", elapsedMs: longEnoughElapsedMs)
        _ = await model3.submitFromRecording()
        #expect(model3.state == .failed("Could not reach the Hawky gateway to enroll your voice."))
    }

    // MARK: - A capture with no recording fails clearly (mic never opened)

    @Test func nilRecordingBaseIdSurfacesCaptureFailure() {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.recordListeningCapture(recordingBaseId: nil, elapsedMs: longEnoughElapsedMs)
        #expect(model.capturedRecordingBaseIds.isEmpty)
        #expect(model.state == .failed("No audio was captured — try again."))
    }

    // MARK: - Reset discards the capture but keeps consent

    @Test func resetClearsListeningCaptureAndKeepsConsent() {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent
        model.recordListeningCapture(recordingBaseId: "live-20260712-135209", elapsedMs: longEnoughElapsedMs)
        #expect(model.canSubmitFromRecording)

        model.reset()
        #expect(model.capturedRecordingBaseIds.isEmpty)
        #expect(model.listeningElapsedMs == 0)
        #expect(model.serverCountedSpeechMs == nil)
        #expect(model.state == .idle)
        #expect(model.consent.satisfiesGate)   // consent survives a re-take
        #expect(!model.canSubmitFromRecording)
    }

    // MARK: - Success copy is honest about capping

    @Test func enrolledMessageSaysFirstPortionWhenSegmentsWereCapped() {
        // The gateway trims selection at its total budget; when that happened
        // (segmentsCapped > 0) the success copy must say only the FIRST portion
        // of the speech was used instead of implying all of it enrolled.
        let capped = acceptedResult(speechMs: 88_000)   // helper payload has segmentsCapped: 1
        #expect(OwnerEnrollmentModel.enrolledMessage(for: capped)
            == "Enrolled from the first 88s of your speech — you talked more than needed, so the rest wasn't used. Your voice is set up.")

        // No capping (count absent OR zero) keeps the plain copy.
        let plain = LiveVoiceprintEnrollmentResult(payload: .object([
            "status": .string("accepted"), "speechMs": .number(41_000),
        ]))!
        #expect(OwnerEnrollmentModel.enrolledMessage(for: plain)
            == "Enrolled from 41s of your speech. Your voice is set up.")

        let uncapped = LiveVoiceprintEnrollmentResult(payload: .object([
            "status": .string("accepted"), "speechMs": .number(65_000),
            "segmentsCapped": .number(0),
        ]))!
        #expect(OwnerEnrollmentModel.enrolledMessage(for: uncapped)
            == "Enrolled from 65s of your speech. Your voice is set up.")

        // Capped but speechMs absent (parse anomaly): drop the duration clause
        // instead of rendering the self-contradictory "the first 0s of your speech".
        let cappedNoSpeech = LiveVoiceprintEnrollmentResult(payload: .object([
            "status": .string("accepted"), "segmentsCapped": .number(1),
        ]))!
        #expect(OwnerEnrollmentModel.enrolledMessage(for: cappedNoSpeech)
            == "Enrolled from the first part of your speech — you talked more than needed, so the rest wasn't used. Your voice is set up.")
    }

    // MARK: - Additive segment-count parsing on the enrollment result

    @Test func enrollmentResultParsesAdditiveSegmentCounts() {
        let result = acceptedResult()
        #expect(result.segmentsConsidered == 14)
        #expect(result.segmentsUsed == 9)
        #expect(result.segmentsQualityRejected == 3)
        #expect(result.segmentsCapped == 1)
        #expect(result.segmentsAfterGap == 1)

        // Counts are OPTIONAL: a plain enroll_owner response without them still parses.
        let plain = LiveVoiceprintEnrollmentResult(payload: .object([
            "status": .string("accepted"), "speechMs": .number(31_000),
        ]))
        #expect(plain?.segmentsConsidered == nil)
        #expect(plain?.segmentsUsed == nil)
    }

    // MARK: - From-recording params builder (single source of the wire shape)

    @Test func fromRecordingParamsBuilderMatchesServerKeys() {
        let params = LiveVoiceprintEnrollmentRequest.enrollOwnerFromRecordingParams(
            sessionKey: "realtime:main",
            recordingBaseIds: ["live-20260712-135209", "live-20260712-140001"],
            consent: fullConsent,
            minSpeechMs: 30_000
        )
        #expect(params["recordingBaseIds"] == .array([
            .string("live-20260712-135209"), .string("live-20260712-140001"),
        ]))
        #expect(params["sessionKey"] == .string("realtime:main"))
        #expect(params["minSpeechMs"] == .number(30_000))

        // The RPC serializes under the enroll_owner_from_recording method.
        let frame = RequestFrame(
            id: "enroll-rec-1",
            method: "identity.voiceprint.enroll_owner_from_recording",
            params: params
        )
        let data = try? JSONEncoder().encode(frame)
        let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        #expect(json.contains("identity.voiceprint.enroll_owner_from_recording"))
        #expect(json.contains("recordingBaseIds"))
        #expect(json.contains("biometricAllowed"))
    }

    // MARK: - Takes accumulate ("Continue recording" keeps prior takes)

    @Test func takesAccumulateAcrossListeningSessionsAndSubmitInOrder() async {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent

        // Two takes, each individually below the 60s target, together above it.
        model.recordListeningCapture(recordingBaseId: "live-take-a", elapsedMs: 45_000)
        #expect(!model.hasEnoughListeningSpeech)
        model.recordListeningCapture(recordingBaseId: "live-take-b", elapsedMs: 45_000)
        #expect(model.capturedRecordingBaseIds == ["live-take-a", "live-take-b"])
        #expect(model.hasEnoughListeningSpeech)

        _ = await model.submitFromRecording()
        #expect(gateway.fromRecordingCalls.count == 1)
        let sent = gateway.fromRecordingCalls.first?["recordingBaseIds"]
        #expect(sent == .array([.string("live-take-a"), .string("live-take-b")]))
    }

    // MARK: - Server anchor replaces counted takes' estimates, later takes add on

    @Test func serverAnchorReplacesCountedTakesAndLaterTakesAddOn() async {
        // The server rejection (not_enough_speech, 16s counted) anchors progress:
        // it REPLACES the client estimate of the counted take.
        let gateway = FakeRecordingEnrollmentGateway(
            result: rejectedResult(reasons: ["not_enough_speech"], speechMs: 16_000)
        )
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent
        // One take the client estimates at ~62.9s voiced (85s * 0.74) — clears
        // the client gate so submit actually reaches the server...
        model.recordListeningCapture(recordingBaseId: "live-take-a", elapsedMs: 85_000)
        _ = await model.submitFromRecording()
        #expect(Int(model.speechProgressMs) == 16_000)
        #expect(model.keepTalkingSeconds == 44)
        // A NEW take after the anchor adds its client estimate on top; the
        // anchored take is NOT double-counted.
        model.recordListeningCapture(recordingBaseId: "live-take-b", elapsedMs: 10_000)
        #expect(Int(model.speechProgressMs) == 16_000 + Int(10_000 * 0.74))
    }

    // MARK: - A second rejection re-anchors (replaces, never sums)

    @Test func secondRejectionReplacesAnchorAndCoversAllTakes() async {
        let gateway = FakeRecordingEnrollmentGateway(
            result: rejectedResult(reasons: ["not_enough_speech"], speechMs: 16_000)
        )
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent
        model.recordListeningCapture(recordingBaseId: "live-take-a", elapsedMs: 85_000)
        _ = await model.submitFromRecording()
        #expect(Int(model.speechProgressMs) == 16_000)

        // Continue recording enough to clear the 60s gate again (16s anchor +
        // 65s*0.74 = 64.1s), then the server counts BOTH takes at 24s total.
        model.recordListeningCapture(recordingBaseId: "live-take-b", elapsedMs: 65_000)
        gateway.result = rejectedResult(reasons: ["not_enough_speech"], speechMs: 24_000)
        _ = await model.submitFromRecording()
        // REPLACED (24s), not summed (16+24); the anchor now covers both takes,
        // so no client estimate is added on top.
        #expect(Int(model.speechProgressMs) == 24_000)
        #expect(model.keepTalkingSeconds == 36)
        #expect(model.capturedRecordingBaseIds == ["live-take-a", "live-take-b"])
    }

    // MARK: - Accept clears the takes (post-success screen is coherent)

    @Test func acceptedSubmissionClearsTakesAndAnchor() async {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = fullConsent
        model.recordListeningCapture(recordingBaseId: "live-take-a", elapsedMs: 85_000)
        _ = await model.submitFromRecording()
        guard case .enrolled = model.state else {
            Issue.record("expected enrolled state"); return
        }
        #expect(model.capturedRecordingBaseIds.isEmpty)
        #expect(model.serverCountedSpeechMs == nil)
        #expect(!model.canSubmitFromRecording)
    }

    // MARK: - Take limit matches the gateway bound

    @Test func takeLimitBlocksFurtherTakes() {
        let gateway = FakeRecordingEnrollmentGateway(result: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        for index in 0..<OwnerEnrollmentModel.maxTakes {
            model.recordListeningCapture(recordingBaseId: "live-take-\(index)", elapsedMs: 5_000)
        }
        #expect(model.atTakeLimit)
        #expect(model.capturedRecordingBaseIds.count == OwnerEnrollmentModel.maxTakes)
    }
}
