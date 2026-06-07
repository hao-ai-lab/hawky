#!/usr/bin/env bash
# sim-smoke.sh — post-install liveness harness for an iOS Simulator app.
# Proves: app installed, launched, still alive after N seconds, UI screenshot taken,
# no crash/fault lines in the recent unified log. Prints a one-line SUMMARY.
#
# Usage: scripts/sim-smoke.sh [--udid UDID] [--simulator NAME]
#                             [--project PATH | --workspace PATH] [--scheme NAME]
#                             [--app-name NAME] [--bundle ID] [--timeout SEC]
# Exits non-zero on any failure (bad boot, install fail, process gone, error lines).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/xcode-env.sh"

UDID=""
BUNDLE=""
TIMEOUT=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --udid) UDID="$2"; shift 2;;
    --simulator|--simulator-name) IOS_SIMULATOR_NAME="$2"; shift 2;;
    --project) IOS_PROJECT_PATH="$2"; shift 2;;
    --workspace) IOS_WORKSPACE_PATH="$2"; shift 2;;
    --scheme) IOS_SCHEME="$2"; shift 2;;
    --app-name|--product-name) IOS_APP_PRODUCT_NAME="$2"; shift 2;;
    --bundle) IOS_BUNDLE_ID="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    -h|--help) sed -n '2,8p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

ios_load_xcode_defaults
ios_set_xcode_container_args

BUNDLE="$(ios_bundle_id 2>/dev/null || true)"
[[ -n "$BUNDLE" ]] || {
  echo "Unable to derive bundle id from project.yml. Set IOS_BUNDLE_ID or pass --bundle BUNDLE_ID." >&2
  exit 2
}

SIMULATOR_NAME="$IOS_SIMULATOR_NAME"
SHOT_DIR="/tmp/${IOS_SCHEME}-sim"
mkdir -p "$SHOT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
SHOT="$SHOT_DIR/${TS}.png"

if [[ -z "$UDID" ]]; then
  UDID="$(
    xcrun simctl list devices available |
      awk -F'[()]' -v name="$SIMULATOR_NAME" '
        {
          device = $1
          sub(/^[[:space:]]+/, "", device)
          sub(/[[:space:]]+$/, "", device)
          if (device == name) {
            print $2
            exit
          }
        }
      '
  )"
fi
[[ -n "$UDID" ]] || {
  echo "No available $SIMULATOR_NAME simulator found. Pass --udid UDID or --simulator NAME." >&2
  exit 2
}
SHORT_UDID="${UDID:0:8}"

fail() {
  local reason="$1" alive="${2:-n}" err="${3:-0}"
  echo "SIM SMOKE: fail bundle=$BUNDLE udid=$SHORT_UDID alive=$alive screenshot=$SHOT errorLines=$err reason=$reason"
  exit 1
}

echo "[sim-smoke] target simulator=$SIMULATOR_NAME udid=$UDID bundle=$BUNDLE timeout=${TIMEOUT}s"

# 1. Boot sim if needed.
STATE="$(xcrun simctl list devices | grep "$UDID" | sed -E 's/.*\(([A-Za-z]+)\) *$/\1/' | head -1)"
if [[ "$STATE" != "Booted" ]]; then
  echo "[sim-smoke] booting $SHORT_UDID (was: $STATE)"
  xcrun simctl boot "$UDID" || fail "boot"
  xcrun simctl bootstatus "$UDID" -b >/dev/null || fail "bootstatus"
fi

# 2. Build + install. Keep DerivedData outside the repo and clear it each run
# so branch/signing switches cannot poison the smoke build with stale artifacts.
BUILD_DIR="$SHOT_DIR/build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"   # build.log redirect below needs the dir to exist first
echo "[sim-smoke] building..."
if ! xcodebuild "${IOS_XCODE_CONTAINER_ARGS[@]}" -scheme "$IOS_SCHEME" \
    -destination "platform=iOS Simulator,id=$UDID" -configuration Debug \
    -derivedDataPath "$BUILD_DIR" build >"$BUILD_DIR/build.log" 2>&1; then
  tail -30 "$BUILD_DIR/build.log" >&2
  fail "build"
fi

APP_PATH="$(find "$BUILD_DIR/Build/Products/Debug-iphonesimulator" -maxdepth 2 -name "${IOS_APP_PRODUCT_NAME}.app" -print -quit 2>/dev/null || true)"
if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(find "$BUILD_DIR/Build/Products/Debug-iphonesimulator" -maxdepth 2 -name '*.app' -print -quit 2>/dev/null || true)"
fi
[[ -n "$APP_PATH" ]] || fail "app-not-found"
echo "[sim-smoke] installing $APP_PATH"
xcrun simctl install "$UDID" "$APP_PATH" || fail "install"

# 3. Terminate stale, launch fresh (NO --console-pty: parent-kill would kill app).
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
LAUNCH_T0="$(date +%s)"
if ! PID_LINE="$(xcrun simctl launch "$UDID" "$BUNDLE" 2>&1)"; then
  echo "$PID_LINE" >&2; fail "launch"
fi
echo "[sim-smoke] $PID_LINE"
APP_PID="$(printf '%s\n' "$PID_LINE" | sed -nE 's/.*: ([0-9]+)$/\1/p')"

# 4. Wait, then prove liveness.
sleep "$TIMEOUT"

ALIVE="n"
if xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q "$BUNDLE"; then
  ALIVE="y"
elif [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
  ALIVE="y"
fi

# 5. Screenshot (always, even on failure — useful for postmortem).
xcrun simctl io "$UDID" screenshot "$SHOT" >/dev/null 2>&1 || true
[[ -f "$SHOT" ]] || echo "[sim-smoke] warning: screenshot missing" >&2

# 6. Scrape recent log for crash/fault/error lines.
LOG_SINCE="$((TIMEOUT + 15))s"
LOG_OUT="$SHOT_DIR/${TS}.log"
xcrun simctl spawn "$UDID" log show --last "$LOG_SINCE" \
  --predicate "subsystem == \"$BUNDLE\" OR process == \"$IOS_APP_PROCESS_NAME\"" \
  --style compact > "$LOG_OUT" 2>/dev/null || true
ERR_COUNT="$(grep -cE '\b(EXC_BAD_ACCESS|EXC_CRASH|SIGABRT|SIGSEGV|SIGBUS|Fatal error|fatal error:|uncaught exception|Terminating app due to|terminated with signal|did crash)\b' "$LOG_OUT" 2>/dev/null || echo 0)"
ERR_COUNT="${ERR_COUNT//[^0-9]/}"
: "${ERR_COUNT:=0}"

# 7. Verdict.
if [[ "$ALIVE" != "y" ]]; then
  echo "SIM SMOKE: fail bundle=$BUNDLE udid=$SHORT_UDID alive=n screenshot=$SHOT errorLines=$ERR_COUNT"
  echo "[sim-smoke] process gone after ${TIMEOUT}s. Last log lines:" >&2
  tail -20 "$LOG_OUT" >&2 || true
  exit 1
fi
if [[ "$ERR_COUNT" -gt 0 ]]; then
  echo "SIM SMOKE: fail bundle=$BUNDLE udid=$SHORT_UDID alive=y screenshot=$SHOT errorLines=$ERR_COUNT"
  echo "[sim-smoke] crash/fault lines found in log:" >&2
  grep -E '\b(EXC_BAD_ACCESS|EXC_CRASH|SIGABRT|SIGSEGV|SIGBUS|Fatal error|fatal error:|uncaught exception|Terminating app due to|terminated with signal|did crash)\b' "$LOG_OUT" >&2 || true
  exit 1
fi

LAUNCH_MS=$(( ( $(date +%s) - LAUNCH_T0 ) * 1000 ))
echo "[sim-smoke] ok (launch+wait=${LAUNCH_MS}ms, log=$LOG_OUT)"
echo "SIM SMOKE: ok bundle=$BUNDLE udid=$SHORT_UDID alive=y screenshot=$SHOT errorLines=0"
exit 0
