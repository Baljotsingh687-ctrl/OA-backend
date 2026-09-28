const { Router } = require('express');
const multer = require('multer');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { analyzeXray, listXrayAnalyses } = require('../controllers/xray.controller');

const router = Router({ mergeParams: true });
router.use(requireHealthWorker);

const maxMb = Number(process.env.XRAY_MAX_IMAGE_MB || 15);
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || IMAGE_EXT.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('Only image files are accepted'), { status: 415, publicMessage: 'Only image files are accepted' }));
  },
});

router.post('/', upload.single('image'), asyncHandler(analyzeXray));
router.get('/', asyncHandler(listXrayAnalyses));

module.exports = router;
