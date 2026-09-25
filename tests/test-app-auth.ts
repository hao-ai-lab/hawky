import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppAuth, sanitizeReturnUrl } from "../src/gateway/app-auth.js";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "hawky-app-auth-"));
}

describe("AppAuth", () => {
  test("first-user bootstrap can register and login with a signed cookie token", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, allowFirstUserRegistration: true });
      expect(auth.getUserCount()).toBe(0);
      expect(auth.canRegister()).toBe(true);

      const { user } = auth.register("Owner@Example.com", "a long safe password");
      expect(user.email).toBe("owner@example.com");
      expect(user.role).toBe("admin");
      expect(user.status).toBe("approved");
      expect(auth.getUserCount()).toBe(1);
      expect(auth.canRegister()).toBe(false);

      const login = auth.login("owner@example.com", "a long safe password");
      expect(login.user.id).toBe(user.id);
      expect(login.token.split(".").length).toBe(2);

      const req = new Request("https://hawky.live/auth/me", {
        headers: { Cookie: `hawky_session=${encodeURIComponent(login.token)}` },
      });
      expect(auth.userFromRequest(req)).toEqual(login.user);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("invite-gated registration rejects missing or wrong codes", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, registrationCode: "invite-123" });
      expect(() => auth.register("a@example.com", "a long safe password")).toThrow("Invalid registration code");
      expect(() => auth.register("a@example.com", "a long safe password", "wrong")).toThrow("Invalid registration code");

      const { user } = auth.register("a@example.com", "a long safe password", "invite-123");
      expect(user.email).toBe("a@example.com");
      expect(user.status).toBe("approved");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("admin allowlist permits only approved registration emails", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, registrationAllowlist: ["approved@example.com"] });
      expect(auth.canRegister()).toBe(true);
      expect(() => auth.register("stranger@example.com", "a long safe password")).toThrow("Registration is closed");

      const { user } = auth.register("Approved@Example.com", "a long safe password");
      expect(user.email).toBe("approved@example.com");
      expect(user.status).toBe("approved");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("public access does not allow unverified password registration", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, publicRegistration: true, allowFirstUserRegistration: true });
      const { user: admin } = auth.register("admin@example.com", "a long safe password");
      expect(admin.role).toBe("admin");
      expect(auth.canRegister()).toBe(false);
      expect(() => auth.register("new@example.com", "a long safe password")).toThrow("Registration is closed");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("existing pending accounts become regular users while disabled accounts stay blocked", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, publicRegistration: true, allowFirstUserRegistration: true, registrationCode: "invite-123" });
      const { user: admin } = auth.register("admin@example.com", "a long safe password");
      auth.register("waiting@example.com", "a long safe password", "invite-123");
      const { user: disabled } = auth.register("disabled@example.com", "a long safe password", "invite-123");
      auth.disableUser(admin, disabled.id);

      const path = join(stateDir, "users.json");
      const store = JSON.parse(readFileSync(path, "utf-8")) as { users: Array<{ email: string; status: string; role: string }> };
      const waiting = store.users.find((user) => user.email === "waiting@example.com")!;
      waiting.status = "pending";
      waiting.role = "admin"; // A legacy password registration must not acquire admin rights.
      writeFileSync(path, JSON.stringify(store));

      expect(auth.login("waiting@example.com", "a long safe password").user).toMatchObject({ status: "approved", role: "user" });
      expect(() => auth.login("disabled@example.com", "a long safe password")).toThrow("disabled");
      expect(auth.listUsers(admin).some((user) => user.status === "pending")).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("configured admin emails require a verified Google identity for admin access", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({
        stateDir,
        publicRegistration: true,
        allowFirstUserRegistration: true,
        adminEmails: ["owner@example.com"],
        registrationCode: "invite-123",
      });
      const { user: passwordUser } = auth.register("owner@example.com", "a long safe password", "invite-123");
      expect(passwordUser.role).toBe("user");
      expect(() => auth.loginWithGoogle({ sub: "google-owner", email: "owner@example.com", hostedDomain: "example.com" })).toThrow("password first");
      const { user: owner } = auth.loginWithGoogle({ sub: "google-owner", email: "owner@example.com", hostedDomain: "example.com" }, passwordUser.id);
      const { user: candidate } = auth.register("candidate@example.com", "a long safe password", "invite-123");

      expect(owner.role).toBe("admin");
      const approved = auth.approveUser(owner, candidate.id, "admin");
      expect(approved.role).toBe("admin");
      expect(auth.listUsers(owner).filter((user) => user.role === "admin").map((user) => user.email).sort()).toEqual([
        "candidate@example.com",
        "owner@example.com",
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("admins can disable users but not themselves", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, publicRegistration: true, allowFirstUserRegistration: true, registrationCode: "invite-123" });
      const { user: admin } = auth.register("admin@example.com", "a long safe password");
      const { user } = auth.register("new@example.com", "a long safe password", "invite-123");

      expect(() => auth.disableUser(admin, admin.id)).toThrow("cannot disable their own account");
      auth.disableUser(admin, user.id);
      expect(() => auth.login("new@example.com", "a long safe password")).toThrow("disabled");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("registration is closed without invite or first-user bootstrap", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir });
      expect(auth.canRegister()).toBe(false);
      expect(() => auth.register("a@example.com", "a long safe password")).toThrow("Registration is closed");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("login rejects bad passwords and session tampering", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, allowFirstUserRegistration: true });
      auth.register("a@example.com", "a long safe password");
      expect(() => auth.login("a@example.com", "wrong password")).toThrow("Invalid email or password");

      const login = auth.login("a@example.com", "a long safe password");
      const req = new Request("https://hawky.live/auth/me", {
        headers: { Cookie: `hawky_session=${encodeURIComponent(`${login.token}tampered`)}` },
      });
      expect(auth.userFromRequest(req)).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("session cookie can be scoped to the parent domain", () => {
    const previous = process.env.HAWKY_SESSION_COOKIE_DOMAIN;
    process.env.HAWKY_SESSION_COOKIE_DOMAIN = ".hawky.live";
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, allowFirstUserRegistration: true });
      auth.register("a@example.com", "a long safe password");
      const login = auth.login("a@example.com", "a long safe password");
      expect(auth.createSessionCookie(login.token)).toContain("Domain=.hawky.live");
      expect(auth.clearSessionCookie()).toContain("Domain=.hawky.live");
      expect(auth.clearSessionCookies()).toEqual([
        "hawky_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        "hawky_session=; Path=/; Domain=.hawky.live; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      ]);
    } finally {
      if (previous === undefined) delete process.env.HAWKY_SESSION_COOKIE_DOMAIN;
      else process.env.HAWKY_SESSION_COOKIE_DOMAIN = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("Google registration signs in immediately and keeps an immutable provider ID", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, publicRegistration: true, adminEmails: ["owner@gmail.com"] });
      const owner = auth.loginWithGoogle({ sub: "google-owner", email: "owner@gmail.com" });
      expect(owner.user.role).toBe("admin");
      const newUser = auth.loginWithGoogle({ sub: "google-new", email: "new@gmail.com" });
      expect(newUser.user.status).toBe("approved");
      expect(newUser.user.role).toBe("user");
      expect(newUser.token).toBeTruthy();
      expect(auth.loginWithGoogle({ sub: "google-new", email: "new@gmail.com" }).user.id).toBe(newUser.user.id);
      expect(() => auth.loginWithGoogle({ sub: "other-google-account", email: "new@gmail.com" })).toThrow("another Google account");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("an existing Gmail account can add Google sign-in without losing password access", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, allowFirstUserRegistration: true });
      const { user } = auth.register("owner@gmail.com", "a long safe password");
      expect(() => auth.loginWithGoogle({ sub: "google-owner", email: user.email })).toThrow("password first");
      const linked = auth.loginWithGoogle({ sub: "google-owner", email: user.email }, user.id);
      expect(linked.user.id).toBe(user.id);
      expect(auth.loginWithGoogle({ sub: "google-owner", email: user.email }).token).toBeTruthy();
      expect(auth.login(user.email, "a long safe password").user.id).toBe(user.id);
      expect(() => auth.loginWithGoogle({ sub: "google-owner", email: "other@gmail.com" })).toThrow("email changed");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("an unhosted Google email needs a signed-in account to link", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, allowFirstUserRegistration: true });
      const { user } = auth.register("owner@example.com", "a long safe password");
      expect(() => auth.loginWithGoogle({ sub: "google-owner", email: user.email })).toThrow("password first");
      expect(auth.loginWithGoogle({ sub: "google-owner", email: user.email }, user.id).user.id).toBe(user.id);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a new Google account cannot claim an unhosted admin email", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, publicRegistration: true, adminEmails: ["owner@example.com"] });
      expect(() => auth.loginWithGoogle({ sub: "unhosted", email: "owner@example.com" })).toThrow("cannot verify this email domain");
      const hosted = auth.loginWithGoogle({ sub: "hosted", email: "owner@example.com", hostedDomain: "example.com" });
      expect(hosted.user.role).toBe("admin");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeReturnUrl", () => {
  test("allows relative paths and rejects open redirects", () => {
    expect(sanitizeReturnUrl("/settings")).toBe("/settings");
    expect(sanitizeReturnUrl("//evil.example")).toBe("/");
    expect(sanitizeReturnUrl("https://evil.example")).toBe("/");
    expect(sanitizeReturnUrl("/\\evil.example")).toBe("/");
    expect(sanitizeReturnUrl("")).toBe("/");
  });
});
