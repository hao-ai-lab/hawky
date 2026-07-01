"""
Tests for the InsightFace recognition microservice (hawky #627).

InsightFace + cv2 are mocked so these run in CI without models/onnxruntime. We
mock the engine to return fake faces with det_score / bbox / pose / embedding, and
assert: enroll stores an embedding, the QUALITY GATE rejects low-score/tiny/extreme
faces, identify cosine-matches the same identity and ADDS the embedding, a
different face is below threshold, enroll de-dupes against existing people, and
update mutates the profile.
"""
from __future__ import annotations

import base64
import importlib
import os
import sys
import types

import numpy as np
import pytest


class FakeFace:
    def __init__(self, embedding, det_score=0.9, w=200, pose=(0, 0, 0)):
        self.normed_embedding = np.asarray(embedding, dtype=np.float32)
        self.det_score = det_score
        self.bbox = np.array([0, 0, w, w], dtype=np.float32)
        self.pose = np.asarray(pose, dtype=np.float32)


def _install_cv2():
    cv2 = types.ModuleType("cv2")
    cv2.IMREAD_COLOR = 1
    cv2.IMWRITE_JPEG_QUALITY = 1
    cv2.imdecode = lambda arr, flag: np.zeros((8, 8, 3), dtype=np.uint8)
    cv2.imwrite = lambda path, img: open(path, "wb").close() or True
    cv2.imread = lambda path: np.zeros((8, 8, 3), dtype=np.uint8)
    cv2.resize = lambda img, size: np.zeros((size[1], size[0], 3), dtype=np.uint8)
    cv2.imencode = lambda ext, img, params=None: (True, np.zeros(4, dtype=np.uint8))
    sys.modules["cv2"] = cv2


@pytest.fixture
def A(tmp_path):
    os.environ["DEEPFACE_DB"] = str(tmp_path / "facedb")
    os.environ["FACE_MATCH_THRESHOLD"] = "0.35"
    os.environ["FACE_MIN_DET_SCORE"] = "0.62"
    os.environ["FACE_MIN_PX"] = "70"
    os.environ["FACE_MAX_POSE_DEG"] = "40"
    _install_cv2()
    sys.path.insert(0, os.path.dirname(__file__))
    import app as A  # type: ignore

    importlib.reload(A)
    # Stub the engine: each test sets A._engine to return chosen faces.
    return A


def _b64() -> str:
    return base64.b64encode(b"\xff\xd8\xff\xd9").decode()


def _unit(seed: int, dim: int = 8) -> list[float]:
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    return (v / np.linalg.norm(v)).tolist()


def _engine_returning(*faces):
    return lambda: types.SimpleNamespace(get=lambda img: list(faces))


def test_enroll_then_identify_same_identity_adds_embedding(A):
    emb = _unit(1)
    A._engine = _engine_returning(FakeFace(emb))
    pid = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Jay"))["person"]["id"]
    r = A.identify(A.IdentifyRequest(image_base64=_b64()))
    assert r["found"] is True
    assert r["person"]["id"] == pid
    assert r["similarity"] == pytest.approx(1.0, abs=1e-4)
    # The matched embedding was appended (multi-embedding profile).
    raw = A._load()[pid]
    assert len(raw["embeddings"]) == 2


def test_quality_gate_rejects_low_score(A):
    A._engine = _engine_returning(FakeFace(_unit(2), det_score=0.40))
    r = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Blurry"))
    assert r["ok"] is False
    assert "low confidence" in r["error"]
    assert len(A.people()["people"]) == 0


def test_quality_gate_rejects_tiny_face(A):
    A._engine = _engine_returning(FakeFace(_unit(2), w=40))
    r = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Tiny"))
    assert r["ok"] is False
    assert "too small" in r["error"]


def test_quality_gate_rejects_looking_away(A):
    # pitch=75 (looking up/down a lot) → rejected.
    A._engine = _engine_returning(FakeFace(_unit(2), pose=(75, 5, 5)))
    r = A.enroll(A.EnrollRequest(image_base64=_b64(), name="LookingAway"))
    assert r["ok"] is False
    assert "looking away" in r["error"]


def test_quality_gate_allows_rolled_face(A):
    # roll=90 (rotated phone frame) but frontal pitch/yaw → MUST pass. Gating on
    # roll wrongly rejected every upright phone frame (#627 empty-DB bug).
    A._engine = _engine_returning(FakeFace(_unit(2), pose=(5, 5, 90)))
    r = A.enroll(A.EnrollRequest(image_base64=_b64(), name="RolledOK"))
    assert r["ok"] is True
    assert r["person"]["name"] == "RolledOK"


def test_picks_highest_det_score_not_largest(A):
    # A large low-score mis-detection vs a smaller high-score real face → pick real.
    real = FakeFace(_unit(7), det_score=0.95, w=120)
    junk = FakeFace(_unit(99), det_score=0.50, w=400)
    A._engine = _engine_returning(junk, real)
    pid = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Real"))["person"]["id"]
    # Identify with the real face's embedding → matches the enrolled real one.
    A._engine = _engine_returning(FakeFace(_unit(7)))
    r = A.identify(A.IdentifyRequest(image_base64=_b64()))
    assert r["found"] and r["person"]["id"] == pid


def test_different_face_below_threshold(A):
    A._engine = _engine_returning(FakeFace(_unit(3)))
    A.enroll(A.EnrollRequest(image_base64=_b64(), name="Carl"))
    A._engine = _engine_returning(FakeFace(_unit(888)))
    r = A.identify(A.IdentifyRequest(image_base64=_b64()))
    assert r["found"] is False


def test_enroll_dedupes_against_existing(A):
    emb = _unit(5)
    A._engine = _engine_returning(FakeFace(emb))
    pid = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Eve"))["person"]["id"]
    # Enroll again (same face, no id given) → attaches to Eve, no new profile.
    A._engine = _engine_returning(FakeFace(emb))
    r = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Unknown"))
    assert r["person"]["id"] == pid
    assert len(A.people()["people"]) == 1


def test_enroll_rejects_path_traversal_person_id(A, tmp_path):
    A._engine = _engine_returning(FakeFace(_unit(4)))
    outside = tmp_path / "outside"

    r = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Bad", person_id="../outside"))

    assert r["ok"] is False
    assert "person_id" in r["error"]
    assert not outside.exists()
    assert A.people()["people"] == []


def test_update_sets_name_facts_recap(A):
    A._engine = _engine_returning(FakeFace(_unit(4)))
    pid = A.enroll(A.EnrollRequest(image_base64=_b64(), name="Unknown"))["person"]["id"]
    r = A.update(A.UpdateRequest(person_id=pid, name="Dana", facts=["climbs", "climbs"], recap="Q3"))
    p = r["person"]
    assert p["name"] == "Dana"
    assert p["facts"] == ["climbs"]
    assert p["recaps"][-1]["summary"] == "Q3"
    assert "embeddings" not in p


def test_update_adds_facts_to_legacy_profile_missing_facts(A):
    pid = "legacy-1"
    A._save({
        pid: {
            "id": pid,
            "name": "Legacy",
            "embeddings": [_unit(4)],
            "recaps": [],
            "created_at": "2026-06-30T00:00:00Z",
            "last_seen_at": "2026-06-30T00:00:00Z",
        },
    })

    r = A.update(A.UpdateRequest(person_id=pid, facts=["climbs"]))

    assert r["ok"] is True
    assert r["person"]["facts"] == ["climbs"]


def test_identify_empty_db(A):
    A._engine = _engine_returning(FakeFace(_unit(1)))
    assert A.identify(A.IdentifyRequest(image_base64=_b64()))["found"] is False


def test_health(A):
    h = A.health()
    assert h["ok"] is True
    assert h["engine"] == "insightface"


def test_clear_refuses_markerless_database_dir(A):
    os.makedirs(A.DB_PATH, exist_ok=True)
    profiles_path = os.path.join(A.DB_PATH, "profiles.json")
    with open(profiles_path, "w", encoding="utf-8") as f:
        f.write('{"p1":{"id":"p1","name":"Unsafe","embeddings":[]}}')

    r = A.clear()

    assert r["ok"] is False
    assert "markerless" in r["error"]
    assert os.path.exists(profiles_path)


def test_clear_removes_only_owned_face_db_children(A):
    pid = "person-1"
    A._save({
        pid: {
            "id": pid,
            "name": "Clear Me",
            "embeddings": [_unit(4)],
            "facts": [],
            "recaps": [],
            "created_at": "2026-06-30T00:00:00Z",
            "last_seen_at": "2026-06-30T00:00:00Z",
        },
    })
    person_dir = os.path.join(A.DB_PATH, pid)
    os.makedirs(person_dir, exist_ok=True)
    with open(os.path.join(person_dir, "crop.jpg"), "wb") as f:
        f.write(b"jpg")
    keep_path = os.path.join(A.DB_PATH, "keep.txt")
    with open(keep_path, "w", encoding="utf-8") as f:
        f.write("not face-db data")

    r = A.clear()

    assert r == {"ok": True, "removed": 1}
    assert os.path.isdir(A.DB_PATH)
    assert os.path.exists(os.path.join(A.DB_PATH, A.DB_MARKER_FILE))
    assert not os.path.exists(os.path.join(A.DB_PATH, "profiles.json"))
    assert not os.path.exists(person_dir)
    assert os.path.exists(keep_path)


# -----------------------------------------------------------------------------
# Safety Check (#648): /assess_hazard — silent off-model vision classifier. The
# OpenAI HTTP call (urllib.urlopen) is mocked so these run without a key/network.
# -----------------------------------------------------------------------------
import contextlib  # noqa: E402
import io  # noqa: E402
import json as _json  # noqa: E402
import urllib.request  # noqa: E402


def _mock_openai(monkeypatch, content):
    """Make urllib.request.urlopen return a chat-completion whose message content
    is `content` (a string). Raises if `content` is an Exception instance."""

    @contextlib.contextmanager
    def fake_urlopen(req, timeout=0):
        if isinstance(content, Exception):
            raise content
        body = _json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        yield io.BytesIO(body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)


def test_assess_hazard_no_key_is_silent(A, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r == {"ok": True, "severity": "none", "kind": "", "warning": ""}


def test_assess_hazard_detects_fire(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    _mock_openai(monkeypatch, '{"severity":"high","kind":"fire","warning":"There is a fire."}')
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r["severity"] == "high"
    assert r["kind"] == "fire"
    assert "fire" in r["warning"].lower()


def test_assess_hazard_benign_scene_is_none(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    _mock_openai(monkeypatch, '{"severity":"none","kind":"","warning":""}')
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r["severity"] == "none"


def test_assess_hazard_strips_code_fence(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    _mock_openai(monkeypatch, '```json\n{"severity":"medium","kind":"knife","warning":"Mind the knife."}\n```')
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r["severity"] == "medium"
    assert r["kind"] == "knife"


def test_assess_hazard_invalid_severity_falls_back_to_none(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    _mock_openai(monkeypatch, '{"severity":"apocalyptic","kind":"x","warning":"y"}')
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r["severity"] == "none"


def test_assess_hazard_network_error_is_silent(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    _mock_openai(monkeypatch, OSError("ECONNREFUSED"))
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r["severity"] == "none"


def test_assess_hazard_non_json_response_is_silent(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    _mock_openai(monkeypatch, "I cannot help with that.")
    r = A.assess_hazard(A.AssessHazardRequest(image_base64=_b64()))
    assert r["severity"] == "none"


def test_assess_hazard_bad_base64_is_silent(A, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    # No urlopen mock — must short-circuit before any HTTP call on a bad image.
    r = A.assess_hazard(A.AssessHazardRequest(image_base64="!!!not base64!!!"))
    assert r["severity"] == "none"
