const { z } = require('zod');

const uuid = z.string().uuid();

const credentialsSchema = z.object({
  email: z.string().email().transform((e) => e.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const healthWorkerCreateSchema = credentialsSchema.extend({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  role: z.enum(['worker', 'officer', 'admin']).default('worker'),
  village: z.string().optional().nullable(),
  block: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  language_pref: z.string().optional().nullable(),
});

const patientSchema = z.object({
  id: uuid, // client-generated, so retries are idempotent
  local_id: z.string().optional().nullable(),
  name: z.string().min(1),
  age: z.number().int().positive().optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  phone: z.string().optional().nullable(),
  village: z.string().optional().nullable(),
  block: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  device_created_at: z.string().datetime().optional().nullable(),
});

// KOOS (Knee injury and Osteoarthritis Outcome Score) subscales — each stored as the
// raw sum of its items (every item scored 0-4), matching the official KOOS scoring manual.
const symptomAssessmentSchema = z.object({
  id: uuid,
  patient_id: uuid,
  pain_scale: z.number().int().min(0).max(10).optional().nullable(),
  stiffness_duration_min: z.number().int().min(0).optional().nullable(),
  swelling: z.boolean().optional(),
  family_history: z.boolean().optional(),
  joints_affected: z.array(z.string()).optional(),
  koos_pain_score: z.number().min(0).max(36),        // Pain — 9 items
  koos_symptoms_score: z.number().min(0).max(28),     // Symptoms/stiffness — 7 items
  koos_adl_score: z.number().min(0).max(68),          // Function in daily living — 17 items
  koos_sport_score: z.number().min(0).max(20),        // Function in sport/recreation — 5 items
  koos_qol_score: z.number().min(0).max(16),          // Quality of life — 4 items
  raw_answers: z.record(z.any()).optional(),
  device_created_at: z.string().datetime().optional().nullable(),
});

const sensorSessionSchema = z.object({
  id: uuid,
  patient_id: uuid,
  session_type: z.enum(['imu', 'vision']),
  device_id: z.string().optional().nullable(),
  started_at: z.string().datetime().optional().nullable(),
  ended_at: z.string().datetime().optional().nullable(),
  raw_data: z.any().optional(),
  storage_url: z.string().url().optional().nullable(),
  gait_features: z
    .object({
      stride_time_variability: z.number().optional(),
      knee_rom_deg: z.number().optional(),
      cadence_asymmetry: z.number().optional(),
      stance_time_ratio: z.number().optional(),
      extra: z.record(z.any()).optional(),
    })
    .optional(),
});

const num = z.number().finite().optional().nullable();

const sensorReadingSchema = z.object({
  t_ms: z.number().int().min(0),
  sensor_location: z.string().min(1).max(50).optional(),
  ax: num, ay: num, az: num,
  gx: num, gy: num, gz: num,
  mx: num, my: num, mz: num,
  knee_angle_deg: num,
  extra: z.record(z.any()).optional().nullable(),
});

// One upload from the hardware = one batch of samples for a session
const sensorReadingsBatchSchema = z.object({
  sensor_location: z.string().min(1).max(50).optional(), // default for every reading in the batch
  readings: z.array(sensorReadingSchema).min(1).max(5000),
});

const referralUpdateSchema = z.object({
  status: z.enum(['pending', 'completed', 'declined', 'no_show']),
  notes: z.string().optional().nullable(),
});

/** Batch sync payload: arrays of records per table, each idempotent on client-generated id. */
const syncBatchSchema = z.object({
  patients: z.array(patientSchema).optional().default([]),
  symptom_assessments: z.array(symptomAssessmentSchema).optional().default([]),
  sensor_sessions: z.array(sensorSessionSchema).optional().default([]),
});

module.exports = {
  credentialsSchema,
  healthWorkerCreateSchema,
  patientSchema,
  symptomAssessmentSchema,
  sensorSessionSchema,
  sensorReadingsBatchSchema,
  referralUpdateSchema,
  syncBatchSchema,
};
