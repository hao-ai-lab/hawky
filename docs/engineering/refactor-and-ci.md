# Smaller boundaries and measurable CI

## What this change does

Hawky already has useful provider adapters and lifecycle tests. A rewrite would discard those safeguards. The first refactor removes concrete coupling without changing streaming semantics:

```text
Gateway: authentication, ownership, quota, session lifetime, delivery
    |
    +-> one configuration snapshot -> provider factory
                                      |
                                      +-> Gemini adapter
                                      +-> Venus adapter -> protocol/session
                                      +-> JoyAI adapter -> output parser / speech / playback

Shared delegation contracts <- gateway and live coordinators
Bun WebSocket transport      <- gateway proxy and JoyAI speech
```

- `src/live/provider-config.ts` is the single definition and pure resolver for operator-owned settings. Environment overrides are explicit, separately testable, and do not mutate configuration. Each connection sees one settings snapshot, rather than rereading the file while constructing an adapter.
- `src/live/provider-factory.ts` contains provider selection. The gateway handles access and lifetime; it no longer assembles provider-specific configuration inline. Unknown models fail explicitly.
- `src/live/providers/joyai-output.ts` owns parsing, reasoning removal, and delegation marker validation. Existing imports remain compatible through re-exports.
- `src/contracts/delegation.ts` owns serializable delegation types. Live code no longer depends on the gateway for these contracts; the gateway path remains a compatibility export.
- `src/platform/websocket.ts` contains Bun's authenticated-handshake overload. A real loopback WebSocket test checks headers; this also fixes two existing DOM/Bun constructor type errors.

The first hosted run also exposed web builds relying on root-installed Node types. The shared wire parser now accepts standard `Uint8Array` data (including Buffer subclasses), and the older web client declares its own Node and Vite types. Both web builds were verified with root `node_modules` temporarily absent.

Provider contracts and session behavior remain distinct. No common abstract provider class, rewritten event loop, changed wire protocol, cloud deployment, or credentials are needed for this refactor.

## Concrete checks

| Check | What a failure means |
|---|---|
| Root TypeScript + Bun build | Runtime interfaces or packaging no longer compile |
| 64 isolated backend shards | A unit/integration contract fails; no retries hide it |
| Both web builds | Either shipped web surface has a type/build regression |
| 4 web + 8 web-ios test shards | Browser state, capture, playback, reconnect, or UI behavior regresses |
| Live import boundary | Live code starts depending on gateway implementation or storage again |
| CI manifest test | A task disappears from Actions, test discovery loses/duplicates files, or a task name is invalid |
| Provider-specific regressions | Operator overrides, reasoning stripping, exact ASR model ID, authenticated WebSocket handshake |

All existing `tests/test-*.ts`, `tests/test-*.tsx`, `tests/unit/*.test.ts`, and `tests/integration/*.ts` are discovered automatically. The previous `bun run test` baseline had 4,901 cases and took 135 seconds on the development machine. It failed an outdated exact-copy assertion for `IDENTITY.md`; that test now accepts the actual established-character wording while retaining name and no-placeholder assertions.

Each backend test file gets its own process. This avoids leaked module mocks and environment changes, without marking flaky tests as passing. Shards use deterministic file-size balancing; there is no runtime dependency on historical timings. Web shards use explicit file lists, avoiding Vitest's possible empty last shard with ceiling-based partitioning.

## The 30-second requirement

**The enforceable contract is check execution, not total GitHub Actions elapsed time.** `scripts/ci/run.ts` budgets 28 seconds per task and fails on a test error, timeout, unfinished command list, or elapsed time of 30 seconds. Timing JSON is uploaded on failure as well as success. A timeout is a failed check, never a silently skipped test.

GitHub queueing, VM provisioning, checkout, dependency downloads/cache restore, artifact upload, and account concurrency limits are outside that execution timer. A cold hosted job or the complete 81-job matrix is not guaranteed to finish in 30 seconds. More shards cannot bypass the account's concurrency quota. The workflow's three-minute job timeout is an outer cleanup limit, not a claim about performance.

To make a wall-clock target plausible, use enough prewarmed isolated runners with Bun and dependencies already present, then measure cold/warm p95/p99 separately. Even that is a service-level target rather than an absolute guarantee during outages. Do not declare the entire CI under 30 seconds based on local cached timings.

The stable required check remains `Unit, Integration & Web Tests`, and succeeds only if the complete matrix passes. Branch protection can keep requiring that name. The fast suite has no provider secrets. External provider E2E remains a separately named workflow on main/manual dispatch, with visible failures and a ten-minute cap. It is explicitly outside the fast gate. Native Swift builds/device tests likewise cannot honestly be promised within 30 seconds and are not newly claimed as covered here.

## Running and measuring

```sh
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
(cd web-ios && bun install --frozen-lockfile)
bun run ci:check typecheck
bun run ci:check core:0
bun run ci:check web-ios:1
bun scripts/ci/local.ts
```

The local command runs the exact matrix with four workers (`CI_WORKERS` overrides it); total local wall time will exceed 30 seconds. Read `test-results/*.json` for each task and `test-results/logs/` for failures. There are no automatic test retries. Fix or split a slow test when it exceeds the budget; do not increase the budget to conceal the regression.

## Further simplification proposal

1. Split `gateway/agent-methods.ts` by RPC family, preserving registration and authorization in the gateway. Its roughly 2,700 lines are a larger next target than rewriting providers.
2. Move other serializable contracts out of gateway modules and give application services injected storage/tool interfaces. Extend boundary rules only after those imports are removed.
3. Make the CLI composition root assemble services; keep configuration reads and process environment access at that boundary.
4. Decide whether `web` and `web-ios` should share one application shell. Until then, both builds and test suites must stay mandatory.
5. Keep paid inference, hardware/media quality, iOS signing, and deployment verification distinct from deterministic repository CI. Test actual default model IDs against a staging server before an inference-host cutover.

This proposal intentionally leaves these larger changes for separate reviewable diffs. No production service was modified.
