# Hawky

<!-- [![CI](https://github.com/zhisbug/hawky/actions/workflows/ci.yml/badge.svg)](https://github.com/zhisbug/hawky/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/hawky)](https://www.npmjs.com/package/hawky) -->

A personal assistant built on a powerful coding agent core. Gateway-client architecture with TUI, web, and mobile (PWA) interfaces.

## Install

```bash
# Option 1: npm/bun (requires Bun >= 1.3)
bun install -g hawky

# Option 2: one-line install (installs Bun if needed)
curl -fsSL https://raw.githubusercontent.com/zhisbug/hawky/main/install.sh | bash
```

## Quick Start

```bash
# Terminal 1: start the gateway server
hawky gateway

# Terminal 2: open the TUI
hawky
```

On first run, the gateway prompts for your Anthropic API key (masked input). Then the agent walks you through identity setup and configuration via `/setup`.

## Dev Setup

```bash
# Clone and install
git clone https://github.com/zhisbug/hawky.git
cd hawky
bun install

# Start gateway (foreground, visible logs)
bun run gateway

# Start TUI client (another terminal)
bun run dev

# Start web frontend (another terminal, optional)
cd web && bun install && bun run dev
# Opens at http://localhost:5173, proxies to gateway at :4242
```

### Useful Dev Commands

```bash
# Type check
bun run typecheck

# Unit tests (~2200 tests)
bun run test

# Integration tests
bun run test:integration

# E2E tests (requires API keys)
ANTHROPIC_API_KEY=... BRAVE_API_KEY=... bun run test:e2e

# All tests
ANTHROPIC_API_KEY=... BRAVE_API_KEY=... bun run test:all

# Web UI tests
cd web && bun run test

# Build for distribution
bun run build

# Check system health
bun run src/index.ts doctor
```

### iOS App

The native iOS client lives in `ios/`. It is XcodeGen-driven, so update
`ios/project.yml` when adding targets, files, packages, or plist settings, then
regenerate the Xcode project.

```bash
# Regenerate ios/hawky.xcodeproj
bun run ios:generate

# Build the app for iOS Simulator
bun run ios:build-sim

# Build, install, and launch on a connected iPhone
bun run ios:install-device
```

### Test Structure

| Command | Count | What |
|---------|-------|------|
| `bun run test` | ~2200 | Unit tests with mocks |
| `bun run test:integration` | ~55 | Integration tests |
| `cd web && bun run test` | ~190 | Web UI component tests (vitest) |
| `bun run test:e2e` | ~54 | Real API calls + gateway E2E |

Manual tests: [tests/MANUAL_TESTS.md](tests/MANUAL_TESTS.md)

## Architecture

Gateway-client architecture. The gateway is a long-lived process managing the agent, sessions, memory, and background services. All clients are thin UI layers connected via WebSocket.

```
┌──────────────────────────────────────────────────┐
│  GATEWAY (hawky gateway)                       │
│                                                  │
│  Agent loop · Sessions · Memory · Skills         │
│  Heartbeat · Cron · MCP servers · Push           │
│  Cost tracking · Compaction · Sub-agents         │
│                                                  │
│  HTTP: /health, /ready, web frontend             │
│  WebSocket: JSON-RPC for all client comms        │
└──────────────┬───────────────────────────────────┘
               │ ws://localhost:4242
     ┌─────────┼─────────┐
     │         │         │
  ┌──┴──┐  ┌──┴──┐  ┌───┴───┐
  │ TUI │  │ Web │  │Mobile │
  │(Ink)│  │(PWA)│  │(PWA)  │
  └─────┘  └─────┘  └───────┘
```

**Why this design?**
- One agent process serves all clients
- Background services (heartbeat, cron, memory consolidation) run continuously
- Sessions persist across client restarts
- Same permission UX across all clients
- Remote access: connect from any machine via `--connect ws://host:4242`

## Features

### Onboarding & Setup
- Interactive API key prompt on first gateway start (masked input)
- Agent-driven identity bootstrap (name, personality, preferences)
- `/setup` wizard: API keys, skills, heartbeat, memory warm-up
- `/doctor` CLI health check with colored output
- Chat history import from 8 platforms (ChatGPT, Claude, iMessage, Slack, WeChat, Telegram, Discord, WhatsApp)

### Agent Capabilities
- Streaming responses with thinking/extended thinking support
- Built-in tools: bash, file read/write/edit, glob, grep, web search, web fetch, memory, cron, tasks
- Sub-agent support (sync and async execution)
- MCP integration for external tool servers
- Auto-compaction: LLM-powered context summarization when approaching token limits
- Memory flush: extract durable facts from conversation to daily logs

### Skills (9 bundled)
- **commit** — guided git commit workflow
- **github** — GitHub operations via `gh` CLI
- **gog** — Google Workspace (Gmail, Calendar, Drive)
- **himalaya** — email via IMAP/SMTP
- **paper-search** — search arXiv, Semantic Scholar, DBLP
- **peekaboo** — macOS UI automation
- **slack** — Slack messaging
- **summarize** — summarize URLs, podcasts, files
- **import-history** — import chat history from external platforms

### Background Services
- **Heartbeat**: periodic background checks (email, PRs, calendar) on a configurable schedule
- **Cron**: scheduled agent tasks with persistence and run history
- **Memory consolidation**: nightly promotion of daily observations to long-term memory

### TUI
- Streaming markdown with code highlighting
- Permission prompts with approval, denial (with feedback), and persistent permissions
- Permission modes: default, accept-edits, bypass
- Tool output with structured diffs, JSON formatting, elapsed timers
- Grouped parallel tool display
- Clickable URLs (OSC 8)
- Persistent input history across sessions
- Status panel: cost tracking, usage history, error log

### Web Frontend (PWA)
- Real-time chat with streaming markdown
- KaTeX math rendering and Mermaid diagrams
- Push notifications (VAPID)
- Memory editor (workspace file browser)
- Installable as PWA on iOS/Android
- Dark mode with parchment palette

## CLI Reference

```
hawky [command] [options]

Commands:
  gateway           Start the gateway server (foreground, visible logs)
  chat              Start chat client (default, connects to existing gateway)
  doctor            Check system health (API keys, skills, config)
  logs              Tail gateway log file
  setup             Run first-time setup

Options:
  --connect <url>   Connect to gateway at URL (default: ws://localhost:4242)
  --session <key>   Session key (default: tui:main)
  --auto            Auto-start gateway in background if not running
  --model <name>    Override model for this session
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/new` | Start fresh session |
| `/resume` | Resume a previous session |
| `/model <name>` | Show or switch model |
| `/setup` | Run onboarding wizard |
| `/doctor`, `/health` | System health check |
| `/status`, `/cost` | Show cost and usage panel |
| `/usage` | Usage history (7d/30d/all) |
| `/errors` | Recent error log |
| `/skills` | List available skills |
| `/compact` | Summarize old messages to free context |
| `/mcp` | Show connected MCP servers |
| `/cron` | Manage scheduled tasks |
| `/flush` | Extract durable memories to daily log |
| `/heartbeat` | Switch to heartbeat session |
| `/mode <mode>` | Permission mode (default/accept-edits) |
| `/bypass` | Auto-approve all tools |
| `/exit` | Exit TUI |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Enter** | Send message |
| **Ctrl+J** | New line (multi-line input) |
| **↑/↓** | Navigate input history |
| **Esc** | Cancel current agent turn |
| **Ctrl+O** | Toggle compact/expanded tool output |
| **Ctrl+D** | Toggle task viewer |
| **Ctrl+C** | Exit TUI |

## Configuration

Config file: `~/.hawky/config.json` (created on first run)

```json
{
  "api_keys": {
    "anthropic": "sk-ant-...",
    "openai": "",
    "brave_search": ""
  },
  "model": "claude-sonnet-4-6",
  "gateway_port": 4242,
  "heartbeat": {
    "enabled": false,
    "interval_minutes": 30,
    "active_hours": { "start": "08:00", "end": "22:00" }
  },
  "cron": { "enabled": true }
}
```

Environment variables override config:
- `ANTHROPIC_API_KEY` — required
- `OPENAI_API_KEY` — for semantic memory search (optional)
- `BRAVE_API_KEY` — for web search (optional)
- `HAWKY_LOG_LEVEL` — log level: silent/fatal/error/warn/info/debug/trace
- `HAWKY_DEBUG` — debug flags: `gateway/*`, `agent/loop`, etc.

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── agent/                # Agent core (loop, context, streaming, compaction)
├── tools/                # Built-in tools (bash, files, web, memory, cron, agent)
├── commands/             # CLI commands (doctor)
├── gateway/              # Gateway server + client + background services
│   ├── server.ts         # Bun.serve() HTTP + WebSocket
│   ├── agent-sessions.ts # Per-session agent management
│   ├── heartbeat.ts      # Periodic background agent
│   ├── cron.ts           # Scheduled task runner
│   └── probe.ts          # Gateway health check + auto-start
├── tui/                  # Terminal UI (Ink/React)
├── mcp/                  # MCP client (server manager, tool bridge)
├── storage/              # Config, sessions, workspace, permissions
├── memory/               # Hybrid BM25 + vector search (SQLite FTS5)
├── skills/               # Skill system (loader, status, commands)
├── skill-templates/      # 9 bundled skills
├── templates/            # Workspace templates (BOOTSTRAP.md, SETUP.md, etc.)
└── logging/              # Structured logger (subsystem-tagged, rotation)

web/                      # Web frontend (React + Vite + Tailwind PWA)
tests/                    # ~2500 automated tests + manual checklist
```
