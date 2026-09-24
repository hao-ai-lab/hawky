/** Application capabilities, not a lowest-common-denominator wire protocol. */
export type LiveProviderId = "openai-realtime" | "gpt-live" | "gemini-live" | "venus" | "joyai";
export interface ConversationTurn { role: "user" | "assistant"; text: string }
export interface LiveCapabilities {
  provider: LiveProviderId;
  camera: boolean;
  behaviorModes: boolean;
  manualCompaction: boolean;
  textInput: "native" | "backend";
  turnDetection: "configurable" | "continuous";
}
export function liveCapabilities(model: string): LiveCapabilities {
  if (model.startsWith("gemini-")) return { provider: "gemini-live", camera: true, behaviorModes: false, manualCompaction: false, textInput: "native", turnDetection: "continuous" };
  return model === "gpt-live-1"
    ? { provider: "gpt-live", camera: false, behaviorModes: false, manualCompaction: false, textInput: "backend", turnDetection: "continuous" }
    : { provider: "openai-realtime", camera: true, behaviorModes: true, manualCompaction: true, textInput: "native", turnDetection: "configurable" };
}
