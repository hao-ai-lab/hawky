import {
  type VoiceprintDecision,
  type VoiceprintExpectedLabel,
  type VoiceprintManifest,
  type VoiceprintModelInfo,
  type VoiceprintScoreReport,
  type VoiceprintScoreRow,
  type VoiceprintThresholds,
} from "./types.js";
import { loadVoiceprintEmbedding } from "./manifest.js";
import { resolveVoiceprintThresholds } from "./thresholds.js";
import {
  classifyOwnerSimilarity,
  isUsableEmbeddingVector,
  meanVector,
  safeCosineSimilarity,
} from "./similarity.js";

const DEFAULT_MODEL: VoiceprintModelInfo = {
  provider: "external-json",
  modelId: "external-embedding",
};

const VALID_EXPECTED_LABELS = new Set<VoiceprintExpectedLabel>([
  "owner",
  "non_owner",
  "noise",
  "assistant_leakage",
  "unknown",
]);

export async function scoreVoiceprintManifest(
  manifest: VoiceprintManifest,
  options: {
    baseDir?: string;
    thresholdOverrides?: Partial<VoiceprintThresholds>;
    generatedAt?: string;
  } = {},
): Promise<VoiceprintScoreReport> {
  validateManifest(manifest);

  const model = manifest.model ?? DEFAULT_MODEL;
  const thresholds = resolveVoiceprintThresholds(
    manifest.thresholds,
    options.thresholdOverrides,
  );

  const baseDir = options.baseDir ?? process.cwd();
  const enrollmentEmbeddings = await Promise.all(
    manifest.owner.enrollment.map((source) => loadVoiceprintEmbedding(source, baseDir, model)),
  );
  validateLoadedEmbeddingVectors(enrollmentEmbeddings, "owner enrollment");
  const ownerCentroid = meanVector(enrollmentEmbeddings.map((embedding) => embedding.vector));

  const rows: VoiceprintScoreRow[] = [];
  for (const sample of manifest.samples) {
    const loaded = await loadVoiceprintEmbedding(sample, baseDir, model);
    validateLoadedEmbeddingVectors([loaded], "sample", ownerCentroid.length);
    const similarity = safeCosineSimilarity(ownerCentroid, loaded.vector);
    const decision = classifyOwnerSimilarity(similarity, thresholds);
    const assessment = assessDecision(sample.expected, decision);
    rows.push({
      id: sample.id,
      expected: sample.expected,
      decision,
      similarity,
      passed: assessment.passed,
      risk: assessment.risk,
      route: sample.route,
      provider: loaded.provider,
      modelId: loaded.modelId,
      notes: sample.notes,
    });
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    ownerId: manifest.owner.id ?? "owner",
    model,
    thresholds,
    enrollment: {
      count: enrollmentEmbeddings.length,
      dim: ownerCentroid.length,
    },
    summary: summarizeRows(rows),
    rows,
  };
}

export function formatVoiceprintReport(report: VoiceprintScoreReport): string {
  const lines = [
    "Voiceprint threshold report",
    `Generated: ${report.generatedAt}`,
    `Owner: ${report.ownerId}`,
    `Model: ${report.model.provider}/${report.model.modelId}`,
    `Thresholds: ownerAccept=${report.thresholds.ownerAccept.toFixed(3)}, ownerPossible=${report.thresholds.ownerPossible.toFixed(3)}`,
    `Enrollment: ${report.enrollment.count} vectors, dim=${report.enrollment.dim}`,
    "",
    "Samples:",
  ];

  for (const row of report.rows) {
    const status =
      row.passed === null ? "unlabeled" : row.passed ? "pass" : "fail";
    lines.push(
      [
        `- ${row.id}`,
        `expected=${row.expected}`,
        `decision=${row.decision}`,
        `similarity=${row.similarity.toFixed(4)}`,
        `risk=${row.risk}`,
        `status=${status}`,
      ].join(" | "),
    );
  }

  lines.push(
    "",
    `Summary: total=${report.summary.total}, passed=${report.summary.passed}, failed=${report.summary.failed}, unlabeled=${report.summary.unlabeled}, falseAccepts=${report.summary.falseAccepts}, falseRejects=${report.summary.falseRejects}, possibleFalseAccepts=${report.summary.possibleFalseAccepts}`,
  );

  return `${lines.join("\n")}\n`;
}

function validateManifest(manifest: VoiceprintManifest): void {
  if (manifest.version !== 1) {
    throw new Error(`Unsupported voiceprint manifest version: ${String(manifest.version)}.`);
  }
  if (!manifest.owner?.enrollment?.length) {
    throw new Error("Voiceprint manifest needs at least one owner enrollment source.");
  }
  if (!Array.isArray(manifest.samples)) {
    throw new Error("Voiceprint manifest samples must be an array.");
  }
  if (manifest.samples.length === 0) {
    throw new Error("Voiceprint manifest needs at least one sample.");
  }

  const enrollmentIds = new Set<string>();
  for (const [index, source] of manifest.owner.enrollment.entries()) {
    if (!source?.id?.trim()) {
      throw new Error(`Voiceprint owner enrollment at index ${index} requires id.`);
    }
    if (enrollmentIds.has(source.id)) {
      throw new Error(`Duplicate voiceprint owner enrollment id: ${source.id}.`);
    }
    enrollmentIds.add(source.id);
  }

  const sampleIds = new Set<string>();
  for (const [index, sample] of manifest.samples.entries()) {
    if (!sample?.id?.trim()) {
      throw new Error(`Voiceprint sample at index ${index} requires id.`);
    }
    if (sampleIds.has(sample.id)) {
      throw new Error(`Duplicate voiceprint sample id: ${sample.id}.`);
    }
    sampleIds.add(sample.id);
    if (!VALID_EXPECTED_LABELS.has(sample.expected)) {
      throw new Error(
        `Voiceprint sample "${sample.id}" has invalid expected label: ${String(sample.expected)}.`,
      );
    }
  }
}

function assessDecision(
  expected: VoiceprintExpectedLabel,
  decision: VoiceprintDecision,
): Pick<VoiceprintScoreRow, "passed" | "risk"> {
  if (expected === "unknown") {
    return { passed: null, risk: "unlabeled" };
  }

  if (expected === "owner") {
    if (decision === "owner_speaking") {
      return { passed: true, risk: "ok" };
    }
    if (decision === "possible_owner") {
      return { passed: false, risk: "possible_owner_miss" };
    }
    return { passed: false, risk: "false_reject" };
  }

  if (decision === "owner_speaking") {
    return { passed: false, risk: "false_accept" };
  }
  if (decision === "possible_owner") {
    return { passed: false, risk: "possible_false_accept" };
  }
  return { passed: true, risk: "ok" };
}

function summarizeRows(rows: VoiceprintScoreRow[]): VoiceprintScoreReport["summary"] {
  return {
    total: rows.length,
    passed: rows.filter((row) => row.passed === true).length,
    failed: rows.filter((row) => row.passed === false).length,
    unlabeled: rows.filter((row) => row.passed === null).length,
    falseAccepts: rows.filter((row) => row.risk === "false_accept").length,
    falseRejects: rows.filter((row) => row.risk === "false_reject").length,
    possibleFalseAccepts: rows.filter((row) => row.risk === "possible_false_accept").length,
  };
}

function validateLoadedEmbeddingVectors(
  embeddings: readonly { sourceId: string; vector: number[]; dim: number }[],
  kind: string,
  expectedDim?: number,
): void {
  for (const embedding of embeddings) {
    if (!isUsableEmbeddingVector(embedding.vector)) {
      throw new Error(
        `Voiceprint ${kind} "${embedding.sourceId}" produced an invalid embedding.`,
      );
    }
    if (embedding.dim !== embedding.vector.length) {
      throw new Error(
        `Voiceprint ${kind} "${embedding.sourceId}" has inconsistent embedding dimensions.`,
      );
    }
    if (expectedDim !== undefined && embedding.vector.length !== expectedDim) {
      throw new Error(
        `Voiceprint ${kind} "${embedding.sourceId}" has dimension ${embedding.vector.length}; expected ${expectedDim}.`,
      );
    }
  }
}
