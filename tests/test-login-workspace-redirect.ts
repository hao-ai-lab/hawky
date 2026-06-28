import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppAuth } from "../src/gateway/app-auth.js";
import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { resetConfig, resetConfigDir, setConfigDir } from "../src/storage/config.js";

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function formBody(email: string, password = "a long safe password"): URLSearchParams {
  const form = new URLSearchParams();
  form.set("email", email);
  form.set("password", password);
  form.set("return_url", "/");
  return form;
}

describe("login workspace routing", () => {
  let server: GatewayServer;
  let workspaceServer: ReturnType<typeof Bun.serve>;
  let port: number;
  let workspacePort: number;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "hawky-login-redirect-"));
    setConfigDir(configDir);
    resetConfig();
    resetGatewayState();

    const stateDir = join(configDir, "state");
    const auth = new AppAuth({
      stateDir,
      allowFirstUserRegistration: true,
      publicRegistration: true,
      adminEmails: ["admin@example.com"],
    });
    const { user: admin } = auth.register("admin@example.com", "a long safe password");
    const { user: pending } = auth.register("juc049@ucsd.edu", "a long safe password");
    auth.approveUser(admin, pending.id, "user");

    workspaceServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        return new Response(`workspace:${url.pathname}${url.search}`, {
          headers: {
            "Content-Type": "text/plain",
            "X-Workspace": "juc049",
          },
        });
      },
    });
    workspacePort = workspaceServer.port;

    const registryPath = join(configDir, "workspaces.json");
    writeFileSync(registryPath, JSON.stringify({
      users: [
        { slug: "juc049", email: "juc049@ucsd.edu", hostname: "juc049.hawky.live", port: workspacePort },
      ],
    }, null, 2));

    process.env.HAWKY_APP_AUTH = "1";
    process.env.HAWKY_PUBLIC_REGISTRATION = "1";
    process.env.HAWKY_ADMIN_EMAILS = "admin@example.com";
    process.env.HAWKY_WORKSPACE_REGISTRY_FILE = registryPath;
    process.env.HAWKY_CONTROL_HOSTNAMES = "hawky.live";

    server = new GatewayServer();
    port = getTestPort();
    server.start(port);
  });

  afterEach(async () => {
    await server.stop(1000);
    workspaceServer.stop();
    resetGatewayState();
    resetConfigDir();
    resetConfig();
    rmSync(configDir, { recursive: true, force: true });
    delete process.env.HAWKY_APP_AUTH;
    delete process.env.HAWKY_PUBLIC_REGISTRATION;
    delete process.env.HAWKY_ADMIN_EMAILS;
    delete process.env.HAWKY_WORKSPACE_REGISTRY_FILE;
    delete process.env.HAWKY_CONTROL_HOSTNAMES;
  });

  test("control login keeps approved users on the control host", async () => {
    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: "hawky.live", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  test("control host proxies already logged-in users to their workspace", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: "hawky.live", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const res = await fetch(`http://localhost:${port}/`, {
      redirect: "manual",
      headers: { Host: "hawky.live", Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-workspace")).toBe("juc049");
    expect(await res.text()).toBe("workspace:/");
  });

  test("control host preserves the path when proxying logged-in users", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: "hawky.live", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const res = await fetch(`http://localhost:${port}/sessions/today?mode=live`, {
      redirect: "manual",
      headers: { Host: "hawky.live", Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-workspace")).toBe("juc049");
    expect(await res.text()).toBe("workspace:/sessions/today?mode=live");
  });

  test("workspace-host login stays on the workspace", async () => {
    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: "juc049.hawky.live", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  test("control login redirects admins to admin dashboard", async () => {
    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: "hawky.live", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("admin@example.com"),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
  });
});
