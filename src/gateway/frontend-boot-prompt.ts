/** Pure rendering only. File selection and RPC metadata live in frontend-boot-context.ts. */
export interface BootPromptInput {
  identity?: string;
  soul?: string;
  memory: Array<{ filename: string; content: string }>;
  dailyLogs: Array<{ filename: string; content: string }>;
  mode: string;
  capabilities: string[];
  tools: Array<{ name: string; description: string; parameters: { required?: string[] } }>;
}

/** Remove presentation markup from our prose character files, preserving words and links. */
function characterProse(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^\n]+?)[*_](?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderFrontendBootPrompt(input: BootPromptInput): string {
  const sections = [
    "# Backend Boot Context",
    "You are joining an existing session. Use this context silently unless the user asks about it.",
  ];
  if (input.identity?.trim()) sections.push("Identity:\n" + characterProse(input.identity));
  if (input.soul?.trim()) sections.push("Soul:\n" + characterProse(input.soul));
  sections.push([
    "## Session",
    `- Mode: ${input.mode}`,
    `- Capabilities: ${input.capabilities.length > 0 ? input.capabilities.join(", ") : "unspecified"}`,
  ].join("\n"));
  if (input.tools.length > 0) {
    sections.push([
      "## Toolbox",
      "The frontend realtime agent has these callable tools. Prefer fast local tools for simple facts and delegate durable work to the backend session bridge.",
      ...input.tools.map(tool => {
        const required = tool.parameters.required?.length ? ` Required: ${tool.parameters.required.join(", ")}.` : "";
        return `- ${tool.name}: ${tool.description}${required}`;
      }),
    ].join("\n"));
  }
  if (input.memory.length) sections.push("## Relevant Memory\n" + renderFiles(input.memory));
  if (input.dailyLogs.length) sections.push("## Recent Daily Logs\n" + renderFiles(input.dailyLogs));
  sections.push([
    "## Behavior Notes",
    "- Treat this boot context as private context, not as a user message.",
    "- Do not recite this context at startup.",
    "- If the user asks for durable work, use the Hawky bridge tools instead of pretending the frontend can do it locally.",
    "- If memory seems missing or stale, ask the backend agent or search memory through the available tools.",
  ].join("\n"));
  return sections.join("\n\n");
}

function renderFiles(files: BootPromptInput["memory"]): string {
  return files.map(file => `### ${file.filename}\n${file.content.trim()}`).join("\n");
}
