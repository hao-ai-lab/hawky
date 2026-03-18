// =============================================================================
// Skill File Watcher
//
// Watches SKILL.md files for changes. Sets a dirty flag so skills are
// reloaded on the next prompt build. Reuses chokidar (already a dependency).
// =============================================================================

import { watch } from "chokidar";
import { join } from "node:path";
import { homedir } from "node:os";

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let dirty = false;
let watcherInstance: { close: () => void } | null = null;

// Ignored directories (same as memory watcher)
const IGNORED = [
  /\.git/,
  /node_modules/,
  /dist/,
  /\.venv/,
  /venv/,
  /__pycache__/,
  /build/,
  /\.cache/,
];

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

  const watchPaths: string[] = [];

  // User skills
  const userSkillsDir = join(homedir(), ".hawky", "skills");
  watchPaths.push(join(userSkillsDir, "*/SKILL.md"));

  // Workspace skills
  if (workspacePath) {
    watchPaths.push(join(workspacePath, "skills", "*/SKILL.md"));
  }

  if (watchPaths.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    depth: 2,
    ignored: IGNORED,
  });

  watcher.on("all", () => {
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
