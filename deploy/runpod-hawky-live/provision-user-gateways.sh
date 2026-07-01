#!/usr/bin/env bash
set -euo pipefail

POD_HOST="${POD_HOST:?Set POD_HOST to the RunPod SSH host}"
POD_SSH_PORT="${POD_SSH_PORT:-17432}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/hawky}"
REMOTE_USERS_ROOT="${REMOTE_USERS_ROOT:-/srv/hawky/users}"
REMOTE_SEED_USERS_FILE="${REMOTE_SEED_USERS_FILE:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERS_FILE="${HAWKY_USERS_FILE:-$SCRIPT_DIR/users.json}"

if [ ! -f "$USERS_FILE" ]; then
  echo "Missing $USERS_FILE. Copy users.example.json to users.json and edit it first." >&2
  exit 2
fi

ssh_cmd=(ssh -n -p "$POD_SSH_PORT" -o StrictHostKeyChecking=accept-new "root@$POD_HOST")

users_tsv="$(node - "$USERS_FILE" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(config.users)) throw new Error(`${file} must contain a users array`);
for (const [index, user] of config.users.entries()) {
  const slug = String(user.slug || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const linuxUser = String(user.linuxUser || `hawky-${slug}`).trim();
  const port = Number(user.port);
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/.test(slug)) throw new Error(`users[${index}].slug is invalid`);
  if (!email || !email.includes("@")) throw new Error(`users[${index}].email is invalid`);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(linuxUser)) throw new Error(`users[${index}].linuxUser is invalid`);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`users[${index}].port is invalid`);
  console.log([slug, email, linuxUser, port].join("\t"));
}
NODE
)"

if [ -z "$users_tsv" ]; then
  echo "No users declared in $USERS_FILE." >&2
  exit 2
fi

"${ssh_cmd[@]}" "set -euo pipefail
export PATH=\"\$HOME/.bun/bin:\$PATH\"
if [ ! -f '$REMOTE_APP_DIR/dist/index.js' ]; then
  echo '$REMOTE_APP_DIR/dist/index.js is missing. Run runpod-deploy.sh first.' >&2
  exit 2
fi
if ! command -v bun >/dev/null 2>&1 && [ ! -x /usr/local/bin/bun ]; then
  echo 'bun is missing. Run runpod-deploy.sh first.' >&2
  exit 2
fi
if [ ! -x /usr/local/bin/bun ]; then
  install -m 0755 \"\$(command -v bun)\" /usr/local/bin/bun
fi
if ! grep -q '^HAWKY_PROVIDER_GATEWAY_TOKEN=' '$REMOTE_APP_DIR/.env'; then
  token=\"\$(openssl rand -hex 32)\"
  printf '\\nHAWKY_PROVIDER_GATEWAY_TOKEN=%s\\n' \"\$token\" >> '$REMOTE_APP_DIR/.env'
  chmod 0600 '$REMOTE_APP_DIR/.env'
fi
mkdir -p '$REMOTE_USERS_ROOT'
"

while IFS=$'\t' read -r slug email linux_user port; do
  [ -n "$slug" ] || continue
  "${ssh_cmd[@]}" "set -euo pipefail
export PATH=\"\$HOME/.bun/bin:\$PATH\"
slug='$slug'
email='$email'
linux_user='$linux_user'
port='$port'
user_root='$REMOTE_USERS_ROOT/$slug'
home_dir=\"\$user_root/home\"
hawky_home=\"\$home_dir/.hawky\"

if ! id -u \"\$linux_user\" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir \"\$home_dir\" --shell /usr/sbin/nologin \"\$linux_user\"
fi

mkdir -p \"\$hawky_home/state\" \"\$user_root/logs\"
chown -R \"\$linux_user:\$linux_user\" \"\$user_root\"

seed_users_file='$REMOTE_SEED_USERS_FILE'
if [ -z \"\$seed_users_file\" ]; then
  set -a
  . '$REMOTE_APP_DIR/.env'
  set +a
  seed_hawky_home=\"\${HAWKY_HOME:-/root/.hawky}\"
  for candidate in \"\$seed_hawky_home/state/users.json\" '/root/.hawky/state/users.json' '$REMOTE_APP_DIR/.hawky/state/users.json'; do
    if [ -f \"\$candidate\" ]; then
      seed_users_file=\"\$candidate\"
      break
    fi
  done
fi
seed_signing_key_file=\"\"
for candidate in \"\${seed_hawky_home:-/root/.hawky}/state/app-auth-secret.key\" '/root/.hawky/state/app-auth-secret.key' '$REMOTE_APP_DIR/.hawky/state/app-auth-secret.key'; do
  if [ -f \"\$candidate\" ]; then
    seed_signing_key_file=\"\$candidate\"
    break
  fi
done

if [ -n \"\$seed_users_file\" ] && [ -f \"\$seed_users_file\" ]; then
  SEED_USERS_FILE=\"\$seed_users_file\" TARGET_USERS_FILE=\"\$hawky_home/state/users.json\" TARGET_EMAIL=\"\$email\" TARGET_ROLE=user /usr/local/bin/bun - <<'NODE'
const fs = require('node:fs');
const seedFile = process.env.SEED_USERS_FILE;
const targetFile = process.env.TARGET_USERS_FILE;
const targetEmail = process.env.TARGET_EMAIL;
const targetRole = process.env.TARGET_ROLE || 'user';
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const users = Array.isArray(seed.users) ? seed.users : [];
const source = users.find((user) => String(user.email || '').toLowerCase() === targetEmail);
if (source) {
  const target = {
    ...source,
    role: targetRole,
    status: 'approved',
    approvedAt: source.approvedAt || new Date().toISOString(),
    rejectedAt: undefined,
    rejectionReason: undefined,
  };
  fs.writeFileSync(targetFile, JSON.stringify({ users: [target] }, null, 2) + '\\n', { mode: 0o600 });
}
NODE
  chown \"\$linux_user:\$linux_user\" \"\$hawky_home/state/users.json\" 2>/dev/null || true
fi
if [ -n \"\$seed_signing_key_file\" ]; then
  install -m 0600 -o \"\$linux_user\" -g \"\$linux_user\" \"\$seed_signing_key_file\" \"\$hawky_home/state/app-auth-secret.key\"
fi

if [ -f \"\$user_root/gateway.pid\" ] && kill -0 \"\$(cat \"\$user_root/gateway.pid\")\" 2>/dev/null; then
  kill \"\$(cat \"\$user_root/gateway.pid\")\" || true
  sleep 1
fi

set -a
. '$REMOTE_APP_DIR/.env'
set +a
provider_gateway_token=\"\${HAWKY_PROVIDER_GATEWAY_TOKEN:-}\"
if [ -z \"\$provider_gateway_token\" ]; then
  echo 'HAWKY_PROVIDER_GATEWAY_TOKEN is missing from $REMOTE_APP_DIR/.env' >&2
  exit 2
fi
export HOME=\"\$home_dir\"
export HAWKY_HOME=\"\$hawky_home\"
export HAWKY_APP_AUTH=1
export HAWKY_PUBLIC_REGISTRATION=0
export HAWKY_ALLOW_FIRST_USER_REGISTRATION=0
export HAWKY_ADMIN_EMAILS=\"\${HAWKY_WORKSPACE_ADMIN_EMAILS:-}\"
export HAWKY_SESSION_COOKIE_DOMAIN=\"\${HAWKY_SESSION_COOKIE_DOMAIN:-.hawky.live}\"
export HAWKY_HEALTH_TOKEN=\"\${HAWKY_HEALTH_TOKEN:-}\"
export HAWKY_PROVIDER_GATEWAY_URL=\"\${HAWKY_PROVIDER_GATEWAY_URL:-http://127.0.0.1:4242}\"
export HAWKY_PROVIDER_GATEWAY_TOKEN=\"\$provider_gateway_token\"
export HAWKY_PROVIDER_SUBJECT=\"user:\$email\"
export HAWKY_API_BASE_URL=\"\$HAWKY_PROVIDER_GATEWAY_URL/internal/provider/anthropic\"
export ANTHROPIC_API_KEY=\"\$provider_gateway_token\"
unset OPENAI_API_KEY
export HAWKY_REALTIME_MAX_CLIENT_SECRET_TTL_SECONDS=\"\${HAWKY_REALTIME_MAX_CLIENT_SECRET_TTL_SECONDS:-600}\"
export HAWKY_REALTIME_MINTS_PER_HOUR=\"\${HAWKY_REALTIME_MINTS_PER_HOUR:-12}\"
export HAWKY_REALTIME_MINTS_PER_DAY=\"\${HAWKY_REALTIME_MINTS_PER_DAY:-50}\"

runuser --preserve-environment -u \"\$linux_user\" -- \\
  nohup /usr/local/bin/bun '$REMOTE_APP_DIR/dist/index.js' gateway --port \"\$port\" --bind 127.0.0.1 > \"\$user_root/logs/gateway.log\" 2>&1 &
echo \$! > \"\$user_root/gateway.pid\"
sleep 2
curl -fsS -H \"X-Hawky-Health-Token: \$HAWKY_HEALTH_TOKEN\" \"http://127.0.0.1:\$port/health\" >/dev/null
echo \"started \$slug as \$linux_user on 127.0.0.1:\$port\"
"
done <<< "$users_tsv"
