# hawky Voiceprint — Architecture & Implementation

How hawky recognizes **who is speaking** in a live ambient session, end to end:
from the phone microphone to the answering LLM knowing it is talking to the
device owner. This documents the architecture as shipped on `rich-localbuild`
(2026-07-12), the design decisions behind it, and what was learned getting it
to pass device acceptance.

## What it does

During an iOS Live session (OpenAI Realtime over WebRTC), the gateway
continuously and autonomously identifies the speaker of every finalized user
turn against an enrolled **owner voiceprint**. When the evidence establishes
that the owner is present, the gateway pushes an identity event to the phone;
the phone labels the UI and injects one context line into the OpenAI
conversation, so the answering model *knows* who it is talking to — naturally,
without the user announcing themselves.

Recognition is **fail-safe by construction**: every fault (missing audio,
sidecar error, quality reject, malformed payload, consent denial) degrades to
"no identity claim", never to a false owner.

## End-to-end dataflow

```
 iOS (phone)                          Gateway (TypeScript)                Python sidecar
─────────────                        ─────────────────────              ───────────────
 1. OpenAI WebRTC owns the mic;
    a PARALLEL mic tap records
    locally and streams 3s chunks ──▶ 2. media-writer lands
    (media.chunk.upload,               <base>.segNNN.mic.wav + .json
    media_id = <base>.segNNN.mic)      sidecar (duration_ms, final_iso)

 3. VAD/turn events
    (speech_started/stopped,
    live_recording.audio_artifact,
    transcription.completed) ───────▶ 4. live-turn-tracker builds speech
    turns carry                        windows, finalizes user turns
    audioArtifactId =                  (recording-aligned startMs/endMs)
    "<base>:<turnId>" and
    RECORDING-relative windows        5. auto-scorer (WS1, opt-in):
                                        wait-for-audio → resolve turn
                                        audio (two-tier, below) ────────▶ 6. embed.py (sherpa-onnx
                                        slice exact window                  CAM++, 192-dim) embeds
                                                                            the slice
                                      7. cosine vs owner template
                                        → owner_speaking / possible /
                                          unknown per turn
                                      8. A2 evidence reducer
                                        (owner-sticky hysteresis)
                                        → owner_present / not_owner /
                                          provisional / unknown
 10. ChatEvent decodes the frame;    9. EDGE-TRIGGERED broadcast
    edge-triggered identity          ◀── voiceprint.identity
    machine → UI label +                {verdict, confidence, at}
    ONE context injection               (scalars only) + piggyback on
    (createResponse:false) ──────▶      the realtime_event response
 11. OpenAI Realtime now knows the
    speaker is the owner and
    answers accordingly
```

### Step 5 in detail: two-tier audio resolution

The live path never calls `audio_artifact.register` — the gateway resolves a
turn's audio **autonomously** (the "Omi shape": identity work happens where the
media already lives):

1. **Tier 1 — artifact store.** Explicitly registered artifacts (enrollment,
   any registering client) resolve by `(sessionKey, audioArtifactId)` with
   their registered segment-relative window. Byte-for-byte the pre-WS1 path.
2. **Tier 2 — gateway-autonomous.** The `audioArtifactId` prefix before `:`
   is the on-disk recording base (`:` is not a legal media-id character).
   - If a whole file by that name exists AND its sidecar duration covers the
     turn window, the window passes through explicitly (the file is the full
     recording).
   - Otherwise the base expands to its finalized `.segNNN.mic.wav` segments;
     cumulative sidecar `duration_ms` builds the recording timeline; the turn
     window maps onto the max-overlap segment and the **exact overlap** is
     sliced (no padding — padding measurably dilutes the CAM++ embedding).
   - Not-yet-finalized tail, timeline gaps, or cross-root ambiguity ⇒
     "not ready": the auto-scorer retries (3×2s) and then skips fail-safe.
   - A 250ms tolerance absorbs frame-counter vs sidecar-duration drift so the
     session's final turn still resolves.

### Step 8 in detail: owner-sticky evidence

Per-turn decisions feed a session-level reducer
(`src/identity/voiceprint/evidence.ts`) tuned for a personal device — "the
owner is speaking" is the default assumption, and natural UX means the verdict
must not flap:

- **Fast establish**: `owner_flip_threshold` consecutive `owner_speaking`
  turns (production config: 2, ≈5s of speech).
- **Sticky hold**: overturning to `not_owner` needs
  `non_owner_flip_threshold` consecutive clear non-owner turns (production: 4);
  a single owner turn resets the streak.
- **Short turns don't vote** (`min_turn_ms`, production: 2000): a sub-2s
  utterance ("mm-hm", "好啊") carries too little speech for a reliable
  embedding — its "unknown" means *could not tell*, not *someone else*. It
  neither votes nor resets the owner streak, but still refreshes the staleness
  clock.
- **Slow decay**: `stale_timeout_ms` (production: 10 min) before silence
  decays the verdict to unknown.
- Broadcasts are **edge-triggered**: one event per establish/flip involving a
  hard verdict; repeats and unknown→provisional drift emit nothing.

### Step 10 in detail: the injection wording

A/B-verified against `gpt-realtime-2`: OpenAI realtime models are trained to
**disclaim voice recognition**, so a bare "the speaker is the owner" loses to
that prior when the user asks "can you recognize my voice?". The injection
must (1) attribute the verification to *Hawky's voiceprint system* — the app
verified it, not the model — and (2) instruct the model to respond like a
familiar person and explain the mechanism only when asked HOW it knows.
See `ios/hawky/Live/LiveVoiceprintIdentity.swift`.

## Components

| Layer | Where | Role |
|---|---|---|
| Speaker model | `fixtures/voiceprint/models/campplus.onnx` | 3D-Speaker CAM++ (192-dim, ~0.65% EER on VoxCeleb) |
| Embedding sidecar | `services/voiceprint/embed.py` | Python subprocess, JSON protocol; `onnx` (sherpa-onnx) + `reference` (deterministic test) backends; embeds ≥200ms slices |
| Core library | `src/identity/voiceprint/` (41 modules) | wav/quality/similarity/thresholds/turn-scoring, evidence (A2), as-norm (A3), consent-ledger (A4), model-lifecycle (A5), telemetry (A7), liveness-nonce (A8), memory-bridge (A9), calibration (A10), live-* realtime plumbing, encrypted template store |
| Gateway RPC | `src/gateway/voiceprint-methods.ts` | 17 `identity.voiceprint.*` methods: realtime_event/reset, score_turns, enroll/add_clip/delete/reembed, audio_artifact.register, consent CRUD + purge, telemetry/audit reads |
| Auto-scorer | `src/gateway/voiceprint-auto-score.ts` | WS1: per-session single-flight batching, wait-for-audio, evidence fold, edge-triggered broadcast + response piggyback |
| iOS enrollment | `ios/hawky/Voiceprint/` | Guided owner enrollment (`.measurement` capture, quality-aware, ≥30s voiced) |
| iOS live | `ios/hawky/Live/` | Parallel mic tap + chunk upload, realtime event forwarding, identity receive (broadcast + piggyback), UI label, agent injection |

## Configuration (`voiceprint.live_scoring`)

Key fields (see `src/agent/types.ts` for the full schema):

```jsonc
{
  "enabled": true,
  "sidecar": { "command": ".venv/bin/python3", "args": ["services/voiceprint/embed.py"],
               "env": { "VOICEPRINT_BACKEND": "onnx", "VOICEPRINT_MODEL": ".../campplus.onnx" } },
  "allowed_audio_roots": ["~/.hawky", "/tmp", "~/.hawky/workspace/media"],
  "owner_template": { "file_path": "...", "key_path": "...", "create_key_if_missing": true },
  "thresholds": { "owner_accept": 0.55, "owner_possible": 0.45 },   // CAM++ raw cosine
  "auto_score_finalized": true,                                       // WS1 opt-in
  "evidence": { "owner_flip_threshold": 2, "non_owner_flip_threshold": 4,
                "min_turn_ms": 2000, "stale_timeout_ms": 600000 }
}
```

Thresholds are model-specific. Measured with CAM++ on real device audio:
owner in-domain 0.6–0.85, different real speaker ~0.38, TTS ~0.10.

## Security & privacy properties

- **Fail-safe skip**: no fault path can manufacture an owner verdict.
- **Path confinement**: all audio reads resolve under `allowed_audio_roots`
  (realpath-checked); media ids are regex-gated (`[A-Za-z0-9._-]`, no
  separators), so a crafted artifact id cannot escape the roots.
- **Scalar-only identity**: broadcasts/piggybacks carry
  `{verdict, decision, confidence, at}` — never embeddings, paths, or keys.
- **Encrypted template**: owner template is AES-256-GCM at rest, key in a
  separate 0600 keyfile; deleting the key is right-to-erasure.
- **A4 consent**: append-only ledger, per-scope enforcement
  (capture/biometric/memory/export), atomic withdraw-and-purge, retention sweep.
- **A5 model guard**: production config pins the model sha256 and hard-rejects
  the non-discriminative reference backend at load AND score time.
- **A8 liveness nonce**: client-supplied embeddings (Phase 2 on-device path)
  require a fresh single-use session-bound nonce — naive replay resistance.
- **A7 telemetry**: opaque-session-hashed scalars only.
- Known gap (tracked): tier-2 resolution is not yet bound to the *uploading*
  session — on a multi-user gateway a client could reference another session's
  recording base. Fine for a single-owner gateway; must fix before multi-user.

## Lessons from device acceptance (what actually broke)

1. **Capture-domain mismatch is fatal and invisible.** A template enrolled via
   the standalone recorder (`.measurement`, no processing) is acoustically
   ORTHOGONAL (cosine 0.01–0.14) to live WebRTC-tapped audio (AGC/AEC/NS) for
   the same person, while each domain is self-consistent (~0.6–0.7). Enrollment
   MUST capture through the same path recognition scores, or the template must
   be built from live-captured audio. (Fixed operationally by re-enrolling from
   live segments; iOS enrollment-through-live-path is the tracked follow-up.)
2. **Turn timestamps and media timelines are different clocks.** Turns are
   recording-relative; segment files are 3s each. Slicing a segment with
   recording offsets yields empty audio ("segment too short" from the model).
   Every window handed to the sidecar must be explicitly file-relative.
3. **"Unknown" conflates two meanings.** Short-utterance unknowns are
   *insufficient evidence*, not *different speaker* — letting them vote
   overturns the owner mid-conversation.
4. **The LLM needs attribution, not just facts.** See injection wording above.
5. **Padding hurts.** CAM++ embeds 200ms fine; padding a short window with
   surrounding audio dilutes the embedding below threshold.

## Benchmark & multi-speaker testing (proposal)

The pipeline has three layers worth measuring separately; all can run offline
against the real `score_turns` seam (no phone needed):

1. **Model layer — FAR/FRR/EER on our capture domain.** Corpus: N speakers ×
   M utterances of live-domain audio (own recordings + volunteers, augmented
   with public Mandarin/English corpora like CN-Celeb/VoxCeleb re-recorded
   through the phone loop for realism). Sweep `owner_accept`/`owner_possible`,
   report FAR/FRR curves + EER per window length (0.5s/1s/2s/3s). The A10
   calibration module already computes these.
2. **Evidence layer — verdict quality on turn sequences.** Simulate real
   conversations (owner-only, owner+guest interleave, guest-only, noisy short
   turns) through the A2 reducer; measure time-to-establish, false-flip rate,
   time-to-detect-guest under different `evidence` configs. Pure TS, fast,
   property-testable.
3. **End-to-end — τ-Voice style scenario benchmark.** Scripted multi-speaker
   sessions (recorded once, replayed via the realtime_event + media harness)
   scoring: was the owner established? how fast? was the guest flagged? did
   the LLM answer identity questions correctly? This is the layer worth
   open-sourcing in the planned benchmark repo — "hawky vs raw model" on
   speaker-aware tasks is exactly the differentiating headline, since raw
   OpenAI Realtime scores 0 on all of them.

Suggested order: (2) first (cheap, immediately tunes production config), then
(1) with a small recorded multi-speaker set, then (3) as part of the benchmark
repo.
