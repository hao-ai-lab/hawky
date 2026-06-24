# Voiceprint V0 Fixtures

This directory is for the first voiceprint measurement spike.

The default `manifest.example.json` uses inline toy embeddings so the scoring
pipeline is runnable without installing a speaker model. Real fixtures should
replace those vectors with either:

- `audioPath`: a local WAV file segment, scored with the dependency-free
  `signal-baseline` feature extractor for pipeline testing only; or
- `embeddingPath`: JSON output from SpeechBrain, WeSpeaker, Picovoice, or a
  custom sidecar.

The dependency-free `signal-baseline` provider is not a production voiceprint
model. It exists to verify manifest parsing, segment slicing, cosine scoring,
threshold reporting, and CI tests before the real embedding sidecar is added.

For real model experiments, use a sidecar command that reads a
`VoiceprintEmbeddingBatchRequest` JSON object from stdin and writes a
`VoiceprintEmbeddingBatchResponse` JSON object to stdout:

```bash
bun run voiceprint:score \
  --manifest fixtures/voiceprint/my-real-manifest.json \
  --sidecar-command ./scripts/my-speaker-embedder \
  --sidecar-arg --model \
  --sidecar-arg speechbrain-ecapa
```

Recommended fixture labels:

- `owner`: enrolled owner speech from the same route.
- `non_owner`: another human speaker.
- `noise`: background or low-quality audio.
- `assistant_leakage`: assistant playback, loopback, or remote speech leakage.
- `unknown`: unlabeled exploratory sample.

The threshold report fails on:

- owner samples that do not reach `owner_speaking`;
- non-owner, noise, or leakage samples that reach `owner_speaking` or
  `possible_owner`.

This keeps V0 conservative: a missed owner label is safer than a false owner
match.
