import multer from 'multer';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 6 MB' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: 'That record already exists' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }
  if (err?.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid id' });
  }
  if (err?.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const body = { error: status >= 500 ? 'Something went wrong' : err.message };
  if (err.extra) Object.assign(body, err.extra);
  return res.status(status).json(body);
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(jpeg|png|webp)$/.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    if (!allowed) return cb(Object.assign(new Error('Upload JPEG or PNG images'), { status: 400 }));
    return cb(null, true);
  },
});

export const uploadSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});
