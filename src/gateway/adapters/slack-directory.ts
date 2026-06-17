// =============================================================================
// Slack directory + relationship graph (#535)
//
// Persists the Slack workspace directory — users, channels, and user↔channel
// membership — to SQLite at ~/.hawky/state/slack-directory.db, so recipient
// resolution and "who's in #x" / "my team" queries read a local graph instead
// of hammering the Slack API on every send. Matching/ranking is delegated to
// slack-resolve.ts (so pinyin + ranking stay in one place); this module owns
// persistence, refresh, and graph lookups.
//
// Mirrors the house SQLite conventions in src/memory/ (bun:sqlite, state dir,
// CREATE TABLE IF NOT EXISTS, meta key-value, INSERT OR REPLACE).
// =============================================================================

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSubsystemLogger } from "../../logging/index.js";
import { rankRecipients, type SlackRecipient, type SlackDirectoryEntry } from "./slack-resolve.js";

const log = createSubsystemLogger("gateway/slack-directory");

/** Minimal shape of the Slack source we read from (the adapter passes its WebClient). */
export interface SlackDirectorySource {
  listUsers(): Promise<Array<{
    id: string;
    name?: string;
    real_name?: string;
    display_name?: string;
    is_bot?: boolean;
    is_deleted?: boolean;
  }>>;
  listChannels(): Promise<Array<{ id: string; name: string; is_private?: boolean }>>;
  /** Member user-ids of a channel (paginated upstream). */
  listChannelMembers(channelId: string): Promise<string[]>;
}

export interface SlackDirectoryMember {
  id: string;
  label: string;
  handle?: string;
}

const DEFAULT_DB_PATH = join(homedir(), ".hawky", "state", "slack-directory.db");

export class SlackDirectory {
  private db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ":memory:") {
      mkdirSync(join(dbPath, ".."), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_users (
        user_id TEXT PRIMARY KEY,
        name TEXT,
        real_name TEXT,
        display_name TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_channels (
        channel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_channel_members (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_scm_user ON slack_channel_members(user_id)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slack_directory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  // --- meta -----------------------------------------------------------------

  private setMeta(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO slack_directory_meta (key, value) VALUES (?, ?)", [key, value]);
  }

  private getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM slack_directory_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  /** Epoch ms of the last successful refresh, or null if never refreshed. */
  lastRefreshedAt(): number | null {
    const v = this.getMeta("last_refreshed_at");
    return v ? Number(v) : null;
  }

  /** True iff the directory has no users (never populated). */
  isEmpty(): boolean {
    const row = this.db.query("SELECT COUNT(*) AS n FROM slack_users").get() as { n: number };
    return (row?.n ?? 0) === 0;
  }

  /** True iff older than `ttlMs` (or never refreshed). */
  isStale(ttlMs: number): boolean {
    const last = this.lastRefreshedAt();
    return last === null || Date.now() - last > ttlMs;
  }

  // --- refresh --------------------------------------------------------------

  /**
   * Pull users + channels + membership from the source and replace the cached
   * graph in one transaction. `includeMembers` can be disabled to skip the
   * per-channel conversations.members calls (faster, no graph edges).
   */
  async refresh(source: SlackDirectorySource, opts: { includeMembers?: boolean } = {}): Promise<{ users: number; channels: number; edges: number }> {
    const includeMembers = opts.includeMembers !== false;
    const users = await source.listUsers();
    const channels = await source.listChannels();

    let edges = 0;
    const memberMap = new Map<string, string[]>();
    const failedMemberChannelIds = new Set<string>();
    if (includeMembers) {
      for (const ch of channels) {
        try {
          const members = await source.listChannelMembers(ch.id);
          memberMap.set(ch.id, members);
          edges += members.length;
        } catch (err) {
          failedMemberChannelIds.add(ch.id);
          log.debug("conversations.members failed (skipping channel)", {
            channel: ch.id, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM slack_users");
      this.db.run("DELETE FROM slack_channels");

      const insUser = this.db.prepare(
        "INSERT OR REPLACE INTO slack_users (user_id, name, real_name, display_name, is_bot, is_deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const u of users) {
        insUser.run(u.id, u.name ?? null, u.real_name ?? null, u.display_name ?? null, u.is_bot ? 1 : 0, u.is_deleted ? 1 : 0, now);
      }
      const insCh = this.db.prepare(
        "INSERT OR REPLACE INTO slack_channels (channel_id, name, is_private, updated_at) VALUES (?, ?, ?, ?)",
      );
      for (const c of channels) {
        insCh.run(c.id, c.name, c.is_private ? 1 : 0, now);
      }

      if (!includeMembers) {
        this.db.run("DELETE FROM slack_channel_members");
      } else {
        const channelIds = channels.map((c) => c.id);
        if (channelIds.length > 0) {
          const placeholders = channelIds.map(() => "?").join(", ");
          this.db.run(`DELETE FROM slack_channel_members WHERE channel_id NOT IN (${placeholders})`, channelIds);
        } else {
          this.db.run("DELETE FROM slack_channel_members");
        }

        const delMem = this.db.prepare("DELETE FROM slack_channel_members WHERE channel_id = ?");
        for (const channelId of memberMap.keys()) {
          delMem.run(channelId);
        }
      }

      const insMem = this.db.prepare(
        "INSERT OR REPLACE INTO slack_channel_members (channel_id, user_id) VALUES (?, ?)",
      );
      for (const [channelId, memberIds] of memberMap) {
        for (const uid of memberIds) insMem.run(channelId, uid);
      }
    });
    tx();
    if (failedMemberChannelIds.size === 0) {
      this.setMeta("last_refreshed_at", String(now));
    }
    log.info("slack directory refreshed", {
      users: users.length,
      channels: channels.length,
      edges,
      membershipFailures: failedMemberChannelIds.size,
    });
    return { users: users.length, channels: channels.length, edges };
  }

  // --- resolution -----------------------------------------------------------

  /** All directory entries (users + channels) as matchable rows. */
  private entries(): SlackDirectoryEntry[] {
    const out: SlackDirectoryEntry[] = [];
    const users = this.db.query(
      "SELECT user_id, name, real_name, display_name FROM slack_users WHERE is_deleted = 0 AND is_bot = 0",
    ).all() as Array<{ user_id: string; name: string | null; real_name: string | null; display_name: string | null }>;
    for (const u of users) {
      const aliases = [u.real_name, u.display_name].filter((x): x is string => !!x);
      out.push({
        id: u.user_id,
        kind: "user",
        handle: u.name ?? undefined,
        label: u.real_name || u.display_name || u.name || u.user_id,
        aliases,
      });
    }
    const channels = this.db.query("SELECT channel_id, name FROM slack_channels").all() as Array<{ channel_id: string; name: string }>;
    for (const c of channels) {
      out.push({ id: c.channel_id, kind: "channel", handle: c.name, label: c.name });
    }
    return out;
  }

  /** Rank a free-text query against the persisted directory. */
  resolve(query: string): SlackRecipient[] {
    if (!query.trim()) return [];
    return rankRecipients(query, this.entries());
  }

  // --- graph lookups --------------------------------------------------------

  /** Members of a channel (by channel id). */
  getChannelMembers(channelId: string): SlackDirectoryMember[] {
    const rows = this.db.query(`
      SELECT u.user_id AS id, u.name AS handle, u.real_name AS real, u.display_name AS disp
      FROM slack_channel_members m
      JOIN slack_users u ON u.user_id = m.user_id
      WHERE m.channel_id = ? AND u.is_deleted = 0 AND u.is_bot = 0
    `).all(channelId) as Array<{ id: string; handle: string | null; real: string | null; disp: string | null }>;
    return rows.map((r) => ({ id: r.id, label: r.real || r.disp || r.handle || r.id, handle: r.handle ?? undefined }));
  }

  /** Resolve a channel name to its id (best match), or null. */
  resolveChannelId(name: string): string | null {
    const hit = this.resolve(name).find((r) => r.kind === "channel");
    return hit?.id ?? null;
  }

  /** Members of a channel looked up by a loose channel name ("research" → #research-…). */
  getMembersOfChannelName(name: string): SlackDirectoryMember[] {
    const id = this.resolveChannelId(name);
    return id ? this.getChannelMembers(id) : [];
  }

  close(): void {
    this.db.close();
  }
}
