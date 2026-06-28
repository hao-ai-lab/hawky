#!/usr/bin/env bash
# Compatibility wrapper. The canonical guard lives at repo-root scripts/check_commit.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/../../../../scripts/check_commit.sh" "$@"
