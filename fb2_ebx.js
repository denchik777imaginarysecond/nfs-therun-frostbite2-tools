'use strict';
/*
 * fb2_ebx.js — parser for ebx files (Frostbite 2, Need for Speed: The Run variant).
 *
 * ebx = asset description: a set of "instances" of various types
 * (e.g. VehicleBlueprint, UIScreenAsset...). We extract:
 *   guid     — file GUID (other ebx files reference it by this);
 *   imports  — GUIDs of the files this one references (edges of the reference graph);
 *   type     — type of the primary instance; types — all types inside;
 *   strings  — text strings (labels, paths, menu entries...).
 *
 * Layout (little-endian). Unlike BF3, all header fields in NFS The Run are 32-bit.
 *   0x00 magic 0x0FB2D1CE   0x04 string offset      0x08 length of strings+payload to EOF
 *   0x0C import count       0x10 ?                  0x14 instance repeater count
 *   0x18 type count         0x1C field count        0x20 name table length
 *   0x24 string length      0x28 array count        0x2C payload length
 *   0x30 file GUID (16)
 *   0x40 imports: N * (file GUID 16 + instance GUID 16)
 *   then primary instance GUID (16), names, fields (16 bytes each), types (16 bytes each),
 *   instance repeaters (12 bytes: 0, repetitions, type index)
 * Type names are stored as djb2-xor hashes; the words themselves are in the name table.
 * (Layout reverse-engineered from the game's bytes and verified on real files.)
 */

const EBX_MAGIC = 0x0fb2d1ce;

function hashName(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function splitZ(buf, start, len) { // zero-terminated strings
  const out = [];
  let s = start;
  const end = Math.min(start + len, buf.length);
  for (let i = start; i < end; i++) {
    if (buf[i] === 0) { if (i > s) out.push(buf.toString('latin1', s, i)); s = i + 1; }
  }
  return out;
}

function parseEbx(buf) {
  if (buf.length < 0x40 || buf.readUInt32LE(0) !== EBX_MAGIC) return null;
  const u = (o) => buf.readUInt32LE(o);
  const absStr = u(0x04), numGuid = u(0x0c), numInst = u(0x14), numComplex = u(0x18),
    numField = u(0x1c), lenName = u(0x20), lenString = u(0x24);
  const guid = buf.toString('hex', 0x30, 0x40);

  let p = 0x40;
  const imports = new Set();
  // Of each 32-byte pair, the SECOND half matches file GUIDs (verified: 100% vs 0.3% for the first half).
  for (let i = 0; i < numGuid; i++, p += 32) imports.add(buf.toString('hex', p + 16, p + 32));
  p += 16; // primary instance GUID

  const names = new Map(); // hash -> word
  for (const w of splitZ(buf, p, lenName)) names.set(hashName(w), w);
  p += lenName + numField * 16; // skip field descriptors
  const complex = [];
  for (let i = 0; i < numComplex; i++, p += 16) complex.push(names.get(u(p)) || '?');
  const instTypes = [];
  for (let i = 0; i < numInst && p + 12 <= buf.length; i++, p += 12) instTypes.push(complex[u(p + 8)] || '?');

  imports.delete(guid);
  return {
    guid,
    type: instTypes[0] || '?',
    types: [...new Set(instTypes)],
    imports: [...imports],
    strings: absStr < buf.length ? splitZ(buf, absStr, lenString) : [],
  };
}

module.exports = { parseEbx, hashName };
