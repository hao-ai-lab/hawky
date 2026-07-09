// =============================================================================
// Memory File Watcher
//
// Watches workspace files for changes using OS-level events (chokidar).
// Sets a dirty flag when files change — actual re-indexing happens lazily
// on the next search.
// =============================================================================

import { watch } from "chokidar";

// chokidar normalizes the path it passes to an `ignored` *function* predicate
// to forward slashes on every platform, while the watch roots are built with
// the native separator. Compare both sides as POSIX-style paths so the segment
// match works on Windows too (on macOS/Linux this is a no-op).
const toPosix = (p: string): string => p.replace(/\\/g, "/");

export interface MemoryWatcher {
  close(): void;
}

// Vendored/generated directories we never descend into. Matched per path
// *segment* (not as substrings), so a memory file like "node_modules-notes.md"
// or a path under a project that merely contains ".git" is not mistaken for
// one of these directories.
const IGNORED_DIRS = new Set([".git", "node_modules"]);

/**
 * Build a chokidar `ignored` predicate that skips IGNORED_DIRS by exact path
 * segment, only for segments below one of the watch roots — never the roots or
 * their ancestors (a root may live under e.g. a `node_modules/` directory).
 */
export function makeIgnored(roots: string[]): (path: string) => boolean {
  const normRoots = roots.map((r) => {
    const p = toPosix(r);
    return p.endsWith("/") ? p.slice(0, -1) : p;
  });
  return (rawPath: string): boolean => {
    const path = toPosix(rawPath);
    const root = normRoots.find((r) => path === r || path.startsWith(r + "/"));
    if (!root) return false;
    const rel = path.slice(root.length + 1);
    if (!rel) return false; // the root itself
    return rel.split("/").some((segment) => IGNORED_DIRS.has(segment));
  };
}

/**
 * Create a file watcher for workspace memory files.
 * Calls onDirty() when files change (debounced).
 *
 * `watchPaths` must be plain directories — chokidar v4+ dropped glob support,
 * so callers watch containing directories and pass `filter` to decide which
 * changed paths are relevant (e.g. only top-level `.md`, or `.jsonl` sessions).
 */
export function createMemoryWatcher(
  watchPaths: string[],
  onDirty: () => void,
  filter?: (path: string) => boolean,
  debounceMs = 1500,
): MemoryWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    depth: 2,
    ignored: makeIgnored(watchPaths),
  });

  watcher.on("all", (_event, path) => {
    if (filter && (!path || !filter(path))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onDirty, debounceMs);
  });

  return {
    close() {
      watcher.close();
      if (timer) clearTimeout(timer);
    },
  };
}
