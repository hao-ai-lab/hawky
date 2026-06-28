// =============================================================================
// Static File Serving
//
// Serves the web frontend (web/dist/) in production mode.
// In development, Vite dev server handles this; the gateway only serves WS.
//
// Pattern: a proven control-ui.ts — SPA fallback, security headers.
// =============================================================================

import { existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/static");

// -----------------------------------------------------------------------------
// MIME types
// -----------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// -----------------------------------------------------------------------------
// Static file handler
// -----------------------------------------------------------------------------

/**
 * Try to serve a static file from the web frontend build directory.
 * Returns a Response if the file exists, or null if not found.
 *
 * Implements SPA fallback: if the request path doesn't match a file and
 * doesn't look like an API/WS request, return index.html for client-side routing.
 */
export function serveStatic(
  webDistDir: string,
  pathname: string,
): Response | null {
  // Don't serve static files for WebSocket upgrade or API paths
  if (pathname === "/ws" || pathname.startsWith("/api/")) {
    return null;
  }

  // Resolve and guard against path traversal (../../etc/passwd)
  const filePath = join(webDistDir, pathname);
  if (!filePath.startsWith(webDistDir)) {
    return null;
  }

  // Try exact file match (must be a file, not a directory)
  if (existsSync(filePath) && !filePath.endsWith("/") && statSync(filePath).isFile()) {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new Response(Bun.file(filePath), {
      headers: {
        "Content-Type": contentType,
        // Cache static assets aggressively (they have content hashes)
        ...(pathname.startsWith("/assets/")
          ? { "Cache-Control": "public, max-age=31536000, immutable" }
          : { "Cache-Control": "public, max-age=0, must-revalidate" }),
      },
    });
  }

  // SPA fallback: return index.html for non-file paths (client-side routing)
  const indexPath = join(webDistDir, "index.html");
  if (existsSync(indexPath) && !extname(pathname)) {
    return new Response(Bun.file(indexPath), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  }

  return null;
}

/**
 * Resolve the web frontend dist directory.
 * Tries multiple locations to handle both dev (CWD) and installed (binary) scenarios.
 */
export function resolveWebDistDir(): string | null {
  const candidates = [
    // 1. Relative to this source file (works when running from source: src/gateway/ → ../../web/dist)
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist"),
    // 2. Relative to bundle dir (works from deployed bundle: dist/ → ../web/dist)
    join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "web-ios", "dist"),
    // 3. Relative to bundle dir (works from npm package: dist/ → ../web-dist/)
    join(dirname(fileURLToPath(import.meta.url)), "..", "web-dist"),
    // 4. Relative to CWD (works in development)
    join(process.cwd(), "web", "dist"),
    join(process.cwd(), "web-ios", "dist"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      log.info("web frontend found", { path: candidate });
      return candidate;
    }
  }

  // Not found — frontend not built or not present
  return null;
}
