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
app.use(require('./routes/payments'));
app.use(require('./routes/transfer'));
app.use(require('./routes/history'));
app.use(require('./routes/settings'));

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`Something went wrong: ${err.message}`);
});

// Start WhatsApp and the scheduler only once the dashboard port is ours. If another copy of the app is
// already running, stop here: two copies would fight over the same WhatsApp login and send everything twice.
// (Not app.listen: in Express 5 its callback also runs when the port is taken.)
const server = require('http').createServer(app);
server.once('listening', () => {
  console.log(`Dashboard: http://localhost:${config.port}`);
  wa.start();
  scheduler.start();
});
server.listen(config.port, config.host);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`The app is already running (port ${config.port} is in use). Open http://localhost:${config.port}`
      + ' or stop the other copy first (also check Task Scheduler). This copy will now exit.');
  } else {
    console.error(`Could not start the dashboard: ${err.message}`);
  }
  process.exit(1);
});

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
