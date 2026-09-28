const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { listReferrals, updateReferral } = require('../controllers/referrals.controller');

const router = Router();

router.use(requireHealthWorker); // referral triage/updates are done by health workers

router.get('/', asyncHandler(listReferrals));
router.patch('/:id', asyncHandler(updateReferral));

module.exports = router;
