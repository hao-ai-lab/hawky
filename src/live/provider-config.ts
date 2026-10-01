/** Operator-owned settings. Client requests cannot override self-hosted endpoints. */
export interface JoyConfig {
  url: string; model?: string; api_key?: string;
  asr_url?: string; asr_model?: string; asr_api_key?: string;
  tts_url?: string; tts_voice?: string; tts_api_key?: string;
}
export interface LiveProvidersConfig {
  venus?: { url: string; api_key?: string };
  joyai?: JoyConfig;
}
export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Pure resolution: one config snapshot per connection, explicit environment precedence. */
export function resolveJoyConfig(config: LiveProvidersConfig | undefined, env: ProviderEnvironment): JoyConfig {
  const joy = config?.joyai;
  return {
    ...joy,
    url: env.HAWKY_JOYAI_URL || joy?.url || "http://127.0.0.1:8070",
    api_key: env.HAWKY_JOYAI_API_KEY || joy?.api_key,
    asr_url: env.HAWKY_JOYAI_ASR_URL || joy?.asr_url,
    asr_api_key: env.HAWKY_JOYAI_ASR_API_KEY || joy?.asr_api_key,
    tts_url: env.HAWKY_JOYAI_TTS_URL || joy?.tts_url,
    tts_api_key: env.HAWKY_JOYAI_TTS_API_KEY || joy?.tts_api_key,
  };
}
export function resolveVenusConfig(config: LiveProvidersConfig | undefined, env: ProviderEnvironment) {
  return {
    url: env.HAWKY_VENUS_URL || config?.venus?.url || "http://127.0.0.1:8033",
    apiKey: env.HAWKY_VENUS_API_KEY || config?.venus?.api_key,
  };
}
