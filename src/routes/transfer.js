// Import / export page: download everything as Excel, or upload a file, preview, then import.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const excel = require('../excel');
const t = require('../time');
const { flash, redirectWith } = require('./helpers');

const router = express.Router();
const importsDir = path.join(config.dataDir, 'imports');
fs.mkdirSync(importsDir, { recursive: true });

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const upload = multer({
  storage: multer.diskStorage({
    destination: importsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.xlsx`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Choose an Excel .xlsx file (in Excel: File > Save As > Excel Workbook).'));
  },
});

// Uploaded files wait here between preview and import; drop ones older than a day.
function cleanOldUploads() {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(importsDir)) {
    const p = path.join(importsDir, f);
    try { if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

function uploadPath(token) {
  if (!/^\d+-[a-f0-9]{16}\.xlsx$/.test(token || '')) return null;
  const p = path.join(importsDir, token);
  return fs.existsSync(p) ? p : null;
}

async function sendWorkbook(res, wb, name) {
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(buffer));
}

router.get('/import-export', (req, res) => {
  res.render('import_export', { page: 'transfer', flash: flash(req) });
});

router.get('/export.xlsx', async (req, res, next) => {
  try {
    const withIds = req.query.ids !== '0';
    await sendWorkbook(res, excel.buildWorkbook({ withIds }), `whatsapp-scheduler-${t.ymd(new Date())}.xlsx`);
  } catch (err) { next(err); }
});

router.get('/export/template.xlsx', async (req, res, next) => {
  try {
    await sendWorkbook(res, excel.buildTemplate(), 'whatsapp-scheduler-template.xlsx');
  } catch (err) { next(err); }
});

router.post('/import/preview', (req, res) => {
  cleanOldUploads();
  upload.single('file')(req, res, async (err) => {
    if (err) return redirectWith(res, '/import-export', { err: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB.' : err.message });
    if (!req.file) return redirectWith(res, '/import-export', { err: 'Choose a file to import.' });
    const prune = req.body.prune === '1';
    try {
      const parsed = await excel.readWorkbook(req.file.path);
      const plan = excel.plan(parsed, { prune });
      res.render('import_preview', {
        page: 'transfer', plan, prune, token: req.file.filename, fileName: req.file.originalname,
        summary: excel.summary(plan), flash: {},
      });
    } catch (e) {
      fs.rmSync(req.file.path, { force: true });
      redirectWith(res, '/import-export', { err: e.message });
    }
  });
});

router.post('/import/apply', async (req, res) => {
  const file = uploadPath(req.body.token);
  if (!file) return redirectWith(res, '/import-export', { err: 'That upload has expired. Choose the file again.' });
  try {
    // Read again: the plan is worked out against the data as it is right now.
    const plan = excel.plan(await excel.readWorkbook(file), { prune: req.body.prune === '1' });
    const c = excel.apply(plan);
    fs.rmSync(file, { force: true });
    const part = (name, x) => `${name}: ${x.added} added, ${x.updated} updated${x.removed ? `, ${x.removed} deleted` : ''}`;
    const skipped = plan.payments.errors.length + plan.birthdays.errors.length;
    redirectWith(res, '/import-export', {
      msg: `Imported. ${part('Payments', c.payments)}. ${part('Birthdays', c.birthdays)}.${skipped ? ` ${skipped} row(s) with problems were skipped.` : ''}`,
    });
  } catch (e) {
    redirectWith(res, '/import-export', { err: `Import failed, nothing was changed: ${e.message}` });
  }
});

module.exports = router;
