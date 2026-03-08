// =============================================================================
// Context Window Lookup
//
// Maps model IDs to their context window sizes (in tokens).
// Used for token pressure detection and TUI context usage display.
// =============================================================================

// -----------------------------------------------------------------------------
// Known context windows
// -----------------------------------------------------------------------------

const CONTEXT_WINDOWS: Record<string, number> = {
  // Claude 4.7
  "claude-opus-4-7": 1_000_000,
  // Claude 4.6
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  // Claude 4.5
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // Fallback for unrecognized models
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

// -----------------------------------------------------------------------------
// Lookup
// -----------------------------------------------------------------------------

/**
 * Get the context window size for a model.
 * Falls back to DEFAULT_CONTEXT_WINDOW for unrecognized models.
 */
export function getContextWindowTokens(modelId: string): number {
  // Try exact match first
  if (CONTEXT_WINDOWS[modelId]) {
    return CONTEXT_WINDOWS[modelId];
  }

  // Try prefix match (e.g., "claude-sonnet-4-6-20260301" → "claude-sonnet-4-6")
  // Sort by key length descending so longest prefix wins (avoids partial matches).
  const entries = Object.entries(CONTEXT_WINDOWS).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [key, value] of entries) {
    if (modelId.startsWith(key)) {
      return value;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

export { DEFAULT_CONTEXT_WINDOW };
