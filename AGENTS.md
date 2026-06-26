# AGENTS.md — hawky

This file is the **source of truth** for both humans and coding agents working in this repo.
`CLAUDE.md` and other agent configs should point here.

## What hawky is

hawky is a realtime **ambient agent**: a runtime that sees and hears your world 
(audio/ASR, camera, smart glasses) and surfaces help at the right moment. It spans a
TypeScript core + gateway, web clients, and a native iOS app, all wired through a single
WebSocket gateway.

## Repo map

| Path | What |
|------|------|
| `src/` | Core TypeScript runtime: agent loop, providers (Anthropic/OpenAI/Vertex), tools, memory, skills, MCP, node protocol, consumers, ambient engine, and the **gateway** (the hub). `src/index.ts` is the composition root. |
| `src/gateway/` | WebSocket server: device auth, permissions, cron/heartbeat, media ingest, external runtimes. Depends on `src/agent`; the agent never imports the gateway. |
| `src/ambient/` | Ambient intention engine: contracts, delivery modes, latent recognition, geofence/cron activation, reminders. |
| `web/` | Primary web client (React 19 + Vite + Vitest). |
| `web-ios/` | iOS-flavored web client variant. |
| `ios/` | Native iOS app `hawky` (SwiftUI): capture, glasses, live realtime, cocktail-party recognition. `ios/ThirdParty/` is a vendored pipecat SDK. |
| `services/` | Python sidecars (deepface face recognition). |
| `tests/` | TS core test suite (`e2e-*`, `test-*`). |
| `scripts/` | Ops/probe tooling (non-test). |
| `playgrounds/`, `prompt_test/` | Experiments + prompt-eval harness. |
| `deploy/`, `docs/`, `website/` | Deployment units, docs, marketing site. |

## Build / test

```sh
bun install                 # deps (root)
bun run hawky               # run the CLI / TUI
bun run hawky gateway       # run the gateway server
bun test                    # TS core test suite
cd web && bun install && bun run dev && bun test
cd web-ios && bun install && bun run dev && bun test
cd ios && xcodegen && xcodebuild -project hawky.xcodeproj -scheme hawky build
```

Config/state live under `~/.hawky/` (config, state, logs, skills). Per-repo agent
instructions can be placed in a `HAWKY.md` file at a project root.

## COMMIT POLICY (hard rules)

1. **Credit human contributors via `Co-authored-by` trailers (added manually).** One trailer
   line per human who contributed, using their `Name <email>`.
2. **NEVER an AI/bot as author or co-author** (enforced by `check_commit.sh`). No `Claude`,
   `Codex`, `noreply@anthropic.com`, `github-actions`, `dependabot`, or any bot in author or
   `Co-authored-by` fields.
3. **Conventional commits.** `type(scope): summary` (feat/fix/chore/docs/test/refactor).

Use the `commit` skill (`.claude/skills/commit/`) — it assembles the trailer set and blocks AI
co-authors before letting the commit through.

### Contributors

- zhisbug
- GindaChen
- rich7420
- jayzou3773
- Eden-kk

## Contribution workflow

1. Branch from `main`; never commit straight to `main`.
2. Make the change; run the relevant test suite.
3. `commit` skill -> assembles trailers, runs the AI-coauthor guard.
4. Open a PR. PR body: one-sentence summary up top, numbered limitations/follow-ups at the
   bottom.
5. Releases go through the `release` skill.

## Skills

- `.claude/skills/commit/` — enforce co-author trailers, block AI co-authors.
- `.claude/skills/release/` — tag + publish (npm CLI, web build, iOS archive) with a clean changelog.
