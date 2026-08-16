// =============================================================================
// Workspace Manager
//
// Manages the PA workspace at ~/.hawky/workspace/. Handles:
// - First-run initialization (copy templates, create directories)
// - Reading/writing workspace files (SOUL.md, USER.md, etc.)
// - Daily log management (memory/YYYY-MM-DD.md)
//
// Templates live in src/templates/ and are copied on first run.
// Existing files are NEVER overwritten (idempotent init).
// =============================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./config.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default follows HAWKY_HOME/getConfigDir(); tests can still override it.
let workspaceDirOverride: string | null = null;

/** Default workspace path, derived from the configured Hawky root. */
function defaultWorkspaceDir(): string {
  return join(getConfigDir(), "workspace");
}

/** All workspace template files (order matters for bootstrap injection). */
export const WORKSPACE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

/**
 * Additional template files created in workspace but NOT injected into
 * the system prompt. These are loaded on-demand (e.g., when /setup runs).
 */
export const EXTRA_TEMPLATE_FILES = ["SETUP.md"] as const;

export type WorkspaceFileName = (typeof WORKSPACE_FILES)[number];

/**
 * Injection cap for curated long-term memory (MEMORY.md). Higher than the
 * generic per-file cap so a grown MEMORY.md is injected whole rather than
 * middle-clipped by the head/tail truncator. The overall system-prompt size is
 * still bounded by maxCharsTotal in loadBootstrapFiles.
 */
export const MEMORY_MD_INJECTION_CAP = 60_000;

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Override the workspace directory (for testing). */
export function setWorkspaceDir(dir: string): void {
  workspaceDirOverride = dir;
}

/** Reset the workspace directory to the configured default (for testing). */
export function resetWorkspaceDir(): void {
  workspaceDirOverride = null;
}

/** Get the current workspace directory. */
export function getWorkspaceDir(): string {
  return workspaceDirOverride ?? defaultWorkspaceDir();
}

// -----------------------------------------------------------------------------
// Template resolution
// -----------------------------------------------------------------------------

/** Get the path to the templates directory (src/templates/). */
function getTemplatesDir(): string {
  // Navigate from src/storage/ up to src/templates/
  return join(__dirname, "..", "templates");
}

/** Read a template file's content. Returns null if template doesn't exist. */
function readTemplate(filename: string): string | null {
  const templatePath = join(getTemplatesDir(), filename);
  if (!existsSync(templatePath)) return null;
  return readFileSync(templatePath, "utf-8");
}

/**
 * Atomically write `content` to the absolute path `dest`: stream into a sibling
 * temp file, then `renameSync` over the target (atomic on the same filesystem),
 * so a reader never sees a partial file and a crash mid-write leaves the prior
 * content intact. Best-effort temp cleanup on failure.
 */
function atomicWrite(dest: string, content: string): void {
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, dest);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup after a failed atomic write.
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// WorkspaceManager
// -----------------------------------------------------------------------------

export class WorkspaceManager {
  private readonly dir: string;

  constructor(workspaceDir?: string) {
    this.dir = workspaceDir ?? getWorkspaceDir();
  }

  /** Get the workspace directory path. */
  getWorkspacePath(): string {
    return this.dir;
  }

  /** Get the memory directory path (for daily logs). */
  getMemoryDir(): string {
    return join(this.dir, "memory");
  }

  private resolveWorkspacePath(filename: string): string {
    const root = resolve(this.dir);
    const filePath = resolve(root, filename);
    this.assertInsideWorkspace(root, filePath, filename);

    return filePath;
  }

  private resolveReadableWorkspacePath(filename: string): string {
    const filePath = this.resolveWorkspacePath(filename);
    if (existsSync(filePath)) {
      this.assertRealPathInsideWorkspace(filePath, filename);
    }
    return filePath;
  }

  private prepareWritableWorkspacePath(filename: string): string {
    const filePath = this.resolveWorkspacePath(filename);
    const parentDir = dirname(filePath);
    if (existsSync(this.dir)) {
      this.assertNearestExistingParentInsideWorkspace(parentDir, filename);
    }
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    this.assertRealPathInsideWorkspace(parentDir, filename);
    return filePath;
  }

  private assertNearestExistingParentInsideWorkspace(parentDir: string, filename: string): void {
    let cursor = parentDir;
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    this.assertRealPathInsideWorkspace(cursor, filename);
  }

  private assertRealPathInsideWorkspace(path: string, filename: string): void {
    const root = existsSync(this.dir) ? realpathSync(this.dir) : resolve(this.dir);
    this.assertInsideWorkspace(root, realpathSync(path), filename);
  }

  private assertInsideWorkspace(root: string, filePath: string, filename: string): void {
    const rel = relative(root, filePath);

    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Workspace path escapes workspace: ${filename}`);
    }
  }

  /**
   * Initialize the workspace. Copies templates for missing files.
   * Creates the workspace and memory directories if needed.
   * Idempotent: never overwrites existing files.
   *
   * @returns List of files that were created (empty if workspace already fully initialized)
   */
  init(): string[] {
    const created: string[] = [];

    // Detect if this is a fresh workspace (never initialized before)
    const isFirstInit = !existsSync(this.dir);

    // Create workspace directory
    if (isFirstInit) {
      mkdirSync(this.dir, { recursive: true });
    }

    // Create memory/ subdirectory
    const memoryDir = this.getMemoryDir();
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    // Copy templates for missing files (bootstrap-injected files)
    for (const filename of WORKSPACE_FILES) {
      const targetPath = join(this.dir, filename);
      if (existsSync(targetPath)) continue; // Never overwrite

      // BOOTSTRAP.md is only created on first init. Once the user completes
      // onboarding and the agent deletes it, it should NOT come back.
      if (filename === "BOOTSTRAP.md" && !isFirstInit) continue;

      const content = readTemplate(filename);
      if (content !== null) {
        writeFileSync(targetPath, content, "utf-8");
        created.push(filename);
      }
    }

    // Copy extra template files (not injected into system prompt)
    for (const filename of EXTRA_TEMPLATE_FILES) {
      const targetPath = join(this.dir, filename);
      if (existsSync(targetPath)) continue;

      const content = readTemplate(filename);
      if (content !== null) {
        writeFileSync(targetPath, content, "utf-8");
        created.push(filename);
      }
    }

    return created;
  }

  /**
   * Read a workspace file by name.
   * @param filename - File name (e.g., "SOUL.md") or relative path (e.g., "memory/2026-03-14.md")
   * @returns File content, or null if the file doesn't exist
   */
  readFile(filename: string): string | null {
    const filePath = this.resolveReadableWorkspacePath(filename);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  }

  /**
   * Write a workspace file (creates parent directories if needed).
   * @param filename - File name or relative path
   * @param content - File content
   */
  writeFile(filename: string, content: string): void {
    const filePath = this.prepareWritableWorkspacePath(filename);
    writeFileSync(filePath, content, "utf-8");
  }

  /**
   * Atomically write a workspace file: stream into a sibling temp file, then
   * renameSync over the target (atomic on the same filesystem). Guarantees a
   * reader never sees a truncated/partial file, and a crash mid-write leaves the
   * previous content intact rather than a zero/partial-length file. Used for
   * MEMORY.md, whose whole purpose is data-loss safety.
   * @param filename - File name or relative path
   * @param content - File content
   */
  writeFileAtomic(filename: string, content: string): void {
    atomicWrite(this.prepareWritableWorkspacePath(filename), content);
  }

  /**
   * Append a timestamped entry to today's daily log.
   * Creates the file and memory/ directory if needed.
   * @param content - Text to append
   * @param date - Date for the log file (defaults to today)
   */
  appendToDaily(content: string, date?: Date): void {
    const d = date ?? new Date();
    const dateStr = formatDate(d);
    const filename = `memory/${dateStr}.md`;
    const filePath = this.prepareWritableWorkspacePath(filename);

    // Format: [HH:MM] content
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const entry = `\n[${time}] ${content}\n`;

    if (!existsSync(filePath)) {
      // Create with date header
      writeFileSync(filePath, `# ${dateStr}\n${entry}`, "utf-8");
    } else {
      appendFileSync(filePath, entry, "utf-8");
    }
  }

  /**
   * Check if a workspace file exists.
   * @param filename - File name or relative path
   */
  exists(filename: string): boolean {
    return existsSync(this.resolveReadableWorkspacePath(filename));
  }

  /**
   * Delete a workspace file.
   * @param filename - File name or relative path
   * @returns true if file was deleted, false if it didn't exist
   */
  deleteFile(filename: string): boolean {
    const filePath = this.resolveReadableWorkspacePath(filename);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  /**
   * Snapshot a workspace file into memory/.backups/ before it is overwritten,
   * then prune old snapshots down to `keep`. Non-destructive: the original file
   * is left untouched. Reuses the house atomic temp-file + renameSync pattern.
   *
   * @param filename - File to snapshot (e.g. "MEMORY.md").
   * @param opts.keep - How many snapshots to retain (default 20).
   * @param opts.now - Clock override (tests); used to name the snapshot.
   * @returns Absolute path of the snapshot written, or null when there is
   *          nothing to snapshot (missing or empty file).
   */
  snapshotAndPrune(filename: string, opts?: { keep?: number; now?: Date }): string | null {
    const source = this.resolveReadableWorkspacePath(filename);
    if (!existsSync(source)) return null;
    const content = readFileSync(source, "utf-8");
    if (content.trim() === "") return null;

    const keep = opts?.keep ?? 20;
    const now = opts?.now ?? new Date();

    const backupsDir = this.resolveWorkspacePath("memory/.backups");
    mkdirSync(backupsDir, { recursive: true });

    // ISO timestamp made filesystem-safe (no ':' or '.'), plus a short random
    // suffix so two snapshots in the same millisecond (or an injected fixed
    // test clock) never collide and silently clobber an earlier backup.
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const suffix = randomBytes(3).toString("hex");
    const backupPath = join(backupsDir, `MEMORY-${stamp}-${suffix}.md`);

    atomicWrite(backupPath, content);

    // Prune oldest snapshots (ISO names sort chronologically).
    const snapshots = readdirSync(backupsDir)
      .filter((f) => /^MEMORY-.*\.md$/.test(f))
      .sort();
    while (snapshots.length > keep) {
      const oldest = snapshots.shift();
      if (!oldest) break;
      try {
        unlinkSync(join(backupsDir, oldest));
      } catch {
        // Ignore; a vanished snapshot is fine.
      }
    }

    return backupPath;
  }

  /**
   * List daily log files in the memory/ directory.
   * @returns Sorted array of filenames (e.g., ["2026-03-12.md", "2026-03-13.md", "2026-03-14.md"])
   */
  listDailyLogs(): string[] {
    const memoryDir = this.resolveReadableWorkspacePath("memory");
    if (!existsSync(memoryDir)) return [];

    const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    return readdirSync(memoryDir)
      .filter((f) => datePattern.test(f))
      .sort();
  }

  /**
   * Load all bootstrap files for system prompt injection.
   * Returns files in the order defined by WORKSPACE_FILES.
   * Skips files that don't exist. Applies truncation.
   *
   * @param maxCharsPerFile - Max characters per file (default 20000)
   * @param maxCharsTotal - Max total characters across all files (default 150000)
   * @param mainSession - If false, excludes MEMORY.md (security)
   */
  loadBootstrapFiles(options?: {
    maxCharsPerFile?: number;
    maxCharsTotal?: number;
    mainSession?: boolean;
  }): BootstrapFile[] {
    const explicitPerFile = options?.maxCharsPerFile;
    const maxPerFile = explicitPerFile ?? 20_000;
    const maxTotal = options?.maxCharsTotal ?? 150_000;
    const mainSession = options?.mainSession ?? true;

    const files: BootstrapFile[] = [];
    let totalChars = 0;

    for (const filename of WORKSPACE_FILES) {
      // Skip MEMORY.md in non-main sessions (security)
      if (!mainSession && filename === "MEMORY.md") continue;

      const content = this.readFile(filename);
      if (content === null || content.trim().length === 0) continue;

      // MEMORY.md is curated long-term memory whose input-side truncation was
      // removed on purpose; letting the default 20k head/tail clip drop its
      // MIDDLE would silently lose curated facts from the system prompt. When the
      // caller did NOT pin an explicit per-file cap (i.e. the full-agent context,
      // not the intentionally-light heartbeat budget), inject MEMORY.md whole up
      // to a much higher bound. The total-budget guard below still protects the
      // overall prompt size.
      const perFileCap =
        filename === "MEMORY.md" && explicitPerFile === undefined
          ? MEMORY_MD_INJECTION_CAP
          : maxPerFile;

      // Per-file truncation
      const truncated = truncateBootstrapContent(content, filename, perFileCap);

      // Check total budget
      if (totalChars + truncated.content.length > maxTotal) {
        // Skip remaining files if budget exceeded
        break;
      }

      totalChars += truncated.content.length;
      files.push({
        filename,
        content: truncated.content,
        truncated: truncated.wasTruncated,
      });
    }

    return files;
  }
}

// -----------------------------------------------------------------------------
// Bootstrap file types
// -----------------------------------------------------------------------------

export interface BootstrapFile {
  filename: string;
  content: string;
  truncated: boolean;
}

// -----------------------------------------------------------------------------
// Truncation (a proven design pattern: 70% head + 20% tail)
// -----------------------------------------------------------------------------

interface TruncateResult {
  content: string;
  wasTruncated: boolean;
}

function truncateBootstrapContent(
  content: string,
  filename: string,
  maxChars: number,
): TruncateResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return { content: trimmed, wasTruncated: false };
  }

  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker = `\n\n[...truncated ${filename}: kept ${headChars}+${tailChars} chars of ${trimmed.length}...]\n\n`;
  return {
    content: head + marker + tail,
    wasTruncated: true,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Format a Date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Exported for testing. */
export { formatDate, truncateBootstrapContent };
