#!/usr/bin/env bash
#
# setup-voiceprint-model.sh — fetch the assets the GATED real-model voiceprint e2e needs.
#
# The reference-backend e2e (tests/e2e-voiceprint-pipeline.ts) proves the ORCHESTRATION
# end to end with zero weights/network. This script provisions the extra assets needed to
# also prove REAL speaker discrimination via the onnx backend (tests/e2e-voiceprint-onnx.ts):
#
#   1. sherpa-onnx (Python) — the speaker-embedding runtime embed.py's onnx backend wraps.
#   2. a 3D-Speaker CAM++ speaker-embedding ONNX model (~28 MB) -> fixtures/voiceprint/models/campplus.onnx
#   3. three real, labeled, 16 kHz mono human speaker WAVs from sherpa-onnx's own
#      speaker-recognition test data (sr-data) -> fixtures/voiceprint/audio/
#        - speaker1_a_cn_16k.wav  (speaker A, clip 1)  -> ENROLL
#        - speaker1_b_cn_16k.wav  (speaker A, clip 2)  -> must MATCH A
#        - speaker2_a_cn_16k.wav  (speaker B)          -> must NOT match A
#
# We use REAL 2-speaker human audio (not sine waves): a synthetic tone does not exercise a
# speaker model and cannot produce a meaningful A-vs-A / A-vs-B discrimination signal.
#
# Everything lands under gitignored dirs (fixtures/voiceprint/{models,audio,.venv}) so no
# large binaries or audio enter git. The e2e SKIPS cleanly when these assets are absent, so
# running this script is OPTIONAL and CI stays green without it.
#
# Usage:
#   bash scripts/setup-voiceprint-model.sh
#
# Then run the gated e2e (it auto-detects the assets via env or the default fixture paths):
#   VOICEPRINT_PYTHON="$PWD/fixtures/voiceprint/.venv/bin/python3" \
#   VOICEPRINT_MODEL="$PWD/fixtures/voiceprint/models/campplus.onnx" \
#     bun test --timeout 60000 ./tests/e2e-voiceprint-onnx.ts
#
# (If you install sherpa-onnx into your system python3 instead of the venv, you can drop
#  VOICEPRINT_PYTHON; the e2e also probes plain `python3`.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX_DIR="$REPO_ROOT/fixtures/voiceprint"
MODEL_DIR="$FIX_DIR/models"
AUDIO_DIR="$FIX_DIR/audio"
VENV_DIR="$FIX_DIR/.venv"
MODEL_PATH="$MODEL_DIR/campplus.onnx"

MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
SR_DATA_BASE="https://github.com/csukuangfj/sr-data/raw/main/test/3d-speaker"
AUDIO_FILES=(
  "speaker1_a_cn_16k.wav"
  "speaker1_b_cn_16k.wav"
  "speaker2_a_cn_16k.wav"
)

# Pin sherpa-onnx so the gated onnx e2e's empirical cosine values stay reproducible; an
# unpinned wheel could silently shift embedding numerics under the test's thresholds.
SHERPA_ONNX_VERSION="1.13.4"

# Expected sha256 per downloaded asset. These bytes are fed into a model runtime, so a
# corrupted/truncated download or an upstream asset swapped under the same URL must FAIL
# the setup (not silently poison the model). Keyed by basename.
declare -A EXPECTED_SHA256=(
  ["campplus.onnx"]="aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"
  ["speaker1_a_cn_16k.wav"]="5f20ce0ddc378ca3239d3ce864b1142726a46a1221ae553912e4e142045df58b"
  ["speaker1_b_cn_16k.wav"]="20745dc08a4281894d146140b99b9ef7417ac681119b7f7202f553cdf1a85f65"
  ["speaker2_a_cn_16k.wav"]="8a6cffa452df32ef10503f7992f22ffcdd7f16c4e0273d13311bc5cdcb13abf4"
)

PYTHON_BIN="${VOICEPRINT_SETUP_PYTHON:-python3}"

log() { printf '[setup-voiceprint-model] %s\n' "$*"; }
warn() { printf '[setup-voiceprint-model][warn] %s\n' "$*" >&2; }

mkdir -p "$MODEL_DIR" "$AUDIO_DIR"

# ---------------------------------------------------------------------------
# 1. sherpa-onnx into a local venv (keeps the system python clean).
# ---------------------------------------------------------------------------
install_sherpa() {
  log "Creating venv at $VENV_DIR (python: $PYTHON_BIN)"
  if ! "$PYTHON_BIN" -m venv "$VENV_DIR" 2>/dev/null; then
    warn "python venv creation failed; will try installing into a --target dir instead."
    VENV_PY=""
    return 0
  fi
  VENV_PY="$VENV_DIR/bin/python3"
  log "Installing sherpa-onnx into the venv (pip install sherpa-onnx)"
  if ! "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1; then
    warn "pip upgrade failed (continuing)."
  fi
  if "$VENV_PY" -m pip install "sherpa-onnx==$SHERPA_ONNX_VERSION"; then
    if "$VENV_PY" -c "import sherpa_onnx; print('sherpa-onnx', sherpa_onnx.__version__)"; then
      log "sherpa-onnx installed. Use VOICEPRINT_PYTHON=$VENV_PY for the e2e."
      return 0
    fi
  fi
  warn "sherpa-onnx install/import FAILED (no network, or wheel unavailable for this platform)."
  warn "The onnx e2e will SKIP. This is expected in offline/sandboxed environments."
  return 0
}

# ---------------------------------------------------------------------------
# 2 + 3. Download model + real speaker WAVs.
# ---------------------------------------------------------------------------
# Print the sha256 of a file using whichever tool is available.
sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    return 1
  fi
}

# Verify $file matches EXPECTED_SHA256[basename]. FAILS the script on mismatch (these bytes
# feed a model runtime). If no sha256 tool exists we warn but do not block (best effort).
verify_sha256() {
  local file="$1"
  local base
  base="$(basename "$file")"
  local expected="${EXPECTED_SHA256[$base]:-}"
  if [[ -z "$expected" ]]; then
    warn "no expected sha256 for $base (skipping integrity check)"
    return 0
  fi
  local actual
  if ! actual="$(sha256_of "$file")"; then
    warn "no sha256 tool (sha256sum/shasum) available; skipping integrity check for $base"
    return 0
  fi
  if [[ "$actual" != "$expected" ]]; then
    warn "sha256 MISMATCH for $base"
    warn "  expected: $expected"
    warn "  actual:   $actual"
    return 1
  fi
  log "sha256 OK: $base"
  return 0
}

fetch() {
  local url="$1" dest="$2"
  if [[ -f "$dest" ]]; then
    # A stale/corrupt local copy must be caught too, not blindly trusted.
    if verify_sha256 "$dest"; then
      log "already present (verified): $dest"
      return 0
    fi
    warn "existing $dest failed integrity check; re-downloading"
    rm -f "$dest"
  fi
  log "downloading $url"
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fL --retry 2 -o "$dest.part" "$url"; then
      rm -f "$dest.part"
      warn "download FAILED: $url"
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -O "$dest.part" "$url"; then
      rm -f "$dest.part"
      warn "download FAILED: $url"
      return 1
    fi
  else
    warn "neither curl nor wget is available; cannot download $url"
    return 1
  fi
  if ! verify_sha256 "$dest.part"; then
    rm -f "$dest.part"
    warn "integrity check FAILED for $url"
    return 1
  fi
  mv "$dest.part" "$dest"
  return 0
}

install_sherpa || true

MODEL_OK=1
fetch "$MODEL_URL" "$MODEL_PATH" || MODEL_OK=0

AUDIO_OK=1
for name in "${AUDIO_FILES[@]}"; do
  fetch "$SR_DATA_BASE/$name" "$AUDIO_DIR/$name" || AUDIO_OK=0
done

echo
log "----- summary -----"
if [[ -n "${VENV_PY:-}" ]] && "$VENV_PY" -c "import sherpa_onnx" >/dev/null 2>&1; then
  log "sherpa-onnx: OK ($VENV_PY)"
else
  warn "sherpa-onnx: NOT available -> onnx e2e will SKIP"
fi
[[ "$MODEL_OK" == "1" && -f "$MODEL_PATH" ]] && log "CAM++ model: OK ($MODEL_PATH)" || warn "CAM++ model: MISSING -> onnx e2e will SKIP"
[[ "$AUDIO_OK" == "1" ]] && log "speaker WAVs: OK ($AUDIO_DIR)" || warn "speaker WAVs: MISSING/INCOMPLETE -> onnx e2e will SKIP"
echo
log "To run the gated real-model e2e:"
log "  VOICEPRINT_PYTHON=\"${VENV_PY:-python3}\" VOICEPRINT_MODEL=\"$MODEL_PATH\" \\"
log "    bun test --timeout 60000 ./tests/e2e-voiceprint-onnx.ts"
