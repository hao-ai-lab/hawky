// =============================================================================
// Node Host Commands
//
// Command implementations that execute locally on the node host device.
// Each command receives params, executes, and returns a result.
//
// Pattern: a proven node-host/invoke.ts — dispatch map, output cap, timeout.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import { tmpdir, hostname, platform, arch, cpus, totalmem, freemem, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, statSync, unlinkSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

const log = createSubsystemLogger("node/commands");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Maximum output size per stream (stdout/stderr) in bytes. */
const OUTPUT_CAP = 200_000;

/** Default command timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Kill a process and all its descendants.
 * Uses `pgrep -P` to walk the process tree bottom-up, ensuring backgrounded
 * children and pipelines are reaped — not just the direct child.
 * Bun.spawn doesn't create a new process group, so process.kill(-pid) won't
 * reach grandchildren; this recursive approach is needed instead.
 */
function killProcessTree(proc: { pid: number; kill(sig?: number | NodeJS.Signals): void }, sig: NodeJS.Signals): void {
  killDescendants(proc.pid, sig);
  try { proc.kill(sig); } catch {}
}

/** Recursively find and kill all descendant processes of the given PID. */
function killDescendants(pid: number, sig: NodeJS.Signals): void {
  try {
    const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
    const stdout = Buffer.from(result.stdout).toString().trim();
    if (!stdout) return;
    for (const line of stdout.split("\n")) {
      const childPid = parseInt(line.trim(), 10);
      if (isNaN(childPid)) continue;
      killDescendants(childPid, sig);
      try { process.kill(childPid, sig); } catch {}
    }
  } catch {}
}

/** Maximum screenshot file size per image in bytes. */
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

/** Maximum total screenshot payload across all displays.
 *  Base64 inflates ~33%, so 7MB raw → ~9.3MB base64, safely under the
 *  sanitizer's 10MB base64 budget. */
const MAX_TOTAL_SCREENSHOT_BYTES = 7 * 1024 * 1024;

/** Max pixel dimension for screenshot resize. 1920px keeps text readable
 *  while keeping 3-monitor total under 2MB. Anthropic recommends 1568px
 *  for token efficiency but 1920 is a better quality/size balance. */
const SCREENSHOT_MAX_DIMENSION = 1920;

/** Default screenshot retention in days. Configurable via config.screenshots.retention_days. */
const DEFAULT_SCREENSHOT_RETENTION_DAYS = 30;

/** Configured retention (set from config on startup). */
let screenshotRetentionDays = DEFAULT_SCREENSHOT_RETENTION_DAYS;

export function setScreenshotRetentionDays(days: number): void {
  screenshotRetentionDays = days > 0 ? days : DEFAULT_SCREENSHOT_RETENTION_DAYS;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SystemRunParams {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface SystemRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface SystemWhichParams {
  bins: string[];
}

export interface SystemWhichResult {
  bins: Record<string, string | null>;
}

export interface ScreenshotImage {
  base64: string;
  media_type: "image/jpeg" | "image/png";
  display?: number;
}

export interface ScreenshotResult {
  images: ScreenshotImage[];
}

export interface DeviceInfoResult {
  hostname: string;
  platform: string;
  arch: string;
  os: string;
  osVersion: string;
  cpu: string;
  cpuCores: number;
  memoryTotal: string;
  memoryFree: string;
  diskAvailable?: string;
}

export interface FrontmostAppResult {
  app: string;
  title: string;
}

export type CommandResult = SystemRunResult | SystemWhichResult | ScreenshotResult | DeviceInfoResult | FrontmostAppResult;

type CommandParams = SystemRunParams | SystemWhichParams | { timeoutMs?: number; display?: number } | Record<string, never>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireParamsRecord(command: string, params: unknown): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new Error(`${command} params must be an object`);
  }
  return params;
}

function optionalParamsRecord(command: string, params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  return requireParamsRecord(command, params);
}

function optionalString(command: string, params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${command}.${key} must be a string`);
  }
  return value;
}

function optionalPositiveInteger(
  command: string,
  params: Record<string, unknown>,
  key: string,
  max: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new Error(`${command}.${key} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function requireStringArray(command: string, params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) {
    throw new Error(`${command}.${key} must be an array of strings`);
  }
  if (!value.every((item) => typeof item === "string")) {
    throw new Error(`${command}.${key} must be an array of strings`);
  }
  return value;
}

function validateCommandParams(command: string, params: unknown): CommandParams {
  switch (command) {
    case "system.run": {
      const p = requireParamsRecord(command, params);
      return {
        command: requireStringArray(command, p, "command"),
        cwd: optionalString(command, p, "cwd"),
        timeoutMs: optionalPositiveInteger(command, p, "timeoutMs", 30 * 60_000),
      };
    }
    case "system.which": {
      const p = requireParamsRecord(command, params);
      return {
        bins: requireStringArray(command, p, "bins"),
      };
    }
    case "screenshot": {
      const p = optionalParamsRecord(command, params);
      return {
        timeoutMs: optionalPositiveInteger(command, p, "timeoutMs", 120_000),
        display: optionalPositiveInteger(command, p, "display", 16),
      };
    }
    case "frontmost.app": {
      const p = optionalParamsRecord(command, params);
      return {
        timeoutMs: optionalPositiveInteger(command, p, "timeoutMs", 120_000),
      };
    }
    case "device.info":
      optionalParamsRecord(command, params);
      return {};
    default:
      return {};
  }
}

// -----------------------------------------------------------------------------
// system.run — Execute a shell command
// -----------------------------------------------------------------------------

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= OUTPUT_CAP) return { text: output, truncated: false };
  // Keep head + tail for context
  const head = output.slice(0, OUTPUT_CAP * 0.7);
  const tail = output.slice(-OUTPUT_CAP * 0.2);
  return {
    text: `${head}\n... (truncated ${output.length - OUTPUT_CAP} bytes) ...\n${tail}`,
    truncated: true,
  };
}

async function systemRun(params: SystemRunParams, signal?: AbortSignal): Promise<SystemRunResult> {
  const { command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  if (!command || command.length === 0) {
    return { stdout: "", stderr: "Error: empty command", exitCode: 1 };
  }

  log.debug("system.run", { command, cwd, timeoutMs });

  const proc = Bun.spawn(command, {
    cwd: cwd || undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Timeout handling — kill the process tree if it exceeds the limit
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc, "SIGKILL");
  }, timeoutMs);

  // Cancellation handling — SIGTERM the tree first, SIGKILL after 2s grace period
  let cancelCleanup: (() => void) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (signal) {
    const onAbort = () => {
      cancelled = true;
      killProcessTree(proc, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), 2000);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
      cancelCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  }

  try {
    const [stdoutRaw, stderrRaw] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    const stdout = truncateOutput(stdoutRaw);
    const stderr = truncateOutput(stderrRaw);

    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: cancelled ? 130 : timedOut ? 124 : exitCode,
      timedOut: timedOut || undefined,
      truncated: (stdout.truncated || stderr.truncated) || undefined,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    cancelCleanup?.();
  }
}

// -----------------------------------------------------------------------------
// system.which — Resolve binary paths
// -----------------------------------------------------------------------------

async function systemWhich(params: SystemWhichParams): Promise<SystemWhichResult> {
  const result: Record<string, string | null> = {};
  for (const bin of params.bins) {
    const path = Bun.which(bin);
    result[bin] = path;
  }
  return { bins: result };
}

// -----------------------------------------------------------------------------
// screenshot — Capture screen as JPEG (macOS: screencapture, Linux: import)
//
// Captures all monitors by default. Uses JPEG for smaller file size.
// Auto-resizes with sips if over API limit. Saves a persistent copy
// to ~/.hawky/state/screenshots/ for audit trail.
// -----------------------------------------------------------------------------

/** Get the persistent screenshots root directory. */
function getScreenshotsRoot(): string {
  const dir = join(homedir(), ".hawky", "state", "screenshots");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Get today's screenshot directory (organized by date: screenshots/2026-04-11/). */
function getScreenshotsDayDir(): string {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dir = join(getScreenshotsRoot(), today);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Prune screenshot date folders older than retention period. */
export function reapOldScreenshots(): void {
  try {
    const root = getScreenshotsRoot();
    const cutoff = Date.now() - screenshotRetentionDays * 24 * 60 * 60 * 1000;
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        // Legacy flat files (pre-date-folder) — delete if older than retention
        try {
          const filePath = join(root, entry.name);
          if (statSync(filePath).mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch {}
        continue;
      }
      // Date folders: parse YYYY-MM-DD name
      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})$/);
      if (!match) continue;
      const folderDate = new Date(match[1]).getTime();
      if (folderDate < cutoff) {
        rmSync(join(root, entry.name), { recursive: true, force: true });
        log.debug("pruned screenshot folder", { folder: entry.name });
      }
    }
  } catch {}
}

/** Run a subprocess with timeout. Kills with SIGKILL on timeout or abort signal. */
async function runWithTimeout(
  cmd: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killProcessTree(proc, "SIGKILL"); }, timeoutMs);

  // Kill on abort signal
  let cancelCleanup: (() => void) | undefined;
  if (signal) {
    const onAbort = () => killProcessTree(proc, "SIGKILL");
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
      cancelCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  }

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode: timedOut ? 124 : exitCode, timedOut };
  } finally {
    clearTimeout(timer);
    cancelCleanup?.();
  }
}

/** Detect connected display count on macOS. */
async function getDisplayCount(): Promise<number> {
  try {
    const result = await runWithTimeout(
      ["bash", "-c", "system_profiler SPDisplaysDataType | grep 'Resolution:' | wc -l"],
      3000,
    );
    const count = parseInt(result.stdout.trim(), 10);
    return count > 0 ? count : 1;
  } catch {
    return 1;
  }
}

/** Process a single screenshot file: resize for API, save persistent copy. */
async function processScreenshotFile(
  tmpPath: string,
  displayNum: number | undefined,
  id: string,
  ts: string,
): Promise<ScreenshotImage> {
  let fileSize = statSync(tmpPath).size;

  // Always resize on macOS to keep multi-monitor payloads manageable.
  // sips is built into macOS — no external dependency.
  if (platform() === "darwin") {
    const originalSize = fileSize;
    const resizeResult = await runWithTimeout(
      ["sips", "--resampleHeightWidthMax", String(SCREENSHOT_MAX_DIMENSION), tmpPath, "--out", tmpPath],
      5000,
    );
    if (resizeResult.exitCode === 0) {
      fileSize = statSync(tmpPath).size;
      if (fileSize < originalSize) {
        log.debug("screenshot resized", { display: displayNum, originalSize, newSize: fileSize });
      }
    }
  }

  if (fileSize > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `Screenshot too large after resize (${(fileSize / 1024 / 1024).toFixed(1)}MB, max ${MAX_SCREENSHOT_BYTES / 1024 / 1024}MB).`,
    );
  }

  // Save persistent copy (organized by date folder). Disable with HAWKY_SCREENSHOT_PERSIST=0.
  if (process.env.HAWKY_SCREENSHOT_PERSIST !== "0") {
    const suffix = displayNum != null ? `-display${displayNum}` : "";
    const timeOnly = ts.slice(11); // Strip date prefix — folder already has it
    const persistPath = join(getScreenshotsDayDir(), `${timeOnly}-${id}${suffix}.jpg`);
    try {
      copyFileSync(tmpPath, persistPath);
      log.info("screenshot saved", { path: persistPath, display: displayNum, size: fileSize });
    } catch (err) {
      log.warn("failed to save screenshot copy", { error: String(err) });
    }
  }

  const data = readFileSync(tmpPath);
  try { require("fs").unlinkSync(tmpPath); } catch {}

  return {
    base64: data.toString("base64"),
    media_type: "image/jpeg",
    display: displayNum,
  };
}

async function screenshot(params?: { timeoutMs?: number; display?: number }, signal?: AbortSignal): Promise<ScreenshotResult> {
  const timeoutMs = params?.timeoutMs ?? 15_000;
  const id = randomUUID().slice(0, 8);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const os = platform();

  if (os === "darwin") {
    if (params?.display) {
      // Capture specific display
      const tmpPath = join(tmpdir(), `hawky-ss-${id}.jpg`);
      const result = await runWithTimeout(
        ["screencapture", "-x", "-t", "jpg", "-D", String(params.display), tmpPath],
        timeoutMs,
        signal,
      );
      if (result.timedOut) throw new Error("Screenshot timed out (Screen Recording permission may be needed)");
      if (result.exitCode !== 0) throw new Error(`Screenshot failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
      const image = await processScreenshotFile(tmpPath, params.display, id, ts);
      return { images: [image] };
    }

    // Capture ALL displays — pass one output file per display
    const displayCount = await getDisplayCount();
    const tmpPaths = Array.from({ length: displayCount }, (_, i) =>
      join(tmpdir(), `hawky-ss-${id}-d${i + 1}.jpg`),
    );
    const result = await runWithTimeout(
      ["screencapture", "-x", "-t", "jpg", ...tmpPaths],
      timeoutMs,
      signal,
    );
    if (result.timedOut) throw new Error("Screenshot timed out (Screen Recording permission may be needed)");
    if (result.exitCode !== 0) throw new Error(`Screenshot failed (exit ${result.exitCode}): ${result.stderr.trim()}`);

    // Process each display's screenshot, enforcing total size budget
    const images: ScreenshotImage[] = [];
    let totalBytes = 0;
    for (let i = 0; i < tmpPaths.length; i++) {
      if (existsSync(tmpPaths[i])) {
        const image = await processScreenshotFile(tmpPaths[i], i + 1, id, ts);
        const imageBytes = Math.round(image.base64.length * 0.75);
        if (totalBytes + imageBytes > MAX_TOTAL_SCREENSHOT_BYTES) {
          log.warn("screenshot total budget exceeded, skipping remaining displays", {
            display: i + 1, totalBytes, limit: MAX_TOTAL_SCREENSHOT_BYTES,
          });
          break;
        }
        totalBytes += imageBytes;
        images.push(image);
      }
    }
    if (images.length === 0) throw new Error("No screenshots captured");
    return { images };

  } else if (os === "linux") {
    const tmpPath = join(tmpdir(), `hawky-ss-${id}.jpg`);
    const result = await runWithTimeout(["import", "-window", "root", tmpPath], timeoutMs, signal);
    if (result.timedOut) throw new Error("Screenshot timed out");
    if (result.exitCode !== 0) throw new Error(`Screenshot failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    const image = await processScreenshotFile(tmpPath, undefined, id, ts);
    return { images: [image] };

  } else {
    throw new Error(`Screenshot not supported on ${os}`);
  }
}

/** Wrapper that runs the reaper after each capture. */
async function screenshotAndReap(params?: { timeoutMs?: number; display?: number }, signal?: AbortSignal): Promise<ScreenshotResult> {
  const result = await screenshot(params, signal);
  reapOldScreenshots();
  return result;
}

// -----------------------------------------------------------------------------
// device.info — Collect device metadata
// -----------------------------------------------------------------------------

async function deviceInfo(): Promise<DeviceInfoResult> {
  const os = platform();
  let osVersion = "";
  let diskAvailable: string | undefined;

  // Get OS version
  if (os === "darwin") {
    try {
      const proc = Bun.spawn(["sw_vers", "-productVersion"], { stdout: "pipe", stderr: "pipe" });
      osVersion = (await new Response(proc.stdout).text()).trim();
    } catch { osVersion = "unknown"; }
  } else {
    try {
      const proc = Bun.spawn(["uname", "-r"], { stdout: "pipe", stderr: "pipe" });
      osVersion = (await new Response(proc.stdout).text()).trim();
    } catch { osVersion = "unknown"; }
  }

  // Get disk space
  try {
    const proc = Bun.spawn(["df", "-h", "/"], { stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    const lines = output.split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      diskAvailable = parts[3]; // Available column
    }
  } catch {}

  const cpuInfo = cpus();
  const formatBytes = (b: number) => {
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    return `${(b / 1e6).toFixed(0)} MB`;
  };

  return {
    hostname: hostname(),
    platform: os,
    arch: arch(),
    os: os === "darwin" ? "macOS" : os === "linux" ? "Linux" : os,
    osVersion,
    cpu: cpuInfo[0]?.model ?? "unknown",
    cpuCores: cpuInfo.length,
    memoryTotal: formatBytes(totalmem()),
    memoryFree: formatBytes(freemem()),
    diskAvailable,
  };
}

// -----------------------------------------------------------------------------
// frontmost.app — Get active app and window title (macOS only)
// -----------------------------------------------------------------------------

async function frontmostApp(params?: { timeoutMs?: number }, signal?: AbortSignal): Promise<FrontmostAppResult> {
  if (platform() !== "darwin") {
    throw new Error("frontmost.app is only supported on macOS");
  }

  const timeoutMs = params?.timeoutMs ?? 5_000;

  const script = `
    tell application "System Events"
      set frontApp to name of first process whose frontmost is true
      set frontTitle to ""
      try
        tell process frontApp
          set frontTitle to name of front window
        end tell
      end try
      return frontApp & "|" & frontTitle
    end tell
  `;

  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });

  // Enforce timeout — osascript can hang on Accessibility permission prompts
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc, "SIGKILL");
  }, timeoutMs);

  // Kill on abort signal
  let cancelCleanup: (() => void) | undefined;
  if (signal) {
    const onAbort = () => killProcessTree(proc, "SIGKILL");
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
      cancelCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  }

  try {
    const stdout = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;

    if (timedOut) {
      throw new Error("frontmost.app timed out (macOS Accessibility permission may be needed)");
    }
    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new Error(`frontmost.app failed: ${stderr}`);
    }

    const sepIdx = stdout.indexOf("|");
    return {
      app: sepIdx >= 0 ? stdout.slice(0, sepIdx) : stdout,
      title: sepIdx >= 0 ? stdout.slice(sepIdx + 1) : "",
    };
  } finally {
    clearTimeout(timer);
    cancelCleanup?.();
  }
}

// -----------------------------------------------------------------------------
// Command dispatch
// -----------------------------------------------------------------------------

const COMMANDS: Record<string, (params: any, signal?: AbortSignal) => Promise<CommandResult>> = {
  "system.run": systemRun,
  "system.which": systemWhich,
  "screenshot": screenshotAndReap,
  "device.info": deviceInfo,
  "frontmost.app": frontmostApp,
};

/** List of supported command names. */
export const SUPPORTED_COMMANDS = Object.keys(COMMANDS);

/**
 * Dispatch a command by name. Returns the result or throws if unknown.
 * The optional signal allows the gateway to cancel long-running commands.
 */
export async function dispatchCommand(
  command: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`Unknown node command: ${command}`);
  }
  return handler(validateCommandParams(command, params), signal);
}
