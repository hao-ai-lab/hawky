import Foundation

/// The gateway surface the liveness coordinator needs (workflow B2).
///
/// Abstracted as a protocol so the fail-closed nonce logic is unit-testable with a
/// fake, without a live `LiveGatewayBridge` actor / websocket. `LiveGatewayBridge`
/// conforms via a tiny extension below.
protocol VoiceprintLivenessGateway: Sendable {
    /// Request a fresh A8 liveness challenge (single-use, session-bound, TTL-bound
    /// nonce). Returns nil on any failure — the coordinator FAILS CLOSED on nil.
    func requestVoiceprintEmbeddingChallenge(
        sessionKey: String,
        mode: String,
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintEmbeddingChallenge?

    /// Submit B1-serialized score_turns params. Returns nil on transport failure.
    func sendVoiceprintScoreTurns(
        sessionKey: String,
        params: [String: JSONValue],
        mode: String,
        timeoutSeconds: TimeInterval
    ) async -> LiveVoiceprintScoreTurnsResult?
}

extension LiveGatewayBridge: VoiceprintLivenessGateway {}

/// The outcome of one embedding-carrying submission attempt. Surfaced so the
/// caller (and tests) can see whether the fresh-nonce path was taken or the
/// submission fell back to markers.
enum VoiceprintLivenessSubmission: Equatable {
    /// A fresh nonce was obtained for EVERY embedding turn and attached; the batch was
    /// submitted with the embedding turns intact. `nonces` holds the exact nonce
    /// consumed per embedding turn, in turn order (one per embedding-carrying turn) —
    /// the server consumes a nonce per eligible turn, so each turn carries its own.
    case submittedWithNonce(nonces: [String], result: LiveVoiceprintScoreTurnsResult?)
    /// No fresh nonce could be obtained (challenge failed or was already expired on
    /// arrival). Per the fail-closed rule the embeddings are DROPPED for this batch
    /// and NO score_turns submission is issued: these turns arrive from
    /// `realtime_event.finalizedTurns`, which already reported them to the gateway,
    /// so re-sending them markers-only would be redundant ingestion. The coordinator
    /// simply skips the embedding for this batch (clean no-op) rather than doing a
    /// duplicate marker submission for turns the server has already seen.
    case markersOnly(reason: MarkersReason)
    /// Nothing to submit (no turns, or none carried an embedding so no nonce is
    /// needed and this coordinator has nothing to do — the caller's marker path owns it).
    case noEmbeddingTurns

    enum MarkersReason: Equatable {
        /// request_embedding_challenge returned nil (offline / rejected / bad payload).
        case challengeUnavailable
        /// The challenge came back but was already at/after its TTL (with margin).
        case challengeExpired
    }
}

/// Binds a fresh A8 liveness nonce to an embedding-carrying score_turns submission
/// (workflow B2). The core invariant is FAIL-CLOSED:
///
/// - A client embedding is NEVER submitted without a fresh, unexpired nonce.
/// - Each nonce is treated as SINGLE-USE: every embedding-carrying TURN requests its
///   OWN nonce (the server calls verifyAndConsume once per eligible turn, so a single
///   batch-wide nonce would be burned on the first turn and reject the rest). This
///   type holds no nonce state to reuse, and the consumed nonces are returned to the
///   caller only for observability.
/// - A nonce is never attached at/after `expiresAtMs` (minus a safety margin) —
///   such a nonce is discarded and the embedding for that batch is dropped.
/// - Any failure drops the embedding for the batch (fail-closed) without issuing a
///   redundant markers-only submission — those turns were already reported to the
///   gateway by the `realtime_event` marker path. It never crashes, blocks, or
///   submits an embedding turn without a nonce.
///
/// This type is deliberately stateless w.r.t. nonces so there is no way to
/// accidentally reuse one across submissions.
struct VoiceprintLivenessCoordinator: Sendable {
    private let gateway: VoiceprintLivenessGateway
    /// Refuse to attach a nonce this close to (or past) its expiry, so a nonce that
    /// would expire in flight is treated as already gone. Also guards clock skew.
    private let expirySafetyMarginMs: Double
    /// Clock used to compare against `expiresAtMs`. Injectable for tests.
    private let nowMs: @Sendable () -> Double
    private let challengeTimeoutSeconds: TimeInterval
    private let scoreTimeoutSeconds: TimeInterval

    init(
        gateway: VoiceprintLivenessGateway,
        expirySafetyMarginMs: Double = 500,
        challengeTimeoutSeconds: TimeInterval = 10,
        scoreTimeoutSeconds: TimeInterval = 15,
        nowMs: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    ) {
        self.gateway = gateway
        self.expirySafetyMarginMs = max(0, expirySafetyMarginMs)
        self.challengeTimeoutSeconds = challengeTimeoutSeconds
        self.scoreTimeoutSeconds = scoreTimeoutSeconds
        self.nowMs = nowMs
    }

    /// Submit a batch of score_turns. For EACH turn carrying an on-device embedding,
    /// obtain its OWN fresh nonce and attach it before submitting — the gateway
    /// consumes a nonce per eligible turn, so a single batch-wide nonce would be burned
    /// on the first turn and the server would reject the whole batch on the second. If
    /// a fresh, unexpired nonce cannot be obtained for ANY embedding turn, DROP the
    /// embeddings for the entire batch and issue NO submission (`.markersOnly`,
    /// fail-closed): these turns already reached the gateway via the `realtime_event`
    /// marker path, so a markers-only re-submission would be redundant ingestion. If no
    /// turn carries an embedding, this coordinator is a no-op (`.noEmbeddingTurns`) —
    /// the caller's existing marker path already covers that case.
    func submit(
        sessionKey: String,
        mode: String,
        turns: [LiveVoiceprintScoreTurn]
    ) async -> VoiceprintLivenessSubmission {
        let hasEmbedding = turns.contains { $0.embedding != nil }
        guard hasEmbedding else {
            return .noEmbeddingTurns
        }

        // FAIL-CLOSED: obtain one fresh, unexpired nonce per embedding-carrying turn
        // BEFORE attaching any. If ANY fails, drop the whole batch's embeddings WITHOUT
        // re-submitting — the realtime_event marker path already reported these turns.
        var nonces: [String] = []
        for turn in turns where turn.embedding != nil {
            guard let challenge = await gateway.requestVoiceprintEmbeddingChallenge(
                sessionKey: sessionKey,
                mode: mode,
                timeoutSeconds: challengeTimeoutSeconds
            ) else {
                return .markersOnly(reason: .challengeUnavailable)
            }
            // TTL guard: never attach a nonce at/after its expiry (with a safety margin).
            guard nowMs() + expirySafetyMarginMs < challenge.expiresAtMs else {
                return .markersOnly(reason: .challengeExpired)
            }
            nonces.append(challenge.nonce)
        }

        // Stamp each embedding-carrying turn its OWN fresh nonce, in turn order. Each
        // nonce is single-use: this batch is the only submission that will carry it,
        // and the coordinator holds no state to reuse any on a later call.
        var remaining = nonces[...]
        let stamped = turns.map { turn -> LiveVoiceprintScoreTurn in
            guard turn.embedding != nil else { return turn }
            var copy = turn
            copy.nonce = remaining.popFirst()
            return copy
        }
        let params = LiveVoiceprintScoreTurn.scoreTurnsParams(sessionKey: sessionKey, turns: stamped)
        let result = await gateway.sendVoiceprintScoreTurns(
            sessionKey: sessionKey,
            params: params,
            mode: mode,
            timeoutSeconds: scoreTimeoutSeconds
        )
        return .submittedWithNonce(nonces: nonces, result: result)
    }
}
