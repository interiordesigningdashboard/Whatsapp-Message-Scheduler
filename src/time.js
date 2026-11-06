// Date/time helpers. process.env.TZ is set to Asia/Kolkata in config.js,
// so plain Date getters (getHours, getDate, ...) are India time.

const pad = (n) => String(n).padStart(2, '0');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ymdhm(d) {
  return `${ymd(d)} ${hm(d)}`;
}

function ymdhms(d) {
  return `${ymdhm(d)}:${pad(d.getSeconds())}`;
}

// 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DDTHH:MM' -> Date (local time)
function parse(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

// 'HH:MM' on the given day
function atTime(day, time) {
  const [h, m] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// The day a birthday falls on in a given year. Feb 29 birthdays use Feb 28 in non-leap years.
function birthdayInYear(month, day, year) {
  if (month === 2 && day === 29 && !isLeapYear(year)) return new Date(year, 1, 28);
  return new Date(year, month - 1, day);
}

function isValidMonthDay(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(2024, month, 0).getDate(); // 2024 is a leap year, so Feb 29 is allowed
}

function isValidTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
}

function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "Mon, 12 Nov 2026" (built by hand so it looks the same on every PC)
function prettyDate(d) {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

// "Mon, 12 Nov 2026, 09:00"
function prettyDateTime(d) {
  return `${prettyDate(d)}, ${hm(d)}`;
}

module.exports = {
  MONTHS, ymd, hm, ymdhm, ymdhms, parse, startOfDay, addDays, atTime,
  isLeapYear, birthdayInYear, isValidMonthDay, isValidTime, daysBetween,
  prettyDate, prettyDateTime,
};
