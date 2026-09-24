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

Select `gemini-3.8-live` in Live settings. A separate browser Gemini key is
optional; the gateway also accepts `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or
`api_keys.gemini` in its private config. No OpenAI key is used for this path.
The browser sends 16 kHz PCM16 and JPEG frames through authenticated gateway
RPC; only the originating connection receives output audio. Keys stay off the
provider event stream. Gemini returns 24 kHz PCM, input/output transcripts and
native function calls. Its model setup omits unsupported thinking fields, sets
explicit automatic voice activity detection, and includes all input in a turn.
Typed camera questions attach the latest fresh JPEG to that same text turn,
avoiding ordering races with the separate realtime video stream.

`live.stream.*` owns lifecycle and authentication; `src/live/providers/gemini.ts`
owns Gemini JSON. `GatewayStreamProvider` and `PcmMedia` own browser lifecycle,
capture, bounded playback and interruption. Backend task tools are shared with
Realtime. Completed jobs wait for generation and playback to drain before an
announcement; reconnect loads task state quietly. Tool-call cancellation from
speech interruption suppresses an obsolete tool response without cancelling an
already accepted durable task. Provider diagnostics record context delivery;
task cards do not claim that a particular task result has been heard. The new
stream adapters do not yet correlate announcements with task-level playback
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
therefore use the model host's prompt and start with fresh context; the UI warns
about this limitation. Do not claim voice-only restoration parity with Gemini.
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

Fixtures: `bun test ./tests/test-venus-live.ts` and
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
gateway serializes inference, coalesces pending images to the newest frame and
limits cadence to one request per second. A fresh user cue is required before
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

The adapter parses `</silence>`, `</response>` and both upstream delegation marker
variants. It dispatches through Hawk's existing task service with serial execution;
natural-language markers do not carry native parallel/follow-up fields. Repeated
frame responses cannot repeat an identical delegation for the same user turn.
Fresh speech interrupts TTS and prevents an older inference from speaking or
starting a stale task. Backend notifications wait for inference and playback to
drain. Task completion and audio playback remain distinct.

Joy's own visual summaries remain inside its model-hosted connection. Diagnostic
events retain timing and summary counts, not the full private visual descriptions.
Hawk restores its saved text/session memory on reconnect; transferring Joy visual
memory into Hawk's durable archive is deferred. Local RMS endpointing and optional
ASR/TTS add latency and need microphone testing before claiming voice quality.

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
  verified. A browser history-recall check did **not** pass: the model said it
  would check instead of returning the supplied fact. Native voice-only history
  restoration is also unsupported. Treat Venus behavior as experimental; passing
  the wire protocol tests does not establish recall or delegation quality.
- JoyAI: fixtures cover cue endpointing, ASR, image coalescing, action tokens,
  private delegation, TTS, interruption and connection reset. The self-hosted
  deployment was restored on September 24 after an earlier experiment had stopped
  it. Real probes through Hawk's adapter passed a typed red-image question and
  synthetic speech through ASR → JoyAI → TTS, with complete PCM output and session
  cleanup. Model, summary, ASR and TTS endpoints were healthy. Physical microphone
  behavior, long-session summaries and live delegation quality remain unverified.
- Native iOS, durable visual-memory transfer and per-task model/effort selection
  are outside this batch. Existing backend model configuration is unchanged.
