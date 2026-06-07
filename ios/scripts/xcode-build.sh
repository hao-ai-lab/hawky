#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/xcode-env.sh"

ios_load_xcode_defaults
ios_set_xcode_container_args

xcodebuild \
  "${IOS_XCODE_CONTAINER_ARGS[@]}" \
  -scheme "$IOS_SCHEME" \
  -destination "$IOS_BUILD_DESTINATION" \
  build \
  "$@"
