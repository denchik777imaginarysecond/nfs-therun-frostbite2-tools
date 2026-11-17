'use strict';
/*
 * fb2_loc.js — read and write the localization tables of Need for Speed: The Run (Frostbite 2).
 * These are the texts the player sees: menu items, car names, hints, subtitles.
 *
 *   node fb2_loc.js --game "<game dir>" dump [lang]       -> output/loc_<lang>.tsv (id, text), as the game sees it
 *   node fb2_loc.js --game "<game dir>" find <words>      search texts in every installed language
 *   node fb2_loc.js --game "<game dir>" selftest          rebuild every table without changes: must be byte-identical
 *
 * Each language (Data/Win32/Loc/<lang>.toc/.sb, updated by Update/Patch/.../Loc) has two chunks:
 *   strings (magic 0x00039000):
 *     header 36 bytes: [u32 magic][u32 size after the first 8 bytes][u32 count][u32 table offset - 8][u32 text offset - 8][16 bytes name "Global"]
 *     table: count x [u32 string id][u32 text offset], sorted by id
 *     texts: each ends with 0x00; the chunk is padded with zeros to a multiple of 4
 *   characters (magic 0x00039001): [u32 magic][u32 size after 8][u32 next free slot][3072 x u16 UTF-16 character]
 * Text encoding: a byte < 0x80 is that ASCII character. A byte >= 0x80 is a slot of the character table.
 * If that slot holds a small value v (2..13), it is a prefix: the character is in slot v*128 + (next byte - 0x80).
 * String ids are hashes; their ID_... key names are not known, so a text is found by its id or by searching its text.
 */
const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');

const STR_MAGIC = 0x39000, CHAR_MAGIC = 0x39001;
const GAME = path.dirname(L.DATA_DIR);
const BASE_LOC = path.join(L.DATA_DIR, 'Win32', 'Loc');
const PATCH_LOC = path.join(GAME, 'Update', 'Patch', 'Data', 'Win32', 'Loc');

// languages with a text table (two-letter .toc files in the base game)
function languages() {
  return fs.existsSync(BASE_LOC) ? fs.readdirSync(BASE_LOC).filter((f) => /^[a-z]{2}\.toc$/i.test(f)).map((f) => f.slice(0, 2).toLowerCase()).sort() : [];
}

// Reads a language the way the game sees it: from the official patch when it has this language.
function readLoc(lang) {
  const dir = fs.existsSync(path.join(PATCH_LOC, lang + '.toc')) ? PATCH_LOC : BASE_LOC;
  const toc = L.readToc(path.join(dir, lang + '.toc'));
  const fd = fs.openSync(path.join(dir, lang + '.sb'), 'r');
  const chunks = toc.chunks.map((c) => { const b = Buffer.alloc(c.size); fs.readSync(fd, b, 0, c.size, c.offset); return { id: c.id, data: L.unpackBlocks(b) }; });
  fs.closeSync(fd);
  const str = chunks.find((c) => c.data.readUInt32LE(0) === STR_MAGIC);
  const chars = chunks.find((c) => c.data.readUInt32LE(0) === CHAR_MAGIC);
  if (!str || !chars) throw new Error('localization chunks not found for ' + lang);
  const table = [];
  for (let i = 12; i + 1 < chars.data.length; i += 2) table.push(chars.data.readUInt16LE(i));
  const s = str.data, count = s.readUInt32LE(8), tab = 8 + s.readUInt32LE(12), dat = 8 + s.readUInt32LE(16);
  const strings = [];
  for (let i = 0; i < count; i++) {
    const off = s.readUInt32LE(tab + i * 8 + 4);
    let end = dat + off; while (s[end]) end++;
    strings.push({ id: s.readUInt32LE(tab + i * 8), off, bytes: s.subarray(dat + off, end) });
  }
  const loc = { lang, source: dir === PATCH_LOC ? 'official patch' : 'base game', str, chars, table, strings, nextSlot: chars.data.readUInt32LE(8) };
  for (const x of strings) x.text = decodeText(x.bytes, table);
  return loc;
}

function decodeText(bytes, table) {
  let out = '';
  for (let p = 0; p < bytes.length; p++) {
    const c = bytes[p];
    if (c < 0x80) { out += String.fromCharCode(c); continue; }
    let v = table[c];
    if (v > 0 && v < 0x20) v = table[v * 128 + (bytes[++p] - 0x80)]; // two-byte character
    out += v ? String.fromCharCode(v) : '�';
  }
  return out;
}

// Text -> bytes. Characters missing from the table are added to free slots (loc.table / loc.nextSlot are updated).
function encodeText(text, loc) {
  const t = loc.table;
  if (!loc.slotOf) { loc.slotOf = new Map(); t.forEach((v, i) => { if (i >= 0x80 && v >= 0x20 && !loc.slotOf.has(v)) loc.slotOf.set(v, i); }); }
  // prefix byte for each group of 128 slots: byte b (0x80..0xff) whose slot holds the group number v
  const prefixOf = (v) => { for (let b = 0x80; b < 0x100; b++) if (t[b] === v) return b; return -1; };
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) throw new Error(`character "${ch}" cannot be stored (outside UTF-16)`);
    if (code === 0) throw new Error('text cannot contain a NUL character');
    if (code < 0x80) { out.push(code); continue; }
    let slot = loc.slotOf.get(code);
    if (slot === undefined) {
      // a new character: next free slot, inside a 128-slot group that has a prefix byte
      slot = loc.nextSlot;
      if (slot >= t.length || prefixOf(slot >> 7) < 0) throw new Error(`no room for the new character "${ch}" in the ${loc.lang} character table`);
      t[slot] = code; loc.slotOf.set(code, slot); loc.nextSlot = slot + 1; loc.charsChanged = true;
    }
    if (slot < 0x100) out.push(slot);
    else out.push(prefixOf(slot >> 7), 0x80 + (slot & 127));
  }
  return Buffer.from(out);
}

// New string chunk (and character chunk if characters were added). changes: Map(id -> text).
// Texts keep their original order, so with no changes the result is byte-identical to the original.
function buildLoc(loc, changes = new Map()) {
  const s = loc.str.data;
  const entries = loc.strings.map((x) => ({ id: x.id, bytes: changes.has(x.id) ? encodeText(changes.get(x.id), loc) : x.bytes, off: x.off }));
  for (const id of changes.keys()) if (!loc.strings.some((x) => x.id === id)) throw new Error(`text id ${id.toString(16).padStart(8, '0')} does not exist in ${loc.lang}`);
  const order = [...entries].sort((a, b) => a.off - b.off); // original storage order
  const head = 36, tab = head, dat = tab + entries.length * 8;
  let pos = 0;
  for (const e of order) { e.newOff = pos; pos += e.bytes.length + 1; }
  const size = (dat + pos + 3) & ~3;
  const out = Buffer.alloc(size);
  s.copy(out, 0, 0, head); // magic, name and unknown fields stay as they are
  out.writeUInt32LE(size - 8, 4); out.writeUInt32LE(entries.length, 8); out.writeUInt32LE(tab - 8, 12); out.writeUInt32LE(dat - 8, 16);
  entries.forEach((e, i) => { out.writeUInt32LE(e.id, tab + i * 8); out.writeUInt32LE(e.newOff, tab + i * 8 + 4); });
  for (const e of order) e.bytes.copy(out, dat + e.newOff);
  let chars = null;
  if (loc.charsChanged) {
    chars = Buffer.from(loc.chars.data);
    chars.writeUInt32LE(loc.nextSlot, 8);
    loc.table.forEach((v, i) => chars.writeUInt16LE(v, 12 + i * 2));
  }
  return { str: out, chars, strId: loc.str.id, charsId: loc.chars.id };
}

const hexId = (id) => id.toString(16).padStart(8, '0');
const parseId = (h) => { const n = parseInt(String(h).replace(/^0x/i, ''), 16); if (!Number.isFinite(n)) throw new Error('bad text id: ' + h); return n >>> 0; };

module.exports = { languages, readLoc, buildLoc, encodeText, decodeText, hexId, parseId };

// ============================================================ CLI ===
if (require.main === module) {
  const [cmd, ...rest] = L.OPTS.rest;
  if (cmd === 'dump') {
    for (const lang of rest.length ? rest : languages()) {
      const loc = readLoc(lang);
      const f = path.join(L.OUT_DIR, `loc_${lang}.tsv`);
      fs.mkdirSync(L.OUT_DIR, { recursive: true });
      fs.writeFileSync(f, 'id\ttext\n' + loc.strings.map((x) => hexId(x.id) + '\t' + x.text.replace(/[\t\r\n]/g, ' ')).join('\n') + '\n', 'utf8');
      console.log(`${lang} (${loc.source}): ${loc.strings.length} texts -> ${f}`);
    }
  } else if (cmd === 'find') {
    const words = rest.map((w) => w.toLowerCase());
    for (const lang of languages()) for (const x of readLoc(lang).strings) if (words.every((w) => x.text.toLowerCase().includes(w))) console.log(`${lang} ${hexId(x.id)}  ${x.text}`);
  } else if (cmd === 'selftest') {
    let ok = 0, all = 0;
    for (const lang of languages()) {
      const loc = readLoc(lang);
      const r = buildLoc(loc);
      all++; const same = r.str.equals(loc.str.data) && !r.chars;
      if (same) ok++;
      console.log(`${lang}: rebuild without changes ${same ? 'byte-identical' : 'DIFFERENT'} (${loc.strings.length} texts, ${loc.source})`);
      // re-encoding every text with our encoder must give the same bytes
      let enc = 0; for (const x of loc.strings) if (encodeText(x.text, loc).equals(x.bytes)) enc++;
      console.log(`    encoder: ${enc}/${loc.strings.length} texts re-encode to identical bytes`);
    }
    console.log(ok === all ? 'SELFTEST OK' : 'SELFTEST FAILED');
  } else {
    console.log('Commands: dump [lang] | find <words> | selftest');
  }
}
