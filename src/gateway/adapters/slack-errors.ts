// =============================================================================
// Slack Adapter Init Error Classifier
//
// Kept in its own module so it can be imported without pulling in @slack/bolt.
// The whole point of this helper is to explain the case where bolt itself
// cannot be resolved — loading it from slack.ts would re-trigger the failure.
// =============================================================================

export interface SlackInitErrorDecision {
  level: "error" | "warn";
  message: string;
  /** Extra data for the log entry (raw error message, etc.). */
  data?: Record<string, unknown>;
}

/**
 * Matches the "missing dependency" wording emitted by both Node and Bun.
 * Captures the offending package name (group 1) so the message can name the
 * real culprit — for example `@slack/web-api` instead of always `@slack/bolt`.
 *
 * Examples of strings this matches:
 *   - "Cannot find module '@slack/bolt' from '/path/...'"       (Node, Bun dynamic-import ResolveMessage)
 *   - "Cannot find package '@slack/web-api' from '/path/...'"   (Bun's own resolver)
 */
const MISSING_SLACK_PKG = /Cannot find (?:module|package) '(@slack\/[^']+)'/;

/**
 * Decide how to surface a Slack adapter initialization failure.
 *
 * The common deployment pitfall: a Slack dependency is declared in
 * package.json but the operator pulled code without running `bun install`.
 * The resulting error is easy to miss at `warn` level, so we promote it to
 * `error` with an actionable, package-specific message so it lands in the
 * Recent Errors ring buffer with the right guidance.
 */
export function classifySlackInitError(rawMessage: string): SlackInitErrorDecision {
  const match = MISSING_SLACK_PKG.exec(rawMessage);
  if (match) {
    const pkg = match[1]!;
    return {
      level: "error",
      message:
        `slack adapter disabled: ${pkg} is not installed. ` +
        "Run 'bun install' on the host after pulling a branch that adds Slack support.",
    };
  }
  return {
    level: "warn",
    message: "slack adapter initialization failed (non-fatal)",
    data: { error: rawMessage },
  };
}
