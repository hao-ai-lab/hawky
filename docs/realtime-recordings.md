# Realtime session recordings

The browser records each Start-to-Stop interaction under the configured Hawky
state directory (normally `~/.hawky`):

```text
realtime-sessions/2026-09-23T09-30-00.000Z_a1b2c3d4/
  session.json
  conversation.jsonl
  images/<sha256-of-jpeg>.jpg
```

The folder timestamp is UTC and filesystem-safe. The suffix prevents collisions.
`sessionKey` in the manifest links this live session to the continuing app thread.
`connectionId` in each event identifies one provider connection within the session.

`conversation.jsonl` is the authoritative append-only record: session lifecycle,
initial/context updates, replayed context, completed messages, tool requests and
results, sent images and provider acceptance/rejection receipts. Image events
reference `images/`; no base64 image stream is embedded in this log. Text history
also continues to populate the existing combined chat view under `sessions/`.

## Lifecycle

- Temporary provider disconnect: automatically retry up to three attempts using
  the same recording ID, with a new connection ID and explicit context replay.
- Reload/interruption: the active ID is stored in browser localStorage for this
  conversation. The call button resumes it. The old browser upload queue cannot
  be recovered, so final completeness is marked uncertain/incomplete.
- Stop: stop capture, clear the active browser ID, allow up to five seconds for
  upload queues to drain, then append `session.ended`. The final RPC itself is
  subject to the gateway client's timeout. Next Start creates a new folder.
- `session.json` status `open` means no completed end was recorded. It does not
  prove the browser is still connected. `ended` means the client reported clean
  finalization; `incomplete` means uploads/interrupted delivery/pending tools were
  known or suspected to be missing. The JSONL remains authoritative if the
  manifest update was interrupted.

## Conversation restoration

Start waits for the selected conversation's history request. A failed history
request fails startup and can be retried; it is not treated as an empty chat.
The existing replay policy remains the latest 30 user/assistant text messages,
even if the screen displays more. Images and original audio are not replayed.

The browser keeps microphone tracks disabled and blocks new conversation input
while it configures the provider with turn detection disabled. After that update
is acknowledged, it sends history items with stable IDs and waits for their
acceptance. A final acknowledged update restores the configured turn detection;
only then does the UI become connected and the microphone become active.
Restoration times out after 10 seconds with a visible retry path.

The recording distinguishes these events:

- `context.initial`: exact instructions and tools selected for this connection.
- `context.restore_started`: selected messages, before provider acceptance.
- `context.item_accepted`: a matching provider receipt for an individual item.
- `context.restored`: every history item was accepted; `context.ready` additionally
  confirms the final live settings, with elapsed startup-handshake time.
- `context.restore_failed` / `context.restore_cancelled`: incomplete restoration.

Older recordings used `context.restored` for an attempted send; that historical
event alone is not acceptance evidence. `context.ready` and item receipts mark
the new handshake. Acceptance still does not guarantee correct model recall.

## Delivery and performance limits

Stable event IDs make retry uploads idempotent. The gateway serializes log writes
per live session and flushes the log before acknowledgement. The writer assumes
one gateway process per archive root; it is not a distributed log. It retains
recent session indexes in memory (at most 128 sessions, not a hard byte limit).

The archive queue is bounded per connection: 64 requests / roughly 8 MB of counted
payload. It can drop new uploads under pressure and warns the user. It does not
have a durable browser outbox. Acceptance is client-forwarded provider evidence,
not independent backend verification and not proof an answer used an image.

Default capture is 0.2 FPS (one snapshot every five seconds); archiving follows
each sent snapshot. JPEG encoding/JSON serialization occur on the browser thread;
base64 decode/hashing use gateway CPU. There is no automatic retention/deletion.
An image can remain without a receipt; that means unconfirmed, not rejected.

Legacy `session-archives/` and existing `sessions/` files are preserved. The old
archive RPCs remain compatible. This change does not trigger memory distillation.
Browser localStorage currently shares the active recording per conversation;
use one live tab per conversation (cross-tab ownership is not yet enforced).
