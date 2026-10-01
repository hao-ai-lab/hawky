export function parseJoyOutput(raw: string) {
  const s = visibleJoyText(raw);
  if (!s || s === "</silence>" || s === "<silence>" || s === "<silence></silence>") return { text: "", task: undefined };
  // The native demo accepts plain text and XML-style response wrappers too.
  // Only an explicit response prefix may introduce a delegation action.
  const explicit = s.startsWith("</response>") || s.startsWith("<response>");
  let body = explicit ? s.replace(/^<\/?response>/, "") : s;
  if (s.startsWith("<response>")) body = body.replace(/<\/response>\s*$/, "");
  const parts = body.split(/<\/?delegation>/);
  if ((!explicit && parts.length > 1) || parts.length > 2 || parts.some(p => /<\/?[a-z_][^>]*>/i.test(p))) throw new Error("JoyAI returned malformed action markers");
  const task = parts[1]?.trim();
  if (parts.length === 2 && (!task || task.length > 4000)) throw new Error("JoyAI returned an invalid delegation");
  return { text: parts[0].trim(), task };
}

function visibleJoyText(raw: string) {
  // Some deployments include reasoning in content rather than a separate field.
  // Never speak it or execute a delegation mentioned inside it. An incomplete
  // block cannot safely be recovered as user-visible text.
  const visible = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (/<\/?think>/i.test(visible)) throw new Error("JoyAI returned an incomplete reasoning block");
  return visible.replace(/<answer>([\s\S]*?)<\/answer>/gi, "$1").trim();
}

/** Normalized content is the public protocol; raw_content is a debug field.
 * Preserve an explicit raw delegation because upstream normalization may retain
 * only its first line. Never recover malformed tool markup as an executable task.
 */
export function parseJoyResponse(result: any) {
  const raw = result.streamingharness?.raw_content;
  const content = result.choices?.[0]?.message?.content;
  const cleanRaw = typeof raw === "string" && raw.length <= 16000 ? visibleJoyText(raw) : undefined;
  // The upstream first-line normalizer can cut a <think> block in half. In that
  // case use the complete raw payload's visible answer, never its partial text.
  const useRaw = cleanRaw !== undefined && (/<\/?think>/i.test(raw) || /<\/?delegat/i.test(cleanRaw));
  const text = useRaw ? cleanRaw : content ?? raw;
  if (typeof text !== "string" || text.length > 16000) throw new Error("JoyAI returned invalid response text");
  return parseJoyOutput(text);
}
