#!/usr/bin/env bash
# Pre-commit guard for hawky. Blocks AI/bot authors and co-authors.
# Usage: scripts/check_commit.sh "<subject>" "<body-with-trailers>"
set -euo pipefail

SUBJECT="${1:-}"
BODY="${2:-}"
AI_BOT='claude|codex|anthropic|copilot|github-actions|dependabot|\[bot\]|(^|[^a-z])bot([^a-z]|$)'

fail() {
  echo "COMMIT BLOCKED: $1" >&2
  exit 1
}

TRAILERS="$(printf '%s' "$BODY" | grep -iE '^Co-authored-by:' || true)"
AUTHOR="$(git config user.name) <$(git config user.email)>"

if printf '%s\n%s' "$AUTHOR" "$TRAILERS" | grep -iE "$AI_BOT" >/dev/null 2>&1; then
  printf '%s\n%s\n' "$AUTHOR" "$TRAILERS" | grep -iE "$AI_BOT" >&2
  fail "AI/bot detected as author or co-author — humans only"
fi

echo "check_commit: PASS"
