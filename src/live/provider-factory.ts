import { GeminiLiveAdapter } from "./providers/gemini.js";
import { JoyAIAdapter } from "./providers/joyai.js";
import { VenusAdapter } from "./providers/venus.js";
import { resolveJoyConfig, resolveVenusConfig, type LiveProvidersConfig, type ProviderEnvironment } from "./provider-config.js";
import type { StreamAdapter, StreamOptions } from "./stream-contracts.js";

/** Composition only; adapters never load config or import gateway implementation. */
export function createStreamAdapter(options: StreamOptions, config: LiveProvidersConfig | undefined,
  env: ProviderEnvironment, geminiKey: string): StreamAdapter {
  if (options.model.startsWith("gemini-")) return new GeminiLiveAdapter(options, geminiKey);
  if (options.model === "joyai-vl-interaction") return new JoyAIAdapter(options, resolveJoyConfig(config, env));
  if (options.model === "realtime-venus-omni") return new VenusAdapter(options, resolveVenusConfig(config, env));
  throw new Error(`Unsupported streaming model: ${options.model}`);
}
