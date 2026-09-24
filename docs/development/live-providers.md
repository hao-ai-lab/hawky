# Live providers: first integration batch

Hawk keeps one application conversation across different voice connections. Select
`gpt-live-1` or an OpenAI Realtime model in Live settings. While connected, use
**Switch to …** to close the old connection and start the selected model in the
same conversation. Switching is a brief reconnect, not transfer of hidden model
state. Saved session memory plus recent text are restored; task IDs remain stable.

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
Backend session memory is still available. Visual memory and Gemini/Joy/Venus
adapters remain separate work. Native iOS has not been changed. Claude CLI is
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
native function calls. Its model setup omits unsupported thinking fields.

`live.stream.*` owns lifecycle and authentication; `src/live/providers/gemini.ts`
owns Gemini JSON. `GatewayStreamProvider` and `PcmMedia` own browser lifecycle,
capture, bounded playback and interruption. Backend task tools are shared with
Realtime. Completed jobs wait for generation and playback to drain before an
announcement; reconnect loads task state quietly. Tool-call cancellation from
speech interruption suppresses an obsolete tool response without cancelling an
already accepted durable task. This adapter records injection, not a claim that
a particular task result has been heard.

Provider disconnects surface an error and allow Start to restore saved text and
memory. Automatic hidden-state resumption is not implemented. Gemini's sliding
window compression stays provider-owned. Face tools, Stay silent and manual
Realtime item compaction remain disabled. Native iOS is unchanged.

Checks: `bun test ./tests/test-live-stream.ts`; browser fixtures in
`web-ios/tests/gateway-stream.test.tsx`. Paid synthetic probe:
`bun scripts/probes/gemini-live.ts`. The probe verifies real session setup,
spoken output and seeded-history recall, without using a physical microphone.
Protocol: https://ai.google.dev/gemini-api/docs/live-api/capabilities
