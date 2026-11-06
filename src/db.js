const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

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
];

function open() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
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
