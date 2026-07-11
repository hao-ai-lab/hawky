/**
 * FAIL-CLOSED marker: a single sidecar RESPONSE carried a per-turn embedding that
 * is unusable for scoring (empty / NaN / infinite / zero-norm / wrong dimension).
 * This is a DATA-QUALITY fault isolated to ONE turn — never a batch-integrity or
 * security-guard fault — so the batch scorer catches it and marks ONLY that turn
 * skipped (fail-closed: skipped never resolves) instead of throwing out and losing
 * the good turns. Structural faults (id/model mismatch, reference-model guard,
 * duplicate ids) are NOT this error and still throw as clean typed precondition
 * failures.
 *
 * The batch-scoring path detects this fault by TYPE (`instanceof`), not by matching
 * the message text, so rewording the human-readable message can never silently flip
 * a skippable per-turn fault into a batch failure (or vice-versa). The message text
 * is still preserved verbatim at each throw site for callers/tests that assert on it,
 * and for the transport-parser path where this error is thrown but simply propagates
 * as a plain `Error` subclass (it is never reclassified there).
 */
export class UnusableVoiceprintEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableVoiceprintEmbeddingError";
  }
}
