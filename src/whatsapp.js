const fs = require('fs');
const path = require('path');
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
  client = createClient();
  try {
    await client.initialize();
  } catch (err) {
    setStatus('error', { lastError: `Could not start WhatsApp: ${err.message}` });
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

// Send an image with a caption (or just text if there is no image) to a chat or group.
async function send(chatId, imageFile, caption) {
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
  if (!exists) {
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

module.exports = { start, destroy, logout, getState, isReady, listGroups, send, sendToSelf };
