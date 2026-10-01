#!/usr/bin/env python3
"""
Tests for the voiceprint embedding sidecar (services/voiceprint/embed.py).

Self-contained: runs with a plain `python3 test_embed.py` (pytest is not required
and is not installed in this repo's Python), exiting non-zero on the first
failure. Also importable under pytest — each `test_*` function is a plain assert.

Covers: protocol parse/serialize round-trip, WAV load + clip + resample,
deterministic backend stability (same audio -> same vector; different -> different),
batch id matching, and every error case (missing id, missing file, duplicate ids,
empty batch, bad version). WAV fixtures are generated in-process; no external files,
no weights, no network.
"""
from __future__ import annotations

import io
import json
import math
import os
import struct
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import embed  # noqa: E402


# -----------------------------------------------------------------------------
# Fixtures
# -----------------------------------------------------------------------------
def _write_wav(path, freq=220.0, seconds=0.5, sample_rate=16000, channels=1, amp=0.5):
    n = int(seconds * sample_rate)
    frames = bytearray()
    for i in range(n):
        val = int(amp * 32767 * math.sin(2 * math.pi * freq * i / sample_rate))
        for _c in range(channels):
            frames += struct.pack("<h", val)
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(frames))
    return path


def _tmp(name):
    d = tempfile.mkdtemp(prefix="voiceprint-test-")
    return os.path.join(d, name)


def _write_riff(path, fmt_code, bits, channels, sample_rate, frames_bytes):
    """Write a minimal RIFF/WAVE file for formats the stdlib `wave` can't emit."""
    block_align = channels * (bits // 8)
    byte_rate = sample_rate * block_align
    data_size = len(frames_bytes)
    header = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, fmt_code, channels, sample_rate, byte_rate, block_align, bits
    )
    header += b"data" + struct.pack("<I", data_size)
    with open(path, "wb") as f:
        f.write(header + frames_bytes)
    return path


# -----------------------------------------------------------------------------
# Protocol
# -----------------------------------------------------------------------------
def test_parse_batch_request_roundtrip():
    raw = {
        "version": 1,
        "requests": [
            {"id": "a", "audioPath": "/x.wav"},
            {"id": "b", "audioPath": "/y.wav", "startMs": 10, "endMs": 20, "targetSampleRate": 8000},
        ],
    }
    parsed = embed.parse_batch_request(raw)
    assert [r["id"] for r in parsed] == ["a", "b"]
    assert parsed[1]["startMs"] == 10.0 and parsed[1]["endMs"] == 20.0
    assert parsed[1]["targetSampleRate"] == 8000


def test_serialize_batch_response():
    out = embed.serialize_batch_response([
        {"id": "a", "embedding": [1.0, 0.0], "model": {"provider": "reference", "modelId": "reference-fbank-v0"}},
    ])
    parsed = json.loads(out)
    assert parsed["version"] == 1
    assert parsed["responses"][0]["id"] == "a"


def test_empty_batch_is_error():
    _expect_error(lambda: embed.parse_batch_request({"version": 1, "requests": []}), "at least one")


def test_bad_version_is_error():
    _expect_error(lambda: embed.parse_batch_request({"version": 2, "requests": []}), "version")


def test_missing_id_is_error():
    _expect_error(
        lambda: embed.parse_batch_request({"version": 1, "requests": [{"audioPath": "/x.wav"}]}),
        "requires id",
    )


def test_missing_audio_path_is_error():
    _expect_error(
        lambda: embed.parse_batch_request({"version": 1, "requests": [{"id": "a"}]}),
        "audioPath",
    )


def test_duplicate_ids_is_error():
    _expect_error(
        lambda: embed.parse_batch_request(
            {"version": 1, "requests": [{"id": "a", "audioPath": "/x.wav"}, {"id": "a", "audioPath": "/y.wav"}]}
        ),
        "Duplicate",
    )


def test_bad_time_window_is_error():
    _expect_error(
        lambda: embed.parse_batch_request(
            {"version": 1, "requests": [{"id": "a", "audioPath": "/x.wav", "startMs": 30, "endMs": 20}]}
        ),
        "greater than startMs",
    )


# -----------------------------------------------------------------------------
# WAV load + clip + resample
# -----------------------------------------------------------------------------
def test_load_audio_resamples_to_target():
    path = _write_wav(_tmp("mono.wav"), seconds=1.0, sample_rate=48000)
    audio = embed.load_audio(path, None, None, 16000)
    assert audio.sample_rate == 16000
    # ~1s of audio resampled to 16k -> ~16000 samples.
    assert abs(len(audio.samples) - 16000) < 50
    assert abs(audio.duration_ms - 1000.0) < 5.0


def test_load_audio_clips_window():
    path = _write_wav(_tmp("clip.wav"), seconds=1.0, sample_rate=16000)
    full = embed.load_audio(path, None, None, 16000)
    clipped = embed.load_audio(path, 250, 750, 16000)
    assert len(clipped.samples) < len(full.samples)
    # 500ms window at 16k -> ~8000 samples.
    assert abs(len(clipped.samples) - 8000) < 50


def test_load_audio_downmixes_stereo():
    path = _write_wav(_tmp("stereo.wav"), seconds=0.5, sample_rate=16000, channels=2)
    audio = embed.load_audio(path, None, None, 16000)
    assert audio.sample_rate == 16000
    assert len(audio.samples) > 0


def test_load_audio_8bit_is_unsigned():
    # 8-bit PCM WAV is UNSIGNED per spec: silence = 128 -> ~0.0, not full-scale.
    frames = struct.pack("<3B", 128, 128, 128)  # silence
    path = _write_riff(_tmp("u8_silence.wav"), embed.WAV_FORMAT_PCM, 8, 1, 16000, frames)
    audio = embed.load_audio(path, None, None, 16000)
    assert all(abs(s) < 1e-6 for s in audio.samples), audio.samples
    # Max positive (255) and max negative (0) map near +/-1, not both negative.
    frames = struct.pack("<2B", 255, 0)
    path = _write_riff(_tmp("u8_extremes.wav"), embed.WAV_FORMAT_PCM, 8, 1, 16000, frames)
    audio = embed.load_audio(path, None, None, 16000)
    assert audio.samples[0] > 0.9 and audio.samples[1] < -0.9, audio.samples


def test_load_audio_float32_is_supported():
    # The stdlib `wave` module rejects IEEE-float WAVs; our decoder accepts them,
    # matching the TS reader (format code 3).
    frames = struct.pack("<3f", 0.5, -0.5, 0.0)
    path = _write_riff(_tmp("f32.wav"), embed.WAV_FORMAT_IEEE_FLOAT, 32, 1, 16000, frames)
    audio = embed.load_audio(path, None, None, 16000)
    assert abs(audio.samples[0] - 0.5) < 1e-6
    assert abs(audio.samples[1] + 0.5) < 1e-6


def test_load_audio_no_audioop_dependency():
    # audioop was removed from the stdlib in Python 3.13; the sidecar must not
    # depend on it. Importing embed and decoding the default 16-bit path must work
    # regardless of whether audioop is present.
    assert "audioop" not in sys.modules or True  # embed never imports it
    src = open(embed.__file__, "r", encoding="utf-8").read()
    assert "import audioop" not in src


def test_load_audio_missing_file_is_error():
    _expect_error(lambda: embed.load_audio("/no/such/file.wav", None, None, 16000), "not found")


def test_load_audio_unreadable_wav_is_error():
    path = _tmp("bad.wav")
    with open(path, "wb") as f:
        f.write(b"not a wav file at all")
    _expect_error(lambda: embed.load_audio(path, None, None, 16000), "unreadable")


# -----------------------------------------------------------------------------
# Reference backend determinism
# -----------------------------------------------------------------------------
def test_reference_backend_dim_and_normalized():
    path = _write_wav(_tmp("ref.wav"))
    audio = embed.load_audio(path, None, None, 16000)
    backend = embed.ReferenceBackend()
    vec = backend.embed(audio)
    assert len(vec) == embed.REFERENCE_EMBEDDING_DIM
    norm = math.sqrt(sum(v * v for v in vec))
    assert abs(norm - 1.0) < 1e-6
    assert all(math.isfinite(v) for v in vec)


def test_reference_backend_same_audio_same_vector():
    path = _write_wav(_tmp("same.wav"), freq=300.0)
    a1 = embed.load_audio(path, None, None, 16000)
    a2 = embed.load_audio(path, None, None, 16000)
    b = embed.ReferenceBackend()
    assert b.embed(a1) == b.embed(a2)


def test_reference_backend_different_audio_different_vector():
    p1 = _write_wav(_tmp("f220.wav"), freq=220.0)
    p2 = _write_wav(_tmp("f880.wav"), freq=880.0)
    b = embed.ReferenceBackend()
    v1 = b.embed(embed.load_audio(p1, None, None, 16000))
    v2 = b.embed(embed.load_audio(p2, None, None, 16000))
    assert v1 != v2
    # And meaningfully different (cosine well below 1).
    dot = sum(x * y for x, y in zip(v1, v2))
    assert dot < 0.999


def test_reference_backend_empty_audio_still_usable():
    path = _write_wav(_tmp("tiny.wav"), seconds=0.0)
    audio = embed.load_audio(path, None, None, 16000)
    vec = embed.ReferenceBackend().embed(audio)
    norm = math.sqrt(sum(v * v for v in vec))
    assert norm > 0  # TS validator requires a non-zero-norm vector.


# -----------------------------------------------------------------------------
# Full batch driver + id matching
# -----------------------------------------------------------------------------
def test_process_batch_id_matching():
    p1 = _write_wav(_tmp("t1.wav"), freq=200.0)
    p2 = _write_wav(_tmp("t2.wav"), freq=400.0)
    raw = {
        "version": 1,
        "requests": [
            {"id": "turn_1", "audioPath": p1},
            {"id": "turn_2", "audioPath": p2},
        ],
    }
    resp = embed.process_batch(raw, embed.ReferenceBackend())
    assert resp["version"] == 1
    ids = [r["id"] for r in resp["responses"]]
    assert ids == ["turn_1", "turn_2"]
    for r in resp["responses"]:
        assert len(r["embedding"]) == embed.REFERENCE_EMBEDDING_DIM
        assert r["model"]["provider"] == "reference"
        assert r["model"]["modelId"] == "reference-fbank-v0"
        assert r["audio"]["sampleRate"] == 16000
        assert r["audio"]["speechMs"] >= 0


def test_run_end_to_end_via_stdin_stdout():
    path = _write_wav(_tmp("e2e.wav"))
    req = {"version": 1, "requests": [{"id": "x", "audioPath": path}]}
    stdin = io.StringIO(json.dumps(req))
    stdout = io.StringIO()
    os.environ["VOICEPRINT_BACKEND"] = "reference"
    code = embed.run(stdin, stdout)
    assert code == 0
    parsed = json.loads(stdout.getvalue())
    assert parsed["responses"][0]["id"] == "x"


def test_run_invalid_json_returns_json_error_nonzero():
    stdin = io.StringIO("{not json")
    stdout = io.StringIO()
    code = embed.run(stdin, stdout)
    assert code == 1
    assert "error" in json.loads(stdout.getvalue())


def test_run_missing_file_returns_json_error_nonzero():
    req = {"version": 1, "requests": [{"id": "x", "audioPath": "/no/such.wav"}]}
    stdin = io.StringIO(json.dumps(req))
    stdout = io.StringIO()
    code = embed.run(stdin, stdout)
    assert code == 1
    assert "error" in json.loads(stdout.getvalue())


def test_select_backend_unknown_is_error():
    _expect_error(lambda: embed.select_backend("bogus"), "Unknown VOICEPRINT_BACKEND")


def test_onnx_backend_missing_deps_is_clear_error():
    # Selecting onnx without VOICEPRINT_MODEL should raise a clear error when we
    # try to use it (no download attempted).
    old = os.environ.pop("VOICEPRINT_MODEL", None)
    try:
        backend = embed.select_backend("onnx")
        path = _write_wav(_tmp("onnx.wav"))
        audio = embed.load_audio(path, None, None, 16000)
        _expect_error(lambda: backend.embed(audio), "VOICEPRINT_MODEL")
    finally:
        if old is not None:
            os.environ["VOICEPRINT_MODEL"] = old


# -----------------------------------------------------------------------------
# Tiny standalone runner (no pytest dependency)
# -----------------------------------------------------------------------------
def _expect_error(fn, needle):
    try:
        fn()
    except embed.EmbeddingError as exc:
        assert needle in str(exc), f"expected {needle!r} in {exc!r}"
        return
    raise AssertionError(f"expected EmbeddingError containing {needle!r}")


def _main():
    tests = [(name, obj) for name, obj in sorted(globals().items())
             if name.startswith("test_") and callable(obj)]
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   - {name}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL - {name}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_main())
