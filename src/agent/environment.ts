// =============================================================================
// Environment Detection
//
// Detects runtime environment info for the system prompt: git status,
// OS details, shell type, architecture. Results cached per session.
// =============================================================================

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { platform, arch, release, homedir } from "node:os";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface EnvironmentInfo {
  platform: string;
  osVersion: string;
  architecture: string;
  shell: string;
  git: GitInfo | null;
}

export interface GitInfo {
  isRepo: boolean;
  repoName: string;
  branch: string;
  root: string;
}

// -----------------------------------------------------------------------------
// Git detection
// -----------------------------------------------------------------------------

function execGit(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export function detectGitInfo(workingDirectory: string): GitInfo | null {
  const root = execGit("git rev-parse --show-toplevel", workingDirectory);
  if (!root) return null;

  const branch = execGit("git rev-parse --abbrev-ref HEAD", workingDirectory) ?? "unknown";

  // For repo name, prefer the parent of `--git-common-dir` over the parent
  // of `--show-toplevel`. They differ inside a git worktree: `--show-toplevel`
  // returns the worktree directory (e.g. `vivid-tinkering-tome`), but the
  // common dir always points at the *main* `.git`, whose parent is the actual
  // repository (e.g. `hawky`). Fall back to the toplevel if the common-dir
  // call fails for any reason.
  const commonDir = execGit("git rev-parse --git-common-dir", workingDirectory);
  let repoName = basename(root) || "unknown";
  if (commonDir) {
    const absCommon = commonDir.startsWith("/") ? commonDir : resolve(workingDirectory, commonDir);
    const candidate = basename(dirname(absCommon));
    if (candidate) repoName = candidate;
  }

  return {
    isRepo: true,
    repoName,
    branch,
    root,
  };
}

// -----------------------------------------------------------------------------
// OS / Shell detection
// -----------------------------------------------------------------------------

export function detectShell(): string {
  return process.env.SHELL ?? (platform() === "win32" ? "cmd.exe" : "/bin/sh");
}

export function detectOsVersion(): string {
  const p = platform();
  const r = release();
  if (p === "darwin") {
    // Try to get macOS version name
    const version = execGit("sw_vers -productVersion", "/tmp");
    return version ? `macOS ${version}` : `macOS ${r}`;
  }
  if (p === "win32") return `Windows ${r}`;
  if (p === "linux") return `Linux ${r}`;
  return `${p} ${r}`;
}

// -----------------------------------------------------------------------------
// HAWKY.md / CLAUDE.md loading
// -----------------------------------------------------------------------------

const INSTRUCTION_FILE_NAMES = ["HAWKY.md", "CLAUDE.md"];

/**
 * Search for project instruction file (HAWKY.md or CLAUDE.md).
 * Checks working directory first, then git root (if different).
 * HAWKY.md takes priority over CLAUDE.md at the same level.
 */
export function loadProjectInstructions(
  workingDirectory: string,
  gitRoot: string | null,
): { content: string; filePath: string } | null {
  const searchDirs = [workingDirectory];
  if (gitRoot && resolve(gitRoot) !== resolve(workingDirectory)) {
    searchDirs.push(gitRoot);
  }

  for (const dir of searchDirs) {
    for (const fileName of INSTRUCTION_FILE_NAMES) {
      const filePath = join(dir, fileName);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, "utf-8").trim();
          if (content.length > 0) {
            return { content, filePath };
          }
        } catch {
          // Can't read file, skip
        }
      }
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Full environment detection
// -----------------------------------------------------------------------------

export function detectEnvironment(workingDirectory: string): EnvironmentInfo {
  return {
    platform: platform(),
    osVersion: detectOsVersion(),
    architecture: arch(),
    shell: detectShell(),
    git: detectGitInfo(workingDirectory),
  };
}
