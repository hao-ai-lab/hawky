#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE_PORT="${HAWKY_WEBSITE_PORT:-4260}"
WEBSITE_ROOT="${HAWKY_WEBSITE_ROOT:-/opt/hawky/website}"
PID_FILE="${HAWKY_WEBSITE_PID_FILE:-$SCRIPT_DIR/website-server.pid}"
LOG_FILE="${HAWKY_WEBSITE_LOG_FILE:-$SCRIPT_DIR/website-server.log}"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" || true
  sleep 1
fi

export HAWKY_WEBSITE_PORT="$WEBSITE_PORT"
export HAWKY_WEBSITE_ROOT="$WEBSITE_ROOT"
nohup bun "$SCRIPT_DIR/website-server.mjs" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1
curl -fsS -H 'Host: www.hawky.live' "http://127.0.0.1:$WEBSITE_PORT/" >/dev/null
