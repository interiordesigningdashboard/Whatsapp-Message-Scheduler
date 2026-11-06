const express = require('express');
const models = require('../models');
const uploads = require('../uploads');
const wa = require('../whatsapp');
const t = require('../time');
const { getSettings } = require('../db');
const { toArray, redirectWith, flash, idParam } = require('./helpers');

const router = express.Router();

const grace = () => Number(getSettings().grace_minutes);

function readForm(body) {
  return {
    name: (body.name || '').trim(),
    month: Number(body.month),
    day: Number(body.day),
    sendTime: (body.send_time || '').trim(),
    active: body.active === '1',
  };
}

function validate(f, groupIds) {
  const errors = [];
  if (!f.name) errors.push('Enter a name.');
  if (!t.isValidMonthDay(f.month, f.day)) errors.push('Choose a valid birthday date.');
  if (!t.isValidTime(f.sendTime)) errors.push('Enter a send time like 09:00.');
  if (!groupIds.length) errors.push('Tick at least one group.');
  return errors;
}

function renderForm(res, { birthday, form, groupIds, errors }) {
  res.status(errors && errors.length ? 400 : 200).render('birthday_form', {
    page: 'birthdays', birthday, form, groupIds, errors: errors || [],
    allGroups: models.listGroups(), months: t.MONTHS,
  });
}

router.get('/birthdays', (req, res) => {
  const now = new Date();
  const q = (req.query.q || '').trim().toLowerCase();
  const rows = models.listBirthdays()
    .filter((b) => !q || b.name.toLowerCase().includes(q))
    .map((b) => {
      const next = models.nextOccurrence(b, now, grace());
      return {
        ...b,
        next,
        inDays: next ? t.daysBetween(now, next.date) : null,
        hasContent: next ? models.hasContentFor(b, next.dateStr) : false,
      };
    })
    .sort((a, b) => (a.next ? a.next.scheduledAt : Infinity) - (b.next ? b.next.scheduledAt : Infinity));
  res.render('birthdays', { page: 'birthdays', rows, q: req.query.q || '', months: t.MONTHS, t, flash: flash(req) });
});

router.get('/birthdays/new', (req, res) => {
  renderForm(res, { birthday: null, form: { name: '', month: '', day: '', sendTime: '09:00', active: true }, groupIds: [] });
});

router.post('/birthdays', (req, res) => {
  const form = readForm(req.body);
  const groupIds = toArray(req.body.groups);
  const errors = validate(form, groupIds);
  if (errors.length) return renderForm(res, { birthday: null, form, groupIds, errors });
  const id = models.createBirthday(form, groupIds);
  redirectWith(res, `/birthdays/${id}/content`, { msg: `Saved ${form.name}. Now add this year's image and caption.` });
});

router.get('/birthdays/:id/edit', (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (!b) return redirectWith(res, '/birthdays', { err: 'Birthday not found.' });
  renderForm(res, {
    birthday: b,
    form: { name: b.name, month: b.birth_month, day: b.birth_day, sendTime: b.send_time, active: Boolean(b.active) },
    groupIds: b.groupIds,
  });
});

router.post('/birthdays/:id', (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (!b) return redirectWith(res, '/birthdays', { err: 'Birthday not found.' });
  const form = readForm(req.body);
  const groupIds = toArray(req.body.groups);
  const errors = validate(form, groupIds);
  if (errors.length) return renderForm(res, { birthday: b, form, groupIds, errors });
  models.updateBirthday(b.id, form, groupIds);

  // If the date or time moved, keep already-added content attached to the new next birthday.
  if (b.next_for_date) {
    const next = models.nextOccurrence(models.getBirthday(b.id), new Date(), grace());
    if (next && next.dateStr !== b.next_for_date) {
      models.setBirthdayContent(b.id, { imageFile: null, caption: b.next_caption, forDate: next.dateStr });
    }
  }
  redirectWith(res, '/birthdays', { msg: `Saved ${form.name}.` });
});

router.post('/birthdays/:id/delete', (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (b) models.deleteBirthday(b.id);
  redirectWith(res, '/birthdays', { msg: b ? `Deleted ${b.name}.` : undefined });
});

// ----- This year's content -----

function contentView(b) {
  const next = models.nextOccurrence(b, new Date(), grace());
  const hasContent = next ? models.hasContentFor(b, next.dateStr) : false;
  return { next, hasContent };
}

router.get('/birthdays/:id/content', (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (!b) return redirectWith(res, '/birthdays', { err: 'Birthday not found.' });
  const names = models.groupNames();
  res.render('birthday_content', {
    page: 'birthdays', b, ...contentView(b), t, flash: flash(req), errors: [],
    groupNames: b.groupIds.map((g) => names.get(g) || g),
    caption: b.next_caption || '',
    waReady: wa.isReady(),
  });
});

router.post('/birthdays/:id/content', uploads.imageUpload, (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (!b) {
    if (req.file) uploads.remove(req.file.filename);
    return redirectWith(res, '/birthdays', { err: 'Birthday not found.' });
  }
  const { next, hasContent } = contentView(b);
  const caption = (req.body.caption || '').trim();
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  if (!next) errors.push('Could not work out the next birthday date.');
  const keepsImage = hasContent && b.next_image_path;
  if (!req.file && !keepsImage && !caption) errors.push('Add an image, a caption, or both.');

  if (errors.length) {
    if (req.file) uploads.remove(req.file.filename);
    const names = models.groupNames();
    return res.status(400).render('birthday_content', {
      page: 'birthdays', b, next, hasContent, t, flash: {}, errors, caption,
      groupNames: b.groupIds.map((g) => names.get(g) || g), waReady: wa.isReady(),
    });
  }

  // Content left over for an older date is replaced, never reused.
  if (b.next_for_date && b.next_for_date !== next.dateStr && b.next_image_path && !req.file) {
    uploads.remove(b.next_image_path);
    models.clearBirthdayContent(b.id);
  }
  models.setBirthdayContent(b.id, { imageFile: req.file ? req.file.filename : null, caption, forDate: next.dateStr });
  redirectWith(res, `/birthdays/${b.id}/content`, { msg: 'Saved. It will be sent automatically.' });
});

router.post('/birthdays/:id/content/clear', (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (b) models.clearBirthdayContent(b.id);
  redirectWith(res, `/birthdays/${req.params.id}/content`, { msg: 'Removed the image and caption.' });
});

router.post('/birthdays/:id/test', async (req, res) => {
  const b = models.getBirthday(idParam(req));
  if (!b) return redirectWith(res, '/birthdays', { err: 'Birthday not found.' });
  const { hasContent } = contentView(b);
  if (!hasContent) return redirectWith(res, `/birthdays/${b.id}/content`, { err: 'Add an image or caption first.' });
  try {
    await wa.sendToSelf(uploads.fullPath(b.next_image_path), b.next_caption);
    redirectWith(res, `/birthdays/${b.id}/content`, { msg: 'Test sent to your own WhatsApp number.' });
  } catch (err) {
    redirectWith(res, `/birthdays/${b.id}/content`, { err: `Test failed: ${err.message}` });
  }
});

module.exports = router;
