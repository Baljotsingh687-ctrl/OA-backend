const { Router } = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { syncBatch } = require('../controllers/sync.controller');

const router = Router();

router.post('/batch', requireHealthWorker, asyncHandler(syncBatch)); // offline queue is per health worker device

module.exports = router;
