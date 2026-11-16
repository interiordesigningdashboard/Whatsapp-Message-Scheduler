// Due dates, reminder days and message text for payment reminders (EMI, insurance, ...).
const t = require('./time');

// Turn what was typed into digits with country code. 10-digit numbers are Indian: +91 is added.
// Returns null if it does not look like a phone number.
function normalizePhone(input) {
  let d = String(input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = `91${d.slice(1)}`;
  else if (d.length === 10) d = `91${d}`;
  d = d.replace(/\D/g, '');
  return /^\d{11,15}$/.test(d) ? d : null;
}

function prettyPhone(digits) {
  if (/^91\d{10}$/.test(digits)) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

function daysInMonth(year, month0) {
  return new Date(year, month0 + 1, 0).getDate();
}

// The k-th due date (k = 0 is the first). A due day the month does not have becomes its last day.
function dueDate(p, k) {
  const first = t.parse(p.first_due_date);
  const dueDay = first.getDate();
  const m = first.getMonth() + k * p.every_months;
  const year = first.getFullYear() + Math.floor(m / 12);
  const month0 = ((m % 12) + 12) % 12;
  return new Date(year, month0, Math.min(dueDay, daysInMonth(year, month0)));
}

function withinEnd(p, k, date) {
  if (p.end_count && k >= p.end_count) return false;
  if (p.end_date && t.ymd(date) > p.end_date) return false;
  return true;
}

// First due date on or after the given day: { date, k }, or null if the payment has ended.
function dueOnOrAfter(p, day) {
  const first = t.parse(p.first_due_date);
  const target = t.startOfDay(day);
  const monthsApart = (target.getFullYear() - first.getFullYear()) * 12 + (target.getMonth() - first.getMonth());
  let k = Math.max(0, Math.floor(monthsApart / p.every_months) - 1);
  for (let i = 0; i < 4; i++, k++) {
    const d = dueDate(p, k);
    if (!withinEnd(p, k, d)) return null;
    if (d >= target) return { date: d, k };
  }
  return null;
}

// If a reminder goes out on this day, the due date it is for: { due, daysLeft }. Otherwise null.
// Reminders run every day from `remind_days_before` days before the due date up to the due date.
function reminderOn(p, day) {
  const next = dueOnOrAfter(p, day);
  if (!next) return null;
  const daysLeft = t.daysBetween(day, next.date);
  return daysLeft <= p.remind_days_before ? { due: next.date, daysLeft, k: next.k } : null;
}

// The next reminder that has not been sent yet and whose time has not passed by more than the grace
// period: { at, due, daysLeft }. `isLogged(scheduledFor)` says if a reminder is already handled.
function nextReminder(p, now, graceMinutes, isLogged) {
  const created = t.parse(p.created_at);
  let day = t.startOfDay(now);
  for (let i = 0; i < 800; i++) {
    const r = reminderOn(p, day);
    if (r) {
      const at = t.atTime(day, p.send_time);
      const fresh = at.getTime() + graceMinutes * 60000 >= now.getTime() && !(created && at < created);
      if (fresh && !isLogged(t.ymdhm(at))) return { at, due: r.due, daysLeft: r.daysLeft };
      day = t.addDays(day, 1);
    } else {
      const next = dueOnOrAfter(p, day);
      if (!next) return null; // payment has ended
      // jump to the first reminder day of that due date
      const start = t.addDays(next.date, -p.remind_days_before);
      day = start > day ? start : t.addDays(day, 1);
    }
  }
  return null;
}

function formatAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(String(amount).replace(/,/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(amount);
}

function daysLeftText(daysLeft) {
  if (daysLeft <= 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  return `in ${daysLeft} days`;
}

// "5 Dec 2026"
function shortDate(d) {
  return `${d.getDate()} ${t.MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

const PLACEHOLDERS = ['name', 'title', 'amount', 'due_date', 'days_left'];

function renderMessage(p, due, daysLeft) {
  const values = {
    name: p.person_name,
    title: p.title,
    amount: formatAmount(p.amount),
    due_date: shortDate(due),
    days_left: daysLeftText(daysLeft),
  };
  return p.message.replace(/\{(\w+)\}/g, (all, key) => (key in values ? values[key] : all));
}

function unknownPlaceholders(message) {
  return [...new Set((message.match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1)))]
    .filter((k) => !PLACEHOLDERS.includes(k));
}

function describeRepeat(p) {
  const first = t.parse(p.first_due_date);
  if (p.every_months === 12) return `Every year on ${first.getDate()} ${t.MONTHS[first.getMonth()]}`;
  const day = first.getDate();
  const suffix = day > 28 ? ` (or the last day of the month)` : '';
  if (p.every_months === 1) return `Every month on day ${day}${suffix}`;
  return `Every ${p.every_months} months on day ${day}${suffix}`;
}

function describeEnd(p) {
  const parts = [];
  if (p.end_count) parts.push(`${p.end_count} payments`);
  if (p.end_date) parts.push(`until ${shortDate(t.parse(p.end_date))}`);
  return parts.length ? parts.join(', ') : 'No end';
}

// Turns a list of { name, phoneInput } into recipients [{ name, phone }]; adds problems to `errors`.
function checkPeople(people, errors) {
  const recipients = [];
  if (!people.length) errors.push('Add at least one person to remind.');
  if (people.length > 50) errors.push('At most 50 people per payment reminder.');
  const seen = new Set();
  people.forEach((r, i) => {
    const who = r.name || `Person ${i + 1}`;
    const phone = normalizePhone(r.phoneInput);
    if (!r.name) errors.push(`Person ${i + 1}: enter a name.`);
    if (!phone) errors.push(`${who}: enter a valid WhatsApp number, e.g. 98765 43210 or +91 98765 43210.`);
    else if (seen.has(phone)) errors.push(`${who}: the number +${phone} is already in the list.`);
    if (phone) seen.add(phone);
    if (r.name && phone) recipients.push({ name: r.name, phone });
  });
  return recipients;
}

// Checks the payment fields (everything except the people). Used by the form and by Excel import.
function checkFields(f) {
  const errors = [];
  if (!f.title) errors.push('Enter a title, e.g. Car EMI.');
  if (f.amount && !/^\d+(\.\d{1,2})?$/.test(f.amount)) errors.push('Amount: numbers only, e.g. 5000 or 5000.50.');
  if (!Number.isInteger(f.every_months) || f.every_months < 1 || f.every_months > 120) errors.push('Every N months: a whole number from 1 to 120.');
  if (!t.parse(f.first_due_date)) errors.push('Choose the first due date.');
  if (!Number.isInteger(f.remind_days_before) || f.remind_days_before < 0 || f.remind_days_before > 30) errors.push('Remind from: 0 to 30 days before.');
  if (!t.isValidTime(f.send_time)) errors.push('Enter a send time like 10:00.');
  if (f.end_count !== null && (!Number.isInteger(f.end_count) || f.end_count < 1)) errors.push('Number of payments: a whole number, 1 or more.');
  if (f.end_date && !t.parse(f.end_date)) errors.push('End date is not valid.');
  if (f.end_date && t.parse(f.first_due_date) && f.end_date < f.first_due_date) errors.push('End date is before the first due date.');
  if (!f.message) errors.push('Write the reminder message.');
  const unknown = unknownPlaceholders(f.message || '');
  if (unknown.length) errors.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{${u}}`).join(', ')}. Use ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}.`);
  if (/\{amount\}/.test(f.message || '') && !f.amount) errors.push('The message uses {amount}, so enter an amount (or remove {amount}).');
  return errors;
}

const DEFAULT_MESSAGE = 'Hi {name}, this is a reminder that your {title} of ₹{amount} is due {days_left} ({due_date}). Please pay on time 🙏';

module.exports = {
  normalizePhone, prettyPhone, dueDate, dueOnOrAfter, reminderOn, nextReminder,
  renderMessage, unknownPlaceholders, formatAmount, daysLeftText, shortDate,
  describeRepeat, describeEnd, PLACEHOLDERS, DEFAULT_MESSAGE, checkPeople, checkFields,
};
