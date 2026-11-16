const express = require('express');
const models = require('../models');
const wa = require('../whatsapp');
const t = require('../time');
const pay = require('../payments');
const { getSettings } = require('../db');
const { redirectWith, flash, idParam } = require('./helpers');

const router = express.Router();

const EVERY = { monthly: 1, yearly: 12 };

function readForm(body) {
  const repeat = body.repeat;
  const everyN = Number(body.every_n);
  return {
    title: (body.title || '').trim(),
    person_name: (body.person_name || '').trim(),
    phoneInput: (body.phone || '').trim(),
    amount: (body.amount || '').trim().replace(/,/g, ''),
    repeat,
    every_n: body.every_n || '',
    every_months: repeat === 'every_n' ? everyN : EVERY[repeat],
    first_due_date: (body.first_due_date || '').trim(),
    remind_days_before: Number(body.remind_days_before),
    send_time: (body.send_time || '').trim(),
    end_count: body.end_count ? Number(body.end_count) : null,
    end_date: (body.end_date || '').trim() || null,
    message: (body.message || '').trim(),
    active: body.active === '1' ? 1 : 0,
  };
}

function validate(f) {
  const errors = [];
  if (!f.title) errors.push('Enter a title, e.g. Car EMI.');
  if (!f.person_name) errors.push("Enter the person's name.");
  f.phone = pay.normalizePhone(f.phoneInput);
  if (!f.phone) errors.push('Enter a valid WhatsApp number, e.g. 98765 43210 or +91 98765 43210.');
  if (f.amount && !/^\d+(\.\d{1,2})?$/.test(f.amount)) errors.push('Amount: numbers only, e.g. 5000 or 5000.50.');
  if (!['monthly', 'every_n', 'yearly'].includes(f.repeat)) errors.push('Choose how often it repeats.');
  else if (!Number.isInteger(f.every_months) || f.every_months < 1 || f.every_months > 120) errors.push('Every N months: a whole number from 1 to 120.');
  if (!t.parse(f.first_due_date)) errors.push('Choose the first due date.');
  if (!Number.isInteger(f.remind_days_before) || f.remind_days_before < 0 || f.remind_days_before > 30) errors.push('Remind from: 0 to 30 days before.');
  if (!t.isValidTime(f.send_time)) errors.push('Enter a send time like 10:00.');
  if (f.end_count !== null && (!Number.isInteger(f.end_count) || f.end_count < 1)) errors.push('Number of payments: a whole number, 1 or more.');
  if (f.end_date && !t.parse(f.end_date)) errors.push('End date is not valid.');
  if (f.end_date && t.parse(f.first_due_date) && f.end_date < f.first_due_date) errors.push('End date is before the first due date.');
  if (!f.message) errors.push('Write the reminder message.');
  const unknown = pay.unknownPlaceholders(f.message);
  if (unknown.length) errors.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{${u}}`).join(', ')}. Use ${pay.PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}.`);
  if (/\{amount\}/.test(f.message) && !f.amount) errors.push('The message uses {amount}, so enter an amount (or remove {amount}).');
  return errors;
}

function renderForm(res, { payment, form, errors }) {
  res.status(errors && errors.length ? 400 : 200).render('payment_form', {
    page: 'payments', payment, form, errors: errors || [], contacts: models.listContacts(),
    placeholders: pay.PLACEHOLDERS,
  });
}

function formFromPayment(p) {
  const repeat = p.every_months === 1 ? 'monthly' : p.every_months === 12 ? 'yearly' : 'every_n';
  return {
    title: p.title, person_name: p.person_name, phoneInput: `+${p.phone}`, amount: p.amount || '',
    repeat, every_n: repeat === 'every_n' ? String(p.every_months) : '', first_due_date: p.first_due_date,
    remind_days_before: p.remind_days_before, send_time: p.send_time, end_count: p.end_count || '',
    end_date: p.end_date || '', message: p.message, active: p.active,
  };
}

router.get('/payments', (req, res) => {
  const now = new Date();
  const grace = Number(getSettings().grace_minutes);
  const rows = models.listPayments().map((p) => {
    const next = p.active ? pay.nextReminder(p, now, grace, (sf) => models.paymentLogRows(p.id, sf).length > 0) : null;
    const nextDue = pay.dueOnOrAfter(p, now);
    return { ...p, next, nextDue, ended: !nextDue };
  }).sort((a, b) => (a.next ? a.next.at : Infinity) - (b.next ? b.next.at : Infinity));
  res.render('payments', { page: 'payments', rows, pay, t, flash: flash(req) });
});

router.get('/payments/new', (req, res) => {
  renderForm(res, {
    payment: null,
    form: {
      title: '', person_name: '', phoneInput: '', amount: '', repeat: 'monthly', every_n: '3',
      first_due_date: '', remind_days_before: 2, send_time: '10:00', end_count: '', end_date: '',
      message: pay.DEFAULT_MESSAGE, active: 1,
    },
  });
});

// Live preview of the message on the form.
router.post('/payments/preview', express.json(), (req, res) => {
  const b = req.body || {};
  const fake = {
    person_name: b.person_name || 'Name', title: b.title || 'Title', amount: b.amount || '',
    message: b.message || '',
  };
  const due = t.parse(b.first_due_date) || t.addDays(new Date(), 2);
  const days = Math.max(0, Number(b.remind_days_before) || 0);
  res.json({ text: pay.renderMessage(fake, due, days), lastDay: pay.renderMessage(fake, due, 0) });
});

router.post('/payments', (req, res) => {
  const form = readForm(req.body);
  const errors = validate(form);
  if (errors.length) return renderForm(res, { payment: null, form, errors });
  models.createPayment(form);
  redirectWith(res, '/payments', { msg: `Saved "${form.title}" for ${form.person_name}.` });
});

router.get('/payments/:id/edit', (req, res) => {
  const p = models.getPayment(idParam(req));
  if (!p) return redirectWith(res, '/payments', { err: 'Payment reminder not found.' });
  renderForm(res, { payment: p, form: formFromPayment(p) });
});

router.post('/payments/:id', (req, res) => {
  const p = models.getPayment(idParam(req));
  if (!p) return redirectWith(res, '/payments', { err: 'Payment reminder not found.' });
  const form = readForm(req.body);
  const errors = validate(form);
  if (errors.length) return renderForm(res, { payment: p, form, errors });
  models.updatePayment(p.id, form);
  redirectWith(res, '/payments', { msg: `Saved "${form.title}".` });
});

router.post('/payments/:id/delete', (req, res) => {
  const p = models.getPayment(idParam(req));
  if (p) models.deletePayment(p.id);
  redirectWith(res, '/payments', { msg: p ? `Deleted "${p.title}".` : undefined });
});

// Sends the message as it would look for the next reminder, to my own number (not to the person).
router.post('/payments/:id/test', async (req, res) => {
  const p = models.getPayment(idParam(req));
  if (!p) return redirectWith(res, '/payments', { err: 'Payment reminder not found.' });
  const now = new Date();
  const next = pay.nextReminder(p, now, 0, () => false);
  const due = next ? next.due : (pay.dueOnOrAfter(p, now) || { date: pay.dueDate(p, 0) }).date;
  const daysLeft = next ? next.daysLeft : Math.max(0, t.daysBetween(now, due));
  const text = pay.renderMessage(p, due, daysLeft);
  try {
    await wa.sendToSelf(null, `🧪 Test (would go to ${p.person_name}, ${pay.prettyPhone(p.phone)}):\n\n${text}`);
    redirectWith(res, '/payments', { msg: 'Test sent to your own WhatsApp number.' });
  } catch (err) {
    redirectWith(res, '/payments', { err: `Test failed: ${err.message}` });
  }
});

module.exports = router;
