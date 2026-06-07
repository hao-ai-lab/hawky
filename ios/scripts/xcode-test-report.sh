#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/xcode-env.sh"

MODE="${1:-ui}"
if [[ $# -gt 0 ]]; then
  shift
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
report_root="$(ios_abs_path "${IOS_TEST_REPORT_DIR:-reports/ios-test-$timestamp}")"
result_bundle="$(ios_abs_path "${IOS_RESULT_BUNDLE_PATH:-$report_root/TestResults.xcresult}")"

mkdir -p "$report_root"

set +e
IOS_RESULT_BUNDLE_PATH="$result_bundle" bash "$SCRIPT_DIR/xcode-test.sh" "$MODE" "$@"
test_status=$?
set -e

if [[ -d "$result_bundle" ]]; then
  set +e
  node "$SCRIPT_DIR/xcresult-report.mjs" \
    --xcresult "$result_bundle" \
    --output "$report_root"
  report_status=$?
  set -e
  if [[ "$report_status" -eq 0 ]]; then
    echo "iOS test report: $report_root/index.html"
  else
    echo "Failed to generate iOS test report from $result_bundle" >&2
  fi
else
  echo "No xcresult bundle found at $result_bundle; report was not generated." >&2
  report_status=1
fi

if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi
exit "${report_status:-0}"
