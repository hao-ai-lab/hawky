---
name: import-history
description: Import chat history from ChatGPT, Claude.ai, iMessage, Slack, WeChat, Telegram, Discord, or WhatsApp into Hawky memory
metadata: '{"hawky":{"emoji":"📥","always":true}}'
user-invocable: true
---

# import-history — Chat History Import

Import conversations from external platforms into Hawky's memory system. Each platform has a different export mechanism, but they all feed into the same distillation pipeline.

## How to Use

**Step 1: Ask which platforms the user uses.**

Present the full list and ask them to pick which ones they want to import from:

```
Which platforms do you want to import history from? Pick all that apply:

  1. ChatGPT        (needs export ZIP)
  2. Claude.ai      (needs export ZIP)
  3. iMessage        (needs imessage-exporter CLI)
  4. Slack           (needs Slack skill or export ZIP)
  5. WeChat          (needs pre-exported files)
  6. Telegram        (needs Telegram Desktop export)
  7. Discord         (needs DiscordChatExporter CLI)
  8. WhatsApp        (needs mobile chat export)
```

**Step 2:** For each selected platform, follow its section below in order. Skip platforms the user didn't select.

## Platform: ChatGPT

**Prerequisites:** User must export their data from ChatGPT first.

**Steps:**
1. Tell user: "Go to ChatGPT → Settings → Data Controls → Export Data. You'll get an email with a download link. Download the ZIP file and tell me where it is."
2. Once user provides the ZIP path, extract it:
   ```bash
   unzip -o "<zip_path>" -d /tmp/chatgpt-import
   ```
3. Run the flatten helper to convert the tree-structured JSON to simple JSONL:
   ```bash
   python3 "<skill_dir>/flatten_chatgpt.py" /tmp/chatgpt-import/conversations.json /tmp/chatgpt-import/flattened.jsonl
   ```
   (The `<skill_dir>` is the directory containing this SKILL.md file. Find it by searching for `flatten_chatgpt.py`.)
4. Read the flattened JSONL. Each line is: `{"title": "...", "timestamp": "...", "role": "user|assistant", "text": "..."}`
5. Proceed to the **Distillation** section below.

**If conversations.json has multiple shards** (conversations-001.json, etc.), process each one.

## Platform: Claude.ai

**Prerequisites:** User must export their data from Claude.ai first.

**Steps:**
1. Tell user: "Go to Claude.ai → Settings → Privacy → Export Data. You'll get an email with a download link."
2. Extract the ZIP:
   ```bash
   unzip -o "<zip_path>" -d /tmp/claude-import
   ```
3. **Shortcut — import memories directly:** Check if `memories.json` exists in the export. If so, read it — these are already-distilled facts that Claude stored about the user. Present them for review and save approved ones to MEMORY.md. This is the fastest path.
   ```bash
   cat /tmp/claude-import/memories.json
   ```
   Each entry has a `content` field with a fact like "User prefers dark mode" or "User works on hawky project."
4. **Full import — conversations:** Read `conversations.json` (JSON array, NOT JSONL). For each conversation, iterate `chat_messages[]`. Each message has:
   - `sender`: "human" or "assistant"
   - `content`: array of objects, collect items where `type == "text"` and join their `.text` fields
   - `created_at`: ISO 8601 timestamp
5. Proceed to the **Distillation** section below.

## Platform: iMessage

**Prerequisites:** `imessage-exporter` must be installed. Full Disk Access required for Terminal.

**Steps:**
1. Check if installed: `which imessage-exporter`
2. If not installed, tell user: `brew install imessage-exporter`
3. Ask user if they want all messages or specific contacts:
   - All: `imessage-exporter -f txt -o /tmp/imessage-export`
   - Specific contact: `imessage-exporter -f txt -t "<name or phone>" -o /tmp/imessage-export`
   - Date range: add `-s 2024-01-01 -e 2024-12-31`
4. Read the exported txt files from `/tmp/imessage-export/`. Each file is one conversation.
5. Parse each file: lines follow the pattern `[timestamp] Sender: message text`
6. Proceed to the **Distillation** section below.

**Note:** iMessage export can be LARGE (tens of thousands of messages). Suggest filtering by contact or date range to keep it manageable.

## Platform: Slack

**Two approaches:**

### If Hawky's Slack skill is configured:
1. Ask which channels to import from
2. Use the `readMessages` action with pagination to walk backwards through history
3. Collect messages with timestamps and sender names
4. Proceed to **Distillation**

### If user has a workspace export ZIP:
1. Extract the ZIP — it contains JSON files per channel per day
2. Each JSON file has an array of message objects with `user`, `text`, `ts` (timestamp)
3. User IDs need to be resolved to names (check `users.json` in the export)
4. Proceed to **Distillation**

## Platform: WeChat

**Note:** Direct WeChat database access tools have been taken down due to legal issues. This platform requires the user to pre-export their data using an external tool.

**Steps:**
1. Tell user they need to export WeChat messages first using one of:
   - **BlueMatthew/WechatExporter** (from iOS backup, outputs HTML/text)
   - Manual copy-paste from WeChat desktop
2. Once user provides the exported files (text, HTML, or JSON), read them
3. Parse messages: look for patterns of `[timestamp] sender: message` or similar
4. Proceed to **Distillation**

## Platform: Telegram

**Prerequisites:** Telegram Desktop app installed.

Telegram has the best native export of any platform — clean, complete JSON.

**Steps:**
1. Tell user: "Open Telegram Desktop → Settings → Advanced → Export Telegram Data."
2. Recommend settings: format = JSON, select which chats to include, optional date range
3. User provides the export directory path
4. Read the `result.json` file. Structure:
   ```json
   {
     "chats": {
       "list": [{
         "name": "Chat Name",
         "type": "personal_chat",
         "messages": [{
           "type": "message",
           "date": "2024-04-14T10:30:00",
           "from": "John Doe",
           "text": "Hello!"
         }]
       }]
     }
   }
   ```
5. For each chat, iterate `messages[]`. `from` is the sender name, `text` is the content (can be string or array of text entities for formatted text), `date` is ISO 8601.
6. Proceed to **Distillation**

## Platform: Discord

**Prerequisites:** `DiscordChatExporter` CLI (or user provides pre-exported JSON).

**Steps:**
1. Check if DiscordChatExporter is available. If not, tell user:
   - Docker: `docker pull tyrrrz/discordchatexporter`
   - Or download from https://github.com/Tyrrrz/DiscordChatExporter/releases
2. User needs a Discord token (bot token from Developer Portal, or user token from browser dev tools)
3. Ask which channels or DMs to export
4. Run export:
   ```bash
   docker run tyrrrz/discordchatexporter export \
     -t "TOKEN" -c CHANNEL_ID -f Json -o /tmp/discord-export/
   ```
5. Read the JSON output. Each file contains messages with `author.name`, `content`, `timestamp` fields.
6. Proceed to **Distillation**

**If user has pre-exported JSON files**, skip steps 1-4 and read them directly.

## Platform: WhatsApp

**Prerequisites:** WhatsApp mobile app.

**Steps:**
1. Tell user: "On your phone, open the chat you want to export → tap the contact/group name → scroll down → Export Chat → choose Without Media → send to yourself (email, AirDrop, etc.)."
2. The export is a `.txt` file with this format:
   ```
   [1/15/24, 3:42:10 PM] John: Hey, how are you?
   [1/15/24, 3:42:30 PM] Jane: Good! Working on the project.
   ```
3. User provides the path to the `.txt` file(s)
4. Parse each line: extract timestamp, sender, and message text. Handle multi-line messages (continuation lines don't start with `[`).
5. Proceed to **Distillation**

**Limitation:** WhatsApp mobile export caps at 40,000 messages without media. For larger histories, user can export multiple chats separately.

## Distillation Pipeline

This is the shared step for ALL platforms after messages are collected.

### Step 1: Batch by day
Group all collected messages by date (using the message timestamp). Process one day at a time.

### Step 2: Distill facts
For each day's batch of messages, extract the most important facts about the user. Focus on:
- **Recurring patterns** — regular meetings, habits, routines
- **Key contacts** — who the user communicates with frequently, their roles
- **Active projects** — what the user is working on
- **Preferences** — tools, languages, frameworks, communication style
- **Decisions** — important choices the user made
- **Deadlines and commitments** — upcoming dates, promises made
- **Personal context** — timezone, location, job role, interests

Produce 3-10 bullet points per day. Skip days with only trivial chatter.

### Step 3: Privacy gate
**CRITICAL:** Present ALL extracted facts to the user before saving ANYTHING.

Format:
```
I extracted these facts from your [platform] history:

  1. You have a lab meeting every Tuesday at 2pm
  2. Your main collaborators are Alice (ML) and Bob (frontend)
  3. You're actively working on hawky
  4. You prefer concise, direct communication
  5. Your timezone is US Pacific
  ...

Which should I save? (all / select by number / none)
```

### Step 4: Save to memory
Save approved facts to the workspace:
- **Durable facts** (preferences, contacts, recurring events) → append to `MEMORY.md`
- **Time-specific context** (project status, deadlines) → write to `memory/YYYY-MM-DD.md` daily logs
- **User profile updates** (name, role, timezone) → update `USER.md`

Avoid duplicating facts that are already in memory. Check existing MEMORY.md before adding.

### Step 5: Report
Tell the user how many facts were imported and from which platform. Suggest they can re-run this anytime with `/import_history` or during `/setup`.
