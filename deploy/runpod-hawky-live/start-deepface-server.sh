#!/usr/bin/env bash
set -euo pipefail

# Shared DeepFace sidecar (services/deepface) for the multi-tenant pod.
#
# Face recognition and the Safety Check (assess_hazard) tool POST to this service.
# A single shared instance on 127.0.0.1:8099 serves every per-user gateway; the
# provision script exports DEEPFACE_URL to point each workspace here. Without it,
# resolveDeepFaceURL() falls back to 127.0.0.1:8099 inside the empty per-user
# context and every face/hazard call fails with "Unable to connect".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/hawky}"
DEEPFACE_DIR="${DEEPFACE_DIR:-$REMOTE_APP_DIR/services/deepface}"
DEEPFACE_HOST="${DEEPFACE_HOST:-127.0.0.1}"
DEEPFACE_PORT="${DEEPFACE_PORT:-8099}"
DEEPFACE_DB="${DEEPFACE_DB:-$DEEPFACE_DIR/facedb}"
VENV_DIR="${DEEPFACE_VENV:-$DEEPFACE_DIR/.venv}"
PYTHON_BIN="${DEEPFACE_PYTHON:-python3.11}"
PID_FILE="${DEEPFACE_PID_FILE:-$DEEPFACE_DIR/deepface.pid}"
LOG_FILE="${DEEPFACE_LOG_FILE:-$DEEPFACE_DIR/deepface.log}"

if [ ! -f "$DEEPFACE_DIR/app.py" ]; then
  echo "$DEEPFACE_DIR/app.py is missing. Deploy the app first." >&2
  exit 2
fi

# Create the venv + install deps on first run (idempotent; skips if already present).
if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade pip
  "$VENV_DIR/bin/pip" install -r "$DEEPFACE_DIR/requirements.txt"
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" || true
  sleep 1
fi

mkdir -p "$DEEPFACE_DB"

export HOST="$DEEPFACE_HOST"
export PORT="$DEEPFACE_PORT"
export DEEPFACE_DB="$DEEPFACE_DB"
nohup "$VENV_DIR/bin/python" "$DEEPFACE_DIR/app.py" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# Wait for the service to answer /health (model weights download lazily on first call).
for _ in $(seq 1 30); do
  if curl -fsS -m 3 "http://$DEEPFACE_HOST:$DEEPFACE_PORT/health" >/dev/null 2>&1; then
    echo "deepface ready on $DEEPFACE_HOST:$DEEPFACE_PORT"
    exit 0
  fi
  sleep 1
done

echo "deepface did not become healthy on $DEEPFACE_HOST:$DEEPFACE_PORT (see $LOG_FILE)" >&2
exit 1
