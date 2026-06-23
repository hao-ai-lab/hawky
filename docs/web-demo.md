# Hosting the Hawky web demo

A single hosted URL that runs the assistant in the browser — no install — mirroring
the iOS app's user-facing features. This is the deployment guide for issue #681.

## What the web demo includes

| Feature | Web | Notes |
|---|---|---|
| Chat (sessions, tools, permissions) | ✅ | Always available in the sidebar. |
| Live (realtime voice + camera) | ✅ | `getUserMedia` + WebRTC to OpenAI Realtime. |
| Transcription (mic → live text) | ✅ | Realtime input transcription. |
| People database (Cocktail Party) | ✅ | Read-only; needs the DeepFace service for data. |
| Memory (SOUL / IDENTITY / MEMORY.md / daily) | ✅ | Memory view. |
| Settings / providers / BYOK key | ✅ | |
| Push notifications | ✅ | PWA / installable. |
| Smart-glasses capture | ⛔ | iPhone-only (no browser hardware). |
| Native Safety-vision watch | ⛔ | iPhone-only pipeline. |

The Live / Transcription / People views are shown by default and can be hidden via
**Settings → Demo views**.

## Build

```bash
# From the repo root
bun run web:build      # tsc + vite build → web/dist/
```

The gateway serves `web/dist/` automatically (see `src/gateway/static.ts`):
SPA fallback, content-hashed asset caching, and path-traversal guards are built in.

## Run it locally

```bash
bun run gateway        # serves the web app + WebSocket API on :4242
# open http://localhost:4242
```

## Host it publicly

Two requirements drive the hosting setup:

1. **TLS is mandatory.** Browsers only grant camera/microphone (`getUserMedia`) on a
   secure origin (`https://` / `wss://`). Serve the demo over HTTPS.
2. **The gateway must be reachable**, and it refuses to bind to a non-loopback
   address unless device-token auth is initialized (a deliberate safety check in
   `src/index.ts`). The default bind is `127.0.0.1`.

The recommended setup keeps the gateway on loopback and puts a TLS tunnel/proxy in
front of it — exactly the path the iOS app already uses (Cloudflare Access /
Tunnel; the gateway's device-token + CF-redirect handling lives in
`src/gateway/device-auth.ts` and `src/gateway/server.ts`):

```bash
# Gateway on loopback (default), web app already built into web/dist
bun run gateway

# Cloudflare Tunnel (or any TLS reverse proxy) → http://127.0.0.1:4242
cloudflared tunnel --url http://127.0.0.1:4242
```

Direct bind to a public interface is also possible once device auth is set up:

```bash
bun run gateway -- --bind 0.0.0.0   # only allowed when device auth is initialized
```

Auth uses the existing **device-token** flow (`/auth/device`): the browser acquires a
token automatically, or — behind Cloudflare Access — is redirected through CF login
and back. No change is needed for the demo.

## API keys — BYOK (bring your own key)

The hosted demo **never ships a shared OpenAI key**. To power the realtime Live and
Transcription demos, each visitor adds their own key under **Settings → OpenAI key
(this browser)**:

- Stored only in this browser's `localStorage` (`lib/byok.ts`).
- Sent to the gateway **only** to mint a short-lived realtime client secret
  (`live.openaiClientSecret` → broker `byok_api_key`, `src/gateway/live-realtime-broker.ts`).
- Never persisted on the server and never logged.

If a key is configured on the gateway itself (`OPENAI_API_KEY` /
`config.api_keys.openai`), it is used as a fallback when no BYOK key is supplied —
keep that off for public demos.

## People database (optional)

The **People** view reads the server-side DeepFace person DB via the `people.list`
RPC. When the DeepFace microservice isn't running, the view shows a clean
"service not running" state and the rest of the demo is unaffected. To enable real
data, start the service (`services/deepface/`) or set `DEEPFACE_URL`.

## Dev server (HMR)

```bash
bun run gateway        # terminal 1
bun run web:dev        # terminal 2 → http://localhost:5173
```

The Vite dev server proxies `/ws`, `/auth`, and `/api` to the gateway
(`VITE_GATEWAY_URL`, default `ws://localhost:4242`; see `web/.env.example`).
