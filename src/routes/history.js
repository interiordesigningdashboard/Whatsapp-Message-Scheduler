const express = require('express');
const models = require('../models');
const t = require('../time');

const router = express.Router();

router.get('/history', (req, res) => {
  const filters = {
    status: ['sent', 'failed', 'missed'].includes(req.query.status) ? req.query.status : '',
    q: (req.query.q || '').trim(),
    from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '',
  };
  res.render('history', { page: 'history', rows: models.history(filters), filters, t });
});

module.exports = router;
