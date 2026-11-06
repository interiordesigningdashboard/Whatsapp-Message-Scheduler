const config = require('./config'); // sets TZ first
const path = require('path');
const express = require('express');
require('./db'); // opens the database and runs migrations
const wa = require('./whatsapp');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(config.rootDir, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(config.rootDir, 'public')));

app.use(require('./routes/status'));

const server = app.listen(config.port, config.host, () => {
  console.log(`Dashboard: http://localhost:${config.port}`);
});

wa.start();

async function shutdown() {
  console.log('Shutting down...');
  server.close();
  await wa.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
