#!/usr/bin/env bash
# Archive and upload hawky to App Store Connect/TestFlight.
#
# Defaults are intentionally conservative:
# - internal TestFlight only
# - unique timestamp build number
# - no dSYM upload for bundled third-party XCFrameworks that do not ship dSYMs
#
# Usage:
#   ios/scripts/testflight-upload.sh
#   ios/scripts/testflight-upload.sh --build-number 202605301337
#   ios/scripts/testflight-upload.sh --version 1.1 --external
#   ios/scripts/testflight-upload.sh --export-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/xcode-env.sh"

BUILD_NUMBER="$(date +%Y%m%d%H%M)"
VERSION=""
EXPORT_ONLY=false
INTERNAL_ONLY=true
ALLOW_DIRTY=false
UPLOAD_SYMBOLS=false

usage() {
  cat <<'EOF'
Usage: ios/scripts/testflight-upload.sh [OPTIONS]

Options:
  --project <path>       Xcode project path. Defaults to IOS_PROJECT_PATH or ios/project.yml.
  --workspace <path>     Xcode workspace path. Takes precedence over --project.
  --scheme <name>        Xcode scheme. Defaults to IOS_SCHEME or ios/project.yml.
  --team <id>            App Store Connect signing team. Defaults to IOS_DISTRIBUTION_TEAM,
                         IOS_DEVELOPMENT_TEAM, or the application target in ios/project.yml.
  --plist <path>         Info.plist to version. Can be passed more than once.
  --build-number <N>   CFBundleVersion to upload. Default: YYYYMMDDHHMM.
  --version <V>        Temporarily set CFBundleShortVersionString for this archive.
  --external           Do not mark the build internal-only. Required for external TestFlight later.
  --export-only        Create an App Store Connect IPA but do not upload.
  --upload-symbols     Include dSYMs in the upload.
  --allow-dirty        Run even with unrelated local changes.
  --help               Print this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) IOS_PROJECT_PATH="$2"; shift 2 ;;
    --workspace) IOS_WORKSPACE_PATH="$2"; shift 2 ;;
    --scheme) IOS_SCHEME="$2"; shift 2 ;;
    --team) IOS_DISTRIBUTION_TEAM="$2"; shift 2 ;;
    --plist) IOS_VERSION_PLISTS="${IOS_VERSION_PLISTS:+${IOS_VERSION_PLISTS},}$2"; shift 2 ;;
    --build-number) BUILD_NUMBER="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --external) INTERNAL_ONLY=false; shift ;;
    --export-only) EXPORT_ONLY=true; shift ;;
    --upload-symbols) UPLOAD_SYMBOLS=true; shift ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 2
  }
}

bool_plist_value() {
  if [[ "$1" == "true" ]]; then
    echo "<true/>"
  else
    echo "<false/>"
  fi
}

require xcodebuild
require /usr/libexec/PlistBuddy

ios_load_xcode_defaults
ios_set_xcode_container_args
IOS_DISTRIBUTION_TEAM="${IOS_DISTRIBUTION_TEAM:-${IOS_DEVELOPMENT_TEAM:-}}"

cd "${IOS_ROOT}"

if ! $ALLOW_DIRTY && [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has uncommitted changes. Commit/stash them or pass --allow-dirty." >&2
  git status --short >&2
  exit 1
fi

VERSION_PLISTS=()
if [[ -n "${IOS_VERSION_PLISTS:-}" ]]; then
  IFS=',' read -r -a requested_plists <<< "${IOS_VERSION_PLISTS}"
  for plist in "${requested_plists[@]}"; do
    [[ -n "${plist}" ]] || continue
    VERSION_PLISTS+=("$(ios_abs_path "${plist}")")
  done
else
  while IFS= read -r plist; do
    [[ -n "${plist}" ]] || continue
    VERSION_PLISTS+=("$(ios_abs_path "${plist}")")
  done < <(ios_info_plists_from_yaml 2>/dev/null || true)
fi

if [[ ${#VERSION_PLISTS[@]} -eq 0 ]]; then
  VERSION_PLISTS+=("$(ios_abs_path "${IOS_APP_PLIST}")")
fi

for plist in "${VERSION_PLISTS[@]}"; do
  [[ -f "${plist}" ]] || {
    echo "Missing plist: ${plist}" >&2
    exit 1
  }
done

APP_PLIST="${VERSION_PLISTS[0]}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_PATH="/tmp/${IOS_SCHEME}-TestFlight-${BUILD_NUMBER}-${TIMESTAMP}.xcarchive"
EXPORT_PATH="/tmp/${IOS_SCHEME}-TestFlight-${BUILD_NUMBER}-${TIMESTAMP}"
EXPORT_OPTIONS="/tmp/${IOS_SCHEME}-TestFlight-${BUILD_NUMBER}-${TIMESTAMP}-ExportOptions.plist"
PLIST_BACKUPS=()
plist_index=0

for plist in "${VERSION_PLISTS[@]}"; do
  backup="/tmp/${IOS_SCHEME}-plist-${plist_index}-$(basename "${plist}")-${TIMESTAMP}.backup"
  cp "${plist}" "${backup}"
  PLIST_BACKUPS+=("${plist}:${backup}")
  plist_index=$((plist_index + 1))
done

cleanup() {
  local pair plist backup
  for pair in "${PLIST_BACKUPS[@]}"; do
    plist="${pair%%:*}"
    backup="${pair#*:}"
    cp "${backup}" "${plist}" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "==> Preparing TestFlight archive"
echo "    version: ${VERSION:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_PLIST}")}"
echo "    build:   ${BUILD_NUMBER}"
echo "    scheme:  ${IOS_SCHEME}"
echo "    plists:  ${#VERSION_PLISTS[@]}"

for plist in "${VERSION_PLISTS[@]}"; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${BUILD_NUMBER}" "${plist}"
  if [[ -n "${VERSION}" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "${plist}"
  fi
done

DESTINATION="upload"
if $EXPORT_ONLY; then
  DESTINATION="export"
fi

TEAM_OPTIONS=""
if [[ -n "${IOS_DISTRIBUTION_TEAM}" ]]; then
  TEAM_OPTIONS=$'\t<key>teamID</key>\n'
  TEAM_OPTIONS+=$'\t<string>'"${IOS_DISTRIBUTION_TEAM}"$'</string>\n'
fi

cat > "${EXPORT_OPTIONS}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>${DESTINATION}</string>
	<key>signingStyle</key>
	<string>automatic</string>
${TEAM_OPTIONS}	<key>stripSwiftSymbols</key>
	<true/>
	<key>uploadSymbols</key>
	$(bool_plist_value "${UPLOAD_SYMBOLS}")
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>testFlightInternalTestingOnly</key>
	$(bool_plist_value "${INTERNAL_ONLY}")
</dict>
</plist>
EOF

ARCHIVE_FLAGS=(CODE_SIGN_STYLE=Automatic)
if [[ -n "${IOS_DISTRIBUTION_TEAM}" ]]; then
  ARCHIVE_FLAGS+=("DEVELOPMENT_TEAM=${IOS_DISTRIBUTION_TEAM}")
fi

echo "==> Archiving ${IOS_SCHEME}"
xcodebuild \
  "${IOS_XCODE_CONTAINER_ARGS[@]}" \
  -scheme "${IOS_SCHEME}" \
  -configuration "${IOS_RELEASE_CONFIGURATION}" \
  -destination "generic/platform=iOS" \
  -archivePath "${ARCHIVE_PATH}" \
  archive \
  "${ARCHIVE_FLAGS[@]}"

if $EXPORT_ONLY; then
  echo "==> Exporting App Store Connect IPA"
else
  echo "==> Uploading to App Store Connect/TestFlight"
fi

xcodebuild \
  -exportArchive \
  -archivePath "${ARCHIVE_PATH}" \
  -exportPath "${EXPORT_PATH}" \
  -exportOptionsPlist "${EXPORT_OPTIONS}" \
  -allowProvisioningUpdates

echo "==> Done"
echo "    archive: ${ARCHIVE_PATH}"
echo "    export:  ${EXPORT_PATH}"
