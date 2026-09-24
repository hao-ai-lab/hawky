# Try manual context compaction

In web Live, connect and click **Compact live context** in the header, beside Live
settings. It uses the connected realtime model and its existing credentials;
there is no separate compaction API key. This first implementation is OpenAI
Realtime only and must be triggered manually.

## Two-minute check

1. Show an object to the camera and say a distinctive fact, such as “My locker
   code is PINE-73.” Move the object out of view and exchange several more turns
   so the original evidence is older than the last four messages/newest image.
2. Click **Compact live context**. Inspect the generated summary, image/item counts,
   completion status, and elapsed time. The summary should never be spoken or
   appear as an assistant transcript bubble.
3. Ask for the code and what was visible earlier. Compare the answer with the
   summary. Try correcting a fact while summarization is running: the newer
   correction should win.
4. For interruption testing, click again and stop the session during the job.
   It should show cancellation, with no unfinished job carried into the next
   connection. This does **not** test checkpoint restoration; that is deferred.

“Nothing old enough to compact” is expected with a very short conversation.
Hide/Details collapses or reopens the bounded summary panel.

## Procedure and boundaries

- Track acknowledged provider message IDs without retaining another copy of
  image bytes. Protect the last four dialogue messages, the newest image,
  incomplete messages, system instructions/status updates, and tool call/output
  items. Select at most 96 older message items per click. A previous installed
  summary is included ahead of newer selected evidence on subsequent clicks.
- Request an out-of-band `response.create` with `conversation: "none"`,
  `output_modalities: ["text"]`, and explicit `item_reference` inputs. Also supply the
  completed retained tail as read-only clarification evidence, in source order,
  so a correction just beyond the deletion boundary is visible. End the input
  with the summarization task instead of an old conversational turn.
  Force a single response-local `report_history_summary` function to return the
  record as JSON arguments. It is a private output format, not an executable
  backend task; no function result is sent and no external work runs. Existing
  live tools are not offered to this response. Private response IDs bypass the
  normal tool/speech/transcript handlers. This makes an additional billed
  generation on the existing model.
- Require a complete, bounded JSON memory record with `type: "history_summary"`
  and four arrays: `facts`, `corrections`, `open_threads`, `uncertainties`.
  Reject advice/plain replies, incomplete or malformed output, other tools,
  audio, empty records, and oversized records before changing context.
  Parse the function arguments as JSON without extracting or repairing an object
  from prose. A text preamble accompanying the function call stays private and is
  discarded. Render only validated function arguments as readable text.
  These are structural checks, **not a factuality guarantee**. A factually wrong
  record in valid format can still pass; inspect the summary and run the quality
  eval below. Function parameters describe the contract; local validation remains
  necessary and does not establish semantic accuracy.
- Wait for a gap in speech, response generation, and playback. Hold explicit
  replies and temporarily disable automatic VAD responses, awaiting the provider
  acknowledgement. Keep incoming new messages and camera frames.
  Abort if a referenced source or retained clarification was changed meanwhile.
- Insert the summary at the conversation root with `conversation.item.create`.
  Only after its acknowledgement, delete the frozen source IDs one by one with
  `conversation.item.delete`, awaiting each acknowledgement. Restore turn
  detection and release queued replies. No compaction announcement is requested.
- If insertion fails, no original items are deleted. If deletion partially fails,
  retain the accepted summary and show failure/counts; the protocol has no atomic
  swap. A failed turn-detection restoration closes the connection for reconnect.
  Stopping or disconnecting cancels the old connection's job.

The visible transcript and raw archive are untouched. Diagnostics record
`compaction.state`, including summary, counts, elapsed time, and errors.
Counts describe tracked message items, not exact tokens or total context size.
Compaction does not rewrite identity, soul, tools, or backend task state.

**Connection-local experiment:** this operation does not save its visual summary
for reconnect or run at an automatic token threshold. Separately,
[rolling session memory](rolling-session-memory.md) saves text summaries and
restores them with uncovered turns on reconnect. **Update session memory** runs
that backend operation even with Live stopped. When no valid session memory is
available, reconnect uses the previous recent-history path. Gemini,
GPT-Live-specific protocols, Venus, and JoyAI remain follow-ups.

## Code and verification

- `web-ios/src/lib/realtime-compaction.ts`: snapshot, private response, acknowledged replacement.
- `web-ios/src/lib/realtime-compaction-summary.ts`: editable prompt, request construction, output validation.
- `web-ios/src/lib/useRealtime.ts`: connection lifecycle/event routing.
- `web-ios/src/lib/realtime-responses.ts`: speech/response queue lock.
- `web-ios/src/components/CompactionPanel.tsx` and `screens/LiveScreen.tsx`: button and inspection.

Deterministic tests (from `web-ios/`):

```sh
bun run test
bun run build
```

Opt-in paid provider check (from the repository root, `OPENAI_API_KEY` configured):

```sh
bun run prompt_test/realtime-compaction-smoke.ts
```

The smoke test uses the same compactor as Live in a separate synthetic WebSocket
session. It checks summary installation/deletion, earlier visual/text recall,
retention of a correction arriving during the job, and absence of private audio.
The first run with `gpt-realtime-2` compacted four items (one image) in 2.372 s;
the follow-up recovered PINE-73, a red circle/blue square, and the newer 17:00
meeting time. One successful run is not a reliability or latency benchmark.
Browser microphone/VAD/playback still needs the manual check above.

## Summary quality regression suite

The observed failure was a completed advice reply that the old validator accepted
as a summary, deleting 26 old items. The unit regression was run against that
implementation and failed before the fix. It now requires rejection with zero
deletions. Other tests cover malformed/truncated output, a correction changing
during generation, private event routing, and continued normal conversation.

Run the offline quality-check tests from the repository root:

```sh
bun test prompt_test/realtime-compaction-quality.test.ts
```

Run the actual realtime model, with `OPENAI_API_KEY` configured (paid):

```sh
bun run prompt_test/realtime-compaction-quality.ts --runs 2 --output /tmp/hawky-compaction-quality.json
```

Five synthetic scenarios run in separate provider sessions:

1. Mixed backend/identity/chat history and a misheard meeting, with its correction
   among the four retained messages. Earlier directory and session facts must survive.
2. Ambiguous speech without a correction. An earlier assistant's diagnosis must
   remain unsupported rather than becoming an established fact.
3. Export failure and cancellation requested but not yet confirmed. Requests,
   failures, and completed actions must stay distinct.
4. Quoted malicious instructions. The original locker code must survive.
5. Two generated image frames with swapped objects, followed by a blank image.
   Both the summary and post-deletion recall must preserve the earlier visual
   changes. A meeting correction arriving during compaction must win afterward.

The suite calls the **same compactor as the browser**, installs accepted summaries,
deletes covered originals, and asks recall questions. Independent known-fact checks
grade both the summary and recall; expected answers/checks are never supplied in
the summarization prompt. Format rejection is a failed quality trial, even though
it safely retains the history. Reports include raw candidates, installed summaries,
answers, timing, token usage, deletion IDs, and every failed check. They omit media
bytes and credentials. A nonzero exit means failure. Use `--case <id>` to isolate a
fixture; `--runs` is bounded to 1–3 and each generation/acknowledgement has a timeout.

These are finite fact checks with regexes, not a general semantic judge. The grader
tests include deliberately wrong times, lost topics, reversed image movements, and
false cancellation claims. Inspect saved raw output too. This does not test real
ASR, browser playback, long-running sessions, or durable reconnect restoration.

### Recorded result — September 24, 2026 (UTC)

[Saved synthetic provider report](../prompt_test/results/2026-09-24-compaction-quality.json):
`gpt-realtime-2`, two runs of each case. All 10 trials installed and supported the
post-deletion recall checks; **8/10 passed every summary-quality check**. Both
failures were the unresolved ambiguous-speech case: the summary attributed the
earlier medical statement to the assistant, but failed to explicitly label that
assistant conclusion as unsupported. The later recall answer declined to assert
a reliable diagnosis. Keep the stricter summary requirement as a failing quality
case; downstream recall alone is insufficient to certify a summary.

The reported advice-as-summary regression passes: a plain advice reply is rejected
before any originals are removed. All 175 web fixture tests, four offline grader
tests, and the production build passed. There are existing React `act` warnings in
unrelated web tests. No browser microphone/playback run was performed in this batch.
This is a small quality sample, not a production reliability claim or approval for
automatic compaction. Stronger handling of unsupported assistant conclusions is
the next prompt-quality check to address.
