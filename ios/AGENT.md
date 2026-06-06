# Hawky — agent onboarding

This is an xcodegen-driven iOS SwiftUI app. `project.yml` is the source of truth
for the Xcode project; `hawky.xcodeproj/project.pbxproj` is regenerated.

## Regenerate the Xcode project

```
xcodegen generate
```

Run this after editing `project.yml` or adding/removing/renaming source files.

## Build (simulator, Debug)

```
xcodebuild -project hawky.xcodeproj -scheme hawky \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build | tail -40
```

Expect `** BUILD SUCCEEDED **` at the tail.

## Install on a paired iPhone

Use the `ios-install` skill for device installs.

## Add a new source file

1. Drop the `.swift` file into the correct folder under `hawky/`
   (`App/`, `Networking/`, `Stores/`, `Views/`, or `Keychain/`).
   Filenames must be globally unique within the target.
2. Run `xcodegen generate`.
3. Rebuild.

## Tests

`hawkyTests/` uses Swift Testing (`import Testing`). Run via the test
scheme in Xcode or `xcodebuild test`.

## Post-install smoke test

After any change that touches build, entitlements, or startup, run:

```
scripts/sim-smoke.sh
```

Defaults to the first available iPhone simulator and `live.hawky`.
The script builds, installs, launches, waits 8 s,
verifies the process is still alive via `launchctl list`, takes a screenshot
under `/tmp/hawky-sim/`, and scrapes the recent unified log for crash
markers. Prints a one-line `SIM SMOKE: ok|fail …` summary and exits non-zero
on failure. Eyeball the screenshot — that's the enforcement of the "do not
ship unverified launches" rule from the user feedback memory.

Flags: `--udid`, `--bundle`, `--timeout`. See the eval doc at
`hawky-plan/research/sim-automation-evaluation.md` for the tooling
comparison (native vs vphone-cli vs XCUITest).
