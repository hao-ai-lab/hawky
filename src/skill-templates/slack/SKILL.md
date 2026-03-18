---
name: slack
description: Use when the user asks you to read, search, send, or react in Slack — including reading channel history, DMs, searching messages, or posting as the user. Covers "check my Slack", "reply to Alice", "what's happening in #eng", "send a message to Jane", "post in #standup as me".
metadata: { "hawky": { "emoji": "💬", "requires": { "config": ["channels.slack.user_token"] } } }
---

# Slack Actions

## Overview

Hawky's Slack integration has two sides:

1. **Gateway adapter** (automatic, handled for you): the user DMs the Hawky
   bot → messages flow into the bound session. Agent responses + heartbeat
   findings are relayed back to Slack automatically. **You don't invoke
   anything for this** — it's the always-on bridge.

2. **This skill**: for user-initiated actions like "check my Slack messages"
   or "reply to that thread as me". These use the **user token** (`xoxp-`)
   and you call the Slack Web API via `bash` + `curl`.

## When to use this skill

Use it when the user says something like:
- "Check my Slack messages in #engineering from today"
- "What's in my DMs?"
- "Search Slack for 'deploy rollback'"
- "Reply to the last message from Alice in #eng saying 'on it'"
- "Send 'running 5 min late' to #standup as me"
- "React with ✅ to that message"

Do **not** use this skill for:
- Responding to a DM the user sent to the bot → the gateway relays that
  automatically; just respond in the chat.
- Posting a heartbeat or cron finding → that's `delivery: { mode: "announce" }`
  in the job/heartbeat config.

## Prerequisites

- `channels.slack.user_token` is set in `~/.hawky/config.json`.
  If missing, tell the user: "Slack skill needs a user token. Add
  `channels.slack.user_token` to your config or re-run `/setup`."

### Required user token scopes

The `xoxp-` user token needs these OAuth scopes:

| Scope | Used for |
|-------|----------|
| `channels:history` | Read public channel messages |
| `channels:read` | List public channels |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DM messages |
| `im:read` | List DM conversations |
| `mpim:history` | Read group DM messages |
| `mpim:read` | List group DM conversations |
| `chat:write` | Send/edit/delete messages as the user |
| `reactions:write` | Add/remove reactions |
| `search:read` | Search messages |
| `users:read` | Resolve user names to IDs |

Optional (for opening new DMs):

| Scope | Used for |
|-------|----------|
| `im:write` | Open a new DM with `conversations.open` |

## Reading the user token

Read the user token each time you need it (don't cache across sessions):

```bash
TOKEN=$(jq -r '.channels.slack.user_token // empty' ~/.hawky/config.json)
[ -z "$TOKEN" ] && echo "ERROR: user_token not configured" && exit 1
```

All subsequent `curl` calls use `Authorization: Bearer $TOKEN`.

## API endpoint pattern

All Slack Web API calls follow the same shape:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"...":"..."}' \
  https://slack.com/api/<method>
```

Responses are JSON with `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`.
Always check `ok` before using the data.

## Pagination

Many Slack API methods paginate. The response includes
`response_metadata.next_cursor` — if non-empty, there are more results.

```bash
# Generic pagination loop
CURSOR=""
while true; do
  URL="https://slack.com/api/<method>?limit=200"
  [ -n "$CURSOR" ] && URL="${URL}&cursor=${CURSOR}"
  RESP=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL")
  # ... process RESP ...
  CURSOR=$(echo "$RESP" | jq -r '.response_metadata.next_cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

Methods that commonly paginate: `conversations.list`, `users.list`,
`conversations.history`, `conversations.replies`.

For channel/user resolution, always paginate — workspaces with 100+ channels
will not return all results in a single `limit=200` call.

## Common actions

### Resolve channel name → channel ID

`#engineering` → `C01234ABCDE`. You need the ID for most other calls.

**Important:** Workspaces with many channels require pagination. A single
`limit=200` call may not return all channels.

```bash
# Paginated channel lookup
CHANNEL_NAME="engineering"
CHANNEL_ID=""
CURSOR=""
while [ -z "$CHANNEL_ID" ]; do
  URL="https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200"
  [ -n "$CURSOR" ] && URL="${URL}&cursor=${CURSOR}"
  RESP=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL")
  CHANNEL_ID=$(echo "$RESP" | jq -r --arg name "$CHANNEL_NAME" \
    '.channels[] | select(.name == $name) | .id // empty')
  CURSOR=$(echo "$RESP" | jq -r '.response_metadata.next_cursor // empty')
  [ -z "$CURSOR" ] && break
done
echo "$CHANNEL_ID"
```

### Open or find a DM by user ID

To find an existing DM, search your DM list:
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://slack.com/api/conversations.list?types=im&limit=200" \
  | jq -r --arg uid "U0ALICEID" '.channels[] | select(.user == $uid) | .id'
```

To open a new DM (requires `im:write` scope):
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"users":"U0ALICEID"}' \
  https://slack.com/api/conversations.open \
  | jq -r '.channel.id'
```

If you get `missing_scope` on `conversations.open`, fall back to the
`conversations.list` approach above. It works for any DM that already exists.

### Resolve user/channel name → ID (fuzzy)

PREFER the `send_message` tool: it already fuzzy-resolves a name/handle to a
user OR channel (substring, token, and **pinyin** matching, so "邹欣凯"/"欣凯"
match "Jay (Xinkai) Zou"; loose channel names like "ambient" match the channel),
returns candidates when ambiguous, and caches the directory. Use the raw bash
below only when you need something the tool can't do.

Match loosely: case-insensitive substring across `name` (handle),
`real_name`, and `profile.display_name`. A query like `xinkai` must match
"Jay (Xinkai) Zou". For a query in Chinese, also try its pinyin (e.g. 欣凯 →
xinkai). To resolve a channel, search `conversations.list` by `.name` the same
loose way. NEVER require an exact equality match.

```bash
# Returns every candidate as: <id>\t<real_name> (@handle) [display_name]
Q="xinkai"   # the name the user said, lowercased match
curl -s -H "Authorization: Bearer $TOKEN" https://slack.com/api/users.list \
  | jq -r --arg q "$(echo "$Q" | tr '[:upper:]' '[:lower:]')" '
      .members[]
      | select(.deleted != true)
      | { id, name, real: (.real_name // ""), disp: (.profile.display_name // "") }
      | select(
          (.name|ascii_downcase|contains($q)) or
          (.real|ascii_downcase|contains($q)) or
          (.disp|ascii_downcase|contains($q))
        )
      | "\(.id)\t\(.real) (@\(.name)) [\(.disp)]"'
```

Then decide:
- **Exactly one candidate** → use that user id (open a DM with
  `conversations.open?users=<id>` or post to it).
- **Multiple candidates** → DO NOT guess. List the matched names back to the
  user (e.g. "I found Jay (Xinkai) Zou and Xinkai Li — which one?") and send
  only after they pick.
- **No candidates** → tell the user no Slack member matched that name.

For large workspaces (1000+ members), paginate `users.list` the same way as
channels. Most workspaces under ~500 members fit in a single call.

### Read recent messages from a channel or DM

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://slack.com/api/conversations.history?channel=C01234ABCDE&limit=20" \
  | jq '.messages[] | {ts, user, text}'
```

To filter by time (e.g., today's messages only):
```bash
TODAY_EPOCH=$(date -d "$(date +%Y-%m-%d) 00:00:00" +%s)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://slack.com/api/conversations.history?channel=C01234ABCDE&oldest=$TODAY_EPOCH&limit=50" \
  | jq '.messages[] | {ts, user, text}'
```

For a threaded reply chain:
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://slack.com/api/conversations.replies?channel=C01234ABCDE&ts=1712023032.1234" \
  | jq '.messages[] | {ts, user, text}'
```

### Search across workspace

```bash
QUERY=$(jq -Rr @uri <<< "deploy rollback")
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://slack.com/api/search.messages?query=${QUERY}&count=20" \
  | jq '.messages.matches[] | {ts, channel: .channel.name, user: .username, text}'
```

Useful search modifiers:
- `in:#channel-name` — restrict to a channel
- `from:@username` — restrict to a user
- `before:2024-01-15` / `after:2024-01-01` — date range
- `has:link` / `has:reaction` — filter by content type

### Send a message (as the user)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C01234ABCDE","text":"running 5 min late"}' \
  https://slack.com/api/chat.postMessage
```

To reply in a thread, include `thread_ts`:
```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C01234ABCDE","thread_ts":"1712023032.1234","text":"on it"}' \
  https://slack.com/api/chat.postMessage
```

### Edit / delete a message

You can only edit/delete messages the user posted.

```bash
# Edit
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C...","ts":"1712...","text":"Updated text"}' \
  https://slack.com/api/chat.update

# Delete
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C...","ts":"1712..."}' \
  https://slack.com/api/chat.delete
```

### React to a message

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C...","timestamp":"1712...","name":"white_check_mark"}' \
  https://slack.com/api/reactions.add
```

Use the emoji name (no colons), e.g. `white_check_mark`, `eyes`, `+1`.

To remove a reaction:
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C...","timestamp":"1712...","name":"eyes"}' \
  https://slack.com/api/reactions.remove
```

### List your DMs (who have I been talking to)

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://slack.com/api/conversations.list?types=im&limit=50" \
  | jq '.channels[] | {id, user, last_read}'
```

## Safety rules

- **Always confirm before sending.** Draft the message text and show it to
  the user before posting. Never send on the first ask without confirmation
  — the message appears as **them**, not as a bot, so mistakes are costly.
- **Confirm before editing/deleting.** Same reasoning.
- **Don't expose the token.** Don't echo `$TOKEN` or paste it into the
  chat. Read it fresh each bash call.
- **Respect rate limits.** Slack limits apps to ~1 req/sec on most tier 2
  methods. If you get `rate_limited`, wait the `Retry-After` seconds.

## Typical flows

### "Check my Slack messages in #engineering from today"

1. `conversations.list` (paginated) → resolve `#engineering` to channel ID
2. `conversations.history` with `oldest=<today's epoch>` → last N messages
3. Resolve user IDs to names via `users.list` (cache within the turn)
4. Summarize: threads, mentions, pending replies

### "Reply to Alice's last message with 'thanks, will do'"

1. `users.list` → resolve "Alice" to `U0...`
2. Check recent conversation history with Alice — DM or shared channel?
3. Find her most recent message (by `ts`)
4. **Draft** the reply and show it to the user: `"Will send: 'thanks, will do' as a reply to Alice's 'can you review #123?' from 2:15 PM. Confirm?"`
5. On confirmation: `chat.postMessage` with `thread_ts` = Alice's message ts

### "What's happening in #standup today?"

1. Resolve `#standup` → channel ID (paginated)
2. `conversations.history` with today's oldest
3. Summarize: who posted, decisions, action items, open threads

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `missing_scope` | Token lacks a required OAuth scope | Add the scope in the Slack app settings, reinstall to workspace |
| `channel_not_found` | Wrong channel ID, or bot/user not in the channel | Verify the ID; join the channel first |
| `not_in_channel` | User token's owner hasn't joined the channel | Join via Slack UI or `conversations.join` |
| `rate_limited` | Too many requests | Wait `Retry-After` header seconds, then retry |
| `invalid_auth` | Token is expired or revoked | Regenerate the token in Slack app settings |
| `account_inactive` | Token's user has been deactivated | Use a different user's token |

## Ideas to try

- React with ✅ to mark tasks you've handled.
- Daily digest of mentions: search for `@<your-user-id>` since yesterday.
- Thread catch-up: fetch `conversations.replies` and summarize long threads.
- Draft outgoing: agent writes the message, user reviews, agent sends.
