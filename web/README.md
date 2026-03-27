# Hawky Web Frontend

PWA interface for Hawky. Connects to the gateway via WebSocket. Works in desktop browsers and as an installable app on iPhone.

Beyond chat, it includes the **Demo** views that mirror the iOS app — **Live**
(realtime voice + camera), **Transcription** (mic → live text), and **People**
(face-recognition database) — plus Memory, Status, and Settings. The realtime
demos use a "bring your own key" OpenAI key entered in Settings and stored only in
your browser. To host this as a public, no-install demo, see
[`docs/web-demo.md`](../docs/web-demo.md).

## Prerequisites

- Hawky gateway running (`bun run gateway` from the root project)
- Node.js 18+ or Bun 1.0+ (for building)

## Development

Start the gateway and web dev server in separate terminals:

```bash
# Terminal 1: Start gateway (from project root)
bun run gateway

# Terminal 2: Start web dev server (from project root)
bun run web:dev
```

Open `http://localhost:5173` in your browser. The Vite dev server proxies WebSocket connections to the gateway on port 4242.

Hot module replacement (HMR) is enabled — changes to React components update instantly.

## Production

Build the frontend and let the gateway serve it:

```bash
# Build (from project root)
bun run web:build

# Start gateway — it serves web/dist/ at /
bun run gateway
```

Open `http://localhost:4242` in your browser. The gateway serves both the static frontend and the WebSocket API on the same port.

## Testing

```bash
# Run unit tests (from project root)
bun run web:test

# Or from the web/ directory
cd web && bun run test

# Watch mode
cd web && bun run test:watch
```

Tests use Vitest with jsdom for DOM simulation. No browser needed for unit tests.

## Project Structure

```
web/
├── src/
│   ├── main.tsx              — React entry point
│   ├── App.tsx               — Layout shell (sidebar + chat area)
│   ├── components/           — React components
│   │   └── Sidebar.tsx       — Channel list sidebar
│   ├── hooks/                — React hooks (useSocket, useChat, etc.)
│   ├── lib/                  — Utilities (protocol, markdown, storage)
│   └── styles/
│       └── globals.css       — Tailwind base styles
├── tests/                    — Vitest unit tests
├── public/                   — Static assets (favicon, icons)
├── vite.config.ts            — Vite config + WS proxy
├── vitest.config.ts          — Test config (jsdom)
├── tailwind.config.ts        — Tailwind theme
└── tsconfig.json             — TypeScript config
```

## Tech Stack

- **React 19** — UI framework
- **Vite 6** — Build tool + dev server
- **Tailwind CSS 3** — Utility-first styling
- **Vitest** — Unit testing (jsdom environment)
- **TypeScript** — Strict mode

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `VITE_GATEWAY_URL` | `ws://localhost:4242` | Gateway WebSocket URL (dev mode proxy target) |
