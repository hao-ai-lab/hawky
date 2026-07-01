import { existsSync, readFileSync } from "node:fs";

import type { AppAuthUser } from "./app-auth.js";

export interface WorkspaceRegistryUser {
  slug: string;
  email: string;
  hostname?: string;
  port?: number;
  linuxUser?: string;
  userId?: string;
}

interface WorkspaceRegistryFile {
  users?: WorkspaceRegistryUser[];
}

export function findWorkspaceForUser(user: AppAuthUser): WorkspaceRegistryUser | null {
  const registryPath = (process.env.HAWKY_WORKSPACE_REGISTRY_FILE || "").trim();
  if (!registryPath || !existsSync(registryPath)) return null;
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as WorkspaceRegistryFile;
    const users = Array.isArray(registry.users) ? registry.users : [];
    const email = user.email.toLowerCase();
    return users.find((entry) => String(entry.email || "").toLowerCase() === email) ?? null;
  } catch {
    return null;
  }
}

export function workspaceLocalTargetForUser(user: AppAuthUser): string | null {
  const workspace = findWorkspaceForUser(user);
  const port = Number(workspace?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `127.0.0.1:${port}`;
}

export function isControlHost(host: string): boolean {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const configured = (process.env.HAWKY_CONTROL_HOSTNAMES || "app.hawky.live,admin.hawky.live,realtime-gateway.hawky.live")
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(hostname);
}

export function isAdminHost(host: string): boolean {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const configured = (process.env.HAWKY_ADMIN_HOSTNAMES || "admin.hawky.live")
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(hostname);
}
