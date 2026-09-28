const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { createAssessment, listAssessmentsForPatient } = require('../controllers/assessments.controller');

// Mounted at /api/assessments and /api/patients/:patientId/assessments
const router = Router({ mergeParams: true });

router.use(requireHealthWorker); // assessments are recorded/reviewed by health workers, not patient logins

router.post('/', asyncHandler(createAssessment));
router.get('/', asyncHandler(listAssessmentsForPatient)); // requires :patientId param when mounted nested

module.exports = router;
