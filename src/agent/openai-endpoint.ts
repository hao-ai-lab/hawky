import { loadConfig } from "../storage/config.js";

/** Route issued Hawk keys through the configured proxy; personal keys stay direct. */
export function openAIEndpoint(path: string, apiKey: string): string {
  const base = apiKey.startsWith("sk-hawky-")
    ? process.env.HAWKY_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || loadConfig().openai_base_url
    : "https://api.openai.com/v1";
  if (!base) throw new Error("A Hawk API key requires an OpenAI base URL in gateway settings.");
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
