#!/usr/bin/env node
// Export all payment reminders and birthdays to the standard Excel file.
//
//   npm run export                        -> whatsapp-scheduler-YYYY-MM-DD.xlsx in the current folder
//   npm run export -- backup.xlsx         -> that file
//   npm run export -- backup.xlsx --no-ids   (for another PC: every row is added as new there)
//
// Safe to run while the app is running.
const path = require('path');
require('../src/config');
const excel = require('../src/excel');
const models = require('../src/models');
const t = require('../src/time');

async function main() {
  const args = process.argv.slice(2);
  const withIds = !args.includes('--no-ids');
  const file = args.find((a) => !a.startsWith('--')) || `whatsapp-scheduler-${t.ymd(new Date())}.xlsx`;
  const wb = excel.buildWorkbook({ withIds });
  await wb.xlsx.writeFile(file);
  const p = models.listPayments().length;
  const b = models.listBirthdays().length;
  console.log(`Exported ${p} payment reminder(s) and ${b} birthday(s) to ${path.resolve(file)}`);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
