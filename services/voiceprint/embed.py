#!/usr/bin/env python3
"""
Voiceprint embedding sidecar for hawky live speaker scoring.

This is the missing embedding model behind the TS/gateway voiceprint pipeline.
The gateway spawns this process (configured via config.voiceprint.live_scoring),
writes ONE batch request as JSON to stdin, and reads ONE batch response as JSON
from stdout. The exact protocol lives in
src/identity/voiceprint/sidecar-protocol.ts; this file mirrors it.

Protocol (stdin -> stdout, both JSON, both `version: 1`):

  request  = { "version": 1, "requests": [
                { "id", "audioPath", "startMs"?, "endMs"?, "targetSampleRate"? } ] }
  response = { "version": 1, "responses": [
                { "id", "embedding": [float, ...],
                  "model": { "provider", "modelId", "version"? },
                  "audio":   { "durationMs"?, "speechMs"?, "sampleRate"?, "channels"? }?,
                  "quality": { "rms"?, "tooShort"? }? } ] }

Every request id gets EXACTLY one response id; duplicate/missing/empty ids are
errors. On a hard error (bad JSON, unparseable batch) the process prints a single
JSON error object to stdout and exits non-zero, which sidecar-client.ts surfaces
as a rejected promise. Per-request failures (missing file, unreadable WAV) also
fail the whole batch with a non-zero exit + JSON error, because the runner treats
a missing/short response id as fatal anyway.

Two backends, selected by VOICEPRINT_BACKEND:

  * "reference" (DEFAULT, test/CI): a deterministic, dependency-free projection of
    framed spectral/energy features to a fixed 192-dim vector. Same audio -> same
    vector; different audio -> different vector. It is NOT a real speaker model and
    is NOT discriminative between speakers — it exists ONLY to exercise the
    protocol + pipeline without weights or network.

  * "onnx" (PRODUCTION): wraps sherpa-onnx speaker-embedding extraction for a
    CAM++ model. We use sherpa-onnx specifically because it BUNDLES the matched
    fbank front-end for the model, avoiding the front-end-parity risk of a
    hand-rolled log-mel. The model path comes from VOICEPRINT_MODEL. sherpa-onnx
    is imported lazily; this module loads fine without it. If "onnx" is selected
    but sherpa-onnx or the model is missing, we fail with a clear error. We never
    download weights.
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys
from typing import Any, Dict, List, Optional, Tuple

PROTOCOL_VERSION = 1
DEFAULT_TARGET_SAMPLE_RATE = 16000
REFERENCE_EMBEDDING_DIM = 192

# Bound the number of samples/response floats we will emit so a pathological
# request cannot blow past the sidecar's maxStdoutBytes and get the parent to
# SIGTERM us mid-write. The reference/onnx embeddings are small fixed-dim vectors,
# so this only guards against absurd batch sizes.
MAX_BATCH_REQUESTS = 4096


class EmbeddingError(Exception):
    """A request- or batch-level failure that should fail the whole batch."""


# -----------------------------------------------------------------------------
# Protocol parse / serialize (mirrors sidecar-protocol.ts)
# -----------------------------------------------------------------------------
def parse_batch_request(raw: Any) -> List[Dict[str, Any]]:
    """Validate and normalize the incoming batch request.

    Mirrors validateEmbeddingBatchRequest / validateEmbeddingRequest in
    sidecar-protocol.ts: version must be 1, requests a non-empty array, ids
    unique and non-empty, audioPath non-empty, numeric fields sane.
    """
    if not isinstance(raw, dict):
        raise EmbeddingError("Voiceprint embedding batch request must be an object.")
    if raw.get("version") != PROTOCOL_VERSION:
        raise EmbeddingError(
            f"Unsupported voiceprint embedding request version: {raw.get('version')!r}."
        )
    requests = raw.get("requests")
    if not isinstance(requests, list):
        raise EmbeddingError("Voiceprint embedding batch request requires requests array.")
    if len(requests) == 0:
        raise EmbeddingError("Voiceprint embedding batch requires at least one request.")
    if len(requests) > MAX_BATCH_REQUESTS:
        raise EmbeddingError(
            f"Voiceprint embedding batch exceeds {MAX_BATCH_REQUESTS} requests."
        )

    seen: set = set()
    normalized: List[Dict[str, Any]] = []
    for req in requests:
        item = _parse_request(req)
        if item["id"] in seen:
            raise EmbeddingError(f"Duplicate voiceprint embedding request id: {item['id']}.")
        seen.add(item["id"])
        normalized.append(item)
    return normalized


def _parse_request(req: Any) -> Dict[str, Any]:
    if not isinstance(req, dict):
        raise EmbeddingError("Voiceprint embedding request must be an object.")
    rid = req.get("id")
    if not isinstance(rid, str) or not rid.strip():
        raise EmbeddingError("Voiceprint embedding request requires id.")
    audio_path = req.get("audioPath")
    if not isinstance(audio_path, str) or not audio_path.strip():
        raise EmbeddingError("Voiceprint embedding request requires audioPath.")

    start_ms = _optional_non_negative(req.get("startMs"), "startMs", rid)
    end_ms = _optional_non_negative(req.get("endMs"), "endMs", rid)
    if start_ms is not None and end_ms is not None and end_ms <= start_ms:
        raise EmbeddingError(
            f"Voiceprint embedding request {rid} endMs must be greater than startMs."
        )
    target = req.get("targetSampleRate")
    if target is not None:
        if not _is_number(target) or target <= 0:
            raise EmbeddingError(
                f"Voiceprint embedding request {rid} targetSampleRate must be positive."
            )

    return {
        "id": rid,
        "audioPath": audio_path,
        "startMs": start_ms,
        "endMs": end_ms,
        # Sample rates are integers; the TS contract only requires a positive
        # finite number, so round (not truncate) a fractional rate to the nearest
        # integer to minimize divergence from the shared contract.
        "targetSampleRate": int(round(target)) if target is not None else None,
    }


def _optional_non_negative(value: Any, field: str, rid: str) -> Optional[float]:
    if value is None:
        return None
    if not _is_number(value) or value < 0:
        raise EmbeddingError(
            f"Voiceprint embedding request {rid} {field} must be a non-negative number."
        )
    return float(value)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def serialize_batch_response(responses: List[Dict[str, Any]]) -> str:
    return json.dumps({"version": PROTOCOL_VERSION, "responses": responses}, ensure_ascii=True)


# -----------------------------------------------------------------------------
# WAV load + clip + resample (direct RIFF parse; stdlib `struct` only, no deps)
# -----------------------------------------------------------------------------
# We parse the RIFF/WAVE container ourselves rather than through the stdlib `wave`
# module for two reasons: (1) `wave` cannot read IEEE-float WAVs (format code 3),
# and (2) the old widen path depended on `audioop`, which was removed from the
# stdlib in Python 3.13. This decoder mirrors src/identity/voiceprint/wav.ts
# sample-for-sample (8-bit unsigned, 16/24/32-bit signed PCM, 32/64-bit float,
# channel averaging) so the Python embedding and the TS-side owner-template
# features are read from the same audio.
WAV_FORMAT_PCM = 1
WAV_FORMAT_IEEE_FLOAT = 3


class LoadedAudio:
    __slots__ = ("samples", "sample_rate", "duration_ms")

    def __init__(self, samples: List[float], sample_rate: int, duration_ms: float):
        self.samples = samples          # mono float32 in [-1, 1]
        self.sample_rate = sample_rate
        self.duration_ms = duration_ms


def load_audio(
    audio_path: str,
    start_ms: Optional[float],
    end_ms: Optional[float],
    target_sample_rate: int,
) -> LoadedAudio:
    """Read a PCM/float WAV, downmix to mono, clip to [start,end], resample."""
    if not os.path.isfile(audio_path):
        raise EmbeddingError(f"Voiceprint audio file not found: {audio_path}.")

    try:
        with open(audio_path, "rb") as handle:
            raw_file = handle.read()
    except OSError as exc:
        raise EmbeddingError(f"Voiceprint WAV is unreadable ({audio_path}): {exc}.") from exc

    try:
        samples, source_rate = _decode_wav(raw_file)
    except EmbeddingError as exc:
        raise EmbeddingError(f"Voiceprint WAV is unreadable ({audio_path}): {exc}.") from exc

    # Clip to the requested window (on the SOURCE rate before resampling).
    samples = _clip_samples(samples, source_rate, start_ms, end_ms)

    # Resample to the target rate with the same linear interpolation as
    # src/identity/voiceprint/wav.ts resampleLinear (see _resample_linear).
    resampled = _resample_linear(samples, source_rate, target_sample_rate)
    duration_ms = (len(resampled) / target_sample_rate) * 1000.0 if target_sample_rate else 0.0
    return LoadedAudio(resampled, target_sample_rate, duration_ms)


def _decode_wav(raw: bytes) -> Tuple[List[float], int]:
    """Parse a RIFF/WAVE buffer into mono float samples + sample rate.

    Mirrors parseWavPcm/readSample in src/identity/voiceprint/wav.ts.
    """
    if len(raw) < 44 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise EmbeddingError("expected a RIFF/WAVE buffer")

    fmt: Optional[Dict[str, int]] = None
    data_start = -1
    data_size = 0
    offset = 12
    n = len(raw)
    while offset + 8 <= n:
        chunk_id = raw[offset:offset + 4]
        size = struct.unpack_from("<I", raw, offset + 4)[0]
        payload_start = offset + 8
        if chunk_id == b"fmt ":
            if size < 16:
                raise EmbeddingError("invalid WAV fmt chunk")
            (format_code, channels, sample_rate) = struct.unpack_from("<HHI", raw, payload_start)
            (block_align, bits_per_sample) = struct.unpack_from("<HH", raw, payload_start + 12)
            fmt = {
                "formatCode": format_code,
                "channels": channels,
                "sampleRate": sample_rate,
                "blockAlign": block_align,
                "bitsPerSample": bits_per_sample,
            }
        elif chunk_id == b"data":
            data_start = payload_start
            # Clamp to the buffer end only here, where the payload span is used —
            # no other chunk needs payload_end, so this avoids recomputing it for
            # every fmt/aux chunk while yielding the identical data_size.
            data_size = min(payload_start + size, n) - payload_start
            break
        offset = payload_start + size + (size % 2)

    if fmt is None:
        raise EmbeddingError("WAV file is missing a fmt chunk")
    if data_start < 0:
        raise EmbeddingError("WAV file is missing a data chunk")
    if fmt["channels"] <= 0 or fmt["sampleRate"] <= 0 or fmt["blockAlign"] <= 0:
        raise EmbeddingError("WAV file has invalid audio format metadata")

    bits = fmt["bitsPerSample"]
    if bits <= 0 or bits % 8 != 0:
        raise EmbeddingError(f"unsupported WAV bit depth: {bits}")
    bytes_per_sample = bits // 8
    read_sample = _sample_reader(fmt["formatCode"], bits)

    channels = fmt["channels"]
    block_align = fmt["blockAlign"]
    frame_count = data_size // block_align
    samples: List[float] = [0.0] * frame_count
    for frame in range(frame_count):
        frame_offset = data_start + frame * block_align
        mono = 0.0
        for channel in range(channels):
            sample_offset = frame_offset + channel * bytes_per_sample
            mono += read_sample(raw, sample_offset)
        samples[frame] = mono / channels
    return samples, fmt["sampleRate"]


def _sample_reader(format_code: int, bits_per_sample: int):
    """Return a fn(buf, offset) -> float in [-1, 1], matching wav.ts readSample."""
    if format_code == WAV_FORMAT_PCM:
        if bits_per_sample == 8:
            # 8-bit PCM WAV is UNSIGNED per spec (silence = 128), matching
            # wav.ts (buf.readUInt8(offset) - 128) / 128.
            return lambda buf, off: (buf[off] - 128) / 128.0
        if bits_per_sample == 16:
            return lambda buf, off: struct.unpack_from("<h", buf, off)[0] / 32768.0
        if bits_per_sample == 24:
            return lambda buf, off: _read_int24_le(buf, off) / 8388608.0
        if bits_per_sample == 32:
            return lambda buf, off: struct.unpack_from("<i", buf, off)[0] / 2147483648.0
        raise EmbeddingError(f"unsupported PCM WAV bit depth: {bits_per_sample}")
    if format_code == WAV_FORMAT_IEEE_FLOAT:
        if bits_per_sample == 32:
            return lambda buf, off: struct.unpack_from("<f", buf, off)[0]
        if bits_per_sample == 64:
            return lambda buf, off: struct.unpack_from("<d", buf, off)[0]
    raise EmbeddingError(
        f"unsupported WAV format code {format_code} / {bits_per_sample} bits"
    )


def _read_int24_le(buf: bytes, offset: int) -> int:
    return int.from_bytes(buf[offset:offset + 3], "little", signed=True)


def _clip_samples(
    samples: List[float],
    sample_rate: int,
    start_ms: Optional[float],
    end_ms: Optional[float],
) -> List[float]:
    if not samples:
        return samples
    # Mirror sliceWavAudio in src/identity/voiceprint/wav.ts: floor (not round)
    # the millisecond boundaries to sample indices so the clip window matches the
    # TS-side owner-template read sample-for-sample.
    start = 0 if start_ms is None else max(0, int(math.floor(start_ms / 1000.0 * sample_rate)))
    end = (
        len(samples)
        if end_ms is None
        else min(len(samples), int(math.floor(end_ms / 1000.0 * sample_rate)))
    )
    if end <= start:
        return []
    return samples[start:end]


def _resample_linear(samples: List[float], source_rate: int, target_rate: int) -> List[float]:
    # Mirror resampleLinear in src/identity/voiceprint/wav.ts sample-for-sample:
    # rate-ratio stepping `sourceIndex = i * (fromRate / toRate)` (NOT endpoint-
    # anchored), so the Python-side resample matches the TS reference exactly.
    if not samples or source_rate == target_rate:
        return list(samples)
    n = len(samples)
    out_len = max(1, int(round(n * target_rate / source_rate)))
    ratio = source_rate / target_rate
    out: List[float] = []
    for i in range(out_len):
        source_index = i * ratio
        left = int(math.floor(source_index))
        right = min(left + 1, n - 1)
        frac = source_index - left
        out.append(samples[left] * (1.0 - frac) + samples[right] * frac)
    return out


# -----------------------------------------------------------------------------
# Shared feature front-end for the reference backend
# -----------------------------------------------------------------------------
def _rms(samples: List[float]) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


# Voiced-energy detection: a frame counts as voiced when its RMS clears a floor
# set to a fraction of the clip's overall RMS, but never below an absolute noise
# floor (so a near-silent clip is not scored as all-voiced).
SPEECH_ABSOLUTE_RMS_FLOOR = 1e-4
SPEECH_RELATIVE_RMS_FRACTION = 0.35


def _speech_ms(samples: List[float], sample_rate: int) -> float:
    """Rough voiced-energy estimate: frames whose RMS is above a small floor."""
    if not samples or sample_rate <= 0:
        return 0.0
    frame = max(1, int(sample_rate * 0.02))  # 20 ms frames
    total = _rms(samples)
    floor = max(SPEECH_ABSOLUTE_RMS_FLOOR, total * SPEECH_RELATIVE_RMS_FRACTION)
    voiced = 0
    for start in range(0, len(samples), frame):
        chunk = samples[start:start + frame]
        if _rms(chunk) >= floor:
            voiced += len(chunk)
    return (voiced / sample_rate) * 1000.0


# -----------------------------------------------------------------------------
# Backends
# -----------------------------------------------------------------------------
class ReferenceBackend:
    """Deterministic, dependency-free, NON-DISCRIMINATIVE embedding backend.

    Maps audio -> a fixed 192-dim vector via a seeded projection of framed
    spectral/energy features. Same audio always yields the same vector; different
    audio yields a different vector, so the pipeline (id matching, cosine scoring,
    storage) is fully exercisable without weights or network.

    IT IS NOT A SPEAKER MODEL. It does not attempt to separate one speaker from
    another; do not use it for real identity decisions. It exists for tests/CI.
    """

    provider = "reference"
    model_id = "reference-fbank-v0"
    version = "0"

    N_FRAMES = 32
    N_BANDS = 24  # coarse spectral bands per frame -> 32*24 = 768 raw features

    # Deterministic bias so all-zero audio still yields a non-zero-norm vector
    # (required by the TS validator). BIAS_SEED is an arbitrary fixed lane fed to
    # the seeded weight generator; BIAS_SCALE keeps the bias tiny vs real features.
    BIAS_SEED = 0xBEEF
    BIAS_SCALE = 1e-3

    def model_info(self) -> Dict[str, str]:
        return {"provider": self.provider, "modelId": self.model_id, "version": self.version}

    def embed(self, audio: LoadedAudio) -> List[float]:
        features = self._features(audio.samples, audio.sample_rate)
        return self._project(features)

    def _features(self, samples: List[float], sample_rate: int) -> List[float]:
        # Split the (possibly empty) signal into N_FRAMES equal chunks and compute
        # coarse per-chunk band energies. This is a crude fbank-shaped feature —
        # deterministic and cheap, not perceptual (see the NON-DISCRIMINATIVE note
        # on the class).
        feats: List[float] = []
        n = len(samples)
        if n == 0:
            return [0.0] * (self.N_FRAMES * self.N_BANDS)
        frame_len = max(1, n // self.N_FRAMES)
        for f in range(self.N_FRAMES):
            start = f * frame_len
            chunk = samples[start:start + frame_len] if start < n else []
            feats.extend(self._band_energies(chunk))
        return feats

    def _band_energies(self, chunk: List[float]) -> List[float]:
        bands = [0.0] * self.N_BANDS
        m = len(chunk)
        if m == 0:
            return bands
        # Downsample the DFT: evaluate N_BANDS frequency bins directly (Goertzel-
        # style), giving band energies without a full FFT dependency.
        for b in range(self.N_BANDS):
            freq = (b + 1) / (self.N_BANDS + 1)  # normalized (0, 1)
            omega = 2.0 * math.pi * freq * 0.5   # up to Nyquist
            real = 0.0
            imag = 0.0
            for i, s in enumerate(chunk):
                real += s * math.cos(omega * i)
                imag += s * math.sin(omega * i)
            bands[b] = math.log1p((real * real + imag * imag) / (m * m))
        return bands

    def _project(self, features: List[float]) -> List[float]:
        # Seeded linear projection features -> 192-dim, using a deterministic
        # pseudo-random weight generated on the fly (no numpy dependency). The
        # seed is fixed so the mapping is stable across processes/hosts.
        dim = REFERENCE_EMBEDDING_DIM
        out = [0.0] * dim
        for j, x in enumerate(features):
            if x == 0.0:
                continue
            for d in range(dim):
                out[d] += x * _seeded_weight(j, d)
        # Add a tiny deterministic bias so all-zero audio still yields a usable
        # (non-zero-norm) vector, which the TS validator requires.
        for d in range(dim):
            out[d] += _seeded_weight(self.BIAS_SEED, d) * self.BIAS_SCALE
        return _l2_normalize(out)


def _seeded_weight(a: int, b: int) -> float:
    # Deterministic hash -> [-1, 1). splitmix64-style mixing on a 64-bit lane.
    x = (a * 0x9E3779B97F4A7C15 + b * 0xD1B54A32D192ED03 + 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF
    x ^= x >> 30
    x = (x * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
    x ^= x >> 27
    x = (x * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    x ^= x >> 31
    return (x / 0xFFFFFFFFFFFFFFFF) * 2.0 - 1.0


def _l2_normalize(vec: List[float]) -> List[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm <= 0:
        # Should not happen given the bias term, but keep the vector usable.
        return [1.0] + [0.0] * (len(vec) - 1)
    return [v / norm for v in vec]


class OnnxBackend:
    """Production backend: sherpa-onnx speaker-embedding extraction for CAM++.

    sherpa-onnx is imported LAZILY and only when this backend is actually used,
    so the module imports without it. The model path comes from VOICEPRINT_MODEL.
    We use sherpa-onnx precisely BECAUSE it bundles the matched fbank front-end
    for the model, avoiding front-end-parity drift from a hand-rolled log-mel.
    We never download weights.
    """

    provider = "sherpa-onnx"
    model_id = "cam++"

    def __init__(self) -> None:
        self._extractor = None
        # Read VOICEPRINT_MODEL exactly once at construction; both the version tag
        # and the lazy engine build reuse this snapshot (env is fixed for the life
        # of the process, so this is behavior-identical to reading it twice).
        self._model_path = os.environ.get("VOICEPRINT_MODEL")
        self._version = self._resolve_version()

    def _resolve_version(self) -> Optional[str]:
        model_path = self._model_path
        if not model_path:
            return None
        # Use the model file's basename (minus extension) as the version tag so a
        # swapped model is distinguishable downstream.
        base = os.path.basename(model_path.rstrip(os.sep))
        for ext in (".onnx", ".ONNX"):
            if base.endswith(ext):
                base = base[: -len(ext)]
        return base or None

    def model_info(self) -> Dict[str, str]:
        info = {"provider": self.provider, "modelId": self.model_id}
        if self._version:
            info["version"] = self._version
        return info

    def _engine(self):
        if self._extractor is not None:
            return self._extractor
        model_path = self._model_path
        if not model_path:
            raise EmbeddingError(
                "VOICEPRINT_MODEL is required for the onnx backend "
                "(path to a sherpa-onnx CAM++ speaker-embedding model)."
            )
        if not os.path.isfile(model_path):
            raise EmbeddingError(f"Voiceprint onnx model not found: {model_path}.")
        try:
            import sherpa_onnx  # type: ignore
        except ImportError as exc:
            raise EmbeddingError(
                "sherpa-onnx is not installed but the onnx backend was selected. "
                "Install it (pip install sherpa-onnx) to use real embeddings."
            ) from exc

        num_threads = int(os.environ.get("VOICEPRINT_ONNX_THREADS", "1"))
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=model_path,
            num_threads=num_threads,
            provider=os.environ.get("VOICEPRINT_ONNX_PROVIDER", "cpu"),
        )
        if not config.validate():
            raise EmbeddingError(f"Invalid sherpa-onnx speaker-embedding config for {model_path}.")
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        return self._extractor

    def embed(self, audio: LoadedAudio) -> List[float]:
        extractor = self._engine()
        stream = extractor.create_stream()
        # sherpa-onnx expects float32 mono samples in [-1, 1]; it owns the fbank.
        stream.accept_waveform(sample_rate=audio.sample_rate, waveform=audio.samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            raise EmbeddingError(
                "Voiceprint audio segment is too short for the onnx speaker model."
            )
        embedding = extractor.compute(stream)
        return [float(v) for v in embedding]


def select_backend(name: Optional[str]):
    backend = (name or "reference").strip().lower()
    if backend == "reference":
        return ReferenceBackend()
    if backend == "onnx":
        return OnnxBackend()
    raise EmbeddingError(
        f"Unknown VOICEPRINT_BACKEND {backend!r} (expected 'reference' or 'onnx')."
    )


# -----------------------------------------------------------------------------
# Batch driver
# -----------------------------------------------------------------------------
def process_batch(raw_request: Any, backend) -> Dict[str, Any]:
    requests = parse_batch_request(raw_request)
    responses: List[Dict[str, Any]] = []
    for req in requests:
        target_rate = req["targetSampleRate"] or DEFAULT_TARGET_SAMPLE_RATE
        audio = load_audio(req["audioPath"], req["startMs"], req["endMs"], target_rate)
        embedding = backend.embed(audio)
        if not embedding or not all(math.isfinite(v) for v in embedding):
            raise EmbeddingError(
                f"Backend produced a non-finite/empty embedding for {req['id']}."
            )
        responses.append(
            {
                "id": req["id"],
                "embedding": embedding,
                "model": backend.model_info(),
                "audio": {
                    "durationMs": round(audio.duration_ms, 3),
                    "speechMs": round(_speech_ms(audio.samples, audio.sample_rate), 3),
                    "sampleRate": audio.sample_rate,
                    "channels": 1,
                },
                "quality": {
                    "rms": round(_rms(audio.samples), 6),
                    "tooShort": len(audio.samples) == 0,
                },
            }
        )
    return {"version": PROTOCOL_VERSION, "responses": responses}


def run(stdin, stdout) -> int:
    """Drive one batch: read a JSON request from `stdin`, write JSON to `stdout`.

    On success writes the batch response and returns 0. On any failure writes a
    single `{"error": ...}` object to stdout and returns 1 (never raising), so the
    parent sees a JSON error + non-zero exit rather than a crash. All output goes
    to stdout because that is the sidecar protocol; stderr is left for the parent.
    """
    try:
        text = stdin.read()
    except Exception as exc:  # pragma: no cover - defensive
        stdout.write(json.dumps({"error": f"failed to read stdin: {exc}"}))
        return 1

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        stdout.write(json.dumps({"error": f"invalid JSON request: {exc}"}))
        return 1

    try:
        backend = select_backend(os.environ.get("VOICEPRINT_BACKEND"))
        response = process_batch(raw, backend)
    except EmbeddingError as exc:
        stdout.write(json.dumps({"error": str(exc)}))
        return 1
    except Exception as exc:  # pragma: no cover - defensive, never crash parent
        stdout.write(json.dumps({"error": f"unexpected voiceprint sidecar error: {exc}"}))
        return 1

    # Serialize the success path through the shared helper so the wire format
    # (version envelope + ensure_ascii) is defined in exactly one place.
    stdout.write(serialize_batch_response(response["responses"]))
    return 0


def main() -> int:
    return run(sys.stdin, sys.stdout)


if __name__ == "__main__":
    sys.exit(main())
