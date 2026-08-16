import Testing
import Foundation
@testable import hawky

/// B2 liveness-nonce binding tests. Exercise the fail-closed single-use / TTL
/// nonce rules of `VoiceprintLivenessCoordinator` against a fake gateway, plus the
/// exact server keys carried on the submitted score_turns params.
@Suite struct VoiceprintLivenessBindingTests {

    // MARK: - Fake gateway

    /// Records every challenge request and score_turns submission, and serves a
    /// scripted queue of challenges (or nil to simulate a failed challenge).
    private final class FakeLivenessGateway: VoiceprintLivenessGateway, @unchecked Sendable {
        private let lock = NSLock()
        private var challenges: [LiveVoiceprintEmbeddingChallenge?]
        private var challengeIndex = 0
        private(set) var challengeRequests = 0
        private(set) var submittedParams: [[String: JSONValue]] = []

        init(challenges: [LiveVoiceprintEmbeddingChallenge?]) {
            self.challenges = challenges
        }

        func requestVoiceprintEmbeddingChallenge(
            sessionKey: String,
            mode: String,
            timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintEmbeddingChallenge? {
            lock.lock()
            defer { lock.unlock() }
            challengeRequests += 1
            guard challengeIndex < challenges.count else { return nil }
            let next = challenges[challengeIndex]
            challengeIndex += 1
            return next
        }

        func sendVoiceprintScoreTurns(
            sessionKey: String,
            params: [String: JSONValue],
            mode: String,
            timeoutSeconds: TimeInterval
        ) async -> LiveVoiceprintScoreTurnsResult? {
            lock.lock()
            submittedParams.append(params)
            lock.unlock()
            return LiveVoiceprintScoreTurnsResult(payload: .object([
                "ok": .bool(true),
                "sessionKey": .string(sessionKey),
                "turns": .number(Double((params["turns"]?.arrayCount) ?? 0)),
            ]))
        }
    }

    // MARK: - Helpers

    private func challenge(nonce: String, expiresInMs: Double, now: Double) -> LiveVoiceprintEmbeddingChallenge {
        LiveVoiceprintEmbeddingChallenge(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "nonce": .string(nonce),
            "expiresAtMs": .number(now + expiresInMs),
        ]))!
    }

    private func embeddingTurn(id: String) -> LiveVoiceprintScoreTurn {
        let embedder = DeterministicSpeakerEmbedder()
        let samples = (0..<2_048).map { Float(sin(Double($0) * 0.05)) }
        let embedding = try! embedder.embed(samples, sampleRate: 16_000)
        return LiveVoiceprintScoreTurn(
            sessionKey: "realtime:main",
            transcriptItemID: id,
            role: "user",
            startMs: 0,
            endMs: 800,
            embedding: embedding
        )
    }

    private func markerTurn(id: String) -> LiveVoiceprintScoreTurn {
        LiveVoiceprintScoreTurn(
            sessionKey: "realtime:main",
            transcriptItemID: id,
            role: "user",
            startMs: 0,
            endMs: 800
        )
    }

    private func firstTurnObject(_ params: [String: JSONValue]) -> [String: JSONValue]? {
        guard case let .some(.array(turns)) = params["turns"],
              case let .object(first)? = turns.first else { return nil }
        return first
    }

    // MARK: - Fresh nonce requested and attached

    @Test func freshNonceIsRequestedAndAttachedToSubmittedTurn() async {
        let now: Double = 1_000_000
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-fresh", expiresInMs: 60_000, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main",
            mode: "ambient",
            turns: [embeddingTurn(id: "item-1")]
        )

        guard case let .submittedWithNonce(nonces, result) = submission else {
            Issue.record("expected submittedWithNonce, got \(submission)")
            return
        }
        #expect(nonces == ["nonce-fresh"])
        #expect(result?.ok == true)
        #expect(gateway.challengeRequests == 1)
        #expect(gateway.submittedParams.count == 1)

        let turn = firstTurnObject(gateway.submittedParams[0])
        #expect(turn?["nonce"] == .string("nonce-fresh"))
    }

    // MARK: - Exact server keys on the submitted turn

    @Test func submittedTurnCarriesEmbeddingModelAndNonceWithExactServerKeys() async {
        let now: Double = 500_000
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-keys", expiresInMs: 30_000, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        _ = await coordinator.submit(
            sessionKey: "realtime:main",
            mode: "ambient",
            turns: [embeddingTurn(id: "item-keys")]
        )

        let turn = firstTurnObject(gateway.submittedParams[0])
        // sampleEmbedding is a number array.
        guard case let .some(.array(vector)) = turn?["sampleEmbedding"] else {
            Issue.record("sampleEmbedding missing / not an array")
            return
        }
        #expect(vector.count == 192)
        #expect(vector.allSatisfy { if case .number = $0 { return true }; return false })
        // sampleEmbeddingModel object with the exact server keys.
        guard case let .some(.object(model)) = turn?["sampleEmbeddingModel"] else {
            Issue.record("sampleEmbeddingModel missing / not an object")
            return
        }
        #expect(model["provider"] == .string("reference"))
        #expect(model["modelId"] == .string("reference-hash-v1"))
        // The fresh nonce with the exact server key.
        #expect(turn?["nonce"] == .string("nonce-keys"))
    }

    // MARK: - Single-use: two submissions request two nonces

    @Test func nonceIsSingleUseAcrossTwoSubmissions() async {
        let now: Double = 2_000_000
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-A", expiresInMs: 60_000, now: now),
            challenge(nonce: "nonce-B", expiresInMs: 60_000, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let first = await coordinator.submit(
            sessionKey: "realtime:main", mode: "ambient", turns: [embeddingTurn(id: "item-1")]
        )
        let second = await coordinator.submit(
            sessionKey: "realtime:main", mode: "ambient", turns: [embeddingTurn(id: "item-2")]
        )

        // Each submission requested its OWN nonce — never reuse one.
        #expect(gateway.challengeRequests == 2)
        guard case let .submittedWithNonce(noncesA, _) = first,
              case let .submittedWithNonce(noncesB, _) = second else {
            Issue.record("expected two nonce-bound submissions")
            return
        }
        #expect(noncesA == ["nonce-A"])
        #expect(noncesB == ["nonce-B"])
        #expect(noncesA != noncesB)
        #expect(firstTurnObject(gateway.submittedParams[0])?["nonce"] == .string("nonce-A"))
        #expect(firstTurnObject(gateway.submittedParams[1])?["nonce"] == .string("nonce-B"))
    }

    // MARK: - Per-turn nonce: a multi-embedding batch stamps a distinct nonce per turn

    /// Regression: the gateway consumes a nonce per eligible turn (verifyAndConsume
    /// inside the per-turn scoring loop), so a batch with 2+ embedding turns must carry
    /// a DISTINCT fresh nonce on each turn. A single batch-wide nonce would be burned
    /// on turn #1 and the server would reject the whole batch on turn #2's consumed nonce.
    @Test func multiEmbeddingBatchStampsDistinctNoncePerTurn() async {
        let now: Double = 7_000_000
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-1", expiresInMs: 60_000, now: now),
            challenge(nonce: "nonce-2", expiresInMs: 60_000, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main",
            mode: "ambient",
            turns: [embeddingTurn(id: "item-1"), embeddingTurn(id: "item-2")]
        )

        guard case let .submittedWithNonce(nonces, _) = submission else {
            Issue.record("expected submittedWithNonce for a 2-embedding batch, got \(submission)")
            return
        }
        // One fresh nonce requested PER embedding turn, all distinct.
        #expect(gateway.challengeRequests == 2)
        #expect(nonces == ["nonce-1", "nonce-2"])
        // A single batch submission, with each turn stamped its OWN nonce.
        #expect(gateway.submittedParams.count == 1)
        guard case let .some(.array(turns)) = gateway.submittedParams[0]["turns"],
              case let .object(t0)? = turns.first,
              turns.count == 2,
              case let .object(t1) = turns[1] else {
            Issue.record("expected two submitted turns")
            return
        }
        #expect(t0["nonce"] == .string("nonce-1"))
        #expect(t1["nonce"] == .string("nonce-2"))
    }

    /// Fail-closed for a multi-embedding batch: if the SECOND turn's challenge fails,
    /// the whole batch's embeddings are dropped and nothing is submitted (no partial /
    /// nonce-less embedding ever reaches the gateway).
    @Test func multiEmbeddingBatchFailsClosedIfAnyTurnNonceUnavailable() async {
        let now: Double = 8_000_000
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-ok", expiresInMs: 60_000, now: now),
            nil, // second turn's challenge fails
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main",
            mode: "ambient",
            turns: [embeddingTurn(id: "item-1"), embeddingTurn(id: "item-2")]
        )

        guard case .markersOnly(.challengeUnavailable) = submission else {
            Issue.record("expected markersOnly(.challengeUnavailable), got \(submission)")
            return
        }
        // FAIL-CLOSED: no score_turns submitted at all — not even the first turn's
        // successfully-nonced embedding — because the batch could not be fully bound.
        #expect(gateway.submittedParams.isEmpty)
    }

    // MARK: - Expired nonce is NOT attached (refetch semantics)

    @Test func expiredNonceIsNotAttachedAndDegradesToMarkers() async {
        let now: Double = 3_000_000
        // Challenge already at expiry (0ms left) → must be treated as gone.
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-stale", expiresInMs: 0, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main", mode: "ambient", turns: [embeddingTurn(id: "item-x")]
        )

        guard case let .markersOnly(reason) = submission else {
            Issue.record("expected markersOnly for expired nonce, got \(submission)")
            return
        }
        #expect(reason == .challengeExpired)
        // A challenge WAS requested (the coordinator would refetch), but the stale
        // nonce was never attached — and NO score_turns is re-submitted, because the
        // realtime_event marker path already reported these turns to the gateway.
        #expect(gateway.challengeRequests == 1)
        #expect(gateway.submittedParams.isEmpty)
    }

    @Test func nonceWithinSafetyMarginIsTreatedAsExpired() async {
        let now: Double = 4_000_000
        // Nonce expires in 100ms but the default safety margin is 500ms → too close.
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "nonce-marginal", expiresInMs: 100, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main", mode: "ambient", turns: [embeddingTurn(id: "item-m")]
        )
        guard case .markersOnly(.challengeExpired) = submission else {
            Issue.record("expected markersOnly(.challengeExpired), got \(submission)")
            return
        }
        // Marginal (soon-to-expire) nonce is treated as gone: nothing re-submitted.
        #expect(gateway.submittedParams.isEmpty)
    }

    // MARK: - Challenge failure → fail-closed, no embedding submitted

    @Test func challengeFailureSubmitsNoEmbeddingAndFallsBackToMarkers() async {
        let now: Double = 5_000_000
        // Challenge returns nil (offline / rejected).
        let gateway = FakeLivenessGateway(challenges: [nil])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main", mode: "ambient", turns: [embeddingTurn(id: "item-f")]
        )

        guard case let .markersOnly(reason) = submission else {
            Issue.record("expected markersOnly for failed challenge, got \(submission)")
            return
        }
        #expect(reason == .challengeUnavailable)
        #expect(gateway.challengeRequests == 1)
        // FAIL-CLOSED: the embedding is dropped and NO score_turns is issued. These
        // turns already reached the gateway via the realtime_event marker path, so a
        // markers-only re-submission would be redundant ingestion. Clean no-op.
        #expect(gateway.submittedParams.isEmpty)
    }

    // MARK: - No embedding turns → coordinator is a no-op

    @Test func noEmbeddingTurnsIsNoOp() async {
        let now: Double = 6_000_000
        let gateway = FakeLivenessGateway(challenges: [
            challenge(nonce: "unused", expiresInMs: 60_000, now: now),
        ])
        let coordinator = VoiceprintLivenessCoordinator(gateway: gateway, nowMs: { now })

        let submission = await coordinator.submit(
            sessionKey: "realtime:main", mode: "ambient", turns: [markerTurn(id: "m1")]
        )

        #expect(submission == .noEmbeddingTurns)
        // No challenge requested, nothing submitted — the caller's marker path owns it.
        #expect(gateway.challengeRequests == 0)
        #expect(gateway.submittedParams.isEmpty)
    }

    // MARK: - Result parsing

    @Test func embeddingChallengeRejectsMissingOrEmptyNonce() {
        #expect(LiveVoiceprintEmbeddingChallenge(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("k"),
            "nonce": .string(""),
            "expiresAtMs": .number(1),
        ])) == nil)
        #expect(LiveVoiceprintEmbeddingChallenge(payload: .object([
            "ok": .bool(false),
            "sessionKey": .string("k"),
            "nonce": .string("n"),
            "expiresAtMs": .number(1),
        ])) == nil)
        #expect(LiveVoiceprintEmbeddingChallenge(payload: nil) == nil)
    }

    @Test func embeddingChallengeParsesValidPayload() {
        let parsed = LiveVoiceprintEmbeddingChallenge(payload: .object([
            "ok": .bool(true),
            "sessionKey": .string("realtime:main"),
            "nonce": .string("abc"),
            "expiresAtMs": .number(1_234),
        ]))
        #expect(parsed?.nonce == "abc")
        #expect(parsed?.sessionKey == "realtime:main")
        #expect(parsed?.expiresAtMs == 1_234)
    }
}

private extension JSONValue {
    var arrayCount: Int? {
        if case let .array(values) = self { return values.count }
        return nil
    }
}
