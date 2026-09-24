/** Application capabilities, not a lowest-common-denominator wire protocol. */
export type LiveProviderId = "openai-realtime" | "gpt-live";
export interface ConversationTurn { role: "user" | "assistant"; text: string }
export interface LiveCapabilities {
  provider: LiveProviderId;
  camera: boolean;
  manualCompaction: boolean;
  textInput: "native" | "backend";
  turnDetection: "configurable" | "continuous";
}
export function liveCapabilities(model: string): LiveCapabilities {
  return model === "gpt-live-1"
    ? { provider: "gpt-live", camera: false, manualCompaction: false, textInput: "backend", turnDetection: "continuous" }
    : { provider: "openai-realtime", camera: true, manualCompaction: true, textInput: "native", turnDetection: "configurable" };
}
