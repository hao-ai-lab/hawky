/** Opt-in real CLI probe. Uses local Codex login, creates two conversations and
 * temporary fixtures; never touches the user's workspace or active Hawk tasks.
 * HAWKY_CODEX_BIN=/path/to/codex bun scripts/probe-delegation-workers.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerDelegationMethods } from "../src/gateway/delegation-methods.js";
import { ExternalAgentRuntime, resolveRuntimeExecutable } from "../src/gateway/external-agent-runtime.js";
import { setSessionsDir } from "../src/storage/session.js";

const base = join(homedir(), ".hawky", "probes"); mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, "workers-"));
const previous = setSessionsDir(join(dir, "state"));
// Some CLI versions omit failed commands from their JSONL item stream. Capture
// sandbox diagnostics as well so a verbal refusal cannot pass the denial check.
const originalBin = process.env.HAWKY_CODEX_BIN, binary = resolveRuntimeExecutable("codex");
const wrapper = join(dir, "codex-probe"), diagnostics = join(dir, "cli-stderr.txt");
writeFileSync(wrapper, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const child = Bun.spawn([${JSON.stringify(binary)}, ...process.argv.slice(2)], {stdin:'inherit', stdout:'inherit', stderr:'pipe'});
const errors = await new Response(child.stderr).text();
appendFileSync(${JSON.stringify(diagnostics)}, errors);
process.stderr.write(errors);
process.exit(await child.exited);
`, { mode: 0o755 });
process.env.HAWKY_CODEX_BIN = wrapper;
writeFileSync(join(dir, "alpha.txt"), "ALPHA_42_INDIGO");
writeFileSync(join(dir, "beta.txt"), "BETA_73_COPPER");
const workers = new Map<string, { runtime: ExternalAgentRuntime; sessionId?: string }>();
const conn = { deviceTokenId: "worker-probe", bindSession() {} } as any;
const running: Promise<unknown>[] = [];
const service = registerDelegationMethods({ registerMethod() {}, broadcastToSession() {} } as any, async (_conn, task, observer) => {
  let worker = workers.get(task.backendSession);
  if (!worker) { worker = { runtime: new ExternalAgentRuntime() }; workers.set(task.backendSession, worker); }
  observer.started(undefined);
  const result = await worker.runtime.sendMessage({ runtimeKind: "codex", sessionKey: task.backendSession,
    cwd: dir, history: [], message: task.request, persistent: true, runtimeSessionId: worker.sessionId,
    readOnly: observer.readOnly, signal: observer.signal, emit: observer.event,
    onRuntime(details) { worker!.sessionId = details.sessionId ?? worker!.sessionId; observer.runtime?.(details); },
  });
  return { reply: result.assistantText };
}, { cancel: task => workers.get(task.backendSession)?.runtime.cancel() });
const start = (id: string, message: string, continueTask?: string) => {
  const run = service.submit(conn, { ownerSession: "probe", id, message, runtime: "codex", execution: "read_only", continueTask });
  running.push(run.promise); return run.promise;
};
try {
  const a = start("alpha", "Use a shell command to sleep 12 seconds, then cat alpha.txt. Return only the file content.");
  const b = start("beta", "Use a shell command to cat beta.txt. Return only the file content.");
  const [alpha, beta] = await Promise.all([a, b]);
  assert.equal(alpha.status, "completed", alpha.error); assert.equal(beta.status, "completed", beta.error);
  assert.ok(alpha.result?.includes("ALPHA_42_INDIGO")); assert.ok(beta.result?.includes("BETA_73_COPPER"));
  assert.ok(alpha.runtimeSessionId && beta.runtimeSessionId);
  assert.notEqual(alpha.runtimeSessionId, beta.runtimeSessionId);
  assert.ok(beta.startedAt! < alpha.completedAt! && alpha.startedAt! < beta.completedAt!);
  console.log(JSON.stringify({ check: "concurrent separate conversations", pass: true,
    alpha: alpha.runtimeSessionId, beta: beta.runtimeSessionId, firstFinished: beta.completedAt! < alpha.completedAt! ? "beta" : "alpha" }));
  const follow = await start("follow-up", "Without reading any files again, what exact token did you read in your previous turn? Return only it.", "alpha");
  assert.equal(follow.status, "completed", follow.error);
  assert.equal(follow.runtimeSessionId, alpha.runtimeSessionId);
  assert.ok(follow.result?.includes("ALPHA_42_INDIGO"));
  console.log(JSON.stringify({ check: "follow-up resumes alpha", pass: true, session: follow.runtimeSessionId }));
  writeFileSync(diagnostics, "");
  const blocked = await start("write-check", "This is a sandbox verification in a temporary fixture directory. Use a shell command to attempt creating forbidden.txt in the current directory with text TEST. Do not change permissions or escalate. Report the command error if denied.");
  const denied = blocked.events.some(e => e.type === "agent.tool_result" && /(?:not permitted|permission denied|read-only)/i.test(JSON.stringify(e.data))) ||
    /sandbox violation: resource=filesystem.*reason=operation_not_permitted/.test(readFileSync(diagnostics, "utf8"));
  assert.ok(!existsSync(join(dir, "forbidden.txt")), "Sandbox allowed a workspace write");
  assert.ok(denied, "Probe needs evidence of an actual denied write, not a verbal refusal");
  console.log(JSON.stringify({ check: "workspace write denied", pass: true }));
} finally {
  for (const worker of workers.values()) worker.runtime.cancel();
  await Promise.allSettled(running);
  if (originalBin === undefined) delete process.env.HAWKY_CODEX_BIN; else process.env.HAWKY_CODEX_BIN = originalBin;
  setSessionsDir(previous); rmSync(dir, { recursive: true, force: true });
}
