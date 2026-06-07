#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/xcode-env.sh"

ios_load_xcode_defaults

MODE="${1:-handshake}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$MODE" in
  handshake)
    DEFAULT_ONLY_TESTING="hawkyTests/GatewayHandshakeIntegrationTests"
    ;;
  chat)
    DEFAULT_ONLY_TESTING="hawkyTests/ChatClientIntegrationTests"
    ;;
  all)
    DEFAULT_ONLY_TESTING="hawkyTests/GatewayHandshakeIntegrationTests,hawkyTests/ChatClientIntegrationTests"
    ;;
  *)
    echo "Unknown live iOS test mode: $MODE" >&2
    echo "Usage: $0 [handshake|chat|all] [xcodebuild args...]" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATEWAY_URL="${IOS_INTEGRATION_GATEWAY_URL:-${IOS_LIVE_GATEWAY_URL:-http://127.0.0.1:4242}}"
HEALTH_URL="${GATEWAY_URL%/}/health"
GATEWAY_PID=""
GATEWAY_LOG="${IOS_LIVE_GATEWAY_LOG:-$REPO_ROOT/ios/reports/live-gateway.log}"

simctl_device_from_destination() {
  if [[ -n "${IOS_SIMULATOR_ID:-}" ]]; then
    printf '%s\n' "$IOS_SIMULATOR_ID"
    return 0
  fi
  if [[ "${IOS_DESTINATION:-}" =~ (^|,)id=([^,]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return 0
  fi
  if [[ "${IOS_DESTINATION:-}" =~ (^|,)name=([^,]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return 0
  fi
  printf '%s\n' "$IOS_SIMULATOR_NAME"
}

SIMCTL_DEVICE="$(simctl_device_from_destination)"

cleanup() {
  xcrun simctl spawn "$SIMCTL_DEVICE" launchctl unsetenv IOS_INTEGRATION_GATEWAY_URL >/dev/null 2>&1 || true
  xcrun simctl spawn "$SIMCTL_DEVICE" launchctl unsetenv IOS_LIVE_TESTS_REQUIRED >/dev/null 2>&1 || true
  if [[ -n "$GATEWAY_PID" ]]; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

gateway_ready() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

if ! gateway_ready; then
  if [[ "${IOS_LIVE_START_GATEWAY:-0}" == "1" ]]; then
    mkdir -p "$(dirname "$GATEWAY_LOG")"
    echo "Starting live gateway at $GATEWAY_URL; logs: $GATEWAY_LOG"
    (
      cd "$REPO_ROOT"
      bun run gateway >"$GATEWAY_LOG" 2>&1
    ) &
    GATEWAY_PID="$!"

    for _ in {1..30}; do
      if gateway_ready; then
        break
      fi
      if ! kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
        echo "Gateway process exited before /health became ready. See $GATEWAY_LOG" >&2
        exit 1
      fi
      sleep 1
    done
  fi
fi

if ! gateway_ready; then
  echo "Live gateway is not reachable at $HEALTH_URL." >&2
  echo "Start it with 'bun run gateway', or rerun with IOS_LIVE_START_GATEWAY=1." >&2
  exit 1
fi

echo "Running live iOS integration tests against $GATEWAY_URL ($MODE)"
echo "Setting simulator env on $SIMCTL_DEVICE: IOS_INTEGRATION_GATEWAY_URL=$GATEWAY_URL"
xcrun simctl boot "$SIMCTL_DEVICE" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$SIMCTL_DEVICE" -b >/dev/null
xcrun simctl spawn "$SIMCTL_DEVICE" launchctl setenv IOS_INTEGRATION_GATEWAY_URL "$GATEWAY_URL"
xcrun simctl spawn "$SIMCTL_DEVICE" launchctl setenv IOS_LIVE_TESTS_REQUIRED "1"

IOS_INTEGRATION_GATEWAY_URL="$GATEWAY_URL" \
IOS_LIVE_TESTS_REQUIRED=1 \
IOS_TEST_ONLY="${IOS_TEST_ONLY:-$DEFAULT_ONLY_TESTING}" \
bash "$SCRIPT_DIR/xcode-test.sh" unit "$@"
