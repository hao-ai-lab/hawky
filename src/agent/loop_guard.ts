// =============================================================================
// Loop Guard
//
// Protects the agent loop from runaway iterations and tool loops.
// Tracks tool calls and detects repeated identical invocations.
// =============================================================================

// -----------------------------------------------------------------------------
// Tool loop detection
// -----------------------------------------------------------------------------

const HISTORY_WINDOW = 20;
const WARN_THRESHOLD = 5;
const BLOCK_THRESHOLD = 10;

interface ToolCallRecord {
  name: string;
  input_hash: string;
}

export class LoopGuard {
  readonly maxIterations: number;
  private iteration = 0;
  private toolHistory: ToolCallRecord[] = [];

  constructor(maxIterations: number) {
    this.maxIterations = maxIterations;
  }

  /**
   * Increment iteration counter. Returns current iteration (1-based).
   */
  nextIteration(): number {
    return ++this.iteration;
  }

  /**
   * Check if we've exceeded the iteration limit.
   */
  isOverLimit(): boolean {
    return this.iteration >= this.maxIterations;
  }

  /**
   * Check if we're approaching the limit (for warning).
   */
  isApproachingLimit(): boolean {
    return this.iteration >= this.maxIterations - 5;
  }

  get currentIteration(): number {
    return this.iteration;
  }

  /**
   * Record a tool call and check for loops.
   * Returns: { ok: true } or { ok: false, reason, count }.
   */
  recordToolCall(
    name: string,
    input: Record<string, unknown>,
  ): { ok: true } | { ok: false; warn: boolean; reason: string; count: number } {
    const hash = hashInput(input);
    this.toolHistory.push({ name, input_hash: hash });

    // Keep only the last HISTORY_WINDOW entries
    if (this.toolHistory.length > HISTORY_WINDOW) {
      this.toolHistory = this.toolHistory.slice(-HISTORY_WINDOW);
    }

    // Count identical calls (same name + same input hash)
    const count = this.toolHistory.filter(
      (r) => r.name === name && r.input_hash === hash,
    ).length;

    if (count >= BLOCK_THRESHOLD) {
      return {
        ok: false,
        warn: false,
        reason: `Tool "${name}" called ${count} times with identical input — blocked to prevent infinite loop.`,
        count,
      };
    }

    if (count >= WARN_THRESHOLD) {
      return {
        ok: false,
        warn: true,
        reason: `Tool "${name}" called ${count} times with identical input — possible loop.`,
        count,
      };
    }

    return { ok: true };
  }

  /**
   * Reset state (for testing).
   */
  reset(): void {
    this.iteration = 0;
    this.toolHistory = [];
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function hashInput(input: Record<string, unknown>): string {
  const json = stableStringify(input);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

// Export for testing
export { hashInput as _hashInput, WARN_THRESHOLD, BLOCK_THRESHOLD, HISTORY_WINDOW };
