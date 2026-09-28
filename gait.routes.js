const { Router } = require('express');
const multer = require('multer');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHealthWorker } = require('../middleware/auth');
const { analyzeGaitVideo } = require('../controllers/gait.controller');

const router = Router({ mergeParams: true });

router.use(requireHealthWorker); // gait capture is done by health workers in the field

const maxMb = Number(process.env.GAIT_MAX_VIDEO_MB || 50);
const VIDEO_EXT = /\.(mp4|mov|avi|webm|mkv|3gp)$/i;

// Memory storage: the video is only relayed to the model service, never kept on disk here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // Some phones send videos as application/octet-stream, so fall back to the extension.
    if (file.mimetype.startsWith('video/') || VIDEO_EXT.test(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error('Only video files are accepted'), { status: 415, publicMessage: 'Only video files are accepted' }));
  },
});

router.post('/', upload.single('video'), asyncHandler(analyzeGaitVideo));

module.exports = router;
