// =============================================================================
// URL Linkification
//
// Detects URLs in text and wraps them in OSC 8 hyperlink escape sequences
// (clickable in iTerm2, VS Code terminal, Kitty, etc.).
//
// Supports:
// - Bare URLs: https://example.com, http://..., file:///path
// - Markdown links: [text](url)
//
// OSC 8 format: \x1b]8;;URL\x07TEXT\x1b]8;;\x07
// =============================================================================

// Combined pattern: markdown links OR bare URLs (markdown links matched first)
// Bare URLs: allow parentheses for Wikipedia-style links, strip trailing punctuation
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+|file:\/\/\/[^)]+)\)|https?:\/\/[^\s"'<>\]]+|file:\/\/\/[^\s"'<>\]]+/g;

/** Strip trailing sentence punctuation that likely isn't part of the URL */
function stripTrailingPunct(url: string): string {
  // Strip trailing ., ,, !, ?, ;, : — but only if they don't have a matching open paren
  let cleaned = url.replace(/[.,!?;:]+$/, "");
  // Handle balanced parens for Wikipedia-style URLs: if more ) than (, strip trailing )
  let opens = 0, closes = 0;
  for (const ch of cleaned) {
    if (ch === "(") opens++;
    if (ch === ")") closes++;
  }
  while (closes > opens && cleaned.endsWith(")")) {
    cleaned = cleaned.slice(0, -1);
    closes--;
  }
  return cleaned;
}

/**
 * Wrap a URL in an OSC 8 hyperlink escape sequence.
 */
function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * Linkify URLs in text for TUI display (OSC 8 escape sequences).
 * Single pass handles both markdown links [text](url) and bare URLs.
 */
export function linkifyForTui(text: string): string {
  return text.replace(LINK_RE, (match, mdText, mdUrl) => {
    if (mdText && mdUrl) {
      return osc8(mdUrl, mdText);
    }
    const cleanUrl = stripTrailingPunct(match);
    const trailing = match.slice(cleanUrl.length); // punctuation after URL
    return osc8(cleanUrl, cleanUrl) + trailing;
  });
}

/**
 * Linkify URLs in text for web display (HTML <a> tags).
 * Single pass handles both markdown links and bare URLs.
 */
export function linkifyForWeb(text: string): string {
  return text.replace(LINK_RE, (match, mdText, mdUrl) => {
    if (mdText && mdUrl) {
      const safeUrl = mdUrl.replace(/"/g, "&quot;");
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${mdText}</a>`;
    }
    const safeUrl = match.replace(/"/g, "&quot;");
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${match}</a>`;
  });
}

// Export for testing
export { LINK_RE, osc8 };
