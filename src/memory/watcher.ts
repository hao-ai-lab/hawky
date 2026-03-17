// =============================================================================
// Memory File Watcher
//
// Watches workspace files for changes using OS-level events (chokidar).
// Sets a dirty flag when files change — actual re-indexing happens lazily
// on the next search.
// =============================================================================

import { watch } from "chokidar";

export interface MemoryWatcher {
  close(): void;
}

/**
 * Create a file watcher for workspace memory files.
 * Calls onDirty() when files change (debounced).
 */
export function createMemoryWatcher(
  watchPaths: string[],
  onDirty: () => void,
  debounceMs = 1500,
): MemoryWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    depth: 2,
    ignored: [/\.git/, /node_modules/],
  });

  watcher.on("all", () => {
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
