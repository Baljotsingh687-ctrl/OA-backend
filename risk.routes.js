const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { runRiskAssessment, getLatestRiskForPatient } = require('../controllers/risk.controller');

const router = Router({ mergeParams: true });

router.use(requireHealthWorker); // risk scoring is triggered by health workers

router.post('/', asyncHandler(runRiskAssessment));
router.get('/latest', asyncHandler(getLatestRiskForPatient));

module.exports = router;
