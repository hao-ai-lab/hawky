# Realtime delegation: implementation and test checklist

Use the web-ios Live client. Start with Backend runtime = Hawk provider. The gateway and browser must both be running this branch. Allow about 15 minutes for the voice checks, plus 5 minutes per optional CLI runtime. Replace `<repo>` below with the absolute checkout path on the gateway host.

## Manual acceptance: five passes

1. **Inspect one real task.** Say: “Use the backend to read `<repo>/tests/fixtures/delegation/alpha.txt` and return all three lines verbatim.” Expand the task. Confirm the full request, original user words, exact backend brief, runtime/model, backend session, read tool event, timing and final answer are visible. The last line must be “Last line: keep the blue notebook.” Collapse and expand it again. No setup interview should occur. A successful backend turn must not by itself claim that the response was played.
2. **Talk while work finishes.** Start the same read, immediately keep speaking, and then ask “Is it done?” Try interrupting the spoken answer too. Expect no active-response error banner, no repeated tool execution, and no claim that completed work is still pending. The result should be offered at a gap. Interrupting playback leaves delivery interrupted while execution remains completed. Model wording and turn-taking quality require this live check; fixture tests cannot establish them.
3. **Correct and cancel.** Ask the backend to ask you which fixture file to read before proceeding. Its task should display a question; answer in the expanded bubble. Separately, ask for a backend `sleep 10` command, approve it only if the normal permission prompt appears, and cancel via the task button while it runs. The status should settle at cancelled. Start another task and use Revise task with the complete corrected request for beta.txt; the old task becomes superseded and only the replacement is current. Cancellation cannot undo actions already performed.
4. **Concurrent work and recovery.** Say: “Submit two separate independent read-only tasks: read alpha.txt and beta.txt at those paths.” Expect two task IDs; either completion order is valid and each answer must stay with its task. Ask a follow-up task to calculate their sum after both have finished: 102. Use a longer task if needed, reload the browser while it is running, and reconnect to the same live session. Existing task status must return without resubmission. Stay quiet for five seconds: Hawk must wait for your first spoken or typed turn. Old completed/interrupted deliveries load silently as context; ask about them when wanted. A known running task that finishes during the new connection queues its announcement, waits for your first turn and ongoing playback to finish, and then requests a reply. A gateway restart marks unfinished work interrupted and requires an explicit retry; it never automatically repeats side effects.
5. **CLI conversation continuity.** In Settings → Live → Hawk bridge, enable CLI runtimes and choose Codex CLI or Claude Code CLI. The chosen CLI must already be installed and logged in on the gateway host. Ask it to read alpha.txt. Inspect its runtime conversation ID, then say “Continue that backend task and tell me the value you read without reading the file again.” The new task should reuse the backend conversation. Try both runtimes. Authentication or permission failures must be visible instead of reported as success. CLI jobs are serialized. Native interactive permission/question controls are supported in the bubble; CLI print-mode approvals remain governed by the CLI and are not an interactive web approval bridge. Claude defaults to its existing Read/Grep/Glob tool configuration. Codex may not report the model in its event stream; the UI leaves it unknown rather than displaying the native provider model.

For a failed check, keep the live session key, task ID, approximate time, the exact spoken prompt, and the observed behavior. The task details and archives are enough to locate the corresponding backend run.

## What the code does

The realtime model calls `session_send_message`, an actual function tool. The browser submits a structured task through `delegation.submit` and promptly returns an acknowledgement, including its task ID. Work runs independently of the audio response. Gateway events and periodic list recovery update the bubble. A terminal result enters realtime context as a task status update; a response coordinator waits for user speech, generation and audio playback to permit a follow-up.

Every live connection waits for the first user turn before sending explicit replies. Recovered terminal tasks are context only, even if their prior playback was interrupted; restoring context does not mark them played. Fresh completions remain in the response queue while the user or assistant speaks. `response.done` ends generation; `output_audio_buffer.stopped` ends playback. Once all gates are clear, the coordinator waits 80 ms and coalesces up to three pending intents into one response with their task IDs. This confirms scheduling and provider playback events, not semantic proof that the spoken answer actually covered every result.

`session_task_control` supplies authoritative list/status/cancel/revise operations. Successful submission does not request another model turn: completion arrives automatically. When the user asks about progress, the returned status gets one continuation with tool calling disabled, preventing recursive status checks. Completion announcements also disable tools. Status/list calls appear as “Status checked” events inside the existing task details and remain in the realtime archive, instead of becoming separate transcript bubbles. Automatic recovery polls do not create those events. Old transcript bubbles are retained in saved history.

Corrections create a replacement task and invalidate the old result. Task execution, result validity and response delivery are stored separately. Delivery describes the associated provider response, not proof that a person heard or understood every word.

Native independent read-only tasks use separate sessions with a restricted tool registry. At most two execute together. Writer tasks, external CLI jobs, and turns sharing a backend session are serialized among delegated jobs. This is not a filesystem lock against other apps or direct chat clients. Dependency tasks wait for prerequisite completion and receive their results.

Codex uses `exec --json` then `exec resume <conversation-id>`; Claude uses persistent print sessions then `--resume <conversation-id>`. The adapter process may restart each turn; the CLI conversation persists. CLI authentication is managed by the installed runtime. Hawk never copies its OAuth credentials into a provider API key. The model field comes from native configuration or a reported CLI model, not an inference from the runtime name.

## Files to inspect

- `src/gateway/delegation-methods.ts`, `delegation-queue.ts`, `delegation-store.ts`, `delegation-types.ts`: lifecycle, scheduling, persistence and serializable state.
- `src/gateway/agent-methods.ts`, `agent-sessions.ts`, `external-agent-runtime.ts`: native agent execution, backend conversation binding, CLI resume and normalized tool events.
- `web-ios/src/lib/realtime-responses.ts`, `useRealtime.ts`, `delegation-view.ts`: speech coordination, task subscriptions, result context and transcript/artifact projection.
- `web-ios/src/components/DelegationBubble.tsx`, `screens/SettingsScreen.tsx`: task inspection, corrections, native input requests and runtime selection.
- `src/agent/context.ts`, `src/templates/AGENTS.md`: omit BOOTSTRAP and the old first-run template instruction without deleting workspace files. Existing historical conversations may still mention onboarding; test a fresh live/backend conversation if comparing prompt behavior.

## Traces and fixture tests

Gateway state stores task snapshots and append-only events at `sessions/delegations/<owner-hash>/<task-id>.json` and `.jsonl`. Snapshots keep the most recent 100 events; journals retain earlier events. Native/CLI conversation history remains in the normal session store. Realtime recordings retain response queue/lifecycle/retry events. Text streaming is batched at 150 ms while preserving each delta in the journal. Tool timing distinguishes queue wait, execution start, first output and completion.

```sh
bun run typecheck
bun test ./tests/test-delegation.ts ./tests/test-external-agent-runtime.ts ./tests/test-chat-send-user-broadcast.ts ./tests/test-command-queue.ts ./tests/test-context.ts ./tests/test-frontend-boot-context.ts
(cd web-ios && bun run build && bun run test)
```

The fixture suite covers duplicated calls, busy-response races, speech/playback gating, read/write scheduling, failed prerequisites, cancellation during dependency waits, correction supersession, persisted recovery, result images, delivery event ordering, CLI resume arguments and structured runtime failures. Fake CLI binaries perform no model requests. These tests validate orchestration; they do not establish live model accuracy, face recognition, spoken response quality, or native iOS parity.

A dev-only presentation fixture is available at `?preview=live-delegation`. It displays a sample task without starting a realtime model. It is excluded from production behavior.
