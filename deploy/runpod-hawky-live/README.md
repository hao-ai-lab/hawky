# Hawky Live RunPod Deployment

`www.hawky.live`, `ios.hawky.live`, `app.hawky.live`, `admin.hawky.live`, and
`realtime-gateway.hawky.live` are served by one RunPod pod through Cloudflare
Tunnel:

- Website: `127.0.0.1:4260` on the pod, serving the public static homepage.
- iOS app redirect: `ios.hawky.live` redirects to the current TestFlight invite.
- Login/app gateway: `127.0.0.1:4242` on the pod.
- Public ingress: Cloudflare Tunnel only.
- Apex `hawky.live`: routed to the website server and redirected to
  `www.hawky.live`.
- Realtime gateway: `realtime-gateway.hawky.live` routes to the same local
  gateway, which mints short-lived OpenAI Realtime client secrets.
- Frontend: `web-ios/dist` copied to `web/dist`, because the gateway serves `web/dist`.
- Public homepage: `website/` served by the local website server.
- Login wall: Hawky app auth (`HAWKY_APP_AUTH=1`).

## Local Secrets

Keep these out of git:

```sh
source /path/to/private/cloudflare.env
```

Expected variables:

- `CF_AUTH_EMAIL`
- `CF_GLOBAL_AUTH_KEY`
- `CF_ACCOUNT_ID`
- `CF_ZONE_ID`

The pod stores runtime secrets in `/opt/hawky/.env` with mode `0600`.

## Deploy App

```sh
HAWKY_REPO_DIR=/path/to/local/hawky-checkout \
POD_HOST=<pod-host> \
POD_SSH_PORT=17432 \
./deploy/runpod-hawky-live/runpod-deploy.sh
```

The script syncs the Hawky app checkout from `HAWKY_REPO_DIR`, builds `web-ios`,
copies it into the gateway static directory, builds the gateway, and restarts
`bun dist/index.js gateway --bind 127.0.0.1`.

The pod does not need GitHub credentials or a GitHub PAT. Deploys are pushed
from a local checkout over SSH/rsync.

## Configure Cloudflare

```sh
source /path/to/private/cloudflare.env
node ./deploy/runpod-hawky-live/cloudflare-hawky-live.mjs
```

This creates or updates:

- remote-managed tunnel `hawky-live-runpod`
- `hawky.live` proxied CNAME to `<tunnel-id>.cfargotunnel.com`
- `www.hawky.live` proxied CNAME to `<tunnel-id>.cfargotunnel.com`
- `ios.hawky.live` proxied CNAME to `<tunnel-id>.cfargotunnel.com`
- `app.hawky.live` proxied CNAME to `<tunnel-id>.cfargotunnel.com`
- `admin.hawky.live` proxied CNAME to `<tunnel-id>.cfargotunnel.com`
- `realtime-gateway.hawky.live` proxied CNAME to `<tunnel-id>.cfargotunnel.com`

## Pod Hardening

Target state:

- `sshd`: key auth only, no password auth.
- website: listen on `127.0.0.1:4260`.
- gateway: listen on `127.0.0.1:4242`.
- `cloudflared`: run with `--token-file`, not token in process argv.
- no default nginx/listeners on public interfaces.
- `HAWKY_HEALTH_TOKEN`: required for `/health` and `/ready` when app auth is enabled.

Useful checks:

```sh
ssh -p 17432 root@<pod-host> 'sshd -T | egrep "^(passwordauthentication|permitrootlogin|pubkeyauthentication)"'
ssh -p 17432 root@<pod-host> 'ss -ltnp'
curl -I https://www.hawky.live/
curl -I https://ios.hawky.live/
curl -I https://app.hawky.live/auth/login
curl -I https://admin.hawky.live/admin
```

Unauthenticated login requests should return the Hawky sign-in portal. Website
requests should return the public homepage. Local health checks use
`X-Hawky-Health-Token` from `/opt/hawky/.env`.

## App Login

The gateway also has optional app-level email/password auth:

```sh
HAWKY_APP_AUTH=1
HAWKY_ALLOW_FIRST_USER_REGISTRATION=0
HAWKY_PUBLIC_REGISTRATION=1
HAWKY_ADMIN_EMAILS=admin@example.com
# Optional auto-approve / invite paths:
# HAWKY_REGISTRATION_ALLOWLIST=friend@example.com
# HAWKY_REGISTRATION_CODE=<private invite code>
# Optional Slack/Discord/custom incoming webhook:
# HAWKY_ADMIN_NOTIFY_WEBHOOK_URL=https://...
```

When enabled, `/auth/device` refuses to mint a device token until the browser has
a valid `hawky_session` httpOnly cookie. Passwords are stored under
`~/.hawky/state/users.json` using `scrypt`; sessions are signed with
`~/.hawky/state/app-auth-secret.key`.

`HAWKY_ALLOW_FIRST_USER_REGISTRATION=1` is only a temporary bootstrap flag. Turn
it off after the first admin account exists. Production registration should keep
`HAWKY_PUBLIC_REGISTRATION=1`: new signups are stored as `pending`, admins review
them at `/admin`, and only approved users can sign in. `HAWKY_ADMIN_EMAILS`
keeps listed accounts admin-approved. `HAWKY_REGISTRATION_ALLOWLIST` and
`HAWKY_REGISTRATION_CODE` are optional fast paths for accounts that should be
approved at registration time.

If `HAWKY_ADMIN_NOTIFY_WEBHOOK_URL` is set, pending registrations post a JSON
notification to that webhook. Without it, pending requests are visible in
`/admin` and logged by the gateway.

Cloudflare only provides tunnel/DNS. App login controls the public portal and
Hawky device-token issuance.

## Per-user Gateway Split

V1 isolation uses a standard control-plane/data-plane split without changing the
main Hawky app first:

- `www.hawky.live`: public website on `127.0.0.1:4260`.
- `hawky.live`: apex website route; redirects to `www.hawky.live`.
- `ios.hawky.live`: stable iOS app URL; redirects to TestFlight.
- `app.hawky.live`: app/login surface on `127.0.0.1:4242`.
- `admin.hawky.live`: admin portal on `127.0.0.1:4242`.
- each user has one per-user gateway process on its own local port.
- one Linux user per Hawky user, for example `hawky-mikey`.
- one runtime home per Hawky user, for example
  `/srv/hawky/users/mikey/home/.hawky`.
- one shared app build at `/opt/hawky`; per-user processes should not write to
  the app checkout.

Cloudflare does not expose per-user gateway hosts. Users enter through
`app.hawky.live`; the control gateway reads the session user, finds that user's
port in `/opt/hawky/deploy/runpod-hawky-live/users.json`, and proxies app/API/WS
traffic directly to `127.0.0.1:<port>`.

```sh
cp deploy/runpod-hawky-live/users.example.json deploy/runpod-hawky-live/users.json
$EDITOR deploy/runpod-hawky-live/users.json

HAWKY_USERS_FILE=deploy/runpod-hawky-live/users.json \
POD_HOST=<pod-host> \
POD_SSH_PORT=17432 \
./deploy/runpod-hawky-live/provision-user-gateways.sh

source /path/to/private/cloudflare.env
node ./deploy/runpod-hawky-live/cloudflare-hawky-live.mjs
```

`provision-user-gateways.sh` seeds a per-user auth store from the current
control-plane users file when it can find the matching email. The per-user
gateway has public registration disabled, so each local gateway starts as a
single-user workspace.

For automatic provisioning, `runpod-deploy.sh` installs the deployment helper
scripts under `/opt/hawky/deploy/runpod-hawky-live` and writes:

```sh
HAWKY_WORKSPACE_PROVISION_COMMAND=/opt/hawky/deploy/runpod-hawky-live/provision-approved-user.sh
```

When an admin approves a pending account, the control gateway runs that command
with the approved user in environment variables. The hook allocates a slug/port,
updates `/opt/hawky/deploy/runpod-hawky-live/users.json`, creates the Linux
user, seeds the per-user auth store, and starts the local gateway.

Provider spend is routed through the control gateway. `provision-user-gateways.sh`
ensures `/opt/hawky/.env` has `HAWKY_PROVIDER_GATEWAY_TOKEN`, then starts each
per-user gateway with:

- `HAWKY_PROVIDER_GATEWAY_URL=http://127.0.0.1:4242`
- `HAWKY_PROVIDER_GATEWAY_TOKEN=<internal token>`
- `HAWKY_API_BASE_URL=http://127.0.0.1:4242/internal/provider/anthropic`
- `ANTHROPIC_API_KEY=<internal token>`
- no `OPENAI_API_KEY`

The token is still a spend capability, so it belongs only in root-owned launch
env, not in browser code or user-editable files. The control gateway remains the
only process with raw OpenAI/Anthropic provider keys.

## Realtime Gateway

The web app uses `live.openaiClientSecret` to mint a short-lived OpenAI Realtime
client secret. If the browser has a saved OpenAI key, that key is used for the
mint. If it does not, the gateway falls back to `OPENAI_API_KEY` from
`/opt/hawky/.env`.

The direct HTTP endpoint is:

```text
POST https://realtime-gateway.hawky.live/api/live/openai/client-secret
```

It is protected by the same Hawky auth/device-token boundary as the app. Do not
make this endpoint public without a grant, quota, or session budget layer.

Recommended starting limits:

```sh
HAWKY_REALTIME_MAX_CLIENT_SECRET_TTL_SECONDS=600
HAWKY_REALTIME_MINTS_PER_HOUR=12
HAWKY_REALTIME_MINTS_PER_DAY=50
```

These limits cap gateway-key client-secret minting per authenticated
identity/device. Browser-supplied BYOK OpenAI keys do not spend the gateway's
OpenAI project and do not count against the gateway mint quota.
