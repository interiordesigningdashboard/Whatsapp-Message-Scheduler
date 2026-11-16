const express = require('express');
const wa = require('../whatsapp');
const models = require('../models');
const { flash, redirectWith } = require('./helpers');

const router = express.Router();

router.get('/groups', (req, res) => {
  res.render('groups', {
    page: 'groups', groups: models.listGroups(), contacts: models.listContacts(), waReady: wa.isReady(), flash: flash(req),
  });
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

router.post('/contacts/sync', async (req, res) => {
  const back = req.body.back === 'payment' ? '/payments/new' : '/groups';
  try {
    const contacts = await wa.listContacts();
    models.saveContacts(contacts);
    redirectWith(res, back, { msg: `Loaded ${contacts.length} contacts from WhatsApp.` });
  } catch (err) {
    redirectWith(res, back, { err: `Could not load contacts: ${err.message}. You can still type the number.` });
  }
});

module.exports = router;
