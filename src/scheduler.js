// Runs once a minute: sends what is due, marks what was missed, cleans up used content,
// and sends the daily "needs content" reminder.
const fs = require('fs');
const { getSettings } = require('./db');
const models = require('./models');
const uploads = require('./uploads');
const wa = require('./whatsapp');
const t = require('./time');

const running = new Set();     // jobs currently queued or sending, e.g. "birthday:3:2026-11-12"
let queue = Promise.resolve(); // jobs send one after another, never in parallel
const pendingAlerts = [];      // alerts waiting for WhatsApp to be connected
let timer = null;
let ticking = false;

const REASON_OFF = 'Not sent: the app was off or WhatsApp was not connected at the send time';
const REASON_NO_CONTENT = 'Not sent: no image or caption was added for this birthday';
const REASON_NO_GROUPS = 'Not sent: no groups were selected';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alertSelf(text) {
  if (getSettings().self_alert_enabled !== '1') return;
  pendingAlerts.push(text);
}

async function flushAlerts() {
  while (pendingAlerts.length && wa.isReady()) {
    const text = pendingAlerts[0];
    try {
      await wa.sendToSelf(null, text);
      pendingAlerts.shift();
    } catch (err) {
      console.warn(`[scheduler] could not send alert to self: ${err.message}`);
      return;
    }
  }
}

// ---------- Building jobs ----------

function birthdayJob(b, dateStr, scheduledAt) {
  const hasContent = models.hasContentFor(b, dateStr);
  return {
    key: `birthday:${b.id}:${dateStr}`,
    type: 'birthday',
    id: b.id,
    label: b.name,
    title: `🎂 ${b.name}`,
    scheduledAt,
    scheduledFor: t.ymdhm(scheduledAt),
    groupIds: b.groupIds,
    imageFile: hasContent ? uploads.fullPath(b.next_image_path) : null,
    caption: hasContent ? b.next_caption : null,
    hasContent,
    logRows: () => models.birthdayLogRows(b.id, dateStr),
    finish: () => {
      // This year's content is used up (sent or missed): delete it.
      const fresh = models.getBirthday(b.id);
      if (fresh && fresh.next_for_date && fresh.next_for_date <= dateStr) models.clearBirthdayContent(b.id);
    },
  };
}

function messageJob(m) {
  const scheduledAt = t.parse(m.send_at);
  return {
    key: `oneoff:${m.id}`,
    type: 'oneoff',
    id: m.id,
    label: m.title,
    title: `🗓️ ${m.title}`,
    scheduledAt,
    scheduledFor: t.ymdhm(scheduledAt),
    groupIds: m.groupIds,
    imageFile: uploads.fullPath(m.image_path),
    caption: m.caption,
    hasContent: Boolean(m.image_path || m.caption),
    logRows: () => models.messageLogRows(m.id),
    finish: () => models.finishMessage(m.id, 'done'),
  };
}

function log(job, groupId, groupName, status, error) {
  return models.addLog({
    jobType: job.type, jobId: job.id, jobLabel: job.label, groupId, groupName,
    scheduledFor: job.scheduledFor, status, error,
  });
}

// Mark every group that has not been handled yet as missed, then finish the job.
function markMissed(job, reason, names) {
  const done = new Set(job.logRows().map((r) => r.group_id));
  const remaining = job.groupIds.filter((g) => !done.has(g));
  if (!job.groupIds.length && done.size === 0) {
    log(job, '', null, 'missed', REASON_NO_GROUPS);
  }
  for (const g of remaining) log(job, g, names.get(g), 'missed', reason);
  job.finish();
  if (remaining.length || !job.groupIds.length) {
    alertSelf(`⚠️ ${job.title} (${t.prettyDateTime(job.scheduledAt)})\n${job.groupIds.length ? reason : REASON_NO_GROUPS}`);
  }
}

// ---------- Sending ----------

async function sendJob(job) {
  const names = models.groupNames();
  const s = getSettings();
  const minDelay = Number(s.delay_min_sec) * 1000;
  const maxDelay = Math.max(minDelay, Number(s.delay_max_sec) * 1000);
  const graceMs = Number(s.grace_minutes) * 60000;

  if (job.imageFile && !fs.existsSync(job.imageFile)) {
    markMissed(job, 'Not sent: the image file is missing', names);
    return;
  }

  const done = new Set(job.logRows().map((r) => r.group_id));
  const remaining = job.groupIds.filter((g) => !done.has(g));
  const results = [];

  for (let i = 0; i < remaining.length; i++) {
    const g = remaining[i];
    // Stay inside the "never send late" rule even for a long list of groups:
    // if WhatsApp drops for longer than the grace period, the rest is marked missed.
    while (!wa.isReady() && Date.now() - job.scheduledAt.getTime() <= graceMs + remaining.length * maxDelay) {
      await sleep(5000);
    }
    if (!wa.isReady()) {
      log(job, g, names.get(g), 'missed', REASON_OFF);
      results.push({ g, ok: false, error: 'WhatsApp disconnected' });
      continue;
    }
    try {
      await wa.send(g, job.imageFile, job.caption);
      log(job, g, names.get(g), 'sent');
      results.push({ g, ok: true });
    } catch (err) {
      log(job, g, names.get(g), 'failed', err.message);
      results.push({ g, ok: false, error: err.message });
    }
    if (i < remaining.length - 1) await sleep(minDelay + Math.random() * (maxDelay - minDelay));
  }

  job.finish();

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  let text = `${job.title}: sent to ${ok}/${results.length} group${results.length === 1 ? '' : 's'}.`;
  if (failed.length) {
    text += `\nFailed:\n${failed.map((f) => `• ${names.get(f.g) || f.g}: ${f.error}`).join('\n')}`;
  }
  alertSelf(text);
  console.log(`[scheduler] ${text.replace(/\n/g, ' | ')}`);
}

function enqueue(job) {
  running.add(job.key);
  queue = queue
    .then(() => sendJob(job))
    .catch((err) => console.error(`[scheduler] job ${job.key} crashed: ${err.stack || err}`))
    .finally(() => running.delete(job.key));
}

// Decide what to do with a job whose send time has come.
function handleDue(job, now, graceMs, names) {
  if (running.has(job.key)) return;

  const rows = job.logRows();
  const done = new Set(rows.map((r) => r.group_id));
  const remaining = job.groupIds.filter((g) => !done.has(g));

  if (!job.groupIds.length) {
    if (!rows.length) markMissed(job, REASON_NO_GROUPS, names);
    else job.finish();
    return;
  }
  if (!remaining.length) { job.finish(); return; } // already handled; make sure content is cleaned up
  if (!job.hasContent) { markMissed(job, REASON_NO_CONTENT, names); return; }

  const late = now.getTime() - job.scheduledAt.getTime() > graceMs;
  if (late) { markMissed(job, REASON_OFF, names); return; }
  if (!wa.isReady()) return; // wait for WhatsApp, until the grace period runs out

  enqueue(job);
}

// ---------- The tick ----------

function checkBirthdays(now, graceMs, names) {
  const today = t.startOfDay(now);
  for (const b of models.listBirthdays()) {
    // Birthday content for a date older than yesterday was never used: the app was off. Clean it up.
    if (b.next_for_date && b.next_for_date < t.ymd(t.addDays(today, -1))) {
      const d = t.parse(b.next_for_date);
      if (b.active) handleDue(birthdayJob(b, b.next_for_date, t.atTime(d, b.send_time)), now, graceMs, names);
      else models.clearBirthdayContent(b.id);
      continue;
    }
    if (!b.active) continue;

    const created = t.parse(b.created_at);
    // Look at yesterday too, so a late-evening birthday is caught if the app was off overnight.
    for (const offset of [-1, 0]) {
      const day = t.addDays(today, offset);
      const date = t.birthdayInYear(b.birth_month, b.birth_day, day.getFullYear());
      if (t.ymd(date) !== t.ymd(day)) continue;
      const scheduledAt = t.atTime(date, b.send_time);
      if (scheduledAt > now) continue;
      if (created && scheduledAt < created) continue; // added after its send time had passed
      handleDue(birthdayJob(models.getBirthday(b.id), t.ymd(date), scheduledAt), now, graceMs, names);
    }
  }
}

function checkMessages(now, graceMs, names) {
  for (const m of models.pendingMessages()) {
    const at = t.parse(m.send_at);
    if (!at || at > now) continue;
    handleDue(messageJob(m), now, graceMs, names);
  }
}

// Birthdays in the next N days that still need an image or caption.
function birthdaysNeedingContent(now, days) {
  const graceMinutes = Number(getSettings().grace_minutes);
  const list = [];
  for (const b of models.listBirthdays()) {
    if (!b.active) continue;
    const next = models.nextOccurrence(b, now, graceMinutes);
    if (!next) continue;
    const inDays = t.daysBetween(now, next.date);
    if (inDays <= days && !models.hasContentFor(b, next.dateStr)) list.push({ b, next, inDays });
  }
  return list.sort((x, y) => x.next.scheduledAt - y.next.scheduledAt);
}

function checkReminder(now) {
  const s = getSettings();
  const today = t.ymd(now);
  if (s.last_reminder_date === today || t.hm(now) < s.reminder_time) return;
  if (!wa.isReady()) return;
  models.saveSettings({ last_reminder_date: today });

  const list = birthdaysNeedingContent(now, Number(s.reminder_days_ahead));
  if (!list.length) return;
  const lines = list.map(({ b, next, inDays }) => {
    const when = inDays === 0 ? 'today' : inDays === 1 ? 'tomorrow' : `in ${inDays} days`;
    return `• ${b.name}: ${t.prettyDate(next.date)} at ${b.send_time} (${when})`;
  });
  alertSelf(`📝 Add an image and caption for these birthdays:\n${lines.join('\n')}\n\nOpen http://localhost:3000/birthdays`);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const graceMs = Number(getSettings().grace_minutes) * 60000;
    const names = models.groupNames();
    checkBirthdays(now, graceMs, names);
    checkMessages(now, graceMs, names);
    checkReminder(now);
    await flushAlerts();
  } catch (err) {
    console.error(`[scheduler] tick failed: ${err.stack || err}`);
  } finally {
    ticking = false;
  }
}

// Tick a couple of seconds after every minute starts.
function scheduleNext() {
  const now = new Date();
  const ms = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 2000;
  timer = setTimeout(async () => {
    await tick();
    scheduleNext();
  }, ms);
}

function start() {
  tick(); // straight away on startup: marks anything missed while the app was off
  scheduleNext();
}

function stop() {
  clearTimeout(timer);
}

// Next sends for the Status page: [{ when, label, kind, url, hasContent }]
function upcoming(now, limit) {
  const graceMinutes = Number(getSettings().grace_minutes);
  const items = [];
  for (const b of models.listBirthdays()) {
    if (!b.active) continue;
    const next = models.nextOccurrence(b, now, graceMinutes);
    if (!next) continue;
    items.push({
      when: next.scheduledAt, label: b.name, kind: 'Birthday', url: `/birthdays/${b.id}/content`,
      hasContent: models.hasContentFor(b, next.dateStr), groups: b.groupIds.length,
    });
  }
  for (const m of models.pendingMessages()) {
    items.push({
      when: t.parse(m.send_at), label: m.title, kind: 'One-off', url: `/messages/${m.id}/edit`,
      hasContent: Boolean(m.image_path || m.caption), groups: m.groupIds.length,
    });
  }
  return items.sort((a, b) => a.when - b.when).slice(0, limit);
}

module.exports = { start, stop, tick, upcoming, birthdaysNeedingContent, isRunning: (key) => running.has(key) };
