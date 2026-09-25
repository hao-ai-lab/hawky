# Hosted account connection for iPhone

Status: proposed design; native implementation has not started.

## User flow

1. The signed-in website offers **Connect iPhone** in account settings. On a phone it opens Hawky; on desktop it shows a QR code for the same connection landing page, with installation guidance if needed.
2. Hawky opens the system authentication browser. The user signs into their existing Hawky account and confirms the account being connected. An existing phone browser login can reduce friction; desktop login does not automatically transfer to the phone.
3. The app shows **Setting up workspace**, **Connecting**, then **Connected as …**. An existing account uses its existing workspace rather than provisioning another one.
4. The phone uses the hosted gateway for chats, memory and delegated tasks. Live providers are enabled only after their native media path is implemented and tested.

The QR code contains only a public connection URL, not an API key or reusable login token. For the first release, require browser sign-in on the phone. A desktop-approved device-code pairing flow can follow later if eliminating that sign-in is valuable.

## What exists and what is missing

| Area | Current code | Required change |
| --- | --- | --- |
| Device authentication | `DeviceAuthClient.swift` obtains `/auth/device` credentials; native Keychain storage exists. | Add hosted account sign-in and device credential lifecycle. |
| Hosted routing | `src/gateway/app-auth.ts` identifies accounts from browser session cookies. The control gateway selects a tenant before the WebSocket upgrade. | Accept account-bound native bearer credentials at the HTTP/WebSocket boundary, before routing. |
| Native transport | `URLSessionGatewayTransport.swift` sends its device token in the connect RPC after upgrading. | Attach the hosted access credential to the upgrade request; retain tenant-level authorization. |
| Deep links | The `hawky` URL scheme and navigation routes exist. | Add a connection entry point and an authentication callback handled by the authentication session. |
| Live media | The active OpenAI native path uses a phone-stored API key; Gemini/custom providers are disabled. | Implement a native gateway-stream provider using the shared media protocol. JoyAI and Venus are not currently native providers. |

Successful web tests do not establish native provider compatibility. Native conversation archives also need explicit synchronization; account connection alone does not transfer an ongoing call or local transcript.

## Authentication and workspace routing

Use `ASWebAuthenticationSession` with authorization code + PKCE S256 and state. The gateway implements the authorization endpoints around existing account login; this is not a claim that they already exist.

- Register and allowlist callback URLs. Prefer a claimed HTTPS callback/universal link where deployment and the supported iOS versions allow it; otherwise use an app-specific scheme with PKCE.
- Issue a single-use authorization code with a short expiry (for example 60 seconds), bound to client, callback and PKCE challenge. The app redeems it with the verifier.
- Return a short-lived access credential (initial target: 15 minutes) and a rotating, revocable refresh credential. Store them in Keychain. Persist a server-side device record and hashed refresh credentials; reject refresh replay.
- Resolve the account and workspace server-side. Never accept a client-selected Linux username, tenant port or internal workspace proxy secret.
- Keep account routing credentials distinct from tenant gateway device credentials and model provider keys. Existing `/auth/device` issuance can run behind native account authentication; the phone never receives the internal proxy secret.
- Sign-out clears local credentials and revokes that device's refresh grant. Device revocation must also terminate its live connections; enforce authorization again on reconnect.
- No provider API keys, Cloudflare service secrets or deployment credentials appear in QR codes, redirects or logs. Redact authorization headers and codes.

State flow: **Signed out → Browser sign-in → Code exchange → Workspace pending → Connecting → Ready**. An expired access token triggers one serialized refresh; a revoked grant returns to sign-in. Transient network failures reconnect with backoff and do not create another account or workspace.

This follows [Apple's web authentication session](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession) and [RFC 8252's native-app browser/PKCE guidance](https://www.rfc-editor.org/rfc/rfc8252).

## Native Live architecture

Keep microphone, camera/glasses capture, audio playback, interruptions and app lifecycle in Swift. Add a `GatewayLiveSessionProvider` that sends PCM audio, image frames and typed messages, and consumes normalized captions, audio, task events and playback acknowledgements from `live.stream.*`.

The gateway owns Gemini/JoyAI/Venus protocol translation and provider credentials. Retain provider capabilities so unavailable modes are disabled honestly. OpenAI's direct WebRTC path needs a server-issued ephemeral credential broker if retained; do not copy a hosted long-lived provider key onto the phone. Provider-specific interruption and session constraints still need testing, especially Venus.

The same account shares durable workspace data. Starting on iPhone restores saved conversation context by session ID; it creates a new media connection. Seamless transfer of an active web call is deferred.

## Implementation order and estimate

| Deliverable | Engineering estimate |
| --- | --- |
| Hosted auth endpoints, native sign-in/Keychain, tenant routing and physical iPhone connection | 2–3 days |
| Native gateway Live adapter, initial Gemini path, reconnect/playback and glasses checks | 3–5 additional days |

Estimates assume the existing gateway media protocol is reusable. Venus runtime fixes and full provider parity are separate work.

Acceptance: sign in on a real iPhone over cellular, reach the same account workspace, verify one saved memory and delegated task, and reconnect. Confirm a second account cannot route to the first workspace; expired/reused codes and revoked devices are rejected. Then test microphone, camera/glasses, spoken replies and interruption through Gemini before expanding to other providers. No native code is changed by this design document.
