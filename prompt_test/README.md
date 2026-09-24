# Hawk realtime scenarios

Keep repeatable prompts and expected behavior here. The checks below describe
the existing implementation; realtime summarization/compaction is now prioritized
in the roadmap but not yet implemented by these scenarios. Global/daily memory
rewriting and mid-conversation durable-memory refresh remain deferred.

See [the realtime roadmap](../docs/realtime-roadmap.md) for the ordered batches.
Compaction, context recovery, and title generation precede the broader prompt
test expansion; capture a small baseline first. New proactive behavior,
meeting-reminder policy, and the reminder/tracking list belong to the last app
batch; their documented scenarios are not yet working-feature claims.

## Automated checks

Run from the repository root:

```sh
bun test ./tests/test-frontend-boot-context.ts ./tests/test-workspace.ts
cd web-ios
bun run test
bun run build
```

The backend tests check fixed character templates, plain character prose, private
routing metadata, bootstrap exclusion, and unchanged daily/global memory selection.
The web tests exercise the actual hook with controlled transport and RPC fixtures:

- `realtime-startup.test.ts`: configure/replay/activate acknowledgements, duplicate
  and out-of-order receipts, rejection, timeout, cancellation, and manual mode.
- `realtime-resume.test.tsx` and `transcript-concurrency.test.tsx`: slow/failed
  history, chat isolation, Stop/Start, reload, microphone readiness, and the
  explicit 30-message replay limit.
- `realtime-scenarios.test.tsx`: prompt/tool payload consistency, tool outcomes,
  person confirmation/saving, missing camera frames, and Stay Silent control.

These are application contracts, not model-quality scores. Capability wording is
unchanged in this batch, including the known bridge-disabled wording mismatch.

For an opt-in test of the real provider, set `OPENAI_API_KEY` in the environment,
then run from the repository root:

```sh
bun run prompt_test/realtime-smoke.ts
```

This makes two paid realtime calls using the browser's default model. Set
`HAWKY_REALTIME_MODEL` to explicitly test another supported model. It uses the
actual character templates, prompt builders, and startup handshake with synthetic
conversation history; it does not upload your workspace memory. JSON output
contains the response, pass/fail, connection-plus-restoration time, first-text
time measured after sending the question, and response completion time. Nonzero
exit means a failed assertion or transport/provider failure. Run it separately
from the deterministic suite; model behavior can vary.

The two model probes ask "What is your name?" and "What time is my meeting?"
after restoring a correction from three to four. Passing only establishes these
two text cases. It does not test WebRTC, audio/VAD, vision, tools, or proactiveness.

## Step 4: live browser checks

Use one browser tab per conversation. Use the updated gateway and reload the
web app before testing. Record model/settings, exact prompt, observed reply,
pass/fail, and the recording ID for each case.

1. **Identity.** Start a new chat and ask "What's your name?" Expect Hawk and no
   setup interview. Ask "I don't feel like doing much today." Check whether the
   response feels warm, brief, and useful. Tone still needs human judgment.
2. **Continuity.** Say "My meeting is at three," then "Actually, it moved to four."
   Stop, Start, and ask "When is my meeting?" Expect four. Repeat after reloading.
   Switch to a new chat and verify the old conversation is not replayed there.
   Keep the fact within the most recent 30 messages for this batch.
3. **Capabilities and tools.** Turn the camera off and ask "What am I holding?"
   Note any unsupported visual claim. Ask "Draw a bar chart for Monday 2 and
   Tuesday 5." Check the tool bubble and actual result against the spoken claim.
   Failures/pending results must not be described as completed. This is an
   observation test for unchanged model/capability wording, not a claimed fix.
4. **People.** With the recognition service and camera working, introduce a
   consenting person: "This is Alex. Remember their name." Confirm the proposed
   candidate when asked, check the saved profile, then ask "Who is this?" Verify
   the service result and the answer agree. Automated tests cover routing only;
   recognition accuracy and persistence through the actual service remain live checks.
5. **Quiet/proactive behavior.** Leave an uneventful scene for 20 seconds; note
   unsolicited narration. Enable Stay Silent, say "We decided to meet tomorrow,"
   then disable it. Expect silence while enabled and one relevant recap afterward.
   Safety monitoring and general event-watching promises require their own service
   checks; this batch does not establish that arbitrary monitoring requests work.

## Files to edit

- Character: `src/templates/IDENTITY.md`, `src/templates/SOUL.md`. Existing installs
  read their workspace copies; template changes do not overwrite installed files.
- Backend prompt layout: `src/gateway/frontend-boot-prompt.ts`.
- Existing memory selection and RPC metadata: `src/gateway/frontend-boot-context.ts`.
- Browser interaction rules and final assembly: `web-ios/src/lib/realtime-prompt.ts`.
- Restoration protocol: `web-ios/src/lib/realtime-startup.ts`; orchestration and
  selected history remain in `web-ios/src/lib/useRealtime.ts`.
