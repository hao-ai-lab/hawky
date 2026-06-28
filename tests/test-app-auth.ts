import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

  test("public registration creates pending users until an admin approves", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({ stateDir, publicRegistration: true, allowFirstUserRegistration: true });
      const { user: admin } = auth.register("admin@example.com", "a long safe password");
      const { user: pending, approvalRequired } = auth.register("new@example.com", "a long safe password");

      expect(approvalRequired).toBe(true);
      expect(pending.status).toBe("pending");
      expect(() => auth.login("new@example.com", "a long safe password")).toThrow("pending admin approval");

      const approved = auth.approveUser(admin, pending.id, "user");
      expect(approved.status).toBe("approved");
      expect(approved.role).toBe("user");
      expect(auth.login("new@example.com", "a long safe password").user.email).toBe("new@example.com");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("configured admin emails bootstrap admins while admins can promote others", () => {
    const stateDir = tempState();
    try {
      const auth = new AppAuth({
        stateDir,
        publicRegistration: true,
        allowFirstUserRegistration: true,
        adminEmails: ["owner@example.com"],
      });
      const { user: owner } = auth.register("owner@example.com", "a long safe password");
      const { user: pending } = auth.register("candidate@example.com", "a long safe password");

      expect(owner.role).toBe("admin");
      const approved = auth.approveUser(owner, pending.id, "admin");
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
      const auth = new AppAuth({ stateDir, publicRegistration: true, allowFirstUserRegistration: true });
      const { user: admin } = auth.register("admin@example.com", "a long safe password");
      const { user: pending } = auth.register("new@example.com", "a long safe password");
      auth.approveUser(admin, pending.id, "user");

      expect(() => auth.disableUser(admin, admin.id)).toThrow("cannot disable their own account");
      auth.disableUser(admin, pending.id);
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
});

describe("sanitizeReturnUrl", () => {
  test("allows relative paths and rejects open redirects", () => {
    expect(sanitizeReturnUrl("/settings")).toBe("/settings");
    expect(sanitizeReturnUrl("//evil.example")).toBe("/");
    expect(sanitizeReturnUrl("https://evil.example")).toBe("/");
    expect(sanitizeReturnUrl("")).toBe("/");
  });
});
