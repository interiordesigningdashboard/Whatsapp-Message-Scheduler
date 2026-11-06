// Applies small upstream fixes to whatsapp-web.js 1.34.7 after `npm install`.
// They are on the library's main branch (pedroslopez/whatsapp-web.js) but not yet released on npm.
// Each patch is only applied once and is skipped if its target code is not found.
// Remove this script once a whatsapp-web.js release includes these fixes.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

// Each patch: `applied` (text present once applied), `find` (regex), and
// `replace(nl, match, ...groups)` returning the replacement text (a function, so "$1" in code is literal).
const PATCHES = [
  {
    // Upstream commit 064a3d5 (PR #201923). Without it, sending an image fails with
    // "Data passed to getter must include an id property (it's how we memoize) but got undefined".
    name: 'media send fix (PR #201923)',
    applied: 'if (message.__x_id) {',
    find: /(\.\.\.extraOptions,\r?\n\s*\};\r?\n)(\s*\/\/ Bot's won't reply)/,
    replace: (nl, m, before, after) => before + [
      "        // MediaData is a model whose private __x_id field collides with Msg's",
      '        // internal id field when its enumerable properties are spread above,',
      '        // breaking getValidatedSender() during Msg initialization.',
      '        if (message.__x_id) {',
      '            delete message.__x_id;',
      '        }',
    ].join(nl) + nl + after,
  },
  {
    // Upstream commit 58ddf15 (PR #201832): WhatsApp Web renamed id._serialized to id.$1 (July 2026).
    // Without it, sendMessage cannot find the message it just sent and returns nothing,
    // so a message that WAS sent looks like a failure.
    name: 'find sent message by new id field (PR #201832)',
    applied: '.Msg.get(newMsgKey._serialized || newMsgKey.$1)',
    find: /\.Msg\.get\(newMsgKey\._serialized\);/,
    replace: () => '.Msg.get(newMsgKey._serialized || newMsgKey.$1);',
  },
  {
    // Same upstream commit: the chat part of a message id.
    name: 'message chat id fallback (PR #201832)',
    applied: 'remote: msg.id.remote._serialized || msg.id.remote.$1,',
    find: /remote: msg\.id\.remote\._serialized,/,
    replace: () => 'remote: msg.id.remote._serialized || msg.id.remote.$1,',
  },
  {
    // Same upstream commit: normalize message ids so Node-side code can keep using _serialized.
    name: 'normalize message id (PR #201832)',
    applied: 'msg.id._serialized == null && msg.id.$1 != null',
    find: /(\r?\n)([ \t]*)delete msg\.pendingAckUpdate;/,
    replace: (nl, m, lineEnd, ind) => lineEnd
      + `${ind}// WhatsApp Web changed _serialized to $1 in message IDs (2026-07 update).${nl}`
      + `${ind}if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {${nl}`
      + `${ind}    msg.id = Object.assign({}, msg.id, { _serialized: msg.id.$1 });${nl}`
      + `${ind}}${nl}${nl}`
      + `${ind}delete msg.pendingAckUpdate;`,
  },
];

if (!fs.existsSync(file)) {
  console.warn('[patch-wwebjs] whatsapp-web.js not installed; skipping.');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';
let changed = false;

for (const p of PATCHES) {
  if (src.includes(p.applied)) {
    console.log(`[patch-wwebjs] already present: ${p.name}`);
  } else if (!p.find.test(src)) {
    console.warn(`[patch-wwebjs] could not apply (different whatsapp-web.js version?): ${p.name}`);
  } else {
    src = src.replace(p.find, (...args) => p.replace(nl, ...args));
    changed = true;
    console.log(`[patch-wwebjs] applied: ${p.name}`);
  }
}

if (changed) fs.writeFileSync(file, src);
