#!/usr/bin/env bash
# =============================================================================
# Hawky Install Script
#
# Installs Bun (if needed) and Hawky via npm.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/zhisbug/hawky/main/install.sh | bash
# =============================================================================

set -euo pipefail

# Colors
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  GREEN='' RED='' BOLD='' DIM='' RESET=''
fi

info()  { echo -e "${BOLD}$1${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
fail()  { echo -e "  ${RED}✗${RESET} $1" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Step 1: Check for Bun
# -----------------------------------------------------------------------------

info "Installing Hawky..."
echo ""

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
  ok "Bun found (v${BUN_VERSION})"
else
  echo "  Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  # Source the updated PATH so bun is available in this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    ok "Bun installed (v$(bun --version))"
  else
    fail "Bun installation failed. Install manually: https://bun.sh"
  fi
fi

# -----------------------------------------------------------------------------
# Step 2: Install Hawky
# -----------------------------------------------------------------------------

echo ""
echo "  Installing hawky..."
bun install -g hawky

if command -v hawky &>/dev/null; then
  ok "hawky installed ($(hawky --version))"
else
  # bun global bin might not be in PATH
  BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
  if [ -x "$BUN_BIN/hawky" ]; then
    ok "hawky installed at $BUN_BIN/hawky"
    echo ""
    echo -e "  ${RED}Note:${RESET} $BUN_BIN is not in your PATH."
    echo "  Add it to your shell profile:"
    echo ""
    echo "    export PATH=\"$BUN_BIN:\$PATH\""
    echo ""
  else
    fail "Installation failed. Try manually: bun install -g hawky"
  fi
fi

# -----------------------------------------------------------------------------
# Step 3: Getting started
# -----------------------------------------------------------------------------

echo ""
info "Getting started:"
echo ""
echo "  1. hawky gateway    ${DIM}# Start the server (keep this terminal open)${RESET}"
echo "  2. hawky            ${DIM}# Open chat in another terminal${RESET}"
echo ""
echo -e "  ${DIM}Or: hawky --auto     # Auto-start gateway + chat in one command${RESET}"
echo -e "  ${DIM}    hawky doctor     # Check system health${RESET}"
echo ""
