# WhatsApp Message Scheduler

Sends birthday messages (image + caption) to WhatsApp groups at a set time, from your own Windows PC.
See [PLAN.md](PLAN.md) for the full design.

> **Status:** Step 1 of 7 is done: WhatsApp login (QR) and the Status page. Birthdays, groups and scheduling come next.

## Setup (Windows)

1. Install **Node.js 20 LTS or newer** from https://nodejs.org (keep the default options).
2. Download this project and open the folder in **Command Prompt**.
3. Install the dependencies (this also downloads a Chrome browser for WhatsApp Web, about 150 MB):

   ```
   npm install
   ```

4. Start the app:

   ```
   npm start
   ```

5. Open **http://localhost:3000**. When the QR code appears, on your phone open
   **WhatsApp → Settings → Linked devices → Link a device** and scan it.
   You only need to do this once. The login is saved in the `data` folder.

## Start automatically when you log in

1. Open **Task Scheduler** and choose **Create Basic Task…**
2. Name: `WhatsApp Scheduler`. Trigger: **When I log on**.
3. Action: **Start a program**. Program: the full path to `start.bat` in this folder.
   Start in: this folder's path.
4. Finish. To check it, right-click the task and choose **Run**, then open http://localhost:3000.

Logs are written to `data\app.log`.

## Keep the PC awake

Messages that fall due while the PC is off or asleep are **skipped and marked missed**. They are never sent late.
Go to **Settings → System → Power → Screen and sleep** and set
"When plugged in, put my device to sleep after" to **Never**.

Also keep WhatsApp on your phone active. Linked devices are logged out after about 14 days if the phone is offline.

## Data

Everything is stored in the `data` folder: the database, uploaded images and the WhatsApp login. Back this folder up.
To unlink the PC from WhatsApp, use **Unlink this PC** on the Status page.

## Important

This uses WhatsApp Web automation, which WhatsApp does not officially support. Keep the volume low and only send to
groups you are in, to avoid your number being banned.
