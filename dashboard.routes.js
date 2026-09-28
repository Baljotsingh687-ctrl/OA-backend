const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireOfficer } = require('../middleware/auth');
const { districtSummary, overallStats, screeningTrend } = require('../controllers/dashboard.controller');

const router = Router();

router.use(requireOfficer); // every dashboard route is officer/admin only

router.get('/summary', asyncHandler(overallStats));
router.get('/by-district', asyncHandler(districtSummary));
router.get('/trend', asyncHandler(screeningTrend));

module.exports = router;
