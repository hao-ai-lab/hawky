import { spawn } from "node:child_process";

import { createSubsystemLogger } from "../logging/index.js";
import type { AppAuthRole, AppAuthUser } from "./app-auth.js";

const log = createSubsystemLogger("gateway/workspace-provisioner");

export interface WorkspaceProvisionRequest {
  user: AppAuthUser;
  role: AppAuthRole;
  admin: AppAuthUser;
}

export interface WorkspaceProvisionResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
}

export async function provisionWorkspaceForUser(
  request: WorkspaceProvisionRequest,
): Promise<WorkspaceProvisionResult> {
  const command = (process.env.HAWKY_WORKSPACE_PROVISION_COMMAND || "").trim();
  if (!command) {
    return { ok: true, skipped: true, message: "Workspace provisioning is not configured." };
  }

  const timeoutMs = envInt("HAWKY_WORKSPACE_PROVISION_TIMEOUT_MS", 120_000);
  const result = await runProvisionCommand(command, request, timeoutMs);
  if (result.ok) {
    log.info("workspace provisioned", { email: request.user.email, userId: request.user.id });
  } else {
    log.warn("workspace provisioning failed", {
      email: request.user.email,
      userId: request.user.id,
      message: result.message,
    });
  }
  return result;
}

function runProvisionCommand(
  command: string,
  request: WorkspaceProvisionRequest,
  timeoutMs: number,
): Promise<WorkspaceProvisionResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HAWKY_PROVISION_USER_ID: request.user.id,
        HAWKY_PROVISION_USER_EMAIL: request.user.email,
        HAWKY_PROVISION_USER_ROLE: request.role,
        HAWKY_PROVISION_ADMIN_EMAIL: request.admin.email,
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, message: `Workspace provisioning timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 8_000) stdout = stdout.slice(-8_000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: err.message });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = (stdout || stderr).trim();
      if (code === 0) {
        resolve({ ok: true, message: output || "Workspace provisioned." });
      } else {
        resolve({ ok: false, message: output || `Workspace provisioning exited with code ${code}.` });
      }
    });
  });
}

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
