// =============================================================================
// In-process pub/sub bus.
//
// Purpose: decouple producers from consumers via topic-based fan-out. See
// design doc §3. Intentionally tiny so it can be swapped for NATS/Redis later
// without consumer edits.
//
// Pattern matching: single-level `*` at segment boundaries only. Examples:
//   "media.finalized"    matches "media.finalized" exactly.
//   "asr.*"              matches any single-segment suffix of "asr.".
//   "asr.final"          matches "asr.final" exactly.
// NOTE: Topics are kept flat (no embedded identifiers) — media_id/session_id
// travel in the event payload so subscribers filter by event.media_id.
//
// Handler errors are caught + logged — one bad consumer does not kill siblings.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("bus");

export type Handler<T = unknown> = (event: T, topic: string) => void | Promise<void>;

export interface Bus {
  publish<T>(topic: string, event: T): void;
  subscribe<T>(pattern: string, handler: Handler<T>): () => void;
}

interface Subscription {
  pattern: string;
  regex: RegExp;
  handler: Handler<unknown>;
}

// -----------------------------------------------------------------------------
// Pattern → RegExp
// -----------------------------------------------------------------------------

/**
 * Compile a glob-ish pattern into a RegExp.
 *   "*" is a single segment (matches [^.]+).
 *   Other characters are literal (with regex metachars escaped).
 */
function compilePattern(pattern: string): RegExp {
  const parts = pattern.split(".").map((seg) => {
    if (seg === "*") return "[^.]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp("^" + parts.join("\\.") + "$");
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

class InProcessBus implements Bus {
  private subs: Subscription[] = [];

  publish<T>(topic: string, event: T): void {
    const matches = this.subs.filter((sub) => sub.regex.test(topic));
    for (const sub of matches) {
      // Fire-and-forget. Async handlers surface errors via the catch below;
      // sync throws are caught by the try/catch inline.
      try {
        const result = sub.handler(event, topic);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch((err) => {
            log.warn("async bus handler error (ignored)", {
              topic,
              pattern: sub.pattern,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        log.warn("sync bus handler error (ignored)", {
          topic,
          pattern: sub.pattern,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  subscribe<T>(pattern: string, handler: Handler<T>): () => void {
    const entry: Subscription = {
      pattern,
      regex: compilePattern(pattern),
      handler: handler as Handler<unknown>,
    };
    this.subs.push(entry);
    return () => {
      const idx = this.subs.indexOf(entry);
      if (idx >= 0) this.subs.splice(idx, 1);
    };
  }

  /** Test helper — wipe every subscription. */
  _reset(): void {
    this.subs = [];
  }

  /** Test helper — count of subscribers whose pattern matches `topic`. */
  _subscriberCountFor(topic: string): number {
    return this.subs.filter((s) => s.regex.test(topic)).length;
  }
}

// -----------------------------------------------------------------------------
// Singleton (swap for NATS/Redis later; keep interface stable)
// -----------------------------------------------------------------------------

const defaultBus = new InProcessBus();

export function getBus(): Bus {
  return defaultBus;
}

/** Test-only: reset all subscriptions on the singleton. */
export function resetBus(): void {
  defaultBus._reset();
}

/** Test-only. */
export function _subscriberCountFor(topic: string): number {
  return defaultBus._subscriberCountFor(topic);
}
