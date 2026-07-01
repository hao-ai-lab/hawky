import { afterEach, describe, expect, test } from "bun:test";

import { provisionWorkspaceForUser } from "../src/gateway/workspace-provisioner.js";

const user = { id: "u_123", email: "new@example.com", role: "user" as const, status: "approved" as const };
const admin = { id: "a_123", email: "admin@example.com", role: "admin" as const, status: "approved" as const };

afterEach(() => {
  delete process.env.HAWKY_WORKSPACE_PROVISION_COMMAND;
  delete process.env.HAWKY_WORKSPACE_PROVISION_TIMEOUT_MS;
});

describe("workspace provisioner", () => {
  test("skips when no command is configured", async () => {
    const result = await provisionWorkspaceForUser({ user, role: "user", admin });
    expect(result).toEqual({ ok: true, skipped: true, message: "Workspace provisioning is not configured." });
  });

  test("passes approved user context to the provision command", async () => {
    process.env.HAWKY_WORKSPACE_PROVISION_COMMAND = "printf '%s|%s|%s|%s' \"$HAWKY_PROVISION_USER_ID\" \"$HAWKY_PROVISION_USER_EMAIL\" \"$HAWKY_PROVISION_USER_ROLE\" \"$HAWKY_PROVISION_ADMIN_EMAIL\"";
    const result = await provisionWorkspaceForUser({ user, role: "admin", admin });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("u_123|new@example.com|admin|admin@example.com");
  });

  test("reports command failures", async () => {
    process.env.HAWKY_WORKSPACE_PROVISION_COMMAND = "echo failed >&2; exit 9";
    const result = await provisionWorkspaceForUser({ user, role: "user", admin });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("failed");
  });
});
