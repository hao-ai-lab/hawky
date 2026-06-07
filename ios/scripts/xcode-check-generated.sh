#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/xcode-env.sh"

ios_load_xcode_defaults

generated_abs="$(ios_abs_path "$IOS_GENERATED_PROJECT_PATH")"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

before="$tmp_dir/before"
if [[ -e "$generated_abs" ]]; then
  cp -R "$generated_abs" "$before"
else
  mkdir "$before"
fi

bash "$IOS_SCRIPT_DIR/xcode-generate.sh" "$@"

if ! diff -ru "$before" "$generated_abs"; then
  echo "Generated Xcode project changed after regeneration." >&2
  echo "Run: bun run ios:generate" >&2
  exit 1
fi
