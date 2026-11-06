const path = require('path');

// All dates and times in the app are India time.
process.env.TZ = 'Asia/Kolkata';

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');

module.exports = {
  timezone: 'Asia/Kolkata',
  host: '127.0.0.1', // localhost only: nobody else on the network can open the dashboard
  port: Number(process.env.PORT) || 3000,
  rootDir,
  dataDir,
  dbPath: path.join(dataDir, 'app.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  waAuthDir: path.join(dataDir, '.wwebjs_auth'),
  // Set WA_DISABLED=1 to run the dashboard without starting WhatsApp (useful for testing).
  waDisabled: process.env.WA_DISABLED === '1',
};
