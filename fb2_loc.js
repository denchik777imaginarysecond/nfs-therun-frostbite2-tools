'use strict';
/*
 * fb2_loc.js — decoder for Need for Speed: The Run localization tables (Frostbite 2, LocalizedStringResource).
 *
 * Layout (reverse-engineered from the game files):
 *   chunk 1 (magic 0x00039000): string count, table of (string ID, offset) pairs, then the strings.
 *     A string is bytes up to 0x00. A byte < 0x80 is a plain ASCII character.
 *     A byte >= 0x80 is an index into the character table (chunk 2). If that slot holds a small value v (2..13),
 *     it is a prefix: character = table[v*128 + (next byte - 0x80)].
 *   chunk 2 (magic 0x00039001): UTF-16 character table (3072 slots).
 *   String IDs are numeric; below we try to match them against hashes of ID_* keys found in ebx (no match found yet).
 *
 *   node fb2_loc.js --game "<game dir>" [ru]   -> output/loc_ru.tsv + summary
 */
const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');
const { hashName } = require('./fb2_ebx.js');

const lang = L.OPTS.rest[0] || 'ru';
const dir = path.join(L.DATA_DIR, 'Win32', 'Loc');
const toc = L.readToc(path.join(dir, lang + '.toc'));
const fd = fs.openSync(path.join(dir, lang + '.sb'), 'r');
const chunks = toc.chunks.map((c) => { const b = Buffer.alloc(c.size); fs.readSync(fd, b, 0, c.size, c.offset); return L.unpackBlocks(b); });
const strData = chunks.find((d) => d.readUInt32LE(0) === 0x39000);
const charData = chunks.find((d) => d.readUInt32LE(0) === 0x39001);

const table = [];
for (let i = 12; i + 1 < charData.length; i += 2) table.push(charData.readUInt16LE(i));

const count = strData.readUInt32LE(8), tab = 8 + strData.readUInt32LE(12), dat = 8 + strData.readUInt32LE(16);
let bad = 0;
function decode(off) {
  let s = '', p = dat + off;
  for (;;) {
    const c = strData[p++];
    if (c === 0 || c === undefined) break;
    if (c < 0x80) { s += String.fromCharCode(c); continue; }
    let v = table[c];
    if (v > 0 && v < 0x20) v = table[v * 128 + (strData[p++] - 0x80)]; // two-byte character
    if (!v) { bad++; s += '�'; continue; }
    s += String.fromCharCode(v);
  }
  return s;
}
const strings = [];
for (let i = 0; i < count; i++) strings.push({ id: strData.readUInt32LE(tab + i * 8), text: decode(strData.readUInt32LE(tab + i * 8 + 4)) });
console.log(`strings: ${strings.length}, unknown characters: ${bad}`);

// --- string keys: collect every ID_... string from ebx and try candidate hash functions
const db = fs.readFileSync(path.join(L.OUT_DIR, 'ebx_db.jsonl'), 'latin1').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const keys = new Map(); // key -> where it is used
for (const r of db) for (const s of r.strings) if (/^ID_[A-Z0-9_]+$/i.test(s)) { if (!keys.has(s)) keys.set(s, r.name); }
const byId = new Map(strings.map((s) => [s.id, s]));
const fnv1 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 0x01000193) ^ s.charCodeAt(i)) >>> 0; return h; };
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h; };
const variants = { djb2xor: hashName, 'djb2xor(lower)': (s) => hashName(s.toLowerCase()), fnv1, fnv1a, 'fnv1(lower)': (s) => fnv1(s.toLowerCase()), 'fnv1a(lower)': (s) => fnv1a(s.toLowerCase()) };
let best = null;
for (const [name, fn] of Object.entries(variants)) {
  let hit = 0; for (const k of keys.keys()) if (byId.has(fn(k))) hit++;
  console.log(`hash ${name}: matched ${hit} of ${keys.size} keys`);
  if (!best || hit > best.hit) best = { name, fn, hit };
}
const keyOf = new Map();
if (best.hit > keys.size * 0.3) for (const [k, where] of keys) { const h = best.fn(k); if (byId.has(h)) keyOf.set(h, { k, where }); }

const out = strings.map((s) => [s.id.toString(16).padStart(8, '0'), keyOf.has(s.id) ? keyOf.get(s.id).k : '', keyOf.has(s.id) ? keyOf.get(s.id).where : '', s.text.replace(/[\t\n\r]/g, ' ')].join('\t'));
fs.writeFileSync(path.join(L.OUT_DIR, `loc_${lang}.tsv`), 'id\tkey\tused_in\ttext\n' + out.join('\n') + '\n', 'utf8');
console.log(`keys matched: ${keyOf.size}; table: ${path.join(L.OUT_DIR, `loc_${lang}.tsv`)}`);
module.exports = { strings };
