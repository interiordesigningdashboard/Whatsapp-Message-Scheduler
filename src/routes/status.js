const express = require('express');
const wa = require('../whatsapp');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('status', { page: 'status', wa: wa.getState() });
});

// Polled by the Status page so the QR code and connection state update without a reload.
router.get('/api/status', (req, res) => {
  const s = wa.getState();
  res.json({ status: s.status, qrDataUrl: s.qrDataUrl, me: s.me, lastError: s.lastError });
});

router.post('/whatsapp/logout', async (req, res) => {
  await wa.logout();
  res.redirect('/');
});

module.exports = router;
