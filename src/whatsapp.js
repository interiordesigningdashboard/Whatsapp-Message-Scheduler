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

// All groups I am in: [{ groupId, name, participantsCount, adminsOnly }]
async function listGroups() {
  const c = requireReady();
  const chats = await c.getChats();
  return chats
    .filter((chat) => chat.isGroup)
    .map((chat) => ({
      groupId: chat.id._serialized,
      name: chat.name || chat.id.user,
      participantsCount: Array.isArray(chat.participants) ? chat.participants.length : null,
      adminsOnly: Boolean(chat.groupMetadata && chat.groupMetadata.announce),
    }));
}

// Send an image with a caption (or just text if there is no image) to a chat or group.
async function send(chatId, imageFile, caption) {
  const c = requireReady();
  let result;
  if (imageFile) {
    const media = MessageMedia.fromFilePath(imageFile);
    result = await c.sendMessage(chatId, media, { caption: caption || undefined, sendSeen: false });
  } else if (caption) {
    result = await c.sendMessage(chatId, caption, { sendSeen: false });
  } else {
    throw new Error('Nothing to send: no image or caption');
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
