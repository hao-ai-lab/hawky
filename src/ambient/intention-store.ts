// =============================================================================
// IntentionStore — store interface + thin in-memory impl for tests and as default
// until M2 file/db implementation.
// =============================================================================

import { canTransition, type Intention, type IntentionOrigin, type IntentionState, type TriggerPredicate, type TriggerTerm } from "./intention.js";
import { clampConfidence, normalizeTopic, normalizeTrigger } from "./intention-normalize.js";

export interface IntentionQuery {
  /** Match a single state, or any of several states. */
  state?: IntentionState | IntentionState[];
  /** Match intentions whose evidence.sessionKey equals this value. */
  sessionKey?: string;
  dueBefore?: string;
  /** place matches only where.place */
  place?: string;
  /** category matches only where.category */
  category?: string;
  origin?: IntentionOrigin;
  /** matches a topic term whose topic (normalized) equals this value */
  topic?: string;
  /** matches a who term whose entity equals this value */
  whoEntity?: string;
  /** matches a who term whose scene equals this value */
  whoScene?: string;
}

export interface IntentionStore {
  create(c: Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> & { state?: IntentionState }): Promise<Intention>;
  get(id: string): Promise<Intention | null>;
  list(q?: IntentionQuery): Promise<Intention[]>;
  /** Enforces canTransition; throws if illegal */
  transition(id: string, to: IntentionState): Promise<Intention>;
  /** Transitions to "resolved" */
  resolve(id: string): Promise<Intention>;
  /** Updates confidence and/or trigger; throws if not found. Clamps confidence to [0,1]. */
  update(id: string, patch: { confidence?: number; trigger?: TriggerPredicate }): Promise<Intention>;
  /** Optional: remove intentions in the given (terminal) states; returns count removed. */
  prune?(states: IntentionState[]): Promise<number>;
}

// -----------------------------------------------------------------------------
// Minimal in-memory implementation (tests + default until M2)
// -----------------------------------------------------------------------------

let _nextId = 1;
function newId(): string {
  return `intention_${_nextId++}`;
}

export class InMemoryIntentionStore implements IntentionStore {
  private store = new Map<string, Intention>();

  async create(
    c: Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> & { state?: IntentionState },
  ): Promise<Intention> {
    const now = new Date().toISOString();
    const intention: Intention = {
      ...c,
      id: newId(),
      state: c.state ?? "pending_arm",
      confidence: clampConfidence(c.confidence),
      trigger: normalizeTrigger(c.trigger),
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(intention.id, structuredClone(intention));
    return structuredClone(intention);
  }

  async get(id: string): Promise<Intention | null> {
    const intention = this.store.get(id);
    return intention ? structuredClone(intention) : null;
  }

  async list(q?: IntentionQuery): Promise<Intention[]> {
    let results = Array.from(this.store.values());
    if (q?.state !== undefined) {
      const states = Array.isArray(q.state) ? q.state : [q.state];
      results = results.filter((c) => states.includes(c.state));
    }
    if (q?.sessionKey !== undefined) {
      results = results.filter((c) => c.evidence.sessionKey === q.sessionKey);
    }
    if (q?.origin !== undefined) results = results.filter((c) => c.origin === q.origin);
    if (q?.dueBefore !== undefined) {
      const cutoff = q.dueBefore;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some(
          (t) => t.kind === "when" && t.at !== undefined && t.at <= cutoff,
        );
      });
    }
    if (q?.place !== undefined) {
      const place = q.place;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some(
          (t) => t.kind === "where" && t.place === place,
        );
      });
    }
    if (q?.category !== undefined) {
      const category = q.category;
      results = results.filter((c) => {
        const terms: TriggerTerm[] = c.trigger.all ?? [];
        return terms.some(
          // category matches only where.category
          (t) => t.kind === "where" && t.category === category,
        );
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
    const intention = this.store.get(id);
    if (!intention) throw new Error(`Intention not found: ${id}`);
    if (!canTransition(intention.state, to)) {
      throw new Error(`Illegal transition: ${intention.state} → ${to}`);
    }
    const updated: Intention = { ...intention, state: to, updatedAt: new Date().toISOString() };
    this.store.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async resolve(id: string): Promise<Intention> {
    return this.transition(id, "resolved");
  }

  async update(id: string, patch: { confidence?: number; trigger?: TriggerPredicate }): Promise<Intention> {
    const intention = this.store.get(id);
    if (!intention) throw new Error(`Intention not found: ${id}`);
    const updated: Intention = {
      ...intention,
      updatedAt: new Date().toISOString(),
    };
    if (patch.confidence !== undefined) {
      updated.confidence = clampConfidence(patch.confidence);
    }
    if (patch.trigger !== undefined) {
      updated.trigger = normalizeTrigger(patch.trigger);
    }
    this.store.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async prune(states: IntentionState[]): Promise<number> {
    const drop = new Set(states);
    let removed = 0;
    for (const [id, intention] of this.store) {
      if (drop.has(intention.state)) {
        this.store.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
