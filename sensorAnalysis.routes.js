const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { analyzeSensorSession } = require('../controllers/sensorAnalysis.controller');

const router = Router({ mergeParams: true });
router.use(requireHealthWorker);
router.post('/', asyncHandler(analyzeSensorSession));

module.exports = router;
