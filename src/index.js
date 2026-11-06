const config = require('./config'); // sets TZ first
const path = require('path');
const express = require('express');
require('./db'); // opens the database and runs migrations
const wa = require('./whatsapp');
const scheduler = require('./scheduler');

const ALLOWED_HOSTS = ['localhost', '127.0.0.1'];

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(config.rootDir, 'views'));

// Only answer requests made to this PC's own dashboard. This blocks other websites open in
// the browser from posting forms here (e.g. to trigger sends) and DNS-rebinding tricks.
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.includes(host)) return res.status(403).send('Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const u = new URL(origin);
        ok = ALLOWED_HOSTS.includes(u.hostname) && Number(u.port || 80) === config.port;
      } catch { /* "null" or malformed */ }
      if (!ok) return res.status(403).send('Forbidden');
    }
  }
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(config.rootDir, 'public')));
app.use('/uploads', express.static(config.uploadsDir));

app.use(require('./routes/status'));
app.use(require('./routes/groups'));
app.use(require('./routes/birthdays'));
app.use(require('./routes/messages'));
app.use(require('./routes/history'));
app.use(require('./routes/settings'));

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`Something went wrong: ${err.message}`);
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Dashboard: http://localhost:${config.port}`);
});

wa.start();
scheduler.start();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down... (closing WhatsApp, please wait)');
  scheduler.stop();
  server.close();
  // Close Chrome properly so the WhatsApp login is saved; give up after 15 s.
  await Promise.race([wa.destroy(), new Promise((r) => setTimeout(r, 15000))]);
  console.log('Stopped.');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
