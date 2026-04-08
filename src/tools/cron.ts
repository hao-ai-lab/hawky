// =============================================================================
// Cron Tool
//
// Agent tool for managing cron jobs. The LLM can create, list, update,
// remove, and force-run cron jobs. Nesting prevention: refuses to create
// jobs from within headless execution (heartbeat/cron).
//
// Pattern: a proven cron-tool.ts — action-based dispatch, session target
// inference, nesting guard.
// =============================================================================

import type { ToolDefinition, ToolResult, ToolContext } from "../agent/types.js";

// The CronService instance is injected at registration time
let cronServiceRef: any = null;

export function setCronServiceRef(service: any): void {
  cronServiceRef = service;
}

export function getCronServiceRef(): any {
  return cronServiceRef;
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const cronToolDefinition: ToolDefinition = {
  name: "cron",
  description:
    "Manage scheduled cron jobs. Actions: add (create a new job), list (show all jobs), " +
    "update (modify a job), remove (delete a job), run (force-run now), status (scheduler info), " +
    "history (show recent runs for a job).",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "update", "remove", "run", "status", "history"],
        description: "The action to perform.",
      },
      // For "add"
      name: {
        type: "string",
        description: "Job name (required for add).",
      },
      description: {
        type: "string",
        description: "Job description (optional).",
      },
      schedule_kind: {
        type: "string",
        enum: ["cron", "every", "at"],
        description: "Schedule type: cron (expression), every (interval), at (one-shot).",
      },
      cron_expr: {
        type: "string",
        description: "Cron expression (for schedule_kind=cron). E.g., '0 9 * * 1-5' for 9am weekdays.",
      },
      timezone: {
        type: "string",
        description: "IANA timezone for cron expression. E.g., 'America/Los_Angeles'.",
      },
      every_minutes: {
        type: "number",
        description: "Interval in minutes (for schedule_kind=every).",
      },
      at: {
        type: "string",
        description: "When to run (for schedule_kind=at). ISO datetime or relative like '+2h', '+30m'.",
      },
      message: {
        type: "string",
        description: "The prompt/instruction for the agent to execute on each run.",
      },
      session_target: {
        type: "string",
        enum: ["isolated", "current"],
        description: "Session target: 'isolated' (own cron session, default — always use this for one-time jobs) or 'current' (fire into current chat — only for recurring lightweight reminders).",
      },
      session_name: {
        type: "string",
        description: "Named persistent session (e.g., 'standup'). Creates session:standup for multi-turn history.",
      },
      heartbeat_bridge: {
        type: "boolean",
        description: "If true, results are also sent to heartbeat for batched triage.",
      },
      // delivery_target was removed from the agent-facing tool surface.
      // Cron jobs each run in their own cron:<name> session, which is now
      // a first-class chattable thread the user can open from the sidebar.
      // The schema field is preserved on CronJob for back-compat reading
      // of older jobs.json files, but is ignored at runtime — see cron.ts
      // and CronJob.delivery_target's @deprecated note in cron-store.ts.
      delete_after_run: {
        type: "boolean",
        description: "For one-shot jobs: delete after successful run (default: true for at schedule).",
      },
      // For "update" / "remove" / "run"
      job_id: {
        type: "string",
        description: "Job ID or name (required for update, remove, run, history).",
      },
      // For "update"
      enabled: {
        type: "boolean",
        description: "Enable or disable a job (for update).",
      },
    },
    required: ["action"],
  },
  permission: "auto_approve",

  execute: async (input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    if (!cronServiceRef) {
      return { type: "error", content: "Cron service not available. Is the gateway running?" };
    }

    const action = input.action as string;

    // Nesting prevention: don't create jobs from headless execution
    if (action === "add" && context.headless) {
      return { type: "error", content: "Cannot create cron jobs from within a cron/heartbeat execution." };
    }

    // Helper: resolve job by ID or name
    const resolveJob = (idOrName: string) => {
      const byId = cronServiceRef.getJob(idOrName);
      if (byId) return byId;
      const all = cronServiceRef.listJobs(true);
      return all.find((j: any) => j.name.toLowerCase() === idOrName.toLowerCase()) ?? null;
    };

    try {
      switch (action) {
        case "status": {
          const status = cronServiceRef.getStatus();
          return {
            type: "text",
            content: JSON.stringify(status, null, 2),
          };
        }

        case "list": {
          const jobs = cronServiceRef.listJobs(true);
          if (jobs.length === 0) {
            return { type: "text", content: "No cron jobs found." };
          }
          const lines = jobs.map((j: any) => {
            const next = j.state.nextRunAtMs
              ? new Date(j.state.nextRunAtMs).toLocaleString()
              : "N/A";
            const status = j.enabled ? "enabled" : "disabled";
            return `• ${j.name} (${j.id}) [${status}] — next: ${next}`;
          });
          return { type: "text", content: lines.join("\n") };
        }

        case "add": {
          const name = input.name as string;
          const message = input.message as string;
          if (!name || !message) {
            return { type: "error", content: "name and message are required for add." };
          }

          // Build schedule
          const scheduleKind = (input.schedule_kind as string) ?? "every";
          let schedule: any;

          if (scheduleKind === "cron") {
            const expr = input.cron_expr as string;
            if (!expr) return { type: "error", content: "cron_expr is required for cron schedule." };
            schedule = { kind: "cron", expr, tz: input.timezone as string | undefined };
          } else if (scheduleKind === "every") {
            const minutes = input.every_minutes as number;
            if (!minutes || minutes < 1) return { type: "error", content: "every_minutes must be >= 1." };
            schedule = { kind: "every", everyMs: minutes * 60_000 };
          } else if (scheduleKind === "at") {
            const at = input.at as string;
            if (!at) return { type: "error", content: "at is required for at schedule." };
            schedule = { kind: "at", at };
          } else {
            return { type: "error", content: `Unknown schedule_kind: ${scheduleKind}` };
          }

          // Resolve session target
          let sessionTarget: string = "isolated";
          let sessionKey: string | undefined;
          if (input.session_name) {
            sessionTarget = `session:${input.session_name}`;
          } else if (input.session_target === "current") {
            sessionTarget = "current";
            sessionKey = context.session_id;
          }

          // Note: input.delivery_target is intentionally not passed through.
          // The field is removed from the tool's input_schema and any value
          // an older agent template tries to set is dropped at the input
          // layer before it can reach the store. New jobs land in their
          // own cron:<name> session and the user opens that session to
          // read or follow up.
          const job = cronServiceRef.addJob({
            name,
            description: input.description as string | undefined,
            schedule,
            payload: { message },
            sessionTarget,
            sessionKey,
            heartbeatBridge: input.heartbeat_bridge as boolean | undefined,
            deleteAfterRun: input.delete_after_run as boolean | undefined ??
              (scheduleKind === "at" ? true : undefined),
          });

          const nextRun = job.state.nextRunAtMs
            ? new Date(job.state.nextRunAtMs).toLocaleString()
            : "N/A";
          return {
            type: "text",
            content: `Created cron job "${job.name}" (${job.id}). Next run: ${nextRun}.`,
          };
        }

        case "update": {
          const jobId = input.job_id as string;
          if (!jobId) return { type: "error", content: "job_id is required for update." };

          // Resolve by ID or name (consistent with remove/run)
          const jobToUpdate = resolveJob(jobId);
          if (!jobToUpdate) return { type: "error", content: `Job not found: ${jobId}` };

          const patch: any = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.description !== undefined) patch.description = input.description;
          if (input.enabled !== undefined) patch.enabled = input.enabled;
          if (input.message !== undefined) patch.payload = { message: input.message };
          // delivery_target intentionally dropped — see addJob above.
          if (input.heartbeat_bridge !== undefined) patch.heartbeatBridge = input.heartbeat_bridge;
          if (input.delete_after_run !== undefined) patch.deleteAfterRun = input.delete_after_run;

          // Schedule update — rebuild schedule object from provided fields
          const scheduleKind = input.schedule_kind as string | undefined;
          const everyMinutes = input.every_minutes as number | undefined;
          const cronExpr = input.cron_expr as string | undefined;
          const at = input.at as string | undefined;
          const timezone = input.timezone as string | undefined;

          if (scheduleKind || everyMinutes !== undefined || cronExpr || at) {
            // Determine the target schedule kind (explicit or inferred from fields)
            const kind = scheduleKind
              ?? (everyMinutes !== undefined ? "every" : undefined)
              ?? (cronExpr ? "cron" : undefined)
              ?? (at ? "at" : undefined)
              ?? jobToUpdate.schedule.kind; // fall back to existing kind

            if (kind === "every") {
              const minutes = everyMinutes ?? (jobToUpdate.schedule.everyMs ? jobToUpdate.schedule.everyMs / 60_000 : undefined);
              if (!minutes || minutes < 1) return { type: "error", content: "every_minutes must be >= 1." };
              patch.schedule = { kind: "every", everyMs: minutes * 60_000 };
            } else if (kind === "cron") {
              const expr = cronExpr ?? jobToUpdate.schedule.expr;
              if (!expr) return { type: "error", content: "cron_expr is required for cron schedule." };
              patch.schedule = { kind: "cron", expr, tz: timezone ?? jobToUpdate.schedule.tz };
            } else if (kind === "at") {
              const atVal = at ?? jobToUpdate.schedule.at;
              if (!atVal) return { type: "error", content: "at is required for at schedule." };
              patch.schedule = { kind: "at", at: atVal };
            }
          } else if (timezone && !scheduleKind && !cronExpr) {
            // Only timezone changed — update existing cron schedule
            if (jobToUpdate.schedule.kind === "cron") {
              patch.schedule = { ...jobToUpdate.schedule, tz: timezone };
            }
          }

          // Warn if nothing to update
          if (Object.keys(patch).length === 0) {
            return { type: "text", content: `No fields to update for job "${jobToUpdate.name}" (${jobToUpdate.id}). Specify fields to change.` };
          }

          const updated = cronServiceRef.updateJob(jobToUpdate.id, patch);
          if (!updated) return { type: "error", content: `Failed to update job: ${jobToUpdate.id}` };

          const parts = [`Updated job "${updated.name}" (${updated.id}).`];
          if (patch.schedule) {
            const nextRun = updated.state.nextRunAtMs
              ? new Date(updated.state.nextRunAtMs).toLocaleString()
              : "N/A";
            parts.push(`Schedule changed. Next run: ${nextRun}.`);
          }
          return { type: "text", content: parts.join(" ") };
        }

        case "remove": {
          const jobId = input.job_id as string;
          if (!jobId) return { type: "error", content: "job_id is required for remove." };

          const jobToRemove = resolveJob(jobId);
          if (!jobToRemove) return { type: "error", content: `Job not found: ${jobId}` };
          cronServiceRef.removeJob(jobToRemove.id);
          return { type: "text", content: `Removed job "${jobToRemove.name}" (${jobToRemove.id}).` };
        }

        case "run": {
          const jobId = input.job_id as string;
          if (!jobId) return { type: "error", content: "job_id is required for run." };

          const jobToRun = resolveJob(jobId);
          if (!jobToRun) return { type: "error", content: `Job not found: ${jobId}. Use the job ID or exact name.` };

          // Fire async — don't block the current agent turn (avoids RPC timeout)
          void cronServiceRef.forceRun(jobToRun.id).catch(() => {});
          return { type: "text", content: `Triggered job "${jobToRun.name}" (${jobToRun.id}). It will run in the background.` };
        }

        case "history": {
          const jobId = input.job_id as string;
          if (!jobId) return { type: "error", content: "job_id is required for history." };

          const jobForHistory = resolveJob(jobId);
          if (!jobForHistory) return { type: "error", content: `Job not found: ${jobId}` };
          const runs = cronServiceRef.getRunHistory(jobForHistory.id, 10);
          if (runs.length === 0) {
            return { type: "text", content: `No run history for job "${jobForHistory.name}" (${jobForHistory.id}).` };
          }
          const lines = runs.map((r: any) => {
            const date = new Date(r.ts).toLocaleString();
            const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "?";
            const err = r.error ? ` — ${r.error.slice(0, 100)}` : "";
            const summary = r.summary ? ` — ${r.summary.slice(0, 100)}` : "";
            return `• ${date} [${r.status}] (${dur})${err}${summary}`;
          });
          return { type: "text", content: `Run history for job ${jobId}:\n${lines.join("\n")}` };
        }

        default:
          return { type: "error", content: `Unknown action: ${action}` };
      }
    } catch (err) {
      return {
        type: "error",
        content: `Cron tool error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
