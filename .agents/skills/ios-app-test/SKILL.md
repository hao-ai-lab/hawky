---
name: ios-app-test
description: Run and report the local-first iOS simulator testing workflow for the hawky app. Use when asked to test the iOS app, verify an iOS UI change, run simulator smoke checks, exercise XcodeBuildMCP screenshots/taps/accessibility, run hawky UI tests, or produce an iOS UX/accessibility audit report for this repo. Works with any MCP-capable agent (Claude Code, Codex).
---

# iOS App Test

Use this skill to test `ios/hawky` locally through deterministic commands plus XcodeBuildMCP simulator automation.

This skill's source of truth is `.agents/skills/ios-app-test/SKILL.md`.
Claude Code loads the same file through the `.claude/skills/ios-app-test/SKILL.md`
symlink.

## Scope

This skill is simulator-first. It verifies build, launch, navigation, Live/Settings UI, semantic accessibility, deterministic unit/UI tests, screenshots, and obvious UX regressions.

Do not claim physical-device coverage. These still need manual device verification:

- Live Activity / Dynamic Island
- BLE glasses pairing and HFP audio
- Camera capture quality
- AVAudioSession / live mic behaviour
- Real authenticated gateway sessions over Tailscale

## Prerequisites / First Run

**Before any run, confirm the environment is ready.** The cheap per-run check is `session_show_defaults` (Modes → Step 0). On a fresh checkout, or when Step 0 surfaces a problem, run the full detect + setup below — auto-fix what is safe, surface what needs a human, and never silently change the system (no unsanctioned `brew`).

1. **Detect:** run `bun run ios:mcp:doctor`. It reports Xcode, the simulator, `axe` (UI automation), and `lldb` status.

2. **Safe to auto-fix (do without asking):**
   - Project missing or stale vs `ios/project.yml`: run `bun run ios:check-generated`. If it reports generated drift, keep the generated project updates that match `ios/project.yml`; use `bun run ios:generate` when the project file itself must be regenerated outside a check.
   - Default simulator missing: create the configured `IOS_SIMULATOR_NAME` (defaults to `iPhone 17 Pro`) with the latest available iOS runtime, or fall back to another booted device and note the substitution in the report.
   - XcodeBuildMCP itself is fetched on demand by `npx` via `.mcp.json` / `.codex/config.toml` — no manual install.

3. **Surface, do not auto-change the system:**
   - **XcodeBuildMCP tools not available** (e.g. `session_show_defaults` is missing): the server is registered in `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex), but the agent must be **restarted** and the project MCP server **trusted/approved** before the tools load. Ask the user to do this, then retry. The deterministic commands (`ios:sim-smoke` / `ios:ui-test` / `ios:test`) still run without the MCP server.
   - **`axe` not installed:** only the best-effort `snapshot_ui` / `tap` exploratory path needs it (`brew tap cameroncooke/axe && brew install axe`). The deterministic XCUITest path does not. Recommend it; do not run `brew` without consent.
   - **Xcode missing or wrong version:** cannot auto-fix — stop and report.

4. **Gateway (optional):** only connected-session flows need it. UI-render, navigation, and audit modes run fine disconnected under `--uitesting`. Start with `bun run gateway` only when a test needs a live session.

## Modes

**Step 0 (always, before any mode):** confirm the environment is ready. Call `session_show_defaults` to verify the project/scheme/simulator and that XcodeBuildMCP tools are loaded. If tools are missing or anything looks off, run `bun run ios:mcp:doctor` and resolve it per **Prerequisites / First Run** above before continuing. Never skip this — a broken environment should surface as a clear pre-flight failure, not a mid-run error.

**Step 1 (backend scope):** choose the smallest backend mode that matches the request and state it in the report.

- **pure-ui**: default for navigation, form, accessibility, screenshot, and report checks. Do not start the gateway.
- **mock+seed**: default for connected-looking UI states. Use launch configuration / launch environment and in-memory mocks such as `IOS_UI_TESTING_LIVE_MOCK=1`; future seed profiles should use env-backed fixtures instead of a real gateway.
- **live-integration**: only when the user explicitly asks to verify real gateway behaviour. Check settings and environment first:
  - Resolve the gateway URL from `IOS_INTEGRATION_GATEWAY_URL`, then `IOS_LIVE_GATEWAY_URL`, else `http://127.0.0.1:4242`.
  - Check `/health` for that URL. If a sandboxed `curl` fails but `lsof` or a user shell shows the port is listening, rerun the health check/test outside the sandbox with approval before reporting the gateway as down.
  - If the gateway is not running and the user wants the harness to start it, set `IOS_LIVE_START_GATEWAY=1`; otherwise ask the user to start `bun run gateway`.
  - When starting the gateway, confirm provider credentials/config exist (`OPENAI_API_KEY`, Anthropic key, or Vertex config depending on `~/.hawky/config.json`) because gateway startup can fail before `/health` if provider auth is missing.
  - For simulator-hosted Swift tests, shell env is not enough: the live script sets `IOS_INTEGRATION_GATEWAY_URL` inside simulator launchd before running tests.
  Run `bun run ios:test:live` for the non-LLM handshake/session path, or `bun run ios:test:live:chat` only when API-key-backed chat round-trips are intended. Report that the run depended on a live backend.

Then choose the smallest mode that matches the request.

- **Quick smoke**: use for "does the iOS app still launch?" Run `bun run ios:sim-smoke`, then XcodeBuildMCP screenshot if available.
- **Targeted verification**: use for changed screens or UI flows. Run the relevant deterministic command, then drive that screen with XcodeBuildMCP.
- **Exploratory audit**: use for UX/accessibility review. Inspect major screens with screenshots and `snapshot_ui`, interact with visible controls, and report prioritized findings.

## Deterministic Commands

Run from the repo root unless noted.

1. `bun run ios:sim-smoke`
2. `bun run ios:ui-test`
3. `bun run ios:test` when the user asks for full test coverage or before high-risk merge decisions.
4. `bun run ios:test:live` when the user explicitly asks for localhost gateway integration. It checks `IOS_INTEGRATION_GATEWAY_URL` / `IOS_LIVE_GATEWAY_URL` (default `http://127.0.0.1:4242`), verifies `/health`, injects the resolved URL into simulator launchd, then runs only the handshake/session Swift tests. Set `IOS_LIVE_START_GATEWAY=1` only when the harness should start `bun run gateway` itself. Use `bun run ios:test:live:chat` for the slower LLM-backed chat round-trip.
5. `bun run ios:test:report` when the user asks for a human-readable report. It runs the UI-test suite with a fixed `.xcresult` path, exports attachments, and writes `ios/reports/<run>/index.html`. When a local GUI is available and the user wants to inspect the report, open the generated `index.html`; otherwise report the path and explain why it was not opened.
6. `bun run ios:check-generated` before PR-ready validation when target membership, schemes, bundle settings, or `ios/project.yml` changed.

Notes:

- `ios:ui-test` launches normal UI tests with `--uitesting`, which disables onboarding/intro, seeds deterministic state, disables Live Activity/Lock Screen UI, and avoids external gateway/BLE dependencies.
- First-run onboarding coverage uses the dedicated `--uitesting-onboarding` launch path while preserving deterministic UI-test defaults.
- `IOS_UI_TESTING_TABS` can seed alternate tab layouts for UI-test page audits. Keep each iPhone layout to four feature tabs plus Settings for stable tab-bar visibility.
- `IOS_UI_TESTING_LIVE_MOCK=1` enables an in-memory mock Live provider for connected-session UI tests. It must not persist provider changes to user defaults or require OpenAI credentials, gateway calls, mic capture, camera capture, or recordings.
- `JC_SEED` selects deterministic app data for mock+seed UI states. Current profiles are `empty`, `chat-populated`, `sessions`, `mixed`, `recordings`, and `error`; use these instead of a live gateway when the test only needs seeded sessions or chat history. Fixture timestamps and IDs should stay fixed so screenshots and assertions do not drift.
- `ios:test` includes current unit and snapshot tests. If snapshot baselines fail, report them separately as visual-regression work; do not hide them as a simulator-loop failure.
- Live gateway integration tests are env-gated. Without `IOS_INTEGRATION_GATEWAY_URL` they skip immediately, so normal `ios:test` never waits on a personal Tailscale host or localhost gateway. The live scripts set this env var and point to localhost by default.
- Do not add test-only gateway bypass tokens or loosen localhost WebSocket auth. The gateway already exposes `/auth/device` for localhost token issuance; iOS live tests should fetch a real device token through `DeviceAuthClient` and connect with the same WebSocket auth path production uses.
- `ios:test:report` uses Xcode 16's supported `xcrun xcresulttool get test-results summary/tests` path. Do not switch it to older `xcresulttool get object` commands or unpinned third-party HTML tools unless they are verified on the team's current Xcode version.
- The generated HTML should be useful for humans: each TestSpec expands to backend mode, seed profile, action / expected / actual steps, and inline screenshots exported from the `.xcresult`, so reviewers can inspect the actual app screens without opening Xcode.
- If sandboxing blocks CoreSimulator, rerun with approval rather than treating it as an app failure.
- If XCUITest reports `unexpected exit`, `test runner unexpected exit`, or `Test crashed with signal kill`, inspect the `.xcresult` to classify the failure, then rerun once before changing app/test code. Treat it as a runner/CoreSimulator flake unless the rerun produces a deterministic assertion or crash with the same test location.

### Test Seam Hygiene

Keep app launch preparation at the composition boundary:

- Production views, stores, and containers should read typed `LaunchConfiguration` values such as onboarding mode, gateway mode, Live provider mode, glasses step mode, and camera autostart.
- Do not add scattered `if UITestingSupport.isEnabled` branches in production views or stores. `UITestingSupport` should only translate DEBUG-gated launch args/env vars into `LaunchConfiguration`.
- Keep app-target UI-test env readers and deterministic seed fixtures DEBUG-only. Release builds should resolve `LaunchConfiguration.current()` directly to `.production` and should not embed mock transcript / recording fixture content.
- If a seam only exists to reach a screen, prefer an existing app navigation affordance or a production deep link over new test-only state. Use accessibility identifiers for stable selectors; they are production accessibility metadata, not test-only logic.
- Keep specs granular: data-driven screen catalogs are fine, but each screen/scenario should emit a named activity or spec-level attachment so the HTML report shows what was covered separately.
- Keep backend scope explicit in specs: use `pure-ui` for navigation/form checks, `mock+seed` for deterministic fixture-backed UI states, and reserve `live-integration` for explicit localhost/gateway runs.
- Keep screen coverage manifest-backed. `ios/hawkyUITests/ScreenManifest.json` is the source of truth for screen ids, deep-link reachability, and expected identifiers; UI tests and the HTML report both read from it. When adding a new screen, add or update its manifest entry and make sure a TestSpec covers that manifest id.
- Prefer one deep-link target per UI test method. In practice, batching many `app.open(url)` calls in one XCUITest can trigger runner restarts even when each assertion passes. A single-screen deep-link spec gives cleaner report sections and a more stable simulator run.
- Terminate the app in UI-test teardown. Runtime-heavy screens such as Live2, Pipecat, camera, or sheet routes can continue work after the assertion; explicit termination prevents cross-test contamination and runner restarts.
- Put `accessibilityIdentifier` on the actual field, button, toggle, picker, or a harmless section title. Avoid assigning an identifier to a `VStack`, `HStack`, `List`, or `Form` that contains controls the tests also need to query; SwiftUI can expose the container identifier in a way that masks child control identifiers in XCUITest.
- Keep scroll-search assertions fast. For controls that may be below the fold, check `exists` or use a short initial wait before swiping; do not spend the full `waitForExistence` timeout before every swipe, or long forms will accumulate dead wait time.
- Keep simulator permissions and animation control in the harness where possible: `UIView.setAnimationsEnabled(false)` through launch config, and `xcrun simctl privacy booted grant all <bundle id>` from the test runner or manual setup when a flow truly needs permissions.

### Team / Local Overrides

The npm scripts call `ios/scripts/xcode-*.sh` wrappers. They infer defaults from `ios/project.yml`, but every important Xcode setting is overrideable without editing tracked files:

- `IOS_PROJECT_PATH` or `IOS_WORKSPACE_PATH`
- `IOS_SCHEME`
- `IOS_SIMULATOR_NAME`, `IOS_DESTINATION`, `IOS_BUILD_DESTINATION`
- `IOS_UNIT_TEST_TARGET`, `IOS_UI_TEST_TARGET`, `IOS_TEST_ONLY`
- `IOS_XCODEGEN_SPEC`
- `IOS_GENERATED_PROJECT_PATH`
- `IOS_BUNDLE_ID`, `IOS_APP_TARGET_NAME`, `IOS_APP_PRODUCT_NAME`, `IOS_APP_PROCESS_NAME`
- `IOS_CONFIGURATION`, `IOS_RELEASE_CONFIGURATION`
- `IOS_DEVELOPMENT_TEAM`, `IOS_DISTRIBUTION_TEAM`, `IOS_VERSION_PLISTS`

Examples:

```bash
IOS_SCHEME=MyApp IOS_PROJECT_PATH=MyApp.xcodeproj bun run ios:ui-test
IOS_WORKSPACE_PATH=MyApp.xcworkspace IOS_SCHEME=MyApp bun run ios:test
IOS_SIMULATOR_NAME="iPhone 16 Pro" bun run ios:sim-smoke
```

Use these env vars for teammates with different local Xcode project/workspace/scheme names, bundle ids, signing teams, simulators, or renamed app targets. `ios:install-device` and `ios/scripts/testflight-upload.sh` share the same resolver, and also accept CLI flags such as `--project`, `--workspace`, `--scheme`, `--bundle`, `--team`, and `--simulator`.

Do not hard-code a personal project path, simulator UDID, bundle id, Apple team id, or renamed local project path into the skill, shared npm scripts, or `.xcodebuildmcp/config.yaml`. Shared files should contain repo defaults only; local differences belong in env vars, CLI flags, or XcodeBuildMCP `session_set_defaults`.

When validating overrides, set env vars on the wrapper command itself, for example `IOS_SCHEME=MyApp bun run ios:ui-test`. Do not commit shell-local experiments or generated local defaults just because they made one machine pass.

## Known Limitation: Semantic Capture On This App

Observed on this repo: XcodeBuildMCP `snapshot_ui` / `wait_for_ui` can return an **empty accessibility tree** for `hawky` (root only, no targets) even when `screenshot` is correct and deterministic XCUITests pass. In the last validation this happened outside and inside `--uitesting`; AXe could still read other simulator surfaces, so treat it as an app/tool interaction until investigated further. AXe also requires `Simulator.app` to be frontmost (`open_sim`) before any capture works at all.

Consequences for this skill:

- **Deterministic XCUITest (`bun run ios:ui-test`) is the primary assertion path** — it queries the accessibility tree in-process via the test runner and sees every identifier.
- Use **`screenshot`** for visual / UX audit evidence.
- Treat `snapshot_ui` tap-by-elementRef as **best-effort**: attempt it (it may work in an interactive Codex session), but if the tree is empty, do not block — assert via XCUITest and report visually. Never call the app untested solely because the semantic tree is empty.

## XcodeBuildMCP Loop

Use shared defaults from `.xcodebuildmcp/config.yaml` as the first choice. If the current checkout or teammate's local setup uses a different project/workspace/scheme/simulator, set the active MCP session defaults with `session_set_defaults` instead of editing shared config.

1. `session_show_defaults`
   - Confirm project/workspace matches the current checkout or local override
   - Confirm scheme matches the deterministic command being run
   - Confirm configuration `Debug`
   - Confirm simulator matches `IOS_SIMULATOR_NAME` or the fallback reported in the test report
2. `build_run_sim`
   - Prefer launch arg `--uitesting` for deterministic verification.
   - Observe bundle id and build duration.
3. `screenshot`
   - Confirm the expected first screen.
4. `snapshot_ui`
   - Call `open_sim` first, or otherwise ensure Simulator.app is foreground. AXe can fail or return partial results when Simulator is backgrounded.
   - Use semantic labels/identifiers and element refs.
   - Prefer identifiers like `tab.live`, `tab.settings`, `live.emptyState`, `live.agentPill`, `live.more`, `live.toggleAudio`, `live.toggleVisual`, `live.start`.
   - If SpringBoard snapshots work but this app's screenshot is normal and `snapshot_ui` returns only the app root with no targets, report this as an MCP semantic capture caveat and fall back to `bun run ios:ui-test` plus screenshots. Do not call the app flow untested solely because the MCP semantic tree is empty.
5. Interact with `tap`, `type_text`, `swipe`, or `wait_for_ui`.
   - Use element refs from the latest snapshot.
   - Avoid raw coordinates unless no semantic element exists.
6. `screenshot` again.
   - Confirm navigation or state changed.

## Audit Checklist

Check at least:

- Live tab renders `Talk to Hawky`
- Settings tab renders and rows are reachable
- Live/Settings tab switching works
- floating Live controls are visible and identified
- tappable controls have useful labels or accessibility identifiers
- no onboarding, modal, keyboard, or connection error blocks the target flow
- text is not clipped or overlapping on iPhone 17 Pro

Flag these explicitly:

- tappable element has no label and no identifier
- identifier is missing from a key control
- interaction depends on screen coordinates
- screenshots show clipped/overlapping text
- deterministic command fails
- simulator-only coverage leaves a device-only gap

## Report Format

Return a concise report:

- Verdict: pass / pass with caveats / fail
- Commands run and outcomes
- HTML report path when `bun run ios:test:report` was run
- Whether the HTML report includes inline step screenshots, and screenshot count when available
- Simulator, bundle id, and build duration when observed
- Screens or flows tested
- Screenshot/log paths when available
- Pass/fail items
- Accessibility gaps
- UX findings, ordered by severity
- Blockers/flakes
- Simulator-only scope note

When a failure is environmental, name the layer: sandbox permission, CoreSimulator, XcodeBuildMCP connection, build, app launch, deterministic assertion, snapshot baseline, or UI behaviour.
