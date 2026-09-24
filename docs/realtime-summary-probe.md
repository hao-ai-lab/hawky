# Realtime summarization capability probe

This is the first experiment for conversation compaction, not a production
compaction implementation. It runs against a separate provider session and does
not modify the user's live call, gateway, saved history, or prompts.

## Provider-independent boundary

Hawk should own the conversation event log and versioned summary checkpoints.
Each summarizer consumes a frozen snapshot: application event IDs, timestamps,
text, selected image references, and the previous checkpoint. Provider item IDs
are temporary mappings owned by a connection adapter, not durable memory IDs.

The proposed interface is `summarizeContext(snapshot, signal) -> summary`.
Select its implementation by verified capability and configured credentials:

1. **Active-session summarizer:** a provider supports background inference over
   selected context without changing the live conversation. OpenAI Realtime's
   out-of-band response is the first implementation under investigation.
2. **Independent summarizer:** use a user-configured multimodal endpoint. This can
   be OpenAI, Gemini, or a hosted open model; it does not have to match the live
   provider. Never assume an OpenAI key exists or silently fall back to a paid
   provider the user has not configured.
3. **Unavailable:** keep the capability explicitly unavailable. Do not pretend
   old context has been summarized. The ordinary conversation can continue
   within its provider's limits; long-history guarantees require another path.

Native provider context compression is a separate capability from producing a
durable, inspectable summary. Do not assume Gemini, GPT-Live, Venus, or JoyAI can
export summaries or implement OpenAI's conversation events. Their adapters and
capability probes remain future work.

For OpenAI, the experiment uses `response.create` with `conversation: "none"`,
`output_modalities: ["text"]`, `tool_choice: "none"`, and an explicit list of
`item_reference` inputs. It identifies summary output through response metadata
and response IDs. This is a separate generation on the same connection, not a
persistent fork or a guarantee of a cloned inference cache.

## Run

From the repository root, with `OPENAI_API_KEY` already set in your environment:

```sh
bun test prompt_test/realtime-summary-probe.test.ts
bun run prompt_test/realtime-summary-probe.ts --runs 3 --output /tmp/summary-probe.json
```

This makes paid API requests. The model defaults to `gpt-realtime-2`; override it
explicitly with `HAWKY_REALTIME_MODEL`. `--runs` accepts 1–5 paired trials. Each
pair creates one baseline and one concurrent session. Trial order alternates.
Only synthetic evidence is uploaded; credentials and media bytes are omitted
from the report. No workspace memory, recordings, or microphone audio is read.

Each trial provides two generated images with a red circle and blue square
exchanging positions, plus a meeting correction from 15:00 to 16:00. It starts
an audio response counting aloud. The concurrent trial requests an image/text
summary after the first audio chunk, using only the frozen evidence items. Both
trials then append another correction to 17:00 and ask for the current time after
the first response has finished.

The probe requires:

- The summary recovers both visual changes and 16:00, including source IDs.
- It returns valid JSON, emits no audio/tools, and creates no default-conversation
  items. It must not incorporate the later 17:00 correction into its snapshot.
- Response lifetimes overlap and voice audio keeps arriving after the summary
  request. The follow-up still returns 17:00 with audio.

The report includes per-response timing, generated audio duration, largest audio
chunk arrival gap, summary usage, checks, and response lifecycle traces. A failed
assertion or provider/transport error produces a nonzero exit. Authentication or
protocol errors stop further trials instead of retrying paid requests blindly.

## Interpretation and next boundary

Live run on September 23, 2026 (PDT), using `gpt-realtime-2`: an initial pair,
followed by three baseline/concurrent pairs after tightening the output prompt.
The repeated run completed at `2026-09-24T03:09:59.660Z`.

- All three repeated concurrent trials passed the protocol checks: overlapping
  response lifetimes, audio arriving after the summary request, summary output
  outside the default conversation, and no summary audio or tool calls.
- Summary completion took 1,758 / 1,617 / 2,007 ms. This measures request to
  `response.done`, not persistence or context installation.
- Strict JSON failed in all three: two parenthesized objects and one object
  prefixed with `=`. Manual inspection found the correct image changes, snapshot
  meeting time, and evidence IDs in each. The automated content checks remain
  failed because parsing failed; the grader does not silently repair output.
- The spoken follow-up retained the newer 17:00 correction in 2/3 concurrent
  trials versus 3/3 baselines. The failure answered 16:00. This is an observed
  model/protocol-path failure, not proof of its cause or a measured failure rate.
- Concurrent trials' largest audio chunk arrival gaps were 157 / 797 / 628 ms;
  baseline gaps were 876 / 1,091 / 1,041 ms. Initial first-audio latency precedes
  the summary request by design and cannot measure its impact on speech onset.

Decision: the API can perform this operation, but do not enable it as the default
production summarizer yet. Output validation and correction retention need more
work. A stricter prompt did not guarantee JSON. Before choosing this strategy,
isolate the correction failure with before/during/after-generation controls and
compare a separately configured summarizer. No active context was deleted or
replaced during these experiments.

These are synthetic WebSocket API checks. They do not establish microphone/VAD
behavior, browser playback, browser event isolation, gateway authentication,
long-session accuracy, stop/resume recovery, or another provider's behavior.
Audio arrival gaps are transport observations, not audible playback gaps. Three
pairs are a capability smoke test, not a statistically reliable latency benchmark.

Before connecting this to the browser, route all summary events by response ID
before the speech coordinator and transcript handler in `useRealtime.ts`. The
current handler treats generated text as conversational output. Never let a
summary become a transcript bubble or let its lifecycle alter speech delivery.
Context installation/deletion and durable checkpoint commit are subsequent work.

Sources:

- [Realtime out-of-band responses and custom context](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [GPT-Live's separately managed long conversations](https://developers.openai.com/api/docs/guides/live-conversations)
