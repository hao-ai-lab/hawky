# Try manual context compaction

In web Live, connect and click **Compact now** in the header, beside Live
settings. It uses the connected realtime model and its existing credentials;
there is no separate compaction API key. This first implementation is OpenAI
Realtime only and must be triggered manually.

## Two-minute check

1. Show an object to the camera and say a distinctive fact, such as “My locker
   code is PINE-73.” Move the object out of view and exchange several more turns
   so the original evidence is older than the last four messages/newest image.
2. Click **Compact now**. Inspect the generated summary, image/item counts,
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
- Request an out-of-band, text-only `response.create` with `conversation: "none"`,
  `tool_choice: "none"`, explicit `item_reference` inputs, and a bounded plain-text
  summary. Private response IDs bypass the conversational speech/transcript
  handlers. This makes an additional billed generation on the existing model.
- Check completion/nonempty text/length/output type. These checks do not prove
  factual accuracy; the inspection panel is deliberately part of the experiment.
- Wait for a gap in speech, response generation, and playback. Hold explicit
  replies and temporarily disable automatic VAD responses, awaiting the provider
  acknowledgement. Keep incoming new messages and camera frames.
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

**Connection-local experiment:** no durable checkpoint loading, automatic token
threshold, archive-to-summary job, or global/daily memory consolidation is
implemented here. Reconnect still replays the existing recent text history (up
to 30 messages); it does not restore this summary or its visual knowledge. Gemini,
GPT-Live-specific protocols, Venus, and JoyAI remain follow-ups.

## Code and verification

- `web-ios/src/lib/realtime-compaction.ts`: snapshot, private response, acknowledged replacement.
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
