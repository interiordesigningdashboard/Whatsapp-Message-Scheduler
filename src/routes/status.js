const express = require('express');
const wa = require('../whatsapp');
const scheduler = require('../scheduler');
const models = require('../models');
const { getSettings } = require('../db');
const t = require('../time');
const { flash } = require('./helpers');

const router = express.Router();

router.get('/', (req, res) => {
  const now = new Date();
  res.render('status', {
    page: 'status',
    wa: wa.getState(),
    upcoming: scheduler.upcoming(now, 5),
    needContent: scheduler.birthdaysNeedingContent(now, Number(getSettings().reminder_days_ahead)),
    groupCount: models.listGroups().length,
    flash: flash(req),
    t,
  });
});

// Polled by the Status page so the QR code and connection state update without a reload.
router.get('/api/status', (req, res) => {
  const s = wa.getState();
  res.json({ status: s.status, qrDataUrl: s.qrDataUrl, me: s.me, lastError: s.lastError, loading: s.loading });
});

router.post('/whatsapp/logout', async (req, res) => {
  await wa.logout();
  res.redirect('/');
});

module.exports = router;
