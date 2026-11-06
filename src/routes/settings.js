const express = require('express');
const models = require('../models');
const { getSettings } = require('../db');
const t = require('../time');
const { flash, redirectWith } = require('./helpers');

const router = express.Router();

router.get('/settings', (req, res) => {
  res.render('settings', { page: 'settings', s: getSettings(), errors: [], flash: flash(req) });
});

router.post('/settings', (req, res) => {
  const b = req.body;
  const s = {
    delay_min_sec: Number(b.delay_min_sec),
    delay_max_sec: Number(b.delay_max_sec),
    grace_minutes: Number(b.grace_minutes),
    reminder_days_ahead: Number(b.reminder_days_ahead),
    reminder_time: (b.reminder_time || '').trim(),
    self_alert_enabled: b.self_alert_enabled === '1' ? '1' : '0',
  };
  const errors = [];
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!intIn(s.delay_min_sec, 0, 300) || !intIn(s.delay_max_sec, 0, 300) || s.delay_max_sec < s.delay_min_sec) {
    errors.push('Delay: whole seconds between 0 and 300, and the maximum must not be lower than the minimum.');
  }
  if (!intIn(s.grace_minutes, 1, 60)) errors.push('Grace period: 1 to 60 minutes.');
  if (!intIn(s.reminder_days_ahead, 0, 60)) errors.push('Reminder days: 0 to 60.');
  if (!t.isValidTime(s.reminder_time)) errors.push('Reminder time: like 09:00.');
  if (errors.length) return res.status(400).render('settings', { page: 'settings', s: { ...getSettings(), ...b }, errors, flash: {} });
  models.saveSettings(s);
  redirectWith(res, '/settings', { msg: 'Settings saved.' });
});

module.exports = router;
