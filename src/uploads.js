const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(new Error('Only JPG, PNG or WEBP images are allowed.'));
  },
});

// Single "image" field; turns multer errors into req.uploadError instead of crashing the request.
function imageUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The image is larger than 15 MB.' : err.message;
    next();
  });
}

// Uploaded files are stored by file name only; this resolves them safely inside the uploads folder.
function fullPath(fileName) {
  if (!fileName) return null;
  return path.join(config.uploadsDir, path.basename(fileName));
}

function remove(fileName) {
  const p = fullPath(fileName);
  if (!p) return;
  fs.rm(p, { force: true }, (err) => {
    if (err) console.warn(`[uploads] could not delete ${p}: ${err.message}`);
  });
}

module.exports = { imageUpload, fullPath, remove };
