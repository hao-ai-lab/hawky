// =============================================================================
// Skill File Watcher
//
// Watches SKILL.md files for changes. Sets a dirty flag so skills are
// reloaded on the next prompt build. Reuses chokidar (already a dependency).
// =============================================================================

import { watch } from "chokidar";
import { join, basename, sep } from "node:path";
import { getConfigDir } from "../storage/config.js";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let dirty = false;
let watcherInstance: { close: () => void } | null = null;

// Vendored/generated directories we never descend into. Matched per path
// *segment* (not as substrings), and only below the watch roots, so a skill
// named "prompt-builder" or even "build" is not mistaken for a "build" dir.
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".venv",
  "venv",
  "__pycache__",
  "build",
  ".cache",
]);

/**
 * Build a chokidar `ignored` predicate that skips IGNORED_DIRS by exact path
 * segment, scoped to *inside* a skill folder. Never treats a watch root, its
 * ancestors (a root may live under e.g. a `build/` directory), or a skill
 * folder's own name (a skill may be named "build") as junk — only vendored
 * dirs nested within a skill.
 */
function makeIgnored(roots: string[]): (path: string) => boolean {
  const normRoots = roots.map((r) => (r.endsWith(sep) ? r.slice(0, -1) : r));
  return (path: string): boolean => {
    const root = normRoots.find((r) => path === r || path.startsWith(r + sep));
    if (!root) return false;
    const rel = path.slice(root.length + 1);
    if (!rel) return false; // the root itself
    // rel[0] is the skill folder name; only segments *within* it can be junk.
    return rel.split(sep).slice(1).some((segment) => IGNORED_DIRS.has(segment));
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Check if skills need reloading. */
export function isSkillsDirty(): boolean {
  return dirty;
}

/** Mark skills as clean (after reloading). */
export function clearSkillsDirty(): void {
  dirty = false;
}

/** Mark skills as dirty (for testing or manual refresh). */
export function markSkillsDirty(): void {
  dirty = true;
}

/**
 * Start watching skill directories for SKILL.md changes.
 * Sets dirty flag on add/change/unlink with 250ms debounce.
 */
export function startSkillsWatcher(workspacePath?: string): void {
  if (watcherInstance) return; // Already watching

  // chokidar v4+ dropped glob support, so a path containing "*" is treated as a
  // literal filename and matches nothing. Watch the containing skill directories
  // directly and filter events down to SKILL.md files in the handler.
  const watchDirs: string[] = [];

  // User skills: <config root>/skills/<name>/SKILL.md
  watchDirs.push(join(getConfigDir(), "skills"));

  // Workspace skills: <workspace>/skills/<name>/SKILL.md
  if (workspacePath) {
    watchDirs.push(join(workspacePath, "skills"));
  }

  if (watchDirs.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(watchDirs, {
    ignoreInitial: true,
    depth: 2,
    ignored: makeIgnored(watchDirs),
  });

  watcher.on("all", (_event, path) => {
    // The directory watch also sees sibling files; only SKILL.md matters.
    if (!path || basename(path) !== "SKILL.md") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      dirty = true;
      timer = null;
    }, 250);
  });

  watcherInstance = {
    close: () => {
      watcher.close();
      if (timer) clearTimeout(timer);
      watcherInstance = null;
    },
  };
}

/** Stop the skills watcher. */
export function stopSkillsWatcher(): void {
  watcherInstance?.close();
}
