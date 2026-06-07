#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/xcode-env.sh"

MODE="${1:-unit}"
if [[ $# -gt 0 ]]; then
  shift
fi

ios_load_xcode_defaults
ios_set_xcode_container_args

case "$MODE" in
  unit) DEFAULT_ONLY_TESTING="$IOS_UNIT_TEST_TARGET" ;;
  ui) DEFAULT_ONLY_TESTING="$IOS_UI_TEST_TARGET" ;;
  all) DEFAULT_ONLY_TESTING="" ;;
  *) DEFAULT_ONLY_TESTING="$MODE" ;;
esac

ONLY_TESTING="${IOS_TEST_ONLY:-$DEFAULT_ONLY_TESTING}"

args=(
  test
  "${IOS_XCODE_CONTAINER_ARGS[@]}"
  -scheme "$IOS_SCHEME"
  -destination "$IOS_DESTINATION"
)

if [[ -n "${IOS_RESULT_BUNDLE_PATH:-}" ]]; then
  args+=(-resultBundlePath "$(ios_abs_path "$IOS_RESULT_BUNDLE_PATH")")
fi

if [[ -n "$ONLY_TESTING" ]]; then
  IFS=',' read -r -a only_targets <<< "$ONLY_TESTING"
  for target in "${only_targets[@]}"; do
    target="${target#"${target%%[![:space:]]*}"}"
    target="${target%"${target##*[![:space:]]}"}"
    [[ -n "$target" ]] || continue
    args+=("-only-testing:$target")
  done
fi

xcodebuild "${args[@]}" "$@"
