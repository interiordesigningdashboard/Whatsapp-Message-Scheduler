const express = require('express');
const models = require('../models');
const uploads = require('../uploads');
const wa = require('../whatsapp');
const t = require('../time');
const scheduler = require('../scheduler');
const { toArray, redirectWith, flash, idParam } = require('./helpers');

const router = express.Router();

function renderForm(res, { message, form, groupIds, errors }) {
  res.status(errors && errors.length ? 400 : 200).render('message_form', {
    page: 'messages', message, form, groupIds, errors: errors || [], allGroups: models.listGroups(),
  });
}

function readForm(req) {
  return {
    title: (req.body.title || '').trim(),
    sendAtInput: (req.body.send_at || '').trim(), // 'YYYY-MM-DDTHH:MM' from <input type="datetime-local">
    caption: (req.body.caption || '').trim(),
    removeImage: req.body.remove_image === '1',
  };
}

function validate(req, form, groupIds, existingImage) {
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  if (!form.title) errors.push('Enter a title.');
  const at = t.parse(form.sendAtInput);
  if (!at) errors.push('Choose a send date and time.');
  else if (at <= new Date()) errors.push('The send time must be in the future.');
  if (!groupIds.length) errors.push('Tick at least one group.');
  const willHaveImage = Boolean(req.file) || (existingImage && !form.removeImage);
  if (!willHaveImage && !form.caption) errors.push('Add an image, a caption, or both.');
  return { errors, at };
}

router.get('/messages', (req, res) => {
  const rows = models.listMessages().map((m) => {
    const logs = m.status === 'pending' ? [] : models.messageLogRows(m.id);
    return { ...m, sentCount: logs.filter((l) => l.status === 'sent').length, logCount: logs.length };
  });
  res.render('messages', { page: 'messages', rows, t, flash: flash(req) });
});

router.get('/messages/new', (req, res) => {
  renderForm(res, { message: null, form: { title: '', sendAtInput: '', caption: '' }, groupIds: [] });
});

router.post('/messages', uploads.imageUpload, (req, res) => {
  const form = readForm(req);
  const groupIds = toArray(req.body.groups);
  const { errors, at } = validate(req, form, groupIds, null);
  if (errors.length) {
    if (req.file) uploads.remove(req.file.filename);
    return renderForm(res, { message: null, form, groupIds, errors });
  }
  models.createMessage({ title: form.title, sendAt: t.ymdhm(at), imageFile: req.file && req.file.filename, caption: form.caption }, groupIds);
  redirectWith(res, '/messages', { msg: `Scheduled "${form.title}" for ${t.prettyDateTime(at)}.` });
});

function editable(req, res) {
  const m = models.getMessage(idParam(req));
  if (!m) { redirectWith(res, '/messages', { err: 'Message not found.' }); return null; }
  if (m.status !== 'pending' || scheduler.isRunning(`oneoff:${m.id}`)) {
    redirectWith(res, '/messages', { err: 'This message has already been sent or cancelled, so it can no longer be changed.' });
    return null;
  }
  return m;
}

router.get('/messages/:id/edit', (req, res) => {
  const m = editable(req, res);
  if (!m) return;
  renderForm(res, {
    message: m,
    form: { title: m.title, sendAtInput: m.send_at.replace(' ', 'T'), caption: m.caption || '' },
    groupIds: m.groupIds,
  });
});

router.post('/messages/:id', uploads.imageUpload, (req, res) => {
  const m = editable(req, res);
  if (!m) { if (req.file) uploads.remove(req.file.filename); return; }
  const form = readForm(req);
  const groupIds = toArray(req.body.groups);
  const { errors, at } = validate(req, form, groupIds, m.image_path);
  if (errors.length) {
    if (req.file) uploads.remove(req.file.filename);
    return renderForm(res, { message: m, form, groupIds, errors });
  }
  models.updateMessage(m.id, {
    title: form.title, sendAt: t.ymdhm(at), imageFile: req.file && req.file.filename,
    removeImage: form.removeImage, caption: form.caption,
  }, groupIds);
  redirectWith(res, '/messages', { msg: `Saved "${form.title}".` });
});

router.post('/messages/:id/cancel', (req, res) => {
  const m = editable(req, res);
  if (!m) return;
  models.finishMessage(m.id, 'cancelled');
  redirectWith(res, '/messages', { msg: `Cancelled "${m.title}".` });
});

router.post('/messages/:id/delete', (req, res) => {
  const m = models.getMessage(idParam(req));
  if (m && m.status === 'pending') return redirectWith(res, '/messages', { err: 'Cancel the message before deleting it.' });
  if (m) models.deleteMessage(m.id);
  redirectWith(res, '/messages', { msg: m ? `Deleted "${m.title}".` : undefined });
});

router.post('/messages/:id/test', async (req, res) => {
  const m = models.getMessage(idParam(req));
  if (!m || m.status !== 'pending') return redirectWith(res, '/messages', { err: 'Message not found.' });
  try {
    await wa.sendToSelf(uploads.fullPath(m.image_path), m.caption);
    redirectWith(res, '/messages', { msg: 'Test sent to your own WhatsApp number.' });
  } catch (err) {
    redirectWith(res, '/messages', { err: `Test failed: ${err.message}` });
  }
});

module.exports = router;
