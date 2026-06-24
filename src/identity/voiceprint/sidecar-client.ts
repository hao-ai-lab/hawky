import { spawn } from "node:child_process";
import {
  parseEmbeddingBatchResponseJson,
  validateEmbeddingBatchRequest,
  type VoiceprintEmbeddingBatchRequest,
  type VoiceprintEmbeddingBatchResponse,
} from "./sidecar-protocol.js";

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
      finish(() => reject(new Error(`Voiceprint sidecar timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxStdoutBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("Voiceprint sidecar stdout exceeded maxStdoutBytes.")));
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > maxStderrBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("Voiceprint sidecar stderr exceeded maxStderrBytes.")));
      }
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.stdin.on("error", (error) => {
      finish(() =>
        reject(new Error(`Voiceprint sidecar stdin error: ${errorMessage(error)}.`)),
      );
    });

    child.on("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          reject(
            new Error(
              `Voiceprint sidecar exited with code ${String(code)}${signal ? ` signal ${signal}` : ""}: ${stderr.trim()}`,
            ),
          );
          return;
        }

        try {
          resolve(parseEmbeddingBatchResponseJson(stdout, requestIds));
        } catch (error) {
          reject(error);
        }
      });
    });

    try {
      child.stdin.end(`${JSON.stringify(input.request)}\n`);
    } catch (error) {
      finish(() =>
        reject(new Error(`Voiceprint sidecar stdin error: ${errorMessage(error)}.`)),
      );
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
