// =============================================================================
// Tests: PWA Configuration
//
// Verifies that the PWA manifest, icons, and meta tags are properly configured.
// =============================================================================

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(__dirname, "..", "dist");
const publicDir = join(__dirname, "..", "public");

// Whether dist/ has been built (run `bun run build` in web/ first)
const distBuilt = existsSync(join(distDir, "index.html"));

describe("PWA assets", () => {
  it("has favicon.svg in public/", () => {
    expect(existsSync(join(publicDir, "favicon.svg"))).toBe(true);
  });

  it("has pwa-icon.svg in public/", () => {
    expect(existsSync(join(publicDir, "pwa-icon.svg"))).toBe(true);
  });

  it("pwa-icon.svg contains rocket emoji", () => {
    const content = readFileSync(join(publicDir, "pwa-icon.svg"), "utf-8");
    expect(content).toContain("🚀");
  });

  it("has pwa-icon-180.png (apple-touch-icon)", () => {
    expect(existsSync(join(publicDir, "pwa-icon-180.png"))).toBe(true);
  });

  it("has pwa-icon-192.png (manifest icon)", () => {
    expect(existsSync(join(publicDir, "pwa-icon-192.png"))).toBe(true);
  });

  it("has pwa-icon-512.png (manifest icon)", () => {
    expect(existsSync(join(publicDir, "pwa-icon-512.png"))).toBe(true);
  });
});

describe.skipIf(!distBuilt)("PWA manifest (build output)", () => {
  const manifestPath = join(distDir, "manifest.webmanifest");

  it("manifest file exists in dist/", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("manifest has correct app name", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.name).toBe("Hawky");
    expect(manifest.short_name).toBe("Hawky");
  });

  it("manifest has standalone display mode", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.display).toBe("standalone");
  });

  it("manifest has sized PNG icons", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const pngIcons = manifest.icons.filter((i: any) => i.type === "image/png");
    expect(pngIcons.length).toBeGreaterThanOrEqual(2);
    const sizes = pngIcons.map((i: any) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("manifest has start_url", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.start_url).toBe("/");
  });
});

describe.skipIf(!distBuilt)("PWA service worker (build output)", () => {
  it("sw-custom.js exists in dist/", () => {
    expect(existsSync(join(distDir, "sw-custom.js"))).toBe(true);
  });

  it("registerSW.js registers sw-custom.js", () => {
    const registerSW = readFileSync(join(distDir, "registerSW.js"), "utf-8");
    expect(registerSW).toContain("sw-custom.js");
  });
});

describe("PWA HTML meta tags", () => {
  it("index.html has apple-mobile-web-app-capable", () => {
    const html = readFileSync(join(__dirname, "..", "index.html"), "utf-8");
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('content="yes"');
  });

  it("index.html has apple-mobile-web-app-title", () => {
    const html = readFileSync(join(__dirname, "..", "index.html"), "utf-8");
    expect(html).toContain('name="apple-mobile-web-app-title"');
    expect(html).toContain("Hawky");
  });

  it("index.html has theme-color", () => {
    const html = readFileSync(join(__dirname, "..", "index.html"), "utf-8");
    expect(html).toContain('name="theme-color"');
  });

  it("index.html has viewport with viewport-fit=cover", () => {
    const html = readFileSync(join(__dirname, "..", "index.html"), "utf-8");
    expect(html).toContain("viewport-fit=cover");
  });

  it("index.html has apple-touch-icon pointing to PNG", () => {
    const html = readFileSync(join(__dirname, "..", "index.html"), "utf-8");
    expect(html).toContain("apple-touch-icon");
    expect(html).toContain("pwa-icon-180.png");
  });
});
