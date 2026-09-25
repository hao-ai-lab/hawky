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
<title>Setting up your workspace</title><style>
body{font:17px/1.5 system-ui;max-width:540px;margin:12vh auto;padding:24px;background:#101412;color:#eee}
h1{font-size:32px;line-height:1.2;margin:0 0 20px}button,a{font:inherit;color:inherit}
button{background:#344432;padding:12px;border:1px solid #678;border-radius:8px;cursor:pointer}
progress{display:block;width:100%;height:10px;border:0;border-radius:8px;overflow:hidden;background:#303a32;accent-color:#dba446}
progress::-webkit-progress-bar{background:#303a32}progress::-webkit-progress-value{background:#dba446}
progress:indeterminate{background:linear-gradient(90deg,#303a32 25%,#dba446 50%,#303a32 75%);background-size:200% 100%;animation:working 2s linear infinite}
progress:indeterminate::-webkit-progress-bar{background:transparent}
@keyframes working{to{background-position:-200% 0}}
@media(prefers-reduced-motion:reduce){progress:indeterminate{animation:none}}
[hidden]{display:none!important}.detail{color:#adb8af;font-size:15px}ul{padding-left:22px}footer{display:flex;align-items:center;gap:20px;margin-top:28px}
</style>
<main><h1>Setting up your workspace</h1>
<p id="status" role="status">Preparing your private workspace and assistant…</p>
<progress id="progress" aria-label="Workspace setup in progress"></progress>
<p id="elapsed" class="detail">Setup in progress · 0 seconds elapsed</p>
<p class="detail">We’re preparing:</p><ul class="detail"><li>Your private files and conversation storage</li><li>Your included model access</li><li>Your backend assistant, checked before you enter</li></ul>
<p class="detail">This page opens your workspace automatically when it’s ready. Refreshing won’t restart your setup.</p>
<footer><button id="retry" hidden>Retry setup</button><a href="/auth/logout">Sign out</a></footer></main>
<script>
const text=document.getElementById('status'),button=document.getElementById('retry'),bar=document.getElementById('progress'),elapsed=document.getElementById('elapsed');
let started=Date.now(),active=true,phase='Setup in progress';
function tick(){if(active)elapsed.textContent=phase+' · '+Math.floor((Date.now()-started)/1000)+' seconds elapsed';}
setInterval(tick,1000);
async function poll(retry=false){
 if(retry){button.hidden=true;active=true;started=Date.now();phase='Retrying setup';bar.hidden=false;text.textContent='Retrying your workspace setup…';tick();}
 try{
  const r=await fetch('/auth/workspace/status',{method:retry?'POST':'GET',credentials:'same-origin'});
  if(r.status===401){location.replace('/auth/login');return;}
  if(!r.ok)throw new Error('Setup status unavailable');
  const s=await r.json();
  if(s.status==='ready'){active=false;bar.hidden=false;bar.value=1;bar.max=1;text.textContent='Your workspace is ready';elapsed.textContent='Opening your workspace…';const u=new URL(location.href).searchParams.get('return_url');location.replace(u&&new URL(u,location.origin).origin===location.origin&&!u.startsWith('/auth/workspace')?u:'/');return;}
  active=s.status==='pending'||s.status==='provisioning';bar.hidden=!active;button.hidden=s.status!=='failed';
  text.textContent=s.status==='failed'?'Setup could not finish. Your account is saved. Retry to continue.':s.status==='disabled'?'This account is disabled.':'Preparing your private workspace and assistant…';
  phase='Setup in progress';
  if(active){const since=Date.parse(s.updatedAt);if(Number.isFinite(since))started=since;tick();setTimeout(poll,2000);}else{elapsed.textContent=s.status==='failed'?'Setup paused':'Setup stopped';}
 }catch{active=true;phase='Reconnecting';bar.hidden=false;text.textContent='Connection lost. Reconnecting…';tick();setTimeout(poll,4000);}
}
button.onclick=()=>poll(true);poll();</script></html>`;
}
