const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const config = require('./config');

// Connection states shown on the Status page.
//   disabled      WA_DISABLED=1, WhatsApp not started
//   starting      browser is launching / loading WhatsApp Web
//   qr            waiting for me to scan the QR code with my phone
//   authenticating QR scanned, loading chats
//   ready         connected and able to send
//   disconnected  logged out or connection lost; restarting
//   error         could not start (see lastError)
const state = {
  status: config.waDisabled ? 'disabled' : 'starting',
  qrDataUrl: null,
  me: null, // { number, name }
  lastError: null,
  loading: null, // e.g. "45% WhatsApp" while WhatsApp Web loads
  since: new Date(),
};

let client = null;
let restartTimer = null;

function setStatus(status, extra = {}) {
  Object.assign(state, { status, since: new Date() }, extra);
  console.log(`[whatsapp] ${status}${extra.lastError ? `: ${extra.lastError}` : ''}`);
}

// The Chrome profile folder LocalAuth uses for the saved WhatsApp login.
const profileDir = path.join(config.waAuthDir, 'session');

// A Chrome left over from an earlier run (app closed without stopping Chrome, or a second copy of the app)
// keeps the profile locked, and the new Chrome exits at once: "Target closed" / "browser is already running".
// Close such Chromes (only ones using OUR profile folder) and remove stale lock files before starting.
function closeLeftoverChrome() {
  let killed = 0;
  try {
    if (process.platform === 'win32') {
      const dir = profileDir.toLowerCase().replace(/'/g, "''");
      const ps = `$d='${dir}'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome-headless-shell.exe'" | `
        + "Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($d) } | "
        + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      killed = out.split(/\s+/).filter(Boolean).length;
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m || Number(m[1]) === process.pid || !m[2].includes(`--user-data-dir=${profileDir}`)) continue;
        try { process.kill(Number(m[1]), 'SIGKILL'); killed += 1; } catch { /* already gone */ }
      }
    }
  } catch (err) {
    console.warn(`[whatsapp] could not check for leftover Chrome: ${err.message}`);
  }
  if (killed) console.log(`[whatsapp] closed ${killed} leftover Chrome process(es) that were holding the WhatsApp login`);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
    try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch { /* still in use or not there */ }
  }
  return killed;
}

// Puppeteer's messages when Chrome dies on start are cryptic; say what to do.
function startHint(message) {
  if (/Target closed|already running|Failed to launch|Browser closed|Navigating frame was detached|Session closed/i.test(message)) {
    return `${message}. Chrome closed while starting. Make sure only one copy of the app is running `
      + '(also check Task Scheduler). If it keeps happening, stop the app, rename the folder data\\.wwebjs_auth and start again to scan a new QR code.';
  }
  return message;
}

function createClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: config.waAuthDir }),
    // WhatsApp Web can take several minutes to load on big accounts (first sync after linking,
    // thousands of chats). Puppeteer's default 3-minute limit per step is too short for that.
    authTimeoutMs: 180000,
    webVersionCache: { type: 'local', path: config.waCacheDir },
    puppeteer: {
      headless: true,
      protocolTimeout: 10 * 60 * 1000,
      // Let the app close Chrome itself on Ctrl+C. If Puppeteer kills Chrome first,
      // the saved WhatsApp login can be left half-written and the next start hangs.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      dumpio: process.env.WA_DEBUG === '1', // WA_DEBUG=1 shows Chrome's own messages in the log
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  c.on('loading_screen', (percent, message) => {
    state.loading = `${percent}%${message ? ` ${message}` : ''}`;
    console.log(`[whatsapp] loading ${state.loading}`);
  });

  c.on('qr', async (qr) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
      setStatus('qr', { qrDataUrl });
    } catch (err) {
      setStatus('error', { lastError: `QR render failed: ${err.message}` });
    }
  });

  c.on('authenticated', () => setStatus('authenticating', { qrDataUrl: null }));

  c.on('auth_failure', (msg) => {
    setStatus('error', { lastError: `Login failed: ${msg}`, qrDataUrl: null });
    scheduleRestart();
  });

  c.on('ready', () => {
    const info = c.info || {};
    setStatus('ready', {
      loading: null,
      qrDataUrl: null,
      lastError: null,
      me: { number: info.wid ? info.wid.user : null, name: info.pushname || null },
    });
  });

  c.on('disconnected', (reason) => {
    setStatus('disconnected', { lastError: `Disconnected: ${reason}`, me: null });
    scheduleRestart();
  });

  return c;
}

async function start() {
  if (config.waDisabled) return;
  clearTimeout(restartTimer);
  setStatus('starting', { qrDataUrl: null, loading: null });
  closeLeftoverChrome();
  client = createClient();
  try {
    await client.initialize();
  } catch (err) {
    setStatus('error', { lastError: `Could not start WhatsApp: ${startHint(err.message)}` });
    scheduleRestart();
  }
}

// Wait 30 s before retrying, so a slow WhatsApp Web load is not interrupted again straight away.
function scheduleRestart(delayMs = 30000) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    await destroy();
    start();
  }, delayMs);
}

async function destroy() {
  clearTimeout(restartTimer);
  const c = client;
  client = null;
  if (!c) return;
  try {
    await c.destroy();
  } catch (err) {
    console.warn(`[whatsapp] destroy failed: ${err.message}`);
  }
}

// Unlink this PC from my WhatsApp account; a new QR code will be shown.
async function logout() {
  if (!client) return;
  try {
    await client.logout();
  } catch (err) {
    console.warn(`[whatsapp] logout failed: ${err.message}`);
  }
  scheduleRestart(1000);
}

function getState() {
  return { ...state };
}

function isReady() {
  return state.status === 'ready' && client !== null;
}

function requireReady() {
  if (!isReady()) throw new Error('WhatsApp is not connected');
  return client;
}

// WhatsApp Web often throws minified one-letter errors (e.g. "r"). Make them readable.
function explain(err) {
  const msg = (err && err.message) || String(err);
  const inner = msg.replace(/^Evaluation failed:\s*/, '').trim();
  if (inner.length <= 3) return `WhatsApp Web internal error ("${inner}"). Try again in a minute; if it keeps happening, restart the app.`;
  return inner;
}

// All groups I am in: [{ groupId, name, participantsCount, adminsOnly }]
// Reads the group list straight from WhatsApp Web's memory instead of client.getChats():
// getChats() refreshes every group from the server and fails completely if one chat errors.
async function listGroups() {
  const c = requireReady();
  let result;
  try {
    result = await c.pupPage.evaluate(() => {
      const groups = [];
      const errors = [];
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      for (const chat of chats) {
        try {
          if (!chat || !chat.id || chat.id.server !== 'g.us') continue;
          const meta = chat.groupMetadata;
          if (meta && meta.isParentGroup) continue; // community "parent": you cannot post there
          const parts = meta && meta.participants;
          let count = null;
          if (parts) {
            if (typeof parts.getModelsArray === 'function') count = parts.getModelsArray().length;
            else if (typeof parts.length === 'number') count = parts.length;
          }
          groups.push({
            groupId: chat.id._serialized || chat.id.$1,
            name: chat.formattedTitle || chat.name || (meta && meta.subject) || chat.id.user,
            participantsCount: count,
            adminsOnly: Boolean(meta && meta.announce),
          });
        } catch (e) {
          errors.push(String((e && e.message) || e));
        }
      }
      return { groups, errors, total: chats.length };
    });
  } catch (err) {
    console.error('[whatsapp] reading groups failed:', err);
    throw new Error(explain(err));
  }
  if (result.errors.length) {
    console.warn(`[whatsapp] skipped ${result.errors.length} chat(s) while reading groups: ${result.errors.slice(0, 3).join(' | ')}`);
  }
  console.log(`[whatsapp] found ${result.groups.length} groups among ${result.total} chats`);
  return result.groups;
}

// My saved WhatsApp contacts that have a phone number: [{ name, phone }] (phone = digits with country code).
// Read straight from WhatsApp Web's memory; a contact that errors is skipped.
async function listContacts() {
  const c = requireReady();
  let result;
  try {
    result = await c.pupPage.evaluate(() => {
      const out = [];
      const errors = [];
      const { Contact } = window.require('WAWebCollections');
      let getters = {};
      try { getters = window.require('WAWebContactGetters'); } catch (e) { /* older WhatsApp Web */ }
      let isMyContact = null;
      try { isMyContact = window.require('WAWebFrontendContactGetters').getIsMyContact; } catch (e) { /* ignore */ }
      const call = (fn, contact) => { try { return fn ? fn(contact) : undefined; } catch (e) { return undefined; } };
      for (const contact of Contact.getModelsArray()) {
        try {
          if (!contact || !contact.id) continue;
          const server = contact.id.server;
          if (server !== 'c.us' && server !== 'lid') continue;
          const mine = isMyContact ? call(isMyContact, contact) : contact.isMyContact;
          if (!mine) continue;
          if (call(getters.getIsMe, contact)) continue;
          let number = server === 'c.us' ? contact.id.user : (contact.phoneNumber && contact.phoneNumber.user);
          if (!number) continue;
          const name = call(getters.getName, contact) || contact.name || call(getters.getPushname, contact) || contact.pushname;
          if (!name) continue;
          out.push({ name: String(name), phone: String(number) });
        } catch (e) {
          errors.push(String((e && e.message) || e));
        }
      }
      return { contacts: out, errors };
    });
  } catch (err) {
    console.error('[whatsapp] reading contacts failed:', err);
    throw new Error(explain(err));
  }
  if (result.errors.length) console.warn(`[whatsapp] skipped ${result.errors.length} contact(s): ${result.errors.slice(0, 3).join(' | ')}`);
  console.log(`[whatsapp] found ${result.contacts.length} contacts`);
  return result.contacts;
}

// The chat id for a phone number (digits with country code), or an error if the number is not on WhatsApp.
async function chatIdForNumber(phone) {
  const c = requireReady();
  let id;
  try {
    id = await c.pupPage.evaluate(async (number) => {
      const wid = window.require('WAWebWidFactory').createWid(`${number}@c.us`);
      const res = await window.require('WAWebQueryExistsJob').queryWidExists(wid);
      if (!res || !res.wid) return null;
      const w = res.wid;
      return w._serialized || w.$1 || (typeof w.toString === 'function' ? w.toString() : null);
    }, phone);
  } catch (err) {
    console.error(`[whatsapp] checking number ${phone} failed:`, err);
    throw new Error(explain(err));
  }
  if (!id) throw new Error(`The number +${phone} is not on WhatsApp`);
  return id;
}

// Send text (and optionally an image) to a person's private chat by phone number.
async function sendToNumber(phone, imageFile, caption) {
  const chatId = await chatIdForNumber(phone);
  return send(chatId, imageFile, caption, { allowNewChat: true });
}

// Send an image with a caption (or just text if there is no image) to a chat or group.
// options.allowNewChat: a private chat that does not exist yet is created by WhatsApp (used for numbers
// already checked with chatIdForNumber). Otherwise the chat or group must already exist.
async function send(chatId, imageFile, caption, options = {}) {
  const c = requireReady();
  if (!imageFile && !caption) throw new Error('Nothing to send: no image or caption');
  const exists = await c.pupPage.evaluate((id) => {
    try {
      const { Chat } = window.require('WAWebCollections');
      return Boolean(Chat.get(id));
    } catch (e) {
      return true; // cannot check; let sendMessage try
    }
  }, chatId).catch(() => true);
  if (!exists && !options.allowNewChat) {
    throw new Error(chatId.endsWith('@g.us')
      ? 'Group not found in WhatsApp. You may have left it; reload groups on the Groups page.'
      : 'Chat not found in WhatsApp. On your phone, open the "Message yourself" chat and send any message once, then try again.');
  }
  const what = imageFile
    ? `image ${path.basename(imageFile)} (${Math.round(fs.statSync(imageFile).size / 1024)} KB)${caption ? ' + caption' : ''}`
    : 'text only';
  console.log(`[whatsapp] sending ${what} to ${chatId}`);
  let result;
  try {
    if (imageFile) {
      const media = MessageMedia.fromFilePath(imageFile);
      result = await c.sendMessage(chatId, media, { caption: caption || undefined, sendSeen: false });
    } else {
      result = await c.sendMessage(chatId, caption, { sendSeen: false });
    }
  } catch (err) {
    console.error(`[whatsapp] send to ${chatId} failed:`, err);
    throw new Error(explain(err));
  }
  if (!result) {
    // The send went through without an error, but WhatsApp Web did not hand the message back.
    // The chat exists (checked above), so treat it as sent.
    console.warn(`[whatsapp] sent to ${chatId}, but WhatsApp did not confirm it; counting it as sent`);
    return null;
  }
  if (imageFile && result.hasMedia === false) {
    throw new Error('The caption was sent, but WhatsApp dropped the image');
  }
  return result;
}

// My own "Message yourself" chat. Newer accounts have two IDs (phone number and LID), and the
// chat can live under either. Returns candidates, best first: IDs that already have a chat, then the rest.
async function selfChatIds() {
  const c = requireReady();
  let ids = [];
  try {
    ids = await c.pupPage.evaluate(() => {
      const ser = (w) => (w ? w._serialized || w.$1 || (typeof w.toString === 'function' ? w.toString() : null) : null);
      const { getMaybeMePnUser, getMaybeMeLidUser } = window.require('WAWebUserPrefsMeUser');
      const { Chat } = window.require('WAWebCollections');
      const wids = [getMaybeMeLidUser(), getMaybeMePnUser()].filter(Boolean);
      const withChat = wids.filter((w) => Chat.get(w)).map(ser);
      return [...withChat, ...wids.map(ser)].filter(Boolean);
    });
  } catch (err) {
    console.warn('[whatsapp] could not look up own chat:', err.message);
  }
  if (c.info && c.info.wid && c.info.wid._serialized) ids.push(c.info.wid._serialized);
  return [...new Set(ids)];
}

// Message my own number ("Message yourself" chat).
async function sendToSelf(imageFile, caption) {
  const ids = await selfChatIds();
  let lastErr = new Error('Could not find your own chat');
  for (const id of ids) {
    try {
      return await send(id, imageFile, caption);
    } catch (err) {
      lastErr = err;
      console.warn(`[whatsapp] send to self via ${id} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

module.exports = { start, destroy, logout, getState, isReady, listGroups, listContacts, send, sendToSelf, sendToNumber };
