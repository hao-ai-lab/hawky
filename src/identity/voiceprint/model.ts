import type { VoiceprintModelInfo } from "./types.js";

export function voiceprintModelIdentityParts(model: VoiceprintModelInfo): {
  provider: VoiceprintModelInfo["provider"];
  modelId: string;
  version?: string;
} {
  return {
    provider: model.provider,
    modelId: model.modelId,
    version: model.version,
  };
}

export function sameVoiceprintModel(
  a: VoiceprintModelInfo,
  b: VoiceprintModelInfo,
): boolean {
  return a.provider === b.provider && a.modelId === b.modelId && a.version === b.version;
}

export function formatVoiceprintModel(model: VoiceprintModelInfo): string {
  return `${model.provider}/${model.modelId}${model.version ? `@${model.version}` : ""}`;
}
