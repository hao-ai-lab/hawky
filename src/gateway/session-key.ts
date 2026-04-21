// =============================================================================
// Session Key Builder
//
// Builds unique session identifiers from channel, chat ID, and context.
// Session keys determine which session lane a message enters.
//
// Pattern: a proven session-key.ts, simplified for single-user.
// =============================================================================

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SessionKeyParams {
  /** Channel type: "tui", "web", "api", "cron", "heartbeat" */
  channel: string;
  /** Chat identifier within the channel (e.g., tab ID, job ID) */
  chatId?: string;
}

// -----------------------------------------------------------------------------
// Key building
// -----------------------------------------------------------------------------

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/**
 * Build a session key from channel and chat context.
 *
 * Examples:
 *   buildSessionKey({ channel: "tui" })                    → "tui:main"
 *   buildSessionKey({ channel: "web", chatId: "tab-abc" }) → "web:tab-abc"
 *   buildSessionKey({ channel: "cron", chatId: "standup" })→ "cron:standup"
 *   buildSessionKey({ channel: "heartbeat" })              → "heartbeat:main"
 */
export function buildSessionKey(params: SessionKeyParams): string {
  const channel = normalize(params.channel) || "unknown";
  const chatId = params.chatId ? normalize(params.chatId) : "main";
  return `${channel}:${chatId}`;
}
