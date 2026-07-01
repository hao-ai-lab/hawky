#!/usr/bin/env bash
# Conventional-commit changelog for a hawky release range.
# Humans only (AI/bot trailers stripped).
# Usage: changelog.sh <from-ref> <to-ref>
set -euo pipefail
FROM="${1:?from ref}"; TO="${2:?to ref}"
AI_BOT='claude|codex|anthropic|copilot|github-actions|dependabot|\[bot\]|(^|[^a-z])bot([^a-z]|$)'

emit() { # $1=type label, $2=conventional prefix
  local out
  out="$(git log "$FROM..$TO" --pretty='%s' | grep -E "^$2(\(.+\))?:" || true)"
  if [ -n "$out" ]; then
    echo "### $1"
    printf '%s\n' "$out" | sed -E 's/^/- /'
    echo
  fi
}

echo "## $TO"
echo
emit "Features"      "feat"
emit "Fixes"         "fix"
emit "Docs"          "docs"
emit "Maintenance"   "chore"
emit "Refactors"     "refactor"
emit "Tests"         "test"

echo "### Contributors"
contributors="$(
  {
    git log "$FROM..$TO" --pretty='%an <%ae>'
    git log "$FROM..$TO" --pretty=%B | sed -nE 's/^Co-authored-by:[[:space:]]*//Ip'
  } \
  | sort -u \
  | grep -ivE "$AI_BOT" \
  || true
)"

if [ -n "$contributors" ]; then
  printf '%s\n' "$contributors" | sed -E 's/^/- /'
else
  echo "- None"
fi
