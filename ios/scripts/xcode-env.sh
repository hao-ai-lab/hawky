#!/usr/bin/env bash

IOS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$IOS_SCRIPT_DIR/.." && pwd)"

ios_abs_path() {
  local path="$1"
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$IOS_ROOT" "$path" ;;
  esac
}

ios_project_name_from_yaml() {
  local yaml_path="$IOS_ROOT/project.yml"
  [[ -f "$yaml_path" ]] || return 1

  ruby -ryaml -e '
    doc = YAML.load_file(ARGV[0])
    name = doc && doc["name"]
    exit 1 if name.nil? || name.to_s.empty?
    puts name
  ' "$yaml_path" 2>/dev/null && return 0

  awk -F': *' '/^name:/ { print $2; exit }' "$yaml_path" 2>/dev/null
}

ios_first_scheme_from_yaml() {
  local yaml_path="$IOS_ROOT/project.yml"
  [[ -f "$yaml_path" ]] || return 1

  ruby -ryaml -e '
    doc = YAML.load_file(ARGV[0])
    schemes = doc && doc["schemes"]
    exit 1 unless schemes.is_a?(Hash) && !schemes.empty?
    puts schemes.keys.first
  ' "$yaml_path" 2>/dev/null
}

ios_app_target_name_from_yaml() {
  local yaml_path="$IOS_ROOT/project.yml"
  [[ -f "$yaml_path" ]] || return 1

  ruby -ryaml -e '
    doc = YAML.load_file(ARGV[0])
    targets = doc.fetch("targets", {})
    app = targets.find do |_name, target|
      target.is_a?(Hash) && target["type"] == "application"
    end
    exit 1 if app.nil? || app[0].to_s.empty?
    puts app[0]
  ' "$yaml_path" 2>/dev/null
}

ios_application_target_setting_from_yaml() {
  local setting_key="$1"
  local yaml_path="$IOS_ROOT/project.yml"
  [[ -f "$yaml_path" ]] || return 1

  ruby -ryaml -e '
    doc = YAML.load_file(ARGV[0])
    setting_key = ARGV[1]
    targets = doc.fetch("targets", {})
    app = targets.find do |_name, target|
      target.is_a?(Hash) && target["type"] == "application"
    end
    value = app && app[1].dig("settings", "base", setting_key)
    exit 1 if value.nil? || value.to_s.empty?
    puts value
  ' "$yaml_path" "$setting_key" 2>/dev/null && return 0

  awk -v key="$setting_key" -F': *' '$1 ~ key { print $2; exit }' "$yaml_path" 2>/dev/null
}

ios_app_info_plist_from_yaml() {
  local yaml_path="$IOS_ROOT/project.yml"
  [[ -f "$yaml_path" ]] || return 1

  ruby -ryaml -e '
    doc = YAML.load_file(ARGV[0])
    targets = doc.fetch("targets", {})
    app = targets.find do |_name, target|
      target.is_a?(Hash) && target["type"] == "application"
    end
    path = app && app[1].dig("info", "path")
    exit 1 if path.nil? || path.to_s.empty?
    puts path
  ' "$yaml_path" 2>/dev/null
}

ios_info_plists_from_yaml() {
  local yaml_path="$IOS_ROOT/project.yml"
  [[ -f "$yaml_path" ]] || return 1

  ruby -ryaml -e '
    doc = YAML.load_file(ARGV[0])
    targets = doc.fetch("targets", {})
    targets.each_value do |target|
      next unless target.is_a?(Hash)
      path = target.dig("info", "path")
      puts path if path && !path.to_s.empty?
    end
  ' "$yaml_path" 2>/dev/null
}

ios_default_project_name() {
  local project_name
  project_name="$(ios_project_name_from_yaml 2>/dev/null || true)"
  if [[ -n "$project_name" ]]; then
    printf '%s\n' "$project_name"
    return 0
  fi

  local project
  project="$(find "$IOS_ROOT" -maxdepth 1 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
  if [[ -n "$project" ]]; then
    basename "$project" .xcodeproj
    return 0
  fi

  return 1
}

ios_default_scheme() {
  local scheme
  scheme="$(ios_first_scheme_from_yaml 2>/dev/null || true)"
  if [[ -n "$scheme" ]]; then
    printf '%s\n' "$scheme"
    return 0
  fi

  scheme="$(ios_project_name_from_yaml 2>/dev/null || true)"
  if [[ -n "$scheme" ]]; then
    printf '%s\n' "$scheme"
    return 0
  fi

  local project
  project="$(find "$IOS_ROOT" -maxdepth 1 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
  if [[ -n "$project" ]]; then
    basename "$project" .xcodeproj
    return 0
  fi

  return 1
}

ios_bundle_id_from_yaml() {
  ios_application_target_setting_from_yaml PRODUCT_BUNDLE_IDENTIFIER
}

ios_development_team_from_yaml() {
  ios_application_target_setting_from_yaml DEVELOPMENT_TEAM
}

ios_load_xcode_defaults() {
  local project_name
  local app_target_name
  local app_plist

  project_name="$(ios_default_project_name 2>/dev/null || true)"
  app_target_name="$(ios_app_target_name_from_yaml 2>/dev/null || true)"

  if [[ -z "${IOS_SCHEME:-}" ]]; then
    IOS_SCHEME="$(ios_default_scheme)" || {
      echo "Unable to infer IOS_SCHEME. Set IOS_SCHEME explicitly." >&2
      return 2
    }
  fi

  IOS_PROJECT_PATH="${IOS_PROJECT_PATH:-${XCODE_PROJECT_PATH:-${project_name:-$IOS_SCHEME}.xcodeproj}}"
  IOS_GENERATED_PROJECT_PATH="${IOS_GENERATED_PROJECT_PATH:-$IOS_PROJECT_PATH}"
  IOS_CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
  IOS_RELEASE_CONFIGURATION="${IOS_RELEASE_CONFIGURATION:-Release}"
  IOS_SIMULATOR_NAME="${IOS_SIMULATOR_NAME:-iPhone 17 Pro}"
  IOS_BUILD_DESTINATION="${IOS_BUILD_DESTINATION:-generic/platform=iOS Simulator}"
  IOS_DESTINATION="${IOS_DESTINATION:-platform=iOS Simulator,name=${IOS_SIMULATOR_NAME}}"
  IOS_UNIT_TEST_TARGET="${IOS_UNIT_TEST_TARGET:-${IOS_SCHEME}Tests}"
  IOS_UI_TEST_TARGET="${IOS_UI_TEST_TARGET:-${IOS_SCHEME}UITests}"
  IOS_APP_TARGET_NAME="${IOS_APP_TARGET_NAME:-${app_target_name:-$IOS_SCHEME}}"
  IOS_APP_PRODUCT_NAME="${IOS_APP_PRODUCT_NAME:-$IOS_APP_TARGET_NAME}"
  IOS_APP_PROCESS_NAME="${IOS_APP_PROCESS_NAME:-$IOS_APP_PRODUCT_NAME}"
  IOS_DEVELOPMENT_TEAM="${IOS_DEVELOPMENT_TEAM:-$(ios_development_team_from_yaml 2>/dev/null || true)}"

  app_plist="$(ios_app_info_plist_from_yaml 2>/dev/null || true)"
  IOS_APP_PLIST="${IOS_APP_PLIST:-${app_plist:-${IOS_APP_TARGET_NAME}/Info.plist}}"
}

ios_set_xcode_container_args() {
  if [[ -n "${IOS_WORKSPACE_PATH:-}" ]]; then
    IOS_XCODE_CONTAINER_ARGS=(-workspace "$(ios_abs_path "$IOS_WORKSPACE_PATH")")
  else
    IOS_XCODE_CONTAINER_ARGS=(-project "$(ios_abs_path "$IOS_PROJECT_PATH")")
  fi
}

ios_bundle_id() {
  if [[ -n "${IOS_BUNDLE_ID:-}" ]]; then
    printf '%s\n' "$IOS_BUNDLE_ID"
    return 0
  fi

  ios_bundle_id_from_yaml
}
