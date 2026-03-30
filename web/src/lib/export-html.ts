// =============================================================================
// Session Export — Self-Contained HTML
//
// Generates a single .html file with the full conversation, embedded CSS,
// and dark/light mode toggle. Opens in any browser, no dependencies.
// =============================================================================

import type { SessionMessage } from "../store/session-store";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatMessage(msg: SessionMessage): string {
  const content = escapeHtml(msg.content).replace(/\n/g, "<br>");

  if (msg.role === "user") {
    return `<div class="msg user"><div class="bubble user-bubble">${content}</div></div>`;
  }
  if (msg.role === "system") {
    return `<div class="msg system"><em>${content}</em></div>`;
  }
  if (msg.role === "tool" && msg.tool) {
    const toolName = escapeHtml(msg.tool.name);
    const preview = escapeHtml(msg.tool.inputPreview);
    const output = msg.tool.output ? escapeHtml(msg.tool.output).replace(/\n/g, "<br>") : "";
    const status = msg.tool.isError ? "error" : "success";
    return `<div class="msg tool"><div class="tool-card ${status}"><strong>${toolName}</strong> <span class="preview">${preview}</span>${output ? `<pre class="tool-output">${output}</pre>` : ""}</div></div>`;
  }
  // Assistant
  return `<div class="msg assistant">${content}</div>`;
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 24px 16px; background: #f5f5f0; color: #1c1917; }
body.dark { background: #2b2a27; color: #e7e5e4; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid rgba(0,0,0,0.1); }
.dark .header { border-bottom-color: rgba(255,255,255,0.1); }
.header h1 { font-size: 1.25rem; font-weight: 600; }
.header button { background: none; border: 1px solid rgba(0,0,0,0.15); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 0.8rem; color: inherit; }
.dark .header button { border-color: rgba(255,255,255,0.15); }
.meta { font-size: 0.75rem; color: #6b6a68; margin-bottom: 24px; }
.dark .meta { color: #9a9893; }
.msg { margin-bottom: 16px; }
.msg.user { text-align: right; }
.bubble { display: inline-block; max-width: 80%; padding: 10px 16px; border-radius: 16px; text-align: left; }
.user-bubble { background: #ddd9ce; color: #1c1917; }
.dark .user-bubble { background: #393937; color: #e7e5e4; }
.msg.assistant { font-family: ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif; }
.msg.system { text-align: center; font-size: 0.85rem; color: #6b6a68; }
.dark .msg.system { color: #9a9893; }
.tool-card { border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 10px 14px; font-family: -apple-system, sans-serif; font-size: 0.85rem; background: #fafaf8; }
.dark .tool-card { border-color: rgba(255,255,255,0.08); background: #333; }
.tool-card.error { border-color: #dc2626; }
.tool-card .preview { color: #6b6a68; font-size: 0.8rem; }
.tool-output { margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.03); border-radius: 4px; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
.dark .tool-output { background: rgba(255,255,255,0.03); }
pre, code { font-family: "SF Mono", Menlo, monospace; }
`;

export function exportSessionAsHtml(messages: SessionMessage[], sessionKey: string): void {
  const date = new Date().toLocaleString();
  const messagesHtml = messages.map(formatMessage).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hawky — ${escapeHtml(sessionKey)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="header">
  <h1>Hawky</h1>
  <button onclick="document.body.classList.toggle('dark')">Toggle Dark</button>
</div>
<div class="meta">Session: ${escapeHtml(sessionKey)} &middot; Exported: ${escapeHtml(date)} &middot; ${messages.length} messages</div>
${messagesHtml}
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hawky-${sessionKey.replace(/[^a-zA-Z0-9-]/g, "-")}-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
