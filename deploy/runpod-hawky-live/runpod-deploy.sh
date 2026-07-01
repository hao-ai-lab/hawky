#!/usr/bin/env bash
set -euo pipefail

POD_HOST="${POD_HOST:?Set POD_HOST to the RunPod SSH host}"
POD_SSH_PORT="${POD_SSH_PORT:-17432}"
REMOTE_DIR="${REMOTE_DIR:-/opt/hawky}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${HAWKY_REPO_DIR:-}" ]; then
  REPO_DIR="$(cd "$HAWKY_REPO_DIR" && pwd)"
else
  REPO_DIR=""
  for candidate in "$SCRIPT_DIR/../../../hawky-main" "$SCRIPT_DIR/../../../hawky"; do
    if [ -f "$candidate/package.json" ] && [ -f "$candidate/src/index.ts" ]; then
      REPO_DIR="$(cd "$candidate" && pwd)"
      break
    fi
  done
fi

if [ -z "$REPO_DIR" ]; then
  echo "Set HAWKY_REPO_DIR to a local checkout of https://github.com/hao-ai-lab/hawky." >&2
  exit 2
fi

ssh_cmd=(ssh -p "$POD_SSH_PORT" -o StrictHostKeyChecking=accept-new "root@$POD_HOST")
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'web/node_modules' \
  --exclude 'web-ios/node_modules' \
  --exclude 'ios/build' \
  --exclude '.DS_Store' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'deploy/runpod-hawky-live/users.json' \
  --exclude 'deploy/runpod-hawky-live/*.pid' \
  --exclude 'deploy/runpod-hawky-live/*.log' \
  --exclude 'cloudflare/' \
  --exclude 'gateway.log' \
  --exclude 'gateway.pid' \
  -e "ssh -p $POD_SSH_PORT -o StrictHostKeyChecking=accept-new" \
  "$REPO_DIR/" "root@$POD_HOST:$REMOTE_DIR/"

"${ssh_cmd[@]}" "mkdir -p '$REMOTE_DIR/deploy/runpod-hawky-live'"
rsync -az \
  --exclude 'users.json' \
  --exclude '*.pid' \
  --exclude '*.log' \
  -e "ssh -p $POD_SSH_PORT -o StrictHostKeyChecking=accept-new" \
  "$SCRIPT_DIR/" "root@$POD_HOST:$REMOTE_DIR/deploy/runpod-hawky-live/"

"${ssh_cmd[@]}" "set -euo pipefail
export PATH=\"\$HOME/.bun/bin:\$PATH\"
cd '$REMOTE_DIR'
if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash >/dev/null; fi
install -m 0755 \"\$(command -v bun)\" /usr/local/bin/bun
bun install --frozen-lockfile
cd web-ios
bun install --frozen-lockfile
bun run build
rm -rf '$REMOTE_DIR/web/dist'
mkdir -p '$REMOTE_DIR/web'
cp -a '$REMOTE_DIR/web-ios/dist' '$REMOTE_DIR/web/dist'
cd '$REMOTE_DIR'
bun run build
touch '$REMOTE_DIR/.env'
chmod 0600 '$REMOTE_DIR/.env'
if [ -f '$REMOTE_DIR/gateway.pid' ] && kill -0 \"\$(cat '$REMOTE_DIR/gateway.pid')\" 2>/dev/null; then
  kill \"\$(cat '$REMOTE_DIR/gateway.pid')\" || true
  sleep 1
fi
if [ -f '$REMOTE_DIR/deploy/runpod-hawky-live/workspace-router.pid' ] && kill -0 \"\$(cat '$REMOTE_DIR/deploy/runpod-hawky-live/workspace-router.pid')\" 2>/dev/null; then
  kill \"\$(cat '$REMOTE_DIR/deploy/runpod-hawky-live/workspace-router.pid')\" || true
  rm -f '$REMOTE_DIR/deploy/runpod-hawky-live/workspace-router.pid'
fi
pkill -f '[w]orkspace-router.mjs' 2>/dev/null || true
if ! grep -q '^HAWKY_PROVIDER_GATEWAY_TOKEN=' '$REMOTE_DIR/.env'; then
  token=\"\$(openssl rand -hex 32)\"
  printf '\\nHAWKY_PROVIDER_GATEWAY_TOKEN=%s\\n' \"\$token\" >> '$REMOTE_DIR/.env'
  chmod 0600 '$REMOTE_DIR/.env'
fi
if ! grep -q '^HAWKY_WORKSPACE_PROVISION_COMMAND=' '$REMOTE_DIR/.env'; then
  printf '\\nHAWKY_WORKSPACE_PROVISION_COMMAND=%s\\n' '$REMOTE_DIR/deploy/runpod-hawky-live/provision-approved-user.sh' >> '$REMOTE_DIR/.env'
  chmod 0600 '$REMOTE_DIR/.env'
fi
if ! grep -q '^HAWKY_WORKSPACE_REGISTRY_FILE=' '$REMOTE_DIR/.env'; then
  printf '\\nHAWKY_WORKSPACE_REGISTRY_FILE=%s\\n' '$REMOTE_DIR/deploy/runpod-hawky-live/users.json' >> '$REMOTE_DIR/.env'
  chmod 0600 '$REMOTE_DIR/.env'
fi
if ! grep -q '^HAWKY_SESSION_COOKIE_DOMAIN=' '$REMOTE_DIR/.env'; then
  printf '\\nHAWKY_SESSION_COOKIE_DOMAIN=.hawky.live\\n' >> '$REMOTE_DIR/.env'
  chmod 0600 '$REMOTE_DIR/.env'
fi
if grep -q '^HAWKY_CONTROL_HOSTNAMES=' '$REMOTE_DIR/.env'; then
  sed -i 's#^HAWKY_CONTROL_HOSTNAMES=.*#HAWKY_CONTROL_HOSTNAMES=app.hawky.live,admin.hawky.live,realtime-gateway.hawky.live#' '$REMOTE_DIR/.env'
else
  printf '\\nHAWKY_CONTROL_HOSTNAMES=app.hawky.live,admin.hawky.live,realtime-gateway.hawky.live\\n' >> '$REMOTE_DIR/.env'
  chmod 0600 '$REMOTE_DIR/.env'
fi
if grep -q '^HAWKY_ADMIN_HOSTNAMES=' '$REMOTE_DIR/.env'; then
  sed -i 's#^HAWKY_ADMIN_HOSTNAMES=.*#HAWKY_ADMIN_HOSTNAMES=admin.hawky.live#' '$REMOTE_DIR/.env'
else
  printf '\\nHAWKY_ADMIN_HOSTNAMES=admin.hawky.live\\n' >> '$REMOTE_DIR/.env'
  chmod 0600 '$REMOTE_DIR/.env'
fi
if [ -f '$REMOTE_DIR/deploy/runpod-hawky-live/users.json' ]; then
  USERS_FILE='$REMOTE_DIR/deploy/runpod-hawky-live/users.json' bun - <<'NODE'
const fs = require('node:fs');
const file = process.env.USERS_FILE;
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.users = Array.isArray(config.users) ? config.users : [];
for (const user of config.users) {
  delete user.hostname;
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 });
NODE
fi
set -a
. '$REMOTE_DIR/.env'
set +a
nohup bun dist/index.js gateway --port 4242 --bind 127.0.0.1 > '$REMOTE_DIR/gateway.log' 2>&1 &
echo \$! > '$REMOTE_DIR/gateway.pid'
sleep 2
curl -fsS -H \"X-Hawky-Health-Token: \${HAWKY_HEALTH_TOKEN:-}\" http://127.0.0.1:4242/health
SCRIPT_DIR='$REMOTE_DIR/deploy/runpod-hawky-live' HAWKY_WEBSITE_ROOT='$REMOTE_DIR/website' '$REMOTE_DIR/deploy/runpod-hawky-live/start-website-server.sh'
"
