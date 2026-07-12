import Foundation

/// Scalar-only identity summary pushed by the gateway (WS1). This is the SAME
/// shape on both delivery channels:
///  1. the piggyback `identity` field on the `identity.voiceprint.realtime_event`
///     RESPONSE (without `sessionKey`), and
///  2. the edge-triggered `voiceprint.identity` broadcast EventFrame payload
///     (with `sessionKey`).
///
/// Wire keys (verified against `VoiceprintIdentitySummary` in
/// `src/gateway/voiceprint-auto-score.ts`):
///   { verdict: "owner_present"|"provisional"|"not_owner"|"unknown",
///     decision?: <string>, confidence: <number>, at: <ISO string> }
///
/// Never carries embeddings, audio paths, or secrets (A7 discipline). `verdict`
/// and `at` are the only REQUIRED fields; a payload missing either — or carrying a
/// non-string verdict — fails to parse (returns nil), which the state machine
/// treats as "no identity", never a false owner.
struct LiveVoiceprintIdentitySummary: Equatable {
    var verdict: String
    var decision: String?
    var confidence: Double?
    var at: String
    /// Present only on the broadcast channel; nil on the piggyback channel.
    var sessionKey: String?

    init(verdict: String, decision: String? = nil, confidence: Double? = nil, at: String, sessionKey: String? = nil) {
        self.verdict = verdict
        self.decision = decision
        self.confidence = confidence
        self.at = at
        self.sessionKey = sessionKey
    }

    /// Parse from a decoded JSON object (piggyback or broadcast). FAIL-SAFE: a
    /// missing/garbled `verdict` or `at` returns nil so the caller degrades quietly.
    init?(object: [String: JSONValue]) {
        guard
            case let .some(.string(verdict)) = object["verdict"],
            case let .some(.string(at)) = object["at"]
        else {
            return nil
        }
        self.verdict = verdict
        self.at = at
        if case let .some(.string(decision)) = object["decision"] {
            self.decision = decision
        } else {
            self.decision = nil
        }
        if case let .some(.number(confidence)) = object["confidence"] {
            self.confidence = confidence
        } else {
            self.confidence = nil
        }
        if case let .some(.string(sessionKey)) = object["sessionKey"] {
            self.sessionKey = sessionKey
        } else {
            self.sessionKey = nil
        }
    }
}

/// The stabilized owner verdicts the gateway can push. Mirrors
/// `SpeakerEvidenceVerdict` in `src/identity/voiceprint/evidence.ts`. An unknown
/// wire string decodes to `.unrecognized` — which the state machine treats like
/// `unknown` and NEVER as an owner (fail-safe against a garbled payload).
enum LiveVoiceprintVerdict: Equatable {
    case ownerPresent
    case provisional
    case notOwner
    case unknown
    case unrecognized

    init(wire: String) {
        switch wire {
        case "owner_present": self = .ownerPresent
        case "provisional": self = .provisional
        case "not_owner": self = .notOwner
        case "unknown": self = .unknown
        default: self = .unrecognized
        }
    }

    /// A "hard" verdict — a settled establish/flip target. Mirrors the server's
    /// `isHardVerdict` (owner_present / not_owner).
    var isHard: Bool {
        self == .ownerPresent || self == .notOwner
    }
}

/// The action the edge-triggered identity state machine decided for one incoming
/// summary. `.none` means de-duped or below the establish/flip edge — the caller
/// does NOTHING (no injection, no relabel). `.apply` means an identity edge fired
/// and the caller should inject exactly one context item + relabel once.
enum LiveVoiceprintIdentityAction: Equatable {
    case none
    case apply(verdict: LiveVoiceprintVerdict, injection: String, label: String)
}

/// Edge-triggered owner-identity state machine for a single live session.
///
/// The gateway already edge-triggers its `voiceprint.identity` BROADCAST, but the
/// piggyback `identity` field is present on EVERY realtime_event response that
/// folded any state — so it repeats the current verdict. This client-side machine
/// re-applies the edge discipline over BOTH channels and de-dupes across them, so
/// the agent injection + UI relabel happen at most once per genuine establish/flip.
///
/// EDGE RULE (mirrors `src/gateway/voiceprint-auto-score.ts` fold): apply ONLY
/// when the incoming verdict differs from the last-applied verdict AND at least one
/// side of the transition is a hard verdict (owner_present / not_owner) — i.e. an
/// identity ESTABLISH (unknown/provisional -> hard) or FLIP (hard -> anything). The
/// unknown -> provisional drift is not an identity event; a same-verdict repeat is
/// a no-op.
///
/// DE-DUPE across the two channels: both carry the same { verdict, at }. An
/// incoming summary whose (verdict, at) has already been applied — or whose verdict
/// equals the last-applied verdict — yields `.none`. `at` is compared as an opaque
/// string equality guard (a repeat push replays the same ISO timestamp).
///
/// FAIL-SAFE: an `.unrecognized` verdict (garbled/unknown wire string) can never be
/// a hard verdict, so it never establishes/flips into an owner; it is treated like
/// `unknown`.
struct LiveVoiceprintIdentityMachine: Equatable {
    private(set) var lastAppliedVerdict: LiveVoiceprintVerdict = .unknown
    private(set) var lastAppliedAt: String?

    /// Feed one pushed summary. Returns the action to take (pure — no side effects).
    mutating func ingest(_ summary: LiveVoiceprintIdentitySummary) -> LiveVoiceprintIdentityAction {
        let verdict = LiveVoiceprintVerdict(wire: summary.verdict)

        // DE-DUPE: identical (verdict, at) already applied → nothing to do.
        if verdict == lastAppliedVerdict, summary.at == lastAppliedAt {
            return .none
        }
        // Same verdict (even with a newer `at`) is not an identity edge.
        if verdict == lastAppliedVerdict {
            // Still advance the `at` marker so a later same-verdict repeat de-dupes,
            // but take no action.
            lastAppliedAt = summary.at
            return .none
        }

        // EDGE: verdict changed AND at least one side is a hard verdict.
        let isEdge = verdict.isHard || lastAppliedVerdict.isHard
        guard isEdge else {
            // e.g. unknown -> provisional: track the verdict but do not inject/relabel.
            lastAppliedVerdict = verdict
            lastAppliedAt = summary.at
            return .none
        }

        lastAppliedVerdict = verdict
        lastAppliedAt = summary.at
        return .apply(
            verdict: verdict,
            injection: Self.injectionText(for: verdict),
            label: Self.uiLabel(for: verdict)
        )
    }

    /// The exactly-one system context item text injected into the Realtime session
    /// on an establish/flip. Only owner_present / not_owner reach here as hard
    /// verdicts; provisional/unknown reach here only on a FLIP AWAY from a hard
    /// verdict (identity lost), for which we tell the model the speaker is no longer
    /// confirmed.
    /// The wording matters twice over (A/B-verified on gpt-realtime-2):
    /// 1. OpenAI realtime models are trained to DISCLAIM voice recognition, so a
    ///    bare fact ("the speaker is the owner") loses to that prior when the
    ///    user asks "can you recognize my voice?". The injection must attribute
    ///    the verification to Hawky's voiceprint system — the app did it, not
    ///    the model — and tell the model to rely on it.
    /// 2. Over-attributing reads like an engineering demo: without the "don't
    ///    explain the mechanism" clause the model recites "Hawky's voiceprint
    ///    system verified..." on every identity question. The natural target is
    ///    a familiar-person response ("Yep — I know I'm talking to you"), with
    ///    the mechanism explained only when the user asks HOW it knows.
    static func injectionText(for verdict: LiveVoiceprintVerdict) -> String {
        switch verdict {
        case .ownerPresent:
            return "Hawky's voiceprint system verified the current speaker's voice: they are the device owner (the app verified this, not you). Just know who you're talking to — treat and address them as the owner naturally, like a familiar person. If they ask whether you know who they are, confirm briefly and warmly; do NOT explain the verification mechanism or mention the voiceprint system unless they specifically ask HOW you know."
        case .notOwner:
            return "Hawky's voiceprint system checked the current speaker's voice: it does NOT match the device owner, so treat them as a guest — naturally, without announcing it or mentioning the verification unless they ask how you know. Do not assume they are the owner."
        default:
            // Identity flipped away from a hard verdict back to provisional/unknown.
            return "Hawky's voiceprint system can no longer confirm the current speaker's identity; quietly treat it as unverified until Hawky confirms again — no need to mention this unless asked."
        }
    }

    /// Short UI indicator text for the retro-label / owner banner.
    static func uiLabel(for verdict: LiveVoiceprintVerdict) -> String {
        switch verdict {
        case .ownerPresent:
            return "Owner speaking"
        case .notOwner:
            return "Unknown speaker"
        default:
            return "Speaker unconfirmed"
        }
    }
}
