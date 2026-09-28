const { syncBatchSchema } = require('../utils/validators');
const { processSyncBatch } = require('../services/sync.service');

/**
 * POST /api/sync/batch
 * The frontend's Dexie sync-queue posts here whenever navigator.onLine fires true.
 * Every record carries its client-generated UUID, so this is safe to retry after
 * a dropped connection — records already inserted come back as 'skipped_duplicate'
 * rather than erroring or duplicating.
 */
async function syncBatch(req, res) {
  const batch = syncBatchSchema.parse(req.body);
  const results = await processSyncBatch(req.healthWorker.id, batch);
  res.json({ ok: true, results });
}

module.exports = { syncBatch };
