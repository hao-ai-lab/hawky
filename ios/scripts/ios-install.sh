#!/usr/bin/env bash
# ios-install.sh — check out any hawky ref, build, install on paired iPhone,
# launch, capture logs, return evidence.
#
# Usage:
#   scripts/ios-install.sh [--ref <branch|tag|sha|pr:<n>>] [--device <udid|name>]
#                          [--project <path>|--workspace <path>] [--scheme <name>]
#                          [--bundle <id>] [--team <id>] [--simulator <name>]
#                          [--log-seconds <N>] [--sim] [--no-install] [--help]
#
# Hard rules (enforced in code):
#   - Never git reset --hard, never force-push, never --no-verify.
#   - Never touch worktrees under .claude/worktrees/.
#   - Stash uncommitted changes before checkout; restore on EXIT.

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/xcode-env.sh"

REPO_ROOT="${IOS_ROOT}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BUILD_LOG="/tmp/ios-install-${TIMESTAMP}.log"
DEVICES_JSON="/tmp/ios-install-devices-${TIMESTAMP}.json"

# ── Defaults ──────────────────────────────────────────────────────────────────
OPT_REF=""
OPT_DEVICE=""
OPT_LOG_SECONDS=15
OPT_SIM=false
OPT_NO_INSTALL=false

# ── State for cleanup ─────────────────────────────────────────────────────────
ORIGINAL_BRANCH=""
STASH_REF=""
CHECKED_OUT_REF=false
LOG_PID=""

# ── Helpers ───────────────────────────────────────────────────────────────────
die()  { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARNING: $*" >&2; }
info() { echo "==> $*"; }

usage() {
  cat <<'EOF'
Usage: scripts/ios-install.sh [OPTIONS]

Options:
  --ref <branch|tag|sha|pr:<n>>
        What to check out. pr:<n> fetches PR #n head via `gh pr checkout`.
        Default: current branch (no checkout performed).
  --device <udid|name>
        Target device UDID or name substring. If omitted, auto-picks first
        connected iPhone via xcrun devicectl.
  --project <path>
        Xcode project path. Defaults to IOS_PROJECT_PATH or ios/project.yml.
  --workspace <path>
        Xcode workspace path. Takes precedence over --project.
  --scheme <name>
        Xcode scheme. Defaults to IOS_SCHEME or ios/project.yml.
  --bundle <id>
        Bundle id to launch. Defaults to IOS_BUNDLE_ID or the application
        target's PRODUCT_BUNDLE_IDENTIFIER in ios/project.yml.
  --team <id>
        Development team for device builds. Defaults to IOS_DEVELOPMENT_TEAM
        or the application target's DEVELOPMENT_TEAM in ios/project.yml.
  --simulator <name>
        Simulator name for --sim. Defaults to IOS_SIMULATOR_NAME.
  --log-seconds <N>
        How many seconds to stream device logs after launch. Default: 15.
  --sim
        Build for iOS Simulator instead of real hardware.
  --no-install
        Build only; skip install, launch, and log capture.
  --help
        Print this message and exit.

Examples:
  scripts/ios-install.sh
  scripts/ios-install.sh --ref main --log-seconds 30
  scripts/ios-install.sh --ref pr:42
  scripts/ios-install.sh --ref abc1234 --no-install
EOF
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)           OPT_REF="$2";          shift 2 ;;
    --device)        OPT_DEVICE="$2";       shift 2 ;;
    --project)       IOS_PROJECT_PATH="$2"; shift 2 ;;
    --workspace)     IOS_WORKSPACE_PATH="$2"; shift 2 ;;
    --scheme)        IOS_SCHEME="$2";       shift 2 ;;
    --bundle)        IOS_BUNDLE_ID="$2";    shift 2 ;;
    --team)          IOS_DEVELOPMENT_TEAM="$2"; shift 2 ;;
    --simulator|--simulator-name) IOS_SIMULATOR_NAME="$2"; shift 2 ;;
    --log-seconds)   OPT_LOG_SECONDS="$2";  shift 2 ;;
    --sim)           OPT_SIM=true;          shift   ;;
    --no-install)    OPT_NO_INSTALL=true;   shift   ;;
    --help|-h)       usage; exit 0               ;;
    *) die "Unknown argument: $1. Run with --help for usage." ;;
  esac
done

# ── Guard: refuse .claude/worktrees ──────────────────────────────────────────
if [[ "${REPO_ROOT}" == *"/.claude/worktrees/"* ]]; then
  die "Refusing to run inside a .claude/worktrees/ path. Run from the main working tree."
fi

# ── Save current branch and stash dirty state ─────────────────────────────────
cd "${REPO_ROOT}"

ORIGINAL_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
  info "Uncommitted changes detected — stashing with message 'ios-install-pre-checkout-${TIMESTAMP}'"
  if ! git stash push --include-untracked -m "ios-install-pre-checkout-${TIMESTAMP}"; then
    die "git stash failed. Aborting to protect uncommitted work."
  fi
  STASH_REF="stash@{0}"
  info "Stash created: ${STASH_REF}"
fi

# ── EXIT trap: restore branch + stash ────────────────────────────────────────
cleanup() {
  local exit_code=$?
  # Kill log-stream if still running
  if [[ -n "${LOG_PID}" ]]; then
    kill "${LOG_PID}" 2>/dev/null || true
  fi
  # Restore original branch if we changed it
  if $CHECKED_OUT_REF && [[ -n "${ORIGINAL_BRANCH}" ]]; then
    info "Restoring branch: ${ORIGINAL_BRANCH}"
    git checkout "${ORIGINAL_BRANCH}" --quiet 2>/dev/null || \
      warn "Could not restore branch '${ORIGINAL_BRANCH}' — check manually."
  fi
  # Pop stash
  if [[ -n "${STASH_REF}" ]]; then
    info "Restoring stash: ${STASH_REF}"
    git stash pop --quiet 2>/dev/null || \
      warn "Stash pop failed — run 'git stash pop' manually to recover uncommitted work."
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

# ── Checkout ref ─────────────────────────────────────────────────────────────
if [[ -n "${OPT_REF}" ]]; then
  if [[ "${OPT_REF}" == pr:* ]]; then
    PR_NUM="${OPT_REF#pr:}"
    info "Fetching PR #${PR_NUM} via gh pr checkout"
    command -v gh >/dev/null 2>&1 || die "'gh' CLI not found. Install via: brew install gh"
    gh pr checkout "${PR_NUM}"
  else
    info "Checking out ref: ${OPT_REF}"
    git checkout "${OPT_REF}"
  fi
  CHECKED_OUT_REF=true
fi

ios_load_xcode_defaults
ios_set_xcode_container_args
BUNDLE_ID="$(ios_bundle_id 2>/dev/null || true)"

COMMIT_SHA="$(git rev-parse --short HEAD)"
CURRENT_REF="${OPT_REF:-${ORIGINAL_BRANCH}}"
info "Building ref=${CURRENT_REF} commit=${COMMIT_SHA} scheme=${IOS_SCHEME}"

if ! $OPT_NO_INSTALL && [[ -z "${BUNDLE_ID}" ]]; then
  die "Unable to derive bundle id. Set IOS_BUNDLE_ID or pass --bundle."
fi

# ── Resolve destination ───────────────────────────────────────────────────────
# Device resolution is deferred until after the build when not installing, but
# xcodebuild needs a destination for even a pure build. Detect early but only
# die on missing device when we're actually going to install.
DEVICE_UDID=""

if $OPT_SIM; then
  DESTINATION="${IOS_DESTINATION}"
  XCODE_EXTRA_FLAGS=(
    "CODE_SIGNING_ALLOWED=NO"
  )
else
  if [[ -n "${OPT_DEVICE}" ]]; then
    DEVICE_UDID="${OPT_DEVICE}"
    info "Using specified device: ${DEVICE_UDID}"
  else
    info "Auto-detecting first reachable iPhone via devicectl..."
    if xcrun devicectl list devices --json-output "${DEVICES_JSON}" 2>/dev/null; then
      # Prefer tunnelState=connected (USB or active wireless tunnel), but also
      # accept pairingState=paired devices on Wi-Fi — devicectl brings up the
      # tunnel on demand when we issue install/launch. Without this relaxation
      # we lock out wireless debugging even when the phone is on the same LAN.
      DEVICE_UDID="$(python3 -c "
import json, sys
with open('${DEVICES_JSON}') as f:
    data = json.load(f)
devices = data.get('result', {}).get('devices', [])
# Pass 1: actively-tunneled device (fastest install path).
for d in devices:
    udid = d.get('hardwareProperties', {}).get('udid', '')
    conn = d.get('connectionProperties', {})
    if conn.get('tunnelState', '') == 'connected' and udid:
        print(udid); sys.exit(0)
# Pass 2: paired device on local network — devicectl will dial the tunnel.
for d in devices:
    udid = d.get('hardwareProperties', {}).get('udid', '')
    conn = d.get('connectionProperties', {})
    pairing = conn.get('pairingState', '')
    transport = conn.get('transportType', '')
    if pairing == 'paired' and transport == 'localNetwork' and udid:
        print(udid); sys.exit(0)
# Pass 3: any paired device at all — last-resort, may still work.
for d in devices:
    udid = d.get('hardwareProperties', {}).get('udid', '')
    conn = d.get('connectionProperties', {})
    if conn.get('pairingState', '') == 'paired' and udid:
        print(udid); sys.exit(0)
" 2>/dev/null || true)"
    fi
    if [[ -n "${DEVICE_UDID}" ]]; then
      info "Auto-selected device UDID: ${DEVICE_UDID}"
    else
      if $OPT_NO_INSTALL; then
        warn "No paired iPhone found, but --no-install was set. Building for generic device."
        DEVICE_UDID="placeholder-no-install"
      else
        die "No paired iPhone found. Wake the phone, ensure it is on the same Wi-Fi as this Mac (or plug it in), and tap Trust on the iPhone when prompted."
      fi
    fi
  fi

  if [[ "${DEVICE_UDID}" == "placeholder-no-install" ]]; then
    DESTINATION="generic/platform=iOS"
  else
    DESTINATION="platform=iOS,id=${DEVICE_UDID}"
  fi
  XCODE_EXTRA_FLAGS=("-allowProvisioningUpdates")
  if [[ -n "${IOS_DEVELOPMENT_TEAM}" ]]; then
    XCODE_EXTRA_FLAGS=("DEVELOPMENT_TEAM=${IOS_DEVELOPMENT_TEAM}" "${XCODE_EXTRA_FLAGS[@]}")
  fi
fi

# ── Build ─────────────────────────────────────────────────────────────────────
info "Starting build → log: ${BUILD_LOG}"
BUILD_START="$(date +%s)"

# Optionally pipe through xcbeautify
if command -v xcbeautify >/dev/null 2>&1; then
  PIPE_CMD="xcbeautify"
else
  PIPE_CMD="cat"
fi

set +e
xcodebuild \
  "${IOS_XCODE_CONTAINER_ARGS[@]}" \
  -scheme "${IOS_SCHEME}" \
  -configuration "${IOS_CONFIGURATION}" \
  -destination "${DESTINATION}" \
  "${XCODE_EXTRA_FLAGS[@]}" \
  build 2>&1 | tee "${BUILD_LOG}" | ${PIPE_CMD}
XCODE_EXIT="${PIPESTATUS[0]}"
set -e

BUILD_END="$(date +%s)"
BUILD_DURATION=$(( BUILD_END - BUILD_START ))

# Count warnings
WARNING_COUNT="$(grep -c ': warning:' "${BUILD_LOG}" 2>/dev/null || true)"

if [[ "${XCODE_EXIT}" -ne 0 ]]; then
  echo ""
  echo "BUILD FAILED (exit ${XCODE_EXIT}). Last 30 lines of log:" >&2
  tail -30 "${BUILD_LOG}" >&2
  echo "" >&2
  echo "Full log: ${BUILD_LOG}" >&2
  exit 1
fi

info "Build succeeded in ${BUILD_DURATION}s (${WARNING_COUNT} warnings)"

# ── Early exit if --no-install ────────────────────────────────────────────────
if $OPT_NO_INSTALL; then
  echo ""
  echo "───── SUMMARY ─────────────────────────────────────────────────────────"
  echo "  Ref:            ${CURRENT_REF}"
  echo "  Commit:         ${COMMIT_SHA}"
  echo "  Device:         (skipped — --no-install)"
  echo "  Build duration: ${BUILD_DURATION}s"
  echo "  Warnings:       ${WARNING_COUNT}"
  echo "  Install:        skipped (--no-install)"
  echo "  Build log:      ${BUILD_LOG}"
  echo "───────────────────────────────────────────────────────────────────────"
  exit 0
fi

# ── Find the built .app ───────────────────────────────────────────────────────
BUILT_PRODUCTS_DIR="$(xcodebuild \
  "${IOS_XCODE_CONTAINER_ARGS[@]}" \
  -scheme "${IOS_SCHEME}" \
  -configuration "${IOS_CONFIGURATION}" \
  -destination "${DESTINATION}" \
  "${XCODE_EXTRA_FLAGS[@]}" \
  -showBuildSettings 2>/dev/null \
  | grep ' BUILT_PRODUCTS_DIR ' | head -1 | awk '{print $3}')"
APP_PATH="${BUILT_PRODUCTS_DIR}/${IOS_APP_PRODUCT_NAME}.app"
if [[ ! -d "${APP_PATH}" ]]; then
  APP_PATH="$(find "${BUILT_PRODUCTS_DIR}" -maxdepth 2 -name '*.app' -print -quit 2>/dev/null || true)"
fi

[[ -d "${APP_PATH}" ]] || die "Could not locate built .app at: ${APP_PATH}"
info "Built app: ${APP_PATH}"

# ── Install ───────────────────────────────────────────────────────────────────
INSTALL_STATUS="failed"
LAUNCH_STATUS="failed"
APP_LOG="/tmp/ios-install-applog-${TIMESTAMP}.log"

if $OPT_SIM; then
  SIM_UDID="$(printf '%s\n' "${IOS_DESTINATION}" | sed -nE 's/.*id=([^,]+).*/\1/p')"
  if [[ -z "${SIM_UDID}" ]]; then
    SIM_UDID="$(xcrun simctl list devices --json \
      | SIMULATOR_QUERY_NAME="${IOS_SIMULATOR_NAME}" python3 -c '
import json, os, sys
target = os.environ["SIMULATOR_QUERY_NAME"]
d = json.load(sys.stdin)
for _rt, devs in d["devices"].items():
    for dev in devs:
        if target in dev["name"] and dev["state"] == "Booted":
            print(dev["udid"])
            sys.exit(0)
' 2>/dev/null || true)"
  fi
  if [[ -z "${SIM_UDID}" ]]; then
    warn "No booted ${IOS_SIMULATOR_NAME} Simulator found. Booting..."
    SIM_UDID="$(xcrun simctl list devices --json \
      | SIMULATOR_QUERY_NAME="${IOS_SIMULATOR_NAME}" python3 -c '
import json, os, sys
target = os.environ["SIMULATOR_QUERY_NAME"]
d = json.load(sys.stdin)
for _rt, devs in d["devices"].items():
    for dev in devs:
        if target in dev["name"]:
            print(dev["udid"])
            sys.exit(0)
' 2>/dev/null || true)"
    [[ -n "${SIM_UDID}" ]] || die "No ${IOS_SIMULATOR_NAME} Simulator found. Set IOS_SIMULATOR_NAME or pass --simulator."
    xcrun simctl boot "${SIM_UDID}"
  fi
  xcrun simctl install "${SIM_UDID}" "${APP_PATH}" && INSTALL_STATUS="ok" || true
  xcrun simctl launch "${SIM_UDID}" "${BUNDLE_ID}" && LAUNCH_STATUS="ok" || true
  LOG_STREAM_CMD=(xcrun simctl spawn "${SIM_UDID}" log stream \
    --predicate "subsystem contains '${BUNDLE_ID}'")
else
  info "Installing on device ${DEVICE_UDID}..."
  if xcrun devicectl device install app \
    --device "${DEVICE_UDID}" \
    "${APP_PATH}"; then
    INSTALL_STATUS="ok"
  else
    warn "Install failed. Is the phone unlocked and trusting this Mac?"
  fi

  if [[ "${INSTALL_STATUS}" == "ok" ]]; then
    info "Launching ${BUNDLE_ID}..."
    if xcrun devicectl device process launch \
      --device "${DEVICE_UDID}" \
      "${BUNDLE_ID}"; then
      LAUNCH_STATUS="ok"
    else
      warn "Launch failed."
    fi
  fi
  LOG_STREAM_CMD=(xcrun devicectl device process view --device "${DEVICE_UDID}")
fi

# ── Stream logs ───────────────────────────────────────────────────────────────
if [[ "${LAUNCH_STATUS}" == "ok" ]]; then
  info "Streaming device logs for ${OPT_LOG_SECONDS}s → ${APP_LOG}"
  "${LOG_STREAM_CMD[@]}" > "${APP_LOG}" 2>&1 &
  LOG_PID=$!
  sleep "${OPT_LOG_SECONDS}"
  kill "${LOG_PID}" 2>/dev/null || true
  LOG_PID=""
  LOG_LINE_COUNT="$(wc -l < "${APP_LOG}" | tr -d ' ')"
  info "Log capture complete (${LOG_LINE_COUNT} lines)"
else
  APP_LOG="(skipped — launch did not succeed)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "───── SUMMARY ─────────────────────────────────────────────────────────"
echo "  Ref:            ${CURRENT_REF}"
echo "  Commit:         ${COMMIT_SHA}"
if $OPT_SIM; then
  echo "  Device:         Simulator (${SIM_UDID:-unknown})"
else
  echo "  Device:         ${DEVICE_UDID}"
fi
echo "  Build duration: ${BUILD_DURATION}s"
echo "  Warnings:       ${WARNING_COUNT}"
echo "  Install:        ${INSTALL_STATUS}"
echo "  Launch:         ${LAUNCH_STATUS}"
echo "  Build log:      ${BUILD_LOG}"
echo "  App log:        ${APP_LOG}"
echo "───────────────────────────────────────────────────────────────────────"
