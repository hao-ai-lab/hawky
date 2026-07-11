import Testing
import Foundation
@testable import hawky

/// B3 owner-enrollment tests. Exercise the FAIL-CLOSED consent gate, the exact
/// enroll_owner param shape (sources + consent keys), the too-short guided-floor
/// gate, RPC serialization under the enroll_owner method, and failure handling —
/// all against a fake gateway, independent of SwiftUI.
@Suite @MainActor struct OwnerEnrollmentTests {

    // MARK: - Fake gateway

    /// Records every enroll_owner / add_enrollment_clip / register call so tests can
    /// assert whether an RPC fired and inspect the params it carried. Scripts the
    /// enroll result so failure paths can be simulated.
    private final class FakeEnrollmentGateway: VoiceprintEnrollmentGateway, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var enrollCalls: [[String: JSONValue]] = []
        private(set) var addClipCalls: [[String: JSONValue]] = []
        private(set) var registerCalls = 0
        private var enrollResult: LiveVoiceprintEnrollmentResult?

        init(enrollResult: LiveVoiceprintEnrollmentResult?) {
            self.enrollResult = enrollResult
        }

        func registerVoiceprintAudioArtifact(
            sessionKey: String, audioArtifactID: String, mediaID: String,
            sampleRate: Double?, route: String?, timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintAudioArtifactRegistration? {
            lock.lock(); registerCalls += 1; lock.unlock()
            return LiveVoiceprintAudioArtifactRegistration(payload: .object([
                "ok": .bool(true),
                "sessionKey": .string(sessionKey),
                "audioArtifact": .object(["audioArtifactId": .string(audioArtifactID)]),
            ]))
        }

        func enrollVoiceprintOwner(
            sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintEnrollmentResult? {
            lock.lock(); enrollCalls.append(params); lock.unlock()
            return enrollResult
        }

        func addVoiceprintEnrollmentClip(
            sessionKey: String, params: [String: JSONValue], timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintEnrollmentResult? {
            lock.lock(); addClipCalls.append(params); lock.unlock()
            return enrollResult
        }
    }

    // MARK: - Helpers

    private func acceptedResult(sourceCount: Int = 1) -> LiveVoiceprintEnrollmentResult {
        LiveVoiceprintEnrollmentResult(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "status": .string("accepted"),
            "templateRef": .string("owner-template-1"),
            "sourceCount": .number(Double(sourceCount)),
            "speechMs": .number(31_000),
        ]))!
    }

    /// A single source whose voiced estimate clears the guided floor on its own.
    private func longSource(id: String = "src-1") -> OwnerEnrollmentSource {
        OwnerEnrollmentSource(
            id: id,
            audioArtifactID: "artifact-\(id)",
            route: "ios-enrollment",
            voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs + 2_000
        )
    }

    private func firstSourceObject(_ params: [String: JSONValue]) -> [String: JSONValue]? {
        guard case let .some(.array(sources)) = params["sources"],
              case let .object(first)? = sources.first else { return nil }
        return first
    }

    // MARK: - Consent gate blocks submission (no RPC fires while needsConsent)

    @Test func consentGateBlocksSubmissionUntilBiometricConsentGranted() async {
        let gateway = FakeEnrollmentGateway(enrollResult: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")

        // Record enough speech, but grant NO consent.
        model.addRecordedSource(longSource())
        #expect(model.state == .needsConsent)

        // Submitting with no consent must NOT call the gateway and must stay needsConsent.
        let blocked = await model.submit()
        #expect(blocked == nil)
        #expect(model.state == .needsConsent)
        #expect(gateway.enrollCalls.isEmpty)

        // Partial consent (capture only, no biometric) is STILL blocked — fail-closed.
        model.consent.captureAllowed = true
        model.refreshGateState()
        _ = await model.submit()
        #expect(gateway.enrollCalls.isEmpty)
        #expect(model.state == .needsConsent)

        // Only once BOTH biometric + capture are granted does the RPC fire.
        model.consent.biometricAllowed = true
        model.refreshGateState()
        let result = await model.submit()
        #expect(result?.accepted == true)
        #expect(gateway.enrollCalls.count == 1)
        if case .enrolled = model.state {} else {
            Issue.record("expected enrolled state, got \(model.state)")
        }
    }

    // MARK: - Exact enroll_owner param shape (sources + consent keys)

    @Test func assembledParamsCarryNonEmptySourcesAndExactConsentKeys() async {
        let gateway = FakeEnrollmentGateway(enrollResult: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.addRecordedSource(longSource())
        model.consent = OwnerEnrollmentConsent(
            captureAllowed: true,
            biometricAllowed: true,
            memoryPromotionAllowed: false,
            exportAllowed: false
        )
        model.refreshGateState()

        _ = await model.submit()
        #expect(gateway.enrollCalls.count == 1)
        let params = gateway.enrollCalls[0]

        // NON-EMPTY sources array.
        guard case let .some(.array(sources)) = params["sources"] else {
            Issue.record("sources missing / not an array"); return
        }
        #expect(!sources.isEmpty)

        // The source carries the exact server key `audioArtifactId`.
        let source = firstSourceObject(params)
        #expect(source?["audioArtifactId"] == .string("artifact-src-1"))

        // The consent object carries the exact server keys with the granted values.
        guard case let .some(.object(consent)) = params["consent"] else {
            Issue.record("consent missing / not an object"); return
        }
        #expect(consent["captureAllowed"] == .bool(true))
        #expect(consent["biometricAllowed"] == .bool(true))
        #expect(consent["memoryPromotionAllowed"] == .bool(false))
        #expect(consent["exportAllowed"] == .bool(false))
    }

    // MARK: - startMs / endMs are emitted both-or-neither with exact keys

    @Test func sourceEmitsBothMsBoundsOrNeitherWithExactKeys() {
        let bounded = OwnerEnrollmentSource(
            audioArtifactID: "a1", startMs: 100, endMs: 900, route: "ios-enrollment", voicedMs: 40_000
        )
        let obj = bounded.jsonObject
        #expect(obj["startMs"] == .number(100))
        #expect(obj["endMs"] == .number(900))
        #expect(obj["route"] == .string("ios-enrollment"))

        // No bounds → neither key present (server rejects a lone startMs/endMs).
        let unbounded = OwnerEnrollmentSource(audioArtifactID: "a2", voicedMs: 40_000)
        let obj2 = unbounded.jsonObject
        #expect(obj2["startMs"] == nil)
        #expect(obj2["endMs"] == nil)
    }

    // MARK: - Too-short guided floor blocks submission

    @Test func tooShortStateBlocksSubmissionBelowGuidedFloor() async {
        let gateway = FakeEnrollmentGateway(enrollResult: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")

        // A short clip: well below the guided voiced floor.
        model.addRecordedSource(OwnerEnrollmentSource(
            audioArtifactID: "short", voicedMs: 5_000
        ))
        // Grant full consent so consent is NOT the blocker.
        model.consent = OwnerEnrollmentConsent(
            captureAllowed: true, biometricAllowed: true,
            memoryPromotionAllowed: false, exportAllowed: false
        )
        model.refreshGateState()
        #expect(model.state == .tooShort)
        #expect(!model.hasEnoughSpeech)

        // Submission is blocked and NO RPC fires while too short.
        let blocked = await model.submit()
        #expect(blocked == nil)
        #expect(model.state == .tooShort)
        #expect(gateway.enrollCalls.isEmpty)

        // Adding more speech clears the floor and now the RPC fires.
        model.addRecordedSource(OwnerEnrollmentSource(
            audioArtifactID: "more", voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs
        ))
        model.refreshGateState()
        #expect(model.hasEnoughSpeech)
        _ = await model.submit()
        #expect(gateway.enrollCalls.count == 1)
        // Both sources are carried in the batch.
        guard case let .some(.array(sources)) = gateway.enrollCalls[0]["sources"] else {
            Issue.record("sources missing"); return
        }
        #expect(sources.count == 2)
    }

    // MARK: - RPC helper serializes under the enroll_owner method

    @Test func rpcHelperSerializesParamsUnderEnrollOwner() async {
        // The request builder is the single source of the enroll_owner param shape.
        let params = LiveVoiceprintEnrollmentRequest.enrollOwnerParams(
            sessionKey: "realtime:main",
            sources: [longSource()],
            consent: OwnerEnrollmentConsent(
                captureAllowed: true, biometricAllowed: true,
                memoryPromotionAllowed: true, exportAllowed: false
            ),
            minSpeechMs: 30_000
        )
        #expect(params["sessionKey"] == .string("realtime:main"))
        #expect(params["minSpeechMs"] == .number(30_000))
        guard case let .some(.array(sources)) = params["sources"] else {
            Issue.record("sources missing"); return
        }
        #expect(sources.count == 1)

        // The bridge helper serializes exactly these params into a RequestFrame under
        // the identity.voiceprint.enroll_owner method.
        let frame = RequestFrame(
            id: "enroll-1",
            method: "identity.voiceprint.enroll_owner",
            params: params
        )
        #expect(frame.method == "identity.voiceprint.enroll_owner")
        let data = try? JSONEncoder().encode(frame)
        let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        #expect(json.contains("identity.voiceprint.enroll_owner"))
        #expect(json.contains("biometricAllowed"))
        #expect(json.contains("captureAllowed"))
    }

    // MARK: - add_enrollment_clip param shape

    @Test func addEnrollmentClipCarriesSingleSourceAndConsent() {
        let params = LiveVoiceprintEnrollmentRequest.addEnrollmentClipParams(
            sessionKey: "realtime:main",
            source: longSource(id: "clip-2"),
            consent: OwnerEnrollmentConsent(
                captureAllowed: true, biometricAllowed: true,
                memoryPromotionAllowed: false, exportAllowed: false
            )
        )
        guard case let .some(.object(source)) = params["source"] else {
            Issue.record("source missing / not an object"); return
        }
        #expect(source["audioArtifactId"] == .string("artifact-clip-2"))
        guard case let .some(.object(consent)) = params["consent"] else {
            Issue.record("consent missing"); return
        }
        #expect(consent["biometricAllowed"] == .bool(true))
        // add_enrollment_clip carries a single `source`, never a `sources` array.
        #expect(params["sources"] == nil)
    }

    // MARK: - Failed enroll surfaces failed state without crashing

    @Test func failedEnrollSurfacesFailedStateWithoutCrashing() async {
        // Transport failure: gateway returns nil.
        let offline = FakeEnrollmentGateway(enrollResult: nil)
        let model = OwnerEnrollmentModel(gateway: offline, sessionKey: "realtime:main")
        model.addRecordedSource(longSource())
        model.consent = OwnerEnrollmentConsent(
            captureAllowed: true, biometricAllowed: true,
            memoryPromotionAllowed: false, exportAllowed: false
        )
        model.refreshGateState()

        let result = await model.submit()
        #expect(result == nil)
        if case .failed = model.state {} else {
            Issue.record("expected failed state on transport failure, got \(model.state)")
        }

        // Server rejection: a non-accepted status surfaces failed with the reason.
        let rejected = LiveVoiceprintEnrollmentResult(payload: .object([
            "ok": .bool(false),
            "sessionKey": .string("realtime:main"),
            "status": .string("rejected"),
            "reasons": .array([.string("insufficient_speech")]),
            "speechMs": .number(12_000),
            "sourceCount": .number(1),
        ]))
        let rejecting = FakeEnrollmentGateway(enrollResult: rejected)
        let model2 = OwnerEnrollmentModel(gateway: rejecting, sessionKey: "realtime:main")
        model2.addRecordedSource(longSource())
        model2.consent = OwnerEnrollmentConsent(
            captureAllowed: true, biometricAllowed: true,
            memoryPromotionAllowed: false, exportAllowed: false
        )
        model2.refreshGateState()
        _ = await model2.submit()
        guard case let .failed(detail) = model2.state else {
            Issue.record("expected failed on rejection, got \(model2.state)"); return
        }
        #expect(detail == "insufficient_speech")
    }

    // MARK: - Pending-upload gate: Enroll must not submit while a source is uploading

    @Test func enrollDoesNotSubmitWhilePendingUploadThenSubmitsOnceUploaded() async {
        let gateway = FakeEnrollmentGateway(enrollResult: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")

        // Record a source that is still uploading in the background (local-path
        // fallback shown immediately; artifact-backed upgrade pending). Grant full
        // consent and clear the voiced floor so consent/too-short are NOT the blocker.
        let pending = OwnerEnrollmentSource(
            id: "pending-1",
            audioPath: "/tmp/enroll-pending.wav",
            route: "ios-enrollment",
            voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs + 2_000
        )
        model.addRecordedSource(pending, uploadState: .pending)
        model.consent = OwnerEnrollmentConsent(
            captureAllowed: true, biometricAllowed: true,
            memoryPromotionAllowed: false, exportAllowed: false
        )
        model.refreshGateState()
        #expect(model.hasPendingUploads)

        // submit() must PARK on the pending upload — it may not call the gateway yet.
        let submitTask = Task { await model.submit() }
        // Give the submit task a chance to reach awaitPendingUploads and park.
        await Task.yield()
        #expect(gateway.enrollCalls.isEmpty)

        // Completing the background upload (artifact-backed upgrade) unblocks submit,
        // which then fires exactly one enroll_owner RPC.
        let upgraded = OwnerEnrollmentSource(
            id: "pending-1",
            audioArtifactID: "artifact-pending-1",
            route: "ios-enrollment",
            voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs + 2_000
        )
        model.markSourceUploaded(id: "pending-1", upgraded: upgraded)

        let result = await submitTask.value
        #expect(result?.accepted == true)
        #expect(gateway.enrollCalls.count == 1)
        #expect(!model.hasPendingUploads)

        // The RPC carried the UPGRADED artifact-backed source (not the local path).
        let source = firstSourceObject(gateway.enrollCalls[0])
        #expect(source?["audioArtifactId"] == .string("artifact-pending-1"))
        #expect(source?["audioPath"] == nil)
        if case .enrolled = model.state {} else {
            Issue.record("expected enrolled after upload completed, got \(model.state)")
        }
    }

    // MARK: - Start over / reset clears clips, keeps consent, orphans late uploads

    @Test func resetClearsClipsKeepsConsentAndNoOpsLateUpload() async {
        let gateway = FakeEnrollmentGateway(enrollResult: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")
        model.consent = OwnerEnrollmentConsent(
            captureAllowed: true, biometricAllowed: true,
            memoryPromotionAllowed: false, exportAllowed: false
        )
        let pending = OwnerEnrollmentSource(
            id: "reset-1",
            audioPath: "/tmp/enroll-reset.wav",
            route: "ios-enrollment",
            voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs + 2_000
        )
        model.addRecordedSource(pending, uploadState: .pending)
        #expect(model.sources.count == 1)
        #expect(model.hasPendingUploads)

        // "Start over": clears clips + upload tracking, returns to idle, KEEPS consent.
        model.reset()
        #expect(model.sources.isEmpty)
        #expect(!model.hasPendingUploads)
        #expect(model.consent.satisfiesGate)   // consent survives a re-record

        // A late background-upload callback for the cleared source is a no-op — it must
        // not resurrect a phantom clip or a pending-upload entry.
        let upgraded = OwnerEnrollmentSource(
            id: "reset-1", audioArtifactID: "artifact-reset-1", route: "ios-enrollment",
            voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs + 2_000
        )
        model.markSourceUploaded(id: "reset-1", upgraded: upgraded)
        #expect(model.sources.isEmpty)
        #expect(!model.hasPendingUploads)
    }

    // MARK: - Failed upload keeps the local-path fallback and unblocks Enroll

    @Test func failedUploadKeepsLocalSourceAndUnblocksEnroll() async {
        let gateway = FakeEnrollmentGateway(enrollResult: acceptedResult())
        let model = OwnerEnrollmentModel(gateway: gateway, sessionKey: "realtime:main")

        let local = OwnerEnrollmentSource(
            id: "local-1",
            audioPath: "/tmp/enroll-local.wav",
            route: "ios-enrollment",
            voicedMs: OwnerEnrollmentModel.guidedVoicedFloorMs + 2_000
        )
        model.addRecordedSource(local, uploadState: .pending)
        model.consent = OwnerEnrollmentConsent(
            captureAllowed: true, biometricAllowed: true,
            memoryPromotionAllowed: false, exportAllowed: false
        )
        model.refreshGateState()
        #expect(model.hasPendingUploads)

        // Upload fails: the local-path source stays; the pending gate clears so Enroll
        // is no longer blocked and submits the local-path source as-is.
        model.markSourceUploadFailed(id: "local-1")
        #expect(!model.hasPendingUploads)
        #expect(model.uploadStates["local-1"] == .failed)

        _ = await model.submit()
        #expect(gateway.enrollCalls.count == 1)
        let source = firstSourceObject(gateway.enrollCalls[0])
        #expect(source?["audioPath"] == .string("/tmp/enroll-local.wav"))
    }

    // MARK: - Result parsing: accepted vs non-accepted posture

    @Test func enrollmentResultAcceptedOnlyWhenStatusAccepted() {
        #expect(acceptedResult().accepted == true)
        let reembedded = LiveVoiceprintEnrollmentResult(payload: .object([
            "status": .string("reembedded"), "sourceCount": .number(2),
        ]))
        #expect(reembedded?.accepted == false)
        #expect(LiveVoiceprintEnrollmentResult(payload: nil) == nil)
    }
}
