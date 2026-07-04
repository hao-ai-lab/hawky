// =============================================================================
// LatentService — owns a LatentRecognizer, TranscriptWindows, and an
// IntentionStore. A single heartbeat loop ("distillation") drives recognition
// on a fixed interval (default 60s, configurable via LATENT_HEARTBEAT_MS).
// (M8 §3.2, §9 H1 — refactored from per-session debounce to single tick loop)
// =============================================================================

import { TranscriptWindow, type TranscriptTurn } from "./transcript-window.js";
import {
  DeterministicLatentRecognizer,
  classifySatisfaction,
  type LatentRecognizer,
} from "./latent-recognizer.js";
import { dedupAndSupersede } from "./dedup.js";
import { armIntention } from "./arming.js";
import { projectMode, type Mode } from "./modes.js";
import type { IntentionStore } from "./intention-store.js";
import { findTopicTerm } from "./intention.js";
import { DeterministicRelevanceGate, type RelevanceGate } from "./relevance-gate.js";
import { surfaceLatent } from "./fire.js";
import { makeSessionInvoker, INTENTION_SURFACE_EVENT } from "./session-delivery.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("ambient/latent-service");

export interface LatentServiceDeps {
  store: IntentionStore;
  recognizer?: LatentRecognizer;
  /** Injectable clock for tests. Default: Date.now */
  now?: () => number;
  /** Injectable tz string. Default: "UTC" */
  tz?: string;
  /** Surfacing (optional): broadcast a surface event to a session; returns # live recipients. */
  broadcast?: (sessionKey: string, event: string, payload: unknown) => number;
  /** Surfacing (optional): true if a session has a live connection. */
  hasSession?: (sessionKey: string) => boolean;
  /** Surfacing (optional): live sessions (with mode) for the surfacing pass to scan. */
  liveSessions?: () => { sessionKey: string; mode: Mode }[];
  /** Relevance gate for surfacing (default: deterministic matchLatent). Prod injects the LLM gate. */
  relevanceGate?: RelevanceGate;
  /**
   * Fix 8: Optional callback to disarm where-regions when an intention reaches a terminal state
   * (resolved/suppressed/superseded/surfaced). Called from _sweepSatisfied and _surfacingPass.
   */
  disarmWhereFn?: (intention: import("./intention.js").Intention) => Promise<void>;
}

export class LatentService {
  private readonly store: IntentionStore;
  private readonly recognizer: LatentRecognizer;
  private readonly window: TranscriptWindow;
  private readonly now: () => number;
  private readonly tz: string;
  private readonly broadcast?: LatentServiceDeps["broadcast"];
  private readonly hasSession?: LatentServiceDeps["hasSession"];
  private readonly liveSessions?: LatentServiceDeps["liveSessions"];
  private readonly relevanceGate: RelevanceGate;
  /** Per-session location context (set by M8 region-enter; consumed by the matcher). */
  private readonly sessionLocations = new Map<string, { place?: string; category?: string }>();

  /** intentionId → ts of the last scan that returned it.
   *  The poll skips ids reserved within scanReserveMs (surface-once M10). */
  private readonly scanReservations = new Map<string, number>();
  readonly scanReserveMs = 120_000;

  /** Most-recent mode per session (from the last onTranscript call). */
  private readonly sessionModes = new Map<string, Mode>();
  /** Sessions with new turns since last tick (dirty = needs recognition). */
  private readonly dirty = new Set<string>();
  /** Pending async recognition tasks (for flush/tick ordering). */
  private readonly pending = new Map<string, Promise<unknown>>();
  /**
   * Persistent in-memory suppression store: normalized content keys for
   * intentions the user has declined. Consulted before minting so suppression
   * survives prune() clearing the suppressed state from the IntentionStore.
   */
  private readonly suppressedKeys = new Set<string>();
  private readonly disarmWhereFn?: LatentServiceDeps["disarmWhereFn"];

  constructor(deps: LatentServiceDeps) {
    this.store = deps.store;
    // Default recognizer is DeterministicLatentRecognizer (keyword-based) for
    // tests/callers that omit deps.recognizer. Production injects the LLM-only
    // makeRetryingRecognizer from src/index.ts, which fails soft to no results.
    this.recognizer = deps.recognizer ?? new DeterministicLatentRecognizer();
    this.window = new TranscriptWindow();
    this.now = deps.now ?? (() => Date.now());
    this.tz = deps.tz ?? "UTC";
    this.broadcast = deps.broadcast;
    this.hasSession = deps.hasSession;
    this.liveSessions = deps.liveSessions;
    // Test-only default. Production injects the LLM gate via src/index.ts
    // (makeRelevanceGate(modelInvokeFn)); this deterministic default is never
    // used in prod and just lets tests omit a gate.
    this.relevanceGate = deps.relevanceGate ?? new DeterministicRelevanceGate();
    this.disarmWhereFn = deps.disarmWhereFn;

    // #483: if the store exposes durable suppressed keys, hydrate them on boot
    // so suppression decisions survive a gateway restart.
    if ("getSuppressedKeys" in this.store && typeof (this.store as { getSuppressedKeys?: unknown }).getSuppressedKeys === "function") {
      for (const key of (this.store as { getSuppressedKeys(): string[] }).getSuppressedKeys()) {
        this.suppressedKeys.add(key);
      }
    }
  }

  /**
   * Append a turn to the session window, record the session's current mode,
   * and mark the session dirty (new turns since last recognize).
   *
   * Recognition is NOT triggered here — the single heartbeat loop calls tick()
   * on a fixed interval to process all dirty sessions.
   */
  onTranscript(sessionKey: string, turn: TranscriptTurn, mode: Mode): void {
    this.window.append(sessionKey, turn);
    this.sessionModes.set(sessionKey, mode);
    this.dirty.add(sessionKey);
    log.debug("transcript appended", {
      sessionKey,
      role: turn.role,
      chars: turn.text.length,
      mode,
    });
  }

  /**
   * Record a declined/suppressed content key so it is never re-minted,
   * even after prune() removes the suppressed Intention from the store.
   * Call this from the decline path when a user dismisses a suggestion.
   */
  suppress(content: string): void {
    this.suppressedKeys.add(content.toLowerCase().trim());
    // #483: persist to durable store if available so suppression survives restart.
    if ("addSuppressedKey" in this.store && typeof (this.store as { addSuppressedKey?: unknown }).addSuppressedKey === "function") {
      (this.store as { addSuppressedKey(c: string): void }).addSuppressedKey(content);
    }
  }

  /**
   * True if a content key is currently suppressed. The set is hydrated from the
   * durable store on construction (#483), so this reflects suppressions made in
   * a previous gateway run. Exposed for observability + tests.
   */
  isSuppressed(content: string): boolean {
    return this.suppressedKeys.has(content.toLowerCase().trim());
  }

  /** Transcript window for a session (surfacing matcher context + M10 fetch). */
  windowFor(sessionKey: string): TranscriptTurn[] {
    return this.window.get(sessionKey);
  }

  /** Current location context for a session, if any (set by M8 region-enter). */
  locationFor(sessionKey: string): { place?: string; category?: string } | undefined {
    return this.sessionLocations.get(sessionKey);
  }

  /** Set the session's location context (called on a region-enter event in M8). */
  setLocation(sessionKey: string, location: { place?: string; category?: string }): void {
    this.sessionLocations.set(sessionKey, location);
  }

  /** The relevance gate used by the surfacing poll (production LLM-primary, fail-soft).
   *  Exposed so scanLatent (M10) reuses the SAME gate instance. */
  get surfacingGate(): RelevanceGate {
    return this.relevanceGate;
  }

  /** Build a RelevanceInput-compatible {now, tz} snapshot using this service's
   *  injected clock — so scan and poll always agree on the timestamp. */
  buildScanInput(sessionKey: string): { window: import("./transcript-window.js").TranscriptTurn[]; now: number; tz: string; location: { place?: string; category?: string } | undefined } {
    return {
      window: this.window.get(sessionKey),
      now: this.now(),
      tz: this.tz,
      location: this.sessionLocations.get(sessionKey),
    };
  }

  /** Reserve ids a scan just returned so the poll won't double-surface them (M10).
   *  Refresh policy: sets the timestamp if ABSENT or EXPIRED; does NOT update while
   *  _reservedRecently is true — prevents repeated scans from extending the window. */
  markScanned(ids: string[]): void {
    const t = this.now();
    for (const id of ids) {
      if (!this._reservedRecently(id)) {
        this.scanReservations.set(id, t);
      }
    }
    // Prune expired entries opportunistically.
    for (const [k, v] of this.scanReservations) {
      if (t - v >= this.scanReserveMs) this.scanReservations.delete(k);
    }
  }

  /** True if id was scanned within the reservation window (poll should skip it). */
  wasScannedRecently(id: string): boolean {
    return this._reservedRecently(id);
  }

  /** Test/internal alias for the scan reservation check. */
  _reservedRecently(id: string): boolean {
    const t = this.scanReservations.get(id);
    return t !== undefined && this.now() - t < this.scanReserveMs;
  }

  /**
   * Single heartbeat tick — processes all dirty sessions.
   *
   * For each dirty session:
   * - If the session's mode has latentIntentionEnabled: run recognition.
   * - If quiet: clear dirty without recognizing.
   *
   * Called by the single setInterval loop in src/index.ts. Also callable
   * from tests directly (replaces the per-session flush/debounce approach).
   */
  async tick(): Promise<void> {
    // Pass 1 — recognition (sweep satisfied/cancelled armed latents, then mint) over dirty sessions.
    const sessions = [...this.dirty];
    this.dirty.clear();
    const mintedThisTick = new Set<string>();

    await Promise.all(
      sessions.map((sessionKey) => {
        const mode = this.sessionModes.get(sessionKey) ?? "quiet";
        if (!projectMode(mode).latentIntentionEnabled) {
          // Quiet session: dirty cleared, no recognition.
          return Promise.resolve();
        }
        const p = (async () => {
          await this._sweepSatisfied(sessionKey);
          const ids = await this._runRecognize(sessionKey, mode);
          for (const id of ids) mintedThisTick.add(id);
        })().catch(() => {});
        this.pending.set(sessionKey, p);
        return p.finally(() => {
          if (this.pending.get(sessionKey) === p) this.pending.delete(sessionKey);
        });
      }),
    );

    // Pass 2 — surfacing over live non-quiet sessions (skips this tick's fresh mints).
    await this._surfacingPass(mintedThisTick);
  }

  /**
   * Synchronous flush for tests: mark the session dirty if it has turns,
   * call tick() for that session only, and wait for recognition to settle.
   *
   * This replaces the old debounce-timer flush() pattern. Tests that call
   * onTranscript(...) then flush(sessionKey) get the same behavior as before:
   * recognition runs and the store is populated.
   */
  async flush(sessionKey: string): Promise<void> {
    // If there's an in-flight recognition, wait for it first.
    const inFlight = this.pending.get(sessionKey);
    if (inFlight) {
      await inFlight;
      return;
    }

    // If the session is dirty (has new turns), run recognition now.
    if (this.dirty.has(sessionKey)) {
      this.dirty.delete(sessionKey);
      const mode = this.sessionModes.get(sessionKey) ?? "quiet";
      if (projectMode(mode).latentIntentionEnabled) {
        const p = this._runRecognize(sessionKey, mode).catch(() => {});
        this.pending.set(sessionKey, p);
        await p;
        this.pending.delete(sessionKey);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * M9 satisfaction sweep: for each armed latent in this (dirty) session, if a
   * recent user turn satisfies or cancels its topic, retire it so it never
   * surfaces — satisfied → resolved; cancelled → suppressed (+ suppress() so it
   * survives prune and is never re-minted). Topic-scoped (classifySatisfaction),
   * so a bare "never mind" cannot retire unrelated armed latents. dedup alone
   * does not clean active armed latents, so this is the only path that does.
   */
  private async _sweepSatisfied(sessionKey: string): Promise<void> {
    const window = this.window.get(sessionKey);
    if (window.length === 0) return;
    // Global set: a need satisfied in session B must resolve the shared intention,
    // not just session B's view. (M10 §6 — drop the sessionKey filter.)
    const armed = await this.store.list({ state: "armed", origin: "latent" });
    for (const intent of armed) {
      for (const turn of window) {
        if (turn.role !== "user") continue;
        // A strictly-earlier turn cannot satisfy/cancel a later need — a prior
        // "we bought coffee" must not retire a later "we're out of coffee".
        // (Same-ts turns are kept: they're same-batch and ordering is undefined.)
        if (turn.ts < intent.evidence.ts) continue;
        // Match on the intention's normalized TOPIC (falls back to content) so a
        // coarser topic like "coffee" still resolves on "bought coffee", while a
        // different item sharing only a head noun ("almond milk" vs "oat milk")
        // does not falsely retire this reminder.
        const itemPhrase = findTopicTerm(intent.trigger)?.topic ?? intent.content;
        const kind = classifySatisfaction(itemPhrase, turn.text);
        if (kind === "cancelled") {
          this.suppress(intent.content);
          try { await this.store.transition(intent.id, "suppressed"); } catch { /* already moved */ }
          // Fix 8: disarm where-regions on terminal transitions.
          if (this.disarmWhereFn) await this.disarmWhereFn(intent).catch(() => {});
          break;
        }
        if (kind === "satisfied") {
          try { await this.store.transition(intent.id, "resolved"); } catch { /* already moved */ }
          // Fix 8: disarm where-regions on terminal transitions.
          if (this.disarmWhereFn) await this.disarmWhereFn(intent).catch(() => {});
          break;
        }
      }
    }
  }

  private async _runRecognize(sessionKey: string, mode: Mode): Promise<string[]> {
    if (!projectMode(mode).latentIntentionEnabled) return [];
    const window = this.window.get(sessionKey);
    if (window.length === 0) return [];

    // Fix(M8 #3): list ALL active intentions (both origins) so obvious-origin
    // items block latent duplicates. Only pass latent-origin to the recognizer
    // for its own context.
    const allIntentions = await this.store.list({});
    const recentIntentions = allIntentions.filter((i) => i.origin === "latent");

    const minted = await this.recognizer.recognize({
      window,
      recentIntentions,
      now: this.now(),
      tz: this.tz,
    });

    if (minted.length === 0) {
      log.debug("latent: recognizer minted nothing for window", {
        sessionKey,
        windowTurns: window.length,
        mode,
      });
      return [];
    }
    // Privacy (#484): count only — never log raw minted need content.
    log.info("latent: recognizer minted candidate(s)", {
      sessionKey,
      count: minted.length,
    });

    // Fix(M8 #1): pass persistent suppressedKeys so suppression survives prune().
    const { create, supersede } = dedupAndSupersede(minted, allIntentions, this.suppressedKeys);

    // Supersede stale intentions first.
    for (const { id } of supersede) {
      try {
        await this.store.transition(id, "superseded");
        // Fix 3b: disarm where-regions on supersession.
        if (this.disarmWhereFn) {
          const superseded = await this.store.get(id);
          if (superseded) await this.disarmWhereFn(superseded).catch(() => {});
        }
      } catch {
        // If it already transitioned, skip.
      }
    }

    // Create and arm each new latent intention.
    const mintedIds: string[] = [];
    for (const m of create) {
      const intention = await this.store.create({
        content: m.content,
        trigger: m.trigger,
        strength: m.strength,
        origin: m.origin,
        confidence: m.confidence,
        evidence: { ...m.evidence, sessionKey },
        sensitivity: m.sensitivity,
      });
      // armIntention with empty adapters: match-only triggers (topic/where.category/who)
      // arm immediately (no adapter required); never arm_failed for match-only.
      await armIntention(intention, new Map(), this.store);
      mintedIds.push(intention.id);
      log.info("latent intention stored (armed)", {
        id: intention.id,
        confidence: intention.confidence,
      });
    }
    return mintedIds;
  }

  /**
   * M9 surfacing pass: for each live non-quiet session, run matchLatent against
   * the session context and surface (cautious) the armed latents whose context is
   * right now. Skips intentions minted this tick (no instant echo). No-op when the
   * surfacing deps (broadcast/hasSession/liveSessions) are not wired — e.g. pure
   * recognition or unit-test setups.
   */
  private async _surfacingPass(mintedThisTick: Set<string>): Promise<void> {
    const liveSessions = this.liveSessions;
    const broadcast = this.broadcast;
    const hasSession = this.hasSession;
    if (!liveSessions || !broadcast || !hasSession) return;
    await Promise.all(
      liveSessions().map(async ({ sessionKey, mode }) => {
        if (!projectMode(mode).latentIntentionEnabled) return;
        // Global set: latents are user-global and must surface across sessions (M10 §6).
        // sessionKey supplies the CONTEXT WINDOW, not a filter on eligible latents.
        const armed = await this.store.list({ state: "armed", origin: "latent" });
        // Exclude this tick's fresh mints + ids reserved by a recent scan (surface-once).
        const candidates = armed.filter(
          (i) => !mintedThisTick.has(i.id) && !this._reservedRecently(i.id),
        );
        if (candidates.length === 0) return;
        // The relevance gate decides which candidates are timely enough to surface.
        const verdicts = await this.relevanceGate.evaluate({
          armed: candidates,
          window: this.window.get(sessionKey),
          now: this.now(),
          tz: this.tz,
          location: this.sessionLocations.get(sessionKey),
        });
        const toSurface = verdicts.filter((v) => v.surface);
        if (toSurface.length === 0) return;
        const byId = new Map(candidates.map((i) => [i.id, i]));
        const nodes = makeSessionInvoker(sessionKey, { broadcast, hasSession, event: INTENTION_SURFACE_EVENT });
        for (const v of toSurface) {
          const intent = byId.get(v.id);
          if (!intent) continue;
          // Late check: re-read reservation + state IMMEDIATELY before delivery so a
          // scan landing mid-tick (after the candidates filter) is still caught (M10 §4).
          if (this._reservedRecently(v.id)) continue;
          const fresh = await this.store.get(v.id);
          if (!fresh || fresh.state !== "armed") continue;
          // Fix 3c: pass disarmFn so surfacing a latent also disarms its where-region.
          const result = await surfaceLatent(fresh, {
            store: this.store,
            nodes,
            disarmFn: this.disarmWhereFn,
          });
          // Only log/count an actual delivery — deliverAndMark guarantees a single
          // delivery; two sessions in a tick will race, but only one resolves as delivered.
          if (result.delivered) {
            log.info("latent intention surfaced", {
              id: fresh.id,
              confidence: v.confidence,
              matchedTerms: v.matchedTerms,
            });
          }
        }
      }),
    );
  }
}
