// =============================================================================
// /doctor — System Health Check
//
// Read-only diagnostic that reports the status of all subsystems.
// Two output modes:
//   - CLI: `hawky doctor` → colored chalk output in terminal
//   - TUI: `/doctor` slash command → plain text system message
// =============================================================================

import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getConfigPath } from "../storage/config.js";
import type { HawkyConfig } from "../agent/types.js";
import { WorkspaceManager, getWorkspaceDir, WORKSPACE_FILES } from "../storage/workspace.js";
import { buildSkillStatusReport, formatSkillStatusReport } from "../skills/status.js";
import { getHeartbeatConfigStatus, formatHeartbeatStatus } from "../gateway/heartbeat-setup.js";
import { getCachedCatalog, KNOWN_OPENAI_MODELS } from "../agent/openai-models.js";
import { validateOpenAICompatibleEndpoint } from "../storage/config-validators.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface DoctorReport {
  sections: DoctorSection[];
}

export interface DoctorSection {
  title: string;
  lines: string[];
}

// -----------------------------------------------------------------------------
// Safe config reader (read-only — never creates file)
// -----------------------------------------------------------------------------

function readConfigSafe(): HawkyConfig | null {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Individual checks
// -----------------------------------------------------------------------------

function checkApiKeys(): DoctorSection {
  const config = readConfigSafe();
  if (!config) {
    return { title: "API Keys", lines: ["Config file not found — run /setup"] };
  }
  const lines: string[] = [];

  // Which LLM backend is in use? This changes what counts as "required"
  // for the chat path — Vertex runs on Google ADC, so the Anthropic key
  // is informational only when provider: "vertex" is active.
  const provider = config.provider ?? "anthropic";

  if (provider === "vertex") {
    const projectId = config.vertex?.project_id ?? "";
    const region = config.vertex?.region ?? "global";
    lines.push(`• Provider: Vertex AI (project: ${projectId || "— MISSING —"}, region: ${region})`);
    lines.push(
      projectId
        ? "✓ Vertex project_id configured"
        : "✗ Vertex project_id missing (required) — see deploy/VERTEX_SETUP.md",
    );
    lines.push("• ADC auth: verify with `gcloud auth application-default print-access-token`");
  } else if (provider === "openai") {
    const keySource = process.env.OPENAI_API_KEY
      ? "env OPENAI_API_KEY"
      : config.api_keys.openai
        ? "config api_keys.openai"
        : "— MISSING —";
    const probed = getCachedCatalog();
    const catalogLine = probed
      ? `• Model catalog: probe (${probed.length} models)`
      : `• Model catalog: fallback (${KNOWN_OPENAI_MODELS.length} models)`;
    const baseURL = config.openai_base_url;
    lines.push(baseURL
      ? `• Provider: OpenAI`
      : "• Provider: OpenAI (api.openai.com)");
    if (baseURL) lines.push(`• Endpoint: ${baseURL}`);
    lines.push(`• Key source: ${keySource}`);
    lines.push(`• Model: ${config.model || "— not set —"}`);
    lines.push(catalogLine);
  } else if (provider === "openai_compatible") {
    const compat = config.openai_compatible;
    const activeName = compat?.active_profile || "— UNSET —";
    lines.push("• Provider: OpenAI-compatible");
    lines.push(`• Active profile: ${activeName}`);
    const profile = compat?.active_profile ? compat.profiles?.[compat.active_profile] : undefined;
    if (profile) {
      lines.push(`  Endpoint: ${profile.base_url}`);
      const keySource = profile.api_key
        ? "literal"
        : profile.api_key_env
          ? `env ${profile.api_key_env}`
          : config.api_keys?.openai
            ? "api_keys.openai"
            : process.env.OPENAI_API_KEY
              ? "OPENAI_API_KEY env"
              : "MISSING";
      lines.push(`  Key source: ${keySource}`);
      lines.push(`  Model: ${profile.model || config.model || "— not set —"}`);
    }
    const profiles = compat?.profiles ?? {};
    for (const [name, p] of Object.entries(profiles)) {
      if (name !== compat?.active_profile) {
        lines.push(`  ◦ ${name} → ${p.base_url}`);
      }
    }
  } else {
    lines.push("• Provider: Anthropic (direct api.anthropic.com)");
  }

  const keys: Array<{ name: string; value: string; required: boolean }> = [
    {
      name: "Anthropic",
      value: config.api_keys.anthropic,
      required: provider === "anthropic",
    },
    { name: "Brave Search", value: config.api_keys.brave_search, required: false },
    { name: "OpenAI", value: config.api_keys.openai, required: provider === "openai" },
  ];

  for (const key of keys) {
    const configured = !!key.value;
    const icon = configured ? "✓" : key.required ? "✗" : "·";
    const suffix = configured
      ? "configured"
      : key.required
        ? "missing (required)"
        : "missing (optional)";
    lines.push(`${icon} ${key.name.padEnd(14)} ${suffix}`);
  }

  return { title: "API Keys", lines };
}

function checkSkills(): DoctorSection {
  try {
    const wsDir = getWorkspaceDir();
    const report = buildSkillStatusReport(wsDir);
    const formatted = formatSkillStatusReport(report);
    return { title: "Skills", lines: formatted.split("\n") };
  } catch {
    return { title: "Skills", lines: ["Could not check skill status."] };
  }
}

function checkHeartbeat(): DoctorSection {
  const config = readConfigSafe();
  if (!config) return { title: "Heartbeat", lines: ["Config not found"] };
  const status = getHeartbeatConfigStatus(config);
  const formatted = formatHeartbeatStatus(status);
  return { title: "Heartbeat", lines: formatted.split("\n") };
}

function checkCron(): DoctorSection {
  const config = readConfigSafe();
  if (!config) return { title: "Cron", lines: ["Config not found"] };
  const enabled = config.cron?.enabled !== false;
  return {
    title: "Cron",
    lines: [`${enabled ? "enabled" : "disabled"}`],
  };
}

function checkMemory(): DoctorSection {
  const lines: string[] = [];
  try {
    const wsDir = getWorkspaceDir();
    const ws = new WorkspaceManager(wsDir);

    const memoryMd = ws.readFile("MEMORY.md");
    if (memoryMd !== null) {
      const lineCount = memoryMd.split("\n").length;
      lines.push(`MEMORY.md: ${lineCount} lines`);
    } else {
      lines.push("MEMORY.md: not found");
    }

    const dailyLogs = ws.listDailyLogs();
    lines.push(`Daily logs: ${dailyLogs.length} files`);
    if (dailyLogs.length > 0) {
      lines.push(`Range: ${dailyLogs[0]} → ${dailyLogs[dailyLogs.length - 1]}`);
    }
  } catch {
    lines.push("Could not check memory status.");
  }

  return { title: "Memory", lines };
}

function checkWorkspaceFiles(): DoctorSection {
  const lines: string[] = [];
  try {
    const wsDir = getWorkspaceDir();
    const present: string[] = [];
    const missing: string[] = [];

    for (const filename of WORKSPACE_FILES) {
      if (existsSync(join(wsDir, filename))) {
        present.push(filename);
      } else {
        missing.push(filename);
      }
    }

    if (present.length > 0) {
      lines.push(`✓ ${present.join("  ")}`);
    }
    if (missing.length > 0) {
      lines.push(`✗ ${missing.join("  ")} (missing)`);
    }
  } catch {
    lines.push("Could not check workspace files.");
  }

  return { title: "Workspace Files", lines };
}

function checkConfig(activeModel?: string): DoctorSection {
  const lines: string[] = [];
  const configPath = getConfigPath();
  const config = readConfigSafe();

  if (!config) {
    lines.push(`Config: ${configPath} (not found)`);
    if (activeModel) lines.push(`Model: ${activeModel} (active session)`);
    return { title: "Config", lines };
  }

  lines.push(`Config: ${configPath}`);
  lines.push(`Model: ${activeModel ?? config.model}`);
  lines.push(`Gateway port: ${config.gateway_port}`);
  if (config.setup_completed_at) {
    lines.push(`Setup completed: ${config.setup_completed_at}`);
  } else {
    lines.push(`Setup: not completed (run /setup)`);
  }

  return { title: "Config", lines };
}

// -----------------------------------------------------------------------------
// Main report
// -----------------------------------------------------------------------------

/**
 * Run health checks and return a structured report.
 * Used by `hawky doctor` CLI, the `doctor.run` gateway RPC, and the TUI /doctor slash command.
 */
export function runDoctorChecks(activeModel?: string): DoctorReport {
  return {
    sections: [
      checkConfig(activeModel),
      checkApiKeys(),
      checkSkills(),
      checkHeartbeat(),
      checkCron(),
      checkMemory(),
      checkWorkspaceFiles(),
    ],
  };
}

/**
 * Run health checks with async reachability probes for openai/openai_compatible endpoints.
 * Augments the API Keys section with live /v1/models ping results.
 * Used by `hawky doctor` CLI and the `doctor.run` gateway RPC.
 */
export async function runDoctorChecksAsync(activeModel?: string): Promise<DoctorReport> {
  const report = runDoctorChecks(activeModel);
  const config = readConfigSafe();
  if (!config) return report;

  const provider = config.provider ?? "anthropic";
  const reachabilityLines: string[] = [];

  if (provider === "openai" && config.openai_base_url) {
    const apiKey = config.api_keys?.openai || process.env.OPENAI_API_KEY;
    const result = await validateOpenAICompatibleEndpoint(config.openai_base_url, apiKey);
    reachabilityLines.push(formatReachability(config.openai_base_url, result));
  } else if (provider === "openai_compatible") {
    const compat = config.openai_compatible;
    const activeName = compat?.active_profile;
    const profile = activeName ? compat?.profiles?.[activeName] : undefined;
    if (profile?.base_url) {
      const apiKey = profile.api_key ||
        (profile.api_key_env ? process.env[profile.api_key_env] : undefined) ||
        config.api_keys?.openai ||
        process.env.OPENAI_API_KEY;
      const result = await validateOpenAICompatibleEndpoint(profile.base_url, apiKey);
      reachabilityLines.push(formatReachability(profile.base_url, result));
    }
  }

  if (reachabilityLines.length > 0) {
    const apiSection = report.sections.find((s) => s.title === "API Keys");
    if (apiSection) {
      apiSection.lines.push(...reachabilityLines);
    }
  }

  return report;
}

function formatReachability(
  baseURL: string,
  result: Awaited<ReturnType<typeof validateOpenAICompatibleEndpoint>>,
): string {
  if (!result.valid && result.status === undefined && result.error?.includes("timeout")) {
    return `✗ /v1/models unreachable: timeout after 3s`;
  }
  if (!result.valid && result.status === 401) {
    return `✗ /v1/models returned 401 — check api_key`;
  }
  if (!result.valid && result.status !== undefined) {
    return `✗ /v1/models returned ${result.status} — ${result.error ?? "error"}`;
  }
  if (!result.valid) {
    return `✗ /v1/models unreachable: ${result.error ?? "unknown error"}`;
  }
  if (result.status === 404) {
    return `⚠ /v1/models returned 404 — endpoint may be raw llama.cpp`;
  }
  if (result.error) {
    return `⚠ /v1/models reachable (${result.modelCount ?? 0} models, ${result.latencyMs}ms) — ${result.error}`;
  }
  return `✓ /v1/models reachable (${result.modelCount ?? 0} models, ${result.latencyMs}ms)`;
}

/**
 * Format as plain text (for TUI slash command system messages).
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["Health Check", ""];

  for (const section of report.sections) {
    lines.push(`  ${section.title}`);
    for (const line of section.lines) {
      lines.push(`    ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Colored CLI output (for `hawky doctor`)
// -----------------------------------------------------------------------------

function colorizeLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("✓")) return line.replace("✓", chalk.green("✓")).replace(/configured|enabled/g, (m) => chalk.green(m));
  if (trimmed.startsWith("✗")) return line.replace("✗", chalk.red("✗")).replace(/missing[^)]*|not found|not configured/g, (m) => chalk.red(m));
  if (trimmed.startsWith("Install:") || trimmed.startsWith("Auth needed:")) return chalk.yellow(line);
  if (trimmed.includes("configured")) return line.replace(/configured/g, chalk.green("configured"));
  if (trimmed.includes("missing") || trimmed.includes("not found") || trimmed.includes("not completed")) return line.replace(/missing[^)]*|not found|not completed[^)"]*/g, (m) => chalk.red(m));
  if (trimmed.includes("enabled") && !trimmed.includes("disabled")) return line.replace(/enabled/g, chalk.green("enabled"));
  if (trimmed.includes("disabled")) return line.replace(/disabled/g, chalk.yellow("disabled"));
  return line;
}

/**
 * Print colored report to stdout. Used by `hawky doctor` CLI.
 */
export function printDoctorReport(report: DoctorReport): void {
  console.log();
  console.log(chalk.bold("  Health Check"));
  console.log();

  for (const section of report.sections) {
    console.log(chalk.bold(`  ${section.title}`));
    for (const line of section.lines) {
      console.log(`    ${colorizeLine(line)}`);
    }
    console.log();
  }
}
