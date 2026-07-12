# hawky Voiceprint — Module structure reference

Per-file structure for the converged voiceprint v1, grouped by layer. For each
file: its role, key exports/entry points, who calls it, and the invariant it
holds. This is the "每個部分的實際結構文件" — a map, not a tutorial; see
`voiceprint-architecture.md` for the end-to-end story and `voiceprint-enrollment.md`
for the enrollment flow.

Cross-cutting invariant everywhere: **fail-closed / fail-safe**. Any fault
(missing audio, sidecar error, quality reject, malformed payload, consent
denial) degrades to "no identity claim", never to a false owner.

---

## Layer 1 — Python embedding sidecar (`services/voiceprint/`)

The one thing that must live outside TS: audio slice → speaker embedding vector.

- **`embed.py`** — The embedding subprocess. Reads ONE batch request as JSON on
  stdin, writes ONE batch response on stdout (`version: 1`). Backends selected by
  `VOICEPRINT_BACKEND`: `reference` (deterministic, non-discriminative, test/CI
  default) and `onnx` (sherpa-onnx CAM++, 192-dim, real). Spawned by the gateway
  via `sidecar-client.ts`. Invariant: every request id gets exactly one response
  id; a hard error prints one JSON error + non-zero exit.
- **`test_embed.py`** — Python-side protocol/backend tests for `embed.py`.
- **`requirements.txt`** — sherpa-onnx + numpy deps for the onnx backend.
- **`README.md`** — The protocol + "getting a real CAM++ model" provisioning
  notes. The model file (`campplus.onnx`) lives outside git.

---

## Layer 2 — Core TypeScript library (`src/identity/voiceprint/`, 41 modules)

Pure, dependency-light building blocks. The gateway wiring lives in Layer 3; this
layer is unit-testable in isolation. Grouped by concern.

### Model, math, quality primitives

- **`model.ts`** — Model-identity helpers. `voiceprintModelIdentityParts`,
  `sameVoiceprintModel`, `formatVoiceprintModel`. Called wherever an embedding's
  model tag must match the owner template's. Invariant: model mismatch is a hard
  reject, never a silent cross-model score.
- **`types.ts`** — Core shared types + `DEFAULT_VOICEPRINT_THRESHOLDS`,
  `VoiceprintDecision`, `VoiceprintModelInfo`.
- **`thresholds.ts`** — Threshold resolution + validation. `resolveVoiceprintThresholds`,
  `validateVoiceprintThresholds`, `MIN_OWNER_ACCEPT_THRESHOLD`. Invariant: an
  owner-accept below the floor is rejected.
- **`similarity.ts`** — Cosine + confidence mapping. `safeCosineSimilarity`,
  `isUsableEmbeddingVector`, `vectorNorm`, `INVALID_VECTOR_SIMILARITY`. Invariant:
  a non-finite/zero-norm vector collapses to the invalid sentinel, never a score.
- **`audio-features.ts`** — Goertzel band-energy features for the on-device
  quality path. Minimum analyzable clip = 160 samples AND ≥50 ms.
- **`quality.ts`** — Audio-quality assessment (`VoiceprintAudioQualityStatus`,
  thresholds/metrics). Gates enrollment + scoring input. Called by enrollment and
  the scoring plan.
- **`wav.ts`** — PCM decode helpers (bit-depth → [-1, 1)). Used by any TS path
  that must read a WAV without the sidecar.

### Per-turn scoring + evidence (the recognition brain)

- **`turn-scoring.ts`** — Score one turn (`scoreVoiceprintTurnWithEvidence`,
  `scoreVoiceprintTurnFromEmbedding`), incl. opt-in AS-Norm. Emits a per-turn
  `owner_speaking` / `possible_owner` / `unknown_speaker`.
- **`evidence.ts`** — **A2** session-level accumulator. `reduceSpeakerEvidence`,
  `SpeakerEvidenceConfig` (asymmetric `ownerFlipThreshold`/`nonOwnerFlipThreshold`,
  `instantOwnerConfidence`, `staleTimeoutMs`), `initialSpeakerEvidenceState`,
  `DEFAULT_SPEAKER_EVIDENCE_CONFIG` (flip 3 / window 5 / stale 60s). Called by the
  auto-scorer and `score_turns`. Invariant: jumpy per-turn verdicts fold into a
  hysteretic session verdict that establishes the owner fast and overturns slow.
- **`as-norm.ts`** — **A3** Adaptive Symmetric Normalization against an impostor
  cohort. Opt-in, additive; off ⇒ raw-cosine path byte-for-byte.
- **`contracts.ts`** — Record/evidence contract types (`RecordId`, `EvidenceRef`,
  review-state shapes) shared across scoring, persistence, review.
- **`policy.ts`** — Consent + allowed-uses policy. `VoiceprintConsentSnapshot`,
  `DEFAULT_VOICEPRINT_CONSENT`, `NO_VOICEPRINT_ALLOWED_USES`. Invariant: a missing
  confidence collapses to −1 (fail-closed floor).
- **`review.ts`** — Human review-decision application (`applyVoiceprintReviewDecision`).
- **`report.ts`** — Operating-point + report formatting (`formatVoiceprintReport`,
  `computeVoiceprintReportOperatingPoint`).

### Live realtime pipeline (turn tracking → sidecar → verdict)

- **`live-realtime-events.ts`** — `applyLiveVoiceRealtimeEvent` /
  `applyCanonicalLiveVoiceEvent`: ingest a provider realtime event, drive the
  turn tracker. Entry point for `voiceprint-realtime.ts`.
- **`live-realtime-canonical.ts`** — The canonical internal event vocabulary
  (`speech_started/stopped/transcript_completed/audio_artifact`) the tracker
  consumes.
- **`live-realtime-adapters.ts`** — **A11** provider-adapter seam. Each adapter is
  a pure `(rawEvent) => CanonicalLiveVoiceEvent | null`. THE extension point for
  new realtime/ASR providers (OpenAI adapter shipped).
- **`live-turn-tracker.ts`** — Builds speech windows, finalizes user turns with
  recording-relative `startMs`/`endMs`. `LiveVoiceTurnTracker`. Invariant: turn
  windows are recording-relative (not segment-relative) — the clock the resolver
  must map.
- **`live-queue.ts`** — Queue a finalized turn for scoring (`queueLiveVoiceprintTurn`),
  dropping turns that can't be scored.
- **`live-adapter.ts`** — Prepares a queued turn into a ready/skipped scoring
  candidate (`LiveVoiceprintReadyTurn`, skip reasons).
- **`live-plan.ts`** — Build the scoring plan (`LiveVoiceprintScoringPlan`) incl.
  the A5 production guard (refuse reference-tagged embeddings when required).
- **`live-sidecar-jobs.ts`** — Build the batch embedding request + fold the
  response (`buildLiveVoiceprintScoringJob`, `buildLiveVoiceprintScoringBatchRequest`,
  `scoreLiveVoiceprintScoringJobResponse`).
- **`live-sidecar-runner.ts`** — Run the plan through the sidecar + store results
  (`LiveVoiceprintScoringBatchResult`, transcript identity updates). A5 guard:
  refuse a reference-tagged sidecar response.
- **`live-client-embedding.ts`** — Trust-boundary path: score a client-supplied
  embedding DIRECTLY against the owner template (`scoreClientEmbeddingForQueuedTurn`).
  Gated by `acceptClientEmbeddings` + A8 nonce.
- **`live-validators.ts`** — Shared comparison/error-phrasing helpers, each taking
  a caller-supplied label so call-site error text stays test-pinned.
- **`transcript-state.ts`** — The per-turn identity lifecycle state
  (`VoiceprintTranscriptIdentityState`, lifecycle/skip/error enums) attached to a
  transcript turn.
- **`embedding-errors.ts`** — Fail-closed marker for ONE unusable per-turn
  embedding (empty/NaN/inf/zero-norm/wrong-dim): the batch marks only that turn
  skipped instead of throwing out the good turns.
- **`turn-scoring.ts`** / **`scoring-telemetry.ts`** — see below.

### Sidecar protocol + client

- **`sidecar-protocol.ts`** — Request/response shapes + validation
  (`VoiceprintEmbeddingRequest/Response`, batch variants, `buildEmbeddingRequest`).
  The TS mirror of `embed.py`'s protocol.
- **`sidecar-client.ts`** — Spawns `embed.py`, one batch req/resp. `SidecarError`
  is INFRASTRUCTURE (→ INTERNAL_ERROR at the RPC boundary), not a client fault.
- **`sidecar-manifest.ts`** — Materialize embedding-request plans from a manifest
  (`buildManifestEmbeddingRequestPlan`) for offline/replay embedding.
- **`manifest.ts`** — `resolveFixturePath` (locate the bundled model/fixtures).

### Storage, template, lifecycle safety

- **`template.ts`** — Owner-template shape (`VoiceprintTemplate`,
  `VoiceprintEnrollmentSource`, subject/quality types).
- **`template-store.ts`** — AES-256-GCM encrypted template at rest + separate
  0600 keyfile (`VoiceprintTemplateFileSource`, encrypted-artifact file types).
  Invariant: deleting the key is right-to-erasure.
- **`persistence.ts`** — Derived-record storage snapshot + the A4 right-to-erasure
  primitive (purge EVERY derived record for a subject). `VoiceprintStorageBundle`,
  `emptyVoiceprintStorageSnapshot`.
- **`model-lifecycle.ts`** — **A5** reference-backend detection + model-integrity
  helpers (sha256 pin). Called at config-resolve and score time. Invariant:
  production hard-rejects the non-discriminative reference backend.
- **`consent-ledger.ts`** — **A4** append-only consent ledger + retention +
  deletion + audit core (BIPA/GDPR). Invariant: a withdrawal APPENDS, never
  rewrites a prior grant.
- **`scoring-telemetry.ts`** — **A7** privacy-safe scalar decision telemetry
  (score + decision + threshold), opaque-session-hashed. Separate artifact from
  the A4 audit log.
- **`memory-bridge.ts`** — **A9** pure bridge mapping a reviewed owner tag into a
  single `MemoryCandidate` contribution decision (reuses the existing candidate
  contract). Opt-in.
- **`calibration.ts`** — **A10** FAR/FRR/EER machinery: turns genuine vs impostor
  score arrays into a defensible operating point. The benchmark model-layer seam.
- **`liveness-nonce.ts`** — **A8** single-use, session-bound, TTL-bound nonce store
  (time-injectable, pure). Replay resistance for client-supplied embeddings.
- **`index.ts`** — Barrel re-export (`export *`) — the library's public surface.

---

## Layer 3 — Gateway wiring (`src/gateway/voiceprint-*.ts`)

Depends on Layer 2; the core library never imports the gateway.

- **`voiceprint-methods.ts`** — The RPC hub. `registerVoiceprintMethods(...)`
  registers the **19** `identity.voiceprint.*` methods (see the RPC table in
  `voiceprint-architecture.md`). Owns `runOwnerEnrollment` (shared enroll flow),
  `serializeEnrollmentSuccess/Rejection`, param parsers, and the enroll-from-
  recording total budget `ENROLL_FROM_RECORDING_TOTAL_MAX_MS = 180_000`. Invariant:
  every biometric method is consent-audited; `extraResponseFields` (segment stats)
  are additive-only for the recording path.
- **`voiceprint-config.ts`** — Resolve + validate `config.voiceprint.live_scoring`
  (`resolveVoiceprintLiveScoringConfigFromConfig`, `assertDiscriminativeVoiceprintConfig/Model`).
  Maps `evidence.*` → `SpeakerEvidenceConfig` + auto-score tuning
  (`instant_owner_confidence`, `owner_flip_threshold`, `min_turn_ms`, …).
  Invariant: FAIL-FAST — a config typo throws at load, not silently inside every
  auto-score batch.
- **`voiceprint-enrollment.ts`** — Enrollment segment selection + template write.
  `selectEnrollmentSegmentsFromRecording` (finalized `.segNNN.mic` segments, quality
  gate, per-recording cap `ENROLL_FROM_RECORDING_MAX_MS = 180_000`), `embedEnrollmentSources`,
  `writeOwnerTemplateFromSources`, `deleteOwnerTemplate`. Invariant: the per-recording
  bound must stay ≥ the RPC total budget so a single long take is not silently re-capped.
- **`voiceprint-audio-resolve.ts`** — Two-tier turn-audio resolution (tier-1 artifact
  store; tier-2 gateway-autonomous segment expansion + exact-overlap slice, 250 ms
  tolerance, no padding). Media-id shape/regex gate. Invariant: path confinement —
  every read realpath-checks under `allowed_audio_roots`; a crafted id cannot escape.
- **`voiceprint-auto-score.ts`** — **WS1** background auto-scorer: per-session
  single-flight batching, wait-for-audio retry (3×2s), evidence fold, edge-triggered
  `voiceprint.identity` broadcast + realtime-event response piggyback. Owns
  `VoiceprintIdentitySummary` (scalar wire shape) and `minEvidenceTurnMs`. Invariant:
  fire-and-forget off the hot realtime path; a scoring fault skips, never a false owner.
- **`voiceprint-realtime.ts`** — `VoiceprintRealtimeSessionStore`: per-session
  realtime state (turn tracker) + reset. Provider hint defaults to `auto` (registry,
  OpenAI first).
- **`voiceprint-lifecycle.ts`** — **A4** persistent consent/audit/telemetry stores
  (atomic temp+rename, 0600). ADDITIVE + INERT by default (in-memory no-op) until a
  caller opts in.
- **`voiceprint-liveness.ts`** — Process-lifetime holder for the A8 nonce store,
  supplying the wall clock so RPC handlers don't thread a clock.
- **`voiceprint-param-utils.ts`** — Shared param coercion/validation helpers
  (`configString`, `optionalNumber`, `optionalBoolean`, …) used by the parsers.

---

## Layer 4 — iOS enrollment (`ios/hawky/Voiceprint/`)

SwiftUI shell + testable model + the capture-parity recorder + on-device seam.

- **`OwnerEnrollmentModel.swift`** — `@MainActor` ObservableObject: ALL enrollment
  logic. Multi-take listening flow (`startListening`/`stopListening`/`recordListeningCapture`/
  `submitFromRecording`), the guided-target constants (`serverVoicedFloorMs = 30_000`,
  `guidedVoicedTargetMs = 60_000`, `voicedFraction = 0.74`), progress/gate state,
  and the failure/`enrolled` copy (`enrolledMessage`, `listeningStartFailureMessage`,
  `recordingFailureMessage`) + `listeningFailure`/`micPermissionDenied`. Builds the
  RPC params (`enrollOwnerFromRecordingParams`). Called by `OwnerEnrollmentView`;
  driven directly by `OwnerEnrollmentModelTests`. Invariant: FAIL-CLOSED consent
  gate — the RPC is never sent unless `biometricAllowed && captureAllowed`.
- **`OwnerEnrollmentRecorder.swift`** — `@MainActor` recorder capturing through the
  EXACT same `MicAudioSource(voiceProcessing: true)` + session config that live
  recording uses. Device-only; the testable logic lives in the model. Invariant:
  **capture-domain parity** — enrollment audio must come through the same
  voice-processed path recognition scores, or the template is orthogonal to live.
- **`SpeakerEmbedder.swift`** — On-device embedder seam (workflow B1) + the JSON
  helpers to serialize `score_turns` params. The iOS producer of the client-embedding
  path.
- **`CoreMLSpeakerEmbedder.swift`** — Loads a device-provisioned CAM++ CoreML model
  BY NAME (`campplus`, gitignored `.mlmodelc`); `isAvailable == false` when absent so
  the live path cleanly falls back. Audio→feature transform is a single seam method.
- **`DeterministicSpeakerEmbedder.swift`** — Dev/test-only reference embedder: hashes
  PCM into a stable 192-dim vector. NON-DISCRIMINATIVE — never a real decision;
  exists to keep the wire shape testable.
- **`VoiceprintLivenessCoordinator.swift`** — Workflow B2: fail-closed A8 nonce +
  score-turns submission over the `VoiceprintLivenessGateway` protocol
  (`LiveGatewayBridge` conforms). Invariant: nil challenge ⇒ fail closed.

---

## Layer 5 — iOS live + enrollment session plumbing (voiceprint parts of `ios/hawky/Live/`)

Only the voiceprint-relevant surface of these files (they are large, multi-feature).

- **`LiveVoiceprintIdentity.swift`** — The identity RECEIVE state machine.
  `LiveVoiceprintIdentitySummary` (scalar wire shape shared by the broadcast +
  piggyback channels), edge-triggered UI-label + ONE-context-injection logic, and
  the A/B-verified **attributed** injection wording (attribute to Hawky's voiceprint
  system; explain the mechanism only when asked HOW). Invariant: a payload missing
  `verdict`/`at` parses to nil = "no identity", never a false owner.
- **`LiveSessionStore.swift`** — The session hub. Voiceprint parts: the **enrollment
  listening session** (`startEnrollmentListeningSession`/`stopEnrollmentListeningSession`,
  `enrollmentListeningConfigOverride` — silent, live-upload, no visual/cocktail-party,
  `conversationJournalingEnabled = false`), the journal-isolation helpers
  (`transcriptAppendRuntimeTarget`, `conversationRecordSuppressed`), the enrollment
  gateway accessor, and `lastEnrollmentListeningStartFailure`. Invariant: the
  enrollment monologue is biometric capture, not conversation — one flag keeps it out
  of app chat, gateway transcript, and daily-memory distill (fail-closed default: only
  an explicit override suppresses).
- **`LiveModels.swift`** — `LiveSessionConfig.conversationJournalingEnabled` (transient,
  never persisted; default `true`) — the single flag gating all conversation-record
  paths for the enrollment session.
- **`LiveGatewayBridge.swift`** — Voiceprint RPC transport. `LiveVoiceprintEnrollmentResult`
  (parses `ok/status/reasons/speechMs/sourceCount` + the additive
  `segmentsConsidered/Used/QualityRejected/Capped/AfterGap`), `enrollVoiceprintOwnerFromRecording`,
  `requestVoiceprintEmbeddingChallenge`, `sendVoiceprintScoreTurns`. Invariant: segment
  counts are optional-parsed so `enroll_owner`/older servers don't break.
- **`LiveRecordingSink.swift`** — Recording facade: `LocalRecordingSink` writes the
  WAV + keyframe manifest, `MediaUploadScheduler` owns the live/deferred gateway
  upload queues that emit the `.segNNN.mic` chunks (`media.chunk.upload`). The mic-tap
  itself is started by `LiveSessionStore.startParallelMicRecording`. Together they are
  the source of both live-recognition audio and enrollment segments. Invariant:
  enrollment and recognition read the SAME recording domain (capture parity again).
- **`LiveSessionProvider.swift`** — Realtime session/silence control used by the
  enrollment listening session (`setSilenceMode(true)` so the model never talks over
  the user's enrollment speech).
