const fs = require('fs');
const config = require('./config');

// Node's built-in SQLite: nothing to compile on Windows. It still prints an "experimental"
// warning on some Node versions; hide just that one.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String((warning && warning.message) || warning).includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  self_alert_enabled: '1',
  delay_min_sec: '5',
  delay_max_sec: '15',
  grace_minutes: '2',
  reminder_days_ahead: '7',
  reminder_time: '09:00',
};

// Each entry runs once, in order. Add new migrations to the end; never edit old ones.
const MIGRATIONS = [
  `
  CREATE TABLE birthdays (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    birth_month     INTEGER NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
    birth_day       INTEGER NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
    send_time       TEXT    NOT NULL,              -- 'HH:MM' IST
    active          INTEGER NOT NULL DEFAULT 1,
    next_image_path TEXT,                          -- content for the NEXT birthday only,
    next_caption    TEXT,                          -- cleared after it is sent or missed
    next_for_date   TEXT,                          -- 'YYYY-MM-DD' the content belongs to
    created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE birthday_groups (
    birthday_id INTEGER NOT NULL REFERENCES birthdays(id) ON DELETE CASCADE,
    group_id    TEXT    NOT NULL,
    PRIMARY KEY (birthday_id, group_id)
  );

  CREATE TABLE scheduled_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    send_at    TEXT    NOT NULL,                   -- 'YYYY-MM-DD HH:MM' IST
    image_path TEXT,
    caption    TEXT,
    status     TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'done', 'cancelled')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE scheduled_message_groups (
    message_id INTEGER NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE,
    group_id   TEXT    NOT NULL,
    PRIMARY KEY (message_id, group_id)
  );

  CREATE TABLE wa_groups (
    group_id           TEXT PRIMARY KEY,           -- 'xxxx@g.us'
    name               TEXT NOT NULL,
    participants_count INTEGER,
    last_synced_at     TEXT NOT NULL
  );

  CREATE TABLE send_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type      TEXT NOT NULL CHECK (job_type IN ('birthday', 'oneoff')),
    job_id        INTEGER NOT NULL,
    job_label     TEXT,                            -- person name / message title, kept for history
    group_id      TEXT NOT NULL,
    group_name    TEXT,
    scheduled_for TEXT NOT NULL,                   -- 'YYYY-MM-DD HH:MM' IST
    status        TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'missed')),
    error         TEXT,
    sent_at       TEXT,
    UNIQUE (job_type, job_id, group_id, scheduled_for)
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: remember whether a group only lets admins post
  `ALTER TABLE wa_groups ADD COLUMN admins_only INTEGER NOT NULL DEFAULT 0;`,
  // 3: payment reminders (EMI, insurance...) sent to a person's private chat, and WhatsApp contacts.
  `
  CREATE TABLE payments (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    title              TEXT    NOT NULL,             -- 'Car EMI'
    person_name        TEXT    NOT NULL,
    phone              TEXT    NOT NULL,             -- digits with country code, e.g. '919876543210'
    amount             TEXT,                         -- as typed, e.g. '5000'
    every_months       INTEGER NOT NULL CHECK (every_months BETWEEN 1 AND 120), -- 1 monthly, 3 quarterly, 12 yearly
    first_due_date     TEXT    NOT NULL,             -- 'YYYY-MM-DD'; its day is the due day each time
    remind_days_before INTEGER NOT NULL DEFAULT 2 CHECK (remind_days_before BETWEEN 0 AND 30),
    send_time          TEXT    NOT NULL,             -- 'HH:MM' IST
    end_count          INTEGER,                      -- stop after this many payments (optional)
    end_date           TEXT,                         -- no due dates after this day (optional)
    message            TEXT    NOT NULL,             -- template with {name} {title} {amount} {due_date} {days_left}
    active             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL
  );

  CREATE TABLE wa_contacts (
    phone          TEXT PRIMARY KEY,                 -- digits with country code
    name           TEXT NOT NULL,
    last_synced_at TEXT NOT NULL
  );

  -- send_log gets a third job type; SQLite cannot change a CHECK, so rebuild the table.
  CREATE TABLE send_log_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type      TEXT NOT NULL CHECK (job_type IN ('birthday', 'oneoff', 'payment')),
    job_id        INTEGER NOT NULL,
    job_label     TEXT,
    group_id      TEXT NOT NULL,                     -- group id, or the person's number for payments
    group_name    TEXT,
    scheduled_for TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'missed')),
    error         TEXT,
    sent_at       TEXT,
    UNIQUE (job_type, job_id, group_id, scheduled_for)
  );
  INSERT INTO send_log_new SELECT id, job_type, job_id, job_label, group_id, group_name, scheduled_for, status, error, sent_at FROM send_log;
  DROP TABLE send_log;
  ALTER TABLE send_log_new RENAME TO send_log;
  `,
  // 4: a payment reminder can go to several people. payments.person_name/phone keep the first one.
  `
  CREATE TABLE payment_recipients (
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    phone      TEXT    NOT NULL,                     -- digits with country code
    position   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (payment_id, phone)
  );
  INSERT INTO payment_recipients (payment_id, name, phone, position) SELECT id, person_name, phone, 0 FROM payments;
  `,
];

function open() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const raw = new DatabaseSync(config.dbPath);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  // node:sqlite rejects undefined; store it as NULL like an empty value.
  const clean = (args) => args.map((a) => (a === undefined ? null : a));
  const db = {
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...args) => stmt.run(...clean(args)),
        get: (...args) => stmt.get(...clean(args)),
        all: (...args) => stmt.all(...clean(args)),
      };
    },
    exec: (sql) => raw.exec(sql),
    // Wraps fn so that everything inside it is saved together, or not at all.
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };

  const current = raw.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);

  return db;
}

const db = open();

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

module.exports = { db, getSettings };
