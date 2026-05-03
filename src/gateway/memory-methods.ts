// =============================================================================
// Memory RPC methods (#653)
//
// Surfaces the four-tier memory system to WS clients (iOS Live testing tab)
// without going through an agent loop, mirroring tool-methods.ts (tool.invoke).
//
//   method: "memory.snapshot"
//     params: { daily_limit?: number }
//     result: { ok: true, snapshot: { soul, identity, global, daily[] } }
//
//   method: "memory.distill"   (channel: realtime:memory_distill)
//     params: { session_key?: string, scope: "daily" | "global", mock?: boolean }
//     result: { ok, scope, file, preview, mocked, note? }
//
// `memory.distill` makes at most ONE Haiku call via the provider factory
// (unless mock=true). It is intentionally NOT super fault-tolerant — failures
// are reflected as { ok: false, note } rather than RPC errors so the testing
// tab can render them inline.
// =============================================================================

import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import type { HawkyConfig } from "../agent/types.js";
import type { LLMProvider } from "../agent/provider.js";
import {
  distillMemory,
  readMemorySnapshot,
  DISTILL_SCOPES,
  type DistillScope,
} from "../memory/distill.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/memory-methods");

export interface MemoryMethodsOptions {
  /**
   * Optional LLM provider override for distillation. Production omits this so
   * distillMemory builds the real provider from config; tests/seeding inject a
   * stub to exercise the full path without a network call.
   */
  provider?: LLMProvider;
}

/**
 * Register memory.snapshot and memory.distill.
 *
 * @param getConfig - Lazily resolves the current gateway config so distillation
 *   uses the live provider/key (config can be re-set after /setup).
 */
export function registerMemoryMethods(
  server: GatewayServer,
  getConfig: () => HawkyConfig,
  options?: MemoryMethodsOptions,
): void {
  server.registerMethod("memory.snapshot", (_conn, params) => {
    const p = params as { daily_limit?: unknown } | undefined;
    const dailyLimit =
      p && typeof p.daily_limit === "number" && Number.isFinite(p.daily_limit)
        ? Math.max(1, Math.min(30, Math.floor(p.daily_limit)))
        : undefined;
    return { ok: true, snapshot: readMemorySnapshot({ dailyLimit }) };
  });

  server.registerMethod("memory.distill", async (_conn, params) => {
    const p = params as
      | { session_key?: unknown; scope?: unknown; mock?: unknown }
      | undefined;

    const scopeRaw = p && typeof p.scope === "string" ? p.scope.trim() : "";
    if (!DISTILL_SCOPES.includes(scopeRaw as DistillScope)) {
      throw new MethodError(
        "INVALID_REQUEST",
        `scope must be one of: ${DISTILL_SCOPES.join(", ")}`,
      );
    }
    const scope = scopeRaw as DistillScope;
    const sessionKey =
      p && typeof p.session_key === "string" ? p.session_key.trim() || undefined : undefined;
    const mock = Boolean(p && p.mock === true);

    const start = Date.now();
    try {
      const result = await distillMemory(
        getConfig(),
        { session_key: sessionKey, scope, mock },
        options?.provider ? { provider: options.provider } : undefined,
      );
      log.info("memory.distill", {
        scope,
        session_key: sessionKey ?? null,
        mock,
        ok: result.ok,
        file: result.file,
        duration_ms: Date.now() - start,
      });
      return result;
    } catch (err) {
      log.info("memory.distill failed", {
        scope,
        session_key: sessionKey ?? null,
        mock,
        duration_ms: Date.now() - start,
      });
      return {
        ok: false,
        scope,
        file: scope === "global" ? "MEMORY.md" : "memory/",
        preview: "",
        mocked: mock,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
