// =============================================================================
// Slack Channel Adapter
//
// Bidirectional Slack integration using @slack/bolt (Socket Mode).
// Three-token model:
//   - bot_token  (xoxb-) — agent identity: send/receive DMs as bot
//   - user_token (xoxp-) — user identity: read messages, send as user
//   - app_token  (xapp-) — Socket Mode transport (no public URL)
// =============================================================================

import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createSubsystemLogger } from "../../logging/index.js";
import type { SlackRecipient } from "./slack-resolve.js";
import { SlackDirectory, type SlackDirectorySource, type SlackDirectoryMember } from "./slack-directory.js";
import type {
  ChannelAdapter,
  ChannelStatus,
  InboundMessage,
  InboundMessageHandler,
  OutboundSendResult,
} from "../channel-types.js";

export type { SlackRecipient } from "./slack-resolve.js";

const log = createSubsystemLogger("gateway/adapters/slack");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SlackAdapterOpts {
  /** Bot token (xoxb-...) — required for bot identity. */
  botToken: string;
  /** App-level token (xapp-...) — required for Socket Mode. */
  appToken: string;
  /** User token (xoxp-...) — optional, for reading/acting as user. */
  userToken?: string;
  /** Only accept DMs from this Slack user ID. If unset, accepts DMs from anyone. */
  allowedUserId?: string;
  /**
   * Footer appended to bot-identity messages posted to non-DM channels.
   * Sets expectations so other users don't expect the bot to respond.
   * If null/undefined, a sensible default is used. Pass empty string to disable.
   */
  botPostFooter?: string;
}

// -----------------------------------------------------------------------------
// Adapter
// -----------------------------------------------------------------------------

export class SlackAdapter implements ChannelAdapter {
  readonly channelId = "slack";

  /** Bolt app. Constructed lazily in start() — see the fail-soft note there. */
  private app: App | null = null;
  private botToken: string;
  private appToken: string;
  private botClient: WebClient;
  private userClient: WebClient | null;
  private allowedUserId: string | null;
  private botPostFooter: string;
  private handler: InboundMessageHandler | null = null;
  private connected = false;
  private _lastEventAt: number | null = null;
  private _lastInboundAt: number | null = null;
  private _lastOutboundAt: number | null = null;
  private _lastError: string | null = null;

  /** Cache: userId → DM channel ID. Avoids repeated conversations.open calls. */
  private dmChannelCache = new Map<string, string>();

  /** Persisted directory + relationship graph (#535). Lazily opened. */
  private directory: SlackDirectory | null = null;
  private directoryTtlMs = 30 * 60 * 1000; // 30 min: how stale before a background refresh
  private refreshing = false;

  /** Conversations where we've already auto-replied with the "bot is private" message.
   *  Keyed by Slack DM channel ID. Prevents spamming uninvited DMers. */
  private autoRepliedConversations = new Set<string>();

  constructor(opts: SlackAdapterOpts) {
    // IMPORTANT: keep this constructor free of network side effects. Bolt's
    // `new App(...)` fires `auth.test` as a floating promise (no rejection
    // handler until the first inbound event), so a dead bot token
    // (account_inactive / token_revoked / invalid_auth) becomes an unhandled
    // rejection that kills the whole gateway process. The App is therefore
    // constructed in start(), after the token has been verified in an
    // awaited, catchable path.
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;

    this.botClient = new WebClient(opts.botToken);
    this.userClient = opts.userToken ? new WebClient(opts.userToken) : null;
    this.allowedUserId = opts.allowedUserId ?? null;
    // Default footer references the allowed user so they know who to DM instead.
    // Empty string disables the footer entirely.
    this.botPostFooter = opts.botPostFooter
      ?? (this.allowedUserId
          ? `_🤖 Automated — replies are not monitored. DM <@${this.allowedUserId}> for questions._`
          : `_🤖 Automated — replies are not monitored._`);
  }

  /** Register the inbound DM handler on the (lazily constructed) bolt app. */
  private registerMessageHandler(app: App): void {
    app.message(async ({ message }) => {
      this._lastEventAt = Date.now();

      // Only process real user messages (not bot messages, not subtypes like edits/deletes)
      const msg = message as any;
      if (msg.subtype || msg.bot_id) return;

      // Only process DMs to the bot
      if (msg.channel_type !== "im") return;

      if (!msg.user || !msg.text) return;

      // Single-user gate: only accept DMs from the configured user.
      // Other users get a one-time polite auto-reply so they know the bot
      // is private — better UX than silent drop and prevents repeated
      // attempts.
      if (this.allowedUserId && msg.user !== this.allowedUserId) {
        log.debug("ignoring DM from non-allowed user", {
          sender: msg.user,
          allowed: this.allowedUserId,
        });
        void this.maybeSendRejectionReply(msg.channel).catch((err) => {
          log.warn("auto-reply to non-allowed DM failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }

      this._lastInboundAt = Date.now();

      const inbound: InboundMessage = {
        channelId: "slack",
        conversationId: msg.channel,
        threadId: msg.thread_ts,
        senderId: msg.user,
        text: msg.text,
        timestamp: msg.ts ? parseFloat(msg.ts) * 1000 : Date.now(),
        raw: message,
      };

      if (this.handler) {
        this.handler(inbound);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  /**
   * Verify the bot token, then construct + start the bolt app.
   *
   * Fail-soft contract (#20): every failure mode here — dead bot token, dead
   * app token, network — rejects this promise so the caller's guard can log
   * a warning and leave the channel disabled, instead of crashing the
   * gateway. The awaited `auth.test` below is what makes a dead bot token
   * catchable: without it, bolt's App constructor would run auth.test as a
   * floating promise and an `account_inactive` / `token_revoked` /
   * `invalid_auth` token would become an unhandled rejection that kills the
   * process. The verified bot identity is passed to the App (botId/botUserId)
   * and tokenVerificationEnabled is off, so bolt never re-runs auth.test on
   * its own.
   */
  async start(): Promise<void> {
    try {
      const auth = await this.botClient.auth.test();
      this.app = new App({
        token: this.botToken,
        appToken: this.appToken,
        socketMode: true,
        botId: auth.bot_id,
        botUserId: auth.user_id,
        tokenVerificationEnabled: false,
        // Suppress bolt's default logging — we use our own
        logLevel: "ERROR" as any,
      });
      this.registerMessageHandler(this.app);
      await this.app.start();
      this.connected = true;
      log.info("slack adapter started (Socket Mode)", { botUserId: auth.user_id });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      log.error("slack adapter start failed", { error: this._lastError });
      throw err;
    }
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  isReady(): boolean {
    return this.connected;
  }

  async sendText(opts: {
    to: string;
    text: string;
    threadId?: string;
    identity?: "bot" | "user";
  }): Promise<OutboundSendResult> {
    const client = this.resolveClient(opts.identity);
    if (!client) {
      return { ok: false, error: `no ${opts.identity ?? "bot"} token configured` };
    }

    try {
      // If target looks like a user ID, open a DM channel first
      const channel = await this.resolveChannel(opts.to, client);

      const bodyText = buildBotPostBody({
        text: opts.text,
        channel,
        identity: opts.identity ?? "bot",
        footer: this.botPostFooter,
      });

      const result = await client.chat.postMessage({
        channel,
        text: bodyText,
        thread_ts: opts.threadId,
      });

      this._lastOutboundAt = Date.now();

      return {
        ok: result.ok ?? false,
        messageId: result.ts,
        channelId: result.channel,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this._lastError = error;
      log.warn("slack sendText failed", { to: opts.to, error });
      return { ok: false, error };
    }
  }

  /**
   * Upload a file (e.g. a camera photo) to a DM or channel via files.uploadV2.
   * Resolves a user id to a DM channel the same way sendText does, so callers
   * can pass a user id, channel id, or (already-resolved) name target.
   */
  async sendFile(opts: {
    to: string;
    data: Buffer;
    filename: string;
    comment?: string;
    threadId?: string;
  }): Promise<OutboundSendResult> {
    // Files are always posted by the bot identity (user-token uploads need a
    // different scope and aren't part of this flow).
    const client = this.botClient;
    try {
      const channel = await this.resolveChannel(opts.to, client);

      // files.uploadV2 takes a Buffer/stream + filename, optionally posting an
      // initial_comment and threading via thread_ts. Slack's arg type is a
      // discriminated union on the destination (thread_ts is `never` for a
      // plain channel post), so only attach the optional keys when set.
      const uploadArgs: Record<string, unknown> = {
        channel_id: channel,
        file: opts.data,
        filename: opts.filename,
      };
      if (opts.comment) uploadArgs.initial_comment = opts.comment;
      if (opts.threadId) uploadArgs.thread_ts = opts.threadId;

      const result = (await client.files.uploadV2(
        uploadArgs as unknown as Parameters<typeof client.files.uploadV2>[0],
      )) as { ok?: boolean; files?: Array<{ id?: string }> };

      this._lastOutboundAt = Date.now();

      return {
        ok: result.ok ?? true,
        messageId: result.files?.[0]?.id,
        channelId: channel,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this._lastError = error;
      log.warn("slack sendFile failed", { to: opts.to, error });
      return { ok: false, error };
    }
  }

  // ---------------------------------------------------------------------------
  // User-token operations (for skills/heartbeat)
  // ---------------------------------------------------------------------------

  /** Read message history from a channel. Requires user_token. */
  async readChannelHistory(channel: string, limit = 20): Promise<SlackMessage[]> {
    const client = this.requireUserClient();
    const result = await client.conversations.history({ channel, limit });
    return (result.messages ?? []).map(normalizeMessage);
  }

  /** Read DM history with a specific user. Requires user_token. */
  async readDMs(userId: string, limit = 20): Promise<SlackMessage[]> {
    const client = this.requireUserClient();
    const dmChannel = await this.resolveChannel(userId, client);
    const result = await client.conversations.history({ channel: dmChannel, limit });
    return (result.messages ?? []).map(normalizeMessage);
  }

  /** List channels the user is in. Requires user_token. */
  async listChannels(): Promise<{ id: string; name: string }[]> {
    const client = this.requireUserClient();
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      limit: 200,
    });
    return (result.channels ?? []).map((c: any) => ({
      id: c.id ?? "",
      name: c.name ?? "",
    }));
  }

  /** Search messages across workspace. Requires user_token. */
  async searchMessages(query: string, count = 20): Promise<SlackMessage[]> {
    const client = this.requireUserClient();
    const result = await client.search.messages({ query, count });
    return ((result.messages as any)?.matches ?? []).map(normalizeMessage);
  }

  /** Whether a user token is configured. */
  hasUserToken(): boolean {
    return this.userClient !== null;
  }

  /**
   * The default recipient for proactive sends — the configured `default_dm_user`
   * (your own DM). Used by send_photo when the agent doesn't name a destination.
   */
  getDefaultRecipient(): string | null {
    return this.allowedUserId;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  getStatus(): ChannelStatus {
    return {
      channelId: "slack",
      connected: this.connected,
      lastEventAt: this._lastEventAt ?? undefined,
      lastInboundAt: this._lastInboundAt ?? undefined,
      lastOutboundAt: this._lastOutboundAt ?? undefined,
      lastError: this._lastError ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async stop(): Promise<void> {
    this.connected = false;
    if (!this.app) return; // start() never succeeded — nothing to stop
    try {
      await this.app.stop();
      log.info("slack adapter stopped");
    } catch (err) {
      log.warn("slack adapter stop error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private resolveClient(identity?: "bot" | "user"): WebClient | null {
    if (identity === "user") return this.userClient;
    return this.botClient;
  }

  private requireUserClient(): WebClient {
    if (!this.userClient) {
      throw new Error("Slack user token not configured — cannot perform user-identity operations");
    }
    return this.userClient;
  }

  /**
   * Send a one-time "this bot is private" reply to a non-allowed DMer.
   * Uses a per-conversation flag so a persistent pest can't spam us into
   * re-sending. The check-and-set is synchronous within JS event-loop
   * semantics, so concurrent inbound messages from the same conversation
   * can't double-trigger the reply.
   */
  private async maybeSendRejectionReply(channel: string): Promise<void> {
    if (this.autoRepliedConversations.has(channel)) return;
    this.autoRepliedConversations.add(channel);

    try {
      await this.botClient.chat.postMessage({
        channel,
        text: buildRejectionReplyText(this.allowedUserId),
      });
    } catch (err) {
      // On failure, clear the flag so we can retry on the next inbound
      // (non-idempotent API errors, rate-limit, etc. shouldn't permanently
      // silence a legitimate user who accidentally hit a transient error).
      this.autoRepliedConversations.delete(channel);
      throw err;
    }
  }

  /**
   * Fuzzy-resolve a human name/handle to Slack user candidates. Case-insensitive
   * substring across real_name, display_name, and handle. Returns [] if none.
   * Used by send_message to turn "xinkai" into a user id (→ "Jay (Xinkai) Zou").
   */
  async resolveRecipients(query: string): Promise<SlackRecipient[]> {
    if (!query.trim()) return [];
    const dir = this.getDirectory();
    // Cold start: nothing persisted yet → do a blocking refresh so the first
    // resolve works. Otherwise serve from disk and refresh in the background
    // when stale, so sending stays fast.
    if (dir.isEmpty()) {
      await this.refreshDirectory();
    } else if (dir.isStale(this.directoryTtlMs)) {
      void this.refreshDirectory();
    }
    return dir.resolve(query);
  }

  /** Members of a channel resolved by a loose name ("ambient" → #research-…). */
  async getChannelMembersByName(name: string): Promise<SlackDirectoryMember[]> {
    const dir = this.getDirectory();
    if (dir.isEmpty()) await this.refreshDirectory();
    return dir.getMembersOfChannelName(name);
  }

  /** Lazily open the on-disk directory store. */
  private getDirectory(): SlackDirectory {
    if (!this.directory) this.directory = new SlackDirectory();
    return this.directory;
  }

  /**
   * Refresh the persisted directory (users + channels + membership) from Slack.
   * Guarded so only one refresh runs at a time. Safe to call fire-and-forget.
   */
  async refreshDirectory(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.getDirectory().refresh(this.directorySource());
    } catch (err) {
      log.warn("slack directory refresh failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.refreshing = false;
    }
  }

  /** Adapter-backed source for the directory store (paginated Slack API reads). */
  private directorySource(): SlackDirectorySource {
    const client = this.userClient ?? this.botClient;
    return {
      listUsers: async () => {
        const out: Array<{ id: string; name?: string; real_name?: string; display_name?: string; is_bot?: boolean; is_deleted?: boolean }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const resp = await client.users.list({ limit: 200, cursor });
          for (const m of resp.members ?? []) {
            if (!m.id || m.id === "USLACKBOT") continue;
            out.push({
              id: m.id,
              name: m.name ?? undefined,
              real_name: m.real_name ?? m.profile?.real_name ?? undefined,
              display_name: m.profile?.display_name ?? undefined,
              is_bot: !!m.is_bot,
              is_deleted: !!m.deleted,
            });
          }
          cursor = resp.response_metadata?.next_cursor || undefined;
          if (!cursor) break;
        }
        return out;
      },
      listChannels: async () => {
        const out: Array<{ id: string; name: string; is_private?: boolean }> = [];
        try {
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const resp = await client.conversations.list({
              types: "public_channel,private_channel",
              exclude_archived: true,
              limit: 200,
              cursor,
            });
            for (const c of resp.channels ?? []) {
              if (!c.id || !c.name) continue;
              out.push({ id: c.id, name: c.name, is_private: !!c.is_private });
            }
            cursor = resp.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
        } catch (err) {
          log.debug("conversations.list failed (continuing without channels)", { error: err instanceof Error ? err.message : String(err) });
        }
        return out;
      },
      listChannelMembers: async (channelId: string) => {
        const out: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const resp = await client.conversations.members({ channel: channelId, limit: 200, cursor });
          for (const id of resp.members ?? []) out.push(id);
          cursor = resp.response_metadata?.next_cursor || undefined;
          if (!cursor) break;
        }
        return out;
      },
    };
  }

  /**
   * Resolve a target to a Slack channel ID. If target looks like a user ID
   * (starts with U or W), opens a DM; otherwise returns it as-is (channel ID).
   */
  private async resolveChannel(target: string, client: WebClient): Promise<string> {
    if (!target.startsWith("U") && !target.startsWith("W")) {
      return target; // Already a channel/conversation ID
    }

    // Check cache
    const cached = this.dmChannelCache.get(target);
    if (cached) return cached;

    // Open DM conversation
    const result = await client.conversations.open({ users: target });
    const channelId = result.channel?.id;
    if (!channelId) {
      throw new Error(`Failed to open DM with user ${target}`);
    }

    this.dmChannelCache.set(target, channelId);
    return channelId;
  }
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing)
// -----------------------------------------------------------------------------

/**
 * Build the final message body sent to Slack for an outbound post.
 * - Converts CommonMark → Slack mrkdwn.
 * - For bot-identity posts to non-DM channels, appends the configured
 *   footer (e.g. "Automated — replies not monitored") so other readers
 *   don't expect the bot to answer.
 *
 * A channel is considered a DM iff its Slack ID starts with 'D'.
 * Public/private channels start with 'C' or 'G'.
 */
export function buildBotPostBody(opts: {
  text: string;
  channel: string;
  identity: "bot" | "user";
  footer: string;
}): string {
  const body = toMrkdwn(opts.text);
  const isDm = opts.channel.startsWith("D");
  const shouldAppend = opts.identity === "bot" && !isDm && opts.footer.length > 0;
  return shouldAppend ? `${body}\n\n${opts.footer}` : body;
}

/**
 * Build the one-time auto-reply sent to a user who DMs the bot without
 * being the configured `default_dm_user`. Gives them a clear signal the
 * bot is private and points at the owner if one is configured.
 */
export function buildRejectionReplyText(allowedUserId: string | null): string {
  const suffix = allowedUserId
    ? ` Please message <@${allowedUserId}> directly instead.`
    : "";
  return `This is a private assistant bot and doesn't process DMs from other users.${suffix}`;
}

// -----------------------------------------------------------------------------
// Shared types for user-token operations
// -----------------------------------------------------------------------------

export interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  type?: string;
}

function normalizeMessage(msg: any): SlackMessage {
  return {
    ts: msg.ts ?? "",
    user: msg.user,
    text: msg.text,
    type: msg.type,
  };
}

// -----------------------------------------------------------------------------
// CommonMark → Slack mrkdwn converter
// -----------------------------------------------------------------------------

/**
 * Convert CommonMark/GitHub-flavored markdown to Slack's mrkdwn dialect.
 *
 * Slack differs from standard markdown in ways that matter for readability:
 *   **bold**   → *bold*            (double → single asterisk)
 *   *italic*   → _italic_          (asterisk → underscore)
 *   ~~strike~~ → ~strike~          (double → single tilde)
 *   [text](u)  → <u|text>
 *   # Heading  → *Heading*         (no native headings; use bold + blank line)
 *
 * We preserve:
 *   `inline code`
 *   ```code blocks```
 *   - bullet lists (mostly compatible)
 *   1. ordered lists
 *   > blockquotes
 *
 * This isn't a full CommonMark parser — it's a pragmatic regex pass that
 * covers the common cases the agent produces. It protects code fences and
 * inline code from being rewritten (those contain arbitrary characters).
 */
export function toMrkdwn(text: string): string {
  if (!text) return text;

  // Extract and stash fenced code blocks and inline code so we don't rewrite
  // their contents. Placeholders use a rare Unicode private-use char so they
  // can't collide with user content.
  const stashed: string[] = [];
  const PLACEHOLDER = "\uE000";
  const stash = (s: string) => {
    stashed.push(s);
    return `${PLACEHOLDER}${stashed.length - 1}${PLACEHOLDER}`;
  };

  let out = text;

  // Fenced code blocks: ``` ... ```  (both ``` and ~~~ variants)
  out = out.replace(/```[\s\S]*?```/g, (m) => stash(m));
  out = out.replace(/~~~[\s\S]*?~~~/g, (m) => stash(m.replace(/^~~~/g, "```").replace(/~~~$/g, "```")));

  // Inline code: `...`
  out = out.replace(/`[^`\n]+`/g, (m) => stash(m));

  // Links: [text](url)  →  <url|text>
  //        [text](<url>) form isn't common; skip for simplicity.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `<${url}|${text}>`);

  // Strikethrough: ~~text~~  →  ~text~
  out = out.replace(/~~([^~\n]+)~~/g, "~$1~");

  // Bold: **text**  →  stashed *text*  (stash so the italic pass doesn't
  // re-match the single-asterisk bold output and convert it to _text_).
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner) => stash(`*${inner}*`));

  // Italic: *text*  →  _text_
  // Slack's native italic is _text_. Plain *text* would render as bold in
  // mrkdwn, which would misrepresent italics — so we translate to _text_.
  // Require non-whitespace on both sides so list bullets aren't caught.
  out = out.replace(/(^|[\s(])\*(\S[^*\n]*?\S|\S)\*(?=[\s).,!?:;]|$)/g, "$1_$2_");

  // Headings: # …  →  *…*  (mrkdwn has no headings; use bold for emphasis).
  // Use [ \t] (not \s) for trailing whitespace so we don't eat the newline.
  out = out.replace(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm, (_m, _hashes, txt) => `*${txt}*`);

  // Restore stashed code.
  out = out.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"), (_m, idx) => stashed[Number(idx)]!);

  return out;
}
