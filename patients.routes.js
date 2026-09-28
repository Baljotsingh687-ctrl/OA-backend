const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const {
  createPatient,
  listPatients,
  getPatient,
  getOrCreateOwnProfile,
} = require('../controllers/patients.controller');

const router = Router();

// Patient self-login flow: fetch-or-create the patient's own profile.
// Must come before '/:id' so 'me' is never treated as a patient id.
router.get('/me', asyncHandler(getOrCreateOwnProfile));
router.post('/me', asyncHandler(getOrCreateOwnProfile));

// Health-worker flow: register / browse patients. Any worker/officer/admin can see everyone.
router.post('/', requireHealthWorker, asyncHandler(createPatient));
router.get('/', requireHealthWorker, asyncHandler(listPatients));

// A single patient record — any health worker, or the patient viewing their own.
router.get('/:id', asyncHandler(getPatient));

module.exports = router;
