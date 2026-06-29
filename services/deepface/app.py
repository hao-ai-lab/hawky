"""
Face-recognition microservice for Cocktail Party Mode (hawky #627).

Engine: InsightFace (deepinsight/insightface) — SCRFD detector + ArcFace
(buffalo_l). Chosen over the DeepFace wrapper because it (a) separates real faces
far better on hard live-camera frames (verified: same-person cosine ~0.65 vs
different ~0.10, a wide margin) and (b) exposes per-face QUALITY signals
(det_score, bbox size, pitch/yaw) so we can reject looking-away/tiny/blurry crops before
they pollute the DB. The service owns matching + the person DB; iOS sends a face
crop and gets back an identity, enrolls new people, and updates profiles.

Pipeline per request:
  detect faces → pick the highest-confidence face → QUALITY GATE (det_score,
  size, pose) → L2-normalized 512-d embedding → cosine match over stored
  embeddings. A profile holds MULTIPLE embeddings (every confirmed match adds its
  frame), so a person becomes robust to angle/lighting over time.

DB layout (DEEPFACE_DB, default services/deepface/facedb):
  facedb/<person_id>/<uuid>.jpg   enrolled crops (for thumbnails)
  facedb/profiles.json            { id, name, embeddings[[float]], facts, recaps, ... }

Endpoints: GET /health · POST /identify · /enroll · /people · /update · /clear ·
/assess_hazard (Safety Check #648: silent vision hazard classifier, off-model)
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("DEEPFACE_DB", os.path.join(os.path.dirname(__file__), "facedb"))
PROFILES_FILE = os.path.join(DB_PATH, "profiles.json")
MODEL_PACK = os.environ.get("INSIGHTFACE_MODEL", "buffalo_l")

# Cosine threshold: >= is a match. InsightFace/ArcFace separates same vs different
# widely (same ~0.65, diff ~0.10 on the #627 set), so 0.35 is safely between.
MATCH_THRESHOLD = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.35"))
# Quality gate — reject crops that would produce a garbage embedding (the cause of
# the duplicate "Unknown" profiles): low detector confidence, tiny face, or extreme
# pose (sideways / looking away). Tuned for LIVE camera frames (the
# client now sends the full frame, so InsightFace detects with full context): a
# too-strict gate left the DB empty. Override via env to retune from real testing.
MIN_DET_SCORE = float(os.environ.get("FACE_MIN_DET_SCORE", "0.50"))
MIN_FACE_PX = int(os.environ.get("FACE_MIN_PX", "50"))          # min bbox width in px
MAX_POSE_DEG = float(os.environ.get("FACE_MAX_POSE_DEG", "50")) # max |yaw|/|pitch|

_lock = threading.Lock()
_app = None  # lazy InsightFace FaceAnalysis
app = FastAPI(title="hawky-face", version="3.0.0")


# -----------------------------------------------------------------------------
# Engine
# -----------------------------------------------------------------------------
def _engine():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis

        a = FaceAnalysis(name=MODEL_PACK, providers=["CPUExecutionProvider"])
        a.prepare(ctx_id=-1, det_size=(640, 640))
        _app = a
    return _app


class FaceQuality:
    """Why a face was accepted/rejected by the quality gate."""

    def __init__(self, ok: bool, reason: str = ""):
        self.ok = ok
        self.reason = reason


def _passes_quality(face) -> FaceQuality:
    if face.det_score < MIN_DET_SCORE:
        return FaceQuality(False, f"low confidence ({face.det_score:.2f})")
    w = float(face.bbox[2] - face.bbox[0])
    if w < MIN_FACE_PX:
        return FaceQuality(False, f"face too small ({int(w)}px)")
    # InsightFace pose is [pitch, yaw, roll]. Only PITCH (up/down) and YAW (left/
    # right) indicate the person is looking away — gate on those. ROLL (in-plane
    # tilt) does NOT hurt recognition: ArcFace aligns faces by the eyes, and a
    # rotated phone frame (front camera delivers ~90° roll) is fully recognizable.
    # Gating on roll wrongly rejected every upright phone frame (roll ≈ ±90°).
    if face.pose is not None:
        pitch, yaw = float(abs(face.pose[0])), float(abs(face.pose[1]))
        if max(pitch, yaw) > MAX_POSE_DEG:
            return FaceQuality(False, f"looking away (pitch {pitch:.0f}, yaw {yaw:.0f})")
    return FaceQuality(True)


def _best_face(img):
    """Return (face, quality) for the highest-confidence face, or (None, reason).
    Picks by det_score (NOT bbox size — a large mis-detection scores low)."""
    faces = _engine().get(img)
    if not faces:
        return None, FaceQuality(False, "no face detected")
    face = max(faces, key=lambda f: f.det_score)
    return face, _passes_quality(face)


def _embedding(img) -> tuple[list[float] | None, str]:
    """Quality-gated embedding for the best face. Returns (embedding|None, reason)."""
    h, w = (img.shape[0], img.shape[1]) if hasattr(img, "shape") else (0, 0)
    faces = _engine().get(img)
    if not faces:
        print(f"[face] REJECT no-face | frame={w}x{h} faces=0", flush=True)
        return None, "no face detected"
    face = max(faces, key=lambda f: f.det_score)
    q = _passes_quality(face)
    fw = int(face.bbox[2] - face.bbox[0])
    pose = np.round(face.pose, 0).tolist() if face.pose is not None else None
    if not q.ok:
        print(f"[face] REJECT {q.reason} | frame={w}x{h} faces={len(faces)} best_score={face.det_score:.2f} face_w={fw} pose={pose}", flush=True)
        return None, q.reason
    print(f"[face] OK | frame={w}x{h} faces={len(faces)} score={face.det_score:.2f} face_w={fw} pose={pose}", flush=True)
    return np.asarray(face.normed_embedding, dtype=np.float32).tolist(), ""


def _cosine(a: list[float], b: list[float]) -> float:
    va, vb = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    if va.shape != vb.shape or va.size == 0:
        return -1.0
    return float(np.dot(va, vb))  # normed_embedding is already unit length


# -----------------------------------------------------------------------------
# Profile store
# -----------------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict[str, dict[str, Any]]:
    try:
        with open(PROFILES_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(profiles: dict[str, dict[str, Any]]) -> None:
    os.makedirs(DB_PATH, exist_ok=True)
    tmp = PROFILES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(profiles, f, indent=2)
    os.replace(tmp, PROFILES_FILE)


def _decode(image_base64: str):
    if "," in image_base64 and image_base64.strip().lower().startswith("data:"):
        image_base64 = image_base64.split(",", 1)[1]
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"invalid base64: {exc}") from exc
    import cv2

    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image bytes")
    return img


def _thumbnail_b64(person_id: str) -> str | None:
    person_dir = os.path.join(DB_PATH, person_id)
    try:
        crops = sorted(f for f in os.listdir(person_dir) if f.endswith(".jpg"))
    except FileNotFoundError:
        return None
    if not crops:
        return None
    import cv2

    img = cv2.imread(os.path.join(person_dir, crops[0]))
    if img is None:
        return None
    h, w = img.shape[:2]
    scale = 160.0 / max(h, w, 1)
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def _public(p: dict[str, Any], include_thumbnail: bool = False) -> dict[str, Any]:
    out = {k: v for k, v in p.items() if k != "embeddings"}
    if include_thumbnail:
        out["thumbnail"] = _thumbnail_b64(p.get("id", ""))
    return out


# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------
class IdentifyRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 JPEG/PNG of a face crop or frame")


class EnrollRequest(BaseModel):
    image_base64: str
    name: str = "Unknown"
    person_id: str | None = Field(None, description="Add a crop to this identity; omit to create one")


class UpdateRequest(BaseModel):
    person_id: str
    name: str | None = None
    facts: list[str] | None = None
    recap: str | None = None


# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, Any]:
    with _lock:
        count = len(_load())
    return {"ok": True, "engine": "insightface", "model": MODEL_PACK, "count": count,
            "match_threshold": MATCH_THRESHOLD, "min_det_score": MIN_DET_SCORE}


@app.post("/identify")
def identify(req: IdentifyRequest) -> dict[str, Any]:
    try:
        img = _decode(req.image_base64)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    with _lock:
        profiles = _load()
        if not profiles:
            return {"ok": True, "found": False, "reason": "empty database"}
        try:
            query, reason = _embedding(img)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}
        if query is None:
            # Quality gate rejected the face — tell the client why (not a "no match").
            return {"ok": True, "found": False, "reason": reason}

        best_id, best_sim = None, -1.0
        for pid, p in profiles.items():
            for emb in p.get("embeddings", []):
                s = _cosine(query, emb)
                if s > best_sim:
                    best_sim, best_id = s, pid
        if best_id is None or best_sim < MATCH_THRESHOLD:
            return {"ok": True, "found": False, "best_similarity": max(best_sim, 0.0)}

        # Confirmed match: add this embedding so the profile covers more angles
        # (bounded to avoid unbounded growth).
        p = profiles[best_id]
        embs = p.setdefault("embeddings", [])
        if len(embs) < 12:
            embs.append(query)
        p["last_seen_at"] = _now()
        _save(profiles)
        return {"ok": True, "found": True, "person": _public(p), "similarity": best_sim}


@app.post("/enroll")
def enroll(req: EnrollRequest) -> dict[str, Any]:
    try:
        img = _decode(req.image_base64)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    import cv2

    with _lock:
        profiles = _load()
        try:
            emb, reason = _embedding(img)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}
        if emb is None:
            # Refuse to enroll a low-quality crop — this is what created junk profiles.
            return {"ok": False, "error": f"face not clear enough to enroll: {reason}"}

        # If no person_id given, guard against a duplicate: if this face already
        # matches an existing person, attach to them instead of making a new profile.
        person_id = req.person_id
        if person_id is None:
            best_id, best_sim = None, -1.0
            for pid, p in profiles.items():
                for e in p.get("embeddings", []):
                    s = _cosine(emb, e)
                    if s > best_sim:
                        best_sim, best_id = s, pid
            if best_id is not None and best_sim >= MATCH_THRESHOLD:
                person_id = best_id

        person_id = person_id or uuid.uuid4().hex
        person_dir = os.path.join(DB_PATH, person_id)
        os.makedirs(person_dir, exist_ok=True)
        cv2.imwrite(os.path.join(person_dir, f"{uuid.uuid4().hex}.jpg"), img)

        if person_id not in profiles:
            profiles[person_id] = {
                "id": person_id, "name": req.name, "embeddings": [emb],
                "facts": [], "recaps": [], "created_at": _now(), "last_seen_at": _now(),
            }
        else:
            profiles[person_id].setdefault("embeddings", [])
            if len(profiles[person_id]["embeddings"]) < 12:
                profiles[person_id]["embeddings"].append(emb)
            profiles[person_id]["last_seen_at"] = _now()
            if req.name and req.name != "Unknown":
                profiles[person_id]["name"] = req.name
        _save(profiles)
        return {"ok": True, "person": _public(profiles[person_id])}


@app.post("/people")
def people() -> dict[str, Any]:
    with _lock:
        return {"ok": True, "people": [_public(p, include_thumbnail=True) for p in _load().values()]}


@app.post("/clear")
def clear() -> dict[str, Any]:
    """Wipe the entire person database (profiles + enrolled crop dirs). Used by the
    People Database tab's Clear button."""
    import shutil

    with _lock:
        removed = len(_load())
        try:
            if os.path.isdir(DB_PATH):
                shutil.rmtree(DB_PATH)
            os.makedirs(DB_PATH, exist_ok=True)
        except OSError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "removed": removed}


@app.post("/update")
def update(req: UpdateRequest) -> dict[str, Any]:
    with _lock:
        profiles = _load()
        p = profiles.get(req.person_id)
        if p is None:
            return {"ok": False, "error": "unknown person_id"}
        if req.name:
            p["name"] = req.name
        if req.facts:
            for f in req.facts:
                if f not in p["facts"]:
                    p["facts"].append(f)
        if req.recap:
            p.setdefault("recaps", []).append({"summary": req.recap, "at": _now()})
        p["last_seen_at"] = _now()
        _save(profiles)
        return {"ok": True, "person": _public(p)}


# -----------------------------------------------------------------------------
# Safety Check (#648): /assess_hazard
#
# A SILENT vision hazard classifier that runs OFF the realtime model. iOS samples
# camera frames and posts them here; we ask a vision LLM (OpenAI) whether the frame
# shows a real, present danger and return {severity, kind, warning}. This is a
# separate pipeline from face recognition — it does not touch InsightFace or the
# person DB. Degrades to severity:"none" on any error (no key, no network, bad
# image) so a missing classifier just means "no warning", never a crash.
# -----------------------------------------------------------------------------
HAZARD_MODEL = os.environ.get("SAFETY_VISION_MODEL", "gpt-4o-mini")
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
_VALID_SEVERITY = {"none", "low", "medium", "high"}

_HAZARD_PROMPT = (
    "You are a vigilant home-safety monitor watching a live camera frame. Decide if "
    "the frame shows a REAL, PRESENT physical danger to a person right now — for "
    "example: an unattended stove flame or fire, a gas leak/burner left on, a knife or "
    "sharp blade used unsafely, a pot about to boil over or tip, a child near a hot "
    "surface, smoke, or someone about to be hurt. Ordinary safe activity is NOT a "
    "hazard. Be conservative: only flag medium/high when you are confident, and use "
    "'none' for normal scenes. Respond with ONLY a compact JSON object: "
    '{"severity":"none|low|medium|high","kind":"<short slug e.g. fire|gas|knife|burn|fall>",'
    '"warning":"<the alert, empty if none>"}. '
    "The warning MUST be ONE short spoken sentence, under 12 words, stating the danger "
    "plainly (e.g. \"Careful — the stove is on and the pan is hot.\"). No preamble, no "
    "extra advice, no follow-up tips."
)


class AssessHazardRequest(BaseModel):
    image_base64: str


def _hazard_none() -> dict[str, Any]:
    return {"ok": True, "severity": "none", "kind": "", "warning": ""}


@app.post("/assess_hazard")
def assess_hazard(req: AssessHazardRequest) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        # No key → silent no-op (the pipeline treats this as "no hazard").
        print("[assess_hazard] SKIP: no OPENAI_API_KEY", flush=True)
        return _hazard_none()

    # Validate the image is decodable; pass the raw base64 straight to the VLM.
    image = req.image_base64.strip()
    if "," in image and image.lower().startswith("data:"):
        image = image.split(",", 1)[1]
    try:
        base64.b64decode(image, validate=True)
    except (binascii.Error, ValueError):
        print("[assess_hazard] SKIP: bad base64", flush=True)
        return _hazard_none()

    import urllib.error
    import urllib.request

    payload = {
        "model": HAZARD_MODEL,
        "temperature": 0,
        "max_tokens": 120,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _HAZARD_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image}", "detail": "low"},
                    },
                ],
            }
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{OPENAI_BASE}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        print(f"[assess_hazard] OpenAI HTTP {exc.code}: {detail}", flush=True)
        return _hazard_none()
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        print(f"[assess_hazard] OpenAI call failed: {exc}", flush=True)
        return _hazard_none()

    try:
        content = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError):
        print(f"[assess_hazard] unexpected response shape: {str(data)[:300]}", flush=True)
        return _hazard_none()

    # The model may wrap JSON in a ```json fence; extract the first {...} blob.
    start, end = content.find("{"), content.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return _hazard_none()
    try:
        parsed = json.loads(content[start : end + 1])
    except ValueError:
        return _hazard_none()

    severity = str(parsed.get("severity", "none")).strip().lower()
    if severity not in _VALID_SEVERITY:
        severity = "none"
    kind = str(parsed.get("kind", "")).strip()
    warning = str(parsed.get("warning", "")).strip()
    # Observability (#648): log every verdict so we can see WHY a session shows no
    # warnings (classifier said none vs gated downstream). Cheap; one line per frame.
    print(f"[assess_hazard] severity={severity} kind={kind!r} warning={warning!r}", flush=True)
    if severity == "none":
        return _hazard_none()
    return {"ok": True, "severity": severity, "kind": kind, "warning": warning}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8099")))
