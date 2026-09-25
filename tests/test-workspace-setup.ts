import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSetup } from "../src/gateway/workspace-setup.js";
import type { AppAuthUser } from "../src/gateway/app-auth.js";
import { setConfigDir, resetConfigDir } from "../src/storage/config.js";
let dir: string, setup: WorkspaceSetup;
let user: AppAuthUser;
const env = { ...process.env };
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "hawky-setup-")); setConfigDir(dir);
 user = { id:"a".repeat(32), email:"setup@example.com", role:"user", status:"approved", createdAt:new Date().toISOString() } as AppAuthUser;
 process.env.HAWKY_WORKSPACE_REGISTRY_FILE = join(dir,"registry.json");
 const script = join(dir,"helper.cjs");
 writeFileSync(script, `const fs=require('fs');const p=process.env.HAWKY_WORKSPACE_REGISTRY_FILE;fs.appendFileSync(p+'.calls',process.env.HAWKY_PROVISION_ACTION+'\\n');setTimeout(()=>fs.writeFileSync(p,JSON.stringify({users:[{userId:process.env.HAWKY_PROVISION_USER_ID,email:process.env.HAWKY_PROVISION_USER_EMAIL,slug:'test',port:4301,ready:process.env.HAWKY_PROVISION_ACTION!=='disable'}]})),50);`);
 process.env.HAWKY_WORKSPACE_PROVISION_COMMAND = `${process.execPath} ${script}`;
 setup = new WorkspaceSetup(() => user);
});
afterEach(() => { resetConfigDir(); rmSync(dir,{recursive:true,force:true}); for(const k of ["HAWKY_WORKSPACE_REGISTRY_FILE","HAWKY_WORKSPACE_PROVISION_COMMAND"]){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];} });
async function finished() {for(let i=0;i<100;i++){await Bun.sleep(20);if(setup.get(user).status!=="provisioning")return;}throw new Error("setup timed out");}
test("one job per user; readiness requires the helper registry", async()=>{
 expect(setup.ensure(user).status).toBe("provisioning"); setup.ensure(user);setup.ensure(user);
 await finished(); expect(setup.get(user).status).toBe("ready");
 expect(readFileSync(join(dir,"registry.json.calls"),"utf8").trim()).toBe("provision");
});
test("failure stays failed until retry; skips cannot mark ready",async()=>{
 process.env.HAWKY_WORKSPACE_PROVISION_COMMAND="";setup.ensure(user);await finished();expect(setup.get(user).status).toBe("failed");expect(setup.ensure(user).status).toBe("failed");
 process.env.HAWKY_WORKSPACE_PROVISION_COMMAND=`${process.execPath} ${join(dir,"helper.cjs")}`;
 setup.ensure(user,true);await finished();expect(setup.get(user).status).toBe("ready");
});
test("interrupted setup resumes and stale ready state cannot expose default workspace",async()=>{
 mkdirSync(join(dir,"state/workspace-setup"),{recursive:true});writeFileSync(join(dir,"state/workspace-setup",user.id+".json"),JSON.stringify({status:"provisioning",attempt:1,updatedAt:""}));
 expect(setup.ensure(user).attempt).toBe(2);await finished();expect(setup.get(user).status).toBe("ready");
 writeFileSync(join(dir,"registry.json"),JSON.stringify({users:[]}));expect(setup.get(user).status).toBe("pending");
});
test("disable and reapprove preserve identity but require setup again",async()=>{
 setup.ensure(user);await finished();user={...user,status:"disabled"};await setup.disable(user);expect(setup.get(user).status).toBe("disabled");
 user={...user,status:"approved"};expect(setup.ensure(user,true).status).toBe("provisioning");await finished();expect(setup.get(user).status).toBe("ready");
});
