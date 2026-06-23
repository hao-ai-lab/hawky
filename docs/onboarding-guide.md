# hawky + hawky Onboarding Guide

This guide walks through deploying `hawky` on a physical iPhone, connecting it to the `hawky` gateway running on a Mac, and pairing Ray-Ban Meta glasses. Follow the sections in order; each one calls out the setup issues that came up during a real end-to-end run and how they were resolved.

> This document does not contain real credentials, API keys, Meta Client Tokens, or other secrets. It only describes where each value belongs and what type of value is expected. Keep secrets in local, uncommitted files such as `ios/Secrets.xcconfig` or in environment variables.

Reference environment used for the successful run:

| Component | Version |
| --- | --- |
| macOS | 26.5 |
| Xcode | 26.5 (Swift 6.3.2) |
| Bun | 1.3.14 |
| Meta Wearables DAT SDK | 0.4.0 (`exactVersion`, pinned by `project.yml`) |
| Glasses | Ray-Ban Meta, Meta AI app >= v254, firmware >= v20 |

---

## 0. Overview: architecture and goal

```text
iPhone (hawky)            Mac (hawky gateway)              Anthropic
  audio/video capture -- Tailscale --> agent loop / sessions / media storage --> Claude
  Glasses tab                     ws://<tailscale-ip>:4242
        ^
  Ray-Ban Meta glasses (first-person camera + microphone)
```

For the glasses flow to work, the Mac gateway must be running first. Then the iPhone connects to that gateway, and finally the glasses are registered through the app.

---

## 1. iOS toolchain: Xcode 26 and Swift 6.2 or newer are required

**Why:** the Meta Wearables DAT binary frameworks (`MWDATCore` / `MWDATCamera`) were compiled with **Swift 6.2**. Older compilers cannot read their `.swiftinterface` files and fail with an error like:

```text
Failed to build module 'MWDATCamera'; this SDK is not supported by the compiler
(the SDK is built with 'Apple Swift version 6.2 ...'), while this compiler is
'Apple Swift version 6.0.3 ...'. Please select a toolchain which matches the SDK.
```

### Issues encountered

- **Xcode 15.4 cannot open the project.** The project uses `objectVersion = 77` (Xcode 16 format), so Xcode 15.4 reports a "future Xcode project file format (77)" error.
- **Xcode 16.2 (Swift 6.0.3) still cannot compile MWDAT.** Swift 6.0.3 is too old for the Meta SDK.
- **Final fix:** upgrade to **Xcode 26.5 (Swift 6.3.2)**. This requires a macOS 26-series release. After upgrading macOS, install Xcode 26 from the App Store.

### Verify

```bash
xcrun swift --version    # should be >= Swift 6.2
xcodebuild -version
```

---

## 2. Physical-device support components

The first physical-device build against iOS 26.5 can fail with:

```text
iOS 26.5 is not installed. Please download and install the platform from
Xcode > Settings > Components.
```

Download the iOS platform component, either from Xcode Settings or with:

```bash
xcodebuild -downloadPlatform iOS
```

> Use `-downloadPlatform iOS`, not `-downloadAllPlatforms`. The latter also downloads tvOS and watchOS platforms, which is slower and unnecessary for this setup.

### Simulator runtime build mismatch (known Xcode 26 issue)

Even for a physical-device build, asset catalog compilation (`actool`) can validate the simulator runtime and fail with:

```text
No simulator runtime version from [...] available to use with iphonesimulator SDK version 23F73
```

This happens when Xcode's bundled simulator SDK build does not match the runtime build available from Apple's download source, such as SDK `23F73` versus runtime `23F77`. In the successful setup, installing the platform component resolved the issue. If it still fails, remove duplicate or unusable runtimes:

```bash
xcrun simctl runtime list           # check for Unusable/Duplicate runtimes
xcrun simctl runtime delete <UUID>  # delete duplicates, leaving one Ready runtime
```

---

## 3. Meta SDK version: use 0.4.0, do not upgrade casually

**Key lesson:** if the build reports many errors such as `cannot find type 'StreamSession'` or `StreamSessionError has no member 'hingesClosed'`, do not immediately change the SDK version.

- Those missing-API errors are secondary failures. The real problem is that `MWDATCamera` failed to compile with an older Swift compiler, so the module was never produced and dependent types could not be found.
- After upgrading to Swift 6.3.2, the original `exactVersion: 0.4.0` builds successfully without changing the glasses code.
- In testing, SDK versions 0.5, 0.6, and 0.7 removed or renamed the `StreamSession` API surface, so upgrading made the situation worse.

`ios/project.yml`:

```yaml
packages:
  MetaWearablesDAT:
    url: https://github.com/facebook/meta-wearables-dat-ios
    exactVersion: 0.4.0
```

---

## 4. Signing and Meta credentials (`Secrets.xcconfig`)

The project originally hard-coded the author's `DEVELOPMENT_TEAM`, and the MWDAT credential build settings were empty placeholders (`$(CLIENT_TOKEN)` / `$(META_APP_ID)` were undefined, which builds empty strings).

### Fix: local `ios/Secrets.xcconfig` (do not commit)

Create `ios/Secrets.xcconfig` with three build settings:

```text
META_APP_ID  = <App ID generated by Meta Developer Center>
CLIENT_TOKEN = <Client Token generated by Meta Developer Center; include the full string with | and do not quote it>
DEVELOPMENT_TEAM = <your Apple Developer Team ID>
```

Attach it at the top level of `project.yml`:

```yaml
configFiles:
  Debug: Secrets.xcconfig
  Release: Secrets.xcconfig
```

Replace the two hard-coded `DEVELOPMENT_TEAM: <original-author-team>` entries in `project.yml` with:

```yaml
DEVELOPMENT_TEAM: "$(DEVELOPMENT_TEAM)"
```

This makes the value come from the local xcconfig file.

Add `Secrets.xcconfig` to `ios/.gitignore` to avoid committing credentials.

### Where the MWDAT values come from

| Info.plist field | Source |
| --- | --- |
| `MetaAppID` | Generated when creating the app in Meta Wearables Developer Center |
| `ClientToken` | Generated in the same place, usually shaped like `AR\|<appid>\|<hex>` |
| `TeamID` | Your Apple Developer Team ID; it **must match** the team registered in Meta Developer Center |
| `AppLinkURLScheme` | `hawky://`, matching the project's `CFBundleURLSchemes` |

### Regenerate the project and verify credentials are injected

```bash
cd ios
xcodegen generate
# After building, confirm that the MWDAT values in Info.plist are not empty:
APP="$HOME/Library/Developer/Xcode/DerivedData/hawky-*/Build/Products/Debug-iphoneos/hawky.app"
plutil -extract MWDAT xml1 -o - $APP/Info.plist
```

> If changing signing teams prevents an existing install from being overwritten, the error is usually `MismatchedApplicationIdentifierEntitlement` because the old and new `application-identifier` prefixes differ. Uninstall the old app first:
>
> ```bash
> xcrun devicectl device uninstall app --device <UDID> live.hawky
> ```

---

## 5. Build, install, and launch on a physical device

Get the device destination ID recognized by `xcodebuild`:

```bash
cd ios
xcodebuild -project hawky.xcodeproj -scheme hawky -showdestinations | grep "platform:iOS" | grep -v Simulator
```

Build with automatic signing:

```bash
xcodebuild -project hawky.xcodeproj -scheme hawky \
  -destination 'id=<DEVICE_ID>' -allowProvisioningUpdates build
```

Install and launch. Note that the device ID used by `devicectl` is different from the destination ID used by `xcodebuild`, so use the appropriate ID for each command:

```bash
APP="$HOME/Library/Developer/Xcode/DerivedData/hawky-*/Build/Products/Debug-iphoneos/hawky.app"
xcrun devicectl device install app --device <DEVICECTL_UDID> $APP
xcrun devicectl device process launch --device <DEVICECTL_UDID> live.hawky
```

The first physical-device run also requires trust and developer-mode setup on the iPhone:

- Settings -> General -> VPN & Device Management -> trust the developer.
- Settings -> Privacy & Security -> Developer Mode -> enable it and restart the phone when prompted.

---

## 6. Mac backend: hawky gateway

### Install

```bash
curl -fsSL https://bun.sh/install | bash      # install bun if needed
cd /path/to/hawky
bun install
```

### Start the gateway

Pass the API key through the environment rather than writing it into a config file:

```bash
export PATH="$HOME/.bun/bin:$PATH"
export ANTHROPIC_API_KEY="sk-ant-..."
bun run src/index.ts gateway --bind <tailscale-ip>
```

- `doctor` self-check, no API key required: `bun run src/index.ts doctor`
- Health check: `curl http://<tailscale-ip>:4242/health` -> `{"ok":true,"status":"live"}`

> The gateway is a long-running process. Do not close the Mac or let it sleep, or every client will disconnect. If the API key is passed through the environment, you must provide it again whenever you restart the gateway process.

---

## 7. Networking: use Tailscale instead of exposing `0.0.0.0`

By default, the gateway binds to `127.0.0.1`, which the iPhone cannot reach. Bind it to the Mac's Tailscale interface instead. Only devices signed into the same Tailscale account can reach it.

```bash
tailscale status        # confirm the Mac and iPhone are both online
tailscale ip -4         # Mac Tailscale IP, for example 100.x.x.x
```

- Use the address from `tailscale ip -4` as the gateway `--bind` value.
- When bound to a non-localhost address, the gateway enforces device-token authentication as defense in depth. The iPhone app includes the token flow and can authenticate automatically.
- Install Tailscale on the iPhone and sign into the **same account**. Verify from Safari with `http://<tailscale-ip>:4242/health`.

### In-app configuration

In hawky, open **Settings**, set Gateway URL to `http://<tailscale-ip>:4242`, then force-quit and reopen the app. When connected, the gateway log should show `client connected {"platform":"mobile"}`.

---

## 8. Web frontend (Mac browser)

```bash
cd web
bun install
export VITE_GATEWAY_URL="ws://<tailscale-ip>:4242"
export NODE_OPTIONS="--max-http-header-size=65536"   # see the 431 issue below
bun run dev          # http://localhost:5173
```

### Issue 1: HTTP 431 Request Header Fields Too Large

Large browser cookies can exceed Node's default 16 KB request-header limit, causing the page to fail or close. Fix it with `NODE_OPTIONS=--max-http-header-size=65536`, or use an incognito/private browser window.

### Issue 2: repeated refreshes and crash from an unauthorized reconnect loop

The gateway log repeatedly shows `connection closed {"code":1008,"reason":"unauthorized"}`, and the browser reconnects continuously. The root cause was that `web/vite.config.ts` proxied only `/ws` and missed `/auth/device`. The frontend request to `fetch("/auth/device?mode=json")` was handled by Vite itself and returned HTML instead of token JSON. Without a device token, every WebSocket connection was rejected.

The fix, already merged into `web/vite.config.ts`, is to proxy the HTTP endpoints too:

```ts
proxy: {
  "/ws":           { target, ws: true, changeOrigin: true },
  "/auth/device": { target, changeOrigin: true },
  "/api":         { target, changeOrigin: true },
}
```

Verify that `curl "http://localhost:5173/auth/device?mode=json"` returns `{"ok":true,"token":"eyJ..."}` instead of HTML.

---

## 9. Ray-Ban Meta glasses setup

### Prerequisites

- Pair the glasses with the official **Meta AI app** first and confirm Bluetooth is connected.
- Use Meta AI app >= **v254** and glasses firmware >= **v20**.
- Make sure the Meta credentials from section 4 are present in the app (`MWDAT.MetaAppID`, `ClientToken`, and `TeamID` are not empty).

### Register the app in Meta Wearables Developer Center

Go to https://wearables.developer.meta.com/, create an app, enable Device Access Toolkit, and copy the generated **MetaAppID** and **ClientToken**. The registered fields must match the iOS app exactly:

| Field | Value |
| --- | --- |
| Apple Team ID | Must match the app's signing team |
| iOS Bundle ID | `live.hawky` (**must not contain a hyphen `-`**; this is a known DAT limitation) |
| URL Scheme | `hawky://` |

### Critical issue: register fails with `internal error`

Symptom: tapping Register in hawky shows `Meta registration completed` in the video logs, meaning the request was sent successfully, but after switching to Meta AI, Meta AI displays **"internal error"**.

Debugging notes:

1. The error is **not thrown by hawky**. The app log shows that registration completed locally; Meta AI or Meta's service rejects the request during attestation.
2. Team ID, bundle ID, credentials, URL scheme, and app active status were all correct.
3. The actual cause was that the device or account was not inside the app's test authorization scope, so the registration request went through production attestation and failed. Meta's documentation says attestation is **"not used in Developer Mode"**.

### Fix: enable Developer Mode in the Meta AI app

Meta AI app -> **Settings -> App Info** -> tap the app version 5 times -> a **Developer Mode** switch appears -> turn it on.

Then return to hawky -> Glasses -> **Register**. Registration should succeed because attestation is no longer enforced.

> Alternative if Developer Mode is not enough: create a **Release Channel** in Developer Center, add your Meta account email, accept the email invitation, switch to that channel in Meta AI under Settings -> Release Channel, and register again. The successful run used Developer Mode, so this fallback was not needed.

### Registration diagnostics

`registerGlasses()` in `GlassesVideoStream.swift` now checks `configureError` before registration. On failure, it distinguishes `RegistrationError`, `WearablesError`, and other errors, printing the exact type and case so it is easier to tell whether an "internal error" came from configuration or registration.

---

## 10. Code changes produced during the successful setup

| File | Change |
| --- | --- |
| `ios/Secrets.xcconfig` | **Added locally only, not committed:** `META_APP_ID`, `CLIENT_TOKEN`, and `DEVELOPMENT_TEAM` |
| `ios/project.yml` | Added `configFiles` for `Secrets.xcconfig`; changed `DEVELOPMENT_TEAM` to read from the xcconfig variable |
| `ios/.gitignore` | Added `Secrets.xcconfig` |
| `ios/hawky/Glasses/GlassesVideoStream.swift` | Improved diagnostics in `registerGlasses()` |
| `web/vite.config.ts` | Added proxy entries for `/auth/device` and `/api` |

---

## 11. Quick rerun checklist after the environment is configured

```bash
# 1. Backend
export PATH="$HOME/.bun/bin:$PATH"
export ANTHROPIC_API_KEY="sk-ant-..."
cd /path/to/hawky && bun run src/index.ts gateway --bind $(tailscale ip -4 | head -1)

# 2. Web frontend (optional)
cd web && VITE_GATEWAY_URL="ws://$(tailscale ip -4 | head -1):4242" \
  NODE_OPTIONS="--max-http-header-size=65536" bun run dev

# 3. iPhone: enable Tailscale -> set the gateway URL in hawky Settings -> Glasses -> Register
#    Keep Meta AI Developer Mode enabled.
```

## Failure quick reference

| Symptom | Check first |
| --- | --- |
| Project will not open / format 77 | Xcode version; use Xcode 26 or newer |
| `SDK not supported by the compiler` | Swift version; use Swift 6.2 or newer, meaning Xcode 26 or newer |
| `iOS X.X is not installed` | Run `xcodebuild -downloadPlatform iOS` |
| `cannot find type StreamSession` | This is a secondary failure from `MWDATCamera` not compiling; upgrade Swift |
| Physical-device install fails with `MismatchedApplicationIdentifier` | Uninstall the old app before installing again |
| iPhone app cannot connect to gateway | Check that gateway `--bind` uses the Tailscale IP and both devices are online in the same Tailscale account |
| Web page refreshes repeatedly and crashes | Check whether the Vite proxy is missing `/auth/device`; for 431 errors, increase the header-size limit |
| Glasses register fails with `internal error` | Enable Developer Mode in Meta AI, or create and join a release channel |
