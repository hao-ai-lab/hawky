/**
 * Shared voiceprint validation helpers.
 *
 * These small checks were previously re-implemented across the live-pipeline
 * files. Extracting them keeps the comparison operators and error phrasing in
 * one place. Every helper takes a caller-supplied label/message so each call
 * site keeps its exact (test-asserted) error text.
 */

/**
 * Validate that a start/end millisecond pair is finite and correctly ordered
 * (`endMs > startMs`). Both messages are built from `label` so callers keep
 * their existing phrasing (e.g. "Live voiceprint turn" / "Live voiceprint
 * scoring job").
 */
export function validateTimeBounds(startMs: number, endMs: number, label: string): void {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error(`${label} requires finite startMs and endMs.`);
  }
  if (endMs <= startMs) {
    throw new Error(`${label} requires endMs > startMs.`);
  }
}

/**
 * Validate that a trimmed identifier string is non-empty. `message` is the full
 * error text so each call site preserves its exact phrasing.
 */
export function validateIdentifierNotEmpty(value: string, message: string): void {
  if (!value.trim()) {
    throw new Error(message);
  }
}

/**
 * Return the first value that appears more than once, or `null` if all values
 * are unique. Comparison is by strict equality on the raw string.
 */
export function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
}

/**
 * Throw if `ids` contains any duplicate. The error message is derived from the
 * first duplicate via `makeMessage` so call sites keep their exact phrasing.
 */
export function checkNoDuplicateIds(
  ids: readonly string[],
  makeMessage: (duplicate: string) => string,
): void {
  const duplicate = firstDuplicate(ids);
  if (duplicate !== null) {
    throw new Error(makeMessage(duplicate));
  }
}

/**
 * Validate that a string is a non-empty, ISO-parseable timestamp. `label` is
 * the full message prefix (e.g. "Voiceprint template" / "Voiceprint template
 * file") so callers keep their exact phrasing.
 */
export function validateIsoLikeTime(value: string, label: string, field: string): void {
  if (!value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} ${field} must be an ISO timestamp.`);
  }
}
