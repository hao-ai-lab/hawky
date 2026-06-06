# Local iOS dev loop

Local-first, agent-driven build / run / screenshot / UI-test loop for the
`Hawky` app. No GitHub CI required. Tracking: #605.

There are two layers:

1. **Deterministic CLI** — plain `xcodebuild` / `simctl` wrappers you (or CI
   later) can run by hand. Stable, scriptable, no agent needed.
2. **Agent loop (XcodeBuildMCP)** — lets Claude Code (or any MCP client) drive
   the simulator: build → run → read the accessibility tree → tap/swipe →
   screenshot → verify, all inside the agentic loop. This is the same
   foundation OpenAI's "Build iOS Apps" Codex plugin uses.

---

## 1. Deterministic CLI (npm scripts)

Run from the repo root:

| Script | What it does |
| --- | --- |
| `bun run ios:generate` | Regenerate the Xcode project from `ios/project.yml` (XcodeGen is the source of truth) |
| `bun run ios:check-generated` | Regenerate from `ios/project.yml`, then fail if the generated Xcode project has drift |
| `bun run ios:build-sim` | Build the app for a generic simulator |
| `bun run ios:test` | Run the unit/snapshot test target on the configured simulator |
| `bun run ios:ui-test` | Run deterministic UI tests with `--uitesting` on the configured simulator |
| `bun run ios:sim-smoke` | Build → install → launch → screenshot → scrape logs for crashes; prints a one-line `SIM SMOKE: ok/fail` verdict |
| `bun run ios:mcp:doctor` | XcodeBuildMCP environment check (Xcode, simulators, `axe`, LLDB) |

The CLI wrappers in `ios/scripts/xcode-*.sh` derive repo defaults from
`ios/project.yml`: scheme/project name defaults to the XcodeGen `name`, unit
tests default to `<scheme>Tests`, UI tests default to `<scheme>UITests`, and
the smoke-test bundle id comes from the application target's
`PRODUCT_BUNDLE_IDENTIFIER`. Team members can override these without editing
tracked files:

| Override | Applies to |
| --- | --- |
| `IOS_PROJECT_PATH=MyApp.xcodeproj` | Xcode project path |
| `IOS_WORKSPACE_PATH=MyApp.xcworkspace` | Xcode workspace path; takes precedence over `IOS_PROJECT_PATH` |
| `IOS_SCHEME=MyApp` | build/test scheme |
| `IOS_SIMULATOR_NAME="iPhone 16 Pro"` | simulator name for tests/smoke |
| `IOS_DESTINATION="platform=iOS Simulator,id=<UDID>"` | full test destination |
| `IOS_BUILD_DESTINATION="generic/platform=iOS Simulator"` | build-only destination |
| `IOS_UNIT_TEST_TARGET=MyAppTests` | `bun run ios:test` target |
| `IOS_UI_TEST_TARGET=MyAppUITests` | `bun run ios:ui-test` target |
| `IOS_XCODEGEN_SPEC=Project.yml` | custom XcodeGen spec for generate/drift checks |
| `IOS_GENERATED_PROJECT_PATH=MyApp.xcodeproj` | drift-check path |
| `IOS_BUNDLE_ID=com.example.MyApp` | smoke-test launch bundle |
| `IOS_APP_TARGET_NAME=MyApp` | application target name when it differs from the scheme |
| `IOS_APP_PRODUCT_NAME=MyApp` | built `.app` product name for smoke tests |
| `IOS_APP_PROCESS_NAME=MyApp` | process name for simulator log filtering |
| `IOS_CONFIGURATION=Debug` | build/test configuration |
| `IOS_RELEASE_CONFIGURATION=Release` | archive configuration |
| `IOS_DEVELOPMENT_TEAM=ABCDE12345` | device build signing team |
| `IOS_DISTRIBUTION_TEAM=ABCDE12345` | TestFlight export signing team |
| `IOS_VERSION_PLISTS=App/Info.plist,Widget/Info.plist` | Info.plists to version for TestFlight |

Examples:

```bash
IOS_SCHEME=MyApp IOS_PROJECT_PATH=MyApp.xcodeproj bun run ios:ui-test
IOS_WORKSPACE_PATH=MyApp.xcworkspace IOS_SCHEME=MyApp bun run ios:test
IOS_SIMULATOR_NAME="iPhone 16 Pro" bun run ios:sim-smoke
```

The default simulator for this repo's screenshots/snapshots is **iPhone 17
Pro**, but it is intentionally an overrideable default rather than a script
constant.

`ios:install-device` and `ios/scripts/testflight-upload.sh` use the same
`ios/scripts/xcode-env.sh` resolver. Prefer one-off env vars or CLI flags such
as `--project`, `--workspace`, `--scheme`, `--bundle`, `--team`, and
`--simulator` for local machine differences. Do not commit personal simulator
UDIDs, bundle ids, Apple team ids, or renamed local project paths into
`package.json`, `.xcodebuildmcp/config.yaml`, or the repo skill.

Run `ios:check-generated` before PR-ready validation when `ios/project.yml`,
target membership, schemes, or bundle settings change. It is intentionally a
drift check: keep generated project changes that match `project.yml`, and
investigate any unexpected diff.

`ios:ui-test` launches normal UI tests with `--uitesting`. That mode skips the
launch intro and onboarding, seeds deterministic state, disables node role
startup and Live Activity UI, and avoids external gateway/BLE dependencies so
the first UI assertions are deterministic. First-run onboarding coverage uses
the dedicated `--uitesting-onboarding` path. UI tests can also pass
`IOS_UI_TESTING_TABS` to seed alternate tab layouts for broader page
coverage, and `IOS_UI_TESTING_LIVE_MOCK=1` to start a local mock Live
session without OpenAI credentials, gateway calls, mic capture, camera capture,
or recordings. Keep each iPhone layout to four feature tabs plus Settings for
stable tab-bar visibility.

---

## 2. Agent loop (XcodeBuildMCP)

### Setup (already in the repo, team-shared)

- `/.mcp.json` — registers the `XcodeBuildMCP` MCP server (`npx -y
  xcodebuildmcp@2.6.2 mcp`). Pinned for reproducibility; bump deliberately.
  - `XCODEBUILDMCP_ENABLED_WORKFLOWS=simulator,ui-automation,debugging,logging`
    loads only the workflow groups we use, keeping the agent's tool context
    small (the server ships 72+ tools across groups we don't need here).
  - `XCODEBUILDMCP_SENTRY_DISABLED=true` — no telemetry.
- `/.codex/config.toml` — the same server registered for Codex (CLI / IDE),
  which uses TOML instead of `.mcp.json`. So Claude Code and Codex drive the
  identical loop. (Codex users can alternatively install OpenAI's "Build iOS
  Apps" plugin, which bundles the same XcodeBuildMCP.)
- `/.xcodebuildmcp/config.yaml` — read by the MCP server regardless of which
  agent connects; pins this repo's default `projectPath` / `scheme` /
  `configuration` / `simulatorName` so the agent doesn't rediscover them. If a
  teammate uses a different local project/workspace/scheme/simulator, override
  the active MCP session with `session_set_defaults` instead of editing shared
  config.

### Enabling it

`.mcp.json` is project-scoped, so **Claude Code must be restarted** (and the
project MCP server approved) before the tools load — MCP servers connect at
session start. Verify with `bun run ios:mcp:doctor` (CLI) or by asking the
agent to list its tools.

Environment confirmed working on this machine: Xcode 26.1.1, `axe` 1.7.1 (UI
automation ready), `lldb-dap` (debugging ready).

### The loop (tool names the agent calls)

The canonical sequence is:

1. `session_show_defaults` → confirm `projectPath`, `scheme`, `configuration`,
   and `simulatorName`; if they do not match the current checkout or local
   override, call `session_set_defaults` for this session
2. `build_run_sim` → build, install, and launch on the configured simulator
3. `screenshot` → confirm the expected screen rendered
4. `snapshot_ui` → read the semantic accessibility tree and collect `elementRef`
   targets
5. UI interaction: `tap`, `type_text`, `swipe`, or `gesture` using element refs
   where available, not raw coordinates
6. `wait_for_ui` and/or `screenshot` again → verify the result
7. Logs: use the `runtimeLogPath` / `osLogPath` returned by `build_run_sim` or
   `launch_app_sim`
8. Debugging when needed: `debug_attach_sim`, `debug_breakpoint_add`,
   `debug_stack`, `debug_variables`, and related LLDB tools

Prefer `snapshot_ui` (semantic accessibility tree with element refs) over raw
coordinates — it's why agent-driven UI testing is robust without writing
XCUITest scripts.

---

## 3. Repo skill

Codex discovers repo-scoped skills from `.agents/skills`. This repo includes:

```text
.agents/skills/ios-app-test/SKILL.md
```

Use `$ios-app-test` when asking Codex to run the iOS testing workflow. Claude
Code loads the same source through `.claude/skills/ios-app-test/SKILL.md`. The
skill packages the deterministic commands, XcodeBuildMCP loop, UX/accessibility
audit checklist, and report format for this app.

---

## Reference

- XcodeBuildMCP: https://www.xcodebuildmcp.com/
- OpenAI "Build iOS Apps" plugin (open source, same architecture):
  https://github.com/openai/plugins/tree/main/plugins/build-ios-apps
