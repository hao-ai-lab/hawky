import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMediaRoot } from "../src/gateway/media-root.js";
import {
  getDefaultConfig,
  resetConfig,
  resetConfigDir,
  saveConfig,
  setConfigDir,
} from "../src/storage/config.js";

describe("resolveMediaRoot", () => {
  let configDir: string;
  let previousMediaRoot: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "hawky-media-root-test-"));
    previousMediaRoot = process.env.HAWKY_MEDIA_ROOT;
    delete process.env.HAWKY_MEDIA_ROOT;
    setConfigDir(configDir);
  });

  afterEach(() => {
    if (previousMediaRoot === undefined) {
      delete process.env.HAWKY_MEDIA_ROOT;
    } else {
      process.env.HAWKY_MEDIA_ROOT = previousMediaRoot;
    }
    resetConfigDir();
    resetConfig();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("uses HAWKY_MEDIA_ROOT when set", () => {
    process.env.HAWKY_MEDIA_ROOT = "/tmp/hawky-media-env";

    expect(resolveMediaRoot()).toBe("/tmp/hawky-media-env");
  });

  test("uses configured media.root when env override is absent", () => {
    const config = getDefaultConfig();
    config.media = {
      ...config.media,
      root: "/tmp/hawky-media-config",
    };
    saveConfig(config);

    expect(resolveMediaRoot()).toBe("/tmp/hawky-media-config");
  });

  test("falls back to default media root (under the configured root) when config has no root", () => {
    // The default now derives from the Hawky config root, so overriding the
    // root via setConfigDir() relocates the media root too (no ~/.hawky leak).
    expect(resolveMediaRoot()).toBe(join(configDir, "workspace", "media"));
  });
});
