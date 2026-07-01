#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const listenPort = Number.parseInt(process.env.HAWKY_WEBSITE_PORT || "4260", 10);
const listenHost = process.env.HAWKY_WEBSITE_BIND || "127.0.0.1";
const rootDir = path.resolve(process.env.HAWKY_WEBSITE_ROOT || "/opt/hawky/website");
const canonicalHost = (process.env.HAWKY_WEBSITE_CANONICAL_HOST || "www.hawky.live").toLowerCase();
const iosRedirectUrl = process.env.HAWKY_IOS_REDIRECT_URL || "https://testflight.apple.com/join/ZeehcR73";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".ico", "image/x-icon"],
]);

function resolveStaticPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const cleanPath = pathname.replace(/^\/+/, "");
  let candidate = path.resolve(rootDir, cleanPath || "index.html");
  if (!candidate.startsWith(`${rootDir}${path.sep}`) && candidate !== rootDir) {
    return null;
  }

  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    candidate = path.join(candidate, "index.html");
  }

  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return null;
  }

  return candidate;
}

function shouldRedirectToCanonical(host) {
  const hostname = String(host || "").split(":")[0].toLowerCase();
  return canonicalHost && hostname === "hawky.live" && hostname !== canonicalHost;
}

function shouldRedirectToIos(host) {
  const hostname = String(host || "").split(":")[0].toLowerCase();
  return hostname === "ios.hawky.live";
}

Bun.serve({
  hostname: listenHost,
  port: listenPort,
  async fetch(req) {
    const url = new URL(req.url);

    if (shouldRedirectToIos(req.headers.get("host"))) {
      return Response.redirect(iosRedirectUrl, 308);
    }

    if (shouldRedirectToCanonical(req.headers.get("host"))) {
      url.hostname = canonicalHost;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }

    if (!["GET", "HEAD"].includes(req.method)) {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath) {
      return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const headers = new Headers({
      "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
      "Cache-Control": path.basename(filePath) === "index.html"
        ? "no-cache"
        : "public, max-age=3600",
    });

    if (req.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    return new Response(Bun.file(filePath), { headers });
  },
});

console.log(`Hawky website serving ${rootDir} on ${listenHost}:${listenPort}`);
