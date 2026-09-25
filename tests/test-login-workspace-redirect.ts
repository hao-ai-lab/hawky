import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppAuth } from "../src/gateway/app-auth.js";
import { GatewayServer, resetGatewayState, proxyCloseCode } from "../src/gateway/server.js";
import { resetConfig, resetConfigDir, setConfigDir } from "../src/storage/config.js";

const CONTROL_HOST = "app.hawky.live";
const ADMIN_HOST = "admin.hawky.live";

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
  let receivedWorkspaceHeaders: Headers;

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
      registrationAllowlist: ["juc049@ucsd.edu"],
    });
    auth.register("admin@example.com", "a long safe password");
    auth.register("juc049@ucsd.edu", "a long safe password");

    workspaceServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, socketServer) {
        if (req.headers.get("upgrade") === "websocket") return socketServer.upgrade(req) ? undefined : new Response("failed", {status:400});
        receivedWorkspaceHeaders = new Headers(req.headers);
        const url = new URL(req.url);
        return new Response(`workspace:${url.pathname}${url.search}`, {
          headers: {
            "Content-Type": "text/plain",
            "X-Workspace": "juc049",
          },
        });
      },
      websocket: { message(ws, message) { ws.send(message); } },
    });
    workspacePort = workspaceServer.port;

    const registryPath = join(configDir, "workspaces.json");
    writeFileSync(registryPath, JSON.stringify({
      users: [
        { slug: "juc049", email: "juc049@ucsd.edu", port: workspacePort },
        { slug: "admin", email: "admin@example.com", port: workspacePort },
      ],
    }, null, 2));

    process.env.HAWKY_APP_AUTH = "1";
    process.env.HAWKY_GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.HAWKY_GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.HAWKY_PUBLIC_REGISTRATION = "1";
    process.env.HAWKY_ADMIN_EMAILS = "admin@example.com";
    process.env.HAWKY_WORKSPACE_REGISTRY_FILE = registryPath;
    process.env.HAWKY_CONTROL_HOSTNAMES = `${CONTROL_HOST},${ADMIN_HOST}`;
    process.env.HAWKY_ADMIN_HOSTNAMES = ADMIN_HOST;

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
    delete process.env.HAWKY_AUTO_PROVISION;
    delete process.env.HAWKY_WORKSPACE_PROVISION_COMMAND;
    delete process.env.HAWKY_APP_AUTH;
    delete process.env.HAWKY_GOOGLE_CLIENT_ID;
    delete process.env.HAWKY_GOOGLE_CLIENT_SECRET;
    delete process.env.HAWKY_PUBLIC_REGISTRATION;
    delete process.env.HAWKY_ADMIN_EMAILS;
    delete process.env.HAWKY_WORKSPACE_REGISTRY_FILE;
    delete process.env.HAWKY_CONTROL_HOSTNAMES;
    delete process.env.HAWKY_ADMIN_HOSTNAMES;
  });

  test("automatic setup blocks device tokens and workspace access until ready", async () => {
    await server.stop(1000);
    process.env.HAWKY_AUTO_PROVISION = "1";
    process.env.HAWKY_WORKSPACE_PROVISION_COMMAND = "";
    server = new GatewayServer(); server.start(port);
    const login = await fetch(`http://localhost:${port}/auth/login`, {method:"POST",redirect:"manual",headers:{Host:CONTROL_HOST},body:formBody("juc049@ucsd.edu")});
    expect(login.headers.get("location")).toStartWith("/auth/workspace");
    for (const path of ["/ws", "/auth/login", "/health", "/admin"]) {
      const upgrade = await fetch(`http://localhost:${port}${path}`, {headers:{Host:CONTROL_HOST,Upgrade:"websocket"}});
      expect(upgrade.status).toBe(401);
    }
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const path of ["/", "/auth/device", "/api/workspace-defaults"]) {
      const response = await fetch(`http://localhost:${port}${path}`, {redirect:"manual",headers:{Host:CONTROL_HOST,Cookie:cookie}});
      expect(response.status).toBe(303); expect(response.headers.get("location")).toStartWith("/auth/workspace");
    }
    const status = await fetch(`http://localhost:${port}/auth/workspace/status`, {headers:{Host:CONTROL_HOST,Cookie:cookie}});
    expect((await status.json()).status).toBe("failed");
  });

  test("proxy injects the mapped credential and strips browser cookies", async () => {
    writeFileSync(join(configDir,"workspaces.json"), JSON.stringify({users:[{slug:"juc049",email:"juc049@ucsd.edu",port:workspacePort,ready:true,proxyToken:"private-workspace-secret"}]}));
    const login = await fetch(`http://localhost:${port}/auth/login`,{method:"POST",redirect:"manual",headers:{Host:CONTROL_HOST},body:formBody("juc049@ucsd.edu")});
    const cookie=login.headers.get("set-cookie")!.split(";")[0];
    const res=await fetch(`http://localhost:${port}/api/test`,{headers:{Host:CONTROL_HOST,Cookie:cookie,"X-Hawky-Workspace-Token":"attacker-selected"}});
    expect(res.status).toBe(200);expect(receivedWorkspaceHeaders.get("X-Hawky-Workspace-Token")).toBe("private-workspace-secret");expect(receivedWorkspaceHeaders.has("Cookie")).toBe(false);
  });

  test("proxied websocket retains session authentication after the HTTP request ends", async () => {
    const login=await fetch(`http://localhost:${port}/auth/login`,{method:"POST",redirect:"manual",headers:{Host:CONTROL_HOST},body:formBody("juc049@ucsd.edu")});
    const cookie=login.headers.get("set-cookie")!.split(";")[0];
    const ws=new WebSocket(`ws://localhost:${port}/ws`,{headers:{Host:CONTROL_HOST,Cookie:cookie}});
    try {
      await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=reject;});
      await Bun.sleep(5200);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      const echoed=new Promise<string>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("echo timeout")),1000);ws.onmessage=e=>{clearTimeout(t);resolve(String(e.data));};});
      ws.send("still connected");expect(await echoed).toBe("still connected");
    } finally {ws.close();}
  }, 10000);

  test("tenant gateway rejects direct localhost requests without its credential", async () => {
    process.env.HAWKY_WORKSPACE_PROXY_TOKEN="private-workspace-secret";process.env.HAWKY_APP_AUTH="0";
    const tenant=new GatewayServer();const tenantPort=getTestPort();tenant.start(tenantPort);
    delete process.env.HAWKY_WORKSPACE_PROXY_TOKEN;process.env.HAWKY_APP_AUTH="1";
    try {
      expect((await fetch(`http://localhost:${tenantPort}/health`)).status).toBe(401);
      expect((await fetch(`http://localhost:${tenantPort}/health`,{headers:{"X-Hawky-Workspace-Token":"wrong"}})).status).toBe(401);
      expect((await fetch(`http://localhost:${tenantPort}/health`,{headers:{"X-Hawky-Workspace-Token":"private-workspace-secret"}})).status).toBe(200);
    } finally {await tenant.stop(1000);}
  });

  test("control login keeps approved users on the control host", async () => {
    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: CONTROL_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  test("public password sign-up stays closed until email verification exists", async () => {
    const registration = await fetch(`http://localhost:${port}/auth/register`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: CONTROL_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("new-user@example.com"),
    });
    expect(registration.status).toBe(400);
    expect(await registration.text()).toContain("Registration is closed");
  });

  test("Google sign-in is offered and starts a protected authorization flow", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, { headers: { Host: CONTROL_HOST } });
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Continue with Google");

    const start = await fetch(`http://localhost:${port}/auth/google/start?return_url=%2Fsessions`, {
      redirect: "manual",
      headers: { Host: CONTROL_HOST },
    });
    expect(start.status).toBe(303);
    const authUrl = new URL(start.headers.get("location")!);
    expect(authUrl.hostname).toBe("accounts.google.com");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://app.hawky.live/auth/google/callback");
    expect(start.headers.get("set-cookie")).toContain("hawky_google_state=");
  });

  test("control host proxies already logged-in users to their workspace", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: CONTROL_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const res = await fetch(`http://localhost:${port}/`, {
      redirect: "manual",
      headers: { Host: CONTROL_HOST, Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-workspace")).toBe("juc049");
    expect(await res.text()).toBe("workspace:/");
  });

  test("control host preserves the path when proxying logged-in users", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: CONTROL_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("juc049@ucsd.edu"),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const res = await fetch(`http://localhost:${port}/sessions/today?mode=live`, {
      redirect: "manual",
      headers: { Host: CONTROL_HOST, Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-workspace")).toBe("juc049");
    expect(await res.text()).toBe("workspace:/sessions/today?mode=live");
  });

  test("control login redirects admins to admin dashboard", async () => {
    const res = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: CONTROL_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("admin@example.com"),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
  });

  test("control host proxies admin app routes while keeping admin routes on control", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: CONTROL_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("admin@example.com"),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const app = await fetch(`http://localhost:${port}/`, {
      redirect: "manual",
      headers: { Host: CONTROL_HOST, Cookie: cookie },
    });
    const admin = await fetch(`http://localhost:${port}/admin`, {
      redirect: "manual",
      headers: { Host: CONTROL_HOST, Cookie: cookie },
    });

    expect(app.status).toBe(200);
    expect(app.headers.get("x-workspace")).toBe("juc049");
    expect(await app.text()).toBe("workspace:/");
    expect(admin.status).toBe(200);
    expect(admin.headers.get("x-workspace")).toBeNull();
  });

  test("admin host routes root to admin instead of a workspace", async () => {
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Host: ADMIN_HOST, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody("admin@example.com"),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const root = await fetch(`http://localhost:${port}/`, {
      redirect: "manual",
      headers: { Host: ADMIN_HOST, Cookie: cookie },
    });
    const admin = await fetch(`http://localhost:${port}/admin`, {
      redirect: "manual",
      headers: { Host: ADMIN_HOST, Cookie: cookie },
    });

    expect(root.status).toBe(303);
    expect(root.headers.get("location")).toBe("/admin");
    expect(admin.status).toBe(200);
    expect(admin.headers.get("x-workspace")).toBeNull();
  });
});

test("proxy close converts reserved transport codes to a legal frame", () => {
  for (const code of [0, 1004, 1005, 1006, 1015]) expect(proxyCloseCode(code)).toBe(1011);
  for (const code of [1000, 1001, 1011, 4001]) expect(proxyCloseCode(code)).toBe(code);
});
