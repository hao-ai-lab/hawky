# Voiceprint embedding sidecar

The speaker-embedding model behind hawky's live voiceprint scoring. The TypeScript
gateway owns turn tracking, owner-template matching, cosine scoring, consent, and
storage; this sidecar owns the one thing that must live outside TS: turning a slice
of audio into a speaker embedding vector.

The gateway spawns this process (configured via `config.voiceprint.live_scoring`),
writes **one** batch request as JSON to stdin, and reads **one** batch response as
JSON from stdout. That is the entire contract. See
`src/identity/voiceprint/sidecar-protocol.ts` (shapes + validation) and
`src/identity/voiceprint/sidecar-client.ts` (how it is spawned).

## Protocol

Both directions are JSON with `version: 1`.

Request (stdin):

```json
{
  "version": 1,
  "requests": [
    { "id": "turn_1", "audioPath": "/abs/turn_1.wav", "startMs": 0, "endMs": 1500, "targetSampleRate": 16000 }
  ]
}
```

Response (stdout):

```json
{
  "version": 1,
  "responses": [
    {
      "id": "turn_1",
      "embedding": [/* floats */],
      "model": { "provider": "reference", "modelId": "reference-fbank-v0", "version": "0" },
      "audio": { "durationMs": 1500.0, "speechMs": 1490.0, "sampleRate": 16000, "channels": 1 },
      "quality": { "rms": 0.35, "tooShort": false }
    }
  ]
}
```

Rules (enforced here and re-validated in `sidecar-protocol.ts`):

- Every request `id` gets **exactly one** response `id`. Missing, duplicate, or
  unexpected ids are errors.
- `requests` must be a non-empty array; ids and `audioPath` must be non-empty;
  `startMs`/`endMs`/`targetSampleRate` must be sane when present.
- Per request: load the WAV at `audioPath` (a direct RIFF/WAVE parse using only
  `struct` — no heavy IO deps, no `audioop`; supports 8-bit unsigned, 16/24/32-bit
  PCM, and 32/64-bit IEEE-float, mirroring `src/identity/voiceprint/wav.ts`),
  downmix to mono, clip to `[startMs, endMs]` if given, resample to
  `targetSampleRate` (default 16000), compute the embedding, and report
  `audio` (`durationMs` / `speechMs` / `sampleRate` / `channels`) plus a `quality`
  hint (`rms`, `tooShort`).
- On a hard failure (bad JSON, unreadable/missing WAV, backend error) the process
  writes a single JSON error object (`{"error": "..."}`) to stdout and exits
  non-zero. `sidecar-client.ts` surfaces the non-zero exit as a rejected promise,
  which the runner turns into a `sidecar_failed` scoring error — the parent never
  crashes. stdout is bounded (small fixed-dim vectors, capped batch size) so it
  cannot blow past the client's `maxStdoutBytes`.

## Backends

Selected by the `VOICEPRINT_BACKEND` environment variable.

### `reference` (default — test/CI only, NON-DISCRIMINATIVE)

A deterministic, dependency-free backend that maps audio to a fixed **192-dim**
vector via a seeded projection of framed spectral/energy features. Same audio always
yields the same vector; different audio yields a different vector, so the whole
pipeline (id matching, cosine scoring, storage, `score_turns`) is exercisable
**without weights or network**.

It is **not** a speaker model. It does not separate one speaker from another. Do not
use it for real identity decisions. It exists purely so tests and CI can run.

- `provider`: `reference`, `modelId`: `reference-fbank-v0`, `version`: `0`.
- Requires nothing beyond the Python 3 standard library (no `audioop`, so it runs
  on Python 3.13+ where `audioop` was removed).

### `onnx` (production)

Wraps [`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) speaker-embedding
extraction for a **CAM++** model. `sherpa-onnx` is imported **lazily** (this module
loads fine without it); if `onnx` is selected but `sherpa-onnx` or the model is
missing, it fails with a clear error. **No weights are downloaded.**

- `provider`: `sherpa-onnx`, `modelId`: `cam++`, `version` derived from the model
  file basename (minus extension), e.g. `campplus_16k` for `campplus_16k.onnx`.
- Env: `VOICEPRINT_MODEL` (path to the `.onnx` model — required),
  `VOICEPRINT_ONNX_THREADS` (default 1), `VOICEPRINT_ONNX_PROVIDER` (default `cpu`).

#### Why sherpa-onnx (front-end parity)

A speaker-embedding model is trained on a **specific** acoustic front-end (fbank /
log-mel: exact window, hop, mel bins, log floor, mean/var normalization). If the
runtime front-end does not match bit-for-bit, the embeddings drift and similarity
scores degrade — silently. `sherpa-onnx` **bundles the matched fbank front-end**
for the model it runs, so we do not hand-roll a log-mel and risk that parity drift.
That is the whole reason we prefer it over calling the raw ONNX graph ourselves.

#### Getting a real CAM++ model

Download a pre-exported model from the sherpa-onnx speaker-recognition model zoo
(3D-Speaker CAM++ models, e.g. `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`):

- sherpa-onnx models: https://github.com/k2-fsa/sherpa-onnx/releases (speaker-recognition assets)
- upstream 3D-Speaker: https://github.com/modelscope/3D-Speaker

Place the `.onnx` file somewhere the gateway can read and point `VOICEPRINT_MODEL` at
it. Install the dependency with `pip install -r requirements.txt` (the `reference`
backend needs no install).

## Wiring it into the gateway

`config.voiceprint.live_scoring` drives the sidecar. Live scoring stays **disabled**
by default; it only activates when `enabled: true` and an owner template + audio
roots are configured.

Production (onnx / CAM++):

```jsonc
{
  "voiceprint": {
    "live_scoring": {
      "enabled": true,
      "sidecar": {
        "command": "python3",
        "args": ["services/voiceprint/embed.py"],
        "env": { "VOICEPRINT_BACKEND": "onnx", "VOICEPRINT_MODEL": "/models/campplus_16k.onnx" }
      },
      "owner_template": { "file_path": "...", "key_path": "..." },
      "allowed_audio_roots": ["/abs/audio/root"],
      "consent": { "capture_allowed": true, "biometric_allowed": true },
      "expected_model": { "provider": "sherpa-onnx", "model_id": "cam++", "version": "campplus_16k" }
    }
  }
}
```

`expected_model` is optional; when set it is matched by strict equality of
`provider` + `model_id` + `version` against what the sidecar reports (see
`sameVoiceprintModel` in `src/identity/voiceprint/model.ts`). The onnx `version` is
the model file basename minus extension, so it must match exactly (e.g.
`campplus_16k` for `campplus_16k.onnx`); a mismatch fails every turn with a
`sidecar_failed` error. Omit `expected_model` to skip the check entirely.

Local/dev (reference backend, deterministic but non-discriminative). Set the explicit
opt-in `dev_reference_backend: true` and omit `sidecar.command`; the gateway defaults
the sidecar to `services/voiceprint/embed.py` with `VOICEPRINT_BACKEND=reference`:

```jsonc
{
  "voiceprint": {
    "live_scoring": {
      "enabled": true,
      "dev_reference_backend": true,
      "owner_template": { "file_path": "...", "key_path": "..." },
      "allowed_audio_roots": ["/abs/audio/root"],
      "consent": { "capture_allowed": true, "biometric_allowed": true }
    }
  }
}
```

`dev_reference_backend` is opt-in only and must never be used for real identity — the
reference backend cannot tell speakers apart. The `VOICEPRINT_PYTHON` env var overrides
the interpreter used for the dev default.

## Tests

- Python: `python3 test_embed.py` (self-contained; pytest not required — each
  `test_*` is a plain assert, and the runner exits non-zero on any failure). Covers
  protocol parse/serialize, WAV load + clip + resample, deterministic backend
  stability, batch id matching, and every error case. WAV fixtures are generated
  in-process; no weights, no network.
- TypeScript integration: `tests/test-voiceprint-embed-service.ts` spawns this real
  service through `runEmbeddingSidecar` (`VOICEPRINT_BACKEND=reference`) and asserts
  id-matched finite embeddings plus a full `score_turns` round-trip.
