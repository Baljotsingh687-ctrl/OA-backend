-- ============================================================
-- Osteoarthritis Early Screening System — Database Schema
-- Target: plain PostgreSQL (no Supabase dependency).
-- Authentication is handled by this backend itself (email + password, JWT).
-- ============================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- 0. Users (login accounts for both health workers and patients)
-- ------------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null, -- bcrypt hash, never the raw password
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 1. Health workers (ASHA/ANM staff + district officers)
-- ------------------------------------------------------------
create table if not exists health_workers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references users(id) on delete cascade, -- login account link
  name text not null,
  phone text unique,
  role text not null default 'worker' check (role in ('worker', 'officer', 'admin')),
  village text,
  block text,
  district text,
  language_pref text default 'en', -- en, as, bn, ne, kha, mni, lus, brx...
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. Patients
-- Note: id is TEXT (client-generated UUID from the app, offline-safe)
-- rather than server-generated, so retries never create duplicates.
--
-- A patient row can come from either flow:
--   - a health worker registers them in the field (health_worker_id set, auth_user_id null
--     until/unless the patient later signs up and gets linked), or
--   - the patient signs up and logs in themselves via the backend's own auth (auth_user_id set,
--     health_worker_id null since no worker registered them).
-- ------------------------------------------------------------
create table if not exists patients (
  id uuid primary key, -- generated client-side (crypto.randomUUID())
  auth_user_id uuid unique references users(id) on delete set null, -- set when the patient has their own login
  health_worker_id uuid references health_workers(id), -- worker who registered them, if any
  local_id text, -- optional Aadhaar-linked or camp-local ID
  name text not null,
  age int check (age > 0 and age < 130),
  gender text check (gender in ('male', 'female', 'other')),
  phone text,
  village text,
  block text,
  district text,
  created_at timestamptz not null default now(),
  device_created_at timestamptz, -- when it was actually created offline, on the device
  synced_at timestamptz
);

create index if not exists idx_patients_health_worker on patients(health_worker_id);
create index if not exists idx_patients_district on patients(district);
create index if not exists idx_patients_auth_user on patients(auth_user_id);

-- ------------------------------------------------------------
-- 3. Symptom assessments (digitized KOOS questionnaire)
-- KOOS = Knee injury and Osteoarthritis Outcome Score. Each subscale below stores
-- the raw sum of its items (every item scored 0-4), per the official KOOS scoring manual:
--   pain 0-36 (9 items), symptoms 0-28 (7 items), adl 0-68 (17 items),
--   sport/rec 0-20 (5 items), qol 0-16 (4 items).
-- ------------------------------------------------------------
create table if not exists symptom_assessments (
  id uuid primary key,
  patient_id uuid not null references patients(id) on delete cascade,
  pain_scale int check (pain_scale between 0 and 10),
  stiffness_duration_min int,
  swelling boolean default false,
  family_history boolean default false,
  joints_affected text[], -- e.g. {'knee_left','hip_right'}
  koos_pain_score numeric check (koos_pain_score between 0 and 36),
  koos_symptoms_score numeric check (koos_symptoms_score between 0 and 28),
  koos_adl_score numeric check (koos_adl_score between 0 and 68),
  koos_sport_score numeric check (koos_sport_score between 0 and 20),
  koos_qol_score numeric check (koos_qol_score between 0 and 16),
  raw_answers jsonb,              -- full questionnaire payload, for audit/re-scoring
  created_at timestamptz not null default now(),
  device_created_at timestamptz,
  synced_at timestamptz
);

create index if not exists idx_symptoms_patient on symptom_assessments(patient_id);

-- ------------------------------------------------------------
-- 4. Sensor sessions (IMU strap-on kit OR phone-camera pose video)
-- ------------------------------------------------------------
create table if not exists sensor_sessions (
  id uuid primary key,
  patient_id uuid not null references patients(id) on delete cascade,
  session_type text not null check (session_type in ('imu', 'vision')),
  device_id text, -- ESP32 MAC / phone identifier
  started_at timestamptz,
  ended_at timestamptz,
  raw_data jsonb, -- raw IMU stream or pose-landmark stream (small sessions);
                  -- for large captures store a storage_url instead
  storage_url text,
  created_at timestamptz not null default now(),
  synced_at timestamptz
);

create index if not exists idx_sensor_sessions_patient on sensor_sessions(patient_id);

-- ------------------------------------------------------------
-- 4b. Sensor readings (the actual time-series samples streamed by the hardware)
-- One row per sample. A session (sensor_sessions) is the "recording";
-- readings are the data points inside it. Several IMUs on one strap are told
-- apart by sensor_location (e.g. 'knee_left', 'thigh_right').
-- ------------------------------------------------------------
create table if not exists sensor_readings (
  id bigint generated always as identity primary key,
  sensor_session_id uuid not null references sensor_sessions(id) on delete cascade,
  sensor_location text not null default 'default',
  t_ms int not null check (t_ms >= 0),  -- milliseconds since the session started
  ax real, ay real, az real,            -- accelerometer (g or m/s^2, keep consistent)
  gx real, gy real, gz real,            -- gyroscope (deg/s)
  mx real, my real, mz real,            -- magnetometer (optional)
  knee_angle_deg real,                  -- optional, if the firmware already computes it
  extra jsonb,                          -- any other channel: temperature, flex sensor, battery...
  created_at timestamptz not null default now(),
  -- a retried upload from the ESP32 can never create duplicate samples
  unique (sensor_session_id, sensor_location, t_ms)
);

create index if not exists idx_sensor_readings_session on sensor_readings(sensor_session_id, t_ms);

-- ------------------------------------------------------------
-- 5. Gait features (engineered from a sensor session, feeds the model)
-- ------------------------------------------------------------
create table if not exists gait_features (
  id uuid primary key,
  sensor_session_id uuid not null references sensor_sessions(id) on delete cascade,
  stride_time_variability numeric,
  knee_rom_deg numeric,       -- range of motion, degrees
  cadence_asymmetry numeric,  -- 0-1, left/right imbalance
  stance_time_ratio numeric,
  extra jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. Risk assessments (the composite output of the scoring engine)
-- ------------------------------------------------------------
create table if not exists risk_assessments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  symptom_assessment_id uuid references symptom_assessments(id),
  sensor_session_id uuid references sensor_sessions(id),
  symptom_score numeric,     -- 0-100, normalized KOOS composite (higher = more symptom burden)
  gait_score numeric,        -- 0-100, from gait_features (nullable if no sensor data)
  composite_score numeric not null,  -- 0-100, final blended score
  risk_tier text not null check (risk_tier in ('low', 'moderate', 'high')),
  recommendation text not null, -- e.g. "Monitor / lifestyle advice" or "Refer to orthopaedician"
  model_version text default 'rule-based-v1',
  created_at timestamptz not null default now()
);

create index if not exists idx_risk_patient on risk_assessments(patient_id);
create index if not exists idx_risk_tier on risk_assessments(risk_tier);

-- ------------------------------------------------------------
-- 7. Referrals (tracking what happens after a High/Moderate flag)
-- ------------------------------------------------------------
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  risk_assessment_id uuid references risk_assessments(id),
  referred_to text, -- facility/doctor name
  status text not null default 'pending' check (status in ('pending', 'completed', 'declined', 'no_show')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_referrals_patient on referrals(patient_id);
create index if not exists idx_referrals_status on referrals(status);

-- ------------------------------------------------------------
-- 8. Sync log (audit trail for the offline-first sync queue)
-- ------------------------------------------------------------
create table if not exists sync_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id uuid not null,
  health_worker_id uuid references health_workers(id),
  device_id text,
  status text not null check (status in ('inserted', 'updated', 'skipped_duplicate', 'error')),
  error_message text,
  synced_at timestamptz not null default now()
);

-- ============================================================
-- 9. X-ray analyses (result of the hosted X-ray model for a patient's knee X-ray)
-- ============================================================
create table if not exists xray_analyses (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  prediction text,
  xray_score numeric,        -- 0-100, higher = more likely OA
  model_version text,
  raw_response jsonb,
  filename text,
  created_at timestamptz not null default now()
);
create index if not exists idx_xray_patient on xray_analyses(patient_id);

-- risk_assessments gets an X-ray component (nullable: most patients won't have an X-ray)
alter table risk_assessments add column if not exists xray_score numeric;

-- ============================================================
-- Access control
-- Enforced in the Express API (src/middleware/auth.js + controllers):
--   * any health worker (worker/officer/admin) can access every patient's data
--   * a patient login can only access their own record
-- ============================================================

-- ============================================================
-- Dashboard view (officer-facing aggregates)
-- ============================================================
create or replace view v_district_risk_summary as
select
  p.district,
  p.block,
  count(distinct p.id) as total_patients,
  count(*) filter (where r.risk_tier = 'low') as low_count,
  count(*) filter (where r.risk_tier = 'moderate') as moderate_count,
  count(*) filter (where r.risk_tier = 'high') as high_count,
  count(distinct ref.id) filter (where ref.status = 'pending') as pending_referrals,
  count(distinct ref.id) filter (where ref.status = 'completed') as completed_referrals
from patients p
left join risk_assessments r on r.patient_id = p.id
left join referrals ref on ref.patient_id = p.id
group by p.district, p.block;
