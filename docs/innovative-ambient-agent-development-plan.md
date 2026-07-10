# Technical Debt Remediation Plan

Date: 2026-07-03.

## Context

This plan is distilled from `docs/strategy-2026-07.md`, a whole-repo audit produced
by a 30-agent workflow (seven subsystem auditors reading the code, four market
researchers, four adversarial critics, then a verification pass that fact-checked
every high/critical claim back against the source — 12 confirmed, 2 refuted or
downgraded). What follows is only the engineering half of that audit: sections §8
(technical debt) and §9 (the rewrite candidates). Distribution, release, licensing,
and marketing items are deliberately excluded — this is a builder's backlog.

The audit's one-line verdict frames everything below: **hawky is an excellent agent
runtime wearing an ambient-agent costume; the core (agent loop, safe-bash parser,
hybrid memory retrieval, test discipline) is staff-level, but the shell and the
seams have fallen behind it.** Concretely, the debt clusters into three shapes:

1. **God modules fighting themselves.** Three files have grown past the point where
   they can be unit-tested — `tool_executor.ts` (1,467 lines), web `session-store.ts`
   (2,793 lines), and iOS `LiveSessionStore.swift` (4,905 lines / 251 methods). Each
   is now a single point of failure that every new feature is poured into.
2. **Abstractions that lie.** `McpServerManager` advertises reconnect-on-crash and
   health monitoring in its header comment while implementing neither;
   `ReconnectingTransport.swift` only ever retries the *initial* connection; the
   ambient delivery layer wraps three layers of abstraction around a single boolean
   that is dead in every production path.
3. **Inverted risk.** The latent-intention engine mints intentions with an LLM but
   destroys them with a stop-word-grade regex (`the` / `for` / `got` all count as
   topics), so a real user need can be suppressed forever.

The good news the audit is equally emphatic about: of the ~17 weaknesses it found,
13 are pure execution measured in days-to-weeks. There is no unfixable disease here,
only an unscheduled queue. This document is that queue, ordered.

Task IDs (`#N`) map to the live task tracker for this effort. Every claim carries a
`file:line` citation; the full evidence chain lives in `docs/strategy-2026-07.md`.

## P0 — Actively causing wrong behavior

These are not latent risks; they are shipping bugs or data-loss paths today. They
are also mostly independent of one another and day-sized, so they can be parallelized
and should be cleared before anything larger starts.

### #9 — Fix the dead file watchers

**Problem.** chokidar v5 removed glob support, but `skills/watcher.ts:61,65` and
`memory/index.ts:762` still pass it literal glob strings (e.g. a path containing `*`)
that now match nothing. The watcher registers, reports success, and then never fires.

**Blast radius.** Skills hot-reload is silently dead — editing a skill on disk has no
effect until a full restart — and edits to root `.md` files never trigger a memory
reindex, so the memory index quietly goes stale against the files it claims to mirror.
Both failures are invisible: nothing logs, nothing errors.

**Why it regressed unnoticed.** There is zero test coverage over the *real* watcher;
the existing tests exercise the reindex function directly and never assert that a
filesystem change actually drives it.

**Fix.**
1. Watch the containing directory (non-glob) and apply a filename filter in the event
   handler, replacing every glob pattern handed to chokidar.
2. Audit for any other glob-to-chokidar call sites.
3. Add an integration test that writes a real file and asserts the watcher fires and
   the index/skill set updates.

**Effort:** ~2–3 days. **Dependencies:** none.

### #10 — Fix the `HAWKY_HOME` split-brain

**Problem.** Seven modules hard-code `~/.hawky` (`session.ts:70`, `workspace.ts:26`,
`skills/loader.ts:35`, `input-history.ts:13`, and three more) instead of deriving from
the single configured root. Commit `dc5c222` fixed roughly half of them and is not on
HEAD.

**Blast radius.** When `HAWKY_HOME` (or the config root) is overridden — tests, CI,
multi-instance setups, or a user relocating state — some subsystems read/write the
override while others read/write `~/.hawky`. State lands in two homes: sessions in one,
skills or input-history in another, with no error to signal the divergence.

**Fix.**
1. Route every path through one `configRoot()`/`hawkyHome()` helper.
2. Replace all seven hard-coded literals; land the unshipped half of `dc5c222` in the
   same pass.
3. Add a test that sets an override and asserts no module touches `~/.hawky`.

**Effort:** ~2 days. **Dependencies:** none (self-contained, but touches many files —
do it early to avoid conflicts with later work).

### #11 — Fix the setTimeout overflow and the regex satisfaction sweep

Two independent reminder-engine bugs bundled because they share the `when`/latent path.

**Problem A — timer overflow.** `when-cron.ts:40-49` passes a delay larger than the
32-bit `setTimeout` ceiling (~24.8 days), which wraps to a tiny/negative value, so any
reminder scheduled more than ~24.8 days out fires *immediately* instead of on time.

**Problem B — irreversible false deletion.** `latent-service.ts:286-315` decides an
intention is "satisfied" using a stop-word-grade regex in which tokens like `the`,
`for`, and `got` count as topic matches. A genuine, still-pending reminder can be
matched and permanently deleted — there is no backup and no undo.

**Fix.**
1. Chunk long timers: cap each `setTimeout` at a safe interval and re-arm until the
   real due time (or move to the scheduling library adopted in #30).
2. Fold satisfaction detection into the per-tick LLM call that already runs, and demote
   the regex to a cheap candidate pre-filter — or delete it. Never let the regex be the
   sole authority for deletion.
3. Add tests for a >25-day reminder and for a satisfaction check that must *not* delete
   a live intention.

**Effort:** days (A) to ~1 week (B). **Dependencies:** related to #30.

### #12 — Fix `MemoryIndex.sync()`

**Problem.** `index.ts:146-181` awaits a network embedding call *inside* an open SQLite
write transaction, with no mutex guarding concurrent syncs.

**Blast radius.** Under the gateway's four-way concurrency, overlapping syncs contend
on the write transaction while one is blocked on the network; the transaction stalls
and the memory layer silently degrades to its grep fallback — retrieval quality drops
with no visible error.

**Fix.**
1. Compute all embeddings *before* opening the transaction; keep the transaction purely
   local and short.
2. Serialize `sync()` behind a mutex/queue so concurrent callers coalesce rather than
   collide.
3. Add a concurrency test that fires overlapping syncs and asserts no transaction stall
   and no grep fallback.

**Effort:** ~2–4 days. **Dependencies:** none; touches the same subsystem as #25.

### #13 — Fix the global `process.env` leak in skill env injection

**Problem.** `skills/env.ts:50-93` mutates the shared global `process.env` to inject a
skill's environment before running it.

**Blast radius.** Two skills running concurrently see each other's injected variables —
including secrets/API keys — and a skill that sets a variable can leave it set for
unrelated later code. This is a real secret-crossing bug, not a style issue.

**Fix.**
1. Build a per-run env object and pass it as the `env` option to `Bun.spawn`; never
   mutate the global.
2. Audit for any other global-env mutation on the skill path.
3. Add a test that runs two skills concurrently and asserts neither sees the other's
   variables.

**Effort:** ~1–2 days. **Dependencies:** none.

### #14 — Stop the destructive `MEMORY.md` consolidation

**Problem.** Every six hours the global consolidation reads `MEMORY.md`, truncates it to
16k chars (`distill.ts:304`, `MAX_GLOBAL_CHARS`), feeds that to a 2048-token Haiku
rewrite (`distill.ts:356`, `MAX_GLOBAL_OUTPUT_TOKENS`) prompted to "return the FULL
updated MEMORY.md", and unconditionally overwrites the file with a bare `writeFileSync`
and no backup (`distill.ts:370` → `workspace.ts:233`). Separately, daily distillation
slices the session transcript to the *first* 24k chars (`distill.ts:165`,
`slice(0, MAX_TRANSCRIPT_CHARS)`), so it summarizes the *start* of a long session and
drops the end — usually the most recent, most relevant context.

**Blast radius.** User memory is silently and irreversibly lossy on a normal 6h schedule.
Anything past the 16k cut, or dropped/paraphrased to fit the 2048-token output, is gone
with no recovery path — and because each run's output is the next run's input, the loss
compounds (a telephone-game ratchet: facts can only be lost or held, never recovered).
For a product whose differentiator is persistent memory, this is a credibility-critical
data-loss bug.

**Fix (ship now — safety net, ~1–2 days, low risk).** Make the existing consolidation
non-destructive without redesigning it:
1. Snapshot before every write: `memory/.backups/MEMORY-<ISO>.md` (bounded history),
   then write atomically (temp file → `renameSync`), reusing the house atomic-write /
   `.bak` pattern (`candidate.ts:326`, `session.ts:568`). Gives a recovery path.
2. Anti-lossy gate, fail-closed: if the new output is much shorter than the existing
   file (or its fact count drops sharply), do NOT overwrite — keep the old file, log a
   warning, and write the candidate to `MEMORY.md.proposed` for review.
3. Remove the 16k input truncation (`distill.ts:304`) and raise
   `MAX_GLOBAL_OUTPUT_TOKENS` (`distill.ts:356`) so the model is not forced to compress.
4. Fix daily distillation to keep the tail: `slice(-MAX_TRANSCRIPT_CHARS)` (or head+tail)
   at `distill.ts:165`.
5. Test: a 30k `MEMORY.md` is not truncated, a pre-existing fact survives consolidation,
   a backup exists, a suspiciously-short rewrite is NOT written, and the daily summary
   reflects the session tail.

**Better direction (evidence-gated follow-up).** The deeper fix reframes the problem:
`MEMORY.md` only needs to be *small* for the system-prompt bootstrap injection
(`workspace.ts:305`) — retrieval already flows through the SQLite chunk index over ALL
memory files (`index.ts`), so the durable store never needs a lossy operation. This is a
*budgeted selection* problem, not a compression one (cf. "budgeted pre-query retention",
EMBER, arXiv 2606.05894). Target shape: keep an append-only archive (daily logs,
`.jsonl`, the candidate ledger — all already indexed) as truth, and make `MEMORY.md` a
**deterministically rendered, budgeted top-K view** of verbatim "capsules" ranked by
observed usefulness — so "consolidation" becomes "re-select the capsule set", "forgetting"
becomes reversible demotion (still archived, still searchable), and the compounding LLM
rewrite is *deleted*, not made safer. The candidate ledger (`candidate.ts`) already has
verbatim text + content-hash dedup + atomic write + review states, and is the natural
substrate (its promotion path is currently a stub — `memory-methods.ts:57`).

Do NOT build this speculatively. Three blockers must be resolved first, and it is only
worth it if evidence shows real memory actually exceeds the budget:
- **Hand-edit clobber (new data-loss risk):** re-rendering `MEMORY.md` would overwrite the
  user's manual edits. Must ingest the current file as capsules before each render, or
  skip render when the file changed since last render.
- **Feedback signal:** drive the usefulness counter from *index-search hits* (which search
  the whole archive, so demoted capsules can resurface), not from prompt presence, to
  avoid a rich-get-richer loop; needs line-range attribution from chunk → capsule.
- **Conflict resolution:** contradictory capsules must supersede-don't-delete (first-class,
  not optional) or the rendered view shows stale contradictions.
Also instrument: duplicate indexing of the rendered view vs. its source archive, and
render churn (prompt-cache thrash) under a feedback-driven ranking. A simpler high-leverage
alternative worth measuring first: shrink the always-on core to identity/standing prefs
and lean on the automatic per-turn retrieval hawky already has.

**Effort:** ~1–2 days (safety net) → ~2 weeks (capsule retention, if evidence justifies
it). **Dependencies:** none for the safety net; the capsule direction touches the same
subsystem as #12 and the candidate ledger.

## Security & trust debt (pre-launch)

Real code fixes on the trust boundary — the parts a security-minded reader (and, for
an always-listening agent, that reader will show up on day one) audits first. None of
these is a broad architectural rewrite; they are targeted, and they are the difference
between a credible launch and a bad first headline.

### #5 — Constrain headless permissions

**Problem.** Headless lanes (cron, heartbeat, sub-agents) auto-approve `write_file` /
`edit_file` to arbitrary paths when no interactive resolver is present
(`tool_executor.ts:1337-1363`): the safe-allowlist check failing only sets
`needsPermission`, which then falls through to the auto-approve path.

**Accuracy note (from the verification pass).** The original critique framed this as
"the autonomous path only has a 17-regex denylist" and rated it critical; verification
downgraded that. In reality bash and curl already sit behind a fail-closed *allowlist*,
with a dangerous-floor override that beats even explicit user allow-rules, config-deny
precedence, and headless denial of `ask` rules — so constructs like `find -delete` and
`xargs rm` are *not* auto-approved, and curl is restricted to GET / no-upload /
Slack-read endpoints. What remains genuinely wrong is narrower but real: arbitrary-path
file writes/edits on a lane that runs unattended, all day.

**Fix.**
1. Give headless the same fail-closed allowlist discipline as interactive mode for
   `write_file`/`edit_file` — no silent fall-through to auto-approve.
2. Add per-lane capability grants: a heartbeat can only write inside `workspace_dir`;
   broader scopes require explicit configuration.
3. The clean long-term home for this is the #34 policy-pipeline rewrite — this task is
   the tactical stopgap that ships first.

**Effort:** ~1–2 weeks. **Dependencies:** superseded (not blocked) by #34.

### #6 — Remove the global ATS opt-out and the plaintext API key on iOS

**Problem.** The shipped iOS app disables App Transport Security globally
(`project.yml:70`, `NSAllowsArbitraryLoads`), and a demo store persists an API key in
plaintext `UserDefaults`.

**Blast radius.** The global ATS opt-out weakens transport security app-wide (not just
for the local-network case it was presumably meant for) and is a flag App Review
scrutinizes; the plaintext key is readable by anything with file access to the app
container and is exactly what a first-day code audit greps for. Both are also
reputational: they read as carelessness on a product asking users to trust it with
audio and video.

**Fix.**
1. Replace the global opt-out with `NSAllowsLocalNetworking` (or a scoped exception
   domain) covering only the actual gateway/local-network need.
2. Move the API key to Keychain, or remove the demo store from the release target
   entirely (see #28, which evicts the demo/lab stores).

**Effort:** ~2–3 days. **Dependencies:** overlaps #28.

### #7 — Make face recognition opt-in and stop auto-enrolling strangers

**Problem.** Cocktail-party recognition auto-enrolls non-consented bystanders as
"Unknown" (`CocktailPartyRecognizer.swift:210-220`), and the deepface sidecar grows a
person's embedding on a *read* path whenever it confirms a match
(`app.py:287-294`, capped at 12 entries). So merely being near the device builds a
biometric record of you.

**Accuracy note.** This is *face* recognition, not voiceprint — the repo contains no
voiceprint code, so the voiceprint-specific legal theories don't apply. The consent gap
itself is fully real: it lands squarely in BIPA face-geometry theory and GDPR Art. 9
special-category data, across the ~23 US states with biometric statutes.

**Blast radius.** This is the single highest legal-risk item in the whole audit, and it
directly undercuts the "privacy is our moat" positioning: the product currently does the
exact thing that positioning promises it won't.

**Fix (stopgap now; full consent engine is a separate later effort).**
1. Default face recognition OFF.
2. Remove the Unknown auto-enroll path entirely; unknown faces are anonymized, never
   stored as biometric records.
3. Make `/identify` read-only — move embedding growth out of the read/confirm path to
   an explicit, consented enrollment action.
4. Add a per-person delete path (today only a whole-DB `/clear` exists).

**Effort:** stopgap ~days; full consent engine ~weeks–months (tracked separately).
**Dependencies:** precursor to the Phase-1 consent engine in `strategy-2026-07.md`.

## P1 — Duplication paying a daily multiplication tax

Not broken today, but every fix has to be made three or four times, and drift has
already shipped bugs. These are the highest-leverage cleanups: two of them (#15, #16)
also unblock the big rewrites (#27, #31).

### #15 — Extract one shared stream-event state machine

**Problem.** The "stream events → rendered transcript" fold — the rules that turn an
incremental agent event stream (`text` deltas, `tool_use_start`, `tool_streaming`,
`tool_result`, `thinking`, `permission_request`, `done`, `error`, `cancel`) into an
ordered list of message + tool bubbles with per-item status (streaming → committed,
running → ok/error) — is reimplemented in every client, with the same non-obvious rules
(commit in-flight text before opening a tool bubble; throttled delta append; match
`tool_result` to its `tool_use_start`; rebuild the same transcript from persisted
history on cold-open / back-pagination).

**Blast radius.** Every fix has to be applied in each copy; drift between copies has
already shipped render bugs. Textbook "multiplication tax" — the cost of every change is
multiplied by the number of copies, and the copies diverge over time because the truth
has no owner.

**Findings from code investigation (corrects the original inventory).**
- The duplication is **4 TS copies + iOS**, not 3: `src/tui/hooks/use_agent_loop.ts`
  (raw `StreamEvent`, in-process), `web/src/store/session-store.ts` (2793 lines; live
  `agent.*` handler ~1871–2199 **and** `parseHistoryMessages` ~671 **and** background),
  and **`web-ios/src/lib/session-store.ts` — a fourth full copy the original inventory
  missed**.
- **iOS `ChatEvent.swift` is a wire *decoder*, not the state machine** (it maps
  `agent.*` frames to a `ChatEvent` enum); iOS's actual transcript state lives elsewhere
  (`ChatClient` / `LiveSessionStore`), in Swift.
- **The wire vocabulary is already unified**: the gateway broadcasts every `StreamEvent`
  as `agent.${event.type}` (`agent-turn.ts:158`, `agent-methods.ts:773/882`); web and
  web-ios consume `agent.*`, TUI consumes the raw in-process `StreamEvent`. The semantic
  event set is the same across all clients — only a prefix and the language differ.
- The per-client **message shapes legitimately differ** (`DisplayMessage` with terminal
  fields `outputLines`/`startedAt`/`approvalReason`; `SessionMessage` with
  `backendIndex`/`images`/`documents`/pagination). So what is duplicated is the
  **transition logic**, not the message shape.
- A cross-package sharing mechanism **already exists and is in use**:
  `@hawky/protocol` is a tsconfig + vite path alias → `src/gateway/protocol.ts`, wired in
  both `web/` and `web-ios/`. A shared reducer can live in core `src/` and be aliased in
  the same way; no new package is needed.

**Design principle (non-negotiable — it decides the long-term outcome).** The reducer
must be a **zero-framework, pure, deployment-neutral core** — written as "the thing that
will later run inside the gateway", not as "part of the web store". Concretely: pure
`(state, event) → state`; no `Date.now()`/`Math.random()`/I/O/React/Zustand inside
(timestamps and ids come from the event or an injected source); depends only on the
`StreamEvent` type. This purity is what makes the eventual server-side reduction (Plan B
below) and cross-language conformance fixtures possible at all.

**Target architecture.**
- **Canonical state** = an ordered `items` list (`message | tool`, each with an id +
  status) plus an explicit streaming cursor (`streamingItemId`, `toolUseId → itemId`).
  This mirrors how all three clients already render (siblings), so selectors are ~1:1
  and migration is low-risk. (A message-with-`parts` model à la the Vercel AI SDK is the
  cleaner long-term alternative.)
- **Reducer API** in a new core module `src/transcript/`: `initialState()`,
  `reduce(state, event)` (pure; covers the whole `StreamEvent` union),
  `fromHistory(messages)` (folds synthetic events → **unifies the live and
  `parseHistory` paths through one core**), `selectFlat(state)`.
- **Deterministic ids** (subtle but required for server-portability + fixtures): derive
  ids from the wire (tool item id = `tool_use_id`; message id = turn index / backend
  index) instead of `Date.now()+random`. Optimistic user-bubble ids are minted in the
  client adapter, never in the pure core.
- **Client binding via selector**: each client keeps its own store/hook and render
  model, replaces its inline `switch(event.type)` with `state = reduce(state, event)`,
  and adds a thin `toDisplayMessage` / `toSessionMessage` selector that layers on its
  client-specific fields. All side-effects (throttled flush, `setAppBadge`, unread
  counts, pagination) stay in the client adapter — the core never touches them.
- **Home + wiring**: `src/transcript/index.ts`, exposed to web/web-ios via a new
  `@hawky/transcript` alias (same mechanism as `@hawky/protocol`); TUI imports directly.

**Plan.**

*Phase 1 — TS core + bind the three TS clients (this is the ~1–2 week deliverable; unblocks #27).*
1. Build `src/transcript/` (state, `reduce`, `fromHistory`, selector base) + full
   transition tests.
2. Bind **TUI**: replace the event `switch` with `reduce`; add `toDisplayMessage`.
3. Bind **web**: route both the live `agent.*` handler and `parseHistoryMessages` through
   the core; keep flush/badge/unread/pagination/`backendIndex` in the store adapter; add
   `toSessionMessage`.
4. Bind **web-ios** (the fourth copy) the same way.
5. Delete the four TS transition implementations once differential tests are green.
6. Emit golden fixtures (reused by Phases 2 and 3 — not throwaway).

*Phase 2 — iOS parity (extra; not in the 1–2 weeks).* Keep `ChatEvent.swift` (decoder);
add a Swift `TranscriptReducer` that must pass the **same golden fixtures**. Single
source of truth = fixtures, not code (the language wall makes literal reuse impossible;
"delete the duplicate" from fix #2 does not apply to iOS).

*Phase 3 — server-side reduction (long-term "Plan B"; separate project).* Move the
**same** `reduce` into the gateway; broadcast a canonical state snapshot on
connect/resync and deltas on live (cf. LangGraph `values`/`updates` streaming modes).
Clients degrade to `applyDelta` + render; the `parseHistory` path and the Swift reducer
can then be **deleted outright**. This turns "single source of truth" from a convention
into a structural fact (clients have no events to fold) and removes the iOS language wall
entirely — but it changes the wire protocol and reshapes #27, so it is evaluated
separately. The Phase-1 purity constraint is the only thing that keeps this door open.

**Migration safety.** Before deleting any old copy, run the new reducer in parallel and
assert (in tests over recorded real event logs, plus an optional dev-only runtime check)
that `reduce`+selector output equals the old store's output on the same event stream.
This catches drift-preserving bugs before the old code is removed.

**Testing (fix #3 is the centerpiece, not an afterthought).** (a) Transition unit tests
for every event type and the hard sequences (`text→tool_use_start` commit ordering,
out-of-order `tool_result`, error/cancel mid-stream, reconnect gaps, `fromHistory` ==
live for the same sequence). (b) Language-neutral **golden fixtures**
(`{ events, expected: state }`, cf. CommonMark's `spec.txt`: one spec, many
implementations, one conformance suite) — run by TS now, Swift in Phase 2, gateway
regression in Phase 3. (c) Differential tests (old store vs new core+selector). (d)
Web component snapshot parity.

**Risks.** (1) Teasing the pure transition out of the 2793-line, side-effect-entangled
`session-store.ts` is the real work and the main estimate risk — mitigate by extracting
only the transition and leaving side-effects in the adapter, guarded by differential
tests. (2) Deterministic ids replace `Date.now()+random`. (3) A copy's existing drift may
be depended on by its UI — reconcile via differential tests. (4) `web` and `web-ios` may
have diverged; unifying them onto one reducer surfaces the difference (fix it or push it
into the selector). (5) Per-client throttling stays in the adapter, never in the core.

**Definition of done (Phase 1).** `src/transcript/` is a pure, zero-framework module,
tsc-clean, with full transition-test coverage of the event union; TUI/web/web-ios all
consume it with their inline `switch` transitions deleted and rendering unchanged
(differential + snapshot green); golden fixtures committed and Swift-ready; **#27 is
unblocked**.

**References to steal from.** Vercel AI SDK (`UIMessage.parts` + the framework-agnostic
fold with per-framework bindings); matrix-js-sdk (timeline that merges live `/sync` with
paginated `/messages` — the exact live+history unification problem); Redux Toolkit
(`EntityAdapter` + the pure-core / side-effects-in-middleware discipline); LangGraph
(state + reducer, and `values`/`updates`/`messages` streaming modes for Phase 3);
libsignal / Automerge (Rust core shared across iOS/web via UniFFI/WASM — the ceiling
option that replaces "fixtures + Swift port" with "one compiled core everywhere").

**Effort.** Phase 1 ~1.5–2.5 weeks (reducer + tests ~2–3d; three client bindings +
selectors + differential tests + deletion ~2d each; the untangling of `session-store.ts`
side-effects is the swing factor). Phase 2 (iOS) ~1 week. Phase 3 multi-week, separate.
**Dependencies:** none upstream; prerequisite for #27.

### #16 — Collapse the four byte-identical lib files and fix the socket-store drift

**Problem.** `ws-client`, `byok`, `client-id`, and `media` are byte-for-byte identical
between `web` and `web-ios`, and the socket-store has already drifted (inconsistent
token clearing).

**Blast radius.** Every lib fix must be copied to both trees, and the two copies are
already diverging — one such divergence shipped a bug.

**Fix.**
1. Move the four files into a single shared package (Bun workspace).
2. Fix the socket-store token-clearing inconsistency and unify the behavior.
3. Add tests that lock down the shared behavior.

**Effort:** ~1–2 weeks. **Dependencies:** none; prerequisite for #31.

### #17 — Fix the lossy MCP tool-bridge schema conversion

**Problem.** `tool-bridge.ts:53-64` rebuilds tool schemas and, in doing so, drops
`items`, nested objects, and `anyOf`.

**Blast radius.** Any MCP tool with array/nested/union types is corrupted and may
behave wrongly or fail to be called correctly, limiting how much of the MCP ecosystem
is actually usable through hawky.

**Fix.**
1. Pass the original JSON Schema through untouched instead of reconstructing it.
2. Add a test asserting a schema with `items`/nested/`anyOf` survives the bridge intact.

**Effort:** ~2–3 days. **Dependencies:** none.

### #18 — Rewrite `McpServerManager`

**Problem.** Its header comment promises reconnect-on-crash and health monitoring;
neither exists. When a stdio server dies, every bridged tool fails until the gateway
restarts, while `getAllStates()` still reports `connected`. It also supports only the
deprecated SSE transport, with no streamable-HTTP. This is an abstraction that lies.

**Blast radius.** MCP servers silently stop working after a crash, with a misreported
state that makes it hard to diagnose; and servers that only offer streamable-HTTP
can't be connected at all.

**Fix.**
1. Implement real reconnect (crash detection + backoff).
2. Implement real health monitoring so `getAllStates()` reflects reality.
3. Add a streamable-HTTP transport.
4. Add crash/reconnect integration tests.

**Effort:** ~1–2 weeks. **Dependencies:** none.

### #19 — Consolidate the scattered duplicate helpers

**Problem.** `classifyError` (~70 lines duplicated across the Anthropic and OpenAI
providers), session-key conversion (×3), `formatDate` (×2), tool-preview formatting
(×4), and the slash-command system (×2).

**Blast radius.** Each has to be kept in sync by hand and tends to diverge into
inconsistent behavior. Low-risk, high-clarity — the ideal batch for new contributors.

**Fix.**
1. Extract each into a single shared implementation and replace all call sites.
2. Add tests covering the merged behavior.
3. Split into several small independent PRs to parallelize / hand to outside
   contributors.

**Effort:** ~1 week (splits into several 0.5–1 day items). **Dependencies:** none.

## P2 / P3 — Dead code and quality infrastructure

Lower urgency, but this is where the project's long-term health and contributor
experience live — no linter, flaky tests hidden behind retries, and dead code that
misleads every reader.

### #20 — Collapse provider quirks into a `ProviderCapabilities` descriptor

**Problem.** The OpenAI provider sends `max_tokens` where newer models require
`max_completion_tokens`, has no reasoning support, and counts tokens as `chars/4`; a
document block makes any PDF-bearing session fail permanently after a provider switch.

**Blast radius.** New OpenAI models get the wrong parameter, reasoning is unavailable,
token accounting is inaccurate, and switching providers breaks any PDF-bearing session.

**Fix.**
1. Define a `ProviderCapabilities` descriptor (max-tokens field name, reasoning
   support, token-counting strategy, document-block support, …).
2. Have each provider declare its capabilities; call sites branch on the descriptor
   instead of inline patches.
3. Add tests for provider switching and PDF-bearing sessions.

**Effort:** ~1 week. **Dependencies:** related to #21.

### #21 — Establish one source of truth for the model registry

**Problem.** Three registries (`context-window`, `openai-models`, `cost-tracker`) are
maintained separately and drift.

**Blast radius.** Context window, available-model list, and cost data can contradict
each other, causing pricing / truncation / model-selection errors.

**Fix.**
1. Design one registry (context window, cost, provider, capability flags).
2. Point all three consumers at it.
3. Add a test ensuring a new model only needs to be added in one place.

**Effort:** ~3–5 days. **Dependencies:** related to #20.

### #22 — Delete dead code and empty stubs

**Problem.** The iOS `OpenAIRealtimeLiveSessionProvider` (~830 lines) plus its dead
hook wiring, and four empty stubs (`prepaint.ts`, `staticBaseline`, `decideDelivery`,
`transcript-relay.ts`, `src/services/`).

**Blast radius.** Dead providers and empty stubs mislead readers into thinking
functionality exists, add search noise, and carry maintenance weight.

**Fix.**
1. Confirm no live references, then delete the dead provider and its wiring.
2. Delete or explicitly mark the four empty stubs.
3. Run the full test suite and a build to confirm no dangling references. (The
   ~5,000-line iOS demo/lab stores are handled separately under #28.)

**Effort:** ~2–4 days. **Dependencies:** overlaps #28 and #29 (`decideDelivery` belongs
to the delivery layer).

### #23 — Add lint/format and a real CI matrix

**Problem.** 64k LOC of TypeScript, 41.5k of Swift, and the Python sidecar have no
linter or formatter at all. CI also does not actually run the iOS, web-ios, or pytest
suites — they gate nothing today.

**Blast radius.** Style and low-level errors are never caught automatically, and
iOS/web-ios/python regressions can merge without CI stopping them.

**Fix.**
1. Introduce biome (TS) + ruff (Python) + SwiftLint, report-only first, then blocking.
2. Add a CI job matrix: core / web / web-ios / python sidecar / iOS (macOS runner
   running `xcodegen && xcodebuild test`).
3. Pin the bun version and use `--frozen-lockfile`.

**Effort:** ~3–5 days. **Dependencies:** pair with #24 so the new CI jobs aren't
permanently red.

### #24 — Kill the flaky tests and the `--retry` mask

**Problem.** ~20 `Bun.sleep(10)` race tests and `Math.random()` port selection are
currently hidden behind `--retry=2`. Meta-tests use string-grep
(`test-release-packaging.ts`) rather than real behavior.

**Blast radius.** `--retry` lets real races pass intermittently and masks bugs;
string-grep meta-tests give false confidence.

**Fix.**
1. Replace `Bun.sleep` with deterministic waits (event / polled condition).
2. Reserve or dynamically acquire ports to avoid collisions.
3. Remove `--retry=2`.
4. Replace `test-release-packaging` string-grep with a real `npm pack --dry-run`.

**Effort:** ~3–5 days. **Dependencies:** best done with #23 so the new CI is stable.

### #25 — Pay down the retrieval/memory performance debt

**Problem.** Embeddings stored as JSON text force an O(corpus) parse; FTS uses strict
AND with no stemming and is broken for CJK; `listSessions` is O(all bytes); the
deepface sidecar rewrites its entire JSON store and scans O(N×M).

**Blast radius.** As the corpus / sessions / face DB grow, latency rises linearly or
worse; CJK users get poor retrieval quality.

**Fix.**
1. Store embeddings in a binary/columnar form to avoid full parses (sqlite-vec is
   blocked by `bun:sqlite`, so gate that behind the Bun-isolation work).
2. Add stemming to FTS, fix CJK tokenization, relax the strict AND.
3. Make `listSessions` index/paginate instead of reading all bytes.
4. Change the deepface sidecar to incremental writes + indexed lookup. Splits into
   several independent sub-items.

**Effort:** ~2 weeks+ (staged). **Dependencies:** sqlite-vec portion depends on Bun API
isolation; same subsystem as #12.

## 🔨 Major overhauls (rewrite candidates, high effort)

Section §9 of the audit argues these are past the point of patching. Kept as
separate, explicitly high-effort items (weeks-to-a-month each) so they don't masquerade
as quick fixes. Sequence them after the P0/P1 work — several are unblocked by the P1
extractions above.

### #34 — Rewrite `tool_executor.ts` into an ordered policy pipeline

**Problem.** 1,467 lines holding the permission cache, pattern rules, static allowlist,
curl/find analyzers, path containment, mode logic, and a three-stage executor — with
the final approval decision emerging from five entangled booleans and two near-identical
headless floors. The file is thick with `Codex round 2/7/8/9/12 P1/P2` comments: it
wasn't designed, it was beaten into shape by twelve rounds of adversarial review.

**Blast radius.** Every change to permission behavior is high-risk, effectively only
e2e-testable, and prone to regression; the headless trust-boundary problem (#5) lives
here.

**Fix.**
1. One ordered policy pipeline — deny > ask > explicit-allow > safe-static > prompt —
   returning a single typed decision.
2. Split the command policy (bash/curl/find analyzers) into its own module.
3. Run headless through the same pipeline plus per-lane grants (this is the root fix
   that #5 stopgaps).
4. Unit-test each policy branch, removing the reliance on e2e.

**Effort:** ~weeks to a month. **Dependencies:** absorbs #5 (sequential, not blocking).
§9 overhaul.

### #27 — Rewrite web `session-store.ts` into a per-session reducer

**Problem.** 2,793 lines in which module-level mutable globals (labeled "Legacy
aliases") coexist with a per-session Map, and `switchSession` copies data between them
by hand — miss one copy and you get cross-session stream contamination. Two ~350-line
active/background state machines have already drifted and shipped a bug; the tool-status
reclassifier is on its third generation of rules, each broken in its own way. The file
is fighting itself.

**Blast radius.** The session-switch data contamination is a hard-to-reproduce,
high-severity bug class; every change has to reckon with both the globals and the
per-session state.

**Fix.**
1. Move to a per-session state slice behind a single reducer; `active` is just a
   pointer; delete the module-level globals.
2. Move parsing/formatting out of the store.
3. Collapse the three generations of tool-status rules into one.
4. Add a test proving session switching does not contaminate.

**Effort:** ~weeks. **Dependencies:** blocked by #15 (extract the shared stream-event
machine first). §9 overhaul.

### #28 — Break up iOS `LiveSessionStore.swift` and evict the demo/lab stores

**Problem.** A 4,905-line, 251-method god object owning fifteen unrelated concerns
(phase machine, transcript, Live Activity, widget, CoreLocation, cocktail party,
recording, interruption recovery, persistence) — the core state machine is effectively
only e2e-testable, and every new feature is poured in here. Separately, ~5,000 lines of
demo/lab stores (duplicated mic-pump logic, plaintext keys, `asyncAfter` timing hacks)
appear in the production app's Settings/tabs.

**Blast radius.** The single point of failure for the iOS app: high change risk, hard
to test; and experimental code (including plaintext keys) ships to users.

**Fix.**
1. Split into session-lifecycle, transcript store, diagnostics, an ambient/region
   coordinator, and an activity coordinator.
2. In the same pass, evict the demo/lab stores from the production target (dev-only
   target or deleted).
3. Add unit tests for each extracted concern.

**Effort:** ~weeks to a month. **Dependencies:** relates to #6 (plaintext key) and #33
(transport). §9 overhaul.

### #29 — Implement or delete the ambient delivery layer

**Problem.** In `delivery.ts` / `delivery-gate.ts` / `modes.ts`: `decideDelivery` is
dead code, `scoreDelivery` is a constant stub, the only meaningful branch (directive) is
unreachable in every production path (`intention-service.ts:194` passes
`scoreCtx: undefined`), and three modes collapse to one boolean. Three layers of
abstraction around a boolean are worse than the boolean — this is architecture theater.

**Blast radius.** The delivery-mode differentiation (proactive delivery strategy) is
currently fake; maintainers are misled into thinking a capability layer exists. It
directly bears on the product differentiator (latent-engine maturity).

**Fix (pick one — no middle state allowed).**
- (A) Wire `ScoreContext` through `IntentionService`/`LatentService` so mode/context
  genuinely affect delivery; or
- (B) Delete the `delivery-gate`/`modes` layers and keep one honest boolean.
- Decide first whether ambient v2 needs mode semantics.

**Effort:** ~1–2 weeks (the delete path is shorter). **Dependencies:** related to #30
and the ambient-v2 plan in `strategy-2026-07.md`. §9 overhaul.

### #30 — Replace the latent-recognizer regex and the hand-rolled time parser

**Problem A.** The latent recognizer mints intentions with an LLM but destroys them
with a stop-word-grade regex (the satisfaction sweep) — risk inverted, with the fragile
side holding the irreversible delete power (see #11).

**Problem B.** `when-resolver.ts` is 308 lines of hand-rolled bilingual time regex with
a known DST day-roll bug, no support for noon/tonight/in-2-days, feeding a scheduler
that overflows (#11), and no recurrence. The realtime model can already emit ISO — there
is no payoff to hand-rolling this.

**Blast radius.** Genuine needs get falsely deleted; natural-language time parsing is
unreliable and there is no recurring-reminder support.

**Fix.**
1. Fold satisfaction into the per-tick model call that already runs; demote the regex to
   a candidate filter or delete it.
2. Tighten the tool contract to ISO-or-clarify, or adopt a recurrence library (which
   also resolves #11's overflow and missing recurrence).
3. Add tests for time parsing and for satisfaction.

**Effort:** ~1–2 weeks. **Dependencies:** related to #11 and #29. §9 overhaul.

### #31 — Fold web-ios into web/ behind a platform flag

**Problem.** Four byte-identical lib files, 90% dependency overlap, two `bun.lock`s, two
`node_modules` — it is a responsive style variant, not a separate product.

**Blast radius.** Every web change has to be made twice and the dependency trees drift
independently — one of the largest sources of the multiplication tax.

**Fix.**
1. Fold web-ios into web/ behind a platform flag (or build target / CSS variant) for the
   iOS flavor.
2. Remove the duplicate lockfile and `node_modules`.
3. Verify the critical paths (realtime, chat) work in both flavors.

**Effort:** ~1–2 weeks. **Dependencies:** blocked by #16 (collapse the four shared libs
first). §9 overhaul.

### #32 — Replace the hand-rolled `frontmatter.ts` YAML parser

**Problem.** It forces a "JSON-string-in-YAML metadata" convention only its own parser
understands, breaks on CRLF, and forecloses compatibility with the standard Agent-Skills
`SKILL.md` format — self-defeating when the skills ecosystem is the growth engine.

**Blast radius.** Outside authors can't write skills with standard tooling/format; CRLF
files corrupt; ecosystem growth is throttled.

**Fix.**
1. Parse frontmatter with a standard YAML library.
2. Support the standard `SKILL.md` format (drop the JSON-in-YAML convention; provide a
   migration).
3. Fix CRLF handling.
4. Add regression tests over existing skills plus a standard-`SKILL.md` example.

**Effort:** ~1 week. **Dependencies:** none; prerequisite for the skills-ecosystem plan
in `strategy-2026-07.md`. §9 overhaul.

### #33 — Fix `ReconnectingTransport.swift` so it actually reconnects

**Problem.** Despite the name it only retries the initial connection; when the socket
dies mid-stream the pump exits silently and reconnection is pushed onto every caller
(NodeRunner even reimplements its own backoff). This guards the app's most important
link.

**Blast radius.** Mid-stream disconnects fail silently, recovery behavior is scattered
and inconsistent — hard-to-debug realtime dropouts.

**Fix.**
1. Make the transport actually reconnect on mid-stream disconnect (detect pump exit +
   backoff), or
2. Rename it honestly and unify reconnection into a single backoff implementation,
   removing NodeRunner's duplicate.
3. Add a mid-stream-disconnect → auto-recovery test.

**Effort:** ~1 week. **Dependencies:** relates to #28 (iOS breakup). §9 overhaul.

## Suggested order

Clear #9–#14 first (P0, day-sized, mutually independent, and actively buggy), then
#5/#6/#7 (security/trust), then #15/#16 (P1, which also unblock the #27/#31
rewrites). Save the major overhauls for last.

---

# hawky Ambient Agent Development Plans

Status review: 2026-07-02. This file stacks three living plans, newest first:

1. **Identity, Person Memory, And Face Service Refactor Plan** (2026-06-28) —
   the active engineering plan. PRs 1, 2, and 4 have shipped since it was
   written; the rethink inside makes PR 3 (review ledger) the critical path.
2. **Live Mode Architecture Stabilization Plan** (2026-06-22) — phases 1-4
   done; phases 5-6 (LiveRuntimeSession, LiveBridgeSession) still open.
3. **Frontier Ambient Agent Plan** (2026-06-21) — the long-horizon strategy,
   core data model, voiceprint research, and invention portfolio. The ideas
   stand; per-item status notes were added 2026-07-02.

Naming note: earlier drafts used the codenames "HaoClaw" (core + gateway) and
"jundaclaw" (iOS client). The project is now **hawky**; where old names
survive in prose below, read "HaoClaw" as the hawky core/gateway and
"jundaclaw" as the hawky iOS app.

---

# Identity, Person Memory, And Face Service Refactor Plan

Date: 2026-06-28

This replaces the earlier top-of-file handoff/name-cleanup notes with the
implementation plan for making face recognition, person memory, voiceprint, and
memory distillation share one identity architecture.

## Current Status

Status refresh: 2026-07-02, verified against code on `origin/main` (`dc30c01`)
and `rich-localbuild` (15 commits ahead, 0 behind). Since this plan was
written, PR 1 (durable TS person store) shipped and is on `origin/main`;
PR 2 (face tools emit face-index signals, `fbb8e2f`) and PR 4
(`MemoryCandidate` + bounded person snapshot, `89d76ab`) shipped on
`rich-localbuild`; and the PR 5 voiceprint foundation (~10k lines plus five
`identity.voiceprint.*` gateway RPCs) is on `rich-localbuild`. PR 3 (review
ledger), PR 6 (physical face split), and PR 7 (cross-modal linking) are not
started. Landing `rich-localbuild` on `main` is now step zero of this plan.

What is already in place:

- `src/identity/core/*`
  - `IdentitySignalBase`, `IdentitySubject`, `EvidenceRef`,
    `SourceSessionRef`, `ReviewRecord`, allowed-use policy, and schema fixtures
    exist.
  - Policy tests cover fail-closed behavior for unreviewed/non-owner identity
    signals.

- `src/identity/person/*`
  - `PersonProfile`, `PersonFact`, `PersonRecap`, `IdentityCandidate`, and
    `FaceIdentitySignal` contracts exist.
  - Legacy DeepFace profiles are normalized into structured person records or
    identity candidates.
  - `PersonService` now sits in front of the legacy DeepFace repository.
  - Legacy `Unknown` matches become `IdentityCandidate` records, not durable
    person profiles.
  - `confirm_candidate` promotes a candidate only after explicit review.
  - `reject_candidate` suppresses a candidate so stale ids cannot re-enroll or
    update it later.
  - `people.list` delegates through `PersonService`, so user-visible lists use
    the same candidate filtering as `person.*`.

- iOS and web-ios person tooling
  - Model-facing tools are aligned around `identify_person`, `list_people`,
    `recall_person`, `update_person_profile`,
    `confirm_identity_candidate`, and `reject_identity_candidate`.
  - Raw `face_*` tools still exist as private/backend compatibility tools, but
    Cocktail Party model instructions no longer make those the primary person
    contract.

- `src/identity/voiceprint/*`
  - Voiceprint has contracts, quality gates, threshold policy, template storage,
    sidecar protocol, sidecar runner, turn scoring, storage bundles, transcript
    state, and tests.
  - Gateway RPCs exist for `identity.voiceprint.realtime_event`,
    `identity.voiceprint.realtime_reset`,
    `identity.voiceprint.audio_artifact.register`,
    `identity.voiceprint.score_turns`, and
    `identity.voiceprint.apply_bundle`.
  - iOS can serialize Realtime transcript/audio-artifact events to the gateway
    behind the disabled-by-default `voiceprintRealtimeEnabled` flag.

- `src/memory/*`
  - Session-end and scheduled memory distillation exist.
  - Done on `rich-localbuild` (`89d76ab`): distillation reads a bounded
    `PersonSnapshot` (`src/memory/person-snapshot.ts`), and person-derived
    facts become `MemoryCandidate` records (`src/memory/candidate.ts`) with
    quarantine reasons (`unconfirmed_identity_candidate`,
    `unreviewed_identity_signal`, `policy_unavailable`) instead of durable
    memory. `memory.snapshot` / `memory.distill` gateway RPCs exist.

What is still not done:

- Review ledger (PR 3): there is no review UI anywhere. `web/` and `web-ios/`
  do not render identity candidates, quarantined memory candidates, or
  voiceprint review records; review currently happens only through the
  model-facing tools (`confirm_identity_candidate` /
  `reject_identity_candidate`) — i.e. by talking to the agent.
- DeepFace still owns the physical face embedding index inside
  `services/deepface/app.py` (acceptable short term; profile facts/recaps are
  no longer canonical there).
- Voiceprint is not yet an owner-facing product feature: there is no owner
  enrollment UI, no user-facing encrypted owner-template setup flow, and no
  reviewed bridge from voiceprint tags into person/memory policy. The
  `voiceprintRealtimeEnabled` flag stays off.
- Cross-modal linking is not implemented. Face candidates, voice clusters, and
  heard-name candidates cannot yet be reviewed into one person capsule.
- The 15 `rich-localbuild` commits (face signals, memory gating, voiceprint
  foundation, provider + iOS media work) are not on `origin/main` yet.

The rethink (2026-07-02): the quarantine side of this plan landed faster than
the review side. The system now has three quarantine stores — identity
candidates, memory candidates, and voiceprint review records — and zero
surfaces to review them. Quarantine without review is a write-only database:
it protects the user but delivers no visible value and builds no trust. The
next phase should therefore not add more recognition ability or more signal
producers. It should make the identity signal -> review -> person capsule ->
memory candidate -> durable memory path visible and operable. PR 3 is the
next best PR, ahead of everything else in this plan.

## Target Shape

The identity system should have four durable concepts:

1. `IdentitySignal`
   - A single identity clue from a source.
   - Sources include face match, voiceprint match, manual introduction, heard
     name, device/owner context, or future contact/social hints.
   - Carries source, evidence, confidence, thresholds, model metadata, source
     session, allowed uses, review state, retention, and sensitivity.

2. `IdentityCandidate`
   - A quarantined possible identity that is not yet a confirmed person.
   - Used for unknown faces, non-owner voice clusters, low-confidence matches,
     heard names, and "this might be X" claims.
   - May expire, be suppressed, be merged, or be promoted after review/user
     confirmation.

3. `PersonProfile`
   - A confirmed or user-accepted person capsule.
   - Owns canonical name, aliases, linked candidates/signals, face template refs,
     voice cluster refs, structured facts, recaps, review state, and deletion
     tombstones.
   - Should not be created automatically from every unknown biometric signal.

4. `PersonFact`
   - A fact about a person, not the owner memory store.
   - Structured fields:
     - `id`
     - `person_id`
     - `text`
     - `evidence_refs`
     - `evidence_text`
     - `confidence`
     - `source_session`
     - `source_kind`
     - `created_at`
     - `created_by`
     - `status`
     - `supersedes`
     - `expires_at`
   - Initial statuses: `confirmed`, `candidate`, `legacy_unverified`,
     `rejected`, `superseded`.

The user-facing rule is simple: signals are not people, candidates are not
profiles, and facts are not durable unless their source is inspectable.

## Service Ownership

Do not start by physically splitting deployment. First split responsibility in
code and contracts; split processes only after the APIs are stable.

Target ownership:

- `identity-core`
  - Shared TypeScript contracts and policy primitives.
  - No voiceprint or face implementation dependency.
  - Used by voiceprint, person service, face service, prompt tests, and gateway
    RPC schemas.

- `person-store/service`
  - Owns `PersonProfile`, `IdentityCandidate`, `PersonFact`, recaps, candidate
    promotion, merge/suppress/delete, and person-facing RPCs.
  - Is the source of truth for people.
  - Can store references to face/voice artifacts, but should not run biometric
    embedding models itself in the first pass.

- `face-service`
  - Owns face detection, quality gate, crop handling, embedding extraction, and
    similarity scoring.
  - Should return face identity signals or embedding/match candidates, not mutate
    person facts.
  - Short term: it may still maintain the embedding index while person-service
    owns profile/fact writes.
  - Long term: it becomes stateless or index-only; person-service controls all
    profile lifecycle decisions.

- `voiceprint`
  - Owns voice scoring, owner/non-owner cluster signals, transcript speaker tags,
    and audio-template storage.
  - In the current local branch it has a live scoring foundation, but it should
    stay owner-first until enrollment, consent, retention, and review UX are
    explicit.

- `memory-distill`
  - Reads transcript and bounded person snapshots.
  - Can summarize person context into daily logs, but cannot become the canonical
    person database.

## Next Development Plan

The smoother dependency order is not "face, then memory, then voiceprint" by
modality. It is:

1. Establish the person source of truth. (done)
2. Force biometric providers to emit signals, not person facts. (done)
3. Make review and ledger state visible enough to operate. (next — the
   critical path)
4. Let memory consume only bounded, reviewed snapshots. (done)
5. Let voiceprint add owner/session signals through the same policy gate.
   (foundation done; owner enrollment/consent UX open)
6. Add cross-modal linking only after bad links can be reviewed and undone.
   (not started)

Steps 4 and 5's foundations completed out of order relative to 3, which is
exactly why 3 is now the bottleneck: reviewable state accumulated faster than
the ability to review it.

### PR 1: Durable TypeScript Person Store

Status: DONE — shipped to `origin/main`. `src/identity/person/store.ts`,
`migration.ts`, and `tombstone.ts` exist; the store uses separate JSON files
(`people.json`, `person-facts.json`, `person-recaps.json`,
`person-candidates.json`, `person-tombstones.json`) with atomic writes;
`PersonService` treats the TS store as canonical and imports legacy DeepFace
profiles on read. The section below is kept as the original spec.

The current PersonService boundary is correct, but its
canonical data still comes from `services/deepface/facedb/profiles.json`.

Goal:

- Make TypeScript own confirmed people, person facts, recaps, candidate review
  records, tombstones, and merge metadata.
- Keep DeepFace as a legacy face embedding/index source during the migration.

Files to add or extend:

- `src/identity/person/store.ts`
- `src/identity/person/migration.ts`
- `src/identity/person/tombstone.ts`
- `tests/test-person-store.ts`
- `tests/test-person-store-migration.ts`

Store shape:

- `people.json`
- `person-facts.json`
- `person-recaps.json`
- `person-candidates.json` using or migrating the existing
  `FilePersonCandidateReviewStore`
- `person-tombstones.json`

Rules:

- `PersonProfile` is created only by explicit user confirmation/import/manual
  action, not by raw face/voice signal.
- `PersonFact` must carry confidence plus evidence refs or source session.
- Facts from legacy DeepFace load as `legacy_unverified`; they are displayable
  but not memory-promotable until reviewed.
- Rejected/suppressed/deleted ids must remain tombstoned so a stale DeepFace id
  cannot recreate the person later.
- `confirm_candidate` can promote into a TS `PersonProfile`; DeepFace profile
  rename becomes a compatibility side effect, not the source of truth.

Acceptance:

- `person.list`, `person.recall`, `person.update_profile`,
  `person.confirm_candidate`, and `person.reject_candidate` work without treating
  DeepFace profile JSON as canonical.
- Existing DeepFace profiles can be migrated or viewed through a legacy adapter.
- A rejected candidate cannot be updated through direct id, frame match, or stale
  legacy profile id.
- Tests cover file atomicity, migration, tombstones, and review-state gates.

Implementation order inside PR 1:

1. Add a `PersonStore` interface plus a file-backed implementation.
2. Load legacy DeepFace profiles through a migration/import adapter, but keep
   TS records authoritative after import.
3. Move `PersonService.listPeople` and `recallPerson` to read the TS store first,
   falling back to legacy data only for unmigrated installs.
4. Move `updateProfile` fact/recap writes into TS `PersonFact` and `PersonRecap`
   records with source session/evidence metadata.
5. Move `confirmCandidate` promotion into TS `PersonProfile`; keep DeepFace
   rename/enroll only as a compatibility side effect.
6. Make rejected/suppressed/deleted candidates and profiles leave tombstones
   that all update/enroll paths check.

### PR 2: Gateway Face Adapter And Person-Service Cutover

Status: DONE on `rich-localbuild` (`fbb8e2f`) — model-facing face tools return
face-index signals, person mutations route through `person.*`, and raw
`face_*` tools are compatibility-only across iOS, web, and web-ios. The
physical `/face/*` endpoint contract stays deferred to PR 6.

Do this after PR 1, because person ownership must be clear before the face path
can stop behaving like a person database.

Goal:

- Make the gateway/person path treat face recognition as a signal provider.
- Keep the current Python service and legacy endpoints working short term.
- Route model-facing person tools through `PersonService`, not raw `face_*`
  facts/recaps.
- Stop new user-facing flows from depending on DeepFace profile facts.

New TypeScript boundary:

- `FaceSignalProvider.identifyFrame`
- `FaceSignalProvider.matchEmbedding`
- `FaceSignalProvider.enrollOrLinkTemplate`

The first implementation can wrap existing `/identify` and `/enroll` responses.
It does not need a Python service rewrite yet.

Target face-service contract for the later physical split:

- `/face/quality`
- `/face/embed`
- `/face/match`
- `/face/signal`

Preferred response shape:

```json
{
  "ok": true,
  "signal": {
    "type": "face_match",
    "confidence": 0.84,
    "threshold_used": 0.62,
    "source_session": "realtime:...",
    "evidence_refs": [{"type": "frame", "id": "..."}],
    "metadata": {
      "det_score": 0.93,
      "bbox": [0, 0, 120, 120],
      "pose": "...",
      "model": "insightface/buffalo_l"
    }
  },
  "matches": [
    {"person_id": "person_...", "similarity": 0.84}
  ]
}
```

Compatibility:

- Keep `/identify`, `/enroll`, `/update`, `/people`, and `/clear` until iOS and
  web-ios no longer call raw `face_*` tools.
- Internally treat `/update` as deprecated and route person facts through
  `person.*`.
- If a legacy raw `face_update` call still reaches Python, treat that as
  compatibility debt and do not expose it in model-facing prompts.

Acceptance:

- Face service can be tested without any person facts.
- Person service can be tested with fake face signals.
- A face match returns signal/match metadata; person-service decides candidate vs
  confirmed person vs suppressed result.
- Raw `face_*` tools are private compatibility tools, not model-facing person
  tools.
- No current user-facing iOS/web-ios path requires DeepFace facts as canonical
  person data.

### PR 3: Review Ledger Foundation

Status: NOT STARTED — now the next best PR (see the rethink in Current
Status). The warning below already came true: memory and voiceprint consumers
shipped first, so reviewable state now exceeds what users can inspect. Scope
grew accordingly: the ledger must cover identity candidates, person facts,
quarantined memory candidates, and voiceprint review records in one surface,
reusing the existing service mutations (`PersonService`,
`applyVoiceprintReviewDecision`, memory candidate store) rather than adding
new ones. Build the gateway `review.*` RPCs first so the ledger stays
drivable headlessly, then the `web/` view, then web-ios/iOS.

Do this before turning on new memory or voiceprint consumers. Otherwise the
system will create more reviewable state than users can inspect.

Goal:

- Make identity state operable, not just encoded in schemas.
- Provide a ledger for confirmed people, identity candidates, person facts,
  tombstones, and memory candidates once they arrive.
- Add the minimal review actions needed before memory/voiceprint start producing
  more signals.

Surfaces:

- People list with confirmed profiles and candidates separated.
- Candidate detail with evidence, confidence, source session, modality, and
  actions.
- Fact detail with evidence and delete/supersede controls.
- Tombstone/suppression behavior visible enough for debugging.

Actions:

- Confirm person.
- Rename person.
- Merge candidate into person.
- Keep candidate separate.
- Reject candidate.
- Suppress future resurfacing.
- Delete profile and linked facts/signals according to retention policy.

Acceptance:

- User can correct a bad identity without editing raw files.
- Deleting a person removes profile links and facts, and creates a tombstone.
- Rejected/suppressed candidates do not keep influencing tools or memory.
- The UI can show "why this candidate exists" from evidence/session metadata.

### PR 4: MemoryCandidate And Bounded Person Snapshot

Status: DONE on `rich-localbuild` (`89d76ab`) — `src/memory/candidate.ts`,
`src/memory/person-snapshot.ts`, distill gating, `memory.snapshot` /
`memory.distill` RPCs, and tests (`test-memory-candidate`,
`test-person-memory-snapshot`, `test-memory-distill`, `e2e-memory-distill`)
all exist. Candidate review/promotion actions await the PR 3 ledger.

Memory is the next user-visible safety boundary. It should not read the full
person database, and it should not promote unreviewed identity facts.

Goal:

- Add a session-bounded `PersonSnapshot`.
- Add `MemoryCandidate` records for facts proposed by distillation.
- Keep unconfirmed candidate facts quarantined.

Snapshot contains only:

- People/candidates touched in the session.
- Reviewed person facts visible to this session.
- Identity signals emitted in this session.
- Candidate promotions/rejections in this session.
- Voiceprint owner-speaking tags when policy allows session tagging.

Distill behavior:

- Daily log may summarize reviewed person context.
- `MEMORY.md` must not become a second person database.
- Tool results alone are not durable memory.
- Any person fact inferred from transcript becomes a `MemoryCandidate` or
  `PersonFact` candidate with evidence, not immediate durable memory.

Files to add or extend:

- `src/memory/candidate.ts`
- `src/memory/person-snapshot.ts`
- `src/memory/distill.ts`
- `src/gateway/memory-methods.ts`
- `tests/test-memory-person-snapshot.ts`
- `tests/test-memory-candidate.ts`

Acceptance:

- Distillation prompt receives transcript plus bounded person snapshot.
- Unreviewed identity candidates never reach durable memory.
- Confirmed/reviewed person facts can be referenced without duplicating the
  canonical person store.
- Memory candidates have review/delete/suppress-ready metadata.
- If the review ledger is unavailable, memory candidates remain quarantined and
  cannot auto-promote.

### PR 5: Voiceprint Owner MVP

Status: foundation DONE on `rich-localbuild` (scoring plan/queue/turn tracker,
sidecar protocol + runner, encrypted owner-template envelope, template store,
review primitives, five `identity.voiceprint.*` gateway RPCs, iOS realtime
event serialization behind the off-by-default `voiceprintRealtimeEnabled`
flag). What remains is the product half below: the iOS enrollment UI,
biometric consent UX, template lifecycle (rotate/delete with tombstones), and
the reviewed bridge from owner tags into person/memory policy. This work has
moved from research to productization — see the voiceprint section of the
frontier plan for the detailed status.

Voiceprint should stay owner-first. Do not try to name arbitrary speakers yet.

Goal:

- Add owner enrollment and encrypted local owner template setup.
- Enable post-turn owner-speaking tags when consent and confidence allow it.
- Keep non-owner voices anonymous clusters/candidates.

Implementation:

- iOS enrollment UI records enough clean owner speech locally.
- Gateway stores encrypted owner template refs and scoring config.
- `voiceprintRealtimeEnabled` remains off unless enrollment + consent are ready.
- Owner voice can tag a session and help action/memory gates only when policy
  permits.
- Non-owner results remain `unknown_cluster` or `unknown_speaker`.
- Heard names can propose person/relationship candidates, but must not
  auto-name a speaker.

Acceptance:

- Owner enrollment can be created, loaded, deleted, and rotated.
- `identity.voiceprint.score_turns` produces owner tags using the enrolled
  template.
- No voiceprint result writes durable memory directly.
- Tests cover consent false, low quality, low confidence, missing template, and
  owner match success.

### PR 6: Physical Face Service Split

Status: NOT STARTED. `services/deepface/app.py` still exposes only the legacy
endpoints (`/identify`, `/enroll`, `/update`, `/people`, `/clear`,
`/assess_hazard`); no `/face/quality|embed|match|signal` yet. Still correctly
sequenced after PR 3. Open sub-question: whether `/assess_hazard` belongs in
the face service at all after the split, or moves to a separate vision tool.

Do this after the gateway/person boundary is already proven. This is a cleanup
and performance/deployment PR, not the first correctness PR.

Goal:

- Rename or wrap `services/deepface` as an index-only face service.
- Add `/face/quality`, `/face/embed`, `/face/match`, and `/face/signal`.
- Stop Python from owning facts/recaps.
- Stop `/identify` from mutating embeddings on every match unless an explicit
  template-update policy allows it.

Acceptance:

- Python face service can be tested without person facts.
- Gateway person service owns all person/fact writes.
- Legacy endpoints remain only as compatibility wrappers or are removed after
  clients migrate.

### PR 7: Cross-Modal Person Linking

Status: NOT STARTED. Blocked on PR 3 by design.

Do this only after the review UI exists.

Goal:

- Link face candidates, voice clusters, heard-name candidates, and manual
  introductions into one person capsule through explicit review.

Rules:

- Face and voiceprint remain signal providers.
- Person service remains the identity owner.
- Memory reads only policy-approved person snapshots and memory candidates.
- "Kevin's face + Kevin's voice + heard Kevin in transcript" is a merge
  suggestion, not an automatic merge.

Acceptance:

- Candidate linking suggestions are inspectable.
- Merge/reject/suppress/delete leave an audit trail.
- A bad face or voice match can be corrected without raw file edits.

## Test Plan

Unit tests:

- `identity-core` default policy and allowed-use fail-closed behavior.
- `PersonStore` file atomicity, schema validation, version migration, and
  corrupted-file failure mode.
- Legacy DeepFace profile import, including `legacy_unverified` facts and legacy
  `Unknown` profiles becoming candidates.
- `PersonService` list/recall/update/confirm/reject/delete paths against the TS
  store.
- Tombstones blocking direct id update, frame-match update, re-enroll, and stale
  legacy id resurrection.
- Face signal conversion without person fact mutation.
- Memory snapshot filtering and `MemoryCandidate` quarantine.
- Voiceprint owner policy gates: no consent, low quality, low confidence,
  missing template, and owner match.

Prompt tests:

- "This is Sarah. She is a CS student" must use `update_person_profile`, not
  `memory_append`.
- Unknown face must create/update candidate, not profile.
- Low-confidence visual inference must not become a confirmed fact.
- Identified person answer must relay name, facts, and last recap only when the
  user asks.
- iOS and web-ios model-facing tool manifests stay aligned around `person.*`
  tools, while raw `face_*` tools stay compatibility-only.

Integration tests:

- DeepFace legacy data imports into the TS store without changing the legacy
  source files.
- Python face service returns quality/signal/match without person fact mutation.
- Gateway person RPC writes structured facts with source session.
- iOS bridge calls person tools with current-frame provider.
- web-ios bridge calls the same person tools with browser-frame provider.
- Distill reads transcript plus bounded person snapshot and writes daily log only.
- Voiceprint turn scoring can produce an owner-speaking tag, but cannot write
  durable person facts or memory directly.

Manual verification:

- Start Cocktail Party mode.
- Show a new face: candidate appears, no confirmed `Unknown` profile.
- Say "this is Sarah": candidate promotes to profile with evidence.
- Add "she studies robotics": structured fact includes source session and
  evidence.
- Ask "who is this?": on-demand identify returns Sarah with fact/recap.
- Reject a mistaken candidate: it stops resurfacing.
- End the session: memory shows a reviewable candidate or daily-log summary, not
  an unreviewed durable person fact.
- Delete/suppress a person or candidate: face and voice signals no longer bring
  it back silently.

## Risk Controls

- Keep compatibility endpoints until all clients migrate, but make new writes go
  through `person.*` whenever possible.
- Make old `facts: string[]` readable throughout the migration.
- Do not physically split services before the API boundary is tested.
- Do not allow any raw biometric signal to write durable person memory or global
  memory without review and policy approval.
- Keep person/face code dependent on `identity-core`, not on voiceprint runtime
  files. Voiceprint should remain a signal provider until owner enrollment and
  review UX are complete.
- Keep owner voiceprint disabled by default until enrollment, consent, retention,
  and delete flows are implemented.
- Prefer append-only migrations with explicit versioning over destructive rewrites.
- Keep rollback simple: disable TS store promotion, continue reading legacy
  DeepFace profiles, and preserve tombstones/review records.

## Open Decisions

- Resolved: PR 1 uses separate JSON files per record type (`people.json`,
  `person-facts.json`, `person-recaps.json`, `person-candidates.json`,
  `person-tombstones.json`) with atomic writes.
- Resolved: legacy DeepFace import is lazy on read
  (`importLegacyDeepFaceProfiles` during list/recall), not a one-time command.
- Resolved for now: face embeddings stay indexed in the face service short
  term (`fbb8e2f` kept the index in DeepFace while demoting facts/recaps).
- Whether `PersonFact.status` should distinguish `user_confirmed` from
  `assistant_observed`.
- How long unconfirmed face candidates should be retained by default.
- Whether web-ios People screen should show candidates immediately or only after
  user-facing review mode is enabled.
- Whether person recaps should be structured like facts or remain a separate
  lightweight record type.
- How owner voiceprint templates should be encrypted, rotated, exported, and
  deleted on iOS and gateway storage.

---

# Live Mode Architecture Stabilization Plan

Date: 2026-06-22

This section is a near-term stabilization plan for the current jundaclaw Live
mode architecture. It should be completed before the broader ambient-agent
frontier work below, because Live is the runtime surface where sensing,
realtime speech, memory, tools, bridge reachability, and user trust all meet.

The current Live mode has the right high-level shape:

- iOS owns the mobile sensing and realtime user experience.
- OpenAI Realtime handles low-latency voice over WebRTC.
- HaoClaw gateway owns durable memory, tools, background work, intentions, and
  long-running agent context.
- The phone can still talk to OpenAI when the HaoClaw machine is offline.

The architecture risk is that these pieces are connected through soft state
boundaries. "WebRTC connected", "Realtime session configured", "HaoClaw bridge
available", "tools available", and "running session config" are currently close
but not identical. Bridge availability can also change after startup. The next
implementation pass should make those boundaries explicit and keep them true
for the whole running session.

## Implementation Status

Last updated: 2026-07-02

- Phase 1, Realtime Readiness Gate: completed locally. `LiveSessionProvider`
  now reports `sessionConfigStatus`, OpenAI Realtime waits for
  `session.updated`, and Live only enters normal connected/listening after the
  provider reports the session config state.
- Phase 2, Runtime Snapshot Discipline: completed locally. Running-session
  side effects now read the frozen runtime config snapshot for bridge session
  key, transcript append target, gateway feed, mic watchdog, audio turn
  finalization, recording, and session-end memory distill.
- Phase 3, Bridge Capability Gating: completed locally in this pass. Live now
  derives model-facing bridge availability from startup bridge preflight,
  removes gateway-backed tools and bridge collaboration instructions when the
  gateway is offline, and pushes Realtime `session.update` when the bridge feed
  disconnects or reconnects mid-session.
- Phase 4, Visual Settings Consistency: completed locally in this pass.
  OpenAI Realtime profile loading now preserves saved visual source, cadence,
  and camera position instead of forcing visual input off after app restart.
- Phase 5 (LiveRuntimeSession) and Phase 6 (LiveBridgeSession): not started.
  `LiveGatewayBridge` still constructs a transport per RPC via
  `transportFactory`, so the short-lived-socket problem (P2 below) remains
  fully open. These two phases are the remaining core of this plan.
- Landed since this plan was written, outside the original phase list:
  deferred realtime media uploads (`b99c7b2`), a per-turn visual timeline
  (`4815b1d`), camera-photo-to-Slack delivery (`98507d2`), and ordered
  serialization of Realtime speech/transcript/artifact events to the gateway
  for voiceprint scoring, behind the disabled-by-default
  `voiceprintRealtimeEnabled` flag. The Phase 1 readiness gate now has
  dedicated tests
  (`ios/hawkyTests/LiveRealtimeSessionConfigStatusTests.swift`).
- Rethink note (2026-07-02): the credential-architecture decision (P2 below,
  phone-held direct key vs gateway-issued ephemeral credentials) is becoming
  more important, not less — a headless benchmark client for the gateway and
  the voiceprint consent path both favor deciding this before Phase 6 rather
  than after.

## Current Runtime Shape

Live mode currently has two parallel data pipes.

```text
iPhone LiveSessionStore
  |
  |-- OpenAI Realtime WebRTC pipe
  |     |-- mic audio: RTCAudioTrack / RTP
  |     |-- assistant audio: remote RTCAudioTrack
  |     `-- control/events/tools: RTCDataChannel "oai-events"
  |
  `-- HaoClaw bridge pipe
        `-- WebSocket JSON-RPC to ws://<tailscale-ip>:4242
            boot context, memory, tools, background agent, intentions
```

The HaoClaw gateway on port 4242 is not the OpenAI media proxy. It is the
memory/tool/control plane. The OpenAI WebRTC media leg is established directly
from the phone to OpenAI using the Direct OpenAI API key stored on the phone.

## Data And Function Layers

### 1. UI To Store

`LiveView` starts a session through `LiveSessionStore.start(recordingTransport:)`.
The store owns:

- draft settings: `LiveSessionConfig config`
- running settings snapshot: `LiveSessionConfig? activeConfig`
- unified read accessor: `liveConfig`
- lifecycle: `LiveSessionPhase`
- user-visible diagnostics: `LiveSessionDiagnostics`
- normalized model/provider events: `LiveSessionEvent`

Design rule: UI settings mutate `config`; all running-session side effects must
read `activeConfig` through `liveConfig` or a stronger runtime-session object.

### 2. Startup Preflight

For `.openAIRealtime`, the store currently forces:

- `openAICredentialMode = .directAPIKey`
- `responseModality = .audio`
- `openingBehavior = .silent`

If the HaoClaw bridge is enabled, startup also resolves the bridge session key
and fetches `frontend.boot_context` from the gateway before the OpenAI
Realtime session is configured. That response is used as:

- reachability probe for the user's HaoClaw machine,
- startup memory/context for the realtime model,
- first-contact marker,
- toolbox manifest.

Design rule: boot context is startup configuration input, so it may run before
OpenAI `session.updated`. The bridge feed, transcript writes, tool side
effects, and other runtime injections should wait until the Realtime session is
configured.

### 3. Provider Selection

The active OpenAI Live provider is:

```text
LiveSessionProviderFactory
  .openAIRealtime -> PipecatOpenAIRealtimeLiveSessionProvider
```

The older WebSocket OpenAI provider and gateway broker code still exist, but
they are not the active iOS Live path.

### 4. WebRTC Connect

`PipecatOpenAIRealtimeLiveSessionProvider.connect(config:)` reads the Direct
OpenAI key from the phone Keychain, builds Pipecat options, and starts
`OpenAIRealtimeTransport`.

The WebRTC transport:

- creates a local audio track, initially muted,
- creates a data channel named `oai-events`,
- creates an SDP offer,
- posts the SDP offer directly to `https://api.openai.com/v1/realtime/calls`,
- receives the SDP answer,
- then waits for OpenAI data-channel events.

The initial SDP call intentionally sends only a minimal session. Full persona,
tools, VAD, transcription, voice, and boot context are sent later over the data
channel as `session.update`.

### 5. Realtime Session Configuration

After OpenAI emits `session.created`, the transport sends:

```json
{ "type": "session.update", "session": { "...": "full Live session config" } }
```

The full config includes:

- resolved instructions,
- HaoClaw bridge instructions,
- startup boot context,
- audio input transcription,
- VAD settings,
- output voice,
- tool definitions.

The session is only fully configured after OpenAI emits `session.updated`.

### 6. Mic And Speech

Mic audio is WebRTC media, not JSON and not gateway traffic.

```text
LiveSessionStore.startAudioStream()
  -> provider.setAudioInputEnabled(true)
  -> RTVIClient.enableMic(true)
  -> OpenAIRealtimeWebRTCConnection.unmuteAudio()
  -> RTCAudioTrack.isEnabled = true
```

Speech lifecycle and transcripts arrive over `oai-events`:

- `input_audio_buffer.speech_started`
- `input_audio_buffer.speech_stopped`
- `conversation.item.input_audio_transcription.completed`

The provider normalizes those into `LiveSessionEvent.raw` and
`LiveSessionEvent.inputTranscriptComplete`.

### 7. Assistant Output

Assistant audio is the remote WebRTC audio track. Assistant transcript text is
metadata over the data channel:

- `response.audio_transcript.delta`
- `response.output_audio_transcript.delta`
- `response.audio_transcript.done`
- `response.output_audio_transcript.done`

The provider maps these to `LiveSessionEvent.textDelta` and
`LiveSessionEvent.textComplete`, and the store renders assistant bubbles.

### 8. Text, Context, And Frames

Typed user text and injected context are sent through the WebRTC data channel as
`conversation.item.create` messages.

Camera frames are converted to:

```json
{
  "role": "user",
  "content": [
    {
      "type": "input_image",
      "image_url": "data:image/jpeg;base64,..."
    }
  ]
}
```

Frames use `run_immediately: false`, so they should condition the model without
triggering a response for every frame.

### 9. Tool Calls

Realtime tool calls arrive as:

```json
{
  "type": "response.function_call_arguments.done",
  "name": "session_send_message",
  "call_id": "...",
  "arguments": "{...}"
}
```

The provider calls:

```text
LiveToolRegistry.execute(name, argumentsJSON, LiveToolContext)
```

The tool registry:

- parses JSON arguments,
- finds the Swift tool,
- checks availability,
- executes local Swift code or a gateway-backed RPC,
- serializes a JSON result,
- sends it back to OpenAI as `function_call_output`,
- then triggers `response.create`.

Gateway-backed tools include:

- `session_send_message` -> `chat.send`
- `create_intention` -> `intention.create`
- `scan_intention` -> `intention.scan`
- `intention_respond` -> `intention.respond`
- face/hazard tools -> `tool.invoke`
- memory tools -> `memory.*` or `chat.send`

### 10. Gateway Feed

The store starts a long-lived bridge stream when the HaoClaw bridge is enabled.
It decodes `agent.*` events:

- `agent.text`
- `agent.done`
- `agent.tool_use_start`
- `agent.tool_result`
- `agent.intention_surface`
- `agent.regions.update`
- `agent.when.armed`
- `agent.when.disarmed`

In `onDemand` feed mode, only surface/region/notification style events are
acted on. In `followSession` mode, ordinary background agent text/tool/system
events are also injected into Realtime as silent context.

## Architecture Problems To Fix

### P1: WebRTC Connected Is Not Realtime Ready

`client.start()` establishes the media/data-channel leg, but the session is not
fully useful until OpenAI acknowledges `session.update` with `session.updated`.

Current risk:

- the store can enter `.connected`,
- mic can be enabled,
- visual frames can start,
- bridge context can flow,
- but persona/tools/VAD/transcription may not be applied yet.

Required change:

- split readiness into `transportConnected`, `sessionConfigured`, and
  `listening`,
- gate mic, visual, bridge feed, and visible "Connected" state on
  `sessionConfigured`,
- treat `session_config_failed` as a hard configuration failure,
- treat a missing `session.updated` timeout as a degraded or unconfirmed state
  unless a strict-start mode explicitly chooses to fail the session.

### P1: Running Session Must Not Read Draft Config

The store has the right concept: `config` is draft, `activeConfig` is the
running snapshot. Some runtime paths still read draft `config`, especially
transcript append for latent intentions.

Current risk:

- the user edits settings while Live is running,
- a later transcript append uses a new draft session key or mode,
- the active conversation is written to the wrong HaoClaw session.

Required change:

- audit all running-session side effects,
- use `liveConfig` or a new immutable runtime object,
- reserve direct `config` reads for UI draft mutation only.

### P1: Bridge Availability And Tool Availability Are Not The Same

If boot context fails and bridge is not required, the OpenAI Live session can
still start. That is useful. But the Realtime model may still receive HaoClaw
bridge instructions and tools.

Current risk:

- the model believes HaoClaw tools are available,
- tool calls fail later,
- the user experiences this as unreliable capability rather than clear offline
  state.

Required change:

- derive runtime bridge availability during startup,
- if bridge is offline, remove bridge tools from the Realtime session or inject
  a clear offline instruction and disable tool calls,
- if bridge goes offline after startup, send a Realtime `session.update` that
  disables bridge tools or explicitly marks the bridge unavailable,
- keep the UI offline banner.

### P2: Gateway Bridge Uses Too Many Short-Lived WebSockets

Most `LiveGatewayBridge` methods create a new `URLSessionGatewayTransport`,
connect, send one RPC, and disconnect. A separate long-lived feed stream also
exists.

Current risk:

- Tailscale latency is amplified,
- battery and network churn increase,
- auth and reconnect edge cases multiply,
- concurrent tool calls can create many sockets.

Required change:

- introduce a `LiveBridgeSession`,
- keep one authenticated WebSocket for RPC correlation and event streaming,
- add event routing so background feed events, tool-call RPC responses, and
  `chat.send` response collection cannot consume each other's messages,
- reconnect with backoff and replay only the session binding, not every call.

### P2: Store Knows Too Much About Provider Internals

`LiveSessionStore` currently coordinates provider-specific details: WebRTC owns
mic input, recording needs a parallel mic tap, visual quiet must be set before
bridge feed, hard quiet must suppress certain responses, and frames must buffer
around active responses.

Current risk:

- provider-specific ordering bugs,
- difficult addition of new providers,
- fragile safety/quiet/visual interactions.

Required change:

- expose provider capabilities explicitly,
- move provider-specific ordering behind provider lifecycle methods,
- keep the store focused on product state and user-visible session lifecycle.

### P2: Visual Frame Context Can Grow Without A Strong Budget

Each camera keyframe becomes an `input_image` conversation item. Deduplication
exists, but the default is currently off.

Current risk:

- long sessions accumulate many image items,
- the model fixates on camera context,
- cost and latency become unstable.

Required change:

- turn visual dedup on for continuous visual modes or add a frame budget,
- consider a latest-frame state model or an on-demand vision tool instead of
  appending every keyframe into conversation history.

### P2: Credential Architecture Is Split

iOS Live currently uses a Direct OpenAI API key on the phone. The codebase still
contains gateway broker and older WebSocket Realtime paths.

Current risk:

- legacy code paths make runtime ownership unclear,
- tests and reviews may exercise the wrong path,
- long-term credential/security policy is split between phone-held direct keys
  and gateway-issued credentials.

Required change:

- decide the canonical credential path,
- either commit to direct phone key and mark broker path as legacy,
- or move iOS WebRTC to gateway-issued ephemeral credentials.

### P2: Visual Persistence Defaults Are Inconsistent

Runtime startup no longer forces visual source/cadence off for OpenAI Realtime,
but settings load still resets visual source/cadence to off for that provider.

Current risk:

- user enables camera,
- app reload clears the setting,
- actual runtime behavior and persisted settings disagree.

Required change:

- remove load-time forced visual reset,
- if needed, make it a one-time migration for old installs only.

### P3: Raw Event Observability Is Too Thin

Provider events are normalized for UI, but the full OpenAI data-channel stream
is not retained as a bounded diagnostic artifact.

Current risk:

- active-response races are hard to debug,
- session-update failures are hard to reconstruct,
- tool ordering is hard to audit after an incident.

Required change:

- add a bounded raw OpenAI event ring buffer in diagnostics mode,
- include it in Live raw exports.

## Implementation Plan

### Phase 1: Realtime Readiness Gate

Goal: do not treat WebRTC transport connection as full Live readiness.

Implementation:

1. Add a provider-level async wait for `session.updated`.
2. Convert `session_config_failed:` into a thrown configuration error.
3. Represent a `session.updated` timeout as `configurationUnconfirmed` or a
   degraded state by default; only hard fail when a strict-start policy is
   explicitly enabled.
4. Keep boot context fetch before OpenAI configuration because it contributes
   startup instructions.
5. Move Store `.connected`, mic start, visual start, bridge feed start, and
   opening/safety follow-up after the configured signal.

Acceptance:

- normal start order is `WebRTC session started` -> `Session configured` ->
  `Connected` -> `Listening`;
- bad session config never reaches normal listening state;
- slow `session.updated` acknowledgement does not accidentally kill a usable
  session unless strict-start is enabled;
- bad OpenAI key still routes to the auth alert.

### Phase 2: Runtime Snapshot Discipline

Goal: every side effect for an active Live session uses immutable runtime state.

Implementation:

1. Fix finalized transcript append to read `liveConfig`.
2. Audit all `config.gatewayBridgeSessionKey`, `config.mode`, and related
   runtime reads in `LiveSessionStore`.
3. Introduce local `let cfg = liveConfig` at side-effect boundaries.
4. Add tests for "settings changed while Live is running".

Acceptance:

- a temporary `realtime:<A>` Live session keeps writing to `<A>` even if the
  settings draft changes mid-session.

### Phase 3: Bridge Capability Gating

Status: completed locally on 2026-06-23.

Goal: the Realtime model only receives HaoClaw tools when the bridge is actually
usable.

Implementation:

1. Add `LiveBridgeAvailability` with `disabled`, `available`, and
   `offline(reason)`.
2. Derive it from boot context / required-mode decision.
3. Thread availability into instruction and tool definition generation before
   `session.update`.
4. If offline but Live continues, remove bridge tools and add a short offline
   instruction.
5. Observe bridge disconnect/reconnect during the session and send Realtime
   `session.update` when bridge tools become unavailable or available again.

Acceptance:

- gateway down with bridge not required still allows OpenAI voice;
- the model does not call bridge tools in offline mode;
- gateway up still exposes normal HaoClaw tools;
- gateway dropping mid-session does not leave stale bridge tools advertised to
  the model.

### Phase 4: Visual Settings Consistency

Status: completed locally on 2026-06-23.

Goal: persisted visual settings match runtime behavior.

Implementation:

1. Remove the load-time forced `visualSource = .off` and
   `visualCadence = .off` for OpenAI Realtime.
2. Replace with migration-only defaults if necessary.
3. Add a settings persistence test.

Acceptance:

- enabling camera survives app restart;
- Live starts visual stream according to the saved setting.

### Phase 5: LiveRuntimeSession

Goal: make the running session state explicit.

Proposed shape:

```swift
struct LiveRuntimeSession {
    let id: UUID
    let startedAt: Date
    let effectiveConfig: LiveSessionConfig
    let gatewaySessionKey: String
    let bridgeAvailability: LiveBridgeAvailability
    let capabilities: LiveRuntimeCapabilities
}
```

Implementation:

1. Create this object at start after boot context / bridge decision.
2. Store it as `runtimeSession`.
3. Migrate running side effects from `liveConfig` to `runtimeSession`.
4. Keep `config` as UI draft only.

Acceptance:

- no runtime side effect depends on mutable draft settings;
- code review can identify active-session state from one object.

### Phase 6: LiveBridgeSession

Goal: replace short-lived gateway sockets with one session-scoped connection.

Implementation:

1. Create a bridge session object that owns one authenticated WebSocket.
2. Support RPC correlation and event stream on the same socket.
3. Add per-request event routing for stream-like RPCs such as `chat.send`, so
   background `agent.*` feed events and tool-call response collectors do not
   mix.
4. Reconnect with backoff.
5. Route `chat.send`, `transcript.append`, `intention.*`, `tool.invoke`, and
   `memory.*` through the session.

Acceptance:

- bridge startup uses one primary socket;
- tool calls do not create one socket per RPC;
- concurrent tool calls receive only their own correlated responses;
- reconnect preserves session binding and mode.

## Test Plan

Run in this order:

1. `bun run typecheck`
2. targeted unit tests for Live config, bridge decision, gateway feed, and tool
   registry
3. `bun run ios:build-sim`
4. simulator smoke tests for auth-blocked start and settings persistence
5. real-device tests:
   - gateway up over Tailscale,
   - gateway down with bridge not required,
   - gateway disconnect/reconnect while Live is running,
   - bad OpenAI key,
   - bad Realtime session config,
   - delayed or missing `session.updated`,
   - visual enabled,
   - settings changed while Live is running,
   - background `session_send_message`,
   - timed `create_intention`,
   - latent `transcript.append` / `scan_intention`.

---

# HaoClaw / jundaclaw Frontier Ambient Agent Plan

Date: 2026-06-21

Status refresh: 2026-07-02. This plan is strategy, so most of it does not
"complete", but several of its core objects now exist in code — earlier and
narrower than the schemas below:

- `MemoryCandidate` exists (`src/memory/candidate.ts`) with evidence metadata
  and quarantine reasons; person/identity-derived candidates quarantine by
  default. Invention 6's first slice is done.
- A session-bounded person snapshot (`src/memory/person-snapshot.ts`) bounds
  what memory distillation can read (proof-carrying memory, partial).
- `IdentitySignal` exists for face (`src/identity/person`) and voice
  (`src/identity/voiceprint`) with allowed-use policy that fails closed.
- Identity candidates, tombstones, and confirm/reject/suppress review
  primitives exist; the review *surfaces* (memory ledger, identity queue,
  operator cockpit) do not. That gap is the current bottleneck — see the
  rethink in the refactor plan at the top of this file.
- `Artifact`, `ActionProposal`, `RelationshipCandidate`, `ContextVisa`,
  replay bundles, consent graph, shadow autonomy: not started.

A complementary evidence direction now exists alongside the hero demos: an
open-source benchmark harness (separate repo) measuring hawky-system —
memory + person + proactive + tools over a realtime model — against the raw
realtime model, with τ-Voice (tau2-bench voice) as the headline and
full-duplex/streaming-proactivity benchmarks as secondary. Hero demos remain
the narrative tests; the benchmark harness is the quantitative one. The
integration boundary it imposes: the gateway WebSocket JSON-RPC surface must
stay drivable by a headless client, so no core loop may become iOS-only.

This document is a high-ambition development plan for HaoClaw and jundaclaw. It
is intentionally harder and stranger than a normal roadmap. The goal is to
protect the parts of the project that could become category-defining before the
work collapses into a generic recorder, voice assistant, AI notes app, or
chatbot shell.

## Executive Summary

HaoClaw should become a user-owned ambient-agent harness: a private operating
layer that captures context, stores evidence, forms memories, proposes actions,
shares scoped context with other agents, and remains governable by the user.

jundaclaw should be the mobile and glasses sensing/action client for that
harness. It should not become a standalone chat app. Its job is to sense, show
run-state, request consent, collect feedback, and deliver actions.

The breakthrough is not "an AI that hears and sees everything." The
breakthrough is an ambient agent that can:

- prove what it knows,
- show why it wants to act,
- ask before meaningful side effects,
- learn when silence is better,
- distinguish owner/self context from other people,
- quarantine uncertain identity and relationship signals,
- safely share scoped context with other agents,
- replay and repair its own mistakes.

The product should feel less like a conversational UI and more like a governed
personal agent substrate.

## Market Gap

The ambient-agent market is crowded in obvious places:

- Wearable capture: glasses, pendants, pins, wrist devices.
- Meeting notes: transcript, summary, action items.
- Realtime voice/vision APIs: low-latency conversation and tool calls.
- Desktop lifelogging: screen/audio capture plus local search.
- Memory SDKs: extracted facts and user preferences for agents.

Those products prove demand, but they also reveal the gap. Capture is becoming
cheap. Summaries are becoming commodity. Realtime APIs are becoming plumbing.

The unsolved layer is trusted interpretation and trusted action:

- Why does the agent believe a memory?
- What evidence supports this suggestion?
- Which policy allowed this data to be stored or shared?
- Is the owner present, speaking, or merely overheard?
- Is this person identity confirmed or only a candidate?
- What would the agent have done if it had autonomy?
- How can the user correct the system after a mistake?
- How can another agent use personal context without receiving everything?

HaoClaw already has the correct foundation: a long-running gateway, sessions,
memory, tools, skills, MCP, web/TUI surfaces, background services, push, and
node capabilities.

jundaclaw already has the correct edge: iOS Live, phone capture, glasses path,
realtime tools, mobile node role, memory tools, intentions, and diagnostics.

The next step is to make these pieces feel like one governed ambient system.

## Landscape And Overlap Check

Accessed: 2026-06-21. Refresh: 2026-07-02.

Refresh notes (2026-07-02): the commodity layers moved again, in the expected
direction. Meta launched $299 own-brand AI glasses (June 2026) with a
wearable-specific inference model and the [Wearables Device Access
Toolkit](https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/)
developer preview — glasses capture is now firmly a platform feature, not a
moat for anyone. Google moved [Gemini Live to production
GA](https://ai.google.dev/gemini-api/docs/live-api) on Vertex AI with
"proactive audio" that lets the model decide when to stay silent — meaning
"knows when not to speak" is becoming a platform primitive; hawky's Silence
Is A Feature principle must differentiate through memory, policy, feedback
history, and review, not turn-taking alone. OpenAI shipped
[gpt-realtime](https://openai.com/index/introducing-gpt-realtime/) to
production with MCP server support, image input, SIP calling, and a larger
context window. None of this changes the table's conclusion — capture,
realtime voice, and extracted memory are commodity; trusted interpretation
and trusted action remain the gap — it strengthens it.

The direction is current, but several parts are already active elsewhere. Treat
those as validation, not as differentiation. The differentiated bet is the
combination: evidence-backed memory, owner-first identity, deterministic policy,
action previews, replay/evals, and scoped context export.

| Market signal | What is already happening | Implication for HaoClaw |
| --- | --- | --- |
| Realtime voice agents are now infrastructure | OpenAI Realtime positions low-latency voice agents as sessions that stream audio, manage state, call tools, and use WebRTC/WebSocket paths ([OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime)). Google Gemini Live similarly supports low-latency voice/vision streams, tool use, proactive audio, and smart-glasses/vehicle interfaces ([Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)). | Do not compete on "we have realtime voice." Treat realtime as plumbing. The product moat has to be memory, permission, identity, action, and replay. |
| Smart glasses are becoming developer platforms | Meta's Wearables DAT SDK lets iOS apps connect to Meta AI glasses and use video streaming/photo capture in developer preview ([Meta Wearables DAT iOS](https://github.com/facebook/meta-wearables-dat-ios)). Snap positions Snap OS 2.0 as a wearable OS using voice, gesture, and touch, with consumer Specs in 2026 ([Spectacles](https://www.spectacles.com/)). | Glasses capture is not unique. jundaclaw should use glasses as one sensor in a sensor mesh, not make hardware the moat. |
| Always-on glasses agents already exist | VisionClaw integrates Meta Ray-Ban smart glasses, Gemini Live, and OpenClaw for egocentric perception plus agentic task execution ([VisionClaw paper](https://arxiv.org/abs/2604.03486), [VisionClaw GitHub](https://github.com/Intent-Lab/VisionClaw)). | "Glasses + voice + vision + tool calls" is already a known demo. HaoClaw must go beyond it with durable evidence, reviewable memory, owner identity, policy, and replay. |
| Edge perception efficiency is an active research problem | EPIC argues continuous egocentric video has power and memory bottlenecks, and uses gaze/pose/inertial signals to retain informative perception while reducing memory and energy costs ([EPIC](https://arxiv.org/abs/2606.15859)). VisualClaw similarly filters streaming frames and evolves skills from failures for physical-world agents ([VisualClaw](https://arxiv.org/abs/2606.16295)). | The sensor mesh should not upload everything. Add source routing, informative-frame selection, replay bundles, and eval-driven skill evolution. |
| AI note-taking is mature | Granola is explicitly "notes, actions and memory" without a meeting bot and connects notes into other AI apps ([Granola](https://www.granola.ai/)). Plaud NotePin sells wearable capture with 112-language transcription, speaker labels, templates, compliance claims, multimodal input, and 20-hour recording ([Plaud NotePin](https://www.plaud.ai/products/notepin)). Limitless was acquired by Meta and stopped selling Pendant to new customers while supporting existing customers through 2026 ([Limitless](https://www.limitless.ai/)). | Meeting notes and action items are a wedge, not the destination. The product has to turn notes into evidence-backed, permissioned action. |
| Local-first lifelogging is a strong benchmark | screenpipe records screen/audio locally, exposes MCP, has timeline/search, and enforces deterministic pipe permissions through app/window/content/time restrictions rather than prompt-only controls ([screenpipe](https://github.com/screenpipe/screenpipe)). | This validates local-first capture, MCP, and deterministic permissions. HaoClaw should adopt the policy seriousness, then extend it to phone/glasses, identity, relationships, and action previews. |
| Open-source wearable memory platforms are broadening | Omi describes itself as capturing screen and conversations, producing realtime transcripts, summaries, action items, and AI chat across desktop, phone, and wearables ([Omi](https://github.com/BasedHardware/omi)). | Broad capture + app ecosystem exists. HaoClaw should not try to win by being broader; it should win by being more governable and inspectable. |
| Voice/multimodal agent frameworks are becoming commodity | Pipecat supports realtime voice/multimodal agents, multi-agent handoff, shared buses, WebRTC/WebSocket transports, and many client SDKs ([Pipecat](https://github.com/pipecat-ai/pipecat)). LiveKit Agents provides realtime voice agents, multi-agent handoff, and testing integration ([LiveKit Agents](https://github.com/livekit/agents)). | Do not rewrite voice framework infrastructure unless needed. Borrow pipeline ideas, but keep the differentiator in memory, identity, and policy. |
| Memory layers are already crowded | Mem0 added a 2026 memory algorithm with entity linking, temporal reasoning, hybrid retrieval, and agent-generated facts ([Mem0](https://github.com/mem0ai/mem0)). Letta focuses on stateful agents with advanced memory and self-improvement ([Letta](https://github.com/letta-ai/letta)). Supermemory markets a memory/context engine with profiles, contradictions, automatic forgetting, connectors, and MCP ([Supermemory](https://github.com/SupermemoryAI/supermemory)). | Extracted memory alone is not special. HaoClaw's memory must be proof-carrying, influence-tracked, identity-aware, and reversible. |
| Agent safety is becoming architecture-level | A 2026 OpenClaw safety analysis frames Capability, Identity, and Knowledge as persistent-state attack surfaces and finds poisoning any one dimension sharply increases attack success ([OpenClaw safety analysis](https://arxiv.org/abs/2604.04759)). | This directly supports the Trust Kernel, Context Quarantine, owner-first identity, and scoped context visas. Safety cannot be prompt-only. |
| App-store privacy makes ambient capture a release issue | Apple requires disclosure of collected data and third-party partner practices, and treats retained off-device audio/voice recordings as data collection while on-device-only processing is handled differently ([Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)). | Privacy policy, retention, deletion, and biometric handling must be product architecture, not launch paperwork. |

### What Is Repeated

These ideas are validated but no longer special by themselves:

- realtime voice/vision,
- glasses camera streaming,
- meeting transcription and summaries,
- action items,
- local desktop lifelogging,
- generic long-term memory,
- MCP context access,
- voice agent frameworks,
- app/skill ecosystems.

### What Still Looks Special

The special direction is the combined system:

- proof-carrying memory rather than extracted memory,
- owner-first voice/face recognition rather than broad identity surveillance,
- relationship candidates that refuse to guess,
- context quarantine before memory promotion,
- action inbox before autonomy,
- counterfactual previews before side effects,
- episodic replay and ambient evals,
- deterministic consent graph across capture, memory, MCP export, and tools,
- context visas for other agents,
- attention wallet and regret review.

This is why the plan should emphasize a governed personal agent substrate, not
an AI wearable or note-taking app.

## Positioning

Do not position this as:

- an AI wearable,
- an AI meeting recorder,
- a ChatGPT voice app,
- a personal RAG app,
- a prettier chat client.

Position it as:

> A proof-carrying personal agent that turns ambient context into governed
> memory and permissioned action.

The moat is not hardware and not a model wrapper. The moat is the harness:

- capture-source agnostic,
- model/provider agnostic,
- evidence-backed,
- privacy-aware,
- permissioned,
- replayable,
- action-capable,
- able to explain and repair itself.

## Four Bets To Protect

These are the core bets. If they survive, the product can become unusual. If
they are cut, the project becomes another ambient notes app with tool calls.

### 1. Evidence On Every Durable Memory

Every durable memory must carry provenance:

- raw artifact ids,
- transcript spans,
- frame ids or image regions,
- source device,
- timestamp,
- confidence,
- sensitivity,
- retention policy,
- user confirmation state,
- usage history.

The user should be able to ask:

- "Why do you believe this?"
- "Where did this come from?"
- "Where has this memory influenced behavior?"
- "Forget this everywhere."

### 2. Preview Before Meaningful Side Effects

For meaningful side effects, the agent should not only ask "approve?" It should
show:

- proposed action,
- supporting evidence,
- affected data,
- tool scope,
- risk,
- expected outcome,
- undo or rollback path.

### 3. Autonomy Earned From Shadow Evidence

Autonomy should not be a global settings toggle. It should graduate by:

- action type,
- situation,
- source,
- tool,
- person,
- feedback history.

Before the agent acts autonomously, it should run in shadow mode and record what
it would have done.

### 4. Owner-First Identity And Relationship Memory

Identity starts with the owner, not with bystanders.

The first identity goal is to answer:

- Is the owner present?
- Is the owner speaking?
- Is this memory about the owner or about someone else?
- Is this a confirmed person, or only a candidate?

Non-owner names, faces, voices, and relationship edges must remain candidates
until reviewed. The system should never silently build a biometric identity
database.

## Non-Negotiable Product Principles

### Privacy Must Be Executable

Privacy cannot live only in copy or settings pages. A deterministic policy layer
must govern capture, memory promotion, search, MCP export, and tool execution.

### Silence Is A Feature

The agent should learn when not to interrupt. A technically correct suggestion
can still be wrong if the timing is wrong.

### Unknown People Stay Unknown

The system can cluster signals, but it should not pretend to know who someone
is. Names, voices, faces, and relationship edges are separate signals until the
user confirms a person capsule.

### Replay Is The Trust Product

Users do not need the agent to be perfect if they can inspect, replay, correct,
and regression-test failures.

## How Humans And Agents Should Read This

This document is for both people and coding agents. It uses product language
for intent and engineering language for constraints.

For humans:

- Read `Four Bets To Protect` first. Those are the strategy.
- Read `Priority And Dependency Map` before choosing work.
- Read `Core Data Model` before designing UI or backend APIs.
- Treat the hero demos as narrative tests: if a build cannot support a demo,
  the product story is drifting.

For agents:

- Do not treat the invention portfolio as a parallel task list.
- Do not start P1/P2 work until its P0 dependencies exist.
- Prefer adding schemas, lifecycle states, tests, and replay fixtures before UI
  polish.
- If identity, relationship, or biometric behavior is ambiguous, choose
  quarantine and user review.
- Never implement non-owner biometric naming, relationship promotion, or context
  export without explicit policy and tests.

Priority meanings:

- `P0`: Required to prove the product direction. Work that blocks the first
  inspectable ambient loop.
- `P1`: Core differentiator. Work that turns the loop into a governable product.
- `P2`: Expansion. Work that broadens surfaces or autonomy after the trust
  substrate exists.

Dependency rule:

- `Artifact` comes before `MemoryCandidate`.
- `MemoryCandidate` comes before durable memory UI.
- `ActionProposal` comes before autonomy.
- `IdentitySignal` comes before `RelationshipCandidate`.
- `RelationshipCandidate` comes before social memory actions.
- `ConsentGraph` comes before `ContextVisa`.
- Replay comes before model/provider comparison.
- Eval fixtures come before generated skills.

## Priority And Dependency Map

| Area | Priority | Depends on | First useful deliverable | Do not start if |
| --- | --- | --- | --- | --- |
| Trust Foundation | P0 | Current CI/security/logging gaps | Release gates, redacted logs, web security headers, privacy matrix | Releases can ship without tests or logs preserve secrets by default |
| Core Data Model | P0 | None | `Artifact`, `MemoryCandidate`, `ActionProposal`, `IdentitySignal`, `RelationshipCandidate`, `ContextVisa` draft schemas | The team is still debating object ownership |
| Proof-Carrying Memory | P0 | Artifact ids, evidence refs | One memory candidate with transcript/frame provenance | Raw artifacts are not addressable by stable ids |
| Phone-Held Ambient Loop | P0 | Gateway auth, iOS client, artifact storage | One scripted verifier from capture to phone response | Gateway/iOS connection cannot be reproduced |
| Ambient Action Inbox | P0 | Artifact refs, basic action proposal schema | One evidence-backed action card with approve/dismiss | Proposals cannot link to evidence |
| Episodic Replay | P0 | Event sequence, artifact refs | Export one Live session to a replay bundle | Events cannot be ordered or artifacts cannot be found |
| Context Quarantine | P0 | Memory candidate lifecycle | Person/identity candidates default to `quarantined` | Memory writes bypass review |
| Shadow Autonomy | P1 | Action proposal history, feedback labels | "Would have acted" trace with user rating | Action proposals are not stored |
| Owner Identity | P1 | IdentitySignal schema, consent mode, local secure storage | Owner-present / owner-speaking tags only | Template storage/deletion semantics are undefined |
| Social Memory Capsules | P1 | Owner identity, relationship candidates, review UI | One reviewed person capsule with expiry and evidence | Non-owner identity can become confirmed automatically |
| Consent Graph | P1 | Capture modes, memory lifecycle, identity controls | Two situation contracts with retention/export behavior | Capture and retention policies are hardcoded |
| Context Visas | P2 | Consent graph, memory ledger, MCP scopes | Scoped context export preview with expiry | Unconfirmed people or raw biometrics can be exported |
| Sensor Mesh And Glasses | P2 | Phone loop, node capability manifest | iOS node capabilities and one glasses frame in artifact pipeline | Phone path is not reliable |
| Counterfactual Simulator | P2 | Action proposal schema, permission policy | Preview for one side-effectful tool | Approval flow is not represented as data |
| Attention Wallet | P2 | Action inbox, feedback history | Bad-timing feedback suppresses similar suggestions | Suggestions are not measured |
| Memory Compiler / Living Skills | P2 | Eval fixtures, action history, skill permissions | Skill lifecycle/readiness UI | Skills lack declared data needs and tests |

Status notes (2026-07-02): Context Quarantine shipped for the person/memory
path (`MemoryCandidate` quarantine plus identity-candidate review gates).
Core Data Model is partial — `MemoryCandidate` and `IdentitySignal` exist in
narrower form than the schemas below, while `Artifact`, `ActionProposal`,
`RelationshipCandidate`, and `ContextVisa` do not exist. Owner Identity has
its voiceprint scoring/storage foundation but no enrollment UX. The rows
whose "first useful deliverable" is a review surface (Ambient Action Inbox,
and the review half of Context Quarantine) are where the plan is now
blocked; everything else is unchanged.

## System Shape

The product should be organized as seven layers.

### 1. Capture Layer

Sources:

- iPhone mic and camera,
- Ray-Ban Meta / glasses,
- desktop screen and audio,
- browser/PWA,
- Slack, GitHub, email, calendar,
- local and remote nodes,
- future hardware.

Output:

- raw artifacts,
- transcripts,
- keyframes,
- OCR,
- frame captions,
- owner/self face confidence,
- owner/self voice confidence,
- non-owner voiceprint clusters,
- heard-name candidates,
- relationship-edge candidates,
- speaker/person hints,
- source metadata,
- consent state.

### 2. Evidence Store

Stores:

- media artifacts,
- transcripts,
- keyframes,
- model inputs and outputs,
- tool proposals,
- permission decisions,
- identity-signal records,
- event logs,
- replay bundles.

Required property:

- every derived object links back to evidence.

### 3. Memory And Identity Ledger

Stores:

- durable preferences,
- project facts,
- owner profile,
- social memory capsules,
- relationship graph edges,
- active commitments,
- routines,
- suppressed memories,
- expired memories,
- deleted-memory tombstones.

Required property:

- every memory, identity candidate, and relationship edge can be audited,
  edited, revoked, expired, and replayed.

### 4. Intention Engine

Produces:

- reminders,
- action proposals,
- drafts,
- social nudges,
- workflow suggestions,
- background task candidates.

Required property:

- every proposal competes for attention and includes evidence.

### 5. Trust Kernel

Validates:

- input source,
- consent state,
- memory sensitivity,
- identity confidence,
- requested tool,
- side effects,
- export scope,
- required approval level,
- undo path.

Required property:

- model output is a suggestion, not authority.

### 6. Permissioned Action Runtime

Executes:

- messages,
- emails,
- calendar drafts,
- code edits,
- GitHub actions,
- local commands,
- node commands,
- MCP tools.

Required property:

- action execution leaves a trace and can be reviewed after the fact.

### 7. Operator Cockpit

Surfaces:

- agent run-state,
- capture state,
- owner-present / owner-speaking state,
- action inbox,
- memory ledger,
- identity review queue,
- relationship candidates,
- episodic debugger,
- eval dashboard,
- device/node mesh,
- privacy policy graph.

Required property:

- the first screen answers: "Is the agent alive, what is it sensing, who is it
  sure about, what did it learn, and what does it want to do?"

## Core Data Model

These are conceptual schemas, not final implementation types. They define the
minimum objects that must exist before the product can safely grow.

Agents implementing these objects should create typed definitions, migrations or
storage adapters, fixture builders, and tests for each lifecycle transition.

### Shared Types

```ts
type RecordId = string;
type IsoTime = string;

type Sensitivity =
  | "public"
  | "normal"
  | "private"
  | "sensitive"
  | "biometric";

type ReviewState =
  | "unreviewed"
  | "approved"
  | "edited"
  | "rejected"
  | "suppressed";

type RetentionClass =
  | "ephemeral"
  | "session"
  | "rolling_7d"
  | "rolling_30d"
  | "durable"
  | "delete_on_close";

type EvidenceRef = {
  artifactId: RecordId;
  transcriptRange?: { startMs: number; endMs: number };
  frameRef?: { frameId: string; region?: { x: number; y: number; w: number; h: number } };
  textRange?: { start: number; end: number };
  excerptHash?: string;
};

type ConsentSnapshot = {
  contractId?: RecordId;
  captureAllowed: boolean;
  retention: RetentionClass;
  memoryPromotionAllowed: boolean;
  biometricAllowed: boolean;
  exportAllowed: boolean;
  reason?: string;
};
```

Shared invariants:

- Every durable object must have `createdAt`, `updatedAt`, and `evidenceRefs`
  unless it is itself an artifact.
- Every object that can influence memory, action, or export must carry a
  `ConsentSnapshot`.
- `biometric` sensitivity cannot be exported through a context visa by default.
- Deleted objects should leave tombstones so rejected or deleted identities do
  not resurface as new suggestions.

### Artifact

An artifact is the addressable evidence layer. Nothing durable should be
remembered without linking back to one or more artifacts.

```ts
type Artifact = {
  id: RecordId;
  kind:
    | "audio_segment"
    | "video_frame"
    | "image"
    | "transcript"
    | "ocr"
    | "model_event"
    | "tool_event"
    | "node_event"
    | "user_feedback";
  createdAt: IsoTime;
  capturedAt: IsoTime;
  timeRange?: { start: IsoTime; end: IsoTime };
  source: {
    client: "ios" | "web" | "tui" | "desktop_node" | "glasses" | "slack" | "github" | "other";
    deviceId?: string;
    nodeId?: string;
    appBundleId?: string;
    url?: string;
    locationHint?: "none" | "coarse" | "precise";
  };
  storage: {
    uri: string;
    sha256: string;
    encrypted: boolean;
    localOnly: boolean;
    byteSize?: number;
    mimeType?: string;
  };
  derivedFrom: RecordId[];
  consent: ConsentSnapshot;
  retention: RetentionClass;
  sensitivity: Sensitivity;
  redactionState: "raw" | "redacted" | "summary_only" | "deleted";
  metadata?: Record<string, unknown>;
};
```

Artifact invariants:

- `sha256` is required for replay and deduplication.
- Raw audio, images, and frames must not be retained longer than the active
  consent contract allows.
- Derived transcripts or captions must reference the source audio/frame.
- If an artifact is deleted, derived memories must either be deleted,
  downgraded, or marked as evidence-missing.

### MemoryCandidate

A memory candidate is not automatically durable memory. It is a claim or
commitment waiting for policy, evidence, and possibly user review.

```ts
type MemoryCandidate = {
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  claim: string;
  kind:
    | "preference"
    | "project_fact"
    | "commitment"
    | "routine"
    | "person_note"
    | "relationship_note"
    | "workflow_pattern"
    | "safety_note";
  subject: {
    type: "owner" | "person_candidate" | "confirmed_person" | "project" | "workspace" | "unknown";
    id?: RecordId;
  };
  status:
    | "observed"
    | "proposed"
    | "quarantined"
    | "confirmed"
    | "active"
    | "suppressed"
    | "expired"
    | "deleted";
  evidenceRefs: EvidenceRef[];
  confidence: number;
  sensitivity: Sensitivity;
  consent: ConsentSnapshot;
  retention: RetentionClass;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
    reviewer?: "owner" | "policy" | "agent";
    notes?: string;
  };
  influence: {
    usedInActionProposalIds: RecordId[];
    usedInResponseIds: RecordId[];
    lastUsedAt?: IsoTime;
  };
  expiresAt?: IsoTime;
  tombstoneReason?: string;
};
```

MemoryCandidate invariants:

- `active` requires evidence, consent, and policy approval.
- `person_note` and `relationship_note` cannot become `active` without user
  review.
- `quarantined` candidates may be searched for review, but must not influence
  action proposals.
- Rejected candidates must create suppression hints so the same weak claim does
  not reappear every session.

### ActionProposal

An action proposal is the bridge between ambient observation and tool execution.
It is the unit of approval, feedback, shadow autonomy, and regret review.

```ts
type ActionProposal = {
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  trigger: {
    type: "transcript" | "memory" | "time" | "place" | "manual" | "agent_inference";
    sourceIds: RecordId[];
  };
  title: string;
  rationale: string;
  proposedAction: {
    kind: "message" | "email" | "calendar" | "task" | "code" | "notification" | "tool_call";
    summary: string;
    toolNames: string[];
    sideEffectLevel: "none" | "draft" | "external_write" | "local_write" | "financial" | "identity_affecting";
  };
  evidenceRefs: EvidenceRef[];
  requiredContext: RecordId[];
  risk: {
    level: "low" | "medium" | "high" | "blocked";
    reasons: string[];
    dataEgress: "none" | "local_only" | "third_party" | "public";
  };
  preview: {
    humanReadable: string;
    diffUri?: string;
    recipients?: string[];
    memoryUpdates?: RecordId[];
    rollbackPlan?: string;
  };
  approval: {
    state: "shadow" | "needs_review" | "approved" | "edited" | "dismissed" | "executed" | "failed";
    approvedBy?: "owner" | "policy";
    decidedAt?: IsoTime;
  };
  autonomy: {
    level: "suggest" | "draft" | "execute_with_approval" | "execute_with_undo" | "never";
    policyId?: RecordId;
  };
  result?: {
    status: "not_run" | "success" | "failed" | "reverted";
    executedAt?: IsoTime;
    outputArtifactIds?: RecordId[];
  };
  feedback?: {
    value: "useful" | "wrong" | "too_sensitive" | "bad_timing" | "missed_context";
    notes?: string;
  };
};
```

ActionProposal invariants:

- Side-effectful proposals require preview and approval unless an explicit
  graduated autonomy policy exists.
- Proposals cannot rely on quarantined identity or relationship candidates.
- Shadow proposals must never execute.
- Feedback should update attention scoring and future proposal suppression.

### IdentitySignal

An identity signal is a clue, not a person. It can say "owner likely speaking"
or "same unknown voice cluster as before"; it must not silently create a durable
identity.

```ts
type IdentitySignal = {
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  signalType:
    | "owner_face_template"
    | "owner_voice_template"
    | "owner_present"
    | "owner_speaking"
    | "non_owner_face_cluster"
    | "non_owner_voice_cluster"
    | "heard_name"
    | "speaker_turn";
  subject: {
    type: "owner" | "unknown_cluster" | "person_candidate";
    id?: RecordId;
  };
  evidenceRefs: EvidenceRef[];
  confidence: number;
  thresholdUsed?: number;
  sensitivity: "biometric" | "sensitive" | "private";
  consent: ConsentSnapshot;
  storage: {
    templateUri?: string;
    encrypted: boolean;
    localOnly: boolean;
    keyRef?: string;
  };
  retention: RetentionClass;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
  };
  allowedUses: {
    tagSession: boolean;
    promoteMemory: boolean;
    proposeRelationship: boolean;
    exportContext: boolean;
    triggerAction: boolean;
  };
  expiresAt?: IsoTime;
};
```

IdentitySignal invariants:

- Owner face and voice templates are opt-in.
- Owner biometric templates are local-only and encrypted by default.
- Raw enrollment media should be deleted by default after template extraction.
- Non-owner clusters remain anonymous and expire unless promoted through review.
- `exportContext` is false for biometric signals by default.
- `triggerAction` is false for unreviewed non-owner signals.

### RelationshipCandidate

A relationship candidate is an inferred edge. It is not a fact until the user
confirms it.

```ts
type RelationshipCandidate = {
  id: RecordId;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  from: { type: "owner" | "confirmed_person" | "person_candidate"; id: RecordId };
  to: { type: "confirmed_person" | "person_candidate" | "project" | "organization"; id?: RecordId };
  edgeType:
    | "works_with"
    | "friend_of"
    | "met_at"
    | "introduced_by"
    | "reports_to"
    | "hiring_for"
    | "family"
    | "do_not_infer"
    | "unknown";
  claim: string;
  evidenceRefs: EvidenceRef[];
  supportingSignalIds: RecordId[];
  confidence: number;
  status: "candidate" | "confirmed" | "rejected" | "suppressed" | "expired" | "deleted";
  sensitivity: Sensitivity;
  consent: ConsentSnapshot;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
    correction?: string;
  };
  expiresAt?: IsoTime;
};
```

RelationshipCandidate invariants:

- A candidate relationship cannot influence reminders, action proposals, memory
  retrieval, or context export until confirmed.
- Rejected edges should suppress similar future edges unless new evidence is
  substantially stronger.
- `family`, health, romance, legal, and financial relationship edges should be
  treated as sensitive and require explicit confirmation.

### ContextVisa

A context visa is a scoped, expiring grant that lets another agent see a subset
of HaoClaw context.

```ts
type ContextVisa = {
  id: RecordId;
  createdAt: IsoTime;
  expiresAt: IsoTime;
  grantee: {
    agentName: string;
    client: "codex" | "claude" | "chatgpt" | "cursor" | "mcp_client" | "other";
    instanceId?: string;
  };
  purpose: string;
  requestedScopes: string[];
  grantedScopes: string[];
  deniedScopes: string[];
  includedRecordIds: RecordId[];
  redactionPolicy: {
    stripRawAudio: boolean;
    stripRawImages: boolean;
    stripBiometrics: boolean;
    stripUnconfirmedPeople: boolean;
    summarizeInsteadOfRaw: boolean;
  };
  approval: {
    state: "requested" | "approved" | "denied" | "revoked" | "expired";
    approvedBy?: "owner" | "policy";
    decidedAt?: IsoTime;
  };
  auditLog: {
    accessedAt: IsoTime;
    recordIds: RecordId[];
    query?: string;
  }[];
};
```

ContextVisa invariants:

- Visas expire by default.
- Context export must preview included and denied categories before approval.
- Raw biometric templates, unconfirmed people, quarantined candidates, and raw
  audio/images are denied by default.
- Every access through a visa must be audit-logged.

### Minimal Schema Gate

Before building new product surfaces, the repo should be able to create,
persist, and test these flows:

1. `Artifact -> MemoryCandidate -> active memory`.
2. `Artifact -> ActionProposal -> approval -> result`.
3. `Artifact -> IdentitySignal -> quarantined candidate -> reviewed person`.
4. `IdentitySignal -> RelationshipCandidate -> confirmed or rejected edge`.
5. `MemoryCandidate + ConsentSnapshot -> ContextVisa preview -> export`.
6. `Live session -> replay bundle -> prompt_test case`.

## Identity Risk Controls

Identity is the highest-risk part of this plan. It is also one of the most
useful parts if implemented conservatively. The product rule is:

> Owner recognition is allowed to anchor the agent's perspective. Non-owner
> recognition is quarantined until the user reviews it.

### Storage Rules

Owner templates:

- Owner face and voice templates are opt-in.
- Owner templates are local-only by default.
- Owner templates are encrypted at rest.
- Encryption keys should live in the platform secure store where available
  (Keychain/Secure Enclave on iOS, OS keychain on desktop).
- Raw enrollment media is deleted after template extraction unless the user
  explicitly chooses to retain it as an artifact.
- Owner templates are never included in MCP, context visas, logs, eval exports,
  or replay bundles.

Non-owner signals:

- Non-owner voice or face clusters are anonymous by default.
- Non-owner clusters should use opaque labels such as `voice_cluster_7`, not
  inferred names.
- Non-owner cluster templates are local-only unless a future explicit sharing
  policy is added.
- Non-owner clusters expire by default, initially `rolling_7d` for early testing
  and no more than `rolling_30d` without a reviewed person capsule.
- Non-owner clusters cannot trigger actions, promote memories, or export
  context until reviewed.

Heard names:

- Heard names are text candidates extracted from transcripts.
- Heard names must not be automatically joined to voice or face clusters.
- A heard name can suggest a review card, but not a confirmed person.
- Rejected heard-name mappings should create suppression records.

Relationship edges:

- Relationship edges are candidates until explicitly confirmed.
- Sensitive edges such as family, medical, romance, financial, legal, or
  employment hierarchy require explicit confirmation and shorter default
  retention.
- Relationship candidates must always show evidence and confidence.

### Confidence Thresholds

Initial thresholds should be conservative and adjustable through evals:

| Signal | Default behavior | Initial threshold |
| --- | --- | --- |
| Owner face match | Tag `owner-present` only | `>= 0.90` |
| Possible owner face | Show uncertain diagnostic only | `0.75 - 0.90` |
| Owner voice match | Tag `owner-speaking` only | `>= 0.85` |
| Possible owner voice | Show uncertain diagnostic only | `0.70 - 0.85` |
| Non-owner same voice cluster | Quarantine cluster candidate | `>= 0.80` |
| Heard name extraction | Create text candidate | `>= 0.70` |
| Relationship edge | Create candidate, never confirmed | no auto-confirm threshold |

Rules:

- Threshold misses should fail closed: unknown is better than false identity.
- Thresholds should be measured per environment because glasses audio, iPhone
  mic, room acoustics, and background noise will vary.
- If a signal is below threshold, it may appear in diagnostics but must not
  influence memory or action.

### Deletion Semantics

Deleting owner enrollment:

- Deletes owner face and voice templates.
- Deletes raw enrollment artifacts unless separately retained by user choice.
- Downgrades future owner identity state to unknown.
- Keeps a tombstone that prevents silent re-enrollment.
- Leaves past non-biometric session tags only if the user chooses to keep them;
  otherwise they should be deleted or downgraded to unknown.

Rejecting a non-owner cluster:

- Marks the cluster as rejected or suppressed.
- Prevents the same cluster from resurfacing as a new person suggestion unless
  stronger evidence appears.
- Deletes or expires local templates according to the active retention policy.

Deleting a person capsule:

- Deletes confirmed identity links.
- Deletes or suppresses associated relationship edges.
- Downgrades linked memories to anonymous or deletes them, depending on user
  choice.
- Adds a tombstone so the same person is not immediately recreated.

Revoking a context visa:

- Prevents future reads.
- Keeps the audit log.
- Does not delete the underlying records unless the user separately deletes
  them.

### Owner Enrollment UX

Owner enrollment must be explicit and reversible:

1. Explain why owner recognition exists: to identify whether the user is present
   or speaking, not to identify everyone else.
2. Ask for separate opt-in for face and voice.
3. Capture multiple samples with clear quality checks.
4. Show where templates are stored and whether they are local-only.
5. Show a test result such as "owner voice recognized" or "not enough signal."
6. Provide one-tap disable and delete.
7. Provide a diagnostic view for false positives and false negatives.

The UI should never imply that the system "knows" a non-owner person before
review. It should say "candidate", "unknown speaker", "heard name", or
"possible relationship."

### Logging And Export Rules

- Do not log biometric vectors, raw templates, or raw face crops.
- Do not put biometric identifiers in crash reports.
- Redact names from logs unless the log is an explicit local debug artifact.
- Replay bundles should include identity decisions and confidence, not biometric
  templates.
- Evals should use synthetic or user-approved fixtures.
- Context visas strip biometrics and unconfirmed people by default.

### Required Identity Tests

Before identity features are considered product-ready, add tests for:

- owner enrollment creates encrypted local-only templates,
- deleting enrollment removes templates and prevents silent re-enrollment,
- non-owner clusters cannot trigger actions,
- unreviewed relationship candidates cannot influence memory retrieval,
- rejected names or clusters do not immediately resurface,
- context visas strip biometric and unconfirmed-person data,
- replay bundles exclude raw templates,
- false-positive fixtures fail closed to unknown,
- lower confidence identity signals stay diagnostic-only.

## Voiceprint Research And Implementation Plan

This section expands the owner voice / speaker identity part of the ambient
agent plan. The goal is not biometric authentication. The goal is a conservative
identity signal that can answer:

- Is the owner likely speaking in this turn?
- Is this turn from an unknown recurring voice cluster?
- Which transcript spans and audio artifacts support that belief?
- Can the user inspect, correct, delete, or suppress that identity signal?

### One-Page Voiceprint Plan

Final product goal:

- Live keeps responding in real time.
- Voice identity arrives as quiet evidence shortly after each speech turn.
- HaoClaw stores auditable identity decisions and event participation, not raw
  voice templates.
- Owner identity can support memory/action only after policy allows it.
- Unknown speakers remain anonymous clusters until reviewed.
- Corrections update transcript tags, event participation, memory/action
  candidates, and learning fixtures.

Target dataflow:

```text
iPhone mic
  -> WebRTC RTP -> OpenAI Realtime -> assistant response
  -> local audio observation buffer / WAV -> voiceprint scorer
  -> HaoClaw transcript append -> identity annotation -> memory/action policy
```

Responsibility split:

| Layer | Owns | Must not do |
| --- | --- | --- |
| WebRTC Realtime | Low-latency audio, assistant response, Realtime events | Wait for voiceprint or receive biometric templates |
| iOS Live | Audio observation, turn windows, short ring buffer, UI annotations | Add a third mic tap or run heavy diarization |
| Voiceprint scorer | Embeddings, owner verification, cluster checks | Auto-name bystanders or overwrite templates from guesses |
| HaoClaw | Transcript, memory/action/event graph, policy, review state | Store raw owner templates in general memory/export surfaces |

First implementation should be conservative:

1. Use saved Live WAV files and a Mac/HaoClaw sidecar to score owner similarity.
2. Gate capture and biometric consent before loading/decrypting owner voice
   templates or invoking the sidecar.
3. Add explicit owner voice enrollment with local-only encrypted templates.
4. Attach `owner_speaking`, `possible_owner`, or `unknown_speaker` to transcript
   turns after speech stop.
5. Store `SpeakerTurnTag`, `IdentitySignal`, and `EventParticipation` in HaoClaw
   with evidence refs and allowed uses.
6. Add review primitives before non-owner naming: split, merge, suppress,
   mark media/background, and undo.
7. Add learning only through shadow templates and eval-based promotion.

Success criteria:

- Assistant response latency does not regress.
- Owner verification normally annotates a turn within 0.5-2s when the gateway is
  reachable and the phone is not under thermal pressure.
- If scoring fails, the system stays at `unknown_speaker`.
- `possible_owner` is diagnostics-only.
- Non-owner voice clusters cannot trigger memory/action/export without review.
- Deleting owner enrollment removes templates and prevents silent re-enrollment.

Current implementation status:

- V0 fixture and scoring foundation is in place locally. The scaffold includes
  manifest validation, conservative threshold reporting, explicit baseline audio
  fixtures, sidecar materialization, model metadata checks, invalid-dimension
  rejection, and zero-norm owner centroid rejection.
- V1 storage contract foundation is partially in place. `SpeakerTurnTag`,
  `IdentitySignal`, `TranscriptSpeakerAnnotation`, and `EventParticipation`
  records exist with stable ids, consent gates, allowed-use policy, separate
  review gates for owner template learning and unknown clusters, and first
  review/correction primitives for confirming clusters, rejecting identity, and
  suppressing identity. A storage-ready voiceprint bundle/applicator now groups
  transcript identity states, speaker tags, identity signals, transcript
  annotations, event participation, and stale identity clears for one Live
  session. The first session-scoped gateway RPC contract,
  `identity.voiceprint.apply_bundle`, exists locally and applies a bundle only
  to the bound session. The RPC now has an initial file-backed durable storage
  adapter under the local state directory, with atomic writes and reload tests.
  The first owner template artifact contract is also in place: enrollment
  sources are validated for usable embeddings, consistent dimensions, minimum
  speech duration, local-only encrypted storage refs, model metadata,
  thresholds, deterministic ids, tombstone semantics, and scorer-safe owner
  embedding extraction. A local encrypted owner template artifact file envelope
  is now in place with AES-GCM payload encryption, restricted file permissions,
  keyRef validation, tamper detection, gateway scorer loading, and a first
  server-side file source that resolves a restricted local template key file
  without returning raw key material to clients. Durable DB migration,
  enrollment UI, full production key rotation, and review UI are not started.
- V2 live dataflow foundation is in place locally. Finalized speech turns can
  be assembled from speech windows, transcript item ids, and audio artifact
  refs, then pass through quality gating, consent gating, sidecar job creation,
  batch scoring, transcript identity state patches, stale-update protection,
  storage bundles, and a one-step plan runner that returns
  resolved/skipped/error states without blocking WebRTC. A first Realtime event
  adapter now maps speech start/stop, input transcript completion, assistant
  transcript completion, and local recording artifacts into the turn tracker.
  Gateway RPC methods now buffer those events per bound Live session and return
  finalized turn candidates without exposing raw samples. A server-side
  `identity.voiceprint.score_turns` RPC now bridges finalized turn refs into the
  scoring plan and storage bundle applicator when the gateway has an explicitly
  configured scorer, validated owner template artifact or encrypted local owner
  template file, consent snapshot, and allowed audio roots. Gateway startup now
  resolves a disabled-by-default `voiceprint.live_scoring` config section into
  a server-side scorer using sidecar command, local owner template file source,
  allowed audio roots, expected model, thresholds, quality gates, and explicit
  consent. `score_turns` short-circuits denied consent before loading or
  decrypting owner templates. The gateway also has a first audio-artifact
  registry: finalized local media ids can be registered to a session-scoped
  voiceprint artifact, realtime audio events are rewritten to the gateway-local
  canonical WAV path, and `score_turns` can score by artifact id without
  trusting a client-supplied phone-local `audioPath`. The registry is
  segment-aware: uploaded rolling WAV segments can carry recording-relative
  start/end offsets, and scoring converts transcript turn windows into
  segment-relative sidecar request bounds. Direct owner embeddings remain only
  as a test/backcompat fallback.
  The RPC reads only configured local audio roots, slices the turn window for
  quality gating, runs the sidecar, stores the resulting identity states, and
  does not return raw embeddings to the client. The iOS bridge now has
  typed contracts for `identity.voiceprint.realtime_event` /
  `identity.voiceprint.realtime_reset`, parses Realtime raw events, serializes
  speech/transcript/artifact events in order, and derives turn-scoped artifact
  ids from `LiveRecordingSink` WAV refs. The iOS bridge now derives
  recording-relative `audio_start_ms`/`audio_end_ms` from the active recording
  sink timeline when the Realtime/Pipecat event does not provide offsets. The
  gateway and bridge both refuse to synthesize missing offsets from wall-clock
  time; turns without a recording timeline remain unfinalizable. This path is
  behind a disabled-by-default `voiceprintRealtimeEnabled` config flag until
  owner enrollment and biometric consent UI explicitly turn it on.
- Since 2026-06-23, the memory-side gate landed (`89d76ab`): person-derived
  distillation now produces quarantined `MemoryCandidate` records and reads a
  bounded person snapshot, so the V5 policy target — voice identity
  influencing memory only where policy allows — has its memory-side
  enforcement in place before any voiceprint tag is allowed to matter.
- Remaining before product wiring: connect iOS live/deferred upload responses
  to the new segment-aware voiceprint audio-artifact registry, owner enrollment
  UI and template store, durable DB migrations, real SpeechBrain or WeSpeaker
  sidecar packaging, split/merge review primitives, a config UI for explicit
  biometric consent, and end-to-end Live integration tests.
- Rethink (2026-07-02): this section's research questions are answered and its
  foundation is built; treat what remains as product work (enrollment,
  consent, lifecycle, review surface), not model work. The review surface
  should not be voiceprint-specific — voiceprint review records are one of
  the record kinds in the unified review ledger (refactor plan PR 3).

Read the detailed design below in this order:

1. Research and model choice.
2. Recent open-source implementation lessons.
3. Implementation recommendation.
4. Voiceprint before and after dataflow.
5. Final target dataflow.
6. Final product shape.
7. Live mode sequence.
8. HaoClaw storage and event participation.
9. Latency and mobile performance budget.
10. Policy interaction.
11. Pipeline, learning loop, data model, and phased implementation.

### Research And Model Choice

Screenpipe is a useful near-term reference because its product need is close to
ours: local capture, timeline transcripts, and speaker identification. Issue
[#2253](https://github.com/screenpipe/screenpipe/issues/2253) proposes adding
voice training to onboarding: ask for the user's name, have them read aloud for
30 seconds, then trigger `trainVoice(name, startTime, endTime)` in the
background. The linked implementation commit
[`2a4993e`](https://github.com/screenpipe/screenpipe/commit/2a4993e5c2cb85efe87375c5c2af8c1309129de0)
uses a pragmatic pipeline: look back two minutes, poll the local search API for
input-device audio for up to ten minutes, then reassign matching audio chunks
with `propagate_similar: true`.

That confirms a useful onboarding pattern, but HaoClaw should not copy the
identity semantics directly. In HaoClaw, a user's typed name must not make an
unreviewed biometric identity durable. The typed name can label the owner
profile only after explicit opt-in; non-owner voices remain anonymous clusters.

The main model/tool options:

| Option | Fit | Notes |
| --- | --- | --- |
| SpeechBrain ECAPA-TDNN | Fastest POC for owner verification | The `speechbrain/spkrec-ecapa-voxceleb` model extracts speaker embeddings and uses cosine distance for speaker verification; the model card says it expects 16 kHz mono and reports 0.80% EER on VoxCeleb1-test cleaned, while warning that performance is not guaranteed on other datasets ([model card](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)). |
| pyannote.audio | Best baseline for diarization and speaker turns | `pyannote.audio` provides speaker diarization, VAD, speaker change detection, overlapped speech detection, and speaker embedding; its `community-1` pipeline runs locally after model access setup, while premium `precision-2` runs on pyannoteAI servers ([pyannote.audio](https://github.com/pyannote/pyannote-audio)). |
| WeSpeaker | Strong production/research toolkit, especially if multilingual or Chinese speech matters | WeSpeaker focuses on speaker embedding learning and supports embedding extraction, similarity, and diarization through CLI/Python APIs; it also has runtime/deployment work and multiple newer frontends ([WeSpeaker](https://github.com/wenet-e2e/wespeaker)). |
| Picovoice Eagle | Best iOS/on-device commercial candidate | Picovoice lists Eagle as a streaming speaker recognition SDK with iOS support and benchmarks against pyannote and SpeechBrain ([Eagle docs](https://picovoice.ai/docs/eagle/)). This is attractive for true mobile streaming, but licensing and vendor lock-in need review. |
| Custom Core ML model | Best long-term control, worst first slice | Worth revisiting after the gateway/local POC proves thresholds, artifact alignment, and privacy UX. |

Privacy baseline: Apple treats transmitted data as collected if it is sent off
device and retained beyond what is needed for a real-time request; biometric
data is sensitive info, voice recordings are audio data, and on-device-only
processing is not "collected" for App Privacy answers unless derived data is
sent off device ([Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)).
This strongly favors local-only templates and explicit disclosure for any
gateway, cloud, or third-party SDK path.

### Recent Open-Source Implementation Lessons

Checked on 2026-06-23. The recent PRs below matter because they show where
speaker systems fail in real products: over-merged speakers, echo duplication,
GPU worker contention, missing stable utterance ids, long-audio memory blowups,
and auto-created person records.

| Project / PR | Signal | Implication for HaoClaw |
| --- | --- | --- |
| screenpipe [#4292](https://github.com/screenpipe/screenpipe/pull/4292) speaker cleanup design | Over-merged speaker groups are expected in noisy real-world capture. The proposed product answer is split, auto-split, ignore-media/background, evidence frames, and undo. | Add speaker cleanup/review as a required product surface, not a later nice-to-have. Voice clusters need split/merge/suppress/undo primitives from the start. |
| screenpipe [#4440](https://github.com/screenpipe/screenpipe/pull/4440) acoustic-loopback dedup | Laptop speakers can cause the same remote utterance to appear as both mic input and system output. The PR uses tight cross-direction gates: opposite direction, 1.5s, min 4 words, Jaccard >= 0.85. | Add assistant/loopback leakage detection before voice learning. Echoed assistant/remote speech must never train owner templates or create owner memories. |
| screenpipe [#4379](https://github.com/screenpipe/screenpipe/pull/4379) software AEC | AEC depends on aligned far-end reference audio; verified DSP engine is separate from production wiring because real timing must be validated on device. | Keep AEC/echo mitigation as a measured audio-stage concern. Do not assume Apple's voice processing or one model score removes leakage risk. |
| screenpipe [#4215](https://github.com/screenpipe/screenpipe/pull/4215) meeting state flapping | Audio-sustained meetings can flap between active/ending unless audio state and UI-control state are modeled explicitly. | Voiceprint enrichment should not define session state by itself. Keep Live/session lifecycle, audio evidence, and identity enrichment separate. |
| screenpipe [#3233](https://github.com/screenpipe/screenpipe/pull/3233) duplicate speaker names | Name-based speaker dedup can conflict with embedding distance, especially with loopback artifacts. | In HaoClaw, heard names should stay candidates. Exact-name collisions can suggest review but must not auto-link non-owner people. |
| Omi [#8082](https://github.com/BasedHardware/omi/pull/8082) built-in WeSpeaker embeddings | Moving embeddings local to the batch transcriber reduced external HTTP calls and latency; it also introduced model/runtime coupling. | A gateway sidecar is a good first step, but make embedding worker ownership explicit and test fallback paths. |
| Omi [#8117](https://github.com/BasedHardware/omi/pull/8117) CUDA stream conflict | Built-in embedding collided with ASR CUDA graph capture in production; fix serialized embedding through the GPU worker and added DER/WER/concurrency gates. | If HaoClaw uses GPU models, isolate voiceprint jobs from ASR/realtime work with a queue and concurrency tests. Do not let embedding inference run ad hoc on shared GPU streams. |
| Omi [#7701](https://github.com/BasedHardware/omi/pull/7701) NumPy cosine helper | Speaker matching needed a shared cosine-distance helper and safe zero-vector behavior. | Centralize similarity math and define zero/invalid embedding behavior as "maximum non-match." |
| Omi [#7574](https://github.com/BasedHardware/omi/pull/7574) auto-create speakers flag | A stored "Auto-create Speakers" preference did not actually stop backend person creation until a separate `create_speakers` flag was threaded end-to-end. | Separate capability flags from user consent. Non-owner person creation must default to manual review unless explicitly enabled. |
| pyannote.audio [#1996](https://github.com/pyannote/pyannote-audio/pull/1996) embedding extraction optimization | Diarization speed is dominated by embedding extraction; split frame/embedding APIs and mixed precision can make large gains. | Treat full diarization as a gateway/background optimization target. Owner verification can be much simpler than full diarization. |
| pyannote.audio [#1992](https://github.com/pyannote/pyannote-audio/pull/1992) GPU/MPS memory-safe batching | Long-file diarization can spike CPU RAM/VRAM; optimized batching made memory predictable and improved CUDA/MPS speed. | Add memory/latency budgets and long-audio tests before relying on background diarization. |
| WhisperX [#1338](https://github.com/m-bain/whisperX/pull/1338) interval-tree speaker assignment | Assigning words to speakers with nested loops became a major bottleneck; interval indexing produced a reported 228x speedup on a test case. | Use interval/range indexes for transcript span to speaker tag/event participation joins from day one. |
| WhisperX [#1373](https://github.com/m-bain/whisperX/pull/1373) separate diarization device | Transcription and diarization have different device support; Apple Silicon can run diarization on MPS even if transcription stays CPU. | Keep voiceprint/diarization device routing independent from the Realtime or transcription device. |
| WhisperX [#1349](https://github.com/m-bain/whisperX/pull/1349) pyannote v4/community-1 migration | Diarization APIs and model terms change; default model changed to `speaker-diarization-community-1`. | Pin model/version metadata in `VoiceprintTemplate` and `SpeakerTurnTag`, and keep migration paths explicit. |
| WhisperX [#1221](https://github.com/m-bain/whisperX/pull/1221) long-audio temp files | Long audio can OOM during load; chunking helps, but chunking can produce inconsistent speaker ids across parts. | If HaoClaw chunks long sessions, add cross-chunk cluster reconciliation and stable cluster ids. |
| LiveKit Agents [#6127](https://github.com/livekit/agents/pull/6127) transcript `item_id` | Realtime transcript deltas without a stable utterance key made dedup and one-per-utterance reactions difficult. | `transcriptItemId` is a first-class join key for Live, voiceprint annotations, and HaoClaw event graph. |
| LiveKit Agents [#6104](https://github.com/livekit/agents/pull/6104) Deepgram diarization model option | Providers expose different streaming/batch diarization options; V2 may be batch-only. | Model/provider capability must be explicit. Do not assume streaming and batch identity features are equivalent. |
| Pipecat [#4718](https://github.com/pipecat-ai/pipecat/pull/4718) diarization defaults | Missing diarization defaults caused incomplete service settings until tested. | Add config completeness tests for voice identity flags, thresholds, and max-speaker limits. |

Plan adjustments from this scan:

- Add a speaker cleanup/review surface to the owner identity roadmap:
  split cluster, merge cluster, mark media/background, suppress, undo, and
  evidence preview.
- Add loopback/assistant-leakage gates before learning:
  opposite-source duplicate checks where available, near-simultaneous text
  overlap, min-word gates, output-audio timing, and route metadata.
- Add worker isolation:
  voiceprint jobs should use an explicit sidecar/queue, with concurrency tests
  if they share GPU or model runtime with ASR/transcription.
- Make `transcriptItemId` mandatory wherever possible:
  transcript append, speaker annotation, event participation, learning sample,
  replay bundle, and correction records should join through stable ids.
- Use interval/range indexes for all transcript-span joins.
- Separate consent from capability:
  "can auto-assign speakers" and "may create person records" are different
  flags.
- Keep non-owner auto-creation off by default:
  unknown clusters and heard names create review candidates only.
- Add long-session resilience:
  chunked processing must reconcile speaker ids across chunks, or those ids
  remain local to the chunk and cannot become durable person facts.
- Extend tests beyond model accuracy:
  include loopback duplicates, over-merged speakers, rejected corrections,
  worker concurrency, config defaults, and long-audio memory behavior.

### Reference Materials

Reference scan date: 2026-06-23.

Primary implementation references:

- screenpipe issue:
  [onboarding voice training #2253](https://github.com/screenpipe/screenpipe/issues/2253).
- screenpipe commit:
  [2a4993e voice training implementation](https://github.com/screenpipe/screenpipe/commit/2a4993e5c2cb85efe87375c5c2af8c1309129de0).
- screenpipe PR:
  [#4292 speaker cleanup design](https://github.com/screenpipe/screenpipe/pull/4292).
- screenpipe PR:
  [#4440 acoustic-loopback transcript dedup](https://github.com/screenpipe/screenpipe/pull/4440).
- screenpipe PR:
  [#4379 software AEC engine](https://github.com/screenpipe/screenpipe/pull/4379).
- screenpipe PR:
  [#4215 meeting state flapping with audio](https://github.com/screenpipe/screenpipe/pull/4215).
- screenpipe PR:
  [#3233 duplicate speaker names across dissimilar voices](https://github.com/screenpipe/screenpipe/pull/3233).
- Omi PR:
  [#8082 built-in WeSpeaker embeddings](https://github.com/BasedHardware/omi/pull/8082).
- Omi PR:
  [#8117 CUDA stream conflict and embedding worker isolation](https://github.com/BasedHardware/omi/pull/8117).
- Omi PR:
  [#7701 NumPy cosine distance helper](https://github.com/BasedHardware/omi/pull/7701).
- Omi PR:
  [#7574 respect Auto-create Speakers setting end-to-end](https://github.com/BasedHardware/omi/pull/7574).
- pyannote.audio PR:
  [#1996 optimize embedding extraction in SpeakerDiarization](https://github.com/pyannote/pyannote-audio/pull/1996).
- pyannote.audio PR:
  [#1992 GPU/MPS memory-safe diarization batching](https://github.com/pyannote/pyannote-audio/pull/1992).
- WhisperX PR:
  [#1338 interval-tree speaker assignment](https://github.com/m-bain/whisperX/pull/1338).
- WhisperX PR:
  [#1373 separate diarization device](https://github.com/m-bain/whisperX/pull/1373).
- WhisperX PR:
  [#1349 pyannote v4 / community-1 migration](https://github.com/m-bain/whisperX/pull/1349).
- WhisperX PR:
  [#1221 long-audio temp-file loading](https://github.com/m-bain/whisperX/pull/1221).
- LiveKit Agents PR:
  [#6127 expose transcript item_id](https://github.com/livekit/agents/pull/6127).
- LiveKit Agents PR:
  [#6104 Deepgram diarize_model / V2 diarization option](https://github.com/livekit/agents/pull/6104).
- Pipecat PR:
  [#4718 NVIDIA segmented STT diarization defaults](https://github.com/pipecat-ai/pipecat/pull/4718).

Model and toolkit references:

- SpeechBrain model card:
  [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb).
- pyannote.audio:
  [speaker diarization toolkit](https://github.com/pyannote/pyannote-audio).
- WeSpeaker:
  [speaker embedding / verification / diarization toolkit](https://github.com/wenet-e2e/wespeaker).
- Picovoice Eagle:
  [streaming speaker recognition SDK](https://picovoice.ai/docs/eagle/).

Platform/privacy reference:

- Apple:
  [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/).

### Review After Reference Scan

The core architecture still holds:

- WebRTC should remain the low-latency speech path.
- Voiceprint should stay a side-channel enrichment pipeline.
- HaoClaw should store evidence-backed identity decisions and event
  participation, not raw biometric templates.
- Owner verification should ship before full diarization or non-owner naming.
- Non-owner identity should remain review-first and anonymous by default.

The scan strengthens these constraints:

- Speaker cleanup is required for product trust. Over-merged clusters are a
  normal failure mode, not an edge case.
- Echo and loopback must be treated as identity-poisoning risks. Leakage gates
  belong before learning, not after.
- Stable utterance ids are foundational. Without `transcriptItemId`, replay,
  annotation, correction, and learning become brittle.
- Background diarization can become CPU/RAM/GPU-bound. It needs worker queues,
  memory budgets, and long-audio tests before it can influence durable memory.
- Consent flags must be end-to-end. UI preferences that are not passed to the
  backend are privacy bugs.

Current remaining gaps before implementation:

- Define concrete HaoClaw RPC names:
  `voiceprint.enroll`, `voiceprint.score_turn`,
  `transcript.annotate_speaker`, and `identity.review`.
- Define the first storage migration for `VoiceprintTemplate`,
  `SpeakerTurnTag`, `IdentitySignal`, and `EventParticipation`.
- Define `LiveVoiceTurnTracker` on iOS with monotonic timestamps and
  `transcriptItemId` joins.
- Choose the first sidecar model and dependency path: SpeechBrain ECAPA-TDNN or
  WeSpeaker.
- Add the first fixture corpus and benchmark script before UI work.

### Implementation Recommendation

Build the first version as a local/gateway POC, not as an in-Realtime feature
and not as authentication.

Recommended first stack:

- SpeechBrain ECAPA-TDNN or WeSpeaker in a local sidecar for owner verification.
- pyannote.audio only when we need full diarization or overlapped-speaker
  handling.
- Picovoice Eagle as a separate iOS spike if we decide the owner-speaking tag
  must happen fully on-device and near real time.

Reasoning:

- The current OpenAI Realtime WebRTC path owns its media stream; the app already
  has a parallel mic recording path for WebRTC providers through
  `MicAudioSource`, `LiveRecordingSink`, and local WAV artifacts.
- Speaker embeddings are easiest to validate from local WAV segments first.
- The product risk is false identity and privacy, not model availability.
- A post-turn or near-real-time tag is enough for memory/action gating; it does
  not need to interrupt the active speech loop.

### Voiceprint Before And After Dataflow

This is the practical delta from today's Live flow to the voiceprint-enabled
flow. The important change is not putting speaker recognition inside WebRTC.
The change is adding an identity enrichment loop after a speech turn exists,
then letting HaoClaw decide what that identity signal is allowed to influence.

Before voiceprint, Live has two main paths:

```text
Mic audio
  -> OpenAI Realtime WebRTC
  -> assistant audio / data-channel events
  -> transcript item
  -> HaoClaw transcript append
  -> text-only memory/action/event candidates
```

The pre-voiceprint behavior:

- Realtime owns the low-latency conversation loop.
- iOS receives transcript/tool events and appends transcript turns to HaoClaw.
- HaoClaw can reason from text, explicit user actions, session context, and
  app metadata.
- "Who said this?" is either unknown, manually implied, or inferred from a
  coarse session assumption.
- Memory/action candidates should stay conservative when the actor matters,
  because there is no audio-backed speaker evidence.

After voiceprint, the low-latency path stays the same and a third enrichment
path is added:

```text
Mic audio
  -> OpenAI Realtime WebRTC
  -> assistant audio / data-channel events
  -> transcript item with transcriptItemId
  -> HaoClaw transcript append with identityStatus: "pending"

Same mic observation stream
  -> timestamped speech window
  -> short audio segment / WAV artifact ref
  -> voiceprint scorer
  -> SpeakerTurnTag + IdentitySignal
  -> HaoClaw transcript speaker annotation
  -> EventParticipation / MemoryCandidate / ActionProposal policy gate
```

The post-voiceprint behavior:

- WebRTC still answers immediately and never waits for speaker verification.
- `LiveVoiceTurnTracker` joins Realtime speech events, transcript completion,
  local audio timestamps, and artifact refs into one `SpeechTurn`.
- The scorer works on bounded post-turn segments, not the open WebRTC stream.
- HaoClaw receives the transcript first, then receives a later annotation for
  the same `transcriptItemId`.
- Memory/action/event graph updates happen only after consent and policy
  checks.
- Corrections can walk back dependent event participation, memory candidates,
  action proposals, and learning samples.

The data contracts change like this:

```text
Before:
  Realtime event
    -> TranscriptAppend
    -> MemoryCandidate / ActionProposal

After:
  Realtime event
    -> TranscriptAppend(identityStatus: pending)
    -> SpeechTurn(transcriptItemId, startMs, endMs, audioArtifactRef)
    -> SpeakerTurnTag
    -> IdentitySignal
    -> TranscriptSpeakerAnnotation
    -> EventParticipation
    -> MemoryCandidate / ActionProposal after policy
```

State transition per user turn:

```text
new user turn
  -> transcript_pending
  -> transcript_appended_identity_pending
  -> voiceprint_scoring
  -> identity_resolved | identity_unknown | identity_rejected
  -> policy_allowed_use | diagnostics_only | review_required
```

The storage delta is also explicit:

| Area | Before voiceprint | After voiceprint |
| --- | --- | --- |
| Live UI | transcript and assistant response | transcript first, optional late speaker tag |
| iOS audio | WebRTC plus recording when enabled | same source plus short observation/ring buffer |
| HaoClaw transcript | text turns | text turns with pending/resolved identity state |
| HaoClaw event graph | actor often unknown or text-inferred | actor can be owner/unknown cluster/confirmed person with evidence |
| Memory/action | text and explicit app context | identity-aware only when policy allows |
| Learning | no owner voice adaptation | shadow-template samples with review/eval promotion |
| Privacy | no biometric template path | encrypted local template, no raw template in general memory/export |

What must not change:

- The assistant response path must stay fast.
- WebRTC must not receive owner templates or biometric vectors.
- The phone must not add another microphone tap.
- `possible_owner` and `unknown_cluster` must not silently become durable
  person facts.
- A deleted enrollment must remove templates and block silent re-enrollment.

### Final Target Dataflow

The final system should have three interacting paths. They share stable ids and
evidence references, but they should not block each other.

```text
                           ┌─────────────────────────────┐
                           │        iOS Live Mode         │
                           │                             │
Mic audio chunks ──────────┼─► WebRTC RTP ───────────────┼─► OpenAI Realtime
                           │                             │   low-latency speech
                           │◄─ data-channel events ──────┼── transcripts/tools
                           │                             │
                           │─► audio observation buffer ─┼─► Voiceprint scorer
                           │   local ring buffer / WAV   │   local/gateway only
                           │                             │
                           │─► JSON-RPC/WebSocket ───────┼─► HaoClaw gateway
                           │                             │   memory/tools/actions
                           └─────────────────────────────┘
```

The paths:

1. WebRTC realtime path:
   - owns low-latency user audio, assistant audio, Realtime data-channel events,
     and tool-call transport;
   - must not wait for voiceprint scoring;
   - receives no owner voice template and no biometric vector.
2. HaoClaw control and memory path:
   - owns boot context, durable transcript append, memory candidates, action
     proposals, event graph, replay bundles, and policy decisions;
   - may receive identity annotations after the transcript is appended;
   - stores identity decisions and evidence refs, not raw voice templates.
3. Voiceprint identity path:
   - reads local audio evidence and speech turn windows;
   - produces `SpeakerTurnTag`, `IdentitySignal`, and learning candidates;
   - feeds HaoClaw only after policy gating.

The key design rule:

> WebRTC answers now. Voiceprint enriches shortly after. HaoClaw remembers only
> policy-allowed identity facts with evidence.

### Final Expected Product Shape

When this work is done, voice identity should feel like quiet evidence in Live,
not like a separate biometric product.

The owner-facing experience:

```text
Live session starts
  -> assistant responds normally through Realtime voice
  -> transcript turns appear immediately
  -> speaker identity starts as pending/unknown
  -> owner-speaking labels appear shortly after each turn when confident
  -> uncertain labels stay hidden or diagnostic-only
  -> memory/action cards cite who said what with evidence
  -> user can correct a label and see dependent memories/actions update
```

In the main Live UI, the default should stay simple:

```text
You: 明天幫我提醒要買牛奶
Assistant: 好，我會先準備一張提醒卡給你確認。
```

The detailed evidence view can show the identity layer:

```text
Speaker: owner_speaking
Confidence: 0.89
Source: iPhone mic, 00:12.4-00:15.9
Use: transcript display, memory candidate, action proposal
Not allowed: context export, template update
```

If the signal is weak:

```text
Speaker: possible_owner
Confidence: 0.74
Use: diagnostics only
Result: memory/action treats this as unknown_speaker
```

If another recurring voice appears:

```text
Speaker: unknown_cluster_7
Confidence: 0.82
Use: review only
Suggested review: "This voice appeared in 3 conversations this week."
```

The Memory / Action surfaces should show identity as evidence, not as an
unquestioned fact:

```text
Action proposal
  Title: Remind me to buy milk tomorrow
  Actor: owner_speaking, 0.89 confidence
  Evidence: transcript item + audio segment
  Approval: required
```

The People / Relationship review surface should avoid auto-naming:

```text
Review candidate
  Heard name: Kevin
  Nearby voice: unknown_cluster_7
  Evidence: 4 transcript spans, 2 meetings
  Choices: link to person, keep separate, suppress, delete
```

The Learning surface should make adaptation inspectable:

```text
Owner voice learning
  12 high-quality owner samples queued
  2 rejected samples used as negative fixtures
  Shadow template improves false rejects without increasing false accepts
  Action: promote / keep testing / discard
```

End-state behavior:

- Live voice remains fast even when voice identity is unavailable.
- Voice labels can arrive late and update the transcript without disrupting the
  conversation.
- HaoClaw can answer "who said this?" only with confidence, evidence, and review
  state.
- A memory or action card can say "owner said X" only if policy allowed the
  owner identity signal for that use.
- Unknown speakers can recur as clusters, but names and person links require
  review.
- Corrections propagate through transcript tags, event participation, memory
  candidates, action proposals, and learning fixtures.
- Deleting owner enrollment removes the template and prevents silent
  re-enrollment.

Golden demo:

1. The owner enrolls voice with a 30-45 second read-aloud sample.
2. The owner starts Live and says, "明天提醒我買牛奶."
3. The assistant responds immediately through WebRTC.
4. The transcript first lands in HaoClaw with `identityStatus: "pending"`.
5. Within a short delay, the turn is annotated as `owner_speaking`.
6. HaoClaw creates an action proposal that cites the transcript and audio
   evidence.
7. The user corrects one later false owner label to `unknown_speaker`.
8. Dependent event participation is downgraded, any affected memory/action is
   rechecked, and the segment becomes a negative learning fixture.

### Live Mode Sequence

Session startup:

```text
iOS LiveSessionStore.start()
  -> HaoClaw bridge preflight and boot_context
  -> load owner voice enrollment metadata and policy
  -> start audio observation buffer if voice identity is enabled
  -> start Live recording when mediaPersistenceMode allows it
  -> connect OpenAI Realtime WebRTC
  -> send Realtime session.update with persona/tools/context
```

User turn:

```text
mic audio
  -> WebRTC RTP to OpenAI Realtime
  -> local timestamped audio chunks
  -> optional retained WAV artifact

OpenAI events
  -> input_audio_buffer.speech_started
  -> input_audio_buffer.speech_stopped
  -> conversation.item.input_audio_transcription.completed

iOS Turn Assembly
  -> SpeechTurn(itemID, transcript, startMs, endMs, audioArtifactRef, route)
```

Post-turn enrichment:

```text
SpeechTurn + audio segment
  -> quality gate
  -> speaker embedding
  -> owner verification
  -> anonymous non-owner cluster check
  -> SpeakerTurnTag
  -> IdentitySignal
  -> policy gate
  -> transcript annotation / event participation / learning candidate
```

HaoClaw should receive transcript first with identity pending:

```ts
type TranscriptAppend = {
  sessionKey: string;
  turns: {
    role: "user" | "assistant";
    text: string;
    ts: IsoTime;
    transcriptItemId?: string;
    evidenceRefs?: EvidenceRef[];
    identityStatus?: "pending" | "not_applicable" | "resolved";
  }[];
};
```

Then voiceprint can annotate the same transcript item:

```ts
type TranscriptSpeakerAnnotation = {
  sessionKey: string;
  transcriptItemId: string;
  speakerTurnTagId: RecordId;
  identitySignalId: RecordId;
  result:
    | "owner_speaking"
    | "possible_owner"
    | "unknown_speaker"
    | "unknown_cluster"
    | "confirmed_person";
  confidence: number;
  thresholdUsed: number;
  evidenceRefs: EvidenceRef[];
  allowedUses: {
    diagnostics: boolean;
    transcriptDisplay: boolean;
    memoryPromotion: boolean;
    actionProposal: boolean;
    eventGraph: boolean;
    contextExport: boolean;
    templateLearning: boolean;
  };
};
```

### What HaoClaw Stores

HaoClaw should store identity decisions and event participation, not biometric
templates.

Store in HaoClaw:

- transcript item ids,
- audio artifact refs and transcript ranges,
- `SpeakerTurnTag` metadata,
- `IdentitySignal` metadata,
- confirmed person links,
- anonymous voice cluster ids,
- event participation claims,
- review/correction state,
- policy decisions and allowed uses,
- learning sample metadata.

Do not store in general HaoClaw memory/MCP/export surfaces:

- raw voice embeddings,
- owner voice templates,
- raw enrollment audio by default,
- unredacted biometric vectors,
- non-owner templates without explicit future policy.

Event participation should be represented separately from transcript text:

```ts
type EventParticipation = {
  id: RecordId;
  eventId: RecordId;
  actor:
    | { type: "owner" }
    | { type: "confirmed_person"; personId: RecordId }
    | { type: "unknown_cluster"; clusterId: RecordId }
    | { type: "unknown_speaker" };
  role: "speaker" | "participant" | "mentioned" | "actor" | "observer";
  claim: string;
  evidenceRefs: EvidenceRef[];
  supportingSignalIds: RecordId[];
  confidence: number;
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
  };
  allowedUses: {
    memoryPromotion: boolean;
    actionProposal: boolean;
    contextExport: boolean;
  };
};
```

Examples:

- `owner` said "remember to buy milk" -> can create a memory/action candidate if
  policy allows.
- `unknown_cluster_7` participated in meeting -> can remain a reviewable event
  fact, but cannot name the person or trigger action.
- heard name `"Kevin"` near `unknown_cluster_7` -> creates a candidate mapping,
  not a confirmed person.

### Latency Model

Voice identity does not need one latency target. Use three tiers:

| Tier | Target | Use |
| --- | --- | --- |
| Realtime WebRTC | sub-second path controlled by OpenAI Realtime | assistant response, interruption, tool-call loop |
| Fast owner verification | usually post-turn, target 0.5-2s after speech stop | owner/possible/unknown transcript tag, memory/action gating |
| Slow diarization/clustering | background, session-level | recurring unknown clusters, meeting/event refinement, review cards |

Rules:

- The assistant must not wait for speaker verification before responding.
- Transcript append may happen with `identityStatus: "pending"`.
- Memory promotion and action proposal may wait for identity resolution when the
  proposal depends on who spoke.
- If scoring is late or unavailable, fail closed to `unknown_speaker`.
- If HaoClaw is offline, iOS may keep local pending annotations and sync later;
  Realtime voice should continue if bridge is not required.

### Mobile Performance Budget

The iPhone can support voice identity if the work is shaped as sparse
post-turn enrichment. It should not run heavyweight diarization or continuous
embedding as part of the low-latency Live loop.

Performance rule:

> The phone captures, timestamps, buffers, and assembles turns. The gateway or
> an optimized on-device scorer computes embeddings. Diarization and clustering
> stay background-only.

Expected mobile responsibilities:

- keep one shared audio observation stream;
- maintain a short PCM ring buffer for recent speech;
- write optional WAV artifacts when recording is enabled;
- track `speech_started`, `speech_stopped`, and transcript item ids;
- provide recording-relative `audio_start_ms`/`audio_end_ms` for any artifact
  ref that points at a longer session WAV, using the local recording timeline
  rather than wall-clock timestamps;
- run cheap quality gates such as duration, RMS, clipping, and route metadata;
- send a small post-turn audio segment or artifact ref to the scorer;
- display late-arriving identity annotations.

Avoid on mobile:

- a third microphone tap;
- continuous full-session embedding;
- pyannote-style diarization in the foreground;
- long-running clustering while WebRTC audio/video is active;
- retaining raw audio solely for voice identity when policy says not to.

Audio buffer cost is manageable. PCM16 mono is small:

| Sample rate | Approx bytes/sec | 30s ring buffer |
| --- | ---: | ---: |
| 16 kHz mono PCM16 | ~32 KB/s | ~1 MB |
| 24 kHz mono PCM16 | ~48 KB/s | ~1.5 MB |
| 48 kHz mono PCM16 | ~96 KB/s | ~3 MB |

The real mobile cost is not memory; it is CPU, battery, thermal headroom, and
audio-session stability while WebRTC, camera, voice processing, and recording
are active.

Implementation placement:

| Work | First version | Later optimized version |
| --- | --- | --- |
| Capture and turn assembly | iPhone | iPhone |
| Short ring buffer | iPhone | iPhone |
| Owner verification | Mac/HaoClaw gateway sidecar, post-turn or session-end | on-device optimized scorer if needed |
| Full diarization | gateway/background | only if a proven mobile SDK is acceptable |
| Non-owner clustering | gateway/background | gateway/background |
| Template learning evals | gateway/background | gateway/background |

For first implementation, require one of these audio sources:

- `mediaPersistenceMode != .off`, so `LiveRecordingSink` has a WAV artifact; or
- a new ephemeral `LiveAudioObservationBuffer` that keeps only the last N seconds
  for scoring and discards raw PCM after the embedding is produced.

Do not add another `AVAudioEngine` tap for voice identity. The current WebRTC
path already needs a provider-owned mic plus the existing parallel recording
tap in some modes. Voice identity should consume the same observation stream
used by recording/mic-health, or that stream should be refactored into a single
`LiveAudioObservationPipeline` with multiple consumers:

```text
MicAudioSource / provider audio observation
  -> recording sink
  -> mic watchdog
  -> short voiceprint ring buffer
  -> optional live/deferred upload
```

Recommended rollout:

1. V0 and V1 use gateway scoring from saved WAV files. No extra iPhone compute.
2. V2 uses post-turn gateway scoring from short segments. iPhone only cuts or
   references the segment.
3. V3 adds an ephemeral ring buffer so voice identity works without retaining a
   full recording.
4. Only after benchmarks show a product need, test an on-device scorer such as a
   commercial streaming SDK or a quantized Core ML model.

Mobile acceptance criteria:

- no measurable regression in WebRTC connection stability;
- no extra microphone tap;
- no assistant response delay caused by voice identity;
- scoring failure leaves transcript as `unknown_speaker`;
- with camera off, owner verification annotation usually appears within 0.5-2s
  after speech stop when gateway is reachable;
- with camera on or thermal pressure, scoring may degrade to session-end batch.

### Policy Interaction Between Paths

The paths interact through policy-checked events, not shared mutable state:

```text
TranscriptTurn
  -> pending identity
  -> SpeakerTurnTag
  -> IdentitySignal
  -> ConsentSnapshot / policy gate
  -> EventParticipation / MemoryCandidate / ActionProposal
```

Allowed influence:

- `owner_speaking` with high confidence can backfill transcript metadata and
  contribute to memory/action evidence.
- `possible_owner` can display in diagnostics only.
- `unknown_cluster` can group review cards and event participation candidates,
  but cannot trigger actions or context export.
- `confirmed_person` can influence social memory only after explicit user
  review.

Rejected or corrected identity signals must propagate:

- update the `SpeakerTurnTag` review state,
- downgrade or delete dependent `EventParticipation`,
- re-check memory/action candidates that used the signal,
- add a negative learning fixture.

### Pipeline Shape

```text
Live mic / recording WAV
  -> speech turn windows from Realtime events or local VAD
  -> quality gate: speech duration, RMS, clipping, overlap, route/device
  -> resample to model target, usually 16 kHz mono
  -> embedding model
  -> owner verification and/or anonymous cluster assignment
  -> IdentitySignal linked to transcript and audio artifact refs
  -> memory/action policy consumes only reviewed or owner-safe signals
```

The pipeline should keep these steps separate:

- Speech activity: is there speech?
- Speaker segmentation: where does one speaker turn begin/end?
- Speaker embedding: fixed-length vector for a speech segment.
- Verification: does this segment match the enrolled owner?
- Clustering: does this unknown voice resemble a previous unknown voice?
- Naming: does the user explicitly confirm which person a cluster represents?

### Adaptive Owner Voice Learning Loop

The system should learn from owner voice evidence, but it must not blindly
self-train from its own guesses. Treat learning as controlled adaptation:

```text
speaker turn
  -> identity decision
  -> learning sample candidate
  -> policy gate
  -> shadow template / calibration update
  -> eval against holdout and rejected examples
  -> promote, quarantine, or discard
```

There are two different kinds of learning:

- Feature backfill: once a turn is confidently tagged as owner speech, fill in
  metadata that was previously unknown, such as `speakerRole: owner`,
  route/device, speech quality, transcript owner span, and evidence links.
- Template adaptation: update the owner voice template or route-specific
  calibration using approved high-quality speech samples.

Feature backfill can happen automatically for high-confidence owner matches.
Template adaptation is higher risk and must go through a stricter policy gate.

Learning sample shape:

```ts
type OwnerVoiceLearningSample = {
  id: RecordId;
  createdAt: IsoTime;
  source: {
    speakerTurnTagId: RecordId;
    audioArtifactId: RecordId;
    transcriptItemId?: string;
    startMs: number;
    endMs: number;
  };
  proposedLabel: "owner" | "not_owner" | "unknown";
  labelSource:
    | "manual_confirmed"
    | "high_confidence_voice"
    | "multi_signal_consensus"
    | "manual_rejected"
    | "diagnostic_only";
  confidence: number;
  featureSnapshot: {
    route?: "iphone_mic" | "airpods" | "glasses" | "desktop" | "unknown";
    speechSeconds: number;
    rms?: number;
    clipping?: boolean;
    overlapLikely?: boolean;
    noiseScore?: number;
    modelId: string;
    similarity?: number;
    ownerPresentSignalId?: RecordId;
  };
  allowedUses: {
    backfillMetadata: boolean;
    calibrateThresholds: boolean;
    updateTemplate: boolean;
    trainNonOwnerCluster: boolean;
  };
  review: {
    state: ReviewState;
    reviewedAt?: IsoTime;
  };
};
```

Learning policy:

- Manual confirmation is the strongest label source. A manually confirmed owner
  sample may update a shadow template if quality gates pass.
- A high-confidence owner voice match may backfill metadata immediately and may
  enter the template-adaptation queue, but it should not directly overwrite the
  production owner template.
- Multi-signal consensus can help calibration, but should be treated carefully.
  Example signals: owner face present, device unlocked by owner, paired personal
  route, explicit push-to-talk interaction, and a high voice similarity score.
- Context-only signals, such as first-person wording or calendar context, must
  never train a voice template by themselves.
- Low-quality, clipped, overlapped, or assistant-leakage segments are excluded
  from template adaptation.
- Manual rejection creates a negative example and suppression signal.

Template adaptation should use shadow promotion:

1. Keep the current owner template as production.
2. Build a candidate template version from approved learning samples.
3. Evaluate the candidate against:
   - original enrollment holdout,
   - recent manually confirmed owner samples,
   - manually rejected / known non-owner samples,
   - noisy and route-shifted samples.
4. Promote only if false accepts do not increase and false rejects improve.
5. Keep version history and allow rollback.

Route-specific adaptation is likely necessary. AirPods, iPhone mic, glasses,
desktop microphone, and room acoustics can shift embeddings. Prefer storing
route metadata and route-specific thresholds before attempting one global
template to fit all capture paths.

Feature backfill examples:

- A transcript turn with no speaker label receives `speakerRole: owner` only
  after `owner_speaking` passes threshold.
- An action proposal can use "owner said this" as evidence only when the
  `SpeakerTurnTag` is high-confidence and policy allows owner identity for that
  proposal type.
- A weak voice score plus strong contextual hints can create
  `possible_owner`, but remains diagnostic-only and cannot train the template.
- If the user corrects a turn from `owner_speaking` to `unknown`, the sample is
  added as a negative fixture and future similar scores should be more
  conservative.

The learning loop should optimize toward fewer false owner matches, not toward
maximizing owner recall. Missing an owner tag is acceptable; falsely labeling a
bystander as the owner can poison memory, action proposals, and relationship
inference.

### Data Model Additions

The existing `IdentitySignal` type is the right outer envelope. Add voiceprint
specific metadata rather than storing raw vectors in the signal itself:

```ts
type VoiceprintTemplate = {
  id: RecordId;
  subject: { type: "owner" | "unknown_cluster"; id: RecordId };
  model: {
    provider: "speechbrain" | "pyannote" | "wespeaker" | "picovoice" | "custom";
    modelId: string;
    embeddingDim?: number;
    version: string;
  };
  enrollment: {
    createdAt: IsoTime;
    sourceArtifactIds: RecordId[];
    speechSeconds: number;
    quality: "good" | "marginal" | "rejected";
    route?: "iphone_mic" | "airpods" | "glasses" | "desktop" | "unknown";
  };
  storage: {
    templateUri: string;
    encrypted: true;
    localOnly: boolean;
    keyRef: string;
  };
  thresholds: {
    ownerAccept: number;
    ownerPossible: number;
    clusterAccept: number;
  };
  retention: RetentionClass;
  deletedAt?: IsoTime;
};

type SpeakerTurnTag = {
  id: RecordId;
  transcriptItemId?: string;
  audioArtifactId: RecordId;
  startMs: number;
  endMs: number;
  identitySignalId: RecordId;
  result: "owner_speaking" | "possible_owner" | "unknown_speaker" | "unknown_cluster";
  confidence: number;
  thresholdUsed: number;
  modelId: string;
};
```

Rules:

- Store `VoiceprintTemplate` separately from transcript and memory records.
- Never log template vectors or raw enrollment audio by default.
- Attach `SpeakerTurnTag` to transcript spans and artifacts, not to free-floating
  memory text.
- `possible_owner` is diagnostic-only.
- `unknown_cluster` can group local review cards, but cannot trigger actions,
  promote memories, or export context.

### Implementation Plan

#### Phase V0: Measurement Spike

Status: DONE (fixture and scoring foundation, manifest validation, threshold
report scaffold, similarity helper with zero/invalid-embedding rejection).

Goal:

- Prove that local recorded WAV segments can produce repeatable owner/not-owner
  scores before adding product UI.

Tasks:

- Collect a tiny local fixture set from existing Live recordings:
  - owner same route, quiet room,
  - owner different route if available,
  - another speaker,
  - noisy/background segment,
  - assistant playback leakage if present.
- Add an offline script or sidecar command:
  - read WAV,
  - resample to model target,
  - cut fixed segments,
  - extract embeddings,
  - compute cosine similarity against enrollment.
- Centralize speaker similarity math in one helper and define zero/invalid
  embeddings as maximum non-match.
- Compare SpeechBrain ECAPA-TDNN and WeSpeaker first.
- Produce a threshold report with false accept / false reject examples.

Exit criteria:

- We can score owner vs non-owner on local artifacts.
- We know whether route changes require per-route templates.
- The report chooses one POC model and records the first owner thresholds.

#### Phase V1: Owner Enrollment MVP

Status: PARTIAL — the encrypted owner-template envelope (AES-GCM, restricted
permissions, tamper detection, tombstones) and template store exist; the
enrollment screen, read-aloud capture flow, and one-tap disable/delete UX do
not. This is the main remaining product work.

Goal:

- Let the owner opt in to local voice enrollment and create an encrypted local
  owner template.

Tasks:

- Add an Owner Voice Enrollment screen under Settings or Live diagnostics.
- Use the screenpipe-inspired pattern:
  - ask for explicit owner voice opt-in,
  - show a read-aloud prompt,
  - capture 30-45 seconds,
  - require minimum speech seconds and non-clipping RMS,
  - show "recognized", "not enough signal", or "try again".
- Store a `VoiceprintTemplate` for the owner.
- Delete raw enrollment audio by default after extraction, unless the user opts
  to keep it as an artifact.
- Add one-tap disable/delete with tombstone semantics.

Exit criteria:

- Owner can enroll and delete voice locally.
- Deleting enrollment removes the template and prevents silent re-enrollment.
- No template or raw enrollment media appears in logs, replay bundles, or MCP
  exports.

#### Phase V2: Post-Turn Owner Speaking Tags

Status: foundation DONE behind the off-by-default `voiceprintRealtimeEnabled`
flag — turn tracker, Realtime event adapter, gateway per-session buffering,
audio-artifact registry, and server-side `score_turns` are wired end to end;
enabling it in product waits on V1's enrollment/consent UX.

Goal:

- Attach conservative `owner_speaking`, `possible_owner`, or `unknown_speaker`
  tags to Live transcript turns.

Tasks:

- Wire the TypeScript `LiveVoiceTurnTracker` to existing
  `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`, and
  transcript completion events.
- Align tracked turn windows to `LiveRecordingSink` audio artifacts or local WAV
  offsets.
- Treat speech event timestamps as recording-relative audio offsets. Do not use
  wall-clock `Date.now()` values as WAV slice bounds.
- On iOS, use `LiveRecordingSink`'s written-audio offset as the fallback
  timeline for WebRTC/Pipecat speech callbacks that arrive without
  `audio_start_ms`/`audio_end_ms`; if that timeline is unavailable, skip the
  voiceprint event.
- Treat `transcriptItemId` as the required join key between Live transcript,
  voiceprint annotation, HaoClaw transcript append, replay, and corrections.
- Prefer Realtime `item_id` as the speech-window id for VAD start/stop,
  transcript completion, and local recording artifact joins; only use FIFO
  closed-window fallback for legacy events that do not carry an item id.
- On iOS, serialize voiceprint realtime events through a small ordered queue so
  speech start/stop, artifact refs, and transcript completion cannot be
  reordered by short-lived gateway RPC calls.
- On the gateway, keep finalized-turn buffering and biometric scoring as
  separate RPC steps. Scoring must require a server-configured sidecar, owner
  embeddings/template source, consent snapshot, and audio-root allowlist; the
  client must not be able to choose arbitrary sidecar commands or gateway file
  paths.
- Keep the iOS realtime bridge disabled by default until explicit biometric
  consent and owner enrollment are available.
- Add leakage gates before scoring or learning:
  - reject segments overlapping assistant output audio,
  - reject likely loopback duplicates when text/time/source indicate echo,
  - reject clipped, too-short, or overlapped segments.
- Run embedding after each finalized turn or at session stop.
- Emit `IdentitySignal` and `SpeakerTurnTag` records.
- Surface tags in diagnostics and evidence views, not as confident user-facing
  names yet.

Exit criteria:

- A Live session can show which transcript turns are likely owner speech.
- Low confidence stays diagnostic-only.
- Tags link back to audio artifact refs and transcript spans.

#### Phase V3: Anonymous Non-Owner Clustering

Status: NOT STARTED (review-decision primitives for clusters exist in
`src/identity/voiceprint/review.ts`, but no clustering).

Goal:

- Recognize recurring unknown speakers without naming them.

Tasks:

- Create rolling local clusters such as `voice_cluster_7`.
- Keep clusters local-only and short-lived by default.
- Exclude owner-matched segments from non-owner clustering.
- Add speaker cleanup primitives:
  - split over-merged cluster,
  - merge clusters,
  - mark media/background/noise,
  - suppress future suggestions,
  - undo corrections.
- Add review cards that show evidence snippets and confidence without asserting
  a real identity.
- Add suppression for rejected clusters.

Exit criteria:

- Repeated unknown voices can be grouped for review.
- No non-owner cluster influences memory retrieval, action proposals, or context
  export until reviewed.
- Rejected clusters do not immediately resurface.

#### Phase V4: Heard Names And Manual Person Links

Status: NOT STARTED.

Goal:

- Keep speech-derived names separate from biometric clusters until explicit
  review.

Tasks:

- Extract heard-name candidates from transcripts.
- Show review cards that may contain:
  - heard name,
  - transcript evidence,
  - optional voice cluster evidence,
  - explicit "link", "not this person", "suppress" actions.
- Create or update a person capsule only after manual confirmation.

Exit criteria:

- The system can suggest "heard name near voice cluster" without auto-linking.
- Confirmed links carry evidence and can be revoked.

#### Phase V5: Policy And Evals

Status: NOT STARTED as a whole, but the memory-side gate exists: person and
identity-derived claims already quarantine as `MemoryCandidate` records
before any voiceprint influence is possible.

Goal:

- Make voice identity safe enough to influence memory and ambient actions.

Tasks:

- Add privacy regression tests:
  - owner templates encrypted and local-only,
  - deletion removes templates,
  - context visas strip biometrics by default,
  - replay bundles exclude templates,
  - unreviewed clusters cannot trigger actions.
- Add robustness tests:
  - acoustic-loopback / assistant-leakage segments do not train owner templates,
  - over-merged clusters can be split and undone,
  - exact-name collisions do not auto-link non-owner people,
  - long-session chunking preserves stable cluster ids or keeps ids chunk-local,
  - voiceprint worker concurrency cannot corrupt ASR/transcription state,
  - voice identity config defaults are complete.
- Add `prompt_test` replay fixtures where:
  - owner speech should anchor a memory,
  - non-owner speech must remain unknown,
  - a false-positive-like segment must fail closed to unknown.
- Add a diagnostic threshold page for false positives / false negatives.

Exit criteria:

- Voice identity can be used as a memory/action gating signal only where policy
  explicitly allows it.
- Every identity decision has evidence, confidence, threshold, model, and
  deletion semantics.

### Near-Term Engineering Notes

Likely repo touch points:

- iOS capture:
  - `ios/hawky/Audio/MicAudioSource.swift`
  - `ios/hawky/Live/LiveRecordingSink.swift`
  - `ios/hawky/Live/LiveSessionStore.swift`
  - `ios/hawky/Live/LiveGatewayBridge.swift`
- iOS UI:
  - Settings owner profile / diagnostics surfaces.
- Gateway/local worker:
  - new `src/identity/voiceprint-service.ts` or a Python sidecar invoked by the
    gateway.
- Data contracts:
  - `IdentitySignal`,
  - `VoiceprintTemplate`,
  - `SpeakerTurnTag`,
  - artifact refs and transcript ranges.
- Tests:
  - unit tests for storage/deletion policy,
  - fixture tests for scoring thresholds,
  - Swift bridge contract tests for realtime voiceprint event payloads,
  - prompt replay tests for identity influence.

Implementation guardrails:

- Do not route raw enrollment audio through OpenAI Realtime.
- Do not use voiceprint as authentication.
- Do not auto-name bystanders.
- Do not store bystander templates indefinitely.
- Do not let identity signals bypass the Action Proposal review path.
- Prefer "unknown" over a false owner match.
- Treat missing or denied capture/biometric consent as a pre-processing skip:
  do not read/slice audio, load or decrypt owner templates, call the embedding
  sidecar, compare embeddings, or create storage bundles for that turn.

### Open Questions

- Should first implementation run on the Mac gateway or fully on iPhone?
  - Recommendation: Mac/gateway first for model iteration; iPhone/Picovoice or
    Core ML later if the UX needs local streaming without gateway dependency.
- Do we need diarization immediately?
  - Recommendation: no. Start with owner verification per speech turn; add
    diarization only when mixed-speaker conversations become a blocker.
- Should enrollment be one global owner template or per route/device?
  - Recommendation: record route metadata from day one and expect per-route
    thresholds or templates.
- Can assistant playback contaminate owner voice enrollment?
  - Recommendation: enrollment should happen in a controlled screen with
    assistant output muted; Live turn tagging should reject segments with likely
    playback leakage or overlap.
- How should this interact with screenpipe-style desktop audio?
  - Recommendation: import desktop speaker labels only as external identity
    signals with source attribution, not as trusted person identities.

## Invention Portfolio

Each bet is written as a product/research direction. The first slice is small
enough to start from the current repo.

Status key (2026-07-02): 1 partial, 6 first-slice done, 7 partial, 8 partial;
2, 3, 4, 5, 9, 10, 11, 12, 13 not started. Details under each item.

### 1. Proof-Carrying Memory (P0)

Status: PARTIAL — `MemoryCandidate` carries claim, evidence metadata, source,
and quarantine state, and distillation is bounded by a person snapshot.
Influence tracking ("where did this memory change behavior?") and the Memory
Ledger view do not exist.

Core idea:

- Every durable memory carries evidence, confidence, sensitivity, expiry, and
  usage history.

Hard part:

- Track influence, not only storage. If a wrong memory caused downstream
  suggestions, the user should be able to see and repair that chain.

Repo fit:

- `src/memory/*` becomes the durable memory substrate.
- iOS Live media artifacts become evidence sources.
- `prompt_test` evaluates memory promotion rules.
- Web/iOS get a Memory Ledger view.

First slice:

- Add provenance fields to memory candidates and show one memory with linked
  transcript/frame evidence.

### 2. Ambient Action Inbox (P0)

Core idea:

- Ambient observations become reviewable action cards, not immediate
  interruptions.

Card contents:

- proposed action,
- supporting evidence,
- confidence,
- expected value,
- risk,
- required tools,
- data that will leave the device,
- approve/edit/dismiss/mute/always allow.

Hard part:

- The agent must avoid becoming noisy. Low-value actions should wait for daily
  review instead of interrupting.

Repo fit:

- `src/ambient/intention-service.ts` becomes the proposal backend.
- iOS Live becomes capture and approval surface.
- Gateway permissions become action-level policy.

First slice:

- Convert one timed or transcript-derived intention into an action card with
  evidence and approve/dismiss state.

### 3. Shadow Autonomy (P1)

Core idea:

- Before the agent becomes autonomous, it runs in shadow mode and records what
  it would have done.

Shadow decisions:

- what it would remember,
- what it would suggest,
- what tool it would call,
- when it would interrupt,
- what approval it would request.

Hard part:

- Autonomy must graduate per action class, not globally. The agent may earn
  autonomy for "draft daily notes" but not for "send email."

Repo fit:

- Gateway can store predicted tool calls without executing them.
- `prompt_test` can replay shadow decisions.
- Web cockpit can show "would have acted" traces.

First slice:

- Add a shadow-only action proposal mode that never executes but can be rated
  useful, wrong, too sensitive, or bad timing.

### 4. Episodic Debugger And Memory Time Machine (P0)

Core idea:

- Any ambient episode can be replayed with different model, memory, prompt, or
  privacy settings.

Debug timeline:

- raw audio/frame artifacts,
- transcript,
- model messages,
- memories retrieved,
- memories written,
- tool calls proposed/executed,
- permission decisions,
- identity candidates,
- relationship candidates,
- cost/latency,
- user corrections,
- final outcome.

Hard part:

- Replays require stable artifacts and enough determinism to compare behavior
  across model, prompt, or policy changes.

Repo fit:

- Gateway events already have session ids and sequence numbers.
- Realtime playground exports can become recipes.
- `prompt_test` can consume replay bundles.

First slice:

- Export one Live session into a replay bundle and run it through a
  `prompt_test` case.

### 5. Consent Graph And Situation Contracts (P1)

Core idea:

- Privacy is governed by situations, not only global settings.

Situation examples:

- At conferences, remember names and work topics for 30 days.
- At home, never store raw audio.
- In meetings with this calendar tag, keep transcript but not frames.
- When glasses are active in public, capture only scene captions unless the
  user pins a moment.

Policy dimensions:

- source,
- place,
- person,
- biometric templates,
- heard names,
- relationship edges,
- app,
- data type,
- retention,
- export scope.

Hard part:

- Situation detection is probabilistic, but policy enforcement must become
  deterministic once a contract is active.

Repo fit:

- Device auth and gateway permissions become data-policy aware.
- iOS Live exposes capture status and active situation.
- Memory ledger stores source consent state.
- MCP read APIs filter by policy.

First slice:

- Add two capture modes, "private" and "work meeting", with different retention
  and memory-promotion rules.

### 6. Context Quarantine (P0)

Status: FIRST SLICE DONE — person-related memory candidates quarantine until
confirmation (`src/memory/candidate.ts`, `89d76ab`), and unreviewed identity
candidates cannot become profiles. The remaining slices (injection-suspect
web content, low-trust node outputs, contradiction handling) are open, as is
the cockpit view of quarantined items.

Core idea:

- Suspicious or untrusted context should not immediately enter durable memory.

Quarantine examples:

- overheard commands from someone else,
- sensitive bystander speech,
- low-confidence person identity,
- unconfirmed voice or face clusters,
- heard names without confirmed person mapping,
- relationship edges inferred from weak evidence,
- web pages that may contain prompt injection,
- memories contradicted by stronger evidence,
- tool outputs from low-trust nodes.

Hard part:

- The system needs a memory trust boundary, not just a search index.

Repo fit:

- Memory candidate lifecycle can add `quarantined`.
- Tool outputs and node sources can carry trust levels.
- The cockpit can show quarantined items for review.

First slice:

- Quarantine person-related memory candidates until user confirmation.

### 7. Owner Identity And Relationship Graph (P1)

Status: PARTIAL — the first slice's plumbing exists (owner voiceprint scoring
foundation with encrypted local templates; face identity signals and
candidates), but enrollment UX and `owner-present`/`owner-speaking` session
tags are not user-reachable yet. Second slice (heard names) and third slice
(relationship edges) not started.

Core idea:

- Build an owner-centric identity layer that helps the agent understand who is
  speaking, whether the owner is present, which names recur, and how people may
  relate to the user.

Signals:

- owner face recognition,
- owner voiceprint recognition,
- recurring non-owner voiceprint clusters,
- names frequently heard in conversations,
- aliases and pronunciation variants,
- co-occurrence between names, voices, faces, places, calendar events, and
  topics,
- relationship-edge candidates such as "works with", "friend of", "met at",
  "reports to", "hiring for", "introduced by", "family", or "do not infer."

Important constraint:

- This is not invisible surveillance. Owner identity anchors the agent's
  perspective: "Is this my user speaking? Is my user in this scene? Is this
  memory about my user or someone else?" Non-owner identity stays as
  low-confidence clusters until reviewed.

Hard part:

- Voiceprints, faces, and names are biometric or socially sensitive signals.
  The system must avoid silently turning them into durable identities.

Repo fit:

- Cocktail Party / person tools become the review surface.
- Face recognition starts with owner-only recognition before general person
  recognition.
- Audio pipeline can create local voiceprint clusters without naming them.
- Memory ledger stores relationship candidates separately from confirmed person
  capsules.
- Consent graph controls whether voiceprints, face embeddings, names, or
  relationship edges may be retained.

First slice:

- Add an owner profile with opt-in owner face and owner voice enrollment. Use it
  only to tag sessions as `owner-present`, `owner-speaking`, or
  `non-owner-speaking`, without naming other people.

Second slice:

- Add heard-name extraction from transcripts. Store recurring names as
  reviewable candidates, not confirmed people.

Third slice:

- Add relationship-edge candidates that require explicit user confirmation
  before they influence reminders or memory retrieval.

### 8. Social Memory Capsules (P1)

Status: PARTIAL — the capsule substrate exists in the TS person store
(profiles, structured facts with evidence/source-session, recaps, candidates,
tombstones). Expiry, never-remember fields, and the review surface are open.

Core idea:

- People memory is explicit, bounded, and reviewable.

Capsule fields:

- name or alias,
- linked name/voice/face candidates,
- how the user knows them,
- last interaction,
- open loops,
- safe reminders,
- never-remember fields,
- expiry,
- evidence.

Hard part:

- The feature must avoid becoming invisible face recognition. The product is
  bounded social recall with consent and expiry.

Repo fit:

- Cocktail Party / person tools become a controlled product surface.
- Face recognition remains opt-in and evidence-linked.
- Person memory promotion requires explicit confirmation.

First slice:

- Create one person capsule from a reviewed interaction, with expiry and
  evidence link.

### 9. Personal Context Escrow And Context Visas (P2)

Core idea:

- HaoClaw becomes the user's private context server for other agents.

Instead of giving another agent the whole life log, the user grants a scoped
context visa:

```text
Agent: Codex
Purpose: debug this repo issue
Requested context: last 2 hours of terminal, relevant GitHub issue, current
repo notes
Denied context: personal messages, raw audio, location, unconfirmed people
Expiry: 2 hours
Audit: enabled
```

Hard part:

- The user needs an understandable preview before granting access.

Repo fit:

- Existing MCP server can remain read-only.
- Add scoped memory/session/context APIs.
- Write/action MCP stays behind gateway permission flow.

First slice:

- Add a read-only MCP context export that returns a scoped session summary with
  redaction and expiry metadata.

### 10. Sensor Mesh (P2)

Core idea:

- Phone, glasses, desktop, browser, Slack, GitHub, and future hardware are
  nodes in a sensor/action mesh.

Each node reports:

- capture capabilities,
- action capabilities,
- trust level,
- battery/network state,
- local privacy constraints,
- available tools.

Hard part:

- The gateway must degrade gracefully when a source is missing or low trust.

Repo fit:

- iOS node role already exists.
- Node host and mobile node can share a capability manifest.
- Gateway registry becomes more than connection status.
- screen/audio/glasses sources feed the same artifact model.

First slice:

- Add a node capability manifest and show iOS node capabilities in the
  operator cockpit.

### 11. Counterfactual Action Simulator (P2)

Core idea:

- Before risky actions, simulate the consequence.

For email:

- show draft,
- show recipients,
- show source evidence,
- show memory updates,
- show what could go wrong,
- offer safer alternatives.

For code:

- show file diff,
- tests to run,
- rollback plan,
- affected sessions or tasks.

Hard part:

- The simulator must be concise. Otherwise approval becomes slow theater.

Repo fit:

- Agent/tool layer can produce action previews.
- Permission model can require preview for side effects.
- Web/TUI can render simulation output.

First slice:

- Add preview records for one side-effectful tool path before approval.

### 12. Memory Compiler And Living Skills (P2)

Core idea:

- Repeated accepted actions can compile into governed skills.

Flow:

1. The user repeatedly approves a workflow.
2. HaoClaw detects the pattern.
3. It proposes a skill with trigger conditions, required data, permission
   scope, action template, evals, and rollback behavior.
4. The user reviews and installs it.

Living skill states:

- dormant,
- observing,
- suggested,
- trial,
- trusted,
- degraded,
- revoked.

Hard part:

- The system must distinguish a real habit from a coincidence, and generated
  skills must be testable before running.

Repo fit:

- Existing skills loader/status becomes skill lifecycle infrastructure.
- `prompt_test` supplies eval cases.
- Gateway permissions govern skill action scope.

First slice:

- Add a skill readiness/lifecycle view before generating any skill
  automatically.

### 13. Attention Wallet And Regret Review (P2)

Core idea:

- Every interruption spends attention budget. The agent earns budget back only
  when the user accepts or later confirms value.

Budget dimensions:

- person,
- place,
- time of day,
- task state,
- action type,
- urgency,
- past usefulness,
- recent annoyance.

Daily regret review:

- What did I interrupt you about that was not worth it?
- What should I have caught but missed?
- What did I remember that I should forget?
- What did I fail to do because I lacked permission?

Hard part:

- The agent must learn from negative space: missed opportunities and unwanted
  interruptions.

Repo fit:

- Intention service can track accepted/dismissed/late/missed proposals.
- iOS/web can show daily review.
- Attention score becomes part of proposal ranking.

First slice:

- Add accepted/dismissed/bad-timing feedback to action proposals and use it to
  suppress similar future interruptions.

## Roadmap

Do not treat phases as broad themes. Treat them as gates. Later phases may be
researched, but they should not become product work until their dependencies
are in place.

### Roadmap Work Packages

| Package | Priority | Target | Must include | Gate |
| --- | --- | --- | --- | --- |
| P0-A Trust Baseline | P0 | Make ambient work safe to ship internally | release gates, redacted logs, static security headers, auth on push fallback, privacy matrix | CI blocks unsafe release; logs do not preserve secrets by default |
| P0-B Core Schemas | P0 | Make evidence/action/memory addressable | six core object definitions, fixture builders, lifecycle tests | Objects can be persisted and loaded in tests |
| P0-C Artifact Pipeline | P0 | Make phone capture inspectable | stable artifact ids, transcript/frame refs, hashes, retention metadata | One session's artifacts can be found from a memory/action card |
| P0-D Action Proposal MVP | P0 | Make ambient suggestions reviewable | `ActionProposal`, approve/dismiss, evidence links, basic feedback | One suggestion can be approved or dismissed without executing automatically |
| P0-E Replay Bundle | P0 | Make failures reproducible | ordered events, artifact manifest, prompt/model metadata, prompt_test import | A Live session can become a replay test |
| P0-F Quarantine Default | P0 | Prevent unsafe memory promotion | `quarantined` lifecycle, person/identity candidates default quarantined | Quarantined records cannot influence actions |
| P1-A Owner Identity MVP | P1 | Anchor owner/self context | opt-in owner face/voice enrollment, local encrypted templates, owner-present/speaking tags | Owner signals tag sessions but do not name bystanders |
| P1-B Memory And Identity Review | P1 | Make review a product workflow | memory ledger, identity queue, relationship candidate queue, delete/suppress flows | User can confirm/reject/delete from one surface |
| P1-C Shadow Autonomy | P1 | Calibrate autonomy safely | shadow proposals, feedback labels, usefulness/bad-timing metrics | Agent records would-have-acted traces without execution |
| P1-D Situation Contracts | P1 | Make privacy executable | private/work/public contracts, retention/export rules, active-contract UI | Same policy affects capture, memory, and export |
| P2-A Context Visas | P2 | Safely share context with other agents | visa preview, expiry, denied categories, audit log | External agent receives scoped context only |
| P2-B Sensor Mesh | P2 | Add more capture surfaces | node capability manifest, trust level, graceful degradation, glasses verifier | Phone path remains reliable while sources vary |
| P2-C Counterfactual Simulator | P2 | Improve side-effect safety | preview/diff/rollback for one tool path | User sees consequence model before execution |
| P2-D Living Skills | P2 | Govern generated automation | skill lifecycle, declared data needs, evals, readiness score | No generated skill can run without tests and permission scope |

Status notes (2026-07-02): `P0-F Quarantine Default` is done for the
person/memory path. `P0-B Core Schemas` is partial (`MemoryCandidate` and
`IdentitySignal` exist; the other four objects do not). `P1-A Owner Identity`
has its voiceprint foundation but no enrollment UX. `P1-B Memory And
Identity Review` is the same work as the refactor plan's PR 3 review ledger
and is now the highest-leverage package on this table. No other package has
started.

### Build Order

1. Build `P0-A` and `P0-B` first. They are foundation work.
2. Build `P0-C`, `P0-D`, and `P0-E` together as the first proof-carrying phone
   loop.
3. Add `P0-F` before any identity or relationship work.
4. Start `P1-A` only after template storage, deletion semantics, and identity
   tests are written.
5. Start `P1-B` immediately after owner identity tags exist; review UX is part
   of identity safety, not a later polish step.
6. Start `P1-C` after action proposals have enough feedback history.
7. Start P2 work only after the phone loop is replayable and policy-gated.

### Stop Conditions

Stop and fix foundations if any of these happen:

- An action proposal cannot show its evidence.
- A memory candidate cannot explain its source artifact.
- A non-owner identity candidate influences an action.
- A deleted or rejected person resurfaces as a fresh suggestion.
- A replay bundle cannot reproduce the original context.
- A context export includes raw biometrics or unconfirmed people by default.

### Phase 0: Trust Foundation

Goal:

- Make the current system safe enough to build ambient features on.

Deliverables:

- Release workflow gates: typecheck, unit/integration tests, web build/test.
- iOS simulator CI subset.
- Static security headers and CSP for web.
- File logs redacted by default, raw logs explicit opt-in.
- Device token revocation and scoped roles.
- Auth for push fallback endpoints.
- Privacy/data retention matrix.

Exit criteria:

- A release cannot publish without core tests.
- Web token exposure risk is reduced.
- Logs no longer preserve secrets by default.

### Phase 1: Proof-Carrying Phone Loop

Goal:

- Make the phone-held ambient loop repeatable and evidence-backed.

Deliverables:

- One scripted verifier:
  - gateway health,
  - device auth,
  - iOS client,
  - node role,
  - audio upload,
  - keyframe upload,
  - transcript,
  - memory candidate,
  - action proposal,
  - phone response.
- Artifact ids attached to every transcript/keyframe/action.
- First Memory Ledger view.
- Export Live session to replay/eval case.

Exit criteria:

- A failed demo produces enough artifacts to debug.
- A successful demo can be replayed as a regression.

### Phase 2: Action Inbox And Shadow Autonomy

Goal:

- Turn ambient understanding into safe, reviewable action.

Deliverables:

- Action card schema.
- iOS Action Inbox.
- Web Action Inbox.
- Shadow-mode predictions.
- User feedback labels.
- Per-action autonomy levels:
  - suggest,
  - draft,
  - execute with approval,
  - execute with undo,
  - never.

Exit criteria:

- The system collects useful actions without interrupting constantly.
- Autonomy is earned per action class.

### Phase 3: Memory, Identity Ledger, And Ambient Evals

Goal:

- Make memory promotion, identity hints, relationship inference, and model
  behavior measurable.

Deliverables:

- Memory candidate lifecycle:
  - observed,
  - proposed,
  - quarantined,
  - confirmed,
  - active,
  - suppressed,
  - expired,
  - deleted.
- Opt-in owner face enrollment.
- Opt-in owner voice enrollment.
- `owner-present`, `owner-speaking`, and `non-owner-speaking` session tags.
- Heard-name candidate extraction from transcripts.
- Relationship-edge candidates with explicit review.
- Default quarantine for non-owner identity and relationship memories.
- Media replay fixtures for `prompt_test`.
- Privacy regression tests.
- Memory influence tracking.
- Model/provider comparison on the same ambient episode.

Exit criteria:

- A memory error can become a regression test.
- The user can inspect why a memory exists and where it was used.
- No non-owner biometric identity or relationship edge influences memory or
  action without review.

### Phase 4: Consent Graph And Context Escrow

Goal:

- Make privacy executable across capture, memory, MCP, and tools.

Deliverables:

- Consent policy model:
  - source,
  - place,
  - person,
  - biometric templates,
  - heard names,
  - relationship edges,
  - app,
  - data type,
  - retention,
  - export scope.
- Situation contracts.
- Biometric retention and deletion policy.
- MCP context scopes.
- "What will be shared?" preview for external agents.

Exit criteria:

- The same policy governs what is captured, remembered, searched, and exported.
- External agents can use HaoClaw context without full life-log access.

### Phase 5: Sensor Mesh And Glasses

Goal:

- Make phone, glasses, desktop, and external capture tools interchangeable
  sources.

Deliverables:

- Node capability manifest.
- Per-node trust level.
- Capture source router.
- Graceful degradation states.
- Desktop screen/audio connector or integration.
- Glasses capture verifier:
  - registration,
  - one frame to HaoClaw,
  - owner-present confidence,
  - stream stop,
  - audio source decision.

Exit criteria:

- The gateway knows which sensing sources are active and trustworthy.
- Phone and glasses feed the same artifact pipeline.

### Phase 6: Living Skill Ecosystem

Goal:

- Let the system grow without becoming ungoverned.

Deliverables:

- Skill manifest with capabilities and data needs.
- Skill lifecycle state.
- Skill lint.
- Skill readiness score.
- Skill eval fixtures.
- Skill permission scopes.
- Read-only MCP observability tools.
- Write/action MCP gated by gateway permission model.

Exit criteria:

- A skill cannot quietly access more context than declared.
- Skills can be tested against ambient replay cases.

## First Build Slice

The smallest slice that proves the strategy:

1. Phone captures one short ambient session.
2. Gateway stores artifacts with stable ids.
3. Agent proposes one action card.
4. Action card links to transcript/frame evidence.
5. User approves or dismisses.
6. A memory candidate is created with provenance.
7. User confirms or rejects memory.
8. The whole session exports to a replay case.
9. `prompt_test` replays the case and compares behavior.

Optional hard add-on:

1. Owner face or owner voice is enrolled locally.
2. The session is tagged as owner-present or owner-speaking.
3. A heard-name candidate is extracted from the transcript.
4. The heard-name candidate remains unconfirmed until the user reviews it.

If this works, the repo has moved from "ambient demo" to "inspectable ambient
agent platform."

As of 2026-07-02, steps 6-7 have their substrate (memory candidates with
provenance, plus confirm/reject primitives); steps 2-5 and 8-9 (stable
artifact ids, action card, replay export) do not exist yet, and step 7's
"user confirms or rejects" still lacks a surface — the review ledger again.

## Hero Demos

### Demo 1: The Meeting That Becomes Work

The user has a conversation. The system extracts three commitments, shows
evidence, drafts two follow-ups, creates one task, and asks before sending or
creating anything.

Success:

- no hidden action,
- every suggestion has transcript evidence,
- memory updates are reviewable.

### Demo 2: The Conference Recall

The user meets someone. The system suggests a bounded social capsule:

- whether the owner was present or speaking,
- names heard in the exchange,
- which name may map to which voice or face cluster,
- who this person might be,
- where they met,
- what follow-up matters,
- possible relationship edge,
- what not to remember,
- expiry.

Success:

- owner face/voice recognition anchors the session without naming bystanders,
- heard names remain candidates until review,
- relationship edges require confirmation,
- person memory requires confirmation,
- user can delete the capsule,
- no raw face data is retained unless explicitly allowed.

### Demo 3: The Field Debugger

The user points the phone at an error on another device while the desktop node
has repo context. The system correlates visual evidence, terminal trace, code
history, and suggests a fix plan.

Success:

- multimodal evidence joins code context,
- proposed action includes files/tests,
- trace can replay the failure.

### Demo 4: The Quiet Agent

For a day, the agent runs in shadow mode. At night it shows:

- what it would have remembered,
- what it would have suggested,
- when it would have interrupted,
- what it got wrong.

Success:

- the user can train timing and memory policy without risking live autonomy.

### Demo 5: The Context Firewall

The user asks another agent for help. HaoClaw previews exactly what context will
be shared, strips private data, grants scoped access, and logs the export.

Success:

- external agents become more useful without broad life-log access.

### Demo 6: The Relationship Map That Refuses To Guess

The agent hears recurring names across several meetings and sees the owner in
some of the scenes. It proposes a small relationship map:

- "Maya" appears in three work meetings.
- The owner spoke directly to Maya twice.
- Maya may be related to the mobile infra project.
- No relationship is confirmed yet.
- Suggested action: ask the user to confirm, merge, ignore, or forget.

Success:

- the agent says "candidate" instead of pretending to know,
- it separates names, voice clusters, face clusters, and confirmed people,
- the user can merge or reject identities,
- rejected relationships do not come back as suggestions.

## Engineering Priorities

### Gateway

- Split large RPC registration into capability modules.
- Add RPC schema and policy descriptors:
  - validation,
  - required role,
  - side effects,
  - session requirement,
  - replayability.
- Add per-session event ring buffer and replay from sequence number.
- Add action proposal and shadow decision stores.
- Add typed node capability manifests.
- Add context visa/export records.
- Add identity-signal records with source, confidence, consent, and expiry.

### Memory

- Add provenance fields to memory records.
- Add memory candidate lifecycle.
- Add quarantine state.
- Add background indexing queue.
- Add stale-read and indexing health metrics.
- Add memory influence tracking.
- Add expiry and tombstone semantics.
- Keep identity candidates separate from confirmed memories.

### Identity

- Add owner profile with opt-in face and voice enrollment.
- Add owner-present and owner-speaking tags on sessions.
- Add local or privacy-preserving voiceprint clustering for non-owner speakers.
- Add heard-name extraction from transcripts.
- Add relationship-edge candidate store.
- Add merge/reject/forget flows for names, voices, faces, and person capsules.
- Add tests that prevent unreviewed biometric or relationship candidates from
  influencing actions.

### iOS

- Make Live a run-state cockpit.
- Add Action Inbox.
- Add Memory Ledger / review queue.
- Add capture consent modes.
- Add owner face/voice enrollment and deletion surface.
- Show owner-present / owner-speaking confidence when identity mode is enabled.
- Add active situation indicator.
- Add exportable Live replay bundle.
- Keep glasses as a source feeding the same phone pipeline.

### Web / TUI

- Build a unified operator control-plane model.
- Add episodic timeline.
- Add replay controls.
- Add eval dashboard.
- Add skill lifecycle/readiness views.
- Add MCP observability views.

### Testing

- Extend `prompt_test` to media replay.
- Add ambient regression fixtures.
- Add privacy policy regression tests.
- Add owner identity regression tests.
- Add heard-name and relationship-candidate golden tests.
- Add action proposal golden tests.
- Add iOS phone-held verifier.
- Add release CI gates.

## Agent Task Format

When a human or agent turns this plan into an issue, use this shape. It keeps
strategy, policy, data model, and tests connected.

```md
## Objective

One sentence describing the user-visible or trust-visible outcome.

## Priority

P0 / P1 / P2, with a link to the dependency map.

## Depends On

List required schemas, services, UI surfaces, policy gates, and tests.

## Data Objects

Which of `Artifact`, `MemoryCandidate`, `ActionProposal`, `IdentitySignal`,
`RelationshipCandidate`, or `ContextVisa` are created, read, updated, deleted,
or exported.

## Policy Rules

Consent, retention, review, quarantine, deletion, and export behavior.

## Non-Goals

What this task must not implement yet.

## Acceptance Criteria

Concrete pass/fail checks.

## Tests

Unit, integration, replay, prompt_test, iOS, or UI coverage.

## Failure Mode

What should happen when the model is wrong, the artifact is missing, confidence
is low, the user rejects the candidate, or policy denies the action.
```

Example:

```md
## Objective

Create an evidence-backed action card from a transcript-derived commitment.

## Priority

P0-D Action Proposal MVP.

## Depends On

Artifact ids, transcript artifact, ActionProposal schema, basic approve/dismiss
state.

## Data Objects

Reads Artifact. Creates ActionProposal. May create MemoryCandidate only after
user approval.

## Policy Rules

No side effect. No external write. Evidence required. Quarantined identity
signals cannot be used.

## Non-Goals

No auto-send, no shadow autonomy, no relationship inference.

## Acceptance Criteria

The card shows proposed action, evidence, risk, data egress, approve, dismiss,
and feedback.

## Tests

Golden proposal test, missing-evidence test, quarantined-identity exclusion
test.

## Failure Mode

If evidence is missing, create a diagnostic event instead of a proposal.
```

## Metrics

Track trust and governance, not only engagement:

- accepted suggestions per day,
- dismissed suggestions per day,
- false interruption rate,
- bad-timing feedback rate,
- memory correction rate,
- memory deletion rate,
- action approval rate,
- action undo rate,
- evidence coverage,
- replay reproducibility,
- quarantined-memory promotion rate,
- owner voice/face false-positive rate,
- heard-name confirmation rate,
- relationship-edge correction rate,
- rejected-identity resurfacing rate,
- privacy policy violations caught by tests,
- model drift failures,
- average time to answer "why did you do that?"

## Risks And Mitigations

### The System Feels Creepy

Mitigations:

- explicit capture state,
- consent graph,
- memory review,
- local-first defaults,
- owner-only biometric enrollment as the first identity step,
- non-owner identity quarantine by default,
- person memory confirmation,
- bystander-safe modes.

### The System Becomes Noisy

Mitigations:

- attention wallet,
- shadow autonomy,
- interruption scoring,
- daily review instead of real-time push for low-value items.

### The System Becomes Too Complex To Ship

Mitigations:

- phone-held loop first,
- evidence ledger minimal slice,
- action inbox before autonomy,
- glasses after repeatable phone verifier,
- one or two hero demos per phase.

### Competitors Ship Prettier Capture Products

Mitigations:

- do not compete on capture alone,
- compete on proof, replay, action, policy, and user-owned context.

## Anti-Roadmap

Avoid these traps:

- Building a pendant or custom hardware before the harness is trusted.
- Making chat the center of the product.
- Shipping autonomous actions before shadow calibration.
- Storing extracted memories without source evidence.
- Treating privacy as settings copy rather than executable policy.
- Chasing every provider integration before one end-to-end loop is reliable.
- Polishing UI around an unreliable capture/action path.
- Letting generated skills run without declared data needs and evals.
- Silently building a biometric identity database.
- Letting names, voice clusters, face clusters, or relationship edges become
  confirmed people without review.

## Final Review

The ordinary parts are useful but not category-defining:

- Live status cockpit,
- meeting summaries,
- glasses capture,
- provider integrations,
- prettier chat UI.

The hard parts are the point:

- schema and policy work,
- replayable artifacts,
- negative feedback loops,
- bystander-aware privacy,
- owner-first identity,
- relationship memory that refuses to guess,
- an agent that can explain and repair itself.

If those hard parts survive, HaoClaw can become something unusual: not an
ambient app, but a governed personal agent substrate.
