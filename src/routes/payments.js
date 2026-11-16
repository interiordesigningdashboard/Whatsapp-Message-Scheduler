const express = require('express');
const models = require('../models');
const wa = require('../whatsapp');
const t = require('../time');
const pay = require('../payments');
const { getSettings } = require('../db');
const { toArray, redirectWith, flash, idParam } = require('./helpers');

const router = express.Router();

const EVERY = { monthly: 1, yearly: 12 };

function readForm(body) {
  const repeat = body.repeat;
  const everyN = Number(body.every_n);
  return {
    title: (body.title || '').trim(),
    // Several people: parallel lists of names and numbers; fully empty rows are ignored.
    people: (() => {
      const names = toArray(body.recipient_name);
      const phones = toArray(body.recipient_phone);
      const rows = [];
      for (let i = 0; i < Math.max(names.length, phones.length); i++) {
        const name = String(names[i] || '').trim();
        const phoneInput = String(phones[i] || '').trim();
        if (name || phoneInput) rows.push({ name, phoneInput });
      }
      return rows;
    })(),
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
  const repeatOk = ['monthly', 'every_n', 'yearly'].includes(f.repeat);
  if (!repeatOk) errors.push('Choose how often it repeats.');
  f.recipients = pay.checkPeople(f.people, errors);
  // Without a repeat choice there is no "every N months" to check.
  return [...pay.checkFields(f).filter((e) => repeatOk || !e.startsWith('Every N months')), ...errors];
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
    title: p.title, people: p.recipients.map((r) => ({ name: r.name, phoneInput: `+${r.phone}` })), amount: p.amount || '',
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
      title: '', people: [], amount: '', repeat: 'monthly', every_n: '3',
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
  redirectWith(res, '/payments', { msg: `Saved "${form.title}" for ${form.recipients.map((r) => r.name).join(', ')}.` });
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
  const first = p.recipients[0];
  const text = pay.renderMessage({ ...p, person_name: first.name }, due, daysLeft);
  const to = p.recipients.map((r) => `${r.name} (${pay.prettyPhone(r.phone)})`).join(', ');
  try {
    await wa.sendToSelf(null, `🧪 Test. Would go to ${to}, each with their own name. For ${first.name}:\n\n${text}`);
    redirectWith(res, '/payments', { msg: 'Test sent to your own WhatsApp number.' });
  } catch (err) {
    redirectWith(res, '/payments', { err: `Test failed: ${err.message}` });
  }
});

module.exports = router;
