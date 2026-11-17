'use strict';
/*
 * fb2_ebx_write.js — writes a complete ebx (Need for Speed: The Run, Frostbite 2) from its values.
 * With it, ebx changes are no longer limited to fixed-size values: arrays can grow or shrink, text values
 * can change, references can point to other objects or files.
 *
 *   const W = require('./fb2_ebx_write.js');
 *   const doc = W.decode(buf);          // { ..., imports, instances: [{ guid, cx, value }] } (values as fb2_ebx_fields.parse gives them)
 *   ...change doc.instances[i].value / doc.imports ...
 *   const out = W.encode(doc);          // the new ebx bytes
 *
 *   node fb2_ebx_write.js --game "<game dir>" selftest [limit]   decode + encode every ebx: must be byte-identical
 *
 * Layout rules (all verified on the 91,715 ebx of the game):
 *   header 0x00 magic, 0x04 string table position, 0x08 size of strings + payload + arrays, 0x0c import count,
 *     0x10 zero, 0x14 instance repeater count, 0x18 complex type count, 0x1c field count, 0x20 names length,
 *     0x24 strings length, 0x28 array count, 0x2c payload length, 0x30 file GUID, 0x40 primary instance GUID,
 *     0x50 imports N x [file GUID][instance GUID], then names, fields, complex types, instance repeaters,
 *     (align 16) array repeaters [offset, count, complex type], (align 16) strings, payload, arrays.
 *   Type sections (names, fields, complex types) are kept as they are.
 *   Instance repeaters [0][count][complex type]: one group per type (each type appears once), instances of a type together.
 *   Strings: in the order the values are visited (instances in order, fields in order, array items when met);
 *     equal texts are stored once. Table padded with zeros to 16.
 *   Payload: instances one after another: [GUID 16][data], GUID position aligned to min(type alignment, 4);
 *     padded to 16, always keeping 4 bytes (room for the count of array 0).
 *   Arrays: every empty array uses the shared array 0 (offset 0, count 0). A non-empty array gets its number
 *     after the arrays inside its items ("children first"); arrays are stored in number order as
 *     [u32 count][items], items aligned to max(4, item alignment) and the count right before them; the section is padded to 16.
 */
const F = require('./fb2_ebx_fields.js');

const SCALAR_SIZE = { bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, double: 8, enum: 4, cstring: 4, fileref: 4, ref: 4, array: 4, guid: 16, sha1: 20, resref: 8 };
const SCALAR_ALIGN = { bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, double: 8, enum: 4, cstring: 4, fileref: 4, ref: 4, array: 4, guid: 4, sha1: 4, resref: 8 };
const align = (n, a) => Math.ceil(n / a) * a;

// Everything needed to write the file again. Instance values are the friendly values of fb2_ebx_fields.parse.
function decode(b) {
  const p = F.parse(b);
  const H = p.H;
  const typesAt = 0x50 + H.nImp * 32;
  const repsAt = typesAt + H.lenName + H.nFld * 16 + H.nCx * 16;
  const insts = [];
  let i = 0;
  for (const r of p.reps) for (let j = 0; j < r.count; j++, i++) insts.push({ guid: p.instances[i].guid, cx: r.cx, value: p.instances[i].value });
  return {
    guid: p.guid, primaryGuid: p.primaryGuid,
    imports: p.imports.map((x) => ({ file: x.file, instance: x.instance })),
    types: Buffer.from(b.subarray(typesAt, repsAt)), // names + fields + complex types, unchanged
    counts: { nCx: H.nCx, nFld: H.nFld, lenName: H.lenName },
    emptyArrayCx: p.arrays.length ? p.arrays[0].cx : null,
    fields: p.fields, cx: p.cx,
    instances: insts,
  };
}

function encode(doc) {
  const { fields, cx } = doc;
  const strings = new Map(); // text -> offset
  const strParts = [];
  let strLen = 0;
  const strOff = (t) => {
    if (t === null || t === undefined) return 0xffffffff;
    if (!strings.has(t)) { strings.set(t, strLen); const bt = Buffer.from(t + '\0', 'latin1'); strParts.push(bt); strLen += bt.length; }
    return strings.get(t);
  };
  const arrays = [{ off: 0, count: 0, cx: doc.emptyArrayCx, data: null }]; // array 0: the shared empty array
  let usesArrays = doc.emptyArrayCx !== null;                              // files without array fields have no array 0

  const elemInfo = (ci) => {
    const mf = fields[cx[ci].first], ec = mf.kind === 'struct' ? cx[mf.ref] : null;
    return { mf, size: ec ? align(ec.size, ec.align) : SCALAR_SIZE[mf.kind], al: ec ? ec.align : SCALAR_ALIGN[mf.kind] };
  };

  function writeComplex(ci, obj, buf, at) {
    const c = cx[ci];
    if (!obj || typeof obj !== 'object') throw new Error(`${c.name}: expected an object`);
    for (let k = 0; k < c.n; k++) {
      const f = fields[c.first + k];
      if (f.kind === 'inherit') { if (cx[f.ref] && cx[f.ref].n) writeComplex(f.ref, obj, buf, at); continue; }
      writeValue(f, obj[f.name], buf, at + f.off, c.name + '.' + f.name);
    }
  }
  function writeValue(f, v, buf, q, where) {
    switch (f.kind) {
      case 'struct': return writeComplex(f.ref, v, buf, q);
      case 'array': {
        if (!Array.isArray(v)) throw new Error(where + ': expected an array');
        if (!usesArrays) { usesArrays = true; arrays[0].cx = f.ref; }
        if (!v.length) { buf.writeUInt32LE(0, q); return; } // empty arrays share array 0
        const { mf, size } = elemInfo(f.ref);
        const data = Buffer.alloc(v.length * size);
        v.forEach((item, j) => writeValue(mf, item, data, j * size, `${where}[${j}]`)); // nested arrays get their numbers first
        arrays.push({ count: v.length, cx: f.ref, data, al: elemInfo(f.ref).al });
        buf.writeUInt32LE(arrays.length - 1, q);
        return;
      }
      case 'bool': buf[q] = v ? 1 : 0; return;
      case 'int8': buf.writeInt8(v, q); return; case 'uint8': buf.writeUInt8(v, q); return;
      case 'int16': buf.writeInt16LE(v, q); return; case 'uint16': buf.writeUInt16LE(v, q); return;
      case 'int32': buf.writeInt32LE(v, q); return; case 'uint32': buf.writeUInt32LE(v, q); return;
      case 'int64': buf.writeBigInt64LE(BigInt(v), q); return; case 'uint64': buf.writeBigUInt64LE(BigInt(v), q); return;
      case 'float': buf.writeFloatLE(v, q); return; case 'double': buf.writeDoubleLE(v, q); return;
      case 'enum': {
        if (typeof v === 'number') { buf.writeUInt32LE(v >>> 0, q); return; }
        const e = cx[f.ref], m = e && fields.slice(e.first, e.first + e.n).find((x) => x.name === v);
        if (!m) throw new Error(`${where}: "${v}" is not a value of this list`);
        buf.writeUInt32LE(m.off, q); return;
      }
      case 'cstring': case 'fileref': buf.writeUInt32LE(strOff(v), q); return;
      case 'ref': {
        let r = 0;
        if (v && typeof v === 'object' && '$import' in v) r = (0x80000000 | v.$import) >>> 0;
        else if (v && typeof v === 'object' && '$instance' in v) r = v.$instance + 1;
        else if (v !== null && v !== undefined) throw new Error(where + ': a reference must be null, {$import: n} or {$instance: n}');
        buf.writeUInt32LE(r, q); return;
      }
      case 'guid': Buffer.from(v, 'hex').copy(buf, q, 0, 16); return;
      case 'sha1': Buffer.from(v, 'hex').copy(buf, q, 0, 20); return;
      case 'resref': buf.writeBigUInt64LE(BigInt('0x' + (v || '0')), q); return;
      default: throw new Error(`${where}: cannot write values of kind ${f.kind}`);
    }
  }

  // payload: instances one after another
  const payParts = [];
  let pay = 0;
  const reps = [];
  doc.instances.forEach((inst, n) => {
    const c = cx[inst.cx];
    const ia = Math.min(c.align, 4);
    const at = align(pay, ia);
    if (at > pay) { payParts.push(Buffer.alloc(at - pay)); pay = at; }
    const data = Buffer.alloc(16 + c.size);
    Buffer.from(inst.guid, 'hex').copy(data, 0);
    writeComplex(inst.cx, inst.value, data, 16);
    payParts.push(data); pay += data.length;
    const last = reps[reps.length - 1];
    if (last && last.cx === inst.cx) last.count++; else reps.push({ cx: inst.cx, count: 1 });
  });
  // array 0 (the shared empty array) has its count 4 bytes before the array section, i.e. in the payload's padding:
  // the payload always keeps room for it (also in files without arrays)
  const lenPay = align(pay + 4, 16);
  payParts.push(Buffer.alloc(lenPay - pay));

  // arrays: [u32 count][items] in number order
  const arrParts = [];
  let cur = 0;
  for (let i = 1; i < arrays.length; i++) {
    const a = arrays[i];
    // the count sits right before the items; the items are aligned
    const dataAt = align(align(cur, 4) + 4, Math.max(4, a.al));
    const head = Buffer.alloc(dataAt - cur);
    head.writeUInt32LE(a.count, dataAt - 4 - cur);
    arrParts.push(head, a.data);
    a.off = dataAt;
    cur = dataAt + a.data.length;
  }
  const lenArr = align(cur, 16);
  arrParts.push(Buffer.alloc(lenArr - cur));

  const lenStr = align(strLen, 16);
  strParts.push(Buffer.alloc(lenStr - strLen));

  if (!usesArrays) arrays.length = 0;
  // header and type sections
  const typesAt = 0x50 + doc.imports.length * 32;
  const repsAt = typesAt + doc.types.length;
  const arrRepAt = align(repsAt + reps.length * 12, 16);
  const absStr = align(arrRepAt + arrays.length * 12, 16);
  const total = absStr + lenStr + lenPay + lenArr;
  const out = Buffer.alloc(total);
  const w = (o, v) => out.writeUInt32LE(v >>> 0, o);
  w(0, 0x0fb2d1ce); w(4, absStr); w(8, total - absStr); w(12, doc.imports.length); w(16, 0); w(20, reps.length);
  w(24, doc.counts.nCx); w(28, doc.counts.nFld); w(32, doc.counts.lenName); w(36, lenStr); w(40, arrays.length); w(44, lenPay);
  Buffer.from(doc.guid, 'hex').copy(out, 0x30);
  Buffer.from(doc.primaryGuid, 'hex').copy(out, 0x40);
  doc.imports.forEach((im, i) => { Buffer.from(im.file, 'hex').copy(out, 0x50 + i * 32); Buffer.from(im.instance, 'hex').copy(out, 0x60 + i * 32); });
  doc.types.copy(out, typesAt);
  reps.forEach((r, i) => { w(repsAt + i * 12, 0); w(repsAt + i * 12 + 4, r.count); w(repsAt + i * 12 + 8, r.cx); }); // first field: always 0 in the game's files
  arrays.forEach((a, i) => { w(arrRepAt + i * 12, a.off); w(arrRepAt + i * 12 + 4, a.count); w(arrRepAt + i * 12 + 8, a.cx); });
  Buffer.concat([...strParts, ...payParts, ...arrParts]).copy(out, absStr);
  return out;
}

// ============================================================ editing helpers ===
// Paths look like "Visibility.InvertValue" or "Items.3.Name" (array items by number).

// field descriptor by name in a complex type, including the fields it inherits
function fieldOf(doc, ci, name) {
  const c = doc.cx[ci];
  for (let k = 0; k < c.n; k++) {
    const f = doc.fields[c.first + k];
    if (f.kind === 'inherit') { if (doc.cx[f.ref] && doc.cx[f.ref].n) { const r = fieldOf(doc, f.ref, name); if (r) return r; } }
    else if (f.name === name) return f;
  }
  return null;
}
const itemFieldOf = (doc, f) => doc.fields[doc.cx[f.ref].first]; // the item type of an array field

// -> { holder, key, f }: holder[key] is the value at the path, f describes its type
function locate(doc, inst, path) {
  const parts = String(path).split('.');
  if (!doc.instances[inst]) throw new Error('no object #' + inst);
  let val = doc.instances[inst].value, ci = doc.instances[inst].cx, itemF = null, holder = null, key = null, f = null;
  for (const part of parts) {
    if (Array.isArray(val)) {
      if (!/^\d+$/.test(part) || Number(part) >= val.length) throw new Error(`${path}: item ${part} does not exist (the list has ${val.length})`);
      holder = val; key = Number(part); f = itemF;
    } else {
      if (!val || typeof val !== 'object' || ci === null) throw new Error(`${path}: "${part}" is not inside an object`);
      f = fieldOf(doc, ci, part);
      if (!f) throw new Error(`${path}: no field "${part}" in ${doc.cx[ci].name}`);
      holder = val; key = part;
    }
    val = holder[key];
    ci = f.kind === 'struct' ? f.ref : null;
    itemF = f.kind === 'array' ? itemFieldOf(doc, f) : null;
  }
  return { holder, key, f, itemF };
}

// a zero value of a field type (used for new list items)
function defaultFor(doc, f) {
  switch (f.kind) {
    case 'struct': { const o = { $type: doc.cx[f.ref].name }; fill(doc, f.ref, o); return o; }
    case 'array': return [];
    case 'bool': return false;
    case 'int64': case 'uint64': return '0';
    case 'enum': { const e = doc.cx[f.ref]; return e && e.n ? doc.fields[e.first].name : 0; }
    case 'cstring': case 'fileref': return '';
    case 'ref': return null;
    case 'guid': return '0'.repeat(32);
    case 'sha1': return '0'.repeat(40);
    case 'resref': return '0';
    default: return 0;
  }
}
function fill(doc, ci, o) {
  const c = doc.cx[ci];
  for (let k = 0; k < c.n; k++) {
    const f = doc.fields[c.first + k];
    if (f.kind === 'inherit') { if (doc.cx[f.ref] && doc.cx[f.ref].n) fill(doc, f.ref, o); }
    else if (!(f.name in o)) o[f.name] = defaultFor(doc, f);
  }
}

// adds (or finds) an import, returns its number
function importOf(doc, file, instance) {
  let i = doc.imports.findIndex((x) => x.file === file && x.instance === instance);
  if (i < 0) { doc.imports.push({ file, instance }); i = doc.imports.length - 1; }
  return i;
}

// Checks and converts a value from mod.json for a field. resolveRef(name, objectGuid) -> { file, instance } for
// references to other assets ({ "ref": "<ebx name>", "object": "<optional instance GUID>" }).
function convert(doc, f, v, resolveRef) {
  const k = f.kind, bad = (m) => { throw new Error(`${f.name}: ${m} (got ${JSON.stringify(v)})`); };
  const num = (lo, hi) => { const n = Number(v); if (typeof v === 'boolean' || !Number.isFinite(n)) bad('expected a number'); if (lo !== undefined && (n < lo || n > hi || !Number.isInteger(n))) bad(`expected a whole number ${lo}..${hi}`); return n; };
  switch (k) {
    case 'bool': if (typeof v !== 'boolean') bad('expected true or false'); return v;
    case 'int8': return num(-128, 127); case 'uint8': return num(0, 255);
    case 'int16': return num(-32768, 32767); case 'uint16': return num(0, 65535);
    case 'int32': return num(-2147483648, 2147483647); case 'uint32': return num(0, 4294967295);
    case 'int64': case 'uint64': try { return String(BigInt(v)); } catch { return bad('expected a whole number'); }
    case 'float': case 'double': return num();
    case 'enum': {
      const e = doc.cx[f.ref], names = e ? doc.fields.slice(e.first, e.first + e.n).map((x) => x.name) : [];
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      if (!names.includes(v)) bad('expected one of ' + names.join(', '));
      return v;
    }
    case 'cstring': case 'fileref': if (v !== null && typeof v !== 'string') bad('expected text or null'); return v;
    case 'ref': {
      if (v === null) return null;
      if (v && typeof v === 'object' && Number.isInteger(v.$instance)) { if (!doc.instances[v.$instance]) bad('no such object in this file'); return { $instance: v.$instance }; }
      if (v && typeof v === 'object' && typeof v.object === 'string' && !v.ref) { const n = objectIndex(doc, v.object); if (n < 0) bad('no object with this GUID in this file'); return { $instance: n }; }
      if (v && typeof v === 'object' && typeof v.ref === 'string') {
        if (!resolveRef) bad('references to other assets are not available here');
        const t = resolveRef(v.ref, v.object);
        return { $import: importOf(doc, t.file, t.instance) };
      }
      return bad('expected null, {"ref": "<asset name>"}, {"object": "<GUID in this file>"} or {"$instance": n}');
    }
    case 'guid': if (!/^[0-9a-f]{32}$/i.test(v)) bad('expected 32 hex digits'); return v.toLowerCase();
    case 'sha1': if (!/^[0-9a-f]{40}$/i.test(v)) bad('expected 40 hex digits'); return v.toLowerCase();
    case 'resref': if (!/^[0-9a-f]{1,16}$/i.test(String(v))) bad('expected up to 16 hex digits'); return String(v).toLowerCase();
    case 'struct': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad('expected an object');
      const o = { $type: doc.cx[f.ref].name };
      for (const [name, x] of Object.entries(v)) { if (name === '$type') continue; const ff = fieldOf(doc, f.ref, name); if (!ff) bad(`no field "${name}" in ${doc.cx[f.ref].name}`); o[name] = ff.kind === 'array' ? convertArray(doc, ff, x, resolveRef) : convert(doc, ff, x, resolveRef); }
      fill(doc, f.ref, o);
      return o;
    }
    default: return bad(`values of type ${k} cannot be set`);
  }
}
function convertArray(doc, f, v, resolveRef) {
  if (!Array.isArray(v)) throw new Error(`${f.name}: expected a list`);
  const itemF = itemFieldOf(doc, f);
  return v.map((x) => (itemF.kind === 'array' ? convertArray(doc, itemF, x, resolveRef) : convert(doc, itemF, x, resolveRef)));
}

// deep copy of a value without the reader's helper keys (@offset, %kind)
const copyValue = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, x) => (k[0] === '@' || k[0] === '%' ? undefined : x))));

// ============================================================ objects ===
const objectIndex = (doc, guid) => doc.instances.findIndex((x) => x.guid === String(guid).toLowerCase());

// change every reference to an object of this file: map(old number) -> new number, or null for "removed".
// References inside lists that point to a removed object are taken out of the list (a list item must not be empty).
function renumber(doc, map) {
  const fix = (x) => { const n = map(x.$instance); return n === null ? null : { $instance: n }; };
  const isRef = (x) => x && typeof x === 'object' && '$instance' in x;
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        if (isRef(v[i])) { const r = fix(v[i]); if (r === null) v.splice(i, 1); else v[i] = r; } else walk(v[i]);
      }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { if (k[0] === '@' || k[0] === '%') continue; if (isRef(v[k])) v[k] = fix(v[k]); else walk(v[k]); }
    }
  };
  doc.instances.forEach((x) => walk(x.value));
}

// a copy of an object (same type), placed after the last object of that type; returns its number
function addObject(doc, src, guid) {
  if (!doc.instances[src]) throw new Error('no object #' + src);
  guid = String(guid || require('crypto').randomBytes(16).toString('hex')).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(guid)) throw new Error('an object GUID is 32 hex digits');
  if (objectIndex(doc, guid) >= 0) throw new Error('this file already has an object ' + guid);
  const cx = doc.instances[src].cx;
  let pos = 0; doc.instances.forEach((x, i) => { if (x.cx === cx) pos = i + 1; });
  renumber(doc, (i) => (i >= pos ? i + 1 : i));
  const copy = copyValue(doc.instances[src].value); // src < pos, so its number did not change
  doc.instances.splice(pos, 0, { guid, cx, value: copy });
  return pos;
}

// removes an object; references to it become null (taken out of lists). The main object cannot be removed.
function deleteObject(doc, n) {
  const x = doc.instances[n];
  if (!x) throw new Error('no object #' + n);
  if (x.guid === doc.primaryGuid) throw new Error('the main object of a file cannot be removed');
  doc.instances.splice(n, 1);
  renumber(doc, (i) => (i === n ? null : i > n ? i - 1 : i));
}

module.exports = { decode, encode, locate, objectIndex, addObject, deleteObject, renumber, fieldOf, itemFieldOf, defaultFor, fill, importOf, convert, convertArray, copyValue };

// ============================================================ self-test ===
if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const L = require('./fb2_extract.js');
  const [cmd, limitArg] = L.OPTS.rest;
  if (cmd !== 'selftest') { console.log('Commands: selftest [limit]'); process.exit(0); }
  const index = L.loadIndex();
  const fds = new Map(); const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  const seen = new Set();
  let same = 0, diff = 0, failed = 0;
  const why = {}, examples = {};
  const limit = Number(limitArg) || Infinity;
  for (const e of index) {
    if (e.kind !== 'ebx' || seen.has(e.name)) continue;
    seen.add(e.name);
    if (seen.size > limit) break;
    const b = L.readAsset(fdOf(e.sb), e);
    try {
      const out = encode(decode(b));
      if (out.equals(b)) { same++; continue; }
      diff++;
      // where is the first difference?
      const H = F.parse(b).H;
      let at = 0; while (at < Math.min(out.length, b.length) && out[at] === b[at]) at++;
      const pay = H.absStr + H.lenStr, arr = pay + H.lenPay;
      const part = out.length !== b.length && at >= Math.min(out.length, b.length) ? 'length' : at < 0x50 ? 'header' : at < H.absStr ? 'tables' : at < pay ? 'strings' : at < arr ? 'payload' : 'arrays';
      why[part] = (why[part] || 0) + 1;
      if (!examples[part]) examples[part] = `${e.name} @${at} (len ${b.length} -> ${out.length})`;
    } catch (err) { failed++; const k = err.message.replace(/\d+/g, 'N').slice(0, 80); why[k] = (why[k] || 0) + 1; if (!examples[k]) examples[k] = e.name; }
  }
  console.log(`rebuild: ${same} byte-identical, ${diff} different, ${failed} failed (of ${same + diff + failed})`);
  for (const [k, v] of Object.entries(why)) console.log(`  ${k}: ${v}   e.g. ${examples[k]}`);
}
