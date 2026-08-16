export type VoiceprintExpectedLabel =
  | "owner"
  | "non_owner"
  | "noise"
  | "assistant_leakage"
  | "unknown";

export type VoiceprintDecision =
  | "owner_speaking"
  | "possible_owner"
  | "unknown_speaker";

export interface VoiceprintThresholds {
  ownerAccept: number;
  ownerPossible: number;
}

export const DEFAULT_VOICEPRINT_THRESHOLDS: VoiceprintThresholds = {
  ownerAccept: 0.82,
  ownerPossible: 0.72,
};

export interface VoiceprintModelInfo {
  provider:
    | "external-json"
    | "signal-baseline"
    | "speechbrain"
    | "wespeaker"
    | "picovoice"
    | "sherpa-onnx"
    | "reference"
    | "custom";
  modelId: string;
  version?: string;
  notes?: string;
}

export interface VoiceprintEmbeddingSource {
  id: string;
  audioPath?: string;
  embeddingPath?: string;
  embedding?: number[];
  startMs?: number;
  endMs?: number;
  route?: string;
  notes?: string;
}

export interface VoiceprintFixtureSample extends VoiceprintEmbeddingSource {
  expected: VoiceprintExpectedLabel;
}

export interface VoiceprintManifest {
  version: 1;
  model?: VoiceprintModelInfo;
  thresholds?: Partial<VoiceprintThresholds>;
  owner: {
    id?: string;
    enrollment: VoiceprintEmbeddingSource[];
  };
  samples: VoiceprintFixtureSample[];
}

export interface VoiceprintLoadedEmbedding {
  sourceId: string;
  vector: number[];
  provider: VoiceprintModelInfo["provider"];
  modelId: string;
  source:
    | "inline_embedding"
    | "embedding_path"
    | "wav_signal_baseline";
  dim: number;
}

export interface VoiceprintScoreRow {
  id: string;
  expected: VoiceprintExpectedLabel;
  decision: VoiceprintDecision;
  similarity: number;
  passed: boolean | null;
  risk:
    | "ok"
    | "false_accept"
    | "false_reject"
    | "possible_false_accept"
    | "possible_owner_miss"
    | "unlabeled";
  route?: string;
  provider: VoiceprintModelInfo["provider"];
  modelId: string;
  notes?: string;
}

export interface VoiceprintScoreReport {
  generatedAt: string;
  ownerId: string;
  model: VoiceprintModelInfo;
  thresholds: VoiceprintThresholds;
  enrollment: {
    count: number;
    dim: number;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    unlabeled: number;
    falseAccepts: number;
    falseRejects: number;
    possibleFalseAccepts: number;
  };
  rows: VoiceprintScoreRow[];
}
