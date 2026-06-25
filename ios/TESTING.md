# What the iOS app tests — and why

This is the plain-language map of the hawky iOS test suite: **what we actually
verify, in human terms.** It is the companion to
[`.agents/skills/ios-app-test/SKILL.md`](../.agents/skills/ios-app-test/SKILL.md),
which covers *how to run* the tests. This file covers *what they mean*.

If you are reviewing a change and want to know "is this behaviour covered, and what
does 'covered' mean here?", start here.

---

## At a glance

| Layer | What it proves | ~Tests | Backend |
|---|---|---|---|
| **UI flow** | the real app navigates; every screen and control is reachable; seeded data renders; a session starts and stops | ~37 | pure-UI + mock/seed (one mock-live) |
| **Snapshot** | a chat message looks right in each state (empty / user / streaming / done / error) | 5 | none — view in isolation |
| **Unit & integration** | the logic under the UI: settings & routing, sessions, the voice state machine, the gateway wire protocol, capture, persistence | ~210 | offline (two opt-in live) |

Plus one **self-check** that fails the build if any screen has no test. Counts drift as
the app grows — treat them as a sense of scale, not a contract.

---

## How the suite is built to be trustworthy

Three design choices make these tests deterministic and worth believing:

1. **Non-invasive seams, not `if isTesting` branches.** Test behaviour is selected by
   a single typed value, `LaunchConfiguration` (`App/LaunchConfiguration.swift`),
   resolved once at launch from process arguments/environment. Production builds always
   resolve to `.production` (live gateway, no mocks, no seeded state). There are no
   test-only conditionals scattered through the views, so the code under test is the
   code that ships.

2. **Three backend scopes**, chosen per test so each test is as cheap and stable as it
   can be:

   | Scope | What's behind the UI | Used for |
   |---|---|---|
   | **pure-UI** | nothing — no gateway at all | navigation, control reachability, layout, onboarding |
   | **mock + seed** | an in-memory gateway pre-loaded with fixed state | chat history, sessions, recordings, error surfaces |
   | **live-integration** | a real gateway over WebSocket | handshake + a real chat turn (opt-in, skipped by default) |

3. **Deterministic seed profiles** (`JC_SEED`, `App/LaunchSeedFixtures.swift`). Every
   id, timestamp, and message string is pinned, so a seeded run renders the same pixels
   and the same text every time:

   | `JC_SEED` | What it installs |
   |---|---|
   | `empty` | one session, no messages |
   | `chat-populated` | one session with user + assistant + system messages |
   | `mixed` | two sessions (`main` + `research`) with session-specific history |
   | `recordings` | a dummy recording file on disk so the history list has a row |
   | `error` | a seeded gateway error string |

The UI layer also self-describes: every UI test carries a **TestSpec** (id, title,
purpose, steps with expected/actual) that is attached to the result bundle and rendered
into a **fail-first HTML report** with a screenshot per step
(`scripts/xcresult-report.mjs`). A **ScreenManifest** (`ScreenManifest.json`, 31 screens)
is the source of truth for "which screens exist", and a meta-test fails the build if any
screen has no test or any spec points at a screen that doesn't exist.

---

## Layer 1 — UI flow tests (`hawkyUITests/HawkyUITests.swift`)

These drive the real app in the simulator and assert on accessibility identifiers (not
on-screen labels), so they survive copy changes and localization. Grouped by what they
prove:

### Launch & tab structure
- **The app launches clean.** With deterministic defaults it opens straight to the Live
  empty state ("Talk to Hawky") with the Live and Settings tabs — no leftover
  simulator state, no onboarding, no intro animation leaking in.
- **Tabs switch.** Live → Settings reaches the Settings root and its Connection row.
- **The configurable tab layouts render.** The primary layout (Live, Chat, Probes,
  Pipecat, Settings) and the secondary/developer layout (Live2, Pipecat Recording,
  GPTRDemo, Live, Settings) each install deterministically and every tab exposes its
  screen identifier.

### Onboarding
- **First-run onboarding stays navigable** end-to-end — Welcome → Connect → Live
  Provider → Ray-Ban Meta → All Set → Live — **without** needing a camera or the Meta
  companion app. This is the path a brand-new user sees, so it must never dead-end.

### Chat & sessions (mock + seed)
- **Seeded sessions appear** in the sessions pane.
- **A populated transcript renders** the user, assistant, and system messages from the
  `chat-populated` seed — no live gateway involved.
- **Switching sessions works**: from the `mixed` seed we open the sessions pane, pick the
  Research session, and see *its* assistant message (not main's).
- **Deep links select a session**: `hawky://chat/hawky:research` opens Chat and
  activates the right seeded session.

### Recordings, connection status
- **The recordings history renders a real row** from the `recordings` seed instead of the
  empty state.
- **The connection-error surface works**: with the `error` seed, the connection debug
  sheet shows the seeded gateway error — we can exercise error UI without breaking a real
  connection.

### Live session control
- **A mock Live session starts and stops.** Through the in-memory mock provider
  (`HAWKY_UI_TESTING_LIVE_MOCK=1`): Start enables → tap → in-session state with Stop →
  tap Stop → back to idle. This proves the session state machine drives the UI without
  any audio hardware or real provider.

### Settings & Live surfaces are fully reachable
- **Every first-level Settings page opens and returns cleanly** (Connection, Agent, Live,
  Prompt, Appearance, Notifications, Layout, About).
- **Nested Settings controls are reachable** beyond the first level — gateway/device
  fields, the prompt editor, ntfy notification toggles and the per-session filter
  subpage, and the tab-layout controls.
- **Live's secondary surfaces are reachable** — the More sheet, Live Settings, the Live
  Sessions list (summary / new / export), and the recordings history empty state.
- **The full Live Settings form is reachable** — provider, model, direct-OpenAI-key, and
  on scroll the recording, response-modality, audio-output, toolbox, bridge, and
  audio-source controls.
- **The Pipecat and demo screens expose their controls** — Pipecat (API key, model,
  prompt, toggles, start, mic, plus the read-only WebRTC/transcript/events panels), and
  the Live2 / Pipecat Recording / GPTRDemo demo surfaces with their nested pages.

> Why so much "reachability" testing? These assert that every important control keeps a
> **stable accessibility identifier**. That's what makes the rest of the UI tests (and
> any future automation) able to find controls at all — it's the floor the suite stands on.

### Deep-link reachability sweep
A generated test per catalogued screen opens its `hawky://…` deep link and asserts
the expected screen identifier appears — Live, Chat, Probes, Pipecat, the Settings pages,
Live recordings/summary/glasses/sessions/status, and the secondary Live2 / Pipecat
Recording / GPTR screens. This guarantees **every screen in the app is reachable by URL**,
which is also how the rest of the suite jumps straight to a screen.

### The suite checks itself
- **`testScreenManifestAndSpecsAreComplete`** is the guardrail: the manifest is
  well-formed (no duplicate/empty ids, every catalogued screen has a URL), every TestSpec
  only references screens that exist, **every screen has at least one test**, and the
  deep-link sweep covers exactly the catalogued screens — no more, no less. If someone
  adds a screen and forgets a test, the build fails here.

---

## Layer 2 — Snapshot tests (`hawkyTests/Snapshots/ChatViewSnapshotTests.swift`)

Pixel-level contracts for how a chat message looks. They render `MessageBubbleView` in
isolation (no networking, no app container) at a fixed 390 px width in dark mode with
pinned UUIDs, so any genuine change to `DesignTokens` or the bubble layout shows up as a
diff:

- **Empty state** — the "Start a conversation" copy with the session key.
- **User bubble** — trailing, tinted, asymmetric corner.
- **Assistant streaming** — assistant body with the inline typing cursor.
- **Assistant finalized** — the same turn after streaming, no cursor.
- **Error/system row** — a centered caption-style system error (`[E_NET] websocket closed`).

---

## Layer 3 — Unit & integration tests (`hawkyTests/`)

~210 focused tests that pin down logic below the UI. Most are pure offline unit tests;
the two **live-integration** files are skipped unless a real gateway URL is provided
(`HAWKY_INTEGRATION_GATEWAY_URL`). Grouped by subsystem:

### Settings, layout & launch routing
- **SettingsValidationTests** — the big one. Gateway URLs must be HTTP/HTTPS with a host
  (trims whitespace; rejects empty/scheme-only/wrong-scheme). Default tabs are just
  Live + Settings; developer-only tabs auto-hide unless dev mode is on. Legacy tab
  layouts migrate without data loss (the old `recording`/`glasses` tabs collapse into
  `live`). Onboarding auto-presents only on a fresh install. Live config persists
  keep-running-offscreen and OpenAI credential mode.
- **StoresTests** — three stores:
  - *ChatStore*: append messages, stream deltas, finalize, ignore unknown message ids,
    decode remote history (skipping tool_use/tool_result, preferring display_text).
  - *ConnectionStore*: idle → connecting → connected/error/abandoned, with manual recovery.
  - *SessionStore*: default `hawky:main`, upsert preserving pin/archive, active summary.
- **SessionActions** — list manipulation: upsert keeps pin/archive unless overridden,
  sort is pinned-first then recency, and an archived active session falls back sensibly.
- **SessionFilter** — search: case-insensitive substring plus regex, degrading gracefully
  (show everything and flag it) on an invalid pattern.
- **SwitchSession** — switching resilience: a stale transport reconnects, send failures
  surface as a friendly typed error, and a gateway-settings change rebuilds the transport.

### Live session & real-time voice
- **SurfaceStateMachineTests** — the floor-arbitration state machine for real-time voice:
  who gets to speak, queueing when the floor is busy, TTL expiry of stale queued items,
  deterministic drain order, and playback tracking. This is the brain that keeps the
  assistant from talking over the user.
- **LiveAudioOutputDestinationTests** — audio routing: glasses (Bluetooth HFP, *not*
  forced loudspeaker, to avoid echo), speaker (forced loudspeaker), and auto (legacy
  default); persisted across launches.
- **ForegroundReconnectTests** — returning to the foreground reconnects if disconnected,
  refreshes history if connected, and debounces rapid transitions (2 s) so we don't spam
  the gateway.
- **AudioProtocolsTests / GlassesAudioSessionTests** — audio value types and the glasses
  audio-session options (Bluetooth HFP + duck others + default to speaker).

### Gateway wire protocol & networking
- **FrameCodecTests** — JSON encode/decode of the request/response/event frames and the
  dynamic `JSONValue` payload, including a real `hello-response.json` fixture and graceful
  `.unknown` decoding for unrecognised frames.
- **ChatEventDecoderTests** — turning incoming event frames into typed `ChatEvent`s (text
  deltas, done, error with/without code, system message, tool-use/tool-result, intention
  surface), with unknown/malformed events returning nil instead of crashing.
- **CorrelatorTests** — matching async responses to requests by id under concurrency:
  50 out-of-order ids all resolve, double-resolve is a no-op, timeouts clean up, and
  `rejectAll` wakes everyone.
- **DeviceAuthClientTests** — the device-auth token fetch over stubbed HTTP: 200 returns
  the token; 401/`ok:false`/bad-JSON/500 each throw the right typed error.
- **NodeRunnerTests** — the device acting as a "node" the backend can drive: the hello
  handshake (role=node), reconnect backoff, and dispatching `node.invoke` to reply with a
  result (or a typed error for an unknown command).
- **NodeCapabilitiesTests** — the shape and value ranges of capability replies: battery,
  storage, network, clipboard, notifications, and frontend message/open-tab (including
  the `recording`→`live` tab remap).

### Glasses capture & recordings
- **GlassesCapturePolicyTests** — frame-rate/resolution policy per mode (battery-saver
  ~2 fps, ambient ~7 fps default, preview ~15 fps, developer), and the "three cadences"
  (source request / preview / upload) diagnostics.
- **KeyframeUploaderTests** — a started uploader sends `media.chunk.upload` with the right
  fields (session key, `media_kind=frame`, JPEG mime, capture timestamp, base64 bytes).
- **RecordingManifestStoreTests** — keyframe ingestion writes the frame file + manifest
  with offsets relative to recording start, and cleanup removes audio + frames + manifest
  together.
- **AmbientRegionProjectionTests** — the CoreLocation region-budget logic (≤20 monitored
  regions): keep all under the cap, otherwise pick nearest and re-arm a far reminder as
  the user approaches, deterministically (no churn before the first GPS fix; ties broken
  by id). This is the #481 fix.

### Persistence, config & infra
- **KeychainStoreTests** — auth tokens round-trip through the keychain (save/load/update/
  delete; missing key returns nil, no crash).
- **AgentConfigStoreTests** — loads and saves provider, model, and Vertex config from the
  gateway; warns when the backend ignores a provider change; and reverts a draft (never to
  defaults) on an invalid request.
- **IntegrationGatewayConfigTests** — parsing the integration-test gateway URL from env
  (primary + legacy alias), rejecting `ws://`, and the required-test gating flag.
- **LaunchIconTests** — the launch-branding icon asset resolves, is square, and is
  high-res (≥512 px) for the intro zoom.
- **SmokeTests** — a trivial `1+1==2` that proves the test harness itself is wired up.

### Live-integration (opt-in — needs a real gateway)
- **GatewayHandshakeIntegrationTests** — a real WebSocket handshake: non-empty connId +
  server version, `chat.send` advertised, a `session.exists` roundtrip, clean disconnect,
  and auth failure on a blank token.
- **ChatClientIntegrationTests** — a real chat turn: send "hello", collect `delta` events
  and a terminal `done`, reuse the transport for a second turn, and enforce a hard timeout
  so a stuck turn fails instead of hanging.

---

## What we deliberately don't test here

So the gaps are explicit, not accidental:

- **Real camera / WebRTC video / on-device audio capture** — the simulator can't, and the
  UI tests use the mock provider instead. Live media is validated by hand on a device.
- **The Meta companion app / real Ray-Ban Meta pairing** — onboarding is tested as
  reachable without it.
- **The live gateway by default** — only the two opt-in integration files touch a real
  gateway, and only when `HAWKY_INTEGRATION_GATEWAY_URL` is set.

---

## Where things live / how to run

| | |
|---|---|
| UI tests + specs | `hawkyUITests/HawkyUITests.swift`, `TestSpec.swift` |
| Screen catalog | `hawkyUITests/ScreenManifest.json` + `ScreenManifest.swift` |
| Snapshot tests | `hawkyTests/Snapshots/ChatViewSnapshotTests.swift` |
| Unit/integration | `hawkyTests/*.swift` |
| Test seams | `hawky/App/LaunchConfiguration.swift`, `HawkyUITesting.swift`, `LaunchSeedFixtures.swift` |
| HTML report | `scripts/xcresult-report.mjs` |

Run them with `bun run ios:test` (unit), `bun run ios:ui-test` (UI),
`bun run ios:test:report` (UI + HTML report), or `bun run ios:test:live` (integration,
needs a gateway). Full details and prerequisites are in
[`.agents/skills/ios-app-test/SKILL.md`](../.agents/skills/ios-app-test/SKILL.md).
