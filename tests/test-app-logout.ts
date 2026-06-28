import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { resetConfig, resetConfigDir, setConfigDir } from "../src/storage/config.js";

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

describe("app logout", () => {
  let server: GatewayServer;
  let port: number;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "hawky-app-logout-"));
    setConfigDir(configDir);
    resetConfig();
    resetGatewayState();
    process.env.HAWKY_APP_AUTH = "1";
    server = new GatewayServer();
    port = getTestPort();
    server.start(port);
  });

  afterEach(async () => {
    await server.stop(1000);
    resetGatewayState();
    resetConfigDir();
    resetConfig();
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.HAWKY_APP_AUTH;
  });

  test("clears the session cookie and browser device tokens", async () => {
    const res = await fetch(`http://localhost:${port}/auth/logout?return_url=/auth/login`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("hawky_session=;");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(body).toContain("localStorage.removeItem");
    expect(body).toContain("hawky_device_token");
    expect(body).toContain("/auth/login");
  });
});
