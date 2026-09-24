# Rolling session memory

The backend now maintains a saved summary for each conversation and an entry in
the corresponding daily log. It reads the gateway's archived user/assistant text,
including ordinary web Live turns that never delegate work.

```text
Persisted conversation JSONL (source)
    → session checkpoint + rolling summary
    → one replaceable entry per session per local day
    → existing six-hour consolidation into MEMORY.md
```

## When it runs

The normal gateway starts `SessionMemoryScheduler`. Every 60 seconds it scans
the latest 500 unarchived sessions, limited to those modified within seven days.
Maintenance sessions and delegated child workers are excluded. It rotates through
eligible conversations, with at most two model attempts per tick.

An active session becomes eligible after six new messages. Smaller batches become
eligible after 60 seconds without a source-file change. Successful updates have a
120-second per-session cooldown. Each request handles at most 24,000 text characters
from one calendar day; remaining text waits for another request. Scheduling limits
mean these are eligibility thresholds, not guaranteed delivery times.

iOS session-end and manual `memory.distill` requests use the same checkpoint and
bypass the automatic timing gates. Web Live needs no new session-end callback:
its persisted conversation is picked up during the next eligible scan.

Configure the gateway in `~/.hawky/config.json`:

```json
{
  "memory": {
    "session_enabled": true,
    "session_interval_seconds": 120,
    "session_min_messages": 6,
    "session_idle_seconds": 60,
    "distill_model": "gpt-5.4-mini"
  }
}
```

`distill_model` is optional. With an Anthropic API key the default is
`claude-haiku-4-5`; with only an OpenAI API key it is `gpt-5.4-mini`. Vertex and
OpenAI-compatible configurations retain their configured provider and model.
An explicit memory model overrides the default. CLI login alone does not supply
a memory API key; missing credentials leave the checkpoint unchanged and log a
retryable failure. `session_enabled: false` disables the new automatic extraction,
but does not disable existing manual requests or global consolidation.

## Saved state and interruption handling

Under the configured workspace (normally `~/.hawky/workspace`):

- `memory/.sessions/<sha256-session-id>.json`: summary, revision, source cursor
  and hash, latest daily entry, model, and last successful update time.
- `memory/YYYY-MM-DD.md`: one marked block per session, updated in place while
  preserving other sessions and handwritten entries. Dates follow the gateway's
  local timezone; transcript timestamps carry matching explicit UTC offsets.
- `MEMORY.md`: existing curated global memory, consolidated separately.

The model receives the previous session summary, the previous entry for that day,
and only new transcript text. The prompt distinguishes user facts from assistant
interpretations, preserves unresolved task status, and lets corrections replace
earlier mistakes. Output must be a complete JSON `session_memory` record with
nonempty, bounded `summary` and `daily_memory` fields. Invalid, truncated, tool, or
failed responses do not advance the cursor. Requests have a 30-second deadline.

An update takes a fixed source snapshot. New turns appended during generation
remain for the next update. Rewriting the covered source during generation rejects
the output. A previously rewritten source causes a rebuild from the available
transcript without carrying over unsupported old facts.

The checkpoint is atomically replaced first, then the daily block is replaced.
If the gateway exits between these writes, the next call repairs the daily block
from the checkpoint without another model call. Requests for the same session
are serialized inside the gateway, while the conversation continues. A stopped
Live connection does not cancel this independent backend job. A gateway restart
continues from saved progress; unchanged transcripts make no model call.

## Inspect or run manually

In web Live, **Update session memory** works before, during, or after a Live
connection, provided the gateway is connected and the conversation has text.
It first flushes pending transcript saves, then processes up to eight chunks.
The panel shows the saved summary, revision, daily file, and any error. If a
backlog remains, another click continues it. Switching conversations hides the
old result and stops further requests for it; a backend request already sent can
still finish safely for its original session.

Using the existing gateway WebSocket RPC transport:

```json
{"method":"memory.session","params":{"session_key":"web:YOUR_SESSION"}}
```

Returns the saved checkpoint or `null` before the first update.

```json
{"method":"memory.distill","params":{"scope":"daily","session_key":"web:YOUR_SESSION"}}
```

Returns `revision`, `session_memory`, daily `preview`, `file`, `skipped`, and
`has_more`. Repeat while `has_more` is true to process a backlog. A further call
with no new text returns `skipped: true`. `memory.snapshot` reads daily/global
files for the existing Memory UI. These snippets show RPC method and params;
the normal transport still supplies its request envelope and authentication.

On Start, web Live also calls `memory.resume` with the same `session_key`.
This read-only RPC validates the checkpoint against one transcript snapshot and
returns the summary plus every uncovered text turn. It neither calls a model nor
advances memory progress. A summary still being generated does not block resume:
the previously committed summary and its uncovered tail remain usable.

The frontend installs the summary before the tail using the existing acknowledged,
silent startup sequence. Microphone input stays disabled until restoration is
accepted, and no response is requested. The visible transcript is unchanged.
If the uncovered tail exceeds 24,000 characters or 100 messages, startup asks for
an update instead of dropping unsummarized turns. Missing/stale memory uses the
existing recent-history path. Crash-recovered recording turns are compared with
persisted recent turns; if they are not covered, the existing recording-recovery
path is retained with a visible warning rather than discarding those turns.

## Test it

Restart the gateway with this build. In web Live, say “I prefer green tea.” End
the session, wait about two minutes with the gateway running, and refresh Memory.
The daily file should have one session entry. Resume the same conversation and
say “Correction: I prefer black tea.” After another eligible update the same
entry should reflect the correction. Its revision should increase; reconnecting
without new turns should not add another entry. A busy backlog can take longer.

For an immediate check, use **Update session memory** with Live stopped, inspect
the panel, then Start. The status should report a restored memory revision. Hawk
should wait for you to speak. Ask about an earlier fact, then correct it and repeat.

Fixture checks, from the repository root:

```sh
bun test ./tests/test-session-memory.ts ./tests/test-memory-distill.ts ./tests/test-memory-scheduler.ts ./tests/test-prompts.ts ./tests/test-openai-provider.ts
bun test --timeout 30000 ./tests/e2e-memory-distill.ts
bun test ./tests/test-workspace.ts -t 'atomic writes'
bun run typecheck
bun run build
```

Opt-in paid quality check using synthetic conversations in a temporary workspace:

```sh
bun run prompt_test/rolling-memory-quality.ts --live --output /tmp/rolling-memory-quality.json
```

It makes four model calls: ambiguous meeting speech followed by a correction,
and a pending file task followed by cancellation and a preference. It also checks
that unchanged input skips the model. The saved
[GPT-5.4 mini report](../prompt_test/results/2026-09-24-rolling-memory-quality.json)
passes both scenarios. Regex checks and JSON validation are not a general
factuality guarantee; inspect the recorded summaries as well.

## Boundaries

This version summarizes **text only**. It does not preserve image understanding,
swap the active realtime context, or replace **Compact live context**. Reconnect
restores validated session text memory plus its uncovered tail; the boot context
also reads recent daily logs within its existing character budget. The separate
live image summary is not restored. When no valid session summary is available,
the previous recent-history/recording recovery behavior remains.

Daily entries for earlier days remain historical; later corrections appear in
the rolling session summary and the newer day's entry. Multiple gateway processes
writing the same workspace are not coordinated. Native agent context compaction
can rewrite its session log; a rebuild can only use the history that remains.
The existing daily-to-global consolidation policy is otherwise unchanged.

Implementation: `src/memory/session-memory.ts` owns checkpoints/projection;
`session-memory-scheduler.ts` owns timing; `distill.ts` owns provider calls;
`src/prompts/registry.ts` owns `memory.distill.daily.system`;
`src/gateway/memory-methods.ts` exposes inspection/manual runs; `src/index.ts`
starts and stops scheduling.

`src/memory/session-resume.ts` builds the resume packet;
`web-ios/src/lib/session-memory.ts` handles manual updates and packet selection;
`web-ios/src/lib/useRealtime.ts` flushes transcript writes and installs the packet
through `realtime-startup.ts`. Browser regression coverage is in
`web-ios/tests/realtime-resume.test.tsx` and `session-memory.test.tsx`.

Browser verification (September 24, 2026 UTC): with Live stopped, Update session
memory saved revision 1; repeating it returned up-to-date at the same revision.
A real `gpt-realtime-2` connection with mic/camera disabled acknowledged that
summary and zero uncovered turns, and generated no opening reply. The test
connection was ended afterward. All 183 web tests and 23 focused backend/RPC
tests passed, as did the backend typecheck and both builds. This does not test
microphone recognition, long audio sessions, or image-memory restoration.
