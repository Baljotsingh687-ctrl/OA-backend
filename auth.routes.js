const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { register, login, createHealthWorker } = require('../controllers/auth.controller');

const router = Router();

// Public
router.post('/register', asyncHandler(register)); // patient self sign-up
router.post('/login', asyncHandler(login));       // health workers + patients

// Admin only: create health worker accounts
router.post('/health-workers', requireAuth, requireAdmin, asyncHandler(createHealthWorker));

module.exports = router;
