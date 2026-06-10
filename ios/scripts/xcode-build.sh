#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/xcode-env.sh"

ios_load_xcode_defaults
ios_set_xcode_container_args

args=(
  "${IOS_XCODE_CONTAINER_ARGS[@]}"
  -scheme "$IOS_SCHEME"
  -destination "$IOS_BUILD_DESTINATION"
  build
)

if ios_is_simulator_destination "$IOS_BUILD_DESTINATION" && ! ios_xcode_has_build_setting CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION "$@"; then
  args+=("CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION=YES")
fi

xcodebuild "${args[@]}" "$@"
