# DeepFace microservice (Cocktail Party Mode, #627)

A FastAPI face-recognition service powered by
[deepinsight/insightface](https://github.com/deepinsight/insightface) using
SCRFD detection and ArcFace embeddings (`buffalo_l`). Despite the directory name,
this service does not use the Python `deepface` wrapper.

Current responsibility:

- detect and quality-gate face crops,
- compute L2-normalized embeddings,
- match embeddings with cosine similarity,
- persist the current server-side person database,
- persist enrolled face crops for thumbnails,
- store the current `name`, `facts`, and `recaps` fields for each person profile.

This means the service is stateful today. The planned identity refactor will split
person facts/profile lifecycle out of this service so face recognition becomes a
signal provider instead of the source of truth for person memory.

## Run

```bash
cd services/deepface
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
PORT=8099 python app.py
# first model load downloads InsightFace weights; subsequent calls are fast
```

Point the gateway at it:

```bash
export DEEPFACE_URL=http://127.0.0.1:8099   # gateway reads this; defaults to the same
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | - | `{ ok, engine, model, count, match_threshold, min_det_score }` |
| POST | `/identify` | `{ image_base64 }` | `{ ok, found, person?, similarity?, best_similarity?, reason? }` |
| POST | `/enroll` | `{ image_base64, name?, person_id? }` | `{ ok, person }` |
| POST | `/people` | `{}` | `{ ok, people }` |
| POST | `/update` | `{ person_id, name?, facts?, recap? }` | `{ ok, person }` |
| POST | `/clear` | `{}` | `{ ok, removed }` |
| POST | `/assess_hazard` | `{ image_base64 }` | `{ ok, severity, kind, warning }` |

Notes:

- `image_base64` accepts JPEG/PNG bytes; data-URL prefixes are tolerated.
- `/identify` returns cosine `similarity`, not distance.
- `/identify` updates `last_seen_at` and may append a bounded extra embedding to
  an existing profile for angle/lighting robustness.
- `/enroll` rejects low-quality crops and deduplicates against existing profiles
  before creating a new one.
- `/update` stores facts as bare strings today and appends recaps as
  `{ summary, at }`.

## Storage

Default DB root is `DEEPFACE_DB=./facedb`:

```text
facedb/
  profiles.json                 # id, name, embeddings, facts, recaps, timestamps
  <person_id>/<crop_uuid>.jpg    # enrolled crops used for thumbnails
```

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `DEEPFACE_DB` | `./facedb` | persistent profile/crop store |
| `INSIGHTFACE_MODEL` | `buffalo_l` | InsightFace model pack |
| `FACE_MATCH_THRESHOLD` | `0.35` | cosine similarity threshold |
| `FACE_MIN_DET_SCORE` | `0.50` | detector confidence quality gate |
| `FACE_MIN_PX` | `50` | min face bbox width in px |
| `FACE_MAX_POSE_DEG` | `50` | max abs yaw/pitch/roll in degrees |
| `HOST` / `PORT` | `127.0.0.1` / `8099` | bind address |

## Test

```bash
# from repo root; InsightFace + cv2 are mocked, so no weights/GPU needed
pytest services/deepface/test_app.py -q
```

## Privacy

The current service persists face crops, embeddings, profile names, facts, recaps,
and timestamps under `DEEPFACE_DB`. Do not treat this as transient-only storage.
Run it in a trusted local environment, and clear it with `/clear` when testing
with disposable data.
