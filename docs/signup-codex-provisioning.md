# Signup to a private workspace and Codex delegate

Automatic provisioning is implemented when the operator enables `HAWKY_AUTO_PROVISION=1` and configures `HAWKY_WORKSPACE_PROVISION_COMMAND`. The privileged Linux implementation and router management service live in the private deployment repository.

## User flow

1. Sign up with Google or an allowed password/invite registration. Existing registration policy is unchanged.
2. The browser shows **Setting up your workspace**. Signup, sign-in, Google callbacks, and administrator approval all use the same setup coordinator.
3. The helper creates a Linux identity, private home/workspace, individual router key, gateway configuration and Codex home. Codex is selected as the hosted web client's initial delegate.
4. The helper starts the user's gateway and runs a real Codex file-read probe under that Linux UID. Only then is the workspace route marked ready.
5. The user enters the app and can delegate without a separate Codex login. Failures retain the account and show **Retry setup**.

Users cannot obtain a device token or enter the shared/default gateway while their workspace is unready. Local installations without automatic provisioning retain their existing behavior.

## State and retries

`src/gateway/workspace-setup.ts` persists a private status record per stable application user ID:

```text
pending -> provisioning -> ready
                  |          |
                failed     disabled
                  |
              explicit retry
```

Repeated requests share one in-process job. Interrupted provisioning resumes on the next authenticated login/status poll. A failed attempt requires an explicit retry. The deployment helper serializes registry changes with a filesystem lock and atomically replaces files. The router allocates a key transactionally by user ID, so retries retain the same identity, directory, port and key. A ready status is rechecked against the workspace registry.

This is a single-host coordinator, not a distributed job queue: there are no expiring leases or scheduled automatic retries. A gateway process supervisor handles service restarts. The command timeout is configurable using `HAWKY_WORKSPACE_PROVISION_TIMEOUT_MS`.

Disabling an account blocks authenticated routing, revokes its router key and stops its gateway and agent processes. Open proxied WebSockets recheck the login session every five seconds. Setup checks the account again before publishing readiness and invokes cleanup if it was disabled during the attempt. Files are retained. Reapproval runs setup again.

## Runtime and credential boundaries

The trusted front door holds the application login database and signing key. It validates the browser cookie, selects the workspace by user ID and injects a private per-workspace proxy credential. It does not forward browser login cookies into the tenant process. Each tenant gateway requires its own credential, including for direct localhost requests and WebSocket upgrades.

The helper supplies an allowlisted environment, distinct `HOME`, `HAWKY_HOME`, `CODEX_HOME`, temporary directory and workspace. Tenant processes never inherit operator OAuth, deployment credentials, the issuance pool or the app signing key. Managed files are written without following tenant-controlled symlinks. Supervisor configuration and logs stay in operator-controlled directories.

A shared operator-managed Codex executable uses a separate configuration/history for each user:

```toml
model = "<operator-verified-api-model>"
model_provider = "hawk"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.hawk]
name = "Hawk"
base_url = "<router-base-url>/v1"
env_key = "HAWKY_USER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

The general delegate runs as the unprivileged tenant UID. Hosts that support Codex sandboxing retain enforced read-only tasks. A deployment explicitly configured with `HAWKY_CODEX_EXECUTION_POLICY=linux-user` runs tasks under the tenant UID, serializes them exclusively, and records that read-only intent is not sandbox-enforced. The prompt still preserves a request to inspect without modifications. Linux filesystem permissions provide the requested first-release separation; there is no per-user container or VM. Administrators retain access and tenants share host resources/networking.

The user can read/export their own Hawk key. Upstream provider credentials remain on the router. The allocator stores recoverable keys encrypted, assigns one per user, supports revocation and enforces a daily request count. Stored Responses and Live session operations are checked against the key's owner; unsupported shared resource operations are rejected. Request counts are not a dollar spending cap, and already minted short-lived provider credentials can remain valid until their provider expiry.

## Configuration and verification

- `HAWKY_AUTO_PROVISION=1`: enable setup gating/coordinator on the authenticated front door.
- `HAWKY_WORKSPACE_PROVISION_COMMAND`: trusted helper command; receives server-owned identity fields and `HAWKY_PROVISION_ACTION=provision|disable`.
- `HAWKY_WORKSPACE_REGISTRY_FILE`: operator-owned registry; ready entries include stable `userId`, local port and `proxyToken`.
- Tenant environment: `HAWKY_WORKSPACE_PROXY_TOKEN`, `HAWKY_WORKSPACE_USER_ID`, `HAWKY_DEFAULT_BACKEND_RUNTIME=codex`.

Tests cover deduplicated setup, failed retry, interrupted recovery, stale readiness, disable/reapprove, token gating and existing login routes. Deployment verification additionally exercises two fresh invited signups, real WebSocket delegation through the public front door, actual Linux identities/workspaces, and cross-user file access. Google callback routing shares the same coordinator; interactive Google signup still merits a manual browser smoke test.

Private deployment instructions, models, hosts and credentials belong in the companion repository. Existing shared/default-workspace history is not automatically copied into a new private account. Hosted iPhone login/pairing across this front door remains a separate client flow to verify.
