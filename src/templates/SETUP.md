# SETUP.md — Configuration Wizard

_The user ran `/setup`. Guide them through configuring their Hawky instance._

## Before You Start

Check the current configuration status by reading `the Hawky config file (path provided in the /setup message)`. Present a summary:

```
Current status:
  Anthropic API key:  [configured / missing]
  Brave Search key:   [configured / missing]
  OpenAI key:         [configured / missing]
  Skills:             [list enabled skills]
  Heartbeat:          [enabled (30 min) / disabled]
  Push notifications: [enabled / not configured]
  Slack:              [enabled / not configured]
```

If this is a **re-run** (config has `setup_completed_at`), say: "What would you like to reconfigure?" and let them pick sections. Don't force the full flow.

If this is **first-time setup**, walk through each section in order.

## Section 1: API Keys

For each key, check if it's already configured. If so, show "✓ configured" and ask if they want to change it. If missing, collect it.

### Choosing a provider

Before collecting the Anthropic key, ask:

> Which Claude backend do you want to use?
>   1. **Direct Anthropic API** — needs an `ANTHROPIC_API_KEY`. Default.
>   2. **Google Cloud Vertex AI** — uses GCP credits + `gcloud` auth (ADC). No API key.

- If **direct**: set `provider: "anthropic"` (or leave unset) and continue with the Anthropic key step below.
- If **Vertex**: set `provider: "vertex"` plus `vertex.project_id` (and optionally `vertex.region`, default `"global"`). Skip the Anthropic key step — direct the user to `deploy/VERTEX_SETUP.md` for one-time GCP setup (project creation, Model Garden enablement, `gcloud auth application-default login`).
- If already configured (config has `provider: "vertex"` with non-empty `project_id`), show "✓ Vertex provider active" and move on.

### Anthropic API Key (required when `provider` is `"anthropic"`)
- Already set if `api_keys.anthropic` is non-empty in config
- If missing: ask user to paste it
- Validate: use the `bash` tool to run a quick test — `curl -s -o /dev/null -w '%{http_code}' -H 'x-api-key: THE_KEY' -H 'content-type: application/json' -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' https://api.anthropic.com/v1/messages`
  - 200 = valid, 401 = invalid
- Save to config using `edit_file` on `the Hawky config file (path provided in the /setup message)` — update the `api_keys.anthropic` field

### Brave Search API Key (optional)
- Enables web search skill
- If missing, explain what they'll miss and offer to skip
- Get a free key at: https://brave.com/search/api/
- Validate: `curl -s -o /dev/null -w '%{http_code}' -H 'X-Subscription-Token: THE_KEY' 'https://api.search.brave.com/res/v1/web/search?q=test&count=1'`
  - 200 = valid, 401/403 = invalid
- Save to config: `api_keys.brave_search`

### OpenAI API Key (optional)
- Enables semantic memory search (vector embeddings). Without it, memory search uses keyword-only (BM25) — still works, just less fuzzy matching.
- Validate: `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer THE_KEY' -H 'Content-Type: application/json' -d '{"model":"text-embedding-3-small","input":"test"}' https://api.openai.com/v1/embeddings`
  - 200 = valid, 401 = invalid
- Save to config: `api_keys.openai`

### Model Selection
- Current default: whatever is in `config.model`
- Explain tradeoffs: Sonnet (fast, cheap, good for most tasks), Opus (slower, more capable, better for complex reasoning), Haiku (fastest, cheapest, good for simple tasks)
- Save to config: `model` field

## Section 2: Skills

The /setup message includes a pre-computed "Current skill status" section. Present it to the user as-is — it shows which skills are ready (✓) and which are missing (✗) with their install commands.

Ask: "Would you like to set up any of the missing skills?"

For each chosen skill:
1. Show the install command from the status report
2. Tell the user to run it in their terminal
3. Wait for them to confirm it's done
4. Verify by running the skill's verification command with `bash`:
   - **commit**: `git --version`
   - **github**: `gh auth status`
   - **gog**: `GOG_KEYRING_PASSWORD=<password> gog auth list`
   - **himalaya**: `himalaya account list`
   - **peekaboo**: `peekaboo --version`
   - **summarize**: `summarize --version`
5. If verification fails, help troubleshoot (auth needed? PATH not updated?)

Skills that require additional auth after installation:
- **github**: needs `gh auth login`
- **gog**: needs OAuth setup (see below for full details)
- **himalaya**: needs IMAP/SMTP config
- **slack**: needs Slack bot token in config

### Custom Skills

Users can create their own skills for personalized workflows (email triage, calendar briefing, domain-specific tasks). Custom skills are more personal than templates — they encode specific habits, accounts, and preferences.

Ask: "Do you have any custom skills to install? These are typically maintained in a separate git repo."

If yes:
1. Ask for the repo path (e.g., `~/projects/haoskills`)
2. List the skill directories in the repo
3. For each skill, create a symlink into `~/.hawky/skills/`:
   ```bash
   ln -sf ~/projects/haoskills/<skill-name> ~/.hawky/skills/<skill-name>
   ```
4. Verify the skill is detected: check that `/skills` shows the new skill

Custom skills in `~/.hawky/skills/` override bundled templates with the same name. They are loaded from symlinks — changes in the source repo are reflected immediately without reinstallation.

### gog — Full Setup Guide

gog requires OAuth credentials and per-account authorization. On headless servers (like Hawky's gateway), extra steps are needed because there's no local browser.

**Step 1: Import OAuth client credentials**
The user needs a Google Cloud OAuth client_secret JSON file (Desktop type). If they don't have one, guide them to create one at https://console.cloud.google.com/apis/credentials with the relevant API scopes enabled (Gmail, Calendar, Drive, etc.).

```bash
gog auth credentials /path/to/client_secret.json
```

**Step 2: Set keyring password**
On headless servers, gog uses a file-based keyring encrypted with `GOG_KEYRING_PASSWORD`. The user must pick a password and use it consistently for all gog commands. A simple password like `gog` is fine — it protects at-rest tokens, not a public service.

```bash
export GOG_KEYRING_PASSWORD=gog
```

**Save this password to MEMORY.md** so the agent can prefix it on all future gog commands.

**Step 3: Add each Google account**
Use `--manual` on headless servers (prints a URL instead of opening a browser):

```bash
GOG_KEYRING_PASSWORD=gog gog auth add user@gmail.com \
  --services gmail,calendar,drive,contacts,docs,sheets \
  --manual
```

This prints an OAuth URL. The user opens it in any browser (on their laptop is fine), authorizes, and pastes the resulting redirect URL back into the terminal.

Repeat for each Google account.

**Step 4: Verify**
```bash
GOG_KEYRING_PASSWORD=gog gog auth list
```

Should show all accounts with their authorized services.

**Troubleshooting:**
- `failed to unlock keyring` → wrong `GOG_KEYRING_PASSWORD`. Must match what was used during `gog auth add`.
- `Token has been expired or revoked` → re-run `gog auth add` for that account with the same keyring password.
- gog hangs with no output → `GOG_KEYRING_PASSWORD` not set; gog is waiting for interactive keyring input.

## Section 3: Heartbeat

The /setup message includes current heartbeat configuration status. Present it to the user.

Explain: "The heartbeat runs background checks on a schedule — scanning email, checking PRs, monitoring your calendar. It costs a small amount of API credits each run."

If heartbeat is already configured, ask if they want to change settings. If not configured:

Ask:
1. Enable heartbeat? (default: yes)
2. How often? (default: every 30 minutes)
3. Active hours? (default: 8am–10pm in local timezone)
4. Which model for the decision phase? (suggest haiku for cost savings)

Save heartbeat settings to the config file (`heartbeat` section) using `edit_file`.

Then check if HEARTBEAT.md in the workspace already has user-customized tasks (uncommented lines under "## Active Tasks"). If it does, do NOT overwrite — tell the user their existing tasks are preserved.

If HEARTBEAT.md is still the default template (all tasks commented out), generate personalized tasks based on enabled skills:
- Has gog → "Check email for urgent messages", "Review today's calendar"
- Has github → "Check PRs needing review", "Monitor CI status"
- Has paper-search → "Check arXiv for new papers in my research areas"
- Always → "Review pending tasks and commitments from MEMORY.md"

Write the updated HEARTBEAT.md to the workspace. The user can always edit it later.

## Section 4: Push Notifications

Push notifications let Hawky alert you when background tasks complete (cron jobs, heartbeat findings). They work in the browser and as a PWA on iPhone/Android.

Check if `notifications.vapid_email` is already set in the config. If configured, show "✓ Push notifications configured" and move on.

If not configured:

Ask: "Want to enable push notifications? I'll need an email address for the Web Push protocol (VAPID). This email is never shared publicly — it's only used by push service operators to contact you if there's a problem."

1. Collect their email address
2. Save to config using `edit_file`: set `notifications.vapid_email` to `"mailto:their@email.com"`
3. Explain: "Push notifications are now enabled. Open the web frontend and click the bell icon to subscribe this browser. On iPhone, install the PWA first (Add to Home Screen), then subscribe from within the app."

If they skip, explain: "You can enable push notifications later by adding `notifications.vapid_email` to your config or re-running `/setup`."

## Section 5: Slack Integration (optional)

Slack integration gives you a bidirectional bridge: DM a bot to chat with the agent, receive heartbeat/cron findings in Slack, and let the agent read or post as **you** in your channels.

Check if `channels.slack.bot_token` is already set. If configured, show "✓ Slack configured" and confirm it's working by checking `slack.status` via the RPC (or just move on).

If not configured, ask: "Do you want to enable Slack integration?"

If they say no, skip this section and note: "You can enable it later by running `/setup` again or following `deploy/SLACK_SETUP.md`."

If they say yes, explain:

> "Slack integration needs three tokens from a Slack app you create in your workspace. I'll walk you through it step by step. The full guide with a ready-made app manifest is at `deploy/SLACK_SETUP.md` — open that in a browser and follow along. Come back here when you have the three tokens."

Walk them through by pointing them to the guide sections:

1. **Create the app** — Open [api.slack.com/apps](https://api.slack.com/apps), click "Create New App" → "From an app manifest", select their workspace, and paste the YAML manifest from `deploy/SLACK_SETUP.md` (Step 1).

2. **Enable Socket Mode + generate app token** — In the app settings, "Socket Mode" → toggle on → generate token with `connections:write` scope. Token starts with `xapp-`.

3. **Install app + grab bot/user tokens** — "Install App" → install to workspace. Copy the Bot User OAuth Token (`xoxb-...`) and User OAuth Token (`xoxp-...`).

4. **Get Slack user ID** — In Slack, click avatar → Profile → three-dot menu → "Copy member ID". Starts with `U`.

Now collect the values from the user:
- `bot_token` (xoxb-...)
- `app_token` (xapp-...)
- `user_token` (xoxp-...) — optional, but recommended for skill actions
- `default_dm_user` (U...) — **required**, their Slack user ID. Without it, inbound Slack is disabled (fail-closed) so no one else in the workspace can drive their agent.
- `bind_to_session` — default `web:general` (accept the default)

Write to config using `edit_file` on the Hawky config file — set `channels.slack`:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "bot_token": "xoxb-...",
      "user_token": "xoxp-...",
      "app_token":  "xapp-...",
      "default_dm_user": "U...",
      "bind_to_session": "web:general"
    }
  }
}
```

**Important:** tell the user to restart the gateway (`bun run gateway`) for Slack to activate. After restart they should see `slack adapter started (Socket Mode)` in logs.

**Verify:** ask the user to DM their Hawky bot in Slack with a test message. The agent should respond in Slack within a few seconds, and the same conversation should appear in the bound channel (e.g., `web:general`) in the web UI.

**Troubleshooting** (point them at `deploy/SLACK_SETUP.md` "Troubleshooting"):
- `invalid_auth` → wrong token; regenerate.
- No response to DMs → check `default_dm_user` matches their actual Slack user ID.
- Responses in web UI but not Slack → expected on first interaction; the exact binding is created on first inbound DM, so it works on every subsequent message.

## Section 6: Memory Warm-Up

Offer to import context from existing sources to solve the cold-start problem. Use the `import-history` skill for structured import.

### Chat history import

**IMPORTANT: Go through EVERY platform below one by one. Do NOT skip any.** Present each as a yes/no question. The user may not think of all their messaging platforms unprompted.

Ask about each platform in order:
1. **ChatGPT** — "Do you have a ChatGPT account? I can import your conversation history from an export ZIP."
2. **Claude.ai** — "Do you use Claude.ai (the web app)? I can import from an export ZIP."
3. **iMessage** — "Do you use iMessage on your Mac? I can import using `imessage-exporter`."
4. **Slack** — "Do you use Slack? I can import via the Slack skill or an export ZIP."
5. **WeChat** — "Do you use WeChat? I can import from pre-exported text files."
6. **Telegram** — "Do you use Telegram? I can import from a Telegram Desktop export (JSON format)."
7. **Discord** — "Do you use Discord? I can import using DiscordChatExporter or pre-exported JSON."
8. **WhatsApp** — "Do you use WhatsApp? I can import from a mobile chat export (.txt)."
9. **Email** — "Do you want me to scan your recent emails? (Requires the GOG/himalaya skill)"

For each platform the user says "yes" to, follow the `import-history` skill instructions immediately before moving to the next platform. The skill handles parsing, distillation, privacy review, and saving.

For platforms the user says "no" or "skip" to, move to the next one without commentary.

### From enabled skills
If GOG or GitHub skills are ready (check the skill status in the /setup message):
- **GOG**: "Want me to scan your recent emails and calendar?"
- **GitHub**: "Want me to scan your repos and PRs?"

### Quick paste option
For users who don't want to do a full export: "You can also paste a summary. Go to ChatGPT or Claude.ai and ask it: 'List every memory and fact you have about me as a bullet list.' Then paste the result here."

### Privacy gate
ALL extracted facts must be presented for user review before saving. Nothing is written to memory without explicit approval.

## Section 7: Summary

After all sections are complete, show a summary:

```
Setup complete!

API Keys:     Anthropic ✓  Brave ✓  OpenAI ✗ (optional)
Skills:       commit ✓  github ✓  paper-search ✓  gog ✓
Heartbeat:    Enabled (every 30 min, 8am–10pm)
Slack:        Enabled (bot + user tokens, bound to web:general)
Notifications: Push enabled (click bell icon in web to subscribe)
Memory:       12 facts imported

Try these:
  "Check my email for anything urgent"
  "What PRs need my review?"
  "Search for recent papers on LLM agents"

Useful commands:
  /skills     — see all available skills
  /cron       — manage scheduled tasks
  /heartbeat  — trigger heartbeat manually
  /doctor     — check system health
  /setup      — reconfigure anytime
```

Then update `the Hawky config file (path provided in the /setup message)`: set `setup_completed_at` to the current ISO timestamp.

---

_Each section is independently skippable. If the user says "skip" at any point, move to the next section. Be conversational, not robotic — adapt to their responses._
