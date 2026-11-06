# WhatsApp Message Scheduler

Sends birthday messages (image + caption) to WhatsApp groups at a set time, from your own Windows PC.
See [PLAN.md](PLAN.md) for the full design.

## How to use it

1. **Status:** scan the QR code once to link your WhatsApp.
2. **Groups:** click **Load groups from WhatsApp**. Do this again whenever you join or leave a group.
3. **Birthdays → + Add birthday:** enter the name, day and month, send time, and tick the groups. This is saved permanently.
4. **Image & caption:** before each birthday, upload this year's image and write the caption.
   Use **Send test to myself** to see how it looks. After the birthday is sent (or missed), the image and caption
   are deleted, so next year you add new ones.
5. **One-off messages:** schedule a single message (image and/or caption) for any date and time.
6. **History:** shows every send per group: sent, failed (with the reason) or missed.

You also get WhatsApp messages on your own number:
- the result after each send (for example "Rahul: sent to 4/5 groups", with the reason for any failure)
- an alert when something was missed
- a daily reminder (default 09:00) listing birthdays in the next 7 days that still need an image or caption

These can be turned off, and the times changed, on the **Settings** page.

### Rules worth knowing

- **Never sent late.** If the PC is off or WhatsApp is not connected at the send time, the app keeps trying for the
  grace period (default 2 minutes). After that the message is marked **missed**.
- **No image or caption, no send.** A birthday with nothing added is marked missed and you get an alert.
- **29 February** birthdays are sent on 28 February in non-leap years.
- Groups are sent to one at a time with a random 5–15 second pause in between.
- Groups where only admins can post are marked **admins only**. Sending there fails unless you are an admin.

## Setup (Windows)

1. Install **Node.js 22 LTS or newer** from https://nodejs.org (keep the default options).
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
