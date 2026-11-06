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
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
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
  setStatus('starting', { qrDataUrl: null });
  client = createClient();
  try {
    await client.initialize();
  } catch (err) {
    setStatus('error', { lastError: `Could not start WhatsApp: ${err.message}` });
    scheduleRestart();
  }
}

function scheduleRestart(delayMs = 10000) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    await destroy();
    start();
  }, delayMs);
}

async function destroy() {
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
            groupId: chat.id._serialized,
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
  if (!result) throw new Error('WhatsApp did not accept the message (chat not found or no permission to post)');
  return result;
}

function selfChatId() {
  const c = requireReady();
  return c.info.wid._serialized;
}

// Message my own number ("Message yourself" chat).
async function sendToSelf(imageFile, caption) {
  return send(selfChatId(), imageFile, caption);
}

module.exports = { start, destroy, logout, getState, isReady, listGroups, send, sendToSelf };
