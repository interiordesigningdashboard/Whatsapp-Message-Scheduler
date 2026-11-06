# WhatsApp Message Scheduler — Plan (Draft v1)

## 1. Goal

A small app that runs on my own PC and sends **birthday messages (image + caption) to several WhatsApp groups at a fixed time**. I manage it from a simple local web dashboard.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| WhatsApp access | WhatsApp Web automation (`whatsapp-web.js`), linked to my own number by scanning a QR code |
| Message types | **Both** a recurring birthday list (sent every year) **and** one-off scheduled messages |
| Image | I upload a ready-made image. It is sent as-is. |
| Caption | Written by hand for each birthday or message |
| Target groups | Each birthday or message has **its own set of groups** |
| Send time | **Per message**: each birthday or message has its own time |
| Missed sends | If the PC or app is off at send time, **skip it and mark it "missed"**. Never send late. |
| Interface | Local web dashboard (Node.js + server-rendered HTML, no frontend build) |
| Hosting | My own PC or laptop |
| Users / scale | Just me. Under 20 groups and a few hundred birthdays. No login (localhost only). |
| Alerts | A WhatsApp message to my own number with the send results |

## 3. Tech stack

- **Node.js 20+**
- **whatsapp-web.js** with `LocalAuth`, so the session is saved and the QR scan is only needed once. It uses Puppeteer and Chromium.
- **Express + EJS** for the dashboard pages, with plain CSS
- **SQLite** (`better-sqlite3`) in a single local DB file
- **multer** for image uploads, stored in `data/uploads/`
- **node-cron** for a scheduler tick that runs every minute
- **pm2** (or the OS startup folder) to start the app automatically when the PC boots or I log in

## 4. Data model

```
birthdays
  id, name, birth_month, birth_day, send_time (HH:MM),
  image_path, caption, active, created_at, updated_at

birthday_groups          -- the groups for each birthday person
  birthday_id, group_id

scheduled_messages       -- one-off messages
  id, title, send_at (date+time), image_path (optional), caption,
  status (pending | done | cancelled), created_at

scheduled_message_groups
  message_id, group_id

wa_groups                -- cached list of my WhatsApp groups
  group_id (xxx@g.us), name, participants_count, last_synced_at

send_log                 -- one row per (job, group, scheduled date)
  id, job_type (birthday | oneoff), job_id, group_id,
  scheduled_for (datetime), status (sent | failed | missed),
  error, sent_at
  UNIQUE(job_type, job_id, group_id, scheduled_for)   -- prevents double sends

settings
  timezone, self_alert_enabled, delay_between_groups_sec (min/max), grace_minutes
```

## 5. How scheduling works

1. **The tick runs every minute.** It finds jobs whose send time falls in the current minute:
   - Birthdays where `month/day == today`, `send_time == now (HH:MM)`, the birthday is `active`, and there is no `send_log` entry for this year yet.
   - One-off messages where `send_at` is in the current minute and `status = pending`.
2. **Sending a job:**
   - It goes through the job's groups one at a time.
   - It sends the image with the caption: `MessageMedia.fromFilePath()` and then `chat.sendMessage(media, { caption })`. If there is no image, it sends a text-only message.
   - It waits a random **5–15 s between groups**, to look less like a bot and lower the ban risk.
   - It writes a `send_log` row for each group (`sent` or `failed` plus the error).
3. **Missed sends (the skip rule):**
   - At startup and on every tick, any job whose time passed more than `grace_minutes` ago (default 2) with no log is marked `missed` and never sent.
   - If WhatsApp is not connected at send time, the app retries until the grace window ends and then marks the job `missed`.
4. **Feb 29 birthdays** are sent on Feb 28 in non-leap years.
5. **Alert to myself:** after each job, the app sends a short summary to my own number, for example: "🎂 Rahul — sent to 4/5 groups. Failed: Family Group (not admin)". It also sends a single alert for anything marked `missed` when the app starts.

## 6. Dashboard pages (localhost:3000)

| Page | What it does |
|---|---|
| **Status** | WhatsApp connection state, the QR code to scan when logged out, the next 5 upcoming sends |
| **Birthdays** | List, search, add, edit and delete. Fields: name, date, time, image upload with preview, caption, group checkboxes, active toggle. Includes a **"Send test to myself"** button. |
| **One-off messages** | Same form with a full date and time. Shows pending and done messages, with a cancel option. |
| **Groups** | A **"Refresh from WhatsApp"** button and the list of my groups |
| **History** | The `send_log` table with filters (date, status, person) |
| **Settings** | Timezone, delay range, grace minutes, self-alert on/off |

The server binds to `127.0.0.1` only, so nobody else on the network can open the dashboard.

## 7. Project structure

```
src/
  index.js            # boot: DB, WhatsApp client, web server, scheduler
  db.js               # SQLite setup + migrations
  whatsapp.js         # client, QR, connection state, sendToGroup(), sendToSelf()
  scheduler.js        # minute tick, due-job query, missed-job marking
  routes/             # status, birthdays, messages, groups, history, settings
views/                # EJS templates
public/               # CSS
data/                 # app.db, uploads/, .wwebjs_auth/  (git-ignored)
```

## 8. Running on my PC

- `npm install`, then `npm start`. Scan the QR code once from the Status page.
- Start automatically on login with **pm2** (`pm2 start` + `pm2 save` + `pm2-startup`), or with Windows Task Scheduler.
- Turn off PC **sleep** (or at least make sure the PC is awake at send times). Otherwise sends are marked missed.
- Keep the phone's WhatsApp active. Linked devices log out after about 14 days if the phone is offline.

## 9. Risks and limitations

- **Unofficial API:** WhatsApp may ban numbers that behave like bots. Mitigations are the delays between groups, low volume, and only sending to groups I'm already in.
- **WhatsApp Web updates can break the library:** keep `whatsapp-web.js` updated, and the dashboard shows the connection state.
- **Group permissions:** if a group is set to "only admins can send", sending fails. This is logged and included in the alert.
- **The PC must be on:** messages sent while the PC is off are missed (this is the chosen behaviour).

## 10. Milestones

1. **Setup:** project skeleton, SQLite schema, WhatsApp client with QR login and the Status page
2. **Groups:** sync and list my groups, plus a test send of image + caption to one group
3. **Birthdays:** CRUD pages with image upload and per-person groups
4. **Scheduler:** minute tick, due-job query, delays, `send_log`, idempotency, missed marking
5. **One-off messages:** CRUD pages, scheduled through the same engine
6. **Alerts and history:** self-summary messages and the History page
7. **Polish:** settings page, pm2 auto-start, README with setup steps, backup of `data/`

## 11. Still to confirm

- [ ] Which OS: Windows, macOS or Linux? (This affects the auto-start instructions.)
- [ ] Timezone (assumed **Asia/Kolkata**)
- [ ] Will the image or caption for a person change every year, or stay the same until I edit it?
- [ ] Should a birthday also be able to send a **private message** to the person, or only to groups?
- [ ] Do I want to bulk-import existing birthdays from a CSV or Excel file?
