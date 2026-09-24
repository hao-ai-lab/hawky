import type { HawkyConfig } from "../agent/types.js";
import type { LLMProvider } from "../agent/provider.js";
import { listSessions } from "../storage/session.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { distillMemory } from "./distill.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("memory/session-scheduler");

/** Maintenance and child-worker prompts must not become personal memories.
 * Delegated results spoken in the parent Live conversation are already there. */
export function isConversationMemorySource(id: string): boolean {
  return !/^(heartbeat|cron|subagent|delegations|realtime-events|memory)(?:[:/]|$)/.test(id)
    && !/-(?:(?:codex|claude)-)?bridge$|-work-/.test(id);
}

export class SessionMemoryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = false;
  private nextSession = 0;

  constructor(private readonly options: {
    getConfig: () => HawkyConfig;
    workspace?: WorkspaceManager;
    provider?: LLMProvider;
    now?: () => number;
    intervalMs?: number;
  }) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch(error => log.warn("session memory tick failed", { error: String(error) }));
    }, this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
    log.info("session memory scheduler started", { intervalMs: this.options.intervalMs ?? 60_000 });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const result = { updated: 0, failed: 0, skipped: 0 };
    if (this.inFlight || this.stopped || this.options.getConfig().memory?.session_enabled === false) return result;
    this.inFlight = true;
    try {
      const now = new Date(this.options.now?.() ?? Date.now());
      const sessions = listSessions(500).filter(s => isConversationMemorySource(s.id)
        && s.lastModified >= now.getTime() - 7 * 86_400_000 && s.messageCount > 0);
      // Rotate fairly through sessions. At most two model attempts per tick,
      // with per-session cooldown and one in-flight tick for a bounded workload.
      for (let i = 0; i < sessions.length && !this.stopped; i++) {
        const session = sessions[this.nextSession % sessions.length]!;
        this.nextSession = (this.nextSession + 1) % sessions.length;
        const config = this.options.getConfig();
        if (config.memory?.session_enabled === false) break;
        const outcome = await distillMemory(config, { scope: "daily", session_key: session.id, automatic: true }, {
          workspace: this.options.workspace ?? new WorkspaceManager(config.workspace_dir),
          provider: this.options.provider, now, session,
        });
        if (!outcome.ok) {
          result.failed++;
          log.warn("session memory extraction failed; will retry", { session: session.id, error: outcome.note });
        } else if (outcome.skipped) result.skipped++;
        else result.updated++;
        if (result.updated + result.failed >= 2) break;
      }
      return result;
    } finally { this.inFlight = false; }
  }
}
