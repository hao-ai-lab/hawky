// =============================================================================
// Migrate Command
//
// Export and import Hawky state for machine-to-machine migration.
// Creates a tar.gz archive of all portable state (workspace, sessions,
// config, cron, skills, usage) excluding machine-specific files.
//
// Usage:
//   hawky export [--output path]
//   hawky import <archive> [--force]
// =============================================================================

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { hostname } from "node:os";
import { getConfigDir } from "../storage/config.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MANIFEST_VERSION = 1;

/** Files/directories to include in the export (relative to ~/.hawky/) */
const INCLUDE_PATHS = [
  "workspace",
  "sessions",
  "config.json",
  "permissions.json",
  "history.jsonl",
  "heartbeat-state.json",
  "cron",
  "skills",
  "usage",
  "state/screenshots",
];

/** Glob patterns to exclude from the archive */
const EXCLUDE_PATTERNS = [
  "*.bak",
  "*.db",
  "*.db-shm",
  "*.db-wal",
  ".last-session",
];

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

export async function runExport(outputPath?: string): Promise<void> {
  const configDir = getConfigDir();

  if (!existsSync(configDir)) {
    console.error("  No Hawky data found at", configDir);
    process.exit(1);
  }

  // Build manifest
  const manifest = buildManifest(configDir);
  const manifestPath = join(configDir, "MANIFEST.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Determine output path
  const date = new Date().toISOString().slice(0, 10);
  const archivePath = outputPath ?? `hawky-export-${date}.tar.gz`;

  // Build list of paths that actually exist
  const existingPaths = INCLUDE_PATHS.filter((p) => existsSync(join(configDir, p)));
  existingPaths.push("MANIFEST.json");

  // Build exclude flags
  const excludeFlags = EXCLUDE_PATTERNS.flatMap((p) => ["--exclude", p]);

  console.log("\n  Exporting Hawky data...\n");

  const proc = Bun.spawn(
    ["tar", "czf", archivePath, "-C", configDir, ...excludeFlags, ...existingPaths],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Clean up manifest file
  try { require("fs").unlinkSync(manifestPath); } catch {}

  if (exitCode !== 0) {
    console.error("  Export failed:", stderr.trim());
    process.exit(1);
  }

  // Report
  const stat = statSync(archivePath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

  console.log(`  Archive: ${archivePath} (${sizeMB} MB)`);
  console.log(`  Sessions: ${manifest.sessionCount}`);
  console.log(`  Workspace files: ${manifest.workspaceFiles}`);
  console.log(`  Cron jobs: ${manifest.cronJobs}`);
  if (manifest.skillCount > 0) console.log(`  Custom skills: ${manifest.skillCount}`);
  console.log(`\n  To import on another machine:`);
  console.log(`  $ hawky import ${basename(archivePath)}\n`);
}

// -----------------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------------

export async function runImport(archivePath: string, force?: boolean): Promise<void> {
  if (!archivePath) {
    console.error("  Usage: hawky import <archive.tar.gz> [--force]");
    process.exit(1);
  }

  if (!existsSync(archivePath)) {
    console.error(`  Archive not found: ${archivePath}`);
    process.exit(1);
  }

  const configDir = getConfigDir();

  // Check if data already exists
  if (existsSync(join(configDir, "config.json")) && !force) {
    console.error("\n  Hawky data already exists at", configDir);
    console.error("  Use --force to overwrite existing data.\n");
    process.exit(1);
  }

  // Validate archive has MANIFEST.json
  const checkProc = Bun.spawn(
    ["tar", "tzf", archivePath, "MANIFEST.json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const checkExit = await checkProc.exited;
  if (checkExit !== 0) {
    console.error("  Invalid archive: MANIFEST.json not found. Is this a Hawky export?");
    process.exit(1);
  }

  // Read manifest from archive
  const manifestProc = Bun.spawn(
    ["tar", "xzf", archivePath, "-C", "/tmp", "MANIFEST.json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await manifestProc.exited;

  let manifest: ExportManifest | null = null;
  try {
    manifest = JSON.parse(readFileSync("/tmp/MANIFEST.json", "utf-8"));
  } catch {}
  try { require("fs").unlinkSync("/tmp/MANIFEST.json"); } catch {}

  console.log("\n  Importing Hawky data...\n");

  if (manifest) {
    console.log(`  From: ${manifest.hostname} (exported ${manifest.exportedAt.slice(0, 10)})`);
    console.log(`  Sessions: ${manifest.sessionCount}, Workspace files: ${manifest.workspaceFiles}`);
    console.log();
  }

  // Extract to staging directory first (crash-safe: target untouched on failure)
  const stagingDir = join(configDir + "-import-staging-" + Date.now());
  mkdirSync(stagingDir, { recursive: true });

  const proc = Bun.spawn(
    ["tar", "xzf", archivePath, "-C", stagingDir],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Clean up failed staging
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    console.error("  Import failed:", stderr.trim());
    process.exit(1);
  }

  // Clean up manifest from staging (it's metadata, not user data)
  try { require("fs").unlinkSync(join(stagingDir, "MANIFEST.json")); } catch {}

  // If --force and target exists, back up then replace portable subtrees
  if (force && existsSync(configDir)) {
    const backupDir = configDir + "-backup-" + Date.now();
    try { renameSync(configDir, backupDir); } catch {}
    console.log(`  Backed up existing data to ${backupDir}`);
  }

  // Move staging into place
  mkdirSync(configDir, { recursive: true });

  // Move each item from staging to target
  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    const src = join(stagingDir, entry.name);
    const dst = join(configDir, entry.name);
    try { renameSync(src, dst); } catch {
      // Cross-device: fall back to copy
      Bun.spawnSync(["cp", "-r", src, dst]);
    }
  }

  // Clean up staging
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}

  console.log("  Import complete. Start the gateway to resume:\n");
  console.log("  $ bun run gateway\n");
}

// -----------------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------------

interface ExportManifest {
  version: number;
  exportedAt: string;
  hawkyVersion: string;
  hostname: string;
  sessionCount: number;
  workspaceFiles: number;
  cronJobs: number;
  skillCount: number;
}

function buildManifest(configDir: string): ExportManifest {
  let sessionCount = 0;
  const sessionsDir = join(configDir, "sessions");
  if (existsSync(sessionsDir)) {
    sessionCount = countJsonlFiles(sessionsDir);
  }

  let workspaceFiles = 0;
  const workspaceDir = join(configDir, "workspace");
  if (existsSync(workspaceDir)) {
    workspaceFiles = readdirSync(workspaceDir).filter((f) => f.endsWith(".md")).length;
  }

  let cronJobs = 0;
  const cronPath = join(configDir, "cron", "jobs.json");
  if (existsSync(cronPath)) {
    try {
      const data = JSON.parse(readFileSync(cronPath, "utf-8"));
      cronJobs = Array.isArray(data) ? data.length : Object.keys(data).length;
    } catch {}
  }

  let skillCount = 0;
  const skillsDir = join(configDir, "skills");
  if (existsSync(skillsDir)) {
    skillCount = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  }

  return {
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    hawkyVersion: "0.1.0",
    hostname: hostname(),
    sessionCount,
    workspaceFiles,
    cronJobs,
    skillCount,
  };
}

function countJsonlFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countJsonlFiles(join(dir, entry.name));
    } else if (entry.name.endsWith(".jsonl")) {
      count++;
    }
  }
  return count;
}
