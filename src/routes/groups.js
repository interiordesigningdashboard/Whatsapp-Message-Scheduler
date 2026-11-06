const express = require('express');
const wa = require('../whatsapp');
const models = require('../models');
const { flash, redirectWith } = require('./helpers');

const router = express.Router();

router.get('/groups', (req, res) => {
  res.render('groups', { page: 'groups', groups: models.listGroups(), waReady: wa.isReady(), flash: flash(req) });
});

router.post('/groups/sync', async (req, res) => {
  try {
    const groups = await wa.listGroups();
    models.saveGroups(groups);
    redirectWith(res, '/groups', { msg: `Loaded ${groups.length} groups from WhatsApp.` });
  } catch (err) {
    redirectWith(res, '/groups', { err: `Could not load groups: ${err.message}` });
  }
});

module.exports = router;
