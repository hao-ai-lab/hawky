import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../storage/config.js";
import type { AppAuthUser } from "./app-auth.js";
import { provisionWorkspaceForUser } from "./workspace-provisioner.js";
import { findWorkspaceForUser } from "./workspace-registry.js";

export interface WorkspaceSetupState {
  status: "pending" | "provisioning" | "ready" | "failed" | "disabled";
  attempt: number;
  updatedAt: string;
  error?: string;
}
/** Persist progress; interrupted setup resumes on the next authenticated poll/login.
 * The privileged helper must also be idempotent and lock its resource registry. */
export class WorkspaceSetup {
  private running = new Map<string, Promise<void>>();
  private directory = join(getConfigDir(), "state", "workspace-setup");
  constructor(private currentUser: (id: string) => AppAuthUser | undefined) {}
  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid user ID");
    return join(this.directory, `${id}.json`);
  }
  get(user: AppAuthUser): WorkspaceSetupState {
    if (user.status !== "approved") return { status: "disabled", attempt: 0, updatedAt: "" };
    try {
      const saved = JSON.parse(readFileSync(this.path(user.id), "utf8")) as WorkspaceSetupState;
      if (saved.status === "disabled" || (saved.status === "ready" && !findWorkspaceForUser(user)?.ready)) return { ...saved, status: "pending" };
      return saved;
    } catch {}
    if (findWorkspaceForUser(user)?.ready) return { status: "ready", attempt: 0, updatedAt: "" };
    return { status: "pending", attempt: 0, updatedAt: "" };
  }
  private save(user: AppAuthUser, state: WorkspaceSetupState) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.path(user.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  ensure(user: AppAuthUser, retry = false): WorkspaceSetupState {
    const state = this.get(user);
    if (this.running.has(user.id) || state.status === "ready" || state.status === "disabled" || (state.status === "failed" && !retry)) return state;
    const next: WorkspaceSetupState = { status: "provisioning", attempt: state.attempt + 1, updatedAt: new Date().toISOString() };
    this.save(user, next);
    const job = (async () => {
      const result = await provisionWorkspaceForUser({ user, role: user.role, admin: user });
      const latest = this.currentUser(user.id);
      if (!latest || latest.status !== "approved") {
        await provisionWorkspaceForUser({ user, role: user.role, admin: user, action: "disable" });
        this.save(user, { ...next, status: "disabled", updatedAt: new Date().toISOString() });
      } else {
        const ready = result.ok && !result.skipped && Boolean(findWorkspaceForUser(user)?.ready);
        this.save(user, { ...next, status: ready ? "ready" : "failed", updatedAt: new Date().toISOString(),
          ...(ready ? {} : { error: "Workspace setup failed. Retry setup or contact the administrator." }) });
      }
    })().catch(() => this.save(user, { ...next, status: "failed", error: "Workspace setup failed. Please retry." }))
      .finally(() => this.running.delete(user.id));
    this.running.set(user.id, job);
    return next;
  }
  async disable(user: AppAuthUser) {
    this.save(user, { status: "disabled", attempt: this.get(user).attempt, updatedAt: new Date().toISOString() });
    const result = await provisionWorkspaceForUser({ user, role: user.role, admin: user, action: "disable" });
    if (!result.ok || result.skipped) throw new Error("Account access is disabled, but runtime cleanup failed. Retry disabling this account.");
  }
}

export function workspaceSetupPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setting up your workspace</title><style>body{font:18px system-ui;max-width:540px;margin:15vh auto;padding:24px;background:#101412;color:#eee}button,a{font:inherit;color:inherit}button{background:#344432;padding:12px;border:1px solid #678;border-radius:8px}</style>
<h1>Setting up your workspace</h1><p id="status">Preparing your private files and backend assistant…</p><button id="retry" hidden>Retry setup</button> <a href="/auth/logout">Sign out</a>
<script>
const text=document.getElementById('status'),button=document.getElementById('retry');
async function poll(retry=false){try{const r=await fetch('/auth/workspace/status',{method:retry?'POST':'GET',credentials:'same-origin'});if(r.status===401){location.replace('/auth/login');return;}const s=await r.json();if(s.status==='ready'){const u=new URL(location.href).searchParams.get('return_url');location.replace(u&&new URL(u,location.origin).origin===location.origin&&!u.startsWith('/auth/workspace')?u:'/');return;}button.hidden=s.status!=='failed';text.textContent=s.status==='failed'?'Setup could not finish. Your account is saved. Retry to continue.':s.status==='disabled'?'This account is disabled.':'Preparing your private files and backend assistant…';if(s.status==='pending'||s.status==='provisioning')setTimeout(poll,2000);}catch{ text.textContent='Connection lost. Reconnecting…';setTimeout(poll,4000);}}
button.onclick=()=>poll(true);poll();</script></html>`;
}
