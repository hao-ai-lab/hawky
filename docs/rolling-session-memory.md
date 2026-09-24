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

## Test it

Restart the gateway with this build. In web Live, say “I prefer green tea.” End
the session, wait about two minutes with the gateway running, and refresh Memory.
The daily file should have one session entry. Resume the same conversation and
say “Correction: I prefer black tea.” After another eligible update the same
entry should reflect the correction. Its revision should increase; reconnecting
without new turns should not add another entry. A busy backlog can take longer.

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
swap the active realtime context, or replace the frontend's Compact now button.
Reconnect still uses the existing history/boot-context path; that boot context
already reads recent daily logs within its character budget. Direct restoration
of a session summary plus an uncovered transcript tail remains separate work.

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
