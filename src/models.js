// Database queries used by the routes and the scheduler.
const { db } = require('./db');
const t = require('./time');
const uploads = require('./uploads');

// ---------- WhatsApp groups ----------

function listGroups() {
  return db.prepare('SELECT * FROM wa_groups ORDER BY name COLLATE NOCASE').all();
}

function groupNames() {
  return new Map(listGroups().map((g) => [g.group_id, g.name]));
}

// Replace the cached group list with what WhatsApp returned.
function saveGroups(groups) {
  const now = t.ymdhms(new Date());
  db.transaction(() => {
    db.prepare('DELETE FROM wa_groups').run();
    const ins = db.prepare(`INSERT INTO wa_groups (group_id, name, participants_count, admins_only, last_synced_at)
                            VALUES (?, ?, ?, ?, ?)`);
    for (const g of groups) ins.run(g.groupId, g.name, g.participantsCount, g.adminsOnly ? 1 : 0, now);
  })();
}

// ---------- Birthdays ----------

function birthdayGroupIds(id) {
  return db.prepare('SELECT group_id FROM birthday_groups WHERE birthday_id = ?').all(id).map((r) => r.group_id);
}

function getBirthday(id) {
  const b = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(id);
  if (b) b.groupIds = birthdayGroupIds(id);
  return b;
}

function listBirthdays() {
  const rows = db.prepare('SELECT * FROM birthdays ORDER BY name COLLATE NOCASE').all();
  for (const b of rows) b.groupIds = birthdayGroupIds(b.id);
  return rows;
}

function setBirthdayGroups(id, groupIds) {
  db.prepare('DELETE FROM birthday_groups WHERE birthday_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO birthday_groups (birthday_id, group_id) VALUES (?, ?)');
  for (const g of groupIds) ins.run(id, g);
}

function createBirthday({ name, month, day, sendTime, active }, groupIds) {
  const now = t.ymdhms(new Date());
  return db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO birthdays
      (name, birth_month, birth_day, send_time, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name, month, day, sendTime, active ? 1 : 0, now, now);
    setBirthdayGroups(lastInsertRowid, groupIds);
    return Number(lastInsertRowid);
  })();
}

function updateBirthday(id, { name, month, day, sendTime, active }, groupIds) {
  db.transaction(() => {
    db.prepare(`UPDATE birthdays SET name = ?, birth_month = ?, birth_day = ?, send_time = ?, active = ?, updated_at = ?
                WHERE id = ?`).run(name, month, day, sendTime, active ? 1 : 0, t.ymdhms(new Date()), id);
    setBirthdayGroups(id, groupIds);
  })();
}

function deleteBirthday(id) {
  const b = getBirthday(id);
  if (!b) return;
  db.prepare('DELETE FROM birthdays WHERE id = ?').run(id);
  uploads.remove(b.next_image_path);
}

// Content (image + caption) for one specific upcoming birthday date.
function setBirthdayContent(id, { imageFile, caption, forDate }) {
  const b = getBirthday(id);
  if (imageFile && b.next_image_path && b.next_image_path !== imageFile) uploads.remove(b.next_image_path);
  db.prepare(`UPDATE birthdays SET next_image_path = ?, next_caption = ?, next_for_date = ?, updated_at = ? WHERE id = ?`)
    .run(imageFile || b.next_image_path, caption || null, forDate, t.ymdhms(new Date()), id);
}

// Delete this year's image and caption (after the birthday is sent or missed, or by hand).
function clearBirthdayContent(id) {
  const b = getBirthday(id);
  if (!b) return;
  uploads.remove(b.next_image_path);
  db.prepare(`UPDATE birthdays SET next_image_path = NULL, next_caption = NULL, next_for_date = NULL, updated_at = ? WHERE id = ?`)
    .run(t.ymdhms(new Date()), id);
}

function birthdayLogRows(id, dateStr) {
  return db.prepare(`SELECT * FROM send_log WHERE job_type = 'birthday' AND job_id = ? AND scheduled_for LIKE ?`)
    .all(id, `${dateStr}%`);
}

// The next birthday that has not been handled yet (not sent / failed / missed),
// whose send time has not passed by more than the grace period.
function nextOccurrence(b, now, graceMinutes) {
  const created = t.parse(b.created_at);
  for (let y = now.getFullYear(); y <= now.getFullYear() + 2; y++) {
    const date = t.birthdayInYear(b.birth_month, b.birth_day, y);
    const dateStr = t.ymd(date);
    const scheduledAt = t.atTime(date, b.send_time);
    if (scheduledAt.getTime() + graceMinutes * 60000 < now.getTime()) continue;
    if (created && scheduledAt < created) continue;
    if (birthdayLogRows(b.id, dateStr).length) continue;
    return { date, dateStr, scheduledAt };
  }
  return null;
}

function hasContentFor(b, dateStr) {
  return b.next_for_date === dateStr && Boolean(b.next_image_path || b.next_caption);
}

// ---------- One-off messages ----------

function messageGroupIds(id) {
  return db.prepare('SELECT group_id FROM scheduled_message_groups WHERE message_id = ?').all(id).map((r) => r.group_id);
}

function getMessage(id) {
  const m = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  if (m) m.groupIds = messageGroupIds(id);
  return m;
}

function listMessages() {
  const rows = db.prepare(`SELECT * FROM scheduled_messages
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE status WHEN 'pending' THEN send_at END ASC,
             send_at DESC`).all();
  for (const m of rows) m.groupIds = messageGroupIds(m.id);
  return rows;
}

function pendingMessages() {
  const rows = db.prepare(`SELECT * FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at`).all();
  for (const m of rows) m.groupIds = messageGroupIds(m.id);
  return rows;
}

function setMessageGroups(id, groupIds) {
  db.prepare('DELETE FROM scheduled_message_groups WHERE message_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO scheduled_message_groups (message_id, group_id) VALUES (?, ?)');
  for (const g of groupIds) ins.run(id, g);
}

function createMessage({ title, sendAt, imageFile, caption }, groupIds) {
  return db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO scheduled_messages (title, send_at, image_path, caption, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(title, sendAt, imageFile || null, caption || null, t.ymdhms(new Date()));
    setMessageGroups(lastInsertRowid, groupIds);
    return Number(lastInsertRowid);
  })();
}

function updateMessage(id, { title, sendAt, imageFile, removeImage, caption }, groupIds) {
  const m = getMessage(id);
  let image = m.image_path;
  if (imageFile || removeImage) {
    uploads.remove(m.image_path);
    image = imageFile || null;
  }
  db.transaction(() => {
    db.prepare('UPDATE scheduled_messages SET title = ?, send_at = ?, image_path = ?, caption = ? WHERE id = ?')
      .run(title, sendAt, image, caption || null, id);
    setMessageGroups(id, groupIds);
  })();
}

// Mark a one-off message finished (done or cancelled) and delete its image.
function finishMessage(id, status) {
  const m = getMessage(id);
  if (!m) return;
  uploads.remove(m.image_path);
  db.prepare('UPDATE scheduled_messages SET status = ?, image_path = NULL WHERE id = ?').run(status, id);
}

function deleteMessage(id) {
  const m = getMessage(id);
  if (!m) return;
  uploads.remove(m.image_path);
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
}

function messageLogRows(id) {
  return db.prepare(`SELECT * FROM send_log WHERE job_type = 'oneoff' AND job_id = ?`).all(id);
}

// ---------- Payment reminders ----------

// People a payment reminder goes to: [{ name, phone }], in the order they were added.
function paymentRecipients(id) {
  return db.prepare('SELECT name, phone FROM payment_recipients WHERE payment_id = ? ORDER BY position, rowid').all(id)
    .map((r) => ({ name: r.name, phone: r.phone }));
}

function listPayments() {
  const rows = db.prepare('SELECT * FROM payments ORDER BY title COLLATE NOCASE').all();
  for (const p of rows) p.recipients = paymentRecipients(p.id);
  return rows;
}

function getPayment(id) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (p) p.recipients = paymentRecipients(id);
  return p;
}

function setPaymentRecipients(id, recipients) {
  db.prepare('DELETE FROM payment_recipients WHERE payment_id = ?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO payment_recipients (payment_id, name, phone, position) VALUES (?, ?, ?, ?)');
  recipients.forEach((r, i) => ins.run(id, r.name, r.phone, i));
}

const PAYMENT_FIELDS = ['title', 'person_name', 'phone', 'amount', 'every_months', 'first_due_date',
  'remind_days_before', 'send_time', 'end_count', 'end_date', 'message', 'active'];

// f.recipients: [{ name, phone }], at least one. The first is also stored in payments.person_name/phone.
function createPayment(f) {
  const now = t.ymdhms(new Date());
  const row = { ...f, person_name: f.recipients[0].name, phone: f.recipients[0].phone };
  return db.transaction(() => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO payments (${PAYMENT_FIELDS.join(', ')}, created_at, updated_at)
      VALUES (${PAYMENT_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
      .run(...PAYMENT_FIELDS.map((k) => row[k]), now, now);
    setPaymentRecipients(Number(lastInsertRowid), f.recipients);
    return Number(lastInsertRowid);
  })();
}

function updatePayment(id, f) {
  const row = { ...f, person_name: f.recipients[0].name, phone: f.recipients[0].phone };
  db.transaction(() => {
    db.prepare(`UPDATE payments SET ${PAYMENT_FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...PAYMENT_FIELDS.map((k) => row[k]), t.ymdhms(new Date()), id);
    setPaymentRecipients(id, f.recipients);
  })();
}

function deletePayment(id) {
  db.prepare('DELETE FROM payments WHERE id = ?').run(id);
}

// Log rows of one reminder (one row per person).
function paymentLogRows(id, scheduledFor) {
  return db.prepare(`SELECT * FROM send_log WHERE job_type = 'payment' AND job_id = ? AND scheduled_for = ?`)
    .all(id, scheduledFor);
}

// ---------- WhatsApp contacts ----------

function listContacts() {
  return db.prepare('SELECT * FROM wa_contacts ORDER BY name COLLATE NOCASE').all();
}

function saveContacts(contacts) {
  const now = t.ymdhms(new Date());
  db.transaction(() => {
    db.prepare('DELETE FROM wa_contacts').run();
    const ins = db.prepare('INSERT OR IGNORE INTO wa_contacts (phone, name, last_synced_at) VALUES (?, ?, ?)');
    for (const c of contacts) ins.run(c.phone, c.name, now);
  })();
}

// ---------- Send log ----------

// Returns true if the row was written (false if this group was already logged for this send).
function addLog({ jobType, jobId, jobLabel, groupId, groupName, scheduledFor, status, error }) {
  const r = db.prepare(`INSERT OR IGNORE INTO send_log
    (job_type, job_id, job_label, group_id, group_name, scheduled_for, status, error, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(jobType, jobId, jobLabel, groupId, groupName || null, scheduledFor, status, error || null, t.ymdhms(new Date()));
  return r.changes > 0;
}

function history({ status, q, from, to, limit = 300 }) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) { where.push('(job_label LIKE ? OR group_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (from) { where.push('scheduled_for >= ?'); args.push(from); }
  if (to) { where.push('scheduled_for <= ?'); args.push(`${to} 99`); }
  const sql = `SELECT * FROM send_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY scheduled_for DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

// ---------- Settings ----------

function saveSettings(values) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const [k, v] of Object.entries(values)) up.run(k, String(v));
  })();
}

module.exports = {
  listGroups, groupNames, saveGroups,
  getBirthday, listBirthdays, createBirthday, updateBirthday, deleteBirthday,
  setBirthdayContent, clearBirthdayContent, birthdayLogRows, nextOccurrence, hasContentFor,
  listPayments, getPayment, paymentRecipients, createPayment, updatePayment, deletePayment, paymentLogRows,
  listContacts, saveContacts,
  getMessage, listMessages, pendingMessages, createMessage, updateMessage, finishMessage, deleteMessage, messageLogRows,
  addLog, history, saveSettings,
};
