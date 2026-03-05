// =============================================================================
// Secret Redaction
//
// Masks sensitive values in console output. File logs are NOT redacted
// (preserved for debugging). Applied automatically by console transport.
//
// Pattern: a proven redaction approach, simplified.
// =============================================================================

// -----------------------------------------------------------------------------
// Patterns that indicate a value is sensitive
// -----------------------------------------------------------------------------

/** Regex patterns for values that look like secrets */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[a-zA-Z0-9_-]{10,}$/,         // Anthropic, OpenAI keys
  /^ghp_[a-zA-Z0-9]{36,}$/,           // GitHub personal access tokens
  /^ghs_[a-zA-Z0-9]{36,}$/,           // GitHub server tokens
  /^xox[bpras]-[a-zA-Z0-9-]+$/,       // Slack tokens
  /^AIza[a-zA-Z0-9_-]{30,}$/,         // Google API keys
  /^npm_[a-zA-Z0-9]{36,}$/,           // npm tokens
  /^bot[0-9]+:[a-zA-Z0-9_-]{30,}$/,   // Telegram bot tokens
];

/** Key names (case-insensitive) that indicate the value is sensitive */
const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|secret|token|password|credential|auth|bearer|private[_-]?key|access[_-]?key)$/i;

/** Env-var-style assignments: KEY=value, TOKEN=value, etc. */
const ENV_ASSIGNMENT_PATTERN = /\b(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH_TOKEN|PRIVATE_KEY|ACCESS_KEY)\s*=\s*(\S+)/gi;

// -----------------------------------------------------------------------------
// Masking
// -----------------------------------------------------------------------------

/**
 * Mask a sensitive value.
 * Short values (< 12 chars): "***"
 * Longer values: first 4 chars + "..." + last 4 chars
 */
export function maskValue(value: string): string {
  if (value.length < 12) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Check if a string value looks like a secret.
 */
export function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

// -----------------------------------------------------------------------------
// Redaction functions
// -----------------------------------------------------------------------------

/**
 * Redact sensitive values in a string. Used for console output only.
 *
 * Handles:
 * - Env-var assignments: KEY=sk-abc123... → KEY=sk-a...3...
 * - JSON-like fields: "apiKey": "sk-abc123..." → "apiKey": "***"
 */
export function redactString(input: string): string {
  let result = input;

  // Redact env-var-style assignments: SECRET=value
  result = result.replace(ENV_ASSIGNMENT_PATTERN, (_match, key, value) => {
    return `${key}=${maskValue(value)}`;
  });

  // Redact JSON-like key-value pairs: "token": "sk-..."
  result = result.replace(
    /"(api[_-]?key|secret|token|password|credential|auth|access[_-]?token|private[_-]?key)"\s*:\s*"([^"]+)"/gi,
    (_match, key, value) => `"${key}": "${maskValue(value)}"`,
  );

  // Redact standalone secret-looking values (e.g., in log metadata)
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, (match) => maskValue(match));
  }

  return result;
}

/**
 * Redact values in a metadata object (shallow). Returns a new object.
 * Used when formatting metadata for console output.
 */
export function redactMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") {
      if (SENSITIVE_KEY_PATTERN.test(key) || looksLikeSecret(value)) {
        redacted[key] = maskValue(value);
      } else {
        redacted[key] = value;
      }
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
