# Hawky Web (iOS-app, React)

A standalone **responsive web app** (React + Vite) that implements the Hawky
**iOS app's functions** in the browser, talking to the same gateway. It is a real
web layout — a **left sidebar** on desktop, a **bottom bar** on mobile — not the
desktop `web/` chat UI and not a phone-in-a-frame.

```
Desktop                                  Mobile
┌────────┬──────────────────────────┐   ┌──────────────────┐
│ Live   │                          │   │   (screen fills)  │
│ Chat   │   wide content area      │   │                   │
│ People │   (the active screen)    │   │                   │
│ Memory │                          │   ├──────────────────┤
│ …      │                          │   │ Live Chat People  │
│ Settings                          │   │      … More       │
└────────┴──────────────────────────┘   └──────────────────┘
```

## Screens / functions

| Screen | What it does | Gateway |
|---|---|---|
| **Live** | FaceTime-style realtime voice + camera, transcript, mic/camera/silent/cocktail toggles | `live.openaiClientSecret`, `frontend.boot_context` |
| **Chat** | Backend-agent chat + session switcher, streaming | `chat.send`, `session.list/history`, `agent.*` events |
| **People** | Face-recognition database (names, facts, recaps) | `people.list` |
| **Memory** | 4-tier memory viewer/editor (SOUL/IDENTITY/MEMORY/daily) | `workspace.list/read/write` |
| **Recordings** | On-device recordings notice (iPhone-only library) | — |
| **Notifications** | Push availability + heartbeat trigger | `push.vapidKey`, `heartbeat.trigger` |
| **Settings** | Connection, OpenAI key (BYOK), Agent, Live prompt, Appearance, About | `config.get`, `gateway.swapProvider` |

## Run

```bash
# 1) Gateway running (from the repo root)
bun run gateway

# 2) This app (separate Vite project)
cd web-ios && bun install && bun run dev
# → http://localhost:5273   (VITE_GATEWAY_URL points the proxy at the gateway)
```

Open **http://localhost:5273**. Live/camera/mic require a **secure context**
(`https://` or `localhost`) — over a plain-HTTP LAN/Tailscale IP the browser hides
the camera, and the app shows a clear message instead of crashing.

## OpenAI key (BYOK)

Add your key in **Settings → OpenAI key (this device)**. It is stored only in this
browser and sent to the gateway solely to mint short-lived realtime secrets. If the
gateway has its own `OPENAI_API_KEY`, that is used as a fallback.

## Build / test

```bash
bun run build   # tsc + vite → dist/  (served by the gateway, or any static host over HTTPS)
bun run test    # vitest + jsdom smoke tests (mounts App, switches tabs, mocks the gateway)
```

## Architecture

- Reuses the proven gateway plumbing from `web/`: `ws-client`, `socket-store`,
  `byok`, `media`. Wire types come from `../src/gateway/protocol.ts` via the
  `@hawky/protocol` alias.
- The Live engine (`src/lib/useRealtime.ts`) does boot-context → BYOK realtime
  secret → WebRTC to OpenAI Realtime → mic/voice + camera frames → transcript.
- Out of scope (iPhone-only): smart-glasses capture, native Safety-vision.
