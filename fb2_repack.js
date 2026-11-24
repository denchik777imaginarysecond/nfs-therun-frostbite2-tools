'use strict';
/*
 * fb2_repack.js — write support for Frostbite 2 (Need for Speed: The Run): the library behind fb2_patch.js.
 *
 *   - Lossless DbObject reader/writer: keeps every type, name, order and unknown field, so an unmodified
 *     .toc is re-written byte-for-byte (verified by `node fb2_repack.js --game "<game dir>" selftest`).
 *   - .toc file encode: the original 556-byte header (signature + XOR key) is kept as is; the body is
 *     XOR-ed with the same key, exactly like fb2_extract.js reads it.
 *   - packBlocks(): zlib block framing used by bundles and chunks ([u32 BE size][u16 type][u16 BE packed size]).
 *   - appendToSb(): append-only writes, 16-byte aligned (the original archives are never rewritten in place).
 *   - rebuildBundle(): re-emits a bundle with some entries replaced; untouched entries are copied byte-for-byte.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const L = require('./fb2_extract.js');

const TOC_HEADER = 556;
const TOC_KEY_AT = 296;
const TOC_KEY_LEN = 257;

// ============================================================ DbObject (lossless) ===

const T_LIST = 1, T_OBJECT = 2, T_BOOL = 6, T_STRING = 7, T_INT32 = 8, T_INT64 = 9, T_GUID = 0x0f, T_SHA1 = 0x10, T_BLOB = 0x13;

// Node: { t: <raw type byte>, name: Buffer|null, v: <value> }
//   list/object -> array of nodes; bool -> number; string/guid/sha1/blob -> Buffer; int32 -> number; int64 -> BigInt
function dbRead(buf) {
  let p = 0;
  const varint = () => {
    let r = 0, mul = 1, b;
    do { b = buf[p++]; r += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return r;
  };
  function node() {
    const t = buf[p++];
    if (t === 0) return null;
    let name = null;
    if (!(t & 0x80)) { const e = buf.indexOf(0, p); name = Buffer.from(buf.subarray(p, e)); p = e + 1; }
    let v;
    switch (t & 0x1f) {
      case T_LIST: case T_OBJECT: { varint(); v = []; for (let n; (n = node());) v.push(n); break; }
      case T_BOOL: v = buf[p++]; break;
      case T_STRING: case T_BLOB: { const n = varint(); v = Buffer.from(buf.subarray(p, p + n)); p += n; break; }
      case T_INT32: v = buf.readInt32LE(p); p += 4; break;
      case T_INT64: v = buf.readBigInt64LE(p); p += 8; break;
      case T_GUID: v = Buffer.from(buf.subarray(p, p + 16)); p += 16; break;
      case T_SHA1: v = Buffer.from(buf.subarray(p, p + 20)); p += 20; break;
      default: throw new Error('DbObject: unknown type 0x' + t.toString(16) + ' at ' + (p - 1));
    }
    return { t, name, v };
  }
  const root = node();
  return { root, rest: Buffer.from(buf.subarray(p)) }; // rest: any trailing bytes, kept verbatim
}

function encVarint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}

function dbWrite(node) {
  const parts = [Buffer.from([node.t])];
  if (node.name) parts.push(node.name, Buffer.from([0]));
  const v = node.v;
  switch (node.t & 0x1f) {
    case T_LIST: case T_OBJECT: { const body = Buffer.concat([...v.map(dbWrite), Buffer.from([0])]); parts.push(encVarint(body.length), body); break; }
    case T_BOOL: parts.push(Buffer.from([v])); break;
    case T_STRING: case T_BLOB: parts.push(encVarint(v.length), v); break;
    case T_INT32: { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); break; }
    case T_INT64: { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); break; }
    case T_GUID: case T_SHA1: parts.push(v); break;
    default: throw new Error('DbObject: cannot write type 0x' + node.t.toString(16));
  }
  return Buffer.concat(parts);
}

// Helpers for editing toc trees
const child = (obj, name) => obj.v.find((n) => n.name && n.name.toString('latin1') === name);
const numOf = (n) => Number(n.v);
function setNum(n, value) {
  if ((n.t & 0x1f) === T_INT64) n.v = BigInt(value);
  else if ((n.t & 0x1f) === T_INT32) { if (value > 0x7fffffff) throw new Error('value does not fit int32: ' + value); n.v = value; }
  else throw new Error('not a number node');
}
const strOf = (n) => n.v.toString('latin1', 0, n.v.length - 1); // strings include their trailing 0

// ============================================================ TOC files ===

function readTocFile(file) {
  const raw = fs.readFileSync(file);
  const magic = raw.readUInt32BE(0);
  if (magic !== 0x00d1ce00 && magic !== 0x00d1ce01) throw new Error('unknown toc magic ' + magic.toString(16) + ' in ' + file);
  const key = raw.subarray(TOC_KEY_AT, TOC_KEY_AT + TOC_KEY_LEN);
  const body = Buffer.alloc(raw.length - TOC_HEADER);
  for (let i = 0; i < body.length; i++) body[i] = raw[TOC_HEADER + i] ^ key[i % TOC_KEY_LEN] ^ 123;
  const { root, rest } = dbRead(body);
  return { file, header: Buffer.from(raw.subarray(0, TOC_HEADER)), root, rest };
}

function encodeToc(toc) {
  const body = Buffer.concat([dbWrite(toc.root), toc.rest]);
  const key = toc.header.subarray(TOC_KEY_AT, TOC_KEY_AT + TOC_KEY_LEN);
  const out = Buffer.alloc(TOC_HEADER + body.length);
  toc.header.copy(out, 0);
  for (let i = 0; i < body.length; i++) out[TOC_HEADER + i] = body[i] ^ key[i % TOC_KEY_LEN] ^ 123;
  return out;
}

// Find {id, offset, size} entries
function tocChunks(toc) { const c = child(toc.root, 'chunks'); return c ? c.v : []; }
function tocBundles(toc) { const b = child(toc.root, 'bundles'); return b ? b.v : []; }
const entryId = (e) => { const n = child(e, 'id'); return (n.t & 0x1f) === T_GUID ? n.v.toString('hex') : strOf(n); };
const entryFlag = (e, f) => { const n = child(e, f); return !!(n && n.v); };

// ============================================================ blocks ===

// Same framing as unpackBlocks(): 64 KB pieces, zlib (type 0). A piece whose packed form would not fit
// the 16-bit size field is split in half until it does.
// A chunk packed the way the game packs streamed textures: when raw.logicalOffset is set (the levels streamed
// later end there), a new block starts exactly at that offset, so bundles that hold only the tail can point at it.
function packChunk(raw, split = raw.logicalOffset) {
  if (!split || split >= raw.length) return packBlocks(raw);
  return Buffer.concat([packBlocks(raw.subarray(0, split)), packBlocks(raw.subarray(split))]);
}

function packBlocks(data, blockSize = 0x10000) {
  const parts = [];
  const emit = (piece) => {
    const z = zlib.deflateSync(piece, { level: 9 });
    if (z.length > 0xffff) {
      if (piece.length <= 0x1000) throw new Error('packBlocks: block does not compress into 64 KB');
      const half = piece.length >> 1;
      emit(piece.subarray(0, half)); emit(piece.subarray(half));
      return;
    }
    const h = Buffer.alloc(8);
    h.writeUInt32BE(piece.length, 0); h.writeUInt16BE(0, 4); h.writeUInt16BE(z.length, 6);
    parts.push(h, z);
  };
  for (let off = 0; off < data.length; off += blockSize) emit(data.subarray(off, off + blockSize));
  return Buffer.concat(parts);
}

// Is this stored chunk block-framed (true) or a plain file such as video/audio (false)?
// totalLen: full stored size when only the first bytes were read (the first block may be longer than buf).
function isBlockFramed(buf, totalLen = buf.length) {
  if (buf.length < 8) return false;
  const u = buf.readUInt32BE(0), t = buf.readUInt16BE(4), c = buf.readUInt16BE(6);
  return u > 0 && u <= 0x40000 && (t === 0 || t === 0x70 || t === 0x71) && 8 + c <= totalLen;
}

// ============================================================ .sb append ===

// Appends data at a 16-byte aligned offset; returns that offset.
function appendToSb(sbFile, data) {
  const fd = fs.openSync(sbFile, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const off = Math.ceil(size / 16) * 16;
    if (off > size) fs.writeSync(fd, Buffer.alloc(off - size), 0, off - size, size);
    fs.writeSync(fd, data, 0, data.length, off);
    return off;
  } finally { fs.closeSync(fd); }
}

// ============================================================ bundles ===

// Header layout matches readBundle() in fb2_extract.js.
function bundleLayout(hb) {
  const total = hb.readUInt32BE(8), nEbx = hb.readUInt32BE(12), nRes = hb.readUInt32BE(16), nChunk = hb.readUInt32BE(20);
  const sha1At = (i) => 36 + i * 20;
  const namedAt = (i) => 36 + total * 20 + i * 12;           // ebx then res: [nameOff, size, orig]
  const chunkAt = (j) => 36 + total * 20 + (nEbx + nRes) * 12 + nRes * 4 + nRes * 16 + j * 28; // GUID, A, B, C
  return { total, nEbx, nRes, nChunk, sha1At, namedAt, chunkAt };
}

// replacements: Map<entryIndex, Buffer of the new UNPACKED data>. Index order: ebx, res, chunks.
function rebuildBundle(fd, off, size, replacements = new Map()) {
  const info = L.readBundle(fd, off, size);
  if (!info) throw new Error('not a bundle at offset ' + off);
  const h4 = Buffer.alloc(4); fs.readSync(fd, h4, 0, 4, off);
  const hsize = h4.readUInt32BE(0);
  const hb = Buffer.alloc(hsize + 4); fs.readSync(fd, hb, 0, hsize + 4, off);
  const lay = bundleLayout(hb);
  const parts = [hb];
  let pos = hb.length;
  info.entries.forEach((e, i) => {
    const aligned = Math.ceil(pos / 16) * 16;
    if (aligned > pos) { parts.push(Buffer.alloc(aligned - pos)); pos = aligned; }
    let stored;
    if (!replacements.has(i)) {
      stored = Buffer.alloc(e.size); fs.readSync(fd, stored, 0, e.size, e.pos);
    } else {
      const raw = replacements.get(i);
      const orig = Buffer.alloc(e.size); fs.readSync(fd, orig, 0, e.size, e.pos);
      if (e.kind === 'chunk') {
        const at = lay.chunkAt(i - lay.nEbx - lay.nRes);
        const a = hb.readUInt32BE(at + 16);
        if (a !== 0) {
          // A partial copy: the bundle holds only the tail of the chunk (e.g. a texture without its biggest mip level,
          // which the game streams later). Meta: A = where the tail starts in the packed full chunk, B = packed full
          // size, C = logical offset of the tail (bytes of the levels left out). Verified on the game's own bundles.
          const C = hb.readUInt32BE(at + 24);
          if (!isBlockFramed(orig)) throw new Error('chunk with a non-zero logical offset is not block-packed: ' + e.name);
          const oldFull = C + L.unpackBlocks(orig).length;
          const newC = raw.logicalOffset !== undefined ? raw.logicalOffset : raw.length === oldFull ? C : null;
          if (newC === null) throw new Error(`chunk ${e.name}: a partial copy needs the new logical offset (size changed: ${oldFull} -> ${raw.length})`);
          const packed = packChunk(raw, newC);
          let p = 0, logical = 0;
          while (logical < newC && p < packed.length) { logical += packed.readUInt32BE(p); p += 8 + packed.readUInt16BE(p + 6); }
          if (logical !== newC) throw new Error(`chunk ${e.name}: the tail does not start on a block border (${newC})`);
          stored = packed.subarray(p);
          hb.writeUInt32BE(p, at + 16); hb.writeUInt32BE(packed.length, at + 20); hb.writeUInt32BE(newC, at + 24);
        } else {
          stored = isBlockFramed(orig) ? packChunk(raw) : raw;       // keep the original storage style (and the tail border)
          hb.writeUInt32BE(stored.length, at + 20);                 // B = A + stored size
        }
      } else {
        const wasRaw = e.size === e.orig;
        stored = wasRaw ? raw : packBlocks(raw);
        if (!wasRaw && stored.length === raw.length) stored = raw;  // a reader would take equal sizes as "raw"
        const at = lay.namedAt(i);
        hb.writeUInt32BE(stored.length, at + 4);
        hb.writeUInt32BE(raw.length, at + 8);
      }
      // the bundle sha1 table hashes the STORED bytes (verified: 4539/4539 compressed res/chunk entries in UI.sb)
      crypto.createHash('sha1').update(stored).digest().copy(hb, lay.sha1At(i));
    }
    parts.push(stored);
    pos += stored.length;
  });
  const end = Math.ceil(pos / 16) * 16;
  if (end > pos) parts.push(Buffer.alloc(end - pos));
  return Buffer.concat(parts);
}

// ============================================================ adding assets to a bundle ===
// The whole bundle header, as lists:
//   [u32 hsize][magic][total][nEbx][nRes][nChunk][names at][chunkMeta at][chunkMeta size]   (offsets from byte 4)
//   sha1 per entry (20) | ebx + res: name at, stored size, unpacked size (12) | res type (4) | res meta (16)
//   | chunk: GUID, A, B, C (28) | chunkMeta (a DbObject list, one item per chunk: h32, meta{firstMip}) | names
function parseBundle(buf) {
  const hsize = buf.readUInt32BE(0), lay = bundleLayout(buf);
  const strBase = 4 + buf.readUInt32BE(24), metaAt = buf.readUInt32BE(28), metaSize = buf.readUInt32BE(32);
  const name = (o) => buf.toString('latin1', strBase + o, buf.indexOf(0, strBase + o));
  const resAt = 36 + lay.total * 20 + (lay.nEbx + lay.nRes) * 12;
  const metaNode = metaSize ? dbRead(buf.subarray(4 + metaAt, 4 + metaAt + metaSize)).root : null;
  const meta = metaNode ? metaNode.v : [];
  if (meta.length !== lay.nChunk) throw new Error(`bundle has ${lay.nChunk} chunks but ${meta.length} chunkMeta items`);
  const entries = [];
  for (let i = 0; i < lay.total; i++) {
    const e = { sha1: Buffer.from(buf.subarray(lay.sha1At(i), lay.sha1At(i) + 20)) };
    if (i < lay.nEbx + lay.nRes) {
      const at = lay.namedAt(i);
      Object.assign(e, { kind: i < lay.nEbx ? 'ebx' : 'res', name: name(buf.readUInt32BE(at)), size: buf.readUInt32BE(at + 4), orig: buf.readUInt32BE(at + 8) });
      if (e.kind === 'res') { const r = i - lay.nEbx; e.resType = Buffer.from(buf.subarray(resAt + r * 4, resAt + r * 4 + 4)); e.resMeta = Buffer.from(buf.subarray(resAt + lay.nRes * 4 + r * 16, resAt + lay.nRes * 4 + r * 16 + 16)); }
    } else {
      const j = i - lay.nEbx - lay.nRes, at = lay.chunkAt(j);
      const g = Buffer.from(buf.subarray(at, at + 16)); g.subarray(0, 4).reverse(); g.subarray(4, 6).reverse(); g.subarray(6, 8).reverse();
      Object.assign(e, { kind: 'chunk', name: g.toString('hex'), chunk: Buffer.from(buf.subarray(at, at + 28)), size: buf.readUInt32BE(at + 20) - buf.readUInt32BE(at + 16), meta: meta[j] });
    }
    entries.push(e);
  }
  let pos = 4 + hsize;
  for (const e of entries) { pos = Math.ceil(pos / 16) * 16; e.data = Buffer.from(buf.subarray(pos, pos + e.size)); pos += e.size; }
  return { magic: buf.readUInt32BE(4), metaNode, entries };
}

function writeBundle(b) {
  const es = ['ebx', 'res', 'chunk'].flatMap((k) => b.entries.filter((e) => e.kind === k));
  const nEbx = es.filter((e) => e.kind === 'ebx').length, nRes = es.filter((e) => e.kind === 'res').length, nChunk = es.length - nEbx - nRes;
  const names = [], nameAt = new Map();
  let strLen = 0;
  for (const e of es) if (e.kind !== 'chunk' && !nameAt.has(e.name)) { nameAt.set(e.name, strLen); names.push(Buffer.from(e.name + ' ', 'latin1')); strLen += e.name.length + 1; }
  const parts = [Buffer.alloc(36)];
  parts.push(...es.map((e) => e.sha1));
  for (const e of es) if (e.kind !== 'chunk') { const x = Buffer.alloc(12); x.writeUInt32BE(nameAt.get(e.name), 0); x.writeUInt32BE(e.size, 4); x.writeUInt32BE(e.orig, 8); parts.push(x); }
  parts.push(...es.filter((e) => e.kind === 'res').map((e) => e.resType), ...es.filter((e) => e.kind === 'res').map((e) => e.resMeta));
  for (const e of es.filter((x) => x.kind === 'chunk')) { const c = Buffer.from(e.chunk); c.writeUInt32BE(c.readUInt32BE(16) + e.size, 20); parts.push(c); } // B = A + stored size
  let metaAt = 0, metaSize = 0;
  if (nChunk) {
    const items = es.filter((e) => e.kind === 'chunk').map((e) => e.meta);
    const node = b.metaNode ? { ...b.metaNode, v: items } : { t: T_LIST, name: Buffer.from('chunkMeta', 'latin1'), v: items };
    const m = dbWrite(node);
    metaAt = parts.reduce((t, p) => t + p.length, 0) - 4; metaSize = m.length; parts.push(m);
  }
  const strAt = parts.reduce((t, p) => t + p.length, 0) - 4;
  parts.push(...names);
  let head = Buffer.concat(parts);
  head = Buffer.concat([head, Buffer.alloc(Math.ceil(head.length / 16) * 16 - head.length)]); // data starts 16-aligned
  head.writeUInt32BE(head.length - 4, 0); head.writeUInt32BE(b.magic, 4); head.writeUInt32BE(es.length, 8);
  head.writeUInt32BE(nEbx, 12); head.writeUInt32BE(nRes, 16); head.writeUInt32BE(nChunk, 20);
  head.writeUInt32BE(strAt, 24); head.writeUInt32BE(metaAt, 28); head.writeUInt32BE(metaSize, 32);
  const out = [head]; let pos = head.length;
  for (const e of es) { const a = Math.ceil(pos / 16) * 16; if (a > pos) { out.push(Buffer.alloc(a - pos)); pos = a; } out.push(e.data); pos += e.data.length; }
  const end = Math.ceil(pos / 16) * 16; if (end > pos) out.push(Buffer.alloc(end - pos));
  return Buffer.concat(out);
}

// A copy of bundle `buf` that also holds entries of other bundles ([{ from: parseBundle result, kind, name }]), with
// their stored bytes, sha1 and metadata as they are there. Entries the bundle already has are not added twice.
function addToBundle(buf, adds) {
  const b = parseBundle(buf);
  const has = new Set(b.entries.map((e) => e.kind + ':' + e.name.toLowerCase()));
  let added = 0;
  for (const a of adds) {
    const k = a.kind + ':' + a.name.toLowerCase();
    if (has.has(k)) continue;
    const e = a.from.entries.find((x) => x.kind + ':' + x.name.toLowerCase() === k);
    if (!e) throw new Error(`${a.kind} ${a.name} is not in the bundle it should be copied from`);
    if (e.kind === 'chunk' && e.chunk.readUInt32BE(16) !== 0) throw new Error(`chunk ${e.name}: only part of it is in its bundle; cannot be copied`);
    b.entries.push(e); has.add(k); added++;
  }
  return { buf: writeBundle(b), added };
}

// ============================================================ delta bundles (official patch) ===
//
// A patch bundle with delta=true is an assembly list, not a binary diff:
//   [u32 BE tableLen][u32 BE 0xDE17AAAA][u32 0][u32 0]
//   table: tableLen/16 segments of [u32 size][i32 source][u32 offsetHigh][u32 offsetLow]
//   followed by inline data.
// The bundle is all segments concatenated in order. Source:
//    0 -> the next `size` bytes of the inline data (read sequentially; the offset field is informational)
//    1 -> base game .sb (Data/...) at the absolute offset
//   -1 -> Update/Patch/Data/common.dat at the absolute offset
// Verified: all 372 delta bundles rebuild with every ebx and compressed entry matching its header sha1.
const DELTA_MAGIC = 0xde17aaaa;

function readDelta(patchSbFile, offset, size) {
  const fd = fs.openSync(patchSbFile, 'r');
  try {
    const raw = Buffer.alloc(size); fs.readSync(fd, raw, 0, size, offset);
    const tableLen = raw.readUInt32BE(0);
    if (raw.readUInt32BE(4) !== DELTA_MAGIC) throw new Error('not a delta bundle at ' + offset + ' in ' + patchSbFile);
    const segs = [];
    for (let o = 16; o < 16 + tableLen; o += 16) {
      segs.push({ size: raw.readUInt32BE(o), src: raw.readInt32BE(o + 4), off: raw.readUInt32BE(o + 8) * 2 ** 32 + raw.readUInt32BE(o + 12) });
    }
    return { segs, inline: raw.subarray(16 + tableLen) };
  } finally { fs.closeSync(fd); }
}

// Returns the full bundle and a map of where every output range came from.
function reconstructDelta(delta, baseSbFile, commonFile) {
  const bfd = fs.openSync(baseSbFile, 'r'), cfd = fs.openSync(commonFile, 'r');
  try {
    const parts = [], map = [];
    let cur = 0, at = 0;
    for (const s of delta.segs) {
      let b;
      if (s.src === 0) { b = delta.inline.subarray(cur, cur + s.size); map.push({ at, size: s.size, src: 0, off: cur }); cur += s.size; }
      else {
        b = Buffer.alloc(s.size);
        fs.readSync(s.src === 1 ? bfd : cfd, b, 0, s.size, s.off);
        if (s.src !== 1 && s.src !== -1) throw new Error('unknown delta source ' + s.src);
        map.push({ at, size: s.size, src: s.src, off: s.off });
      }
      parts.push(b); at += s.size;
    }
    return { buf: Buffer.concat(parts), map };
  } finally { fs.closeSync(bfd); fs.closeSync(cfd); }
}

// Runs a callback with a temporary file holding `buf` (readBundle/rebuildBundle work on file descriptors).
let tmpCounter = 0;
function withTempFile(buf, fn) {
  const f = path.join(require('os').tmpdir(), `fb2_tmp_${process.pid}_${++tmpCounter}.bin`); // unique even when nested
  fs.writeFileSync(f, buf);
  const fd = fs.openSync(f, 'r');
  try { return fn(fd); } finally { fs.closeSync(fd); fs.unlinkSync(f); }
}

// Encodes `newBuf` (a rebuilt bundle) as a delta. Byte ranges that are unchanged copies of the old
// reconstructed bundle are referenced at their original sources; everything else becomes inline data.
// copies: [{ newAt, oldAt, size }] — ranges of newBuf that equal oldBuf[oldAt..oldAt+size).
function encodeDelta(newBuf, copies, oldMap, oldInline) {
  const out = []; // { size, src, off, data? }
  const push = (seg) => {
    if (!seg.size) return;
    const last = out[out.length - 1];
    if (last && last.src === seg.src && seg.src !== 0 && last.off + last.size === seg.off) { last.size += seg.size; return; }
    if (last && last.src === 0 && seg.src === 0) { last.data = Buffer.concat([last.data, seg.data]); last.size += seg.size; return; }
    out.push(seg);
  };
  const inlineRange = (from, to) => push({ size: to - from, src: 0, off: 0, data: newBuf.subarray(from, to) });
  let pos = 0;
  for (const c of copies.sort((a, b) => a.newAt - b.newAt)) {
    if (c.newAt > pos) inlineRange(pos, c.newAt);
    // split the copied range along the old segment map
    let o = c.oldAt, n = c.newAt, left = c.size;
    while (left > 0) {
      const m = oldMap.find((q) => o >= q.at && o < q.at + q.size);
      const take = Math.min(left, m.at + m.size - o);
      if (m.src === 0) push({ size: take, src: 0, off: 0, data: oldInline.subarray(m.off + (o - m.at), m.off + (o - m.at) + take) });
      else push({ size: take, src: m.src, off: m.off + (o - m.at) });
      o += take; n += take; left -= take;
    }
    pos = c.newAt + c.size;
  }
  if (pos < newBuf.length) inlineRange(pos, newBuf.length);
  const table = Buffer.alloc(out.length * 16);
  out.forEach((s, i) => {
    table.writeUInt32BE(s.size, i * 16); table.writeInt32BE(s.src, i * 16 + 4);
    table.writeUInt32BE(Math.floor(s.off / 2 ** 32), i * 16 + 8); table.writeUInt32BE(s.off % 2 ** 32, i * 16 + 12);
  });
  const head = Buffer.alloc(16);
  head.writeUInt32BE(table.length, 0); head.writeUInt32BE(DELTA_MAGIC, 4);
  return Buffer.concat([head, table, ...out.filter((s) => s.src === 0).map((s) => s.data)]);
}

// Applies replacements to a delta bundle; returns the new delta bytes (to append to the patch .sb).
function rebuildDeltaBundle(patchSbFile, offset, size, baseSbFile, commonFile, replaceByName, adds) {
  return rebuildFromDelta(readDelta(patchSbFile, offset, size), baseSbFile, commonFile, replaceByName, adds);
}

// Same for a bundle the patch does not change (flag "base"): it is treated as a delta made of one
// segment "whole bundle from the base .sb", so the result references the base file for unchanged data
// and holds only the replaced entries inline.
function rebuildBaseAsDelta(baseSbFile, offset, size, commonFile, replaceByName, adds) {
  const delta = { segs: [{ size, src: 1, off: offset }], inline: Buffer.alloc(0) };
  return rebuildFromDelta(delta, baseSbFile, commonFile, replaceByName, adds);
}

function rebuildFromDelta(delta, baseSbFile, commonFile, replaceByName, adds) {
  const old = reconstructDelta(delta, baseSbFile, commonFile);
  if (adds && adds.length) {
    // new entries change the header and move the data: old entries are found by name in their new places
    const grown = addToBundle(old.buf, adds).buf;
    const oldInfo = withTempFile(old.buf, (fd) => L.readBundle(fd, 0, old.buf.length));
    return withTempFile(grown, (fd) => {
      const info = L.readBundle(fd, 0, grown.length);
      const replacements = new Map();
      info.entries.forEach((e, i) => { const r = replaceByName(e); if (r) replacements.set(i, r); });
      const newBuf = rebuildBundle(fd, 0, grown.length, replacements);
      const newInfo = withTempFile(newBuf, (nfd) => L.readBundle(nfd, 0, newBuf.length));
      const oldBy = new Map(oldInfo.entries.map((e) => [e.kind + ':' + e.name, e]));
      const copies = [];
      info.entries.forEach((e, i) => { const o = oldBy.get(e.kind + ':' + e.name); if (o && !replacements.has(i) && e.size) copies.push({ newAt: newInfo.entries[i].pos, oldAt: o.pos, size: e.size }); });
      return { delta: encodeDelta(newBuf, copies, old.map, delta.inline), bundle: newBuf, replaced: replacements.size, entries: info.entries };
    });
  }
  return withTempFile(old.buf, (fd) => {
    const info = L.readBundle(fd, 0, old.buf.length);
    if (!info) throw new Error('reconstructed delta bundle has no valid header');
    const replacements = new Map();
    info.entries.forEach((e, i) => { const r = replaceByName(e); if (r) replacements.set(i, r); });
    const newBuf = rebuildBundle(fd, 0, old.buf.length, replacements);
    // which ranges of the new bundle are verbatim copies of old entries?
    const newInfo = withTempFile(newBuf, (nfd) => L.readBundle(nfd, 0, newBuf.length));
    const copies = [];
    info.entries.forEach((e, i) => { if (!replacements.has(i) && e.size) copies.push({ newAt: newInfo.entries[i].pos, oldAt: e.pos, size: e.size }); });
    return { delta: encodeDelta(newBuf, copies, old.map, delta.inline), bundle: newBuf, replaced: replacements.size, entries: info.entries };
  });
}

module.exports = {
  dbRead, dbWrite, child, numOf, setNum, strOf, readTocFile, encodeToc, tocChunks, tocBundles, entryId, entryFlag,
  packBlocks, packChunk, isBlockFramed, appendToSb, rebuildBundle, bundleLayout, parseBundle, writeBundle, addToBundle,
  readDelta, reconstructDelta, encodeDelta, rebuildDeltaBundle, rebuildBaseAsDelta, withTempFile, DELTA_MAGIC,
};

// ============================================================ self-test ===
// node fb2_repack.js --game "<game dir>" selftest   (read-only: nothing in the game folder is written)
if (require.main === module && L.OPTS.rest[0] === 'selftest') {
  const gameRoot = path.dirname(L.DATA_DIR);
  const walk = (d, o = []) => { if (!fs.existsSync(d)) return o; for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f, o); else if (/\.toc$/i.test(x.name)) o.push(f); } return o; };
  const tocs = [...walk(L.DATA_DIR), ...walk(path.join(gameRoot, 'Update', 'Patch', 'Data'))];
  let same = 0;
  for (const f of tocs) { if (encodeToc(readTocFile(f)).equals(fs.readFileSync(f))) same++; else console.log('  MISMATCH', f); }
  console.log(`1) toc round-trip: ${same}/${tocs.length} byte-identical`);

  const index = L.loadIndex();
  const fds = new Map();
  const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  // 2) packBlocks round-trip and whether our zlib reproduces the original bytes
  let rt = 0, exact = 0, n = 0;
  for (const e of index.filter((x) => x.kind === 'res' && x.size !== x.orig).slice(0, 300)) {
    const stored = Buffer.alloc(e.size); fs.readSync(fdOf(e.sb), stored, 0, e.size, e.pos);
    const raw = L.unpackBlocks(stored), packed = packBlocks(raw);
    n++; if (L.unpackBlocks(packed).equals(raw)) rt++; if (packed.equals(stored)) exact++;
  }
  console.log(`2) packBlocks: ${rt}/${n} round-trip OK, ${exact}/${n} byte-identical to the game's own compression`);
  // 3) the bundle sha1 table must hash the STORED bytes of every entry (rebuildBundle relies on this)
  let shaOk = 0, shaAll = 0;
  {
    const t = path.join(L.DATA_DIR, 'Win32', 'UI.toc');
    const fd = fs.openSync(t.replace(/\.toc$/i, '.sb'), 'r');
    for (const b of L.readToc(t).bundles.slice(0, 20)) {
      const info = L.readBundle(fd, b.offset, b.size);
      const h4 = Buffer.alloc(4); fs.readSync(fd, h4, 0, 4, b.offset);
      const hb = Buffer.alloc(h4.readUInt32BE(0) + 4); fs.readSync(fd, hb, 0, hb.length, b.offset);
      info.entries.forEach((e, i) => {
        const stored = Buffer.alloc(e.size); fs.readSync(fd, stored, 0, e.size, e.pos);
        shaAll++; if (crypto.createHash('sha1').update(stored).digest().equals(hb.subarray(36 + i * 20, 56 + i * 20))) shaOk++;
      });
    }
    fs.closeSync(fd);
  }
  console.log(`3) bundle sha1 table = sha1(stored bytes): ${shaOk}/${shaAll} entries in UI.sb`);
  // 4) rebuilding bundles with no changes must give the original bytes
  let ok = 0, tried = 0;
  for (const t of tocs.filter((f) => f.startsWith(L.DATA_DIR)).slice(0, 64)) {
    const toc = L.readToc(t);
    const sb = t.replace(/\.toc$/i, '.sb');
    if (!toc.bundles || !toc.bundles.length || !fs.existsSync(sb)) continue;
    const fd = fs.openSync(sb, 'r');
    for (const b of toc.bundles.slice(0, 3)) {
      tried++;
      const orig = Buffer.alloc(b.size); fs.readSync(fd, orig, 0, b.size, b.offset);
      const re = rebuildBundle(fd, b.offset, b.size);
      if (re.equals(orig)) ok++; else if (tried - ok <= 3) console.log(`  differs: ${b.id} orig ${orig.length} rebuilt ${re.length} prefixEqual=${orig.subarray(0, re.length).equals(re.subarray(0, orig.length))}`);
    }
    fs.closeSync(fd);
  }
  console.log(`4) bundle rebuild without changes: ${ok}/${tried} byte-identical`);
}
