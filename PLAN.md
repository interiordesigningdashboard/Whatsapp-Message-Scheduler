# WhatsApp Message Scheduler — Plan

> **Status:** all 7 milestones are built. See README.md for setup and use.

## 1. Goal

A small app that runs on my own PC and sends **birthday messages (image + caption) to several WhatsApp groups at a fixed time**. I manage it from a simple local web dashboard.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| WhatsApp access | WhatsApp Web automation (`whatsapp-web.js`), linked to my own number by scanning a QR code |
| Message types | **Both** a recurring birthday list (sent every year) **and** one-off scheduled messages |
| Image | I upload a ready-made image. It is sent as-is. |
| Caption | Written by hand for each birthday or message |
| Yearly content | **The image and caption are new every year.** A birthday keeps only the person's name, date, groups and time. The image and caption are added for the coming birthday and **deleted after it is sent (or missed)**. |
| Target groups | Each birthday or message has **its own set of groups**. Groups only, no private messages to the person. |
| Send time | **Per message**: each birthday or message has its own time |
| Timezone | **Asia/Kolkata (IST)**, fixed |
| OS | **Windows** |
| Out of scope | Private messages to the birthday person, CSV/Excel import |
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
- **Windows Task Scheduler** running `start.bat` at log-on, so the app starts automatically

## 4. Data model

```
birthdays                -- permanent: the person, date, time and groups
  id, name, birth_month, birth_day, send_time (HH:MM),
  active, created_at, updated_at,
  -- content for the NEXT birthday only; cleared after it is sent or missed
  next_image_path, next_caption, next_for_date (YYYY-MM-DD)

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
  self_alert_enabled, delay_between_groups_sec (min/max), grace_minutes,
  reminder_days_ahead (default 7), reminder_time (default 09:00)
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
5. **Yearly content cleanup:**
   - When a birthday job finishes (sent, failed or missed), the app **deletes the uploaded image file** and clears `next_caption`. Next year starts empty.
   - If a birthday comes due with **no image or caption added**, nothing is sent. It is marked `missed` with the reason "no content added", and I get an alert.
   - `next_for_date` ties the content to a specific birthday, so content added for this year can never go out a year later by mistake.
   - One-off messages work the same way: their image file is deleted once they are done.
6. **Reminder to add content:** every day at `reminder_time`, the app sends me a WhatsApp message listing birthdays in the next `reminder_days_ahead` days that still need an image or caption. The dashboard also highlights them.
7. **Alert to myself:** after each job, the app sends a short summary to my own number, for example: "🎂 Rahul — sent to 4/5 groups. Failed: Family Group (not admin)". It also sends a single alert for anything marked `missed` when the app starts.

## 6. Dashboard pages (localhost:3000)

| Page | What it does |
|---|---|
| **Status** | WhatsApp connection state, the QR code to scan when logged out, the next 5 upcoming sends |
| **Birthdays** | List, search, add, edit and delete. Permanent fields: name, date, time, group checkboxes, active toggle. Shows each person's next birthday and a **"Needs content"** badge if no image or caption has been added for it yet. |
| **Add this year's content** | For one upcoming birthday: upload the image (with preview) and write the caption. Includes a **"Send test to myself"** button. |
| **One-off messages** | Same form with a full date and time. Shows pending and done messages, with a cancel option. |
| **Groups** | A **"Refresh from WhatsApp"** button and the list of my groups |
| **History** | The `send_log` table with filters (date, status, person) |
| **Settings** | Delay range, grace minutes, self-alert on/off, reminder days and time |

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

## 8. Running on my Windows PC

- Install **Node.js 20 LTS or newer** from nodejs.org.
- In the project folder, run `npm install`, then `npm start`. Open http://localhost:3000 and scan the QR code once from the Status page.
- **Auto-start:** use Windows Task Scheduler. Create a task with the trigger "At log on" and the action `start.bat`, set to run minimized. The README will give step-by-step instructions.
- **Power settings:** set Settings → System → Power → "When plugged in, put my device to sleep after" to **Never**. Otherwise sends that fall while the PC is asleep are marked missed.
- Keep the phone's WhatsApp active. Linked devices log out after about 14 days if the phone is offline.

## 9. Risks and limitations

- **Unofficial API:** WhatsApp may ban numbers that behave like bots. Mitigations are the delays between groups, low volume, and only sending to groups I'm already in.
- **WhatsApp Web updates can break the library:** keep `whatsapp-web.js` updated, and the dashboard shows the connection state.
- **Group permissions:** if a group is set to "only admins can send", sending fails. This is logged and included in the alert.
- **The PC must be on:** messages sent while the PC is off are missed (this is the chosen behaviour).

## 10. Milestones

1. **Setup:** project skeleton, SQLite schema, WhatsApp client with QR login and the Status page
2. **Groups:** sync and list my groups, plus a test send of image + caption to one group
3. **Birthdays:** CRUD pages for people, dates, times and groups, plus the "add this year's content" page with image upload
4. **Scheduler:** minute tick, due-job query, delays, `send_log`, idempotency, missed marking, content cleanup after sending
5. **One-off messages:** CRUD pages, scheduled through the same engine
6. **Alerts and history:** self-summary messages, the daily "needs content" reminder, and the History page
7. **Polish:** settings page, `start.bat` with Task Scheduler instructions, README with setup steps, backup of `data/`
