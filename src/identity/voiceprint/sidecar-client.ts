import { spawn } from "node:child_process";
import {
  parseEmbeddingBatchResponseJson,
  validateEmbeddingBatchRequest,
  type VoiceprintEmbeddingBatchRequest,
  type VoiceprintEmbeddingBatchResponse,
} from "./sidecar-protocol.js";

/**
 * A fault in the embedding sidecar SUBPROCESS or host — spawn failure (ENOENT),
 * timeout, non-zero exit, stdout/stderr overflow, stdin write failure, or garbage
 * output that fails to parse. These are INFRASTRUCTURE / SERVER faults, NOT
 * client-request faults: callers that translate this to an RPC error should use
 * an internal/transient code (INTERNAL_ERROR) so client retry/backoff works, not
 * INVALID_REQUEST which would tell the client it sent a bad request.
 */
export class VoiceprintSidecarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "VoiceprintSidecarError";
  }
}

export interface EmbeddingSidecarCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export async function runEmbeddingSidecar(input: {
  sidecar: EmbeddingSidecarCommand;
  request: VoiceprintEmbeddingBatchRequest;
}): Promise<VoiceprintEmbeddingBatchResponse> {
  validateEmbeddingBatchRequest(input.request);

  const timeoutMs = input.sidecar.timeoutMs ?? 30_000;
  const maxStdoutBytes = input.sidecar.maxStdoutBytes ?? 5_000_000;
  const maxStderrBytes = input.sidecar.maxStderrBytes ?? 1_000_000;
  const requestIds = input.request.requests.map((request) => request.id);

  return new Promise((resolve, reject) => {
    const child = spawn(input.sidecar.command, input.sidecar.args ?? [], {
      cwd: input.sidecar.cwd,
      env: { ...process.env, ...input.sidecar.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(new VoiceprintSidecarError(`Voiceprint sidecar timed out after ${timeoutMs}ms.`)),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxStdoutBytes) {
        child.kill("SIGTERM");
        finish(() =>
          reject(new VoiceprintSidecarError("Voiceprint sidecar stdout exceeded maxStdoutBytes.")),
        );
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > maxStderrBytes) {
        child.kill("SIGTERM");
        finish(() =>
          reject(new VoiceprintSidecarError("Voiceprint sidecar stderr exceeded maxStderrBytes.")),
        );
      }
    });

    child.on("error", (error) => {
      // spawn failure (e.g. ENOENT for a missing command) — an infrastructure fault.
      finish(() =>
        reject(
          new VoiceprintSidecarError(`Voiceprint sidecar failed to run: ${errorMessage(error)}.`, {
            cause: error,
          }),
        ),
      );
    });

    child.stdin.on("error", (error) => {
      finish(() =>
        reject(new VoiceprintSidecarError(`Voiceprint sidecar stdin error: ${errorMessage(error)}.`)),
      );
    });

    child.on("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          reject(
            new VoiceprintSidecarError(
              `Voiceprint sidecar exited with code ${String(code)}${signal ? ` signal ${signal}` : ""}: ${sidecarFailureDetail(stdout, stderr)}`,
            ),
          );
          return;
        }

        try {
          resolve(parseEmbeddingBatchResponseJson(stdout, requestIds));
        } catch (error) {
          // Garbage / truncated / non-JSON sidecar output — a host/subprocess fault,
          // not a client-request fault. Preserve the parse detail as the cause.
          reject(
            new VoiceprintSidecarError(
              `Voiceprint sidecar produced an unparseable response: ${errorMessage(error)}.`,
              { cause: error },
            ),
          );
        }
      });
    });

    try {
      child.stdin.end(`${JSON.stringify(input.request)}\n`);
    } catch (error) {
      finish(() =>
        reject(new VoiceprintSidecarError(`Voiceprint sidecar stdin error: ${errorMessage(error)}.`)),
      );
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * On a non-zero exit the sidecar writes its JSON `{ "error": ... }` body to
 * STDOUT (per the protocol in services/voiceprint/embed.py), leaving stderr
 * empty. Prefer that parsed reason, then fall back to raw stdout, then stderr,
 * so the rejection surfaced to callers is diagnosable rather than a bare colon.
 */
function sidecarFailureDetail(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout) {
    try {
      const parsed = JSON.parse(trimmedStdout) as { error?: unknown };
      if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Not JSON; fall through to the raw stdout/stderr below.
    }
    return trimmedStdout;
  }
  return stderr.trim();
}
