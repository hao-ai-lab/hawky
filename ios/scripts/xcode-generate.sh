#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/xcode-env.sh"

xcodegen_args=()
if [[ -n "${IOS_XCODEGEN_SPEC:-}" ]]; then
  xcodegen_args+=(--spec "$(ios_abs_path "$IOS_XCODEGEN_SPEC")")
fi

cd "$IOS_ROOT"
# Expand the optional args array in a way that is safe under `set -u` on stock
# macOS bash 3.2, where an empty "${arr[@]}" is a fatal `unbound variable`.
xcodegen generate ${xcodegen_args[@]+"${xcodegen_args[@]}"} "$@"
