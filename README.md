# OA Screening — Backend

Node.js/Express + PostgreSQL backend for the rural osteoarthritis early-screening
project. Works with any plain PostgreSQL database and handles login itself
(email + password, JWT) — no third-party auth or hosted-database service needed.
Your frontend logs in via this API and sends the returned token for everything
else: patients, symptom forms, sensor/gait data, offline sync, risk scoring, and
the district dashboard.

## What this backend handles

- **Login** — register/login for patients, admin-created accounts for health workers.
- **Risk scoring** (KOOS + gait composite) — one scoring formula on the server,
  so it can't drift from what your ML team ships.
- **Idempotent offline sync** — batch-upserting a Dexie queue inside a transaction.
- **Auto-referral creation** on high-risk scores, and the officer dashboard aggregates.

## Two kinds of accounts

Both log in through `POST /api/auth/login` (email + password → JWT), but land as a different role:
- **Health worker** (row in `health_workers`) — can register, browse, and access
  *every* patient's data (not just the ones they personally registered).
- **Patient** (row in `patients`, linked via `patients.auth_user_id`) — can sign
  up (`POST /api/auth/register`) and log in on their own, without a health worker registering them first, and
  can see only their own record.

## 1. Setup

```bash
cd oa-backend
npm install
cp .env.example .env
```

Fill in `.env`:
- `DATABASE_URL` — connection string of any PostgreSQL database (e.g. `postgresql://postgres:password@localhost:5432/oa_screening`). Set `DATABASE_SSL=true` only if your hosted DB requires SSL.
- `JWT_SECRET` — long random string used to sign login tokens. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## 2. Create the schema

```bash
npm run migrate
```

Creates all tables, indexes, and the `v_district_risk_summary` dashboard view.
Safe to re-run (uses `if not exists` / `or replace`).

## 3. Create the first admin

```bash
npm run create-admin -- admin@example.com 'StrongPassword123' 'Admin Name'
```

Log in as this admin, then create other health worker accounts (worker / officer / admin):

```
POST /api/auth/health-workers      (admin token required)
{ "email": "...", "password": "...", "name": "...", "role": "worker",
  "village": "...", "block": "...", "district": "..." }
```

Use `role = 'officer'` for whoever should see the dashboard endpoints.
Patients don't need this — they register themselves (see Auth below).

## 4. Run it

```bash
npm run dev   # nodemon, auto-restart
npm start     # plain node
```

Server starts on `PORT` (default 4000). `GET /health` is an unauthenticated
liveness check.

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | Public. `{ email, password }` — patient creates their own login, gets a token back |
| POST | `/api/auth/login` | Public. `{ email, password }` — returns `{ token, account_type: 'health_worker' \| 'patient' \| 'new', profile }` |
| POST | `/api/auth/health-workers` | Admin only. Creates a health worker login + profile |

Every other `/api/*` route requires:
```
Authorization: Bearer <token from login/register>
```
The backend verifies it locally with `JWT_SECRET`, then looks up whichever profile
matches: a `health_workers` row, or a `patients` row (via `patients.auth_user_id`).

**Patient flow:** `POST /api/auth/register` → `POST /api/patients/me` (creates the
patient profile, first time only) → `GET /api/patients/me` afterwards.

## API Reference

### Patients
| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/patients/me` | **Patient self-login flow.** Fetches the signed-in patient's own profile, or creates it on first login (self-registration — no health worker needs to add them first). |
| POST | `/api/patients` | Health-worker-only. Body includes client-generated `id` (UUID) — safe to retry offline |
| GET | `/api/patients?search=&limit=&offset=` | Health-worker-only. Any worker/officer/admin sees **every** patient, not just ones they registered |
| GET | `/api/patients/:id` | Any health worker, or the patient viewing their own record. Includes nested assessments, sensor sessions, risk history, referrals |

### Symptom assessments (digitized KOOS)
| Method | Path |
|---|---|
| POST | `/api/patients/:patientId/assessments` or `/api/assessments` (body has `patient_id`) |
| GET | `/api/patients/:patientId/assessments` |

### Sensor sessions (IMU or vision/pose)
| Method | Path |
|---|---|
| POST | `/api/patients/:patientId/sensor-sessions` — body can include a nested `gait_features` object if the device/app already computed features |
| GET | `/api/patients/:patientId/sensor-sessions` |
| POST | `/api/sensor-sessions/:sessionId/readings` | Health-worker login. Bulk-store raw samples (see below) |
| GET | `/api/sensor-sessions/:sessionId/readings?sensor_location=&from_ms=&to_ms=&limit=` | Read samples back |
| POST | `/api/device/sensor-sessions/:sessionId/readings` | **Hardware upload.** Same body, but authenticated with header `x-device-key: <DEVICE_API_KEY>` instead of a login |

**Sensor readings body** (max 5000 samples per request; retries are safe, duplicates are skipped):
```json
{
  "sensor_location": "knee_left",
  "readings": [
    { "t_ms": 0,  "ax": 0.02, "ay": -0.98, "az": 0.11, "gx": 1.2, "gy": -0.4, "gz": 0.0 },
    { "t_ms": 10, "ax": 0.03, "ay": -0.97, "az": 0.12, "gx": 1.5, "gy": -0.3, "gz": 0.1, "extra": { "temp_c": 31.2 } }
  ]
}
```
Flow: create the session first (`POST .../sensor-sessions` with `session_type: "imu"` and `device_id`), then
stream readings into it. Data lands in the `sensor_readings` table (`t_ms` = ms since session start).

### Gait video analysis (gait model)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/patients/:patientId/gait-analysis` | Health-worker login. `multipart/form-data` with the walking video in field **`video`** (optional text field `device_id`). Relays it to the gait model service, stores a `vision` sensor session + `gait_features` row, and returns the result. |

Response (`201`):
```json
{
  "sensor_session_id": "…", "gait_features_id": "…", "patient_id": "…",
  "prediction": "KOA", "probability_koa": 0.8123, "gait_risk_score": 81.2,
  "model_version": "gait-video-logreg-v1"
}
```
Errors: `400` no file, `413` too large (`GAIT_MAX_VIDEO_MB`), `415` not a video, `502` model service rejected the video
(e.g. no person detected), `503` model service unreachable or `GAIT_API_URL` unset, `504` timed out.
Then call `POST /api/patients/:patientId/risk-assessment` as usual; it picks up the stored model score automatically.

```bash
curl -X POST "$API/api/patients/$PATIENT_ID/gait-analysis" \
  -H "Authorization: Bearer $TOKEN" -F "video=@walk.mp4"
```

### Sensor model analysis
| Method | Path | Notes |
|---|---|---|
| POST | `/api/patients/:patientId/sensor-analysis` | Health-worker login. Body `{ "sensor_session_id": "<uuid>" }`. Sends that session's stored `sensor_readings` to the sensor model (`SENSOR_API_URL`) and saves the score on the session's `gait_features`; the next risk assessment uses it. Errors: `404` session not found, `422` no readings, `502/503/504` model service problems (the `detail` field carries the upstream message). |

### Risk assessment
| Method | Path | Notes |
|---|---|---|
| POST | `/api/patients/:patientId/risk-assessment` | Body optionally pins `symptom_assessment_id` / `sensor_session_id`; defaults to the patient's latest of each. Auto-creates a referral if tier = `high`. |
| GET | `/api/patients/:patientId/risk-assessment/latest` | |

### Referrals
| Method | Path |
|---|---|
| GET | `/api/referrals?status=&district=` |
| PATCH | `/api/referrals/:id` — body `{ status, notes }` |

### Offline sync (Dexie queue → server)
| Method | Path |
|---|---|
| POST | `/api/sync/batch` | Body: `{ patients: [...], symptom_assessments: [...], sensor_sessions: [...] }`, each record keyed by its client-generated UUID. Returns per-record `inserted` / `skipped_duplicate` status so the app can mark them `synced: true` in IndexedDB. |

### Dashboard (officer/admin role only)
| Method | Path |
|---|---|
| GET | `/api/dashboard/summary` | Overall counts: patients, risk tiers, referrals |
| GET | `/api/dashboard/by-district` | Per district/block breakdown |
| GET | `/api/dashboard/trend` | Patients screened per day, last 30 days |

## Risk scoring engine (`src/services/riskEngine.service.js`)

- **Symptom score**: normalizes the five KOOS subscales (pain, symptoms, ADL,
  sport/recreation, quality of life) into a single 0-100 score. KOOS itself scores
  100 = best knee health, so each subscale is inverted first; there's no single
  official KOOS composite, so the five are currently averaged equally (adjust the
  weights in `riskEngine.service.js` if your clinical team wants a different mix).
- **Gait score**: if the patient's latest gait session came from the video model
  (`gait_features.extra.model_gait_risk_score`, set by `POST .../gait-analysis`), that
  score is used (`model_version = gait-video-logreg-v1`). Otherwise, if `ML_MODEL_ENDPOINT` is set, POSTs `{ features }` there and
  expects `{ gait_risk_score: 0-100 }` back — plug your team's trained
  XGBoost/Random Forest/CNN model behind any small HTTP service (FastAPI/Flask
  work well) and point this at it. If unset, or the call fails/times out, it
  falls back to a transparent rule-based score from stride-time variability,
  knee ROM, cadence asymmetry, and stance-time ratio — so a flaky model
  endpoint in the field never blocks screening.
- **Composite**: 50/50 blend of symptom + gait score when both exist; falls
  back to whichever one is available if only sensor or only symptom data was
  collected.
- **Tiers**: 0-32 low, 33-65 moderate, 66-100 high. High auto-opens a referral.

This is explicitly a **screening/triage** tool — recommendations are phrased
as "refer" / "monitor", never as a diagnosis.

## Notes for your ML teammates

**Gait video model.** Deploy `github.com/aatsanjam-kaur/gait-api` as its own Python service
(`pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000`, run from the repo
folder so it finds `pose_landmarker.task`, `logistic_regression.joblib` and `feature_columns.json`), then set
`GAIT_API_URL` in this backend's `.env`. Keep that service private/behind this backend: it has no authentication of its own.

**Generic features-based model (optional).**

Point `ML_MODEL_ENDPOINT` at a small service (any framework) that accepts:
```json
{ "features": { "stride_time_variability": 4.2, "knee_rom_deg": 118, "cadence_asymmetry": 0.15, "stance_time_ratio": 0.58 } }
```
and returns:
```json
{ "gait_risk_score": 72.5 }
```
Nothing else in the backend needs to change when you swap in a real trained model.

## Notes for your hardware/frontend teammates

- Sensor payloads (`raw_data` on `sensor_sessions`) accept arbitrary JSON — send
  raw IMU streams or pose-landmark arrays as-is; keep large captures in
  `storage_url` (e.g. an S3 bucket or local file storage) instead of inline JSON if they
  get big, to stay under the 5MB request body limit.
- Every POST endpoint expects a **client-generated UUID** as `id` — generate it
  with `crypto.randomUUID()` in the browser when the record is first created
  offline, and reuse the same id if you retry the sync. That's what makes
  `/api/sync/batch` safe to call repeatedly on flaky connections.
