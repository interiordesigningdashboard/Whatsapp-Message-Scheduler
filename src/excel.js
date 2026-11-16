// Export and import of payment reminders and birthdays as one standard Excel file.
// Used by the dashboard (Import / export page) and by scripts/export.js and scripts/import.js.
//
// The file has two sheets with fixed columns (see PAYMENT_COLS / BIRTHDAY_COLS) plus a "How to use" sheet.
// Import: rows with an ID update that item, rows without an ID are added, nothing is deleted unless
// `prune` is set. Rows with problems are reported and skipped; the other rows can still be imported.
const ExcelJS = require('exceljs');
const models = require('./models');
const pay = require('./payments');
const t = require('./time');
const { db } = require('./db');

const PAYMENT_SHEET = 'Payments';
const BIRTHDAY_SHEET = 'Birthdays';

const PAYMENT_COLS = [
  { key: 'id', header: 'ID', width: 7 },
  { key: 'title', header: 'Title', width: 30 },
  { key: 'message', header: 'Message', width: 55 },
  { key: 'amount', header: 'Amount', width: 13 },
  { key: 'repeats', header: 'Repeats', width: 15 },
  { key: 'every_n', header: 'Every N months', width: 10 },
  { key: 'first_due_date', header: 'First due date', width: 14 },
  { key: 'remind_days_before', header: 'Remind days before', width: 11 },
  { key: 'send_time', header: 'Send time', width: 10 },
  { key: 'end_count', header: 'End after payments', width: 11 },
  { key: 'end_date', header: 'End date', width: 14 },
  { key: 'send_to', header: 'Send to', width: 45 },
  { key: 'active', header: 'Active', width: 8 },
];

const BIRTHDAY_COLS = [
  { key: 'id', header: 'ID', width: 7 },
  { key: 'name', header: 'Name', width: 28 },
  { key: 'day', header: 'Day', width: 7 },
  { key: 'month', header: 'Month', width: 12 },
  { key: 'send_time', header: 'Send time', width: 10 },
  { key: 'groups', header: 'Groups', width: 55 },
  { key: 'active', header: 'Active', width: 8 },
];

const REPEATS = ['Monthly', 'Every N months', 'Yearly'];
const YES_NO = ['Yes', 'No'];

// ---------- Writing ----------

// Excel dates are written as UTC midnight so the calendar date is the same everywhere.
const excelDate = (ymd) => {
  const d = t.parse(ymd);
  return d ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) : null;
};

function repeatsLabel(every) {
  if (every === 1) return 'Monthly';
  if (every === 12) return 'Yearly';
  return 'Every N months';
}

function sendToText(recipients) {
  return recipients.map((r) => `${r.name} +${r.phone}`).join('; ');
}

function addSheet(wb, name, cols, rows, lists) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF128C4A' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  for (const r of rows) ws.addRow(r);
  ws.eachRow((row, i) => {
    if (i > 1) row.alignment = { vertical: 'top', wrapText: true };
  });
  for (const c of cols) {
    if (/date/i.test(c.key)) ws.getColumn(c.key).numFmt = 'dd-mm-yyyy';
    if (c.key === 'send_time') ws.getColumn(c.key).numFmt = '@'; // keep "10:00" as text
  }
  // Drop-down lists for fixed choices, for the existing rows and plenty of new ones.
  const last = Math.max(rows.length + 1, 500);
  for (const [key, values] of Object.entries(lists)) {
    const col = ws.getColumn(key).letter;
    for (let r = 2; r <= last; r++) {
      ws.getCell(`${col}${r}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`],
      };
    }
  }
  return ws;
}

function addHelpSheet(wb) {
  const ws = wb.addWorksheet('How to use');
  ws.getColumn(1).width = 110;
  const lines = [
    ['How to use this file', true],
    [''],
    ['Edit the Payments and Birthdays sheets, save, then import the file: dashboard > Import / export, or npm run import.'],
    ['Rows with an ID update that reminder or birthday. Leave ID empty to add a new one. Do not change IDs.'],
    ['Nothing is deleted unless you tick "Delete items not in the file" (or use --prune).'],
    ['Rows with a problem are listed in the preview and skipped; the other rows can still be imported.'],
    [''],
    ['Payments', true],
    ['Message: the text that is sent. Line breaks are kept. These are filled in automatically:'],
    ['   {title}  {amount}  {due_date}  {days_left} ("in 2 days", "tomorrow", "today")  {name} (the person it is sent to)'],
    ['Amount: numbers only, e.g. 5000. Needed if the message uses {amount}.'],
    ['Repeats: Monthly, Every N months (fill in "Every N months", e.g. 3 = quarterly, 6 = half-yearly) or Yearly.'],
    ['First due date: the due day is taken from it. Short months use their last day (the 31st becomes 28/29 Feb, 30 Apr).'],
    ['Remind days before: a reminder goes out every day from this many days before the due date until the due date. 0 = only on the due date.'],
    ['Send time: India time, like 10:00.'],
    ['End after payments / End date: optional. Leave both empty to repeat forever.'],
    ['Send to: one or more people as "Name +number", separated by ";". Example: Vivek +919962500387; Deepa akka +919962500404'],
    ['           10-digit numbers get +91 automatically. Each person gets their own private WhatsApp message.'],
    ['Active: Yes, or No to pause.'],
    [''],
    ['Birthdays', true],
    ['Day and Month: e.g. 9 and December (or 12). Sent every year; 29 February birthdays go on 28 February in other years.'],
    ['Groups: WhatsApp group names exactly as on the Groups & contacts page, separated by ";". Load groups there first.'],
    ['The yearly image and caption are not part of this file; add them on the Birthdays page.'],
  ];
  for (const [text, bold] of lines) {
    const row = ws.addRow([text]);
    if (bold) row.font = { bold: true, size: 13 };
  }
}

function paymentRow(p, { withIds }) {
  return {
    id: withIds ? p.id : null,
    title: p.title,
    message: p.message,
    amount: p.amount ? Number(p.amount) : null,
    repeats: repeatsLabel(p.every_months),
    every_n: p.every_months === 1 || p.every_months === 12 ? null : p.every_months,
    first_due_date: excelDate(p.first_due_date),
    remind_days_before: p.remind_days_before,
    send_time: p.send_time,
    end_count: p.end_count || null,
    end_date: p.end_date ? excelDate(p.end_date) : null,
    send_to: sendToText(p.recipients),
    active: p.active ? 'Yes' : 'No',
  };
}

function birthdayRow(b, names, { withIds }) {
  return {
    id: withIds ? b.id : null,
    name: b.name,
    day: b.birth_day,
    month: t.MONTHS[b.birth_month - 1],
    send_time: b.send_time,
    groups: b.groupIds.map((g) => names.get(g) || g).join('; '),
    active: b.active ? 'Yes' : 'No',
  };
}

// The workbook with everything in the app. `withIds: false` leaves IDs empty (to copy to another PC).
function buildWorkbook({ payments, birthdays, withIds = true } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WhatsApp Scheduler';
  wb.created = new Date();
  const names = models.groupNames();
  // In the order they were added (an import adds rows in file order), so the file keeps its order
  // through export -> edit -> import.
  const byId = (a, b) => (a.id || 0) - (b.id || 0);
  const pays = payments || models.listPayments().sort(byId);
  const bdays = birthdays || models.listBirthdays().sort(byId);
  addSheet(wb, PAYMENT_SHEET, PAYMENT_COLS, pays.map((p) => paymentRow(p, { withIds })), { repeats: REPEATS, active: YES_NO });
  addSheet(wb, BIRTHDAY_SHEET, BIRTHDAY_COLS, bdays.map((b) => birthdayRow(b, names, { withIds })), { month: t.MONTHS, active: YES_NO });
  addHelpSheet(wb);
  return wb;
}

// An empty file with one example row on each sheet.
function buildTemplate() {
  const example = {
    title: 'Car insurance TN10AB1234',
    message: '🚗 *Car insurance renewal*\n• Vehicle: TN10AB1234\n• Premium: ₹{amount}\n• Due date: {due_date}\n• Due: {days_left}',
    amount: '12500', every_months: 12, first_due_date: t.ymd(t.addDays(new Date(), 30)), remind_days_before: 2,
    send_time: '10:00', end_count: null, end_date: null, active: 1,
    recipients: [{ name: 'Name', phone: '919876543210' }],
  };
  const bday = { name: 'Name', birth_day: 9, birth_month: 12, send_time: '09:00', groupIds: ['Family group name'], active: 1 };
  return buildWorkbook({ payments: [example], birthdays: [bday], withIds: false });
}

// ---------- Reading ----------

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('error' in v) return null;
    if (Array.isArray(v.richText)) return cellValue(v.richText.map((r) => r.text).join(''));
    if ('text' in v) return cellValue(v.text);
    return null;
  }
  if (typeof v === 'string') {
    const s = v.replace(/\r\n?/g, '\n').trim();
    return s === '' ? null : s;
  }
  return v;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => (v === null || v === undefined ? '' : v instanceof Date ? t.ymd(v) : String(v).trim());

// Calendar date from an Excel date (UTC midnight) or text like 05-12-2026 / 05.12.2026 / 2026-12-05.
function readDate(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  if (v instanceof Date) return { value: t.ymd(new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())) };
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m.map(Number);
  else {
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
    if (!m) return { error: `"${s}" is not a date (use dd-mm-yyyy)` };
    [, d, mo, y] = m.map(Number);
  }
  const date = new Date(y, mo - 1, d);
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return { error: `"${s}" is not a valid date` };
  return { value: t.ymd(date) };
}

// "10:00", 10:00 typed as an Excel time, or a day fraction (0.41666 = 10:00).
function readTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const pad = (n) => String(n).padStart(2, '0');
  if (v instanceof Date) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const mins = Math.round(v * 24 * 60);
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  }
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(String(v).trim());
  if (!m) return String(v).trim();
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  return `${pad(h)}:${m[2]}`;
}

function readInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) ? n : NaN;
}

function readYesNo(v, fallback = true) {
  if (v === null || v === undefined || v === '') return fallback;
  const s = norm(v);
  if (['yes', 'y', 'true', '1', 'active'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'paused'].includes(s)) return false;
  return null;
}

// "Vivek +919962500387; Deepa akka +91 99625 00404" -> [{ name, phoneInput }]
function readPeople(v) {
  return String(v || '').split(/[;\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^(.*?)[\s,:=(-]*(\+?\d[\d\s-]{8,}\d)\)?$/.exec(part);
    return m ? { name: m[1].trim(), phoneInput: m[2] } : { name: part, phoneInput: '' };
  });
}

function sheetObjects(ws, cols) {
  const byHeader = {};
  ws.getRow(1).eachCell((cell, col) => { byHeader[norm(cellValue(cell.value))] = col; });
  const missing = cols.filter((c) => c.key !== 'id' && !(norm(c.header) in byHeader)).map((c) => c.header);
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const obj = { row: n };
    let any = false;
    for (const c of cols) {
      const col = byHeader[norm(c.header)];
      const v = col ? cellValue(row.getCell(col).value) : null;
      obj[c.key] = v;
      if (v !== null) any = true;
    }
    if (any) rows.push(obj);
  });
  return { rows, missing };
}

function readPaymentRow(r) {
  const errors = [];
  const id = readInt(r.id);
  if (Number.isNaN(id)) errors.push(`ID "${text(r.id)}" is not a number`);

  const repeatsText = norm(r.repeats);
  let every;
  if (['monthly', 'everymonth'].includes(repeatsText)) every = 1;
  else if (['yearly', 'everyyear', 'annual', 'annually'].includes(repeatsText)) every = 12;
  else if (['quarterly'].includes(repeatsText)) every = 3;
  else if (['halfyearly', 'halfyear'].includes(repeatsText)) every = 6;
  else if (repeatsText === 'everynmonths' || /^every\d+months?$/.test(repeatsText)) {
    const fromLabel = /^every(\d+)months?$/.exec(repeatsText);
    every = fromLabel ? Number(fromLabel[1]) : readInt(r.every_n);
    if (every === null) errors.push('Repeats is "Every N months" but "Every N months" is empty');
  } else errors.push(`Repeats must be Monthly, Every N months or Yearly (got "${text(r.repeats)}")`);

  const due = readDate(r.first_due_date);
  if (due.error) errors.push(`First due date: ${due.error}`);
  const end = readDate(r.end_date);
  if (end.error) errors.push(`End date: ${end.error}`);
  const amountRaw = text(r.amount).replace(/[,₹\s]/g, '');
  const active = readYesNo(r.active);
  if (active === null) errors.push(`Active must be Yes or No (got "${text(r.active)}")`);
  const remind = r.remind_days_before === null ? 2 : readInt(r.remind_days_before);

  const f = {
    title: text(r.title),
    message: text(r.message),
    amount: amountRaw,
    every_months: every,
    first_due_date: due.value || '',
    remind_days_before: remind,
    send_time: readTime(r.send_time) || '10:00',
    end_count: readInt(r.end_count),
    end_date: end.value || null,
    active: active ? 1 : 0,
  };
  if (Number.isNaN(f.end_count)) f.end_count = -1; // reported by checkFields
  f.recipients = pay.checkPeople(readPeople(r.send_to), errors);
  if (every !== undefined) errors.push(...pay.checkFields(f).filter((e) => !(due.error && /first due date/i.test(e))));
  return { row: r.row, id, fields: f, errors: [...new Set(errors)] };
}

function readBirthdayRow(r, groupsByName) {
  const errors = [];
  const id = readInt(r.id);
  if (Number.isNaN(id)) errors.push(`ID "${text(r.id)}" is not a number`);
  const name = text(r.name);
  if (!name) errors.push('Name is empty');
  const day = readInt(r.day);
  let month = readInt(r.month);
  if (month === null || Number.isNaN(month)) {
    const i = t.MONTHS.findIndex((m) => norm(m).startsWith(norm(r.month).slice(0, 3)) && norm(r.month).length >= 3);
    month = i >= 0 ? i + 1 : null;
  }
  if (!t.isValidMonthDay(month, day)) errors.push(`Day/Month "${text(r.day)} ${text(r.month)}" is not a valid date`);
  const sendTime = readTime(r.send_time) || '09:00';
  if (!t.isValidTime(sendTime)) errors.push(`Send time "${text(r.send_time)}" should look like 09:00`);
  const active = readYesNo(r.active);
  if (active === null) errors.push(`Active must be Yes or No (got "${text(r.active)}")`);

  const groupIds = [];
  const groupNames = String(r.groups || '').split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!groupNames.length) errors.push('Groups is empty');
  for (const g of groupNames) {
    if (/@g\.us$/.test(g)) { groupIds.push(g); continue; }
    const matches = groupsByName.get(g.toLowerCase()) || [];
    if (matches.length === 1) groupIds.push(matches[0]);
    else if (matches.length > 1) errors.push(`More than one group is called "${g}"`);
    else errors.push(`No WhatsApp group called "${g}" (load groups on the Groups & contacts page)`);
  }
  return {
    row: r.row, id,
    fields: { name, month, day, sendTime, active: active !== false, groupIds: [...new Set(groupIds)] },
    errors,
  };
}

// Reads an uploaded/exported file. Returns { payments: [...], birthdays: [...], problems: [...] }.
async function readWorkbook(source) {
  const wb = new ExcelJS.Workbook();
  try {
    if (Buffer.isBuffer(source)) await wb.xlsx.load(source);
    else await wb.xlsx.readFile(source);
  } catch (err) {
    throw new Error(`Could not open the file as an Excel workbook (.xlsx): ${err.message}`);
  }
  const problems = [];
  const find = (name) => wb.worksheets.find((ws) => norm(ws.name) === norm(name));
  const pws = find(PAYMENT_SHEET);
  const bws = find(BIRTHDAY_SHEET);
  if (!pws && !bws) {
    throw new Error('No "Payments" or "Birthdays" sheet found. Start from an exported file or the template.');
  }
  let payments = [];
  let birthdays = [];
  if (pws) {
    const { rows, missing } = sheetObjects(pws, PAYMENT_COLS);
    if (missing.length) problems.push(`Payments sheet is missing columns: ${missing.join(', ')}`);
    else payments = rows.map(readPaymentRow);
  }
  if (bws) {
    const { rows, missing } = sheetObjects(bws, BIRTHDAY_COLS);
    if (missing.length) problems.push(`Birthdays sheet is missing columns: ${missing.join(', ')}`);
    else {
      const groupsByName = new Map();
      for (const g of models.listGroups()) {
        const k = g.name.trim().toLowerCase();
        groupsByName.set(k, [...(groupsByName.get(k) || []), g.group_id]);
      }
      birthdays = rows.map((r) => readBirthdayRow(r, groupsByName));
    }
  }
  return { payments, birthdays, problems };
}

// ---------- Planning and applying ----------

const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function paymentComparable(p) {
  return {
    title: p.title, message: p.message, amount: p.amount || '', every_months: p.every_months,
    first_due_date: p.first_due_date, remind_days_before: p.remind_days_before, send_time: p.send_time,
    end_count: p.end_count || null, end_date: p.end_date || null, active: p.active ? 1 : 0,
    recipients: p.recipients.map((r) => [r.name, r.phone]),
  };
}

function birthdayComparable(b) {
  return {
    name: b.name, month: b.birth_month ?? b.month, day: b.birth_day ?? b.day, sendTime: b.send_time ?? b.sendTime,
    active: Boolean(b.active), groupIds: [...b.groupIds].sort(),
  };
}

// What an import would do. Nothing is changed.
function plan(parsed, { prune = false } = {}) {
  const result = {
    problems: parsed.problems,
    payments: { add: [], update: [], same: [], remove: [], errors: [] },
    birthdays: { add: [], update: [], same: [], remove: [], errors: [] },
  };
  const sections = [
    ['payments', parsed.payments, (id) => models.getPayment(id), models.listPayments, paymentComparable, (r) => r.fields.title],
    ['birthdays', parsed.birthdays, (id) => models.getBirthday(id), models.listBirthdays, birthdayComparable, (r) => r.fields.name],
  ];
  for (const [kind, rows, get, list, comparable, label] of sections) {
    const out = result[kind];
    const seenIds = new Set();
    for (const r of rows) {
      if (r.id) {
        if (seenIds.has(r.id)) r.errors.push(`ID ${r.id} appears more than once in the file`);
        seenIds.add(r.id);
      }
      if (r.errors.length) { out.errors.push({ row: r.row, label: label(r) || '(no name)', errors: r.errors }); continue; }
      if (!r.id) { out.add.push(r); continue; }
      const existing = get(r.id);
      if (!existing) {
        out.errors.push({ row: r.row, label: label(r), errors: [`ID ${r.id} does not exist here. Clear the ID to add it as new.`] });
        continue;
      }
      const incoming = kind === 'payments' ? paymentComparable(r.fields) : birthdayComparable(r.fields);
      if (sameJSON(comparable(existing), incoming)) out.same.push(r);
      else out.update.push({ ...r, before: existing });
    }
    // Only delete when every row could be read: a row with a problem keeps its item.
    if (prune && rows.length) {
      for (const item of list()) if (!seenIds.has(item.id)) out.remove.push(item);
    }
  }
  return result;
}

// Applies a plan from plan(). Returns counts.
function apply(p) {
  const counts = { payments: { added: 0, updated: 0, removed: 0 }, birthdays: { added: 0, updated: 0, removed: 0 } };
  db.transaction(() => {
    for (const r of p.payments.add) { models.createPayment(r.fields); counts.payments.added += 1; }
    for (const r of p.payments.update) { models.updatePayment(r.id, r.fields); counts.payments.updated += 1; }
    for (const item of p.payments.remove) { models.deletePayment(item.id); counts.payments.removed += 1; }

    for (const r of p.birthdays.add) {
      const f = r.fields;
      models.createBirthday({ name: f.name, month: f.month, day: f.day, sendTime: f.sendTime, active: f.active }, f.groupIds);
      counts.birthdays.added += 1;
    }
    for (const r of p.birthdays.update) {
      const f = r.fields;
      models.updateBirthday(r.id, { name: f.name, month: f.month, day: f.day, sendTime: f.sendTime, active: f.active }, f.groupIds);
      counts.birthdays.updated += 1;
    }
    for (const item of p.birthdays.remove) { models.deleteBirthday(item.id); counts.birthdays.removed += 1; }
  })();
  // Image/caption already added for a birthday whose date changed moves to its new date.
  const grace = Number(require('./db').getSettings().grace_minutes);
  for (const r of p.birthdays.update) {
    const b = models.getBirthday(r.id);
    if (b && b.next_for_date) {
      const next = models.nextOccurrence(b, new Date(), grace);
      if (next && next.dateStr !== b.next_for_date) {
        models.setBirthdayContent(b.id, { imageFile: null, caption: b.next_caption, forDate: next.dateStr });
      }
    }
  }
  return counts;
}

function summary(p) {
  const line = (name, s) => `${name}: ${s.add.length} new, ${s.update.length} changed, ${s.same.length} unchanged`
    + `${s.remove.length ? `, ${s.remove.length} to delete` : ''}${s.errors.length ? `, ${s.errors.length} with problems (skipped)` : ''}`;
  return [line('Payments', p.payments), line('Birthdays', p.birthdays)];
}

module.exports = { buildWorkbook, buildTemplate, readWorkbook, plan, apply, summary, PAYMENT_COLS, BIRTHDAY_COLS };
