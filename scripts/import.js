#!/usr/bin/env node
// Import payment reminders and birthdays from the standard Excel file (made by export or the template).
//
//   npm run import -- file.xlsx                 -> preview only, nothing is saved
//   npm run import -- file.xlsx --apply         -> save
//   npm run import -- file.xlsx --apply --prune -> also delete items that are not in the file
//
// Rows with an ID update that item; rows without an ID are added. Rows with problems are listed and skipped.
// Safe to run while the app is running: it picks up the changes within a minute.
require('../src/config');
const excel = require('../src/excel');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.log('Usage: npm run import -- file.xlsx [--apply] [--prune]');
    process.exit(1);
  }
  const prune = args.includes('--prune');
  const plan = excel.plan(await excel.readWorkbook(file), { prune });

  for (const p of plan.problems) console.log(`! ${p}`);
  for (const [kind, label, nameOf] of [['payments', 'Payments', (r) => r.fields.title], ['birthdays', 'Birthdays', (r) => r.fields.name]]) {
    const s = plan[kind];
    for (const r of s.add) console.log(`  + ${label} row ${r.row}: add "${nameOf(r)}"`);
    for (const r of s.update) console.log(`  ~ ${label} row ${r.row}: update "${nameOf(r)}" (ID ${r.id})`);
    for (const i of s.remove) console.log(`  - ${label}: delete "${i.title || i.name}" (ID ${i.id})`);
    for (const e of s.errors) console.log(`  ! ${label} row ${e.row} "${e.label}" skipped: ${e.errors.join('; ')}`);
  }
  console.log('');
  for (const line of excel.summary(plan)) console.log(line);

  if (!args.includes('--apply')) {
    console.log('\nPreview only, nothing saved. Run again with --apply to import.');
    return;
  }
  const c = excel.apply(plan);
  console.log(`\nImported. Payments: ${c.payments.added} added, ${c.payments.updated} updated, ${c.payments.removed} deleted.`
    + ` Birthdays: ${c.birthdays.added} added, ${c.birthdays.updated} updated, ${c.birthdays.removed} deleted.`);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
