# Hawk realtime roadmap

Updated: 2026-09-23. This is the ordered work list from the current engineering
discussion, not a claim that every feature below is implemented or verified.

Maintain the existing system. Prefer clear boundaries, observable behavior, and
repeatable tests over a rewrite. Finish one batch with evidence before expanding
scope. Keep each implementation feature in its own logical commit.

Priority update: move conversation summarization, realtime context compaction,
and generated conversation titles directly after the current batch cleanup.
Proactive application behavior remains the final app batch. Other ordering is
still open to the user's roadmap review.

## Current position

Core delegation has passed user testing for native backend work, concurrent
native tasks, cancellation, and the Codex execution path. A backend probe also
verified Codex conversation continuation across a client reconnect. Live settings
and input choices before starting a session are implemented. These results do not
establish model quality, every recovery edge case, Claude Code support in the
live environment, or iOS parity.

Use [the delegation checklist](realtime-delegation.md) for exact acceptance cases,
[the scenario checklist](../prompt_test/README.md) for prompt checks, and
[the recording guide](realtime-recordings.md) for evidence and replay limitations.

## Remaining app-quality work, in order

### 1. Close the current batch and explain the code

- Replace the separate Live "Enable CLI runtimes" toggle with one coherent
  backend selector: Hawk provider, Codex CLI, or Claude Code CLI. Selection must
  complete the necessary configuration or show a specific setup error. Merely
  hiding the toggle while leaving the current runtime gate unchanged is not a fix.
- Persist selection of the working Codex executable in the local launch setup;
  the successful restart used a process environment override. Keep private
  deployment details out of the public product code and docs.
- Verify the settings popup remains usable after backend changes. The earlier
  blank-popup report has not been confirmed fixed.
- Walk through session start, prompt/history preparation, function calls,
  delegation, result delivery, and reconnect. Include a small module map and
  identify the boundaries that need stronger tests or later extraction.
- Record remaining acceptance gaps without reopening already accepted behavior.
  Claude Code live testing stays deferred.

Done when: configuration survives a restart, the selector cannot silently leave
the chosen backend unusable, and the code path can be followed from the docs.

Primary files: `web-ios/src/components/LiveSettingsPanel.tsx`,
`web-ios/src/lib/useRealtime.ts`, `web-ios/src/lib/realtime-responses.ts`,
`src/gateway/delegation-methods.ts`, `src/gateway/external-agent-runtime.ts`.

### 2. Prioritize conversation summarization, compaction, and titles

- First capture a short-session baseline and provider usage, then run a 20-30
  minute mixed conversation to track context growth, latency, corrections, and
  pending tasks. Longer or deliberately context-heavy cases must exercise the
  actual compaction trigger; elapsed time alone does not establish token pressure.
- Add backend-owned, bounded conversation summarization for the realtime client.
  Preserve recent turns, corrected facts, unresolved questions, authoritative task
  state, uncertainty, and links to source evidence. Persist summaries separately
  from the raw conversation archive. Design this separately from global/daily
  memory consolidation and from the delegated agent's own context compaction.
- Control compression latency and ensure context replacement does not race with
  speech or task completion. Summarize a known completed prefix in the background;
  retain newer turns and results. Apply only a current, validated summary at a safe
  boundary, with a bounded timeout and failure fallback. Keep stable identity,
  behavior rules, and tool truth outside any summary rewrite.
- Test reconnect and correction after compaction. Current browser replay selects
  at most 30 user/assistant text messages; visible older history is not equivalent
  to restored model context. Resume should use a saved summary plus the relevant
  recent tail without silently dropping corrections or duplicating pending work.
- Generate a concise conversation title from the first meaningful summary, or a
  small early summarization pass after the topic becomes clear. Do not wait until
  the context window is full just to title a short conversation. Track whether a
  title is a placeholder, automatically generated, or user-edited; replace only
  eligible automatic/default titles. Never overwrite a manual rename, including
  one made while a background title request is in flight. Avoid continual renames.

Verified model/API facts on 2026-09-23:

- The currently selected model is `gpt-realtime-2`. Its official model page lists
  a 128,000-token context window and 32,000 maximum output tokens. These are
  model-level limits, not a guarantee of 128,000 usable history tokens in any
  particular session. Check effective session settings and output headroom.
  [Model reference](https://developers.openai.com/api/docs/models/gpt-realtime-2)
- OpenAI describes that context as roughly 1-2 hours of dense two-way raw audio,
  depending on other context and reasoning. That is context-capacity guidance,
  not a promise about connection lifetime or Hawk's mixed audio/image workload.
  [Long-session guidance](https://developers.openai.com/api/docs/guides/voice-prompting)
- Default Realtime truncation removes oldest items from response input at the
  input limit. It is not a semantic summary. The API exposes retention and token
  limits; disabling truncation can produce a context-too-long error instead.
  Set thresholds from measured usage and headroom, not an assumed older 32k limit
  or a fixed timer. [Truncation reference](https://developers.openai.com/api/docs/guides/voice-latency-cost)

Current code boundaries:

`src/agent/compaction.ts` implements native backend-agent summarization with a
default trigger at 95% and a blocking threshold at 98%; `agent-methods.ts` invokes
it for native chat turns. That does not manage a browser-to-provider realtime
conversation or a Codex/Claude CLI conversation. Do not copy those thresholds
into the realtime path without measuring the time/headroom needed to summarize.

The browser currently replays recent text without a rolling summary. Updating
the backend's stored transcript alone would not change the active provider
context: installation of a summary and retirement of covered items need an
explicit, verified client/provider protocol. Keep the raw archive intact.

`web-ios/src/lib/session-store.ts` currently generates a title from the first
user message's first 50 characters and stores it as a display name. The future
title update needs provenance/version handling to distinguish it from a manual
name. Share the summary input/job when useful, but treat title failure separately
so it cannot block compaction or conversation startup.

Done when: the measured long-session test retains the facts and pending work it
needs without an unexplained latency increase or false continuity claims; an
automatically titled short conversation has a useful title, and manual names
survive delayed summarization results.
This is working-context maintenance, not a general long-term media memory system.

Primary areas: `src/agent/compaction.ts`, `web-ios/src/lib/session-store.ts`,
`web-ios/src/lib/realtime-startup.ts`,
`web-ios/src/lib/useRealtime.ts`, `src/gateway/frontend-boot-context.ts`,
`ios/hawky/Live/LiveSessionSummarizer.swift`. Existing implementations are candidates
for reuse, not evidence of equivalent behavior on every frontend/provider.

### 3. Establish basic prompt correctness and a small performance benchmark

- Save the exact assembled prompt, enabled tools, model/settings, selected
  history, recording ID, and task IDs for each case. Keep identity/soul,
  interaction rules, and runtime context understandable as separate inputs.
- Test identity, ambiguous speech, corrections, conversation recap/resume,
  camera availability, and truthful pending/failed/completed tool claims.
  Asking about this conversation should not automatically trigger a backend job.
- Run matching typed and spoken cases to distinguish reasoning/prompt failures
  from audio understanding and turn detection. The displayed ASR transcript is
  not proof of what the audio-native model understood.
- Measure connection/restoration time, user speech end to first audible response,
  interruption-to-silence time, and backend queue/execution/delivery delays.
  Separate provider generation events from browser playback and perceived latency.
- Use fixtures for protocol/state assertions, real-provider cases for model
  behavior, and human ratings for usefulness and interruption quality. Record
  sample counts and failures; a small probe is not a reliable tail-latency claim.

Done when: a prompt edit can be compared against a saved baseline using a short
repeatable suite. No new LLM prompt-rewriting layer is required to reach this gate.
Proactive reminder policy belongs to batch 5, not this baseline.

Primary files: `src/gateway/frontend-boot-prompt.ts`,
`src/gateway/frontend-boot-context.ts`, `web-ios/src/lib/realtime-prompt.ts`,
`prompt_test/README.md`, `prompt_test/realtime-smoke.ts`.

### 4. Verify existing capabilities and frontend parity

- Exercise person introduction, candidate confirmation/rejection, profile saving,
  later recognition, unknown faces, and missing camera frames against the actual
  recognition service. Fixtures alone do not establish recognition accuracy.
- Test current memory retrieval and conversation isolation within their existing
  limits. Keep chat recall separate from durable personal memory and backend history.
- Check audio-only use, camera input, typed input, interruption, Stay Silent,
  chart/result rendering, and task inspection. Retain these controls as regression
  cases without adding new proactive policies.
- Reuse the scenarios on native iOS. Use fixtures/simulator checks where useful,
  then verify microphone, camera, playback, reconnect, and notifications on a device.
  Track web and iOS results separately.
- Inventory Joy, Realtime Venus, Muse, and current Hawk features as references.
  Distinguish implemented/tested behavior from source support and product claims;
  choose the subset needed for Hawk instead of copying every feature.

Done when: each advertised capability in the chosen demo has an observed result,
an explicit unsupported state, or a documented defect. Apply targeted modularity
fixes where those tests expose a weak boundary; avoid a broad refactor first.

Primary areas: `src/identity/person/`, `web-ios/tests/`,
`web-ios/src/lib/useRealtime.ts`, `ios/hawky/Live/`.

### 5. Define proactive behavior and add visible reminders/tracking — last app batch

The meeting discussion is recorded here for later implementation. Basic hearing
and tool-truth defects remain batch 3 issues; decisions about when Hawk should
take initiative belong here.

Recommended initial behavior:

- "I have a meeting at 3": retain the fact in conversation, resolve missing date
  or ambiguous time when needed, and offer a useful reminder. Do not assume that
  mentioning an existing meeting means creating another calendar event.
- A complete explicit reminder request should execute without a redundant
  confirmation. Use current time/timezone and existing preferences; ask only for
  missing details that change the action.
- Treat conversation recall, a durable note, a reminder, and a calendar event as
  distinct outcomes. Never claim something was saved or scheduled before tool
  success. Automatic reminders based on a standing user preference remain a
  policy decision, not a default silently adopted by this roadmap.
- Corrections and cancellation must update the existing commitment/reminder and
  prevent duplicate or obsolete notifications. Unclear audio should trigger a
  focused clarification rather than an unsupported interpretation.
- Surface something only when it is useful enough to interrupt. Record useful
  observations without narrating every scene or generating generic advice after
  every statement.

Add a simple, inspectable reminder/tracking list: what Hawk is tracking, due or
reminder time, state, and edit/cancel controls. Keep the link to the conversation
or task that created the item. Start with commitments and reminders; do not build
a separate elaborate goals product before those work.

The current local test gateway starts delegation and memory but not the cron or
ambient-intention services. The browser has no direct reminder tool, and the
Codex adapter's Hawk MCP allowlist currently exposes read-only session access.
Existing `src/ambient/create-intention.ts` and scheduler code are starting points,
but prompt text alone cannot supply the missing execution/delivery path.

Acceptance scenario: mention meeting, clarify time, request reminder, inspect
saved item, move meeting from three to four, reconnect, receive one correct
notification. Also test cancellation, failed scheduling, duplicate requests, and
the promised behavior while the frontend is disconnected or closed.

Done when: the visible record, backend state, spoken claims, and actual delivery
agree. Use this case for the architecture walkthrough before implementing it.

Design reference: [How We Designed Muse](https://introducing.muse.ai/) describes
persistent work, tracking, activity visibility, and selective proactive updates.
It is inspiration, not evidence that Muse or Hawk passes these acceptance cases.

## Subsequent product work

Recommended order after the current app-quality sequence; these are not removed
from the product vision and are not prerequisites for closing this delegation batch.

1. **Self-hosted realtime models and provider adapters.** Bring up one open model
   with a minimal real audio/video/tool probe before integrating more frontend
   paths. Preserve the interactive-model-first hosting direction, then extend to
   omni/audio-only backends as supported. Audio-only usage of the current provider
   is already part of batch 4. Run the same benchmark across providers and expose
   actual modality/tool support, including graceful fallback. Do not promise a
   self-hosted model from a UI selector or a server health response alone.
2. **Long-term visual/audio memory.** Evolve the existing transcript/image archive
   into periodic or session-gap processing, searchable derived memory, and source
   references. Keep raw evidence distinct from summaries. Decide raw audio capture,
   retention, upload recovery, and retrieval explicitly; existing recordings are
   not proof that this entire system exists.
3. **Richer artifacts.** Start by showing a generated page or document inside Hawk.
   A hosted application with its own backend/database is a separate later scope
   with deployment and lifecycle work, not something a preview alone establishes.

Claude Code integration testing can resume as a bounded compatibility task when
wanted; do not let it block the Codex path. Dedicated multi-stream monitoring and
safety-agent expansion remain separate later work.

## Explicitly outside the current plan

- A feed and an ideas tab are not required product surfaces.
- No attempt to clone all of Muse, Joy, or Realtime Venus.
- No general full-stack application hosting platform in the current milestone.
- No whole-codebase rewrite or broad refactor before evidence identifies a need.

Immediate next action: batch 1 cleanup and the source walkthrough. Keep this file
as the priority list; keep executable cases and observations in `prompt_test/`.
