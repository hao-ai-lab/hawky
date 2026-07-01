#!/usr/bin/env bash
set -euo pipefail

REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/hawky}"
SCRIPT_DIR="${SCRIPT_DIR:-$REMOTE_APP_DIR/deploy/runpod-hawky-live}"
USERS_FILE="${HAWKY_USERS_FILE:-$SCRIPT_DIR/users.json}"
REMOTE_USERS_ROOT="${REMOTE_USERS_ROOT:-/srv/hawky/users}"
EMAIL="${HAWKY_PROVISION_USER_EMAIL:-}"
USER_ID="${HAWKY_PROVISION_USER_ID:-}"
ROLE="${HAWKY_PROVISION_USER_ROLE:-user}"

if [ -z "$EMAIL" ] || [ -z "$USER_ID" ]; then
  echo "HAWKY_PROVISION_USER_EMAIL and HAWKY_PROVISION_USER_ID are required." >&2
  exit 2
fi
if [ ! -f "$REMOTE_APP_DIR/dist/index.js" ]; then
  echo "$REMOTE_APP_DIR/dist/index.js is missing. Deploy the app first." >&2
  exit 2
fi
if [ ! -x /usr/local/bin/bun ]; then
  echo "/usr/local/bin/bun is missing. Deploy the app first." >&2
  exit 2
fi

mkdir -p "$SCRIPT_DIR" "$REMOTE_USERS_ROOT"
if [ ! -f "$USERS_FILE" ]; then
  printf '{\n  "users": []\n}\n' > "$USERS_FILE"
  chmod 0600 "$USERS_FILE"
fi

record_json="$(USERS_FILE="$USERS_FILE" EMAIL="$EMAIL" USER_ID="$USER_ID" /usr/local/bin/bun - <<'NODE'
const fs = require("node:fs");
const file = process.env.USERS_FILE;
const email = String(process.env.EMAIL || "").trim().toLowerCase();
const userId = String(process.env.USER_ID || "").trim();
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { users: [] };
config.users = Array.isArray(config.users) ? config.users : [];

function slugBaseForEmail(value) {
  const local = value.split("@")[0] || "user";
  return local.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
}

let user = config.users.find((candidate) => String(candidate.email || "").toLowerCase() === email);
if (!user) {
  const usedSlugs = new Set(config.users.map((candidate) => candidate.slug));
  const usedPorts = new Set(config.users.map((candidate) => Number(candidate.port)).filter(Number.isInteger));
  const base = slugBaseForEmail(email);
  let slug = base;
  let suffix = 2;
  while (usedSlugs.has(slug)) slug = `${base}-${suffix++}`;
  let port = 4301;
  while (usedPorts.has(port)) port += 1;
  user = {
    slug,
    email,
    linuxUser: `hawky-${slug}`.slice(0, 32),
    port,
    userId,
  };
  config.users.push(user);
} else {
  user.userId = user.userId || userId;
}

fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(user));
NODE
)"

slug="$(printf '%s' "$record_json" | /usr/local/bin/bun -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); console.log(j.slug)')"
linux_user="$(printf '%s' "$record_json" | /usr/local/bin/bun -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); console.log(j.linuxUser)')"
port="$(printf '%s' "$record_json" | /usr/local/bin/bun -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); console.log(j.port)')"

user_root="$REMOTE_USERS_ROOT/$slug"
home_dir="$user_root/home"
hawky_home="$home_dir/.hawky"

if ! id -u "$linux_user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$home_dir" --shell /usr/sbin/nologin "$linux_user"
fi

mkdir -p "$hawky_home/state" "$user_root/logs"
chown -R "$linux_user:$linux_user" "$user_root"

set -a
. "$REMOTE_APP_DIR/.env"
set +a
seed_hawky_home="${HAWKY_HOME:-/root/.hawky}"
seed_users_file=""
seed_signing_key_file=""
for candidate in "$seed_hawky_home/state/users.json" "/root/.hawky/state/users.json" "$REMOTE_APP_DIR/.hawky/state/users.json"; do
  if [ -f "$candidate" ]; then
    seed_users_file="$candidate"
    break
  fi
done
for candidate in "$seed_hawky_home/state/app-auth-secret.key" "/root/.hawky/state/app-auth-secret.key" "$REMOTE_APP_DIR/.hawky/state/app-auth-secret.key"; do
  if [ -f "$candidate" ]; then
    seed_signing_key_file="$candidate"
    break
  fi
done

if [ -n "$seed_users_file" ]; then
  SEED_USERS_FILE="$seed_users_file" TARGET_USERS_FILE="$hawky_home/state/users.json" TARGET_EMAIL="$EMAIL" TARGET_ROLE="$ROLE" /usr/local/bin/bun - <<'NODE'
const fs = require("node:fs");
const seed = JSON.parse(fs.readFileSync(process.env.SEED_USERS_FILE, "utf8"));
const users = Array.isArray(seed.users) ? seed.users : [];
const source = users.find((user) => String(user.email || "").toLowerCase() === String(process.env.TARGET_EMAIL || "").toLowerCase());
if (!source) process.exit(0);
const target = {
  ...source,
  role: process.env.TARGET_ROLE === "admin" ? "admin" : "user",
  status: "approved",
  approvedAt: source.approvedAt || new Date().toISOString(),
  rejectedAt: undefined,
  rejectionReason: undefined,
};
fs.writeFileSync(process.env.TARGET_USERS_FILE, JSON.stringify({ users: [target] }, null, 2) + "\n", { mode: 0o600 });
NODE
  chown "$linux_user:$linux_user" "$hawky_home/state/users.json" 2>/dev/null || true
fi
if [ -n "$seed_signing_key_file" ]; then
  install -m 0600 -o "$linux_user" -g "$linux_user" "$seed_signing_key_file" "$hawky_home/state/app-auth-secret.key"
fi

if ! grep -q '^HAWKY_PROVIDER_GATEWAY_TOKEN=' "$REMOTE_APP_DIR/.env"; then
  token="$(openssl rand -hex 32)"
  printf '\nHAWKY_PROVIDER_GATEWAY_TOKEN=%s\n' "$token" >> "$REMOTE_APP_DIR/.env"
  chmod 0600 "$REMOTE_APP_DIR/.env"
fi

set -a
. "$REMOTE_APP_DIR/.env"
set +a
provider_gateway_token="${HAWKY_PROVIDER_GATEWAY_TOKEN:-}"
if [ -z "$provider_gateway_token" ]; then
  echo "HAWKY_PROVIDER_GATEWAY_TOKEN is missing from $REMOTE_APP_DIR/.env" >&2
  exit 2
fi

if [ -f "$user_root/gateway.pid" ] && kill -0 "$(cat "$user_root/gateway.pid")" 2>/dev/null; then
  kill "$(cat "$user_root/gateway.pid")" || true
  sleep 1
fi

export HOME="$home_dir"
export HAWKY_HOME="$hawky_home"
export HAWKY_APP_AUTH=1
export HAWKY_PUBLIC_REGISTRATION=0
export HAWKY_ALLOW_FIRST_USER_REGISTRATION=0
export HAWKY_ADMIN_EMAILS="${HAWKY_WORKSPACE_ADMIN_EMAILS:-}"
export HAWKY_SESSION_COOKIE_DOMAIN="${HAWKY_SESSION_COOKIE_DOMAIN:-.hawky.live}"
export HAWKY_HEALTH_TOKEN="${HAWKY_HEALTH_TOKEN:-}"
export HAWKY_PROVIDER_GATEWAY_URL="${HAWKY_PROVIDER_GATEWAY_URL:-http://127.0.0.1:4242}"
export HAWKY_PROVIDER_GATEWAY_TOKEN="$provider_gateway_token"
export HAWKY_PROVIDER_SUBJECT="user:$EMAIL"
export HAWKY_API_BASE_URL="$HAWKY_PROVIDER_GATEWAY_URL/internal/provider/anthropic"
export ANTHROPIC_API_KEY="$provider_gateway_token"
# Face recognition + Safety Check (assess_hazard) call a shared DeepFace sidecar
# (services/deepface). Per-user gateways have no sidecar of their own, so point
# them all at the host-shared service; otherwise resolveDeepFaceURL() falls back
# to 127.0.0.1:8099 inside the (empty) per-user namespace and every call fails.
export DEEPFACE_URL="${HAWKY_WORKSPACE_DEEPFACE_URL:-http://127.0.0.1:8099}"
unset OPENAI_API_KEY
export HAWKY_REALTIME_MAX_CLIENT_SECRET_TTL_SECONDS="${HAWKY_REALTIME_MAX_CLIENT_SECRET_TTL_SECONDS:-600}"
export HAWKY_REALTIME_MINTS_PER_HOUR="${HAWKY_REALTIME_MINTS_PER_HOUR:-12}"
export HAWKY_REALTIME_MINTS_PER_DAY="${HAWKY_REALTIME_MINTS_PER_DAY:-50}"

runuser --preserve-environment -u "$linux_user" -- \
  nohup /usr/local/bin/bun "$REMOTE_APP_DIR/dist/index.js" gateway --port "$port" --bind 127.0.0.1 > "$user_root/logs/gateway.log" 2>&1 &
echo $! > "$user_root/gateway.pid"
sleep 2
curl -fsS -H "X-Hawky-Health-Token: $HAWKY_HEALTH_TOKEN" "http://127.0.0.1:$port/health" >/dev/null

echo "workspace provisioned: $EMAIL -> $linux_user on 127.0.0.1:$port"
