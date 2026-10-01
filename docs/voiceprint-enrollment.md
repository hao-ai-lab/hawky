# hawky Voiceprint — Owner enrollment guide

How the device owner teaches hawky their voice, for both the user reading the
screen and the engineer wiring it. Enrollment builds the encrypted **owner
template** that live recognition scores every turn against
(`voiceprint-architecture.md`). The single design constraint that shapes every
decision here: the template must be built from audio captured through the SAME
path recognition scores. This document explains why, the flow that satisfies it,
and the `enroll_owner_from_recording` RPC contract.

Primary code:
- `ios/hawky/Voiceprint/OwnerEnrollmentModel.swift` — all enrollment logic + copy.
- `ios/hawky/Views/OwnerEnrollmentView.swift` — the thin SwiftUI shell.
- `ios/hawky/Live/LiveSessionStore.swift` — the silent listening session + journal isolation.
- `src/gateway/voiceprint-methods.ts` / `voiceprint-enrollment.ts` — the RPC + segment selection.

---

## The capture-domain-parity requirement (why a standalone recorder can never work)

Live recognition scores audio captured through Apple's voice-processing I/O
(`MicAudioSource(voiceProcessing: true)` — AEC/AGC/NS) inside a WebRTC realtime
session. A template enrolled from RAW audio (a `.measurement`-mode recorder with
no processing) is acoustically **orthogonal** to that domain for the *same*
speaker: measured cross-domain cosine 0.01–0.14, versus ~0.6–0.7 within a
domain. The owner would enroll cleanly and then never match at recognition time,
with no visible error — the single most expensive bug in device acceptance.

The fix is structural, not a tuning knob: **enrollment captures through the exact
same capture path as recognition.** So enrollment is not a bespoke recorder — it
runs a real (but silent) live session, uploads the same `.segNNN.mic` segments
recognition uses, and builds the template from those. A standalone raw recorder
is retired precisely because it cannot satisfy this. (`OwnerEnrollmentRecorder.swift`
documents the parity contract; the shipped flow uses the live session below.)

---

## The listening-session flow (user-facing)

The enrollment screen reads top-to-bottom as **consent → record → enroll**:

1. **Consent (Step 1).** A biometric + capture consent toggle. It comes FIRST
   because the listening session uploads biometric audio *while it runs* — nothing
   may be captured before opt-in. "Start listening" stays disabled until consent
   is granted. Copy: *"Required before Hawky starts listening — nothing is captured
   or enrolled until you turn this on. You can delete your voice template at any
   time."*
2. **Read-aloud prompts.** A short numbered script of lines to read, given primary
   weight so the eye finds "these are my lines" against the surrounding explanation.
3. **Record (Step 2) — the silent live session.** Tapping **Start listening** opens
   a real live session with the model muted (see the override below). The user
   talks for about a minute; a live **"Xs / 60s of speech"** meter tracks progress
   against the guided target. Tapping **Stop listening** ends the take. The button
   shows a **"Connecting…"** phase while the live/WebRTC channel comes up (it can
   lag on a slow network), then **"Stop listening"** while active.
4. **Enroll (Step 3).** Once enough voiced speech is captured, **Enroll my voice**
   becomes the filled primary action; it submits all captured takes together.

A `nextStepBanner` always names the single next action ("Step 1 — turn on
biometric consent below", etc.) so the user never guesses.

### Silent-session override + journal isolation

The listening session runs under a TEMPORARY config override
(`LiveSessionStore.enrollmentListeningConfigOverride`): `audioInputEnabled`,
`mediaPersistenceMode = .liveUpload`, visual off, cocktail-party off, safety-check
off, `speakOnlyWhenSpokenTo`, `openingBehavior = .silent`, and — critically —
`conversationJournalingEnabled = false`. The provider is put in silence mode
(`setSilenceMode(true)`) so the model never talks over the enrollment monologue.

`conversationJournalingEnabled` is a transient, never-persisted flag (default
`true`). Setting it false makes the enrollment session leave **no trace in the
conversation record**: no app chat entries, no session-journal lines, no gateway
transcript appends (the latent recognizer), and no session-end memory distill.
One flag gates all of those paths (`transcriptAppendRuntimeTarget`,
`conversationRecordSuppressed`). FAIL-CLOSED default: only an explicit override
suppresses. The enrollment monologue is biometric capture, not conversation — it
must not leak into the user's chat history.

---

## Multi-take semantics ("Continue recording")

One listening session = one "take" = one recording base id (e.g.
`live-20260713-135209`, the base of its `.segNNN.mic` segments). After a take,
the user may tap **Continue recording** to open a *fresh* take that ACCUMULATES on
top — earlier takes and the server-count anchor are kept; only the in-progress
meter restarts. Up to **10 distinct takes** (`OwnerEnrollmentModel.maxTakes` /
`ENROLL_FROM_RECORDING_MAX_TAKES`) enroll TOGETHER, in record order, in a single
`enroll_owner_from_recording` call. Past the limit, Continue recording disables
with honest copy (the gateway rejects an 11th id outright, which would doom every
submit). **Start over** discards all captured takes.

---

## The 60s guided target (rationale + measured numbers)

Three thresholds, all in `OwnerEnrollmentModel`:

- **`serverVoicedFloorMs = 30_000`** — the gateway clamps `minSpeechMs` to ≥30s of
  VOICED speech; the client cannot lower it. This is the hard floor for acceptance.
- **`voicedFraction = 0.74`** — the sidecar counts VOICED duration at ~74% of clip
  length, so the client's live meter (wall-clock × 0.74) tracks the server's voiced
  count. 30s voiced ≈ ~40s of wall-clock talking.
- **`guidedVoicedTargetMs = 60_000`** — the target the UI gates on: **twice** the
  server floor. Measured on device: a template enrolled at the bare 30s floor scores
  live turns in the `possible_owner` grey band (**0.74–0.76**) and the owner never
  establishes; **~60s** scores **0.79–0.84** and establishes in seconds. The server
  still ACCEPTS anything over its 30s floor (a server-counted 45s take enrolls fine)
  — the 60s target only drives the client gate, the progress denominator, and the
  "keep talking" hint.

On the gateway side, selection is bounded to **~180s of SEGMENT audio**
(`ENROLL_FROM_RECORDING_MAX_MS` / `ENROLL_FROM_RECORDING_TOTAL_MAX_MS = 180_000`).
Conversation segments run ~0.47–0.53 voiced, so 180s of segment audio yields
~85–95s of voiced speech — well past the floor, with diminishing returns beyond
that for a CAM++ centroid. **This budget was raised from 90s**: the old 90s cap
silently pinned every enrollment at ~41s voiced no matter how long the user
talked, which is exactly the grey-band regime above. The per-recording bound must
stay ≥ the total budget so a single long take is never silently re-capped.

---

## Failure states and their copy

| State | When | Copy |
|---|---|---|
| `needsConsent` | Captured audio but consent not granted | Submit blocked: *"Turn on biometric consent above to enroll."* |
| `tooShort` | Voiced speech below the guided target (client) OR a server `not_enough_speech` rejection | *"Keep talking about N more seconds — tap Continue recording above and talk a bit longer."* (N prefers the server's exact shortfall over the wall-clock estimate.) |
| Listening-start failure — mic denied | `AVAudioApplication.recordPermission == .denied` | *"Microphone access is turned off for Hawky. Allow the microphone in Settings, then try again."* + an **Open Settings** button. |
| Listening-start failure — no gateway | No enrollment gateway configured | *"Hawky gateway is not reachable — connect first to enroll."* |
| Listening-start failure — live channel | Gateway control connection up but the realtime WebRTC/live-audio channel didn't come up (or the store's concrete reason) | *"Couldn't start the realtime voice session — your gateway is connected, but the live audio channel didn't come up. …"* (or the store's `lastEnrollmentListeningStartFailure`) + a **Try again** button. |
| No capture | Recording never opened (mic warm-up failure) | *"No audio was captured — try again."* |
| `quality_rejected` (submit) | Selected segments failed the quality gate | *"Too noisy — try somewhere quieter."* |
| `no_usable_segments` (submit) | Segments never uploaded / broken timeline | *"Upload didn't complete — try again."* |
| `enrolled` (capped) | Accepted, but selection hit the 180s budget (`segmentsCapped > 0`) | *"Enrolled from the first Ns of your speech — you talked more than needed, so the rest wasn't used. Your voice is set up."* |
| `enrolled` (normal) | Accepted, nothing capped | *"Enrolled from Ns of your speech. Your voice is set up."* |

Copy discipline (all in `OwnerEnrollmentModel`): blame the microphone ONLY when
its permission is *actually* denied (checked against `AVAudioApplication`, never
guessed); distinguish the gateway control channel from the separate live-audio
channel so an error never contradicts the Settings "connected" status; and be
honest about capping instead of implying all of the user's speech was used.
Listening failures render next to the listen button; submit failures render under
the Enroll button.

---

## Re-enroll / replace semantics

Enrollment overwrites: submitting a new set of takes writes a fresh owner template
(`writeOwnerTemplateFromSources`). When a template already exists, the screen
detects it via `owner_template_status` (`existingEnrollment.enrolled`) and, before
any new take is recorded, shows a **done** framing ("Your owner voice") + a neutral
*"Re-record any time to replace your voice template — aim for about a minute of
speech."* hint instead of a setup call-to-action. The "Xs / 60s" meter stays hidden
in that state (a zeroed meter next to "you already have a template" is a
contradictory simultaneous state). Deleting the template is a separate action
(`delete_owner_template`); deleting the encryption key is right-to-erasure.

Enrolling here sets up the template ONLY — it does NOT enable live voiceprint
scoring, which stays a separate, still-off switch. Reaching this screen never flips
any flag.

---

## The RPC contract: `identity.voiceprint.enroll_owner_from_recording`

Registered in `src/gateway/voiceprint-methods.ts`; params parsed by
`parseEnrollOwnerFromRecordingParams`, built on iOS by
`OwnerEnrollmentModel.enrollOwnerFromRecordingParams`.

### Params

| Field (wire key) | Type | Notes |
|---|---|---|
| `recordingBaseIds` | `string[]` | **1..10 DISTINCT** recording base ids, in take order. Each must match the media-id regex (`[A-Za-z0-9._-]`, no path separators / no `:`), which both validates it and makes root-escape impossible. Back-compat: `recording_base_ids`, or a single `recordingBaseId` / `recording_base_id`, are also accepted. |
| `consent` | object | Per-scope consent snapshot (`capture_allowed`, `biometric_allowed`, …). The RPC is consent-audited; a missing/denied biometric+capture scope rejects. |
| `sessionKey` | `string?` | Optional; the gateway derives it from the connection when omitted. |
| `minSpeechMs` | `number?` | Optional voiced-speech floor; clamped by the gateway to ≥30s (the client cannot lower it). |

### Selection pipeline (server)

For each base id, `selectEnrollmentSegmentsFromRecording` picks the finalized
`.segNNN.mic` segments, drops quality failures and segments after a timeline gap,
and caps at the per-recording bound. Across all takes, a running total enforces
the global budget (`ENROLL_FROM_RECORDING_TOTAL_MAX_MS = 180_000`); segments past
it count as `capped`. If nothing is usable, it returns a `rejected` result in the
SAME shape the shared flow produces (never a bare throw), with an honest reason
(`quality_rejected` vs `no_usable_segments`). Otherwise the selected segments run
through the shared `runOwnerEnrollment` (embed → assess → write template).

### Response

Accepted (`serializeEnrollmentSuccess` + the additive segment counts):

```jsonc
{
  "ok": true,
  "sessionKey": "…",
  "status": "accepted",
  "templateRef": "…",          // the stored template id
  "speechMs": 87000,            // total voiced speech in the template
  "sourceCount": 42,            // enrolled sources
  "ownerEmbeddingCount": 42,    // embeddings in the template centroid
  "quality": { /* enrollment quality assessment */ },

  // Additive, from enroll_owner_from_recording ONLY (nil on enroll_owner /
  // add_enrollment_clip and on older servers — parse optionally):
  "segmentsConsidered": 60,
  "segmentsUsed": 42,
  "segmentsQualityRejected": 6,
  "segmentsCapped": 12,         // > 0 ⇒ the "enrolled from the first Ns" copy
  "segmentsAfterGap": 0
}
```

Rejected (`serializeEnrollmentRejection`, plus the same segment counts):

```jsonc
{
  "ok": false,
  "sessionKey": "…",
  "status": "rejected",
  "reasons": ["not_enough_speech"],   // or ["quality_rejected"] / ["no_usable_segments"]
  "speechMs": 18000,
  "sourceCount": 0,
  "segmentsConsidered": 8, "segmentsUsed": 0,
  "segmentsQualityRejected": 8, "segmentsCapped": 0, "segmentsAfterGap": 0
}
```

The segment counts are logged on BOTH the accepted and rejected paths, so the log
can distinguish "user spoke too little" from "the selection budget capped the
takes" — the exact ambiguity that hid the old 90s cap.

The iOS parser (`LiveVoiceprintEnrollmentResult` in `LiveGatewayBridge.swift`)
reads `ok/status/sessionKey/sourceCount/speechMs/reasons` plus all five
`segments*` counts as optional integers, so `enroll_owner` responses and older
servers that omit them never break parsing.
