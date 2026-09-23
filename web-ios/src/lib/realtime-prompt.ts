/** Browser interaction rules. Identity, soul, and existing memory come from the gateway. */
export const REALTIME_INTERACTION_RULES =
  "You are Hawk, a concise, friendly realtime assistant. Use the camera and " +
  "microphone context when relevant, answer briefly, and delegate durable or " +
  "long-running work to the Hawk backend tool.";

/** The only assembly point for initial browser instructions; no I/O or model rewrite. */
export function buildRealtimePrompt(backendContext: string): string {
  return [REALTIME_INTERACTION_RULES, backendContext ? `# Hawk Backend Context\n${backendContext}` : ""]
    .filter(Boolean)
    .join("\n\n");
}
