'use strict';
/*
 * fb2_extract.js — Frostbite 2 asset extractor (Need for Speed: The Run).
 *
 * How it works (short version):
 *   .toc — the table of contents: a list of bundles and where each one sits inside the .sb file.
 *   .sb  — the storage file: bundles stored one after another.
 *   Bundle = header (names, sizes) + asset data: ebx (asset descriptions),
 *            res (resources: meshes, textures...), chunk (raw data blobs that only have a GUID).
 *   Large data is compressed with zlib in 64 KB blocks.
 * The game files are only READ, nothing is ever modified.
 *
 * Usage (all fb2_*.js scripts share these options):
 *   --game <path>   game folder (or its Data folder); can also be set with NFS_THE_RUN_DIR
 *   --out  <path>   where results are written (default: ./output)
 *
 *   node fb2_extract.js --game "<game dir>" index                 — build the index (output/asset_index.tsv)
 *   node fb2_extract.js --game "<game dir>" find  word1 ...       — list matching asset names
 *   node fb2_extract.js --game "<game dir>" extract [--chunks] word1 ...
 *                                                                — extract matching assets
 *   (a word matches any part of the asset name, case-insensitive)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------- options ------
// Shared by all scripts: --game <game dir> and --out <output dir>.
// Everything else (commands, search words) stays in OPTS.rest.
function parseOptions(argv) {
  const opts = { game: process.env.NFS_THE_RUN_DIR || '', out: path.resolve('output'), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--game') opts.game = argv[++i] || '';
    else if (argv[i] === '--out') opts.out = path.resolve(argv[++i] || 'output');
    else opts.rest.push(argv[i]);
  }
  return opts;
}
const OPTS = parseOptions(process.argv.slice(2));
if (!OPTS.game) {
  console.error('Please pass the game folder: --game "<path to Need For Speed The Run>" (or set NFS_THE_RUN_DIR)');
  process.exit(1);
}
// Accept both the game root and its Data folder
const DATA_DIR = fs.existsSync(path.join(OPTS.game, 'Data', 'Win32')) ? path.join(OPTS.game, 'Data') : OPTS.game;
if (!fs.existsSync(path.join(DATA_DIR, 'Win32'))) {
  console.error('Could not find Data/Win32 in: ' + OPTS.game);
  process.exit(1);
}
const OUT_DIR = OPTS.out;
fs.mkdirSync(OUT_DIR, { recursive: true });
const INDEX_FILE = path.join(OUT_DIR, 'asset_index.tsv');
const BUNDLE_MAGIC = 0x970d1c13;

// ============================================================ TOC ==========

// .toc: 8-byte header, signature, key (257 bytes at offset 296),
// the body (from offset 556) is obfuscated with a simple XOR against that key.
function readToc(file) {
  const raw = fs.readFileSync(file);
  const magic = raw.readUInt32BE(0);
  if (magic !== 0x00D1CE00 && magic !== 0x00D1CE01) {
    throw new Error('unknown toc format (magic ' + magic.toString(16) + ')');
  }
  const key = raw.subarray(296, 296 + 257);
  const body = Buffer.alloc(raw.length - 556);
  for (let i = 0; i < body.length; i++) body[i] = raw[556 + i] ^ key[i % 257] ^ 123;
  return parseDb(body);
}

// Binary "DbObject" format: type byte (+0x80 = no name), name, value.
function parseDb(buf) {
  let p = 0;
  const varint = () => { // 7 bits per byte, high bit = "more bytes follow"
    let r = 0, mul = 1, b;
    do { b = buf[p++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return r;
  };
  const cstr = () => {
    const e = buf.indexOf(0, p);
    const s = buf.toString('latin1', p, e);
    p = e + 1;
    return s;
  };
  function elem() { // returns [name, value] or null (end marker 0x00)
    const t = buf[p++];
    if (t === 0) return null;
    const type = t & 0x1f;
    const name = (t & 0x80) ? '' : cstr();
    let v;
    switch (type) {
      case 1: { varint(); v = []; for (let e; (e = elem());) v.push(e[1]); break; }          // list
      case 2: { varint(); v = {}; for (let e; (e = elem());) v[e[0]] = e[1]; break; }        // object
      case 6: v = buf[p++] !== 0; break;                                                     // bool
      case 7: { const n = varint(); v = buf.toString('latin1', p, p + n - 1); p += n; break; } // string
      case 8: v = buf.readInt32LE(p); p += 4; break;                                         // int32
      case 9: v = Number(buf.readBigInt64LE(p)); p += 8; break;                              // int64
      case 0x0f: v = buf.subarray(p, p + 16).toString('hex'); p += 16; break;                // GUID
      case 0x10: v = buf.subarray(p, p + 20).toString('hex'); p += 20; break;               // sha1
      case 0x13: { const n = varint(); v = buf.subarray(p, p + n); p += n; break; }          // blob
      default: throw new Error('unknown type ' + t.toString(16) + ' at offset ' + (p - 1));
    }
    return [name, v];
  }
  return elem()[1];
}

// ======================================================= BUNDLE HEADER =====

// All header numbers are big-endian. Offsets are relative to byte 4 of the bundle.
function readBundle(fd, off, totalSize) {
  const h4 = Buffer.alloc(4);
  fs.readSync(fd, h4, 0, 4, off);
  const hsize = h4.readUInt32BE(0);
  if (hsize < 40 || hsize > 0x4000000) return null;
  const hb = Buffer.alloc(hsize + 4);
  fs.readSync(fd, hb, 0, hsize + 4, off);
  if (hb.readUInt32BE(4) !== BUNDLE_MAGIC) return null;

  const total = hb.readUInt32BE(8);
  const nEbx = hb.readUInt32BE(12), nRes = hb.readUInt32BE(16), nChunk = hb.readUInt32BE(20);
  const strBase = 4 + hb.readUInt32BE(24);
  let p = 36 + total * 20; // skip the sha1 table (20 bytes per asset)

  const cstrAt = (o) => { const s = strBase + o, e = hb.indexOf(0, s); return hb.toString('latin1', s, e); };
  const entries = [];
  const readNamed = (kind, n) => { // entry: name offset, stored size, unpacked size
    for (let i = 0; i < n; i++, p += 12) {
      entries.push({ kind, name: cstrAt(hb.readUInt32BE(p)), size: hb.readUInt32BE(p + 4), orig: hb.readUInt32BE(p + 8), extra: '' });
    }
  };
  readNamed('ebx', nEbx);
  const firstRes = entries.length;
  readNamed('res', nRes);
  for (let i = 0; i < nRes; i++, p += 4) entries[firstRes + i].extra = hb.readUInt32BE(p).toString(16); // resource type
  p += nRes * 16; // resource metadata (not needed here)
  for (let i = 0; i < nChunk; i++, p += 28) {
    // chunk: GUID(16) + three numbers (A, B, C). Real stored size = B - A
    // (usually A = 0; "trimmed" chunks have A > 0 — found by matching against the bundle size).
    const a = hb.readUInt32BE(p + 16), bb = hb.readUInt32BE(p + 20);
    // The bundle table stores the GUID with its first three fields byte-swapped (4+2+2 bytes),
    // while res data and .toc files use the normal form. Normalize it, or references won't match.
    const g = Buffer.from(hb.subarray(p, p + 16));
    g.subarray(0, 4).reverse(); g.subarray(4, 6).reverse(); g.subarray(6, 8).reverse();
    entries.push({ kind: 'chunk', name: g.toString('hex'), size: bb - a, orig: 0, extra: '' });
  }

  // Data follows the header back to back; every entry starts at a 16-byte aligned offset.
  let pos = off + 4 + hsize;
  for (const e of entries) {
    pos = off + Math.ceil((pos - off) / 16) * 16;
    e.pos = pos;
    pos += e.size;
  }
  return { entries, slack: off + totalSize - pos };
}

// ===================================================== READING DATA ======

// Block: [u32 unpacked size][u16 type][u16 compressed size] + data.
function unpackBlocks(buf) {
  // Not every chunk is block-compressed: video (MVhd...) and audio (EA SPS, 0x48...) are stored as plain files.
  // If the first "block header" doesn't look real, return the data as is.
  if (buf.length >= 8) {
    const u0 = buf.readUInt32BE(0), t0 = buf.readUInt16BE(4), c0 = buf.readUInt16BE(6);
    const valid = u0 > 0 && u0 <= 0x40000 && (t0 === 0 || t0 === 0x70 || t0 === 0x71) && 8 + c0 <= buf.length;
    if (!valid) return buf;
  }
  const parts = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const u = buf.readUInt32BE(p), type = buf.readUInt16BE(p + 4), c = buf.readUInt16BE(p + 6);
    if (u === 0) break; // trailing padding
    p += 8;
    if (type === 0) parts.push(zlib.inflateSync(buf.subarray(p, p + c)));
    else { parts.push(buf.subarray(p, p + (c || u))); } // uncompressed block (just in case)
    p += c;
  }
  return Buffer.concat(parts);
}

function readAsset(fd, e) {
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, e.pos);
  if (e.kind === 'chunk' || e.size !== e.orig) return unpackBlocks(buf);
  return buf; // sizes are equal => data is stored as is
}

// ========================================================= INDEX ===========

function findTocs(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) findTocs(full, out);
    else if (d.name.toLowerCase().endsWith('.toc') && d.name.toLowerCase() !== 'layout.toc') out.push(full);
  }
  return out;
}

function buildIndex() {
  const lines = [];
  const stats = { toc: 0, skipped: 0, bundles: 0, badBundles: 0, assets: 0, unaligned: 0, slackBad: 0 };
  for (const toc of findTocs(path.join(DATA_DIR, 'Win32'))) {
    const sbFile = toc.replace(/\.toc$/i, '.sb');
    let db;
    try { db = readToc(toc); } catch (err) { console.error('toc skipped:', toc, err.message); stats.skipped++; continue; }
    if (db.cas || !db.bundles || !fs.existsSync(sbFile)) { stats.skipped++; continue; } // CAS archives are not used by this game
    stats.toc++;
    const fd = fs.openSync(sbFile, 'r');
    const rel = path.relative(DATA_DIR, sbFile);
    for (const b of db.bundles) {
      stats.bundles++;
      if (b.offset % 16) stats.unaligned++;
      const info = readBundle(fd, b.offset, b.size);
      if (!info) { stats.badBundles++; continue; }
      if (info.slack < 0 || info.slack > 15) stats.slackBad++;
      for (const e of info.entries) {
        stats.assets++;
        lines.push([e.kind, e.name, rel, e.pos, e.size, e.orig, e.extra, b.id].join('\t'));
      }
    }
    fs.closeSync(fd);
  }
  fs.writeFileSync(INDEX_FILE, lines.join('\n') + '\n');
  console.log('Index ready:', INDEX_FILE);
  console.log(stats);
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) throw new Error('No index found. Run first: node fb2_extract.js --game "<game dir>" index');
  return fs.readFileSync(INDEX_FILE, 'latin1').split('\n').filter(Boolean).map((l) => {
    const [kind, name, sb, pos, size, orig, extra, bundle] = l.split('\t');
    return { kind, name, sb, pos: +pos, size: +size, orig: +orig, extra, bundle };
  });
}

function match(index, words, withChunks) {
  const w = words.map((x) => x.toLowerCase());
  return index.filter((e) => (withChunks || e.kind !== 'chunk') && w.some((x) => e.name.toLowerCase().includes(x)));
}

// ======================================================= EXTRACTION ========

function extract(words, outDir, withChunks) {
  const found = match(loadIndex(), words, withChunks);
  const seen = new Set(); // the same asset sits in several bundles — take it once
  const fds = new Map();
  const done = [];
  let failed = 0;
  for (const e of found) {
    const key = e.kind + ':' + e.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!fds.has(e.sb)) fds.set(e.sb, fs.openSync(path.join(DATA_DIR, e.sb), 'r'));
      const data = readAsset(fds.get(e.sb), e);
      const safe = e.name.replace(/[<>:"|?*]/g, '_').replace(/\.\./g, '_');
      const target = path.join(outDir, e.kind, safe + '.' + e.kind);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      done.push({ target, bytes: data.length, kind: e.kind });
    } catch (err) {
      failed++;
      console.error('Error:', e.kind, e.name, '-', err.message);
    }
  }
  for (const fd of fds.values()) fs.closeSync(fd);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '_manifest.txt'), done.map((d) => d.bytes + '\t' + d.target).join('\n') + '\n');
  return { done, failed };
}

// ============================================================ MAIN ==========

// When required from another script, only export the functions and run nothing.
module.exports = { OPTS, DATA_DIR, OUT_DIR, INDEX_FILE, readToc, readBundle, readAsset, unpackBlocks, loadIndex, buildIndex };
const [cmd, ...rest] = require.main === module ? OPTS.rest : ['__lib__'];
if (cmd === '__lib__') {
  // library mode
} else if (cmd === 'index') {
  buildIndex();
} else if (cmd === 'find') {
  for (const e of match(loadIndex(), rest, false)) console.log(e.kind + '\t' + e.name);
} else if (cmd === 'extract') {
  const out = path.join(OUT_DIR, 'extracted');
  let withChunks = false;
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--chunks') withChunks = true;
    else words.push(rest[i]);
  }
  const { done, failed } = extract(words, out, withChunks);
  console.log('Extracted files:', done.length, ', errors:', failed);
} else {
  console.log('Commands: index | find words... | extract [--chunks] words...   (shared options: --game <game dir> --out <dir>)');
}
