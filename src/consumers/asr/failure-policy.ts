// =============================================================================
// Failure policy for ASR transcription attempts.
//
// Single policy: retry-then-dead-letter. N attempts with exponential backoff +
// jitter; on permanent failure, write a dead-letter file for later manual replay.
//
// execute() returns T on success, null on permanent failure.
// =============================================================================

import { createSubsystemLogger } from "../../logging/index.js";
import { writeDeadLetter } from "./deadletter.js";

const log = createSubsystemLogger("asr/failure-policy");

export interface FailureCtx {
  media_id: string;
  wav_path: string;
  mime: string;
  backend: string;
}

export interface FailurePolicy {
  name: string;
  execute<T>(op: () => Promise<T>, ctx: FailureCtx): Promise<T | null>;
}

export interface RetryConfig {
  max_attempts: number;
  initial_ms: number;
  multiplier: number;
  jitter_ms: number;
}

const DEFAULT_RETRY: RetryConfig = {
  max_attempts: 3,
  initial_ms: 500,
  multiplier: 2.0,
  jitter_ms: 100,
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithRetry<T>(
  op: () => Promise<T>,
  retry: RetryConfig,
  ctx: FailureCtx,
): Promise<{ value?: T; error?: Error; attempts: number }> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= retry.max_attempts; attempt++) {
    try {
      const value = await op();
      return { value, attempts: attempt };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      log.warn("asr attempt failed", {
        media_id: ctx.media_id,
        attempt,
        max: retry.max_attempts,
        error: lastErr.message,
      });
      if (attempt === retry.max_attempts) break;
      const base = retry.initial_ms * Math.pow(retry.multiplier, attempt - 1);
      const jitter = Math.random() * retry.jitter_ms;
      await sleep(base + jitter);
    }
  }
  return { error: lastErr, attempts: retry.max_attempts };
}

// -----------------------------------------------------------------------------
// Impl
// -----------------------------------------------------------------------------

class RetryThenDeadLetterPolicy implements FailurePolicy {
  name = "retry-then-dead-letter";
  constructor(private retry: RetryConfig) {}
  async execute<T>(op: () => Promise<T>, ctx: FailureCtx): Promise<T | null> {
    const res = await runWithRetry(op, this.retry, ctx);
    if (res.value !== undefined) return res.value;
    log.error("asr retry-then-dead-letter writing dead-letter", {
      media_id: ctx.media_id,
      attempts: res.attempts,
      error: res.error?.message,
    });
    try {
      await writeDeadLetter({
        media_id: ctx.media_id,
        wav_path: ctx.wav_path,
        mime: ctx.mime,
        backend: ctx.backend,
        attempts: res.attempts,
        last_error: res.error?.message ?? "unknown",
        ts_iso: new Date().toISOString(),
      });
    } catch (err) {
      log.error("failed to write dead-letter (double fault)", {
        media_id: ctx.media_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export type PolicyName = "retry-then-dead-letter";

export function createFailurePolicy(
  name: PolicyName,
  retry: Partial<RetryConfig> = {},
): FailurePolicy {
  const r: RetryConfig = { ...DEFAULT_RETRY, ...retry };
  switch (name) {
    case "retry-then-dead-letter":
      return new RetryThenDeadLetterPolicy(r);
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown failure policy: ${exhaustive}`);
    }
  }
}
