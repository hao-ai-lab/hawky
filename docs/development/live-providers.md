# Live providers: first integration batch

Hawk keeps one application conversation across different voice connections. Select
an OpenAI Realtime, GPT-Live, Gemini Live, Venus or JoyAI model in Live settings. While connected, use
**Switch to …** to close the old connection and start the selected model in the
same conversation. Switching is a brief reconnect, not transfer of hidden model
state. Saved session memory and recent text remain in Hawk; task IDs stay stable.
Restoration into each model follows the provider-specific limits below.

## Boundaries and files

- `web-ios/src/lib/useRealtime.ts`: orchestrates start/stop/reconnect, recording and
  the UI. The existing Realtime response queue, transcript, startup and compaction
  state machines remain in their separate `realtime-*.ts` modules.
- `web-ios/src/lib/live/`: browser media transport, serial conversation persistence
  and gateway task subscriptions. `providers/openai-realtime.ts` owns Realtime
  connection/configuration; `providers/gpt-live.ts` owns GPT-Live events/lifecycle.
- `src/live/contracts.ts`: common text history and explicit capability flags.
  No assumption that all providers expose Realtime tools, VAD or item deletion.
- `src/gateway/gpt-live-methods.ts`: authenticated connection broker and sideband.
  `src/live/gpt-live-coordinator.ts`: sole GPT-Live task dispatcher. The browser
  consumes captions/task cards; it never independently executes a delegation.
- `src/gateway/delegation-methods.ts`: shared durable task service for native,
  Codex and Claude. `src/live/gpt-live-router.ts` interprets client delegation;
  `gpt-live-transcript.ts` groups timestamp fragments without pretending they are
  provider-completed turns.

## GPT-Live procedure

1. Flush prior writes, load saved summary/recent history, build Hawk instructions.
   The gateway creates `/v1/live/sessions` with WebRTC and client delegation, then
   attaches a sideband before enabling microphone input. Keys stay at the gateway
   except a user-supplied BYOK value sent through the authenticated RPC.
2. Audio travels through WebRTC. With Mic off at startup, a synthetic silent track
   keeps the continuous timeline advancing without requesting microphone access.
   Output is gated until fresh user input; reconnect cannot speak an old answer.
3. A client delegation contains an ID, not tool arguments. `gpt-5.4-mini`, using
   the same OpenAI key, interprets recent speech and current task states into
   validated submit/status/revise/cancel operations. Typed requests use this path
   too. This adds one API call and requires access to that model. Backend execution
   still uses the selected Hawk provider, Codex CLI or Claude CLI.
4. Task results enter `session.commentary.append`; quiet restoration uses
   `session.thinking.append`. Each update is bounded below the 500-token limit.
   Full output remains in the task card. An append acknowledgement means
   **injected**, not **played**. GPT-Live controls when it speaks; the application
   does not manufacture per-task playback acknowledgements.
5. Stop flushes captured transcript groups and closes the provider, while durable
   tasks continue. A new connection restores current task states quietly. Tasks
   that finish during the new connection wait for fresh user input before an
   announcement. Explicit status questions can retrieve completed results.

The task interpreter waits briefly for late speech fragments and discards a plan
if a correction arrives during interpretation. Each independent task owns a backend
conversation. Native and Codex read-only tasks can use the two workers concurrently;
follow-ups explicitly reference a task and resume its conversation. A queued
follow-up does not block an unrelated reader. Workspace mutations, Claude tasks,
and turns targeting the same conversation run serially. The task card explains
whether it is waiting for a conversation, workspace access, a dependency, or a
worker. A gateway restart marks interrupted work for explicit recovery rather
than replaying side effects.

Codex read-only turns use a read-only shell sandbox, disable configured MCP
servers, apps, plugins and hooks, and disallow escalation. Model/provider/login
configuration is retained. Effective MCP configuration is inspected in the task's
working directory; if it cannot be restricted, execution fails closed. Write turns
keep the existing CLI permission settings and take exclusive workspace access.
A Codex follow-up can change execution mode; a native read-only conversation has
a fixed tool allowlist and needs a separate task for subsequent writes.

The router distinguishes additional work (new task), follow-ups (existing task),
and explicit corrections (supersede and continue the targeted task). It receives
bounded results to resolve references such as "the second paper." Ambiguous targets
need clarification. This is model behavior, so it is evaluated separately from
the deterministic scheduler. Saying "I can check" is not a dispatch acknowledgement.

Routing diagnostics are local files under
`~/.hawky/sessions/delegations/<owner-hash>/routing-<session-hash>.jsonl`.
They record the delegation ID, recent transcript, candidate tasks, proposed
actions, stale decisions, applied task IDs and errors. They contain conversation
data, are created with mode 0600, and contain no raw audio or API keys. Each task's
existing JSONL journal retains queue transitions, tool events and results.

## Verification and manual checks

Automated checks:

```sh
bun test ./tests/test-gpt-live.ts ./tests/test-gpt-live-gateway.ts ./tests/test-delegation.ts
NODE_OPTIONS=--no-experimental-webstorage bun run --cwd web-ios test
bun run typecheck
bun run --cwd web-ios build
```

The Node option avoids the installed Node runtime's incompatible global
`localStorage` in jsdom tests. It is a test runner option, not a product setting.

Paid provider probe (synthetic TTS, no microphone recording):

```sh
bun scripts/probes/gpt-live.ts
```

This requires a configured OpenAI key and checks real audio, client delegation,
spoken task result and seeded-history recall. It closes its session at the end.

Two additional opt-in probes separate routing quality from CLI execution:

```sh
bun scripts/probe-live-task-routing.ts
HAWKY_CODEX_BIN=/path/to/codex bun scripts/probe-delegation-workers.ts
```

The first makes eight `gpt-5.4-mini` calls with synthetic scenarios and never runs
the proposed actions. The second uses the installed Codex login, creates temporary
fixtures and real CLI conversations, and checks overlapping workers, distinct
conversation IDs, follow-up recall and read-only execution. Fixture files are
cleaned up; Codex retains the probe conversations in its normal history.

Manual checks, about 10–15 minutes:

1. Select GPT-Live, start and wait: no opening speech. Say “My test color is
   turquoise.” Stop/start and ask the color: continuity without an opening recap.
2. Select Codex. Ask it to sleep 20 seconds then report its directory. While it
   runs, ask "In a separate task, list the workspace files." Expect two task IDs,
   two runtime conversation IDs and overlapping execution. The listing should
   arrive before the sleep completes. Ask a follow-up about the listing: expect
   a new task ID using the listing's original runtime conversation.
3. Ask the backend to wait, correct the request, then cancel. Old results must
   stay superseded/cancelled, and interrupting speech alone must not cancel work.
4. Start backend work, select Realtime, press **Switch to …**. Keep the same URL,
   transcript and task IDs. Ask about prior context, then switch back to GPT-Live.
5. Start with Mic off and type a backend request. Expect a result in the task card
   and a voice/caption response. Test speaker mute and subsequently enable Mic.

## Limits of this batch

GPT-Live is audio-only. Camera/person tools, Stay silent and manual Realtime
compaction are unavailable for it; their preferences remain saved for Realtime.
Backend session memory is still available. Durable visual memory remains separate
work. Native iOS has not been changed. Claude CLI is
wired through the existing service but has not been exercised live in this batch.

Primary protocol references:
[delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[server controls](https://developers.openai.com/api/docs/guides/voice-server-controls),
[session context](https://developers.openai.com/api/docs/guides/live-conversations).

## Gemini Live

For a silent/stuck session, open its local archive at
`~/.hawky/realtime-sessions/<recording-id>/conversation.jsonl`. Every five seconds,
`media.health` records browser AudioContext/track state, capture/forwarded packet
counts, recent peak level and playback backlog. `provider.health` records Gemini's
gateway input counts, last input/server/transcription ages and turn counts. These
health entries contain no raw audio, image bytes, device identifiers or API keys.
The archive's other entries still contain the normal conversation and context.

Growing browser counts with frozen gateway counts point to transport. If packet
counts advance at both ends, check audio level during speech before attributing
missing transcription to the provider.
Zero audio level alone means silence, not a broken connection. A muted/ended
track, suspended audio context or missing capture packets produces a visible
warning. Provider errors (including quota errors) are archived before teardown.
The previous sparse logs cannot retrospectively distinguish these failure stages.

Select `gemini-3.8-live` in Live settings. A separate browser Gemini key is
optional; the gateway also accepts `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or
`api_keys.gemini` in its private config. No OpenAI key is used for this path.
The browser sends 16 kHz PCM16 and JPEG frames through authenticated gateway
RPC; only the originating connection receives output audio. Keys stay off the
provider event stream. Gemini returns 24 kHz PCM, input/output transcripts and
native function calls. Its model setup omits unsupported thinking fields, sets
explicit automatic voice activity detection, and uses Gemini 3.x's
`TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`: retain video between utterances,
exclude silent audio. Once microphone streaming starts, new text and backend
announcements use `realtimeInput.text`. Mixing explicit `clientContent` turns
with continuous audio/video reproduced a missing second reply. Initial history
still uses `clientContent` before capture begins. Camera-only connections use
explicit multimodal turns so a typed question includes its fresh JPEG; realtime
video/text without an audio stream can miss that image. The browser sends the
initial microphone state before enabling PCM capture.

`live.stream.*` owns lifecycle and authentication; `src/live/providers/gemini.ts`
owns Gemini JSON. `GatewayStreamProvider` and `PcmMedia` own browser lifecycle,
capture, bounded playback and interruption. Backend task tools are shared with
Realtime. Completed jobs wait for generation and playback to drain before an
announcement; reconnect loads task state quietly. Tool-call cancellation from
speech interruption suppresses an obsolete tool response without cancelling an
already accepted durable task. Provider diagnostics record forwarded audio/video
counts, last-frame age, text transport, and Gemini's reported modality usage.
Forwarding is not an image acceptance receipt; image-token usage is separate
provider evidence. No media bytes or keys are included in those diagnostics;
task cards do not claim that a particular task result has been heard. The Gemini
and JoyAI adapters do not yet correlate announcements with task-level playback
receipts, so a completed task can still show **playback unconfirmed** after its
answer appears. Backend completion is tracked independently and remains accurate.

Provider disconnects surface an error and allow Start to restore saved text and
memory. Automatic hidden-state resumption is not implemented. Gemini's sliding
window compression stays provider-owned. Face tools, Stay silent and manual
Realtime item compaction remain disabled. Native iOS is unchanged.

Checks: `bun test ./tests/test-live-stream.ts`; browser fixtures in
`web-ios/tests/gateway-stream.test.tsx`. Paid synthetic probe:
`bun scripts/probes/gemini-live.ts`. The probe verifies real session setup,
spoken output and seeded-history recall, without using a physical microphone.
Protocol: https://ai.google.dev/gemini-api/docs/live-api/capabilities

The probe also accepts `GEMINI_LIVE_PROBE=tool`, `image`, or `voice-image`.
Image modes require `GEMINI_LIVE_IMAGE=/path/to/red.jpg`; voice-image additionally
requires `GEMINI_LIVE_WAV=/path/to/question.wav`, a mono 16 kHz PCM16 synthetic
question asking the image color. It verifies transcription, spoken output and
the image answer even with a different color in restored history. For example,
on macOS: `say -o /tmp/question.aiff 'What color is the image?'`, followed by
`afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/question.aiff /tmp/question.wav`.

To test successive replies with the microphone **remaining open**, use:

```sh
GEMINI_LIVE_PROBE=voice GEMINI_LIVE_IMAGE=/path/to/red.jpg GEMINI_LIVE_WAV=/path/to/question.wav bun scripts/probes/gemini-live-continuous.ts
GEMINI_LIVE_PROBE=text GEMINI_LIVE_IMAGE=/path/to/red.jpg bun scripts/probes/gemini-live-continuous.ts
```

This paid probe sends 100 ms PCM packets, including silence, and one JPEG every
five seconds. It requires two correct image answers, output audio and reported
image-token usage, without forcing replies by ending the audio stream. On
2026-09-24 both sequences passed, as did camera-only input and native tool calls.
These synthetic probes do not verify physical microphone/camera playback in a
user's browser; retest that separately with mic and camera on, then type a second
question without stopping the session.

## Self-hosted Realtime-Venus

Select `realtime-venus-omni`. This integration uses the upstream
`realtime-venus-harness/2` ServingPort, not the demo's WebSocket agent. Hawk owns
backend tasks. Because ServingPort returns raw token IDs, run the small decoding
bridge with the **same checkpoint tokenizer** as the model:

```sh
uv venv services/venus/.venv
uv pip install --python services/venus/.venv/bin/python -r services/venus/requirements.txt
services/venus/.venv/bin/python services/venus/bridge.py --upstream http://127.0.0.1:8031 --tokenizer /path/to/checkpoint/tokenizer.json
```

Point the gateway's `HAWKY_VENUS_URL` at that bridge (default
`http://127.0.0.1:8033`). Alternatively set private gateway config
`live_providers.venus.url`. An optional `HAWKY_VENUS_API_KEY` on both processes
enables bridge bearer authentication (`live_providers.venus.api_key` also works
on the gateway). These operator settings cannot be changed through browser RPC.
Use loopback or an authenticated TLS tunnel when the model is remote.

The bridge checks protocol token IDs and decodes incremental Unicode without
dropping reserved tokens. Captions project only native speech spans, excluding
codec markers and text before the speech marker. Hawk hides `<delegate>` spans,
dispatches one validated task per turn and returns sanitized `<backend>` feedback. Partial/private tokens
cannot become spoken task instructions. Delegations use the shared serial worker;
this native marker contains no structured concurrency/follow-up fields.

Venus receives one-second PCM chunks and JPEG frames. With Mic off, zero PCM
keeps its streaming clock advancing. Typed requests wait until the associated
camera frame has entered model context, using ServingPort's input sequence fence.
Saved history and instructions are installed with the first **typed** request.
The current ServingPort has no quiet context installation: a prefill always starts
a backend generation. Doing that on the first voice utterance can replace its
native answer or leave a listening backend turn running. Microphone-only sessions
therefore use the model host's prompt and start with fresh context; the UI explains
this limitation. Do not claim voice-only restoration parity with Gemini.
Backend completions wait for a model turn
boundary and playback drain. Only a contiguous prefix of actually played audio
is acknowledged. Stop and gateway disconnect close only this connection's model
session. The bridge releases owned sessions after 45 seconds of inactivity if the
gateway is killed. Restarting the bridge still requires a matching tokenizer.

Current protocol limits: one active model session, no input ASR transcript,
no immediate external barge-in operation, server-selected voice, and no manual
context deletion. Typed messages and assistant captions are archived; microphone
speech history cannot be restored unless a separate ASR is added. Model-hosted
memory is not transferred on reconnect. Native iOS is unchanged.

The context-restoration notice is informational, not a failed connection.
Session archives include `provider.health` every five seconds: accepted audio/image
packet counts, output/listen step counts, reply audio chunks, delegation requests,
input level, output age, pending context and playback. Flowing input plus increasing
listen steps means the model is choosing to listen; no output steps means a
different transport/inference failure. These diagnostics contain no raw media.

### Venus session controller

The shared gateway and durable task service own task execution. The Venus-specific
controller in `src/live/providers/venus-session.ts` follows the lifecycle in
[paper sections 4.3–5.4](https://arxiv.org/html/2609.13814) and the upstream
`harness/bridge/host.py`:

- Maintains foreground listen/speak/turn state independently from background work
  and playback. A unit boundary is not a semantic turn boundary; the server can
  also end an idle ServingPort generation while retaining the model's context.
- Freezes up to 30 seconds of accepted audio, eight camera frames and recent typed
  input/confirmed played speech when `<delegate>` opens, including split tokens.
  Time and input-sequence cutoffs exclude later evidence. A complete valid request
  dispatches once; the native generation ID is hashed into a store-safe task ID.
  The private evidence directory beside the task archive contains a JSON manifest,
  PCM WAV and JPEGs (0700 directory, 0600 files). It persists with the task; a
  correction retains the original capture. Client RPC cannot supply these paths.
- Requests a natural spoken backend answer and admits each terminal result privately
  through `<backend>` after the model boundary and playback drain. Queued/running
  receipts do not enter that channel. Control tokens are removed from results;
  Markdown code wrappers are removed for speech; the original answer remains in
  the task card. Duplicate and superseded results cannot become new announcements. No extra LLM
  oralization call is made. Typed history installation remains separate and is
  still not equivalent to native session restoration.
- Associates task, reply attempt, generation and audio chunk identities. Only
  generation completion plus all actual positive playback acknowledgements
  establishes delivery; dropped audio is interrupted. Native acknowledgements
  carry the originating task ID. Stop interrupts in-flight delivery without
  cancelling durable work. Reconnect can recover a pending result but does not
  automatically replay played or uncertain partially delivered results.

Media continues while tasks run and while backend speech is generated. Output
steps respect the one-second model clock so synthetic backend silence cannot run
ahead of real input. Audio inside a delegation stays muted for that generation
because some checkpoints synthesize private request text in the Talker.

The evidence manifest is not an ASR transcript or automatic multimodal tool
attachment. The selected backend can inspect it using its available tools; it
must disclose unsupported media instead of inventing its contents. Native
microphone transcript, quiet context restoration and immediate external barge-in
remain model-host protocol limitations.

Acceptance must cover split requests, later input arriving before request closure,
duplicate/stale results, continuous perception during work, interruption during
delivery, and reconnect. Fixture protocol checks alone do not establish these
behaviors or prove that the checkpoint will choose to answer a short greeting.

Fixtures: `bun test ./tests/test-venus-live.ts ./tests/test-venus-session.ts ./tests/test-venus-gateway.ts` and
`services/venus/.venv/bin/python -m unittest discover -s services/venus -v`.
Real probe: `VENUS_LIVE_IMAGE=/path/to/red.jpg bun scripts/probes/venus-live.ts`.
Set `HAWKY_VENUS_URL` to your bridge; optionally add `VENUS_LIVE_WAV` using the
same synthetic WAV format as the Gemini probe. It checks native speech plus
camera understanding and closes the session afterward.
Source protocol: https://github.com/inclusionAI/Realtime-Venus/tree/main/demos/model

## Self-hosted JoyAI-VL-Interaction

Select `joyai-vl-interaction`. This is the upstream **stateful webinfer adapter**,
not a direct vLLM port: JPEGs and text go to `/v1/chat/completions`, with a unique
`x-streaming-session` per connection. Requests are regular JSON, not SSE. The
gateway serializes inference and coalesces pending images to the newest frame.
Visual inference runs at most once per second independently of speech synthesis
and playback; a new user cue can bypass that cadence. A fresh user cue is required before
camera frames trigger any inference. Stop resets only that upstream connection.

Private gateway `config.json` example (merge into the existing config):

```json
{
  "live_providers": {
    "joyai": {
      "url": "http://127.0.0.1:8070",
      "model": "jdopensource/JoyAI-VL-Interaction",
      "asr_url": "http://127.0.0.1:8993/v1/audio/transcriptions",
      "asr_model": "Qwen/Qwen3-ASR-1.7B",
      "tts_url": "ws://127.0.0.1:8992/ws/tts",
      "tts_voice": "vivian"
    }
  }
}
```

Use the model name served by your deployment (some name it
`JoyAI-VL-Interaction`). `HAWKY_JOYAI_URL`, `HAWKY_JOYAI_ASR_URL` and
`HAWKY_JOYAI_TTS_URL` override these endpoints. `api_key` and `asr_api_key` are
optional, independent bearer keys. Remote services should be reached through an
authenticated tunnel or TLS. The optional TTS endpoint is the upstream Joy
adapter protocol, not a generic OpenAI speech endpoint.

JoyAI itself accepts **no audio**. With ASR configured, a small RMS endpointer
collects 16 kHz PCM, ends a cue after 600 ms silence (maximum 12 seconds), sends a
WAV to ASR and injects recognized words alongside the current image. Without ASR,
use typed cues; the UI reports that microphone audio is unused. This is utterance
cueing, not token-by-token streaming recognition. Without TTS, captions continue
and the UI explicitly reports text-only replies. No implicit paid OpenAI fallback.

The adapter consumes normalized response content, including silence, plain text,
response wrappers and both upstream delegation marker variants. Explicit raw
delegations are preserved when upstream normalization omits later lines, but
malformed delegation markup never executes a task. Invalid output produces a
recoverable warning and a format diagnostic instead of closing the connection.
Complete reasoning blocks are removed before display, speech or tool parsing;
incomplete blocks are rejected rather than spoken. Fresh user cues are explicitly
distinguished from passive frame updates so corrections can receive a reply even
when the image has not changed.
Repeated inference failures back off and do not flood the transcript.
It dispatches through Hawk's existing task service with serial execution;
natural-language markers do not carry native parallel/follow-up fields. Repeated
frame responses cannot repeat an identical delegation for the same user turn.
Camera-only steps distinguish an already delivered reply from a pending question.
They should report new relevant observations, not greet or acknowledge the same
cue again. A consecutive duplicate answer is dropped before captions and TTS,
even if silence occurs between duplicates. Fresh user cues, pending answers,
distinct visual observations and new backend results remain eligible to speak.
The diagnostic `output.duplicate_suppressed` and the health counter
`suppressedReplies` record this without logging the reply text.
Fresh speech interrupts TTS, cancels the active HTTP request and prevents an older
inference from speaking or starting a stale task. This is client-side cancellation:
the upstream API has no generation-cancel endpoint and may finish an already
running GPU request before accepting the next one for that session. Hawk does not
reset visual memory to interrupt a turn. New cues are sent once to the visual
session, rather than repeated as fresh instructions on every frame.

Speech has a separate queue: explicit replies and backend updates take priority,
and only the newest unsaid visual observation is retained. Inference continues
while that queue drains. New user input clears stale queued speech. A backend
result can be generated during playback and spoken after the current reply.
Task completion, generated text and acknowledged audio playback remain distinct.

Joy's own visual summaries remain inside its model-hosted connection. Diagnostic
events retain timing and summary counts, not the full private visual descriptions.
`provider.health` also reports inference/cancellation counts, pending cues, ASR
state and the speech queue; rejected-output diagnostics contain types and lengths,
not raw model text or media.
Hawk restores its saved text/session memory on reconnect; transferring Joy visual
memory into Hawk's durable archive is deferred. Local RMS endpointing and optional
ASR/TTS add latency and need microphone testing before claiming voice quality.

Regression check: say “嗯”, mute Mic and leave Camera on for 15 seconds. A brief
acknowledgment is possible, but it must not keep greeting or inviting conversation with each
frame. Then ask a visual question and request continuous descriptions while
changing the scene; new questions and relevant changes must still get replies.

Hawk imposes no speech-duration cutoff on Joy TTS or the shared PCM player used
by Joy, Gemini and Venus. Long replies can finish or be interrupted normally.
Joy TTS times out only after 30 seconds without audio progress; malformed PCM
and stalled gateway requests still report errors.

Fixtures: `bun test ./tests/test-joyai-live.ts`. Shared browser fixtures:
`NODE_OPTIONS=--no-experimental-webstorage bun run --cwd web-ios test -- tests/gateway-stream.test.tsx`.
Protocol sources: [webinfer](https://github.com/jd-opensource/JoyAI-VL-Interaction/tree/main/services/webinfer),
[ASR](https://github.com/jd-opensource/JoyAI-VL-Interaction/tree/main/services/asr),
[TTS](https://github.com/jd-opensource/JoyAI-VL-Interaction/tree/main/services/tts).

## Checks for the new providers (about 10 minutes per running provider)

1. Select the model, start with Mic off and type a short question. Check captions
   and speaker mute; reconnect should stay silent until fresh input.
2. Enable Camera and ask about an object, then change the scene. Gemini/Venus use
   native media; Joy uses sampled images and the active text cue. Camera-off must
   not be described as a current view.
3. Ask for a backend directory listing. Expect an actual task card before any
   claim of completion. Inspect the backend runtime and result, then cancel a
   longer task explicitly.
4. Interrupt a spoken answer and change the request. Gemini and Joy should stop
   old playback; Venus currently relies on the model's native listening behavior.
5. Switch between providers within the same conversation. Saved text, session
   memory and task IDs survive in Hawk. Gemini/Joy load that text; Venus injects
   it with the first typed request (see voice-only limitation above).
   Provider-specific hidden state and raw images do not transfer. Stop must
   release microphone/camera and the upstream connection.

## Verification snapshot: 2026-09-24

- 198 web tests, 91 targeted gateway/provider/task tests, and three Python bridge
  tests passed. TypeScript checking and the web production build passed.
- Gemini 3.8 Live: real API probes passed seeded-history recall, native function
  invocation, typed-image questions and synthetic voice-plus-image questions.
  Browser checks passed typed replies, quiet reconnect, recall after reconnect,
  and an actual backend delegation through the native worker: calculate 17 + 25,
  show one completed task card, and return 42 in the live conversation.
  Synthetic speech and solid-color images were used; no physical camera or mic
  was recorded during automated testing.
- Venus: an existing self-hosted model passed typed-image and native
  voice-plus-image probes. Browser connection, provider switch and Stop were
  verified. The Venus controller also passed a real native delegation through
  the gateway to Codex CLI: `pwd` executed once, its frozen evidence manifest
  was saved, and the actual directory returned as captions and audio. The probe
  skipped playback and correctly retained interrupted delivery; audible browser
  playback still needs a manual check. A browser history-recall check did **not** pass: the model said it
  would check instead of returning the supplied fact. Native voice-only history
  restoration is also unsupported. Treat Venus behavior as experimental; passing
  the wire protocol tests does not establish recall or delegation quality.
- JoyAI: fixtures cover cue endpointing, ASR, image coalescing, action tokens,
  private delegation, TTS, interruption and connection reset. The self-hosted
  deployment was restored on September 24 after an earlier experiment had stopped
  it. Real probes through Hawk's adapter passed a typed red-image question and
  synthetic speech through ASR → JoyAI → TTS, with complete PCM output and session
  cleanup. A subsequent interruption check with the full Hawk prompt verified
  inference during held playback, cancellation during generation, synthetic
  Chinese speech through ASR followed by a Chinese answer and PCM, and quiet
  reconnect through the gateway. 29 targeted provider/gateway tests and 22 browser
  transport/playback tests passed, as did TypeScript and the web build. These
  probes used generated color images and synthetic speech, not physical devices.
  A repetition follow-up replayed a filler cue with the affected session's prompt
  and seven archived camera frames: no additional replies, followed by a correct
  answer to a new visual question. A red-to-blue observation during held playback
  and a synthetic Chinese interruption also passed. 31 targeted provider/gateway
  tests now cover duplicate suppression, silence between duplicates, requested
  repetition, pending answers, visual changes and fresh backend updates.
  Physical microphone behavior, long-session summaries and live delegation
  quality remain unverified.
- Native iOS, durable visual-memory transfer and per-task model/effort selection
  are outside this batch. Existing backend model configuration is unchanged.
