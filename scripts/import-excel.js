#!/usr/bin/env node
// Creates payment reminders from the "VEHICLE INSURANCE DETAILS" Excel workbook.
//
//   node scripts/import-excel.js <file.xlsx> --to "Vivek=+91 99625 00387" --to "Deepa akka=+91 99625 00404"
//        [--time 10:00] [--days 2] [--apply] [--prune]
//
// Without --apply nothing is saved: it only shows what would be created.
//   --to      a person to remind, "Name=number" (repeat for each person)
//   --time    send time, India time (default 10:00)
//   --days    start reminding this many days before each due date, then every day until it (default 2)
//   --apply   save to the app's database (the app picks the reminders up within a minute)
//   --prune   also delete reminders made by an earlier import whose row is no longer in the Excel
//
// Running it again after editing the Excel updates the reminders it made before (no duplicates).
// Reminders you paused in the dashboard stay paused.
//
// Sheets are recognised by their column headers:
//   VEHICLE NO. + INSURANCE EXPIRY DATE (+ COMPANY NAME)   -> two-wheeler / car insurance, yearly
//   Policy No. + Premium Mode + TEAMS                       -> insurance premiums (yearly, half-yearly, quarterly)
//   EMI Date                                                -> monthly / yearly dues, SIPs, bills
//   Particulars + Amount + Account                          -> monthly loan commitments
// Full account numbers and password columns are never read or put in messages.

const path = require('path');
require('../src/config'); // India time zone; DATA_DIR
const ExcelJS = require('exceljs');
const t = require('../src/time');
const pay = require('../src/payments');

// ---------- Command line ----------

function parseArgs(argv) {
  const args = { file: null, to: [], time: '10:00', days: 2, apply: false, prune: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') args.to.push(argv[++i]);
    else if (a === '--time') args.time = argv[++i];
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--apply') args.apply = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.file) args.file = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function parseRecipients(list) {
  return list.map((s) => {
    const m = /^(.+?)\s*=\s*(.+)$/.exec(s || '');
    if (!m) throw new Error(`--to must look like "Name=+91 98765 43210", got: ${s}`);
    const phone = pay.normalizePhone(m[2]);
    if (!phone) throw new Error(`Not a valid number for ${m[1]}: ${m[2]}`);
    return { name: m[1].trim(), phone };
  });
}

// ---------- Reading cells ----------

// Plain value of a cell: string (trimmed), number, Date (calendar date), or null.
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    // Excel dates come as UTC midnight; keep the calendar date.
    return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  }
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('error' in v) return null;
    if (Array.isArray(v.richText)) return cellValue(v.richText.map((r) => r.text).join(''));
    if ('text' in v) return cellValue(v.text);
    return null;
  }
  if (typeof v === 'string') {
    const s = v.replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
  }
  return v;
}

function sheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => { cells[col] = cellValue(cell.value); });
    if (cells.some((c) => c !== null && c !== undefined)) rows.push(cells);
  });
  return rows;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Find the header row that has all `required` labels; returns { index, cols: { label: column } }.
function findHeader(rows, required, optional = []) {
  for (let i = 0; i < rows.length; i++) {
    const map = {};
    rows[i].forEach((c, col) => { if (typeof c === 'string') map[norm(c)] = col; });
    if (required.every((r) => norm(r) in map)) {
      const cols = {};
      for (const label of [...required, ...optional]) if (norm(label) in map) cols[label] = map[norm(label)];
      return { index: i, cols };
    }
  }
  return null;
}

// A row whose cells all hold the same text (a merged heading cell, e.g. a policy holder's name).
function mergedHeading(r) {
  const vals = r.filter((v) => v !== null && v !== undefined);
  return vals.length && typeof vals[0] === 'string' && vals.every((v) => v === vals[0]) ? vals[0] : null;
}

// Text for a message line: no braces (they are template placeholders).
const clean = (v) => (v === null || v === undefined ? '' : String(v).replace(/[{}]/g, '').trim());

// ---------- Dates in free text ----------

const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function monthsIn(text) {
  return [...String(text || '').matchAll(MONTH_RE)].map((m) => MONTH_INDEX[m[1].toLowerCase()]);
}

function dayIn(text) {
  const m = /(\d{1,2})\s*(st|nd|rd|th)?\b/i.exec(String(text || ''));
  const d = m ? Number(m[1]) : null;
  return d >= 1 && d <= 31 ? d : null;
}

// Date objects, or text like 25.04.2026 / 25-04-2026 / 25/04/2026.
function toDate(v) {
  if (v instanceof Date) return v;
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(v || '').trim());
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

// First due date for a series: the given day in the given month, in a past year, so the series is already running.
// The day is kept (e.g. the 31st), so short months fall on their last day.
function anchor(month, day) {
  const year = new Date().getFullYear() - 1;
  return t.ymd(new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())));
}

// For monthly items: January has 31 days, so any due day is kept as is.
const monthlyAnchor = (day) => anchor(0, day);

// ---------- Messages ----------

const lines = (...ls) => ls.filter(Boolean).join('\n');
const DUE_LINES = ['• Due date: {due_date}', '• Due: {days_left}'];

const MODE_NAME = { 1: 'monthly', 3: 'quarterly', 6: 'half-yearly', 12: 'yearly' };

// ---------- Sheet readers ----------
// Each returns { items: [...], skipped: [{ row, reason }] }.
// item: { key, sheet, title, message, amount, every_months, first_due_date, end_date }

function readVehicles(ws, rows) {
  const h = findHeader(rows, ['VEHICLE NO.', 'INSURANCE EXPIRY DATE'], ['NAME', 'MODEL', 'COMPANY NAME']);
  if (!h) return null;
  const isCar = 'COMPANY NAME' in h.cols || /car/i.test(ws.name);
  const items = [];
  const skipped = [];
  for (const r of rows.slice(h.index + 1)) {
    const vehicle = clean(r[h.cols['VEHICLE NO.']]);
    const expiryRaw = r[h.cols['INSURANCE EXPIRY DATE']];
    if (!vehicle && !expiryRaw) continue;
    const expiry = toDate(expiryRaw);
    if (!vehicle || !expiry) { skipped.push({ row: vehicle || clean(r[h.cols.NAME]), reason: `no vehicle number or unreadable expiry date (${clean(expiryRaw)})` }); continue; }
    const model = clean(r[h.cols.MODEL]);
    const owner = clean(r[h.cols.NAME]);
    const company = clean(r[h.cols['COMPANY NAME']]);
    items.push({
      key: `${isCar ? 'car' : '2w'}:${norm(vehicle)}`,
      sheet: ws.name.trim(),
      title: `${isCar ? 'Car' : '2W'} insurance ${vehicle}`,
      message: lines(
        isCar ? '🚗 *Car insurance renewal*' : '🛵 *Two-wheeler insurance renewal*',
        `• Vehicle: ${vehicle}${model ? ` (${model})` : ''}`,
        owner && `• Owner: ${owner}`,
        company && `• Company: ${company}`,
        '• Expiry date: {due_date}',
        '• Due: {days_left}',
      ),
      amount: '',
      every_months: 12,
      first_due_date: t.ymd(expiry),
      end_date: null,
    });
  }
  return { items, skipped };
}

function readPolicies(ws, rows) {
  const h = findHeader(rows, ['Insurer', 'Product', 'Policy No.'],
    ['Start Date', 'PremiumTerm', 'Premium Mode', 'Premium Amount', 'TEAMS']);
  if (!h) return null;
  const c = h.cols;
  const items = [];
  const skipped = [];
  let holder = '';
  for (const r of rows.slice(h.index + 1)) {
    const merged = mergedHeading(r);
    if (merged) { holder = clean(merged); continue; }
    const insurer = clean(r[c.Insurer]);
    const product = clean(r[c.Product]);
    const policyNo = clean(r[c['Policy No.']]);
    const dueText = clean(r[c.TEAMS]);
    const amount = r[c['Premium Amount']];
    // A row with only a name is the policy holder for the rows below it.
    if (insurer && !product && !policyNo && !dueText && amount == null) { holder = insurer; continue; }
    if (!insurer && !product) continue;
    const label = `${insurer} ${product}`.trim() + (policyNo ? ` ${policyNo}` : '');
    if (/full\s*premium\s*paid/i.test(dueText)) { skipped.push({ row: label, reason: 'full premium paid' }); continue; }

    const start = toDate(r[c['Start Date']]);
    let months = monthsIn(dueText);
    const modeCell = clean(r[c['Premium Mode']]).toUpperCase();
    let every = { M: 1, Q: 3, H: 6, Y: 12 }[modeCell] || null;
    if (months.length > 1) every = 12 / months.length;
    else if (/every\s*year/i.test(dueText) || months.length === 1) every = every || 12;
    if (!every || !Number.isInteger(every)) { skipped.push({ row: label, reason: `cannot tell how often it is due ("${dueText}")` }); continue; }
    if (!months.length && every === 12 && start) months = [start.getMonth()];
    const day = dayIn(dueText) || (start && start.getDate());
    if (!months.length || !day) { skipped.push({ row: label, reason: `cannot read the due date ("${dueText}")` }); continue; }
    months = [...new Set(months)].sort((a, b) => a - b);
    const gaps = months.map((m, i) => ((months[(i + 1) % months.length] - m + 12) % 12) || 12);
    if (months.length > 1 && gaps.some((g) => g !== every)) {
      skipped.push({ row: label, reason: `months in "${dueText}" are not evenly spaced` }); continue;
    }

    // Last premium: start date + premium term (years).
    const term = Number(r[c.PremiumTerm]);
    let endDate = null;
    if (start && Number.isInteger(term) && term > 0) {
      endDate = t.ymd(new Date(start.getFullYear() + term, start.getMonth(), start.getDate() - 1));
    }
    const amountText = typeof amount === 'number' ? String(amount) : '';
    const holderName = holder; // the message is built later; keep this row's holder
    items.push({
      key: policyNo ? `ins:${norm(policyNo)}` : `ins:${norm(holderName)}|${norm(insurer)}|${norm(product)}|${amountText}|${day}`,
      sheet: ws.name.trim(),
      title: `${product || insurer}${policyNo ? ` ${policyNo}` : ''}`,
      message: (count) => lines(
        '🛡️ *Insurance premium*',
        `• Policy: ${[insurer, product].filter(Boolean).join(' – ')}`,
        policyNo && `• Policy no: ${policyNo}`,
        holderName && `• Policy holder: ${holderName}`,
        amountText && (count > 1
          ? `• Premium: ₹{amount} each, ${count} policies (${MODE_NAME[every] || `every ${every} months`})`
          : `• Premium: ₹{amount} (${MODE_NAME[every] || `every ${every} months`})`),
        ...DUE_LINES,
      ),
      amount: amountText,
      every_months: every,
      first_due_date: anchor(months[0], day),
      end_date: endDate,
    });
  }
  return { items, skipped };
}

function readDues(ws, rows) {
  const h = findHeader(rows, ['NAME', 'EMI Date'], ['S.NO :', 'Type', 'A/C', 'EMI Value']);
  if (!h) return null;
  const c = h.cols;
  const sno = c['S.NO :'];
  const items = [];
  const skipped = [];
  let heading = '';
  for (const r of rows.slice(h.index + 1)) {
    const name = clean(r[c.NAME]);
    const type = clean(r[c.Type]);
    const dateText = clean(r[c['EMI Date']]);
    const hasNo = sno !== undefined && r[sno] !== null && r[sno] !== undefined;
    if (!name && !dateText) continue;
    if (!dateText) {
      // A numbered row without a date is a heading (a person, or a group like "TDS Filing Due Date").
      if (hasNo || name) heading = name;
      continue;
    }
    if (hasNo) heading = ''; // a numbered row with its own date stands alone
    const day = dayIn(dateText);
    const months = monthsIn(dateText);
    if (!day) { skipped.push({ row: name, reason: `cannot read the due day ("${dateText}")` }); continue; }
    const yearly = months.length === 1;
    if (months.length > 1) { skipped.push({ row: name, reason: `several months in "${dateText}"` }); continue; }
    const account = clean(r[c['A/C']]); // the account name only, never the account number column
    const value = r[c['EMI Value']];
    const amountText = typeof value === 'number' ? String(value) : '';
    const forPerson = heading && amountText;
    const title = forPerson || !heading
      ? `${name}${type ? ` (${type})` : ''}`
      : `${heading} – ${name}${type ? ` (${type})` : ''}`;
    items.push({
      key: `due:${norm(heading)}|${norm(name)}|${norm(type)}|${norm(account)}|${day}|${yearly ? months[0] : 'm'}`,
      sheet: ws.name.trim(),
      title: forPerson ? `${name} (${heading})` : title,
      message: lines(
        `📌 *${title}*`,
        forPerson && `• For: ${heading}`,
        amountText && '• Amount: ₹{amount}',
        account && `• Account: ${account}`,
        ...DUE_LINES,
      ),
      amount: amountText,
      every_months: yearly ? 12 : 1,
      first_due_date: yearly ? anchor(months[0], day) : monthlyAnchor(day),
      end_date: null,
    });
  }
  return { items, skipped };
}

function readLoans(ws, rows) {
  if (!findHeader(rows, ['Date', 'Particulars', 'Amount'])) return null;
  const items = [];
  const skipped = [];
  let company = '';
  let cols = null;
  for (const r of rows) {
    const texts = r.map((v) => (typeof v === 'string' ? v : null));
    const titleCell = texts.find((v) => v && /every\s*month/i.test(v));
    if (titleCell) { company = titleCell.replace(/\s*-?\s*every\s*month.*$/i, '').trim(); continue; }
    const header = findHeader([r], ['Date', 'Particulars', 'Amount'], ['Account']);
    if (header) { cols = header.cols; continue; }
    if (!cols) continue;
    const dateText = clean(r[cols.Date]);
    const what = clean(r[cols.Particulars]);
    if (!what || /^total$/i.test(dateText)) continue;
    const day = dayIn(dateText);
    if (!day) { skipped.push({ row: what, reason: `cannot read the due day ("${dateText}")` }); continue; }
    const value = r[cols.Amount];
    const amountText = typeof value === 'number' ? String(value) : '';
    const account = clean(r[cols.Account]);
    items.push({
      key: `loan:${norm(company)}|${norm(what)}|${day}|${norm(account)}`,
      sheet: ws.name.trim(),
      title: `${what} (${[company, account].filter(Boolean).join(', ') || 'loan'})`,
      message: lines(
        `🏦 *Loan / EMI: ${what}*`,
        company && `• Company: ${company}`,
        amountText && '• Amount: ₹{amount}',
        account && `• Account: ${account}`,
        ...DUE_LINES,
      ),
      amount: amountText,
      every_months: 1,
      first_due_date: monthlyAnchor(day),
      end_date: null,
    });
  }
  return { items, skipped };
}

const READERS = [readVehicles, readPolicies, readDues, readLoans];

// ---------- Main ----------

async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const items = [];
  const report = [];
  wb.eachSheet((ws) => {
    const rows = sheetRows(ws);
    for (const read of READERS) {
      const res = read(ws, rows);
      if (res) {
        items.push(...res.items);
        report.push({ sheet: ws.name.trim(), count: res.items.length, skipped: res.skipped });
        return;
      }
    }
    report.push({ sheet: ws.name.trim(), count: 0, skipped: [{ row: '(whole sheet)', reason: 'layout not recognised' }] });
  });

  // Identical rows (e.g. three identical policies without numbers) become one reminder.
  const byKey = new Map();
  for (const it of items) {
    const prev = byKey.get(it.key);
    if (prev) prev.count += 1;
    else byKey.set(it.key, { ...it, count: 1 });
  }
  const merged = [...byKey.values()].map((it) => ({
    ...it,
    message: typeof it.message === 'function' ? it.message(it.count) : it.message,
  }));
  return { items: merged, report };
}

function upcomingVolume(payments, days) {
  const perDay = new Map();
  const today = t.startOfDay(new Date());
  for (let i = 0; i < days; i++) {
    const day = t.addDays(today, i);
    const n = payments.filter((p) => pay.reminderOn(p, day)).length;
    if (n) perDay.set(t.ymd(day), n);
  }
  return perDay;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(args.help ? 0 : 1);
  }
  const recipients = parseRecipients(args.to);
  if (!recipients.length) throw new Error('Give at least one --to "Name=number"');
  if (!t.isValidTime(args.time)) throw new Error('--time must look like 10:00');
  if (!Number.isInteger(args.days) || args.days < 0 || args.days > 30) throw new Error('--days must be 0 to 30');

  const { items, report } = await readWorkbook(path.resolve(args.file));

  console.log(`\nRead ${path.basename(args.file)}:`);
  for (const r of report) {
    console.log(`  ${r.sheet}: ${r.count} reminder${r.count === 1 ? '' : 's'}`);
    for (const s of r.skipped) console.log(`     skipped ${s.row}: ${s.reason}`);
  }

  const now = new Date();
  const planned = items.map((it) => ({
    ...it,
    remind_days_before: args.days,
    send_time: args.time,
    every_months: it.every_months,
    end_count: null,
    recipients,
    active: 1,
    created_at: t.ymdhms(now),
  }));

  console.log(`\n${planned.length} reminders, each to ${recipients.map((r) => `${r.name} (${pay.prettyPhone(r.phone)})`).join(' and ')}, at ${args.time}, from ${args.days} day(s) before the due date:\n`);
  const sorted = [...planned].sort((a, b) => {
    const da = pay.dueOnOrAfter(a, now); const db = pay.dueOnOrAfter(b, now);
    return (da ? da.date : Infinity) - (db ? db.date : Infinity);
  });
  for (const p of sorted) {
    const next = pay.dueOnOrAfter(p, now);
    const when = next ? pay.shortDate(next.date) : 'ended';
    const amt = p.amount ? ` ₹${pay.formatAmount(p.amount)}` : '';
    console.log(`  ${when.padEnd(12)} ${(MODE_NAME[p.every_months] || `every ${p.every_months} months`).padEnd(11)} ${p.title}${amt}${p.count > 1 ? ` (×${p.count})` : ''}${p.end_date ? `, until ${pay.shortDate(t.parse(p.end_date))}` : ''}`);
  }

  const sample = sorted.find((p) => pay.dueOnOrAfter(p, now)) || sorted[0];
  if (sample) {
    const d = pay.dueOnOrAfter(sample, now);
    console.log(`\nExample message (${sample.title}, ${args.days} day(s) before):\n`);
    console.log(pay.renderMessage(sample, d ? d.date : now, args.days).replace(/^/gm, '    '));
  }

  const volume = upcomingVolume(planned, 30);
  const busiest = [...volume.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = [...volume.values()].reduce((a, b) => a + b, 0);
  console.log(`\nNext 30 days: ${total} messages to each person (${total * recipients.length} in all).`);
  if (busiest.length) console.log(`Busiest days: ${busiest.map(([d, n]) => `${pay.shortDate(t.parse(d))}: ${n}`).join(', ')} (per person)`);

  if (!args.apply) {
    console.log('\nNothing saved (dry run). Add --apply to create these reminders.\n');
    return;
  }

  // Load the database only when saving.
  const models = require('../src/models');
  let created = 0;
  let updated = 0;
  for (const p of planned) {
    const fields = {
      title: p.title, amount: p.amount, every_months: p.every_months, first_due_date: p.first_due_date,
      remind_days_before: p.remind_days_before, send_time: p.send_time, end_count: null, end_date: p.end_date,
      message: p.message, active: 1, recipients: p.recipients,
    };
    const existing = models.getPaymentByImportKey(p.key);
    if (existing) {
      models.updatePayment(existing.id, { ...fields, active: existing.active }); // keep paused ones paused
      updated += 1;
    } else {
      const id = models.createPayment(fields);
      models.setPaymentImportKey(id, p.key);
      created += 1;
    }
  }
  let removed = 0;
  if (args.prune) {
    const keys = new Set(planned.map((p) => p.key));
    for (const old of models.importedPayments()) {
      if (!keys.has(old.import_key)) { models.deletePayment(old.id); removed += 1; }
    }
  }
  console.log(`\nSaved: ${created} new, ${updated} updated${args.prune ? `, ${removed} removed` : ''}. Open the Payments page to see them.\n`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
});
