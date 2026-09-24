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
if a correction arrives during interpretation. Independent native read-only tasks
can run concurrently; CLI tasks and mutations retain the existing serialization
and permission policy. A gateway restart marks interrupted work for explicit
recovery rather than replaying side effects.

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

Manual checks, about 10–15 minutes:

1. Select GPT-Live, start and wait: no opening speech. Say “My test color is
   turquoise.” Stop/start and ask the color: continuity without an opening recap.
2. Ask for two separate read-only directory listings. Expect two task IDs and
   accurate results. Speak while they run; no Realtime active-response error.
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
