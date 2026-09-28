const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { createSensorSession, listSessionsForPatient, addReadings, listReadings } = require('../controllers/sensors.controller');

const router = Router({ mergeParams: true });

router.use(requireHealthWorker); // sensor kits are operated by health workers in the field

router.post('/', asyncHandler(createSensorSession));
router.get('/', asyncHandler(listSessionsForPatient));
router.post('/:sessionId/readings', asyncHandler(addReadings));
router.get('/:sessionId/readings', asyncHandler(listReadings));

module.exports = router;
