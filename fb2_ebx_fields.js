'use strict';
/*
 * fb2_ebx_fields.js — full field-level ebx reader (Frostbite 2, Need for Speed: The Run variant).
 *
 * Gives every instance with every field value AND the absolute byte offset of each value inside the ebx,
 * so simple values (bool, ints, floats, enums) can be edited in place without re-serializing the file.
 *
 *   node fb2_ebx_fields.js --game "<game dir>" dump <ebx name>        print instances and values
 *   node fb2_ebx_fields.js --game "<game dir>" selftest               parse every ebx and check consistency
 *
 * Layout after the header/imports/names (see fb2_ebx.js):
 *   fields   16 bytes: [u32 name hash][u16 type][u16 ref][u32 offset][u32 secondary offset]
 *   complex  16 bytes: [u32 name hash][u32 first field][u8 field count][u8 alignment][u16 type][u16 size][u16 secondary size]
 *   instance repeaters 12 bytes: [u32 ?][u32 count][u32 complex index]
 *   (align 16) array repeaters 12 bytes: [u32 offset in array section][u32 element count][u32 complex index]
 *   (align 16) string table at absStringOffset, then the instance payload, then the array section.
 * Field kind = (type >> 4) & 0x1f.
 */
const fs = require('fs');
const path = require('path');
const { hashName } = require('./fb2_ebx.js');

const KIND = {
  0: 'inherit', 2: 'struct', 3: 'ref', 4: 'array', 7: 'cstring', 8: 'enum', 9: 'fileref', 10: 'bool',
  11: 'int8', 12: 'uint8', 13: 'int16', 14: 'uint16', 15: 'int32', 16: 'uint32', 17: 'int64', 18: 'uint64',
  19: 'float', 20: 'double', 21: 'guid', 22: 'sha1', 23: 'resref',
};
const SCALAR_SIZE = { bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, double: 8, enum: 4, cstring: 4, fileref: 4, ref: 4, array: 4, guid: 16, sha1: 20, resref: 8 };

function parse(b, opts = {}) {
  // On PC, instances are packed with at most 4-byte alignment; the stored 8/16 alignment does not apply
  // (verified: 91k ebx parse cleanly only with this rule).
  const instAlign = opts.instAlign || ((c) => Math.min(c.align, 4));
  const u = (o) => b.readUInt32LE(o);
  if (u(0) !== 0x0fb2d1ce) throw new Error('not an ebx');
  const H = { absStr: u(4), lenEof: u(8), nImp: u(12), x10: u(16), nInst: u(20), nCx: u(24), nFld: u(28), lenName: u(32), lenStr: u(36), nArr: u(40), lenPay: u(44) };
  const guid = b.toString('hex', 0x30, 0x40);
  let p = 0x40;
  const imports = [];
  for (let i = 0; i < H.nImp; i++, p += 32) imports.push({ file: b.toString('hex', p + 16, p + 32), instance: b.toString('hex', p, p + 16) });
  const primaryGuid = b.toString('hex', p, p + 16); p += 16;
  const names = new Map();
  { let s = p; for (let i = p; i < p + H.lenName; i++) if (!b[i]) { if (i > s) { const w = b.toString('latin1', s, i); names.set(hashName(w), w); } s = i + 1; } }
  p += H.lenName;
  const nameOf = (h) => names.get(h) || '#' + h.toString(16);
  const fields = [];
  for (let i = 0; i < H.nFld; i++, p += 16) { const t = b.readUInt16LE(p + 4); fields.push({ name: nameOf(u(p)), type: t, kind: KIND[(t >> 4) & 0x1f] || 'k' + ((t >> 4) & 0x1f), ref: b.readUInt16LE(p + 6), off: u(p + 8) }); }
  const cx = [];
  for (let i = 0; i < H.nCx; i++, p += 16) { const t = b.readUInt16LE(p + 10); cx.push({ name: nameOf(u(p)), first: u(p + 4), n: b[p + 8], align: b[p + 9] || 1, type: t, kind: KIND[(t >> 4) & 0x1f], size: b.readUInt16LE(p + 12) }); }
  const reps = [];
  for (let i = 0; i < H.nInst; i++, p += 12) reps.push({ x: u(p), count: u(p + 4), cx: u(p + 8) });
  const arrAt = Math.ceil(p / 16) * 16;
  const arrays = [];
  for (let i = 0; i < H.nArr; i++) { const q = arrAt + i * 12; arrays.push({ off: u(q), count: u(q + 4), cx: u(q + 8) }); }
  const strAt = H.absStr, payAt = H.absStr + H.lenStr, arrSecAt = payAt + H.lenPay;
  const cstr = (o) => { if (o === 0xffffffff) return null; const s = strAt + o; if (o >= H.lenStr) throw new Error('string offset out of range ' + o); return b.toString('latin1', s, b.indexOf(0, s)); };

  // read one complex value at absolute position `at`
  function readComplex(ci, at, depth = 0) {
    const c = cx[ci];
    if (depth > 32) throw new Error('nesting too deep');
    const out = { $type: c.name };
    for (let k = 0; k < c.n; k++) {
      const f = fields[c.first + k], q = at + f.off;
      switch (f.kind) {
        case 'inherit': if (c.first + k !== undefined && cx[f.ref] && cx[f.ref].n) Object.assign(out, readComplex(f.ref, at, depth + 1), { $type: c.name }); break;
        case 'struct': out[f.name] = readComplex(f.ref, q, depth + 1); break;
        case 'ref': { const v = u(q); out[f.name] = v === 0 ? null : (v >>> 31) ? { $import: v & 0x7fffffff } : { $instance: v - 1 }; break; }
        case 'array': {
          const idx = u(q); const a = arrays[idx];
          if (!a) throw new Error('array index out of range ' + idx + ' [' + c.name + '.' + f.name + ' field@' + f.off + ' size ' + c.size + ' align ' + c.align + ' inst+' + (q - f.off - payAt) + ']');
          const ac = cx[a.cx], mf = fields[ac.first], ec = mf.kind === 'struct' ? cx[mf.ref] : null;
          // element stride: struct size rounded up to the struct's alignment
          const esize = ec ? Math.ceil(ec.size / ec.align) * ec.align : SCALAR_SIZE[mf.kind];
          if (esize === undefined) throw new Error('unknown array element kind ' + mf.kind);
          const items = [];
          for (let j = 0; j < a.count; j++) items.push(readValue(mf, arrSecAt + a.off + j * esize, depth));
          out[f.name] = items; break;
        }
        default: out[f.name] = readValue(f, q, depth);
      }
      if (!['inherit', 'struct', 'array'].includes(f.kind)) { out['@' + f.name] = q; out['%' + f.name] = f.kind + (f.kind === 'enum' ? ':' + f.ref : ''); } // byte offset + kind of the value (for in-place edits)
    }
    return out;
  }
  function readValue(f, q, depth) {
    switch (f.kind) {
      case 'struct': return readComplex(f.ref, q, depth + 1);
      case 'bool': return !!b[q];
      case 'int8': return b.readInt8(q); case 'uint8': return b[q];
      case 'int16': return b.readInt16LE(q); case 'uint16': return b.readUInt16LE(q);
      case 'int32': return b.readInt32LE(q); case 'uint32': return u(q);
      case 'int64': return b.readBigInt64LE(q).toString(); case 'uint64': return b.readBigUInt64LE(q).toString();
      case 'float': return b.readFloatLE(q); case 'double': return b.readDoubleLE(q);
      case 'enum': { const v = u(q), e = cx[f.ref]; const m = e && fields.slice(e.first, e.first + e.n).find((x) => x.off === v); return m ? m.name : v; }
      case 'cstring': case 'fileref': return cstr(u(q));
      case 'ref': { const v = u(q); return v === 0 ? null : (v >>> 31) ? { $import: v & 0x7fffffff } : { $instance: v - 1 }; }
      case 'guid': return b.toString('hex', q, q + 16);
      case 'sha1': return b.toString('hex', q, q + 20);
      case 'resref': return b.readBigUInt64LE(q).toString(16);
      default: throw new Error('unknown kind ' + f.kind + ' (type 0x' + f.type.toString(16) + ')');
    }
  }

  // instances: laid out one after another in the payload; each one is [16-byte instance GUID][data aligned to its type]
  const instances = [];
  let q = payAt;
  for (const r of reps) {
    const c = cx[r.cx];
    for (let j = 0; j < r.count; j++) {
      // [instance GUID 16 bytes][data], the GUID position aligned (see instAlign above)
      const ia = instAlign(c);
      q = Math.ceil(q / ia) * ia;
      const instGuid = b.toString('hex', q, q + 16);
      q += 16;
      instances.push({ at: q, guid: instGuid, value: readComplex(r.cx, q) });
      q += c.size;
    }
  }
  return { H, guid, primaryGuid, imports, fields, cx, reps, arrays, instances, payloadEnd: q, payAt, arrSecAt, strAt };
}

module.exports = { parse, KIND };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const L = require('./fb2_extract.js');
  const [cmd, name] = L.OPTS.rest;
  const index = L.loadIndex();
  const fds = new Map(); const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  if (cmd === 'dump') {
    const e = index.find((x) => x.kind === 'ebx' && x.name === name.toLowerCase());
    if (!e) { console.log('ebx not found:', name); process.exit(1); }
    const r = parse(L.readAsset(fdOf(e.sb), e));
    console.log(JSON.stringify({ guid: r.guid, imports: r.imports, instances: r.instances.map((i) => i.value) }, null, 1));
  } else if (cmd === 'selftest') {
    const seen = new Set(); let ok = 0, bad = 0, exactEnd = 0; const errs = {};
    for (const e of index) {
      if (e.kind !== 'ebx' || seen.has(e.name)) continue; seen.add(e.name);
      try {
        const r = parse(L.readAsset(fdOf(e.sb), e));
        ok++;
        // instances must fill the payload up to its end (allowing final alignment padding)
        if (r.payAt + r.H.lenPay - r.payloadEnd >= 0 && r.payAt + r.H.lenPay - r.payloadEnd <= 16) exactEnd++;
        else { const k = 'payload size mismatch'; errs[k] = (errs[k] || 0) + 1; }
      } catch (err) { bad++; const k = err.message.replace(/\d+/g, 'N'); errs[k] = (errs[k] || 0) + 1; }
    }
    console.log({ parsed: ok, failed: bad, payloadExact: exactEnd }, errs);
  } else console.log('Commands: dump <ebx name> | selftest');
}
