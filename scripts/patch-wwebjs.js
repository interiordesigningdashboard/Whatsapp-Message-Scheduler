// Applies a small upstream fix to whatsapp-web.js 1.34.7 after `npm install`.
//
// Since a WhatsApp Web update, sending an image fails with
//   "Data passed to getter must include an id property (it's how we memoize) but got undefined".
// Fixed upstream in pedroslopez/whatsapp-web.js commit 064a3d5 (PR #201923), not yet released on npm.
// This script makes exactly that change. Remove it once a whatsapp-web.js release includes the fix.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
const MARKER = 'if (message.__x_id) {';

if (!fs.existsSync(file)) {
  console.warn('[patch-wwebjs] whatsapp-web.js not installed; skipping.');
  process.exit(0);
}

const src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER)) {
  console.log('[patch-wwebjs] media fix already present.');
  process.exit(0);
}

const nl = src.includes('\r\n') ? '\r\n' : '\n';
const anchor = new RegExp(`(\\.\\.\\.extraOptions,\\r?\\n\\s*\\};\\r?\\n)(\\s*// Bot's won't reply)`);
if (!anchor.test(src)) {
  console.warn('[patch-wwebjs] could not find the place to patch (different whatsapp-web.js version?). Sending images may fail.');
  process.exit(0);
}

const fix = [
  '        // MediaData is a model whose private __x_id field collides with Msg\'s',
  '        // internal id field when its enumerable properties are spread above,',
  '        // breaking getValidatedSender() during Msg initialization.',
  `        ${MARKER}`,
  '            delete message.__x_id;',
  '        }',
].join(nl) + nl;

fs.writeFileSync(file, src.replace(anchor, `$1${fix}$2`));
console.log('[patch-wwebjs] applied media send fix (upstream PR #201923).');
