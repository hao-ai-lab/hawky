// =============================================================================
// FileIntentionStore — SQLite-backed durable IntentionStore for issue #483.
//
// Implements the IntentionStore interface exactly. Persists intentions across
// gateway restarts. Also exposes suppressed-key durability and a helper for
// timer rehydration on boot (getArmedWhenIntentions).
//
// Use InMemoryIntentionStore for tests; this class is the production default
// when AMBIENT_INTENTIONS=1 (wired in src/index.ts).
// =============================================================================

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canTransition, type Intention, type IntentionOrigin, type IntentionState, type TriggerPredicate, type TriggerTerm } from "./intention.js";
import type { IntentionQuery, IntentionStore } from "./intention-store.js";
import { clampConfidence, normalizeTopic, normalizeTrigger } from "./intention-normalize.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function initSchema(db: Database): void {
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS intentions (
      id         TEXT PRIMARY KEY,
      state      TEXT NOT NULL,
      origin     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data       TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_intentions_state  ON intentions(state)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_intentions_origin ON intentions(origin)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS suppressed_keys (
      key TEXT PRIMARY KEY
    )
  `);
}

// ---------------------------------------------------------------------------
// FileIntentionStore
// ---------------------------------------------------------------------------

export class FileIntentionStore implements IntentionStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    initSchema(this.db);
  }

  // -------------------------------------------------------------------------
  // IntentionStore interface
  // -------------------------------------------------------------------------

  async create(
    c: Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> & { state?: IntentionState },
  ): Promise<Intention> {
    const now = new Date().toISOString();
    const intention: Intention = {
      ...c,
      id: crypto.randomUUID(),
      state: c.state ?? "pending_arm",
      confidence: clampConfidence(c.confidence),
      trigger: normalizeTrigger(c.trigger),
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO intentions (id, state, origin, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)`,
      [intention.id, intention.state, intention.origin, intention.createdAt, intention.updatedAt, JSON.stringify(intention)],
    );
    return structuredClone(intention);
  }

  async get(id: string): Promise<Intention | null> {
    const row = this.db.query<{ data: string }, [string]>(
      `SELECT data FROM intentions WHERE id = ?`,
    ).get(id);
    return row ? structuredClone(JSON.parse(row.data) as Intention) : null;
  }

  async list(q?: IntentionQuery): Promise<Intention[]> {
    // Build WHERE clause from indexed columns (state, origin) for efficiency;
    // apply remaining predicates in JS (mirrors InMemoryIntentionStore).
    const conditions: string[] = [];
    const params: string[] = [];

    if (q?.state !== undefined) {
      const states = Array.isArray(q.state) ? q.state : [q.state];
      conditions.push(`state IN (${states.map(() => "?").join(",")})`);
      params.push(...states);
    }
    if (q?.origin !== undefined) {
      conditions.push(`origin = ?`);
      params.push(q.origin);
    }

    const sql = conditions.length > 0
      ? `SELECT data FROM intentions WHERE ${conditions.join(" AND ")}`
      : `SELECT data FROM intentions`;

    const rows = this.db.query<{ data: string }, string[]>(sql).all(...params);
    let results: Intention[] = rows.map((r) => JSON.parse(r.data) as Intention);

    // JS-level filters for predicates not in the schema index.
    if (q?.sessionKey !== undefined) {
      results = results.filter((c) => c.evidence.sessionKey === q.sessionKey);
    }
    if (q?.dueBefore !== undefined) {
      const cutoff = q.dueBefore;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some((t) => t.kind === "when" && t.at !== undefined && t.at <= cutoff);
      });
    }
    if (q?.place !== undefined) {
      const place = q.place;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        // #450: place filters ONLY where.place — never where.category (de-overloaded
        // to match InMemoryIntentionStore; category has its own filter below).
        return terms.some((t) => t.kind === "where" && t.place === place);
      });
    }
    if (q?.category !== undefined) {
      const category = q.category;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some((t) => t.kind === "where" && t.category === category);
      });
    }
    if (q?.topic !== undefined) {
      const topic = normalizeTopic(q.topic);
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some((t) => t.kind === "topic" && t.topic === topic);
      });
    }
    if (q?.whoEntity !== undefined) {
      const whoEntity = q.whoEntity;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some((t) => t.kind === "who" && t.entity === whoEntity);
      });
    }
    if (q?.whoScene !== undefined) {
      const whoScene = q.whoScene;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some((t) => t.kind === "who" && t.scene === whoScene);
      });
    }

    return results.map((c) => structuredClone(c));
  }

  async transition(id: string, to: IntentionState): Promise<Intention> {
    const row = this.db.query<{ data: string }, [string]>(
      `SELECT data FROM intentions WHERE id = ?`,
    ).get(id);
    if (!row) throw new Error(`Intention not found: ${id}`);
    const intention = JSON.parse(row.data) as Intention;
    if (!canTransition(intention.state, to)) {
      throw new Error(`Illegal transition: ${intention.state} → ${to}`);
    }
    const updated: Intention = { ...intention, state: to, updatedAt: new Date().toISOString() };
    this.db.run(
      `UPDATE intentions SET state = ?, updated_at = ?, data = ? WHERE id = ?`,
      [updated.state, updated.updatedAt, JSON.stringify(updated), id],
    );
    return structuredClone(updated);
  }

  async resolve(id: string): Promise<Intention> {
    return this.transition(id, "resolved");
  }

  async update(id: string, patch: { confidence?: number; trigger?: TriggerPredicate }): Promise<Intention> {
    const row = this.db.query<{ data: string }, [string]>(
      `SELECT data FROM intentions WHERE id = ?`,
    ).get(id);
    if (!row) throw new Error(`Intention not found: ${id}`);
    const intention = JSON.parse(row.data) as Intention;
    const updated: Intention = { ...intention, updatedAt: new Date().toISOString() };
    if (patch.confidence !== undefined) {
      updated.confidence = clampConfidence(patch.confidence);
    }
    if (patch.trigger !== undefined) {
      updated.trigger = normalizeTrigger(patch.trigger);
    }
    this.db.run(
      `UPDATE intentions SET updated_at = ?, data = ? WHERE id = ?`,
      [updated.updatedAt, JSON.stringify(updated), id],
    );
    return structuredClone(updated);
  }

  async prune(states: IntentionState[]): Promise<number> {
    if (states.length === 0) return 0;
    const placeholders = states.map(() => "?").join(",");
    const result = this.db.run(
      `DELETE FROM intentions WHERE state IN (${placeholders})`,
      states,
    );
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Suppressed-key durability (not on IntentionStore interface)
  // -------------------------------------------------------------------------

  /** Persist a normalized suppressed content key. Idempotent. */
  addSuppressedKey(content: string): void {
    const key = content.toLowerCase().trim();
    this.db.run(`INSERT OR IGNORE INTO suppressed_keys (key) VALUES (?)`, [key]);
  }

  /** True if the normalized key has been suppressed durably. */
  isSuppressed(content: string): boolean {
    const key = content.toLowerCase().trim();
    const row = this.db.query<{ key: string }, [string]>(
      `SELECT key FROM suppressed_keys WHERE key = ?`,
    ).get(key);
    return row !== null;
  }

  /** All durably suppressed keys (normalized). */
  getSuppressedKeys(): string[] {
    const rows = this.db.query<{ key: string }, []>(
      `SELECT key FROM suppressed_keys`,
    ).all();
    return rows.map((r) => r.key);
  }

  // -------------------------------------------------------------------------
  // Timer rehydration helper (not on IntentionStore interface)
  // -------------------------------------------------------------------------

  /**
   * Returns all armed intentions that have a provided `when.at` trigger term.
   * Used on gateway boot to re-schedule timers after a restart.
   * Excludes inferred `when` terms (provenance !== "provided") — mirrors armability rules.
   */
  async getArmedWhenIntentions(): Promise<Intention[]> {
    const rows = this.db.query<{ data: string }, [string]>(
      `SELECT data FROM intentions WHERE state = ?`,
    ).all("armed");
    const results: Intention[] = [];
    for (const r of rows) {
      const intention = JSON.parse(r.data) as Intention;
      const terms: TriggerTerm[] = intention.trigger.all ?? [];
      const hasProvidedWhenAt = terms.some(
        (t) => t.kind === "when" && t.at !== undefined && (t.provenance ?? "provided") === "provided",
      );
      if (hasProvidedWhenAt) results.push(structuredClone(intention));
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
