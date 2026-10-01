#!/usr/bin/env bash
# =============================================================================
# voiceprint-mic-smoke.sh
#
# Record real voices from the mic (or score existing WAVs) and prove that the
# built voiceprint sidecar (services/voiceprint/embed.py, onnx backend) plus a
# real CAM++ speaker-embedding model actually discriminates speakers:
# same person (different words) matches; a different person is rejected.
#
# This is a DEV / SMOKE tool (macOS). It is not part of the automated test
# suite; the deterministic pipeline e2e lives in tests/e2e-voiceprint-*.ts.
#
# Empirically observed operating points (2026-07-10, 3D-Speaker CAM++ via
# sherpa-onnx, 16k mono recordings through this repo's onnx backend):
#
#   owner vs owner (different words)      cos ~ 0.88   -> ACCEPT
#   owner vs a DIFFERENT REAL person      cos ~ 0.38   -> REJECT   <-- the meaningful impostor
#   owner vs a TTS voice (macOS `say`)    cos ~ 0.10   -> REJECT   (too easy — do NOT calibrate on this)
#
# Calibration guidance derived from the above:
#   * Operating threshold ~0.5 (0.5-0.55) separates owner (0.88) from a real
#     human impostor (0.38) with ~0.5 margin.
#   * Calibrate the threshold on REAL-human impostor distributions, NOT TTS:
#     TTS carries synthetic artifacts that sit far from any human voice (~0.1),
#     so a TTS-only calibration sets the threshold much too loose.
#   * Same-mic / same-room recordings inflate impostor cosine slightly (shared
#     channel), so leave headroom below the observed impostor scores.
#   * Need >= ~2-3 s of voiced speech per clip for a stable embedding.
#
# Requirements: ffmpeg (record), python3 + sherpa-onnx + a CAM++ model.
#   Get sherpa-onnx + the model with: scripts/setup-voiceprint-model.sh
#   Point VOICEPRINT_MODEL at the .onnx file (or pass --model <path>).
#
# Usage:
#   # record owner enroll + verify + one impostor from the mic, then score:
#   scripts/voiceprint-mic-smoke.sh --record
#
#   # score existing clips (owner = first two, rest are impostors):
#   scripts/voiceprint-mic-smoke.sh --owner enroll.wav --verify verify.wav \
#       --impostor other.wav [--impostor other2.wav ...]
#
#   # options: --model <campplus.onnx>  --threshold 0.5  --device :1  --seconds 20
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMBED="${REPO_ROOT}/services/voiceprint/embed.py"

MODEL="${VOICEPRINT_MODEL:-}"
THRESHOLD="0.5"
DEVICE=":1"          # avfoundation audio device index (":1" = MacBook Pro Mic; ":0" = default)
SECONDS_LEN="20"
DO_RECORD=0
OWNER_ENROLL=""
OWNER_VERIFY=""
IMPOSTORS=()

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --record) DO_RECORD=1; shift ;;
    --owner) OWNER_ENROLL="$2"; shift 2 ;;
    --verify) OWNER_VERIFY="$2"; shift 2 ;;
    --impostor) IMPOSTORS+=("$2"); shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --seconds) SECONDS_LEN="$2"; shift 2 ;;
    -h|--help) sed -n '2,60p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown arg: $1 (see --help)" ;;
  esac
done

[[ -f "$EMBED" ]] || die "sidecar not found: $EMBED"
[[ -n "$MODEL" ]] || die "no CAM++ model: pass --model <path> or set VOICEPRINT_MODEL (see scripts/setup-voiceprint-model.sh)"
[[ -f "$MODEL" ]] || die "model file not found: $MODEL"
python3 -c 'import sherpa_onnx' 2>/dev/null || die "sherpa-onnx not installed (pip install sherpa-onnx; see scripts/setup-voiceprint-model.sh)"

# -----------------------------------------------------------------------------
# Record mode: capture owner enroll + verify + one impostor from the mic.
# ffmpeg records straight to 16k mono WAV (the format the pipeline expects).
# -----------------------------------------------------------------------------
if [[ "$DO_RECORD" == "1" ]]; then
  command -v ffmpeg >/dev/null || die "ffmpeg not found (brew install ffmpeg)"
  WORK="$(mktemp -d /tmp/vp-mic.XXXXXX)"
  record() { # <outfile> <prompt>
    echo "" >&2
    echo ">>> $2" >&2
    echo ">>> press Enter, then speak for ~${SECONDS_LEN}s (auto-stops)..." >&2
    read -r _
    ffmpeg -y -f avfoundation -i "$DEVICE" -ar 16000 -ac 1 -t "$SECONDS_LEN" "$1" >/dev/null 2>&1
    # re-mux to normalise the header (a q-interrupted stream can leave a bad size)
    ffmpeg -y -i "$1" -ar 16000 -ac 1 -c:a pcm_s16le "${1%.wav}.clean.wav" >/dev/null 2>&1
    mv "${1%.wav}.clean.wav" "$1"
  }
  OWNER_ENROLL="${WORK}/owner_enroll.wav"; record "$OWNER_ENROLL" "OWNER enrollment — say a few sentences."
  OWNER_VERIFY="${WORK}/owner_verify.wav"; record "$OWNER_VERIFY" "OWNER verify — say DIFFERENT words (same person)."
  imp="${WORK}/impostor.wav";              record "$imp"          "IMPOSTOR — a DIFFERENT person should speak now."
  IMPOSTORS=("$imp")
fi

[[ -n "$OWNER_ENROLL" && -f "$OWNER_ENROLL" ]] || die "missing owner enroll clip (--owner or --record)"
[[ -n "$OWNER_VERIFY" && -f "$OWNER_VERIFY" ]] || die "missing owner verify clip (--verify or --record)"
[[ "${#IMPOSTORS[@]}" -gt 0 ]] || die "need at least one --impostor clip"

# -----------------------------------------------------------------------------
# Score: run every clip through the real sidecar (onnx backend), compute cosine
# similarity against the owner-enroll embedding, and print accept/reject.
# -----------------------------------------------------------------------------
VOICEPRINT_MODEL="$MODEL" \
EMBED="$EMBED" OWNER_ENROLL="$OWNER_ENROLL" OWNER_VERIFY="$OWNER_VERIFY" \
THRESHOLD="$THRESHOLD" IMPOSTORS="${IMPOSTORS[*]}" \
python3 - <<'PY'
import json, os, math, subprocess

embed = os.environ["EMBED"]
model = os.environ["VOICEPRINT_MODEL"]
thr = float(os.environ["THRESHOLD"])
clips = {"owner_enroll": os.environ["OWNER_ENROLL"], "owner_verify": os.environ["OWNER_VERIFY"]}
for i, p in enumerate(os.environ["IMPOSTORS"].split()):
    clips[f"impostor_{i+1}"] = p

req = {"version": 1, "requests": [{"id": k, "audioPath": v} for k, v in clips.items()]}
env = {**os.environ, "VOICEPRINT_BACKEND": "onnx", "VOICEPRINT_MODEL": model}
out = subprocess.run(["python3", embed], input=json.dumps(req), capture_output=True, text=True, env=env)
if out.returncode != 0:
    raise SystemExit("sidecar failed: " + (out.stderr or out.stdout)[:800])
emb = {r["id"]: r["embedding"] for r in json.loads(out.stdout)["responses"]}

def cos(a, b):
    return sum(x*y for x, y in zip(a, b)) / (math.sqrt(sum(x*x for x in a)) * math.sqrt(sum(x*x for x in b)))

owner = emb["owner_enroll"]
print(f"\nenrolled owner = owner_enroll   |   threshold = {thr}\n")
self_score = cos(owner, emb["owner_verify"])
mark = "ACCEPT (correct)" if self_score >= thr else "REJECT (!! false reject)"
print(f"  owner_verify (same person, diff words)  cos={self_score:.4f}  -> {mark}")
worst = 0.0
for k in [k for k in emb if k.startswith("impostor_")]:
    s = cos(owner, emb[k])
    worst = max(worst, s)
    mark = "REJECT (correct)" if s < thr else "ACCEPT (!! false accept)"
    print(f"  {k} (different person)             cos={s:.4f}  -> {mark}")
print(f"\n  self-match={self_score:.3f}  worst-impostor={worst:.3f}  margin={self_score-worst:.3f}  separable={self_score>=thr>worst}")
PY
