# Live turn-taking

Status: this increment landed the persona/VAD/token-cap defaults and the
WebSocket delta-revive latch (all uncommitted on `rich-localbuild`). The WebRTC
mic-unmute + echo-hardening + truncation work is **pending on-device A/B** and
is described here as a plan, not as shipped behavior. Tracking id: **#18**.

This document reflects the current code, including uncommitted changes. All file
references are to the working tree.

---

## 1. The three user-facing problems and their measured root causes

Live mode "talks over you", "over-answers", and "can't be cleanly interrupted".
Each maps to a concrete, located root cause.

### 1a. The assistant barges in before you finish a thought

**Symptom:** the model starts answering during a short mid-sentence pause.

**Root cause — fixed `server_vad` silence window (500 ms).** The old default
turn detector was Server VAD with `vadSilenceDurationMs = 500`
(`ios/hawky/Live/LiveModels.swift`, `LiveSessionConfig.vadSilenceDurationMs`).
Server VAD ends a turn purely on a fixed silence duration, so a normal
thinking pause of ~0.5 s reads as "user finished" and the model responds. This
is a cadence problem, not a threshold problem: raising `vadThreshold` only
changes how loud speech must be to register, not how long a pause must be to
count as end-of-turn.

### 1b. The assistant over-answers (paragraphs where a sentence would do)

**Symptom:** replies that read fine as text but drag as speech — multi-paragraph
answers, full enumerated lists read aloud.

**Root cause — two independent gaps:**

- **No numeric brevity in the persona.** The "concise" persona said only
  "keep responses short" with no per-turn sentence/step budget
  (`src/prompts/registry.ts` `LIVE_PERSONA_CONCISE`, and the iOS fallback
  `LivePromptPreset.concise.defaultInstructions` in
  `ios/hawky/Live/LiveModels.swift`). Soft adjectives under-constrain a
  realtime model that will happily monologue.

- **Absent WebRTC token cap.** `maxResponseOutputTokens` was `nil` (unbounded,
  `"inf"`) by default, and the WebRTC transport never carried a cap at all. The
  cap was only ever attempted on the client-secret mint — and, per 1c/§2, that
  path is the wrong place for it because the mint schema rejects the field. So
  the primary voice transport (WebRTC/pipecat) ran with no output ceiling.

### 1c. Barge-in asymmetry between the two transports

Live has two realtime transports and they interrupt differently:

- **WebSocket transport** (`OpenAIRealtimeLiveSessionProvider`,
  `PipecatOpenAIRealtimeLiveSessionProvider` for config): the client receives
  `.outputAudioDelta` events and plays them locally via
  `LiveRealtimeAudioOutputPlayer`. On barge-in it stops the player.
- **WebRTC transport** (pipecat SDK): audio is decoded and played *inside* the
  SDK; the client sees **no** `.outputAudioDelta`. Interruption is driven
  server-side via `interrupt_response`.

**Root cause of the asymmetry — two distinct defects, one fixed, one pending:**

- **WS delta-revive (now FIXED).** When user speech barged in, the store stopped
  the player, but late `.outputAudioDelta`s from the *just-cancelled* response
  kept arriving and called `play()` again, reviving the audio the user meant to
  interrupt. Located and fixed in `ios/hawky/Live/LiveSessionStore.swift` (the
  `outputAudioDropLatched` latch). See §2.

- **WebRTC mic-mute (still PENDING, device A/B).** On WebRTC the mic is not
  muted during assistant playback, so the assistant's own audio can re-enter the
  mic and either be transcribed as user speech or trigger a false barge-in. The
  client has no local playback to stop (audio lives in the SDK), so the WS latch
  does not apply and does not help here. The mic-unmute + echo-hardening +
  truncation plan (§3) targets this and is unverified on device.

---

## 2. What this increment ships

All four controls below are in the working tree (uncommitted).

### 2a. WS delta-revive drop latch (fixes 1c, WS side)

`ios/hawky/Live/LiveSessionStore.swift` adds `outputAudioDropLatched` plus a set
of **pure, unit-testable** transition helpers so the state machine is testable
without an audio device:

- `outputAudioDropLatchOnSpeechStart(stopsPlayback:current:)` — engages the
  latch on a barge-in that actually stops playback (i.e. only under the
  `interruptAssistant` policy; `letAssistantFinish`/`fullDuplex` leave it off).
- `shouldDropOutputAudioDelta(latched:)` — drops `.outputAudioDelta`s while
  latched, so late deltas from the cancelled response can't revive playback.
- `outputAudioDropLatchOnResponseCreated()` — releases at the next turn's
  `response.created` (new turn owns the floor).
- `outputAudioDropLatchOnResponseTerminal()` + `isResponseTerminalRawType(_:)`
  — **also** releases at the interrupted response's own terminal event
  (`response.done` / `response.cancelled` / `response.failed`). This bounds the
  latch to a single response lifetime so a *spurious* `speech_started` (noise
  that stops playback but spawns no new `response.created`) cannot strand the
  latch and drop the tail of the still-active response.

The latch is also cleared on stop/restart and on WS `.reconnect` so it never
outlives its session leg. **Documented residual edge:** revival safety is a
protocol-ordering assumption — the WS `AsyncStream` serializes deltas before the
terminal in wire order; if a proxy/broker ever interleaved a late delta *after*
terminal, that single delta would play. Closing it fully would require
per-response floor tracking and is deliberately out of scope. This is pinned by
`testStrayDeltaAfterTerminalReleaseIsNotDroppedByLatch`.

Tests: `ios/hawkyTests/LiveOutputAudioDropLatchTests.swift` (pure helpers,
lockstep parity between the terminal classifier and the real `.raw` routing, and
`#if DEBUG` seams — `debugRouteReceivedRawEvent`, `debugRouteSessionEvent`,
`debugOutputAudioDropLatched` — that drive the *real* store routing so a future
refactor dropping the wiring fails the suite, not just the mirrored helpers).

**Scope note:** WS-only. The WebRTC transport plays audio in the pipecat SDK and
emits no `.outputAudioDelta`, so the latch never fires there — which is exactly
why the WebRTC side still needs §3.

### 2b. `semantic_vad` default + migration semantics (fixes 1a)

`ios/hawky/Live/LiveModels.swift`:

- `LiveSessionConfig.turnDetectionMode` default flips
  `.serverVAD` → `.semanticVAD` (eagerness `auto` via `semanticVADEagerness`).
  Semantic VAD waits on end-of-utterance *semantics* rather than a fixed
  silence timer, matching natural speech cadence.
- **Migration is fresh-install-only, fail-closed.** `LiveProfileDefaults.load`
  captures `isLegacyInstall = hasPersistedProfile(defaults:)` (presence of
  `providerKey`, which every old and new `save` writes) **before** any migration
  reads. A legacy install's stored `server_vad` is *ambiguous* — the old build
  persisted the default too, so it is indistinguishable from a deliberate Server
  VAD choice — therefore it is **honored, never stomped**. The new
  `semantic_vad` default reaches only fresh installs (no `providerKey`), via the
  struct default. An orphaned VAD key with no `providerKey` is treated as fresh.
  No versioned migration flag is used: the flip is re-derived from
  `isLegacyInstall` on every load, so a `.vN` guard would be dead state.

The `semantic_vad` / `server_vad` payloads (including `eagerness`) are emitted by
the turn-detection builders in `ios/hawky/Live/LiveSessionProvider.swift`
(WebRTC `buildSessionConfig` ~L1098, WS `turnDetectionPayload` ~L1843).

### 2c. Numeric personas (fixes half of 1b)

`src/prompts/registry.ts` (`LIVE_PERSONA_CONCISE`) and the iOS fallback
`ios/hawky/Live/LiveModels.swift` (`LivePromptPreset.concise.defaultInstructions`)
now carry an explicit per-turn budget: *"Speak in 1-3 short sentences per turn;
for lists or steps, give one item and offer to continue."* The two strings are
intentionally kept in sync (registry is the source of truth; iOS ships a bundled
fallback for offline start).

### 2d. Token cap + the broker finding (fixes the other half of 1b)

`ios/hawky/Live/LiveModels.swift`: `LiveSessionConfig.maxResponseOutputTokens`
gains a non-nil voice default of **800** (a few spoken sentences plus a short
list; user-overridable, range-clamped 1…4096). Persistence uses **sentinel 0 for
"unlimited" (nil)** rather than removing the key, because with a non-nil default
an *absent* key now means "fresh install → apply 800", not "user wants no cap".
Legacy installs with no stored key are resolved to `nil` (their old effective
behavior) and committed as sentinel 0 so the resolution is durable and
idempotent. Covered by `SettingsValidationTests.swift`
(`liveMaxResponseTokensDefaultsToVoiceCap`,
`liveMaxResponseTokensUnlimitedSurvivesReload`,
`liveMaxResponseTokensLegacyUnlimitedStaysUnlimited`, and the VAD-migration tests).

**The broker finding — where the cap can and cannot be applied.** The GA
`/v1/realtime/client_secrets` session schema **rejects**
`max_response_output_tokens` with *"Unknown parameter:
'session.max_response_output_tokens'"* (verified live). Consequences, all now
consistent:

- **Gateway broker** (`src/gateway/live-realtime-broker.ts`,
  `buildRealtimeClientSecretRequest`) documents this and **strips** the field
  (`void sanitizeMaxResponseOutputTokens(...)`); it is accepted on the method
  for back-compat but never forwarded.
- **iOS client-secret mint** — both the broker mint body
  (`OpenAIRealtimeLiveSessionProvider.brokerClientSecretBody`, a pure static so
  the "never sent on mint" invariant is unit-testable) and the direct BYOK mint
  (`requestDirectClientSecret`) intentionally omit the field. Sending it would
  now fail the mint outright, since the field has a non-nil default.
- **The cap is applied on the post-connect `session.update` instead**, where the
  schema accepts it: WebRTC via `buildSessionConfig` /
  `maxResponseOutputTokensValue` (~L1148), which is the transport that
  previously had no cap at all.

---

## 3. Pending device-A/B plan: WebRTC mic-unmute + echo hardening + truncation

This is the still-open half of the barge-in asymmetry (1c, WebRTC side). It is
**not** shipped and must be validated on real hardware, because the failure mode
is acoustic and does not reproduce in the simulator or unit tests.

**What the plan covers:**

1. **Mic-unmute discipline.** On WebRTC the mic is currently not muted during
   assistant playback (`client.enableMic(...)` in
   `ios/hawky/Live/LiveSessionProvider.swift`), so the assistant's own speaker
   output can re-enter the mic. The plan is to mute the mic while the bot is
   speaking and cleanly unmute at end-of-turn (or on a genuine user barge-in),
   symmetric with the WS player-stop path.
2. **Echo hardening.** Verify the platform AEC and noise-reduction settings
   (`LiveNoiseReduction`) actually suppress self-echo on device, so unmuting the
   mic during playback does not feed the assistant's voice back as "user speech".
3. **Truncation flows.** On barge-in, truncate the in-flight assistant item to
   what was actually heard so the transcript and the model's context match the
   audio the user got — analogous to the WS `conversation.item.truncate` path
   (`audio_end_ms: floorGuard.playedMs`, `ios/hawky/Live/LiveSessionProvider.swift`
   ~L2050). WebRTC needs the equivalent applied against the SDK's playback
   position rather than a locally-tracked `playedMs`.

**What to test on device (A/B):**

- Barge-in latency and cleanliness with mic-mute ON vs OFF: does the assistant
  stop promptly, and does the *next* user turn drive the next answer without a
  revived tail?
- Self-echo: with the mic unmuted during playback, does the assistant's own
  audio trigger a false `speech_started`?
- Truncation correctness: after an interrupt, does the persisted transcript
  match the audio the user actually heard?
- Device coverage: at least one older and one newer handset, since AEC quality
  and speaker/mic geometry vary.

**What could go wrong — echo → false interrupts.** The central risk is a
feedback loop: unmuting the mic during playback lets the assistant hear itself,
that self-audio crosses the VAD threshold, the server fires `speech_started`,
Live treats it as a barge-in and interrupts a response the user never meant to
stop. This can also latch: an interrupt triggers a new short response, which is
again heard and interrupted. Mitigations to A/B: keep the mic muted until a
confident user-speech onset, rely on AEC + `farField`/`nearField` noise
reduction, and require a minimum energy/duration before honoring a barge-in.
Fail-closed default: if echo cannot be reliably suppressed on a device, prefer
*not* unmuting mid-playback (accept a slightly later barge-in) over emitting
false interrupts.

---

## 4. How the three verbosity controls compose

Response length in Live is governed by three independent, layered controls.
They compose multiplicatively, not redundantly:

| Control | Where | What it constrains | Failure mode if used alone |
|---|---|---|---|
| **Persona text** (numeric brevity) | `src/prompts/registry.ts`, `LiveModels.swift` persona | *Intent* — how the model chooses to structure a turn (1-3 sentences, one list item + offer) | Advisory; a model can ignore soft instructions under some prompts |
| **Token cap** (`maxResponseOutputTokens`, 800) | `LiveModels.swift` + WebRTC `session.update` | *Hard ceiling* on output length regardless of intent | Truncates mid-sentence if the model ignores the persona; ceiling, not shaping |
| **VAD eagerness** (`semantic_vad` / `semanticVADEagerness`) | `LiveModels.swift` + turn-detection payloads | *When a turn ends* — how much of the user's speech is captured before the model responds | Controls input turn boundaries, not output length |

The intended interaction: the **persona** shapes a naturally short spoken turn;
the **token cap** is the fail-safe ceiling that prevents runaway monologues when
the persona is ignored (it clips length, it does not make text well-formed —
that's the persona's job); and **VAD eagerness** governs the *other* side of the
exchange (turn-taking cadence — when the model is allowed to start), which
indirectly reduces perceived verbosity by not answering half-finished thoughts.
Persona and token cap both act on model output; VAD acts on user input. Tuning
only one leaves an obvious gap (soft persona with no ceiling → occasional
paragraphs; hard cap with a verbose persona → mid-sentence truncation; good
persona/cap with eager VAD → correct-length answers to the wrong question).
