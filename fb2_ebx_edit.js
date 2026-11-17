'use strict';
/*
 * fb2_ebx_edit.js — view and edit values inside ebx assets, as the game sees them (official patch deltas applied).
 *
 *   node fb2_ebx_edit.js --game "<game dir>" show <ebx name> [type filter]
 *   node fb2_ebx_edit.js --game "<game dir>" set  <ebx name> <path>=<value> [<path>=<value> ...] [--mods ./mods]
 *
 * <path> = <instance index>.<field>[.<field>...], e.g. 5.Visibility.InvertValue
 * Values are written in place, so only fixed-size values can be edited:
 *   bool (true/false), int8..uint64, float, double, enum (name or number), reference (null only).
 * The edited ebx is re-parsed to check it, then written to mods/ebx/<name>.ebx for fb2_patch.js.
 */
const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');
const R = require('./fb2_repack.js');
const F = require('./fb2_ebx_fields.js');

const GAME = path.dirname(L.DATA_DIR), PD = path.join(GAME, 'Update', 'Patch', 'Data');

// Reads an ebx the way the game sees it: from the official patch delta bundle when there is one.
function readAsGameSees(index, name) {
  const hits = index.filter((e) => e.kind === 'ebx' && e.name.toLowerCase() === name.toLowerCase());
  if (!hits.length) throw new Error('ebx not found: ' + name);
  for (const hit of hits) {
    const ptoc = path.join(PD, hit.sb.replace(/\.sb$/i, '.toc'));
    if (!fs.existsSync(ptoc)) continue;
    const pe = L.readToc(ptoc).bundles.find((b) => b.id.toLowerCase() === hit.bundle.toLowerCase());
    if (!pe || !pe.delta) continue;
    const rec = R.reconstructDelta(R.readDelta(ptoc.replace(/\.toc$/i, '.sb'), pe.offset, pe.size), path.join(L.DATA_DIR, hit.sb), path.join(PD, 'common.dat'));
    let data = null;
    R.withTempFile(rec.buf, (fd) => {
      const info = L.readBundle(fd, 0, rec.buf.length);
      const e = info.entries.find((x) => x.kind === 'ebx' && x.name.toLowerCase() === name.toLowerCase());
      if (e) data = L.readAsset(fd, e);
    });
    if (data) return { data, source: 'official patch: ' + hit.bundle };
  }
  return { data: L.readAsset(fs.openSync(path.join(L.DATA_DIR, hits[0].sb), 'r'), hits[0]), source: 'base game' };
}

function resolve(parsed, p) {
  const parts = p.split('.');
  const idx = Number(parts.shift());
  if (!parsed.instances[idx]) throw new Error('no instance ' + idx);
  let obj = parsed.instances[idx].value;
  while (parts.length > 1) {
    const k = parts.shift();
    obj = /^\d+$/.test(k) && Array.isArray(obj) ? obj[Number(k)] : obj[k];
    if (!obj || typeof obj !== 'object') throw new Error('path not found: ' + p);
  }
  const field = parts[0];
  if (obj['@' + field] === undefined) throw new Error(`"${field}" is not an editable value in ${p}`);
  return { at: obj['@' + field], kind: obj['%' + field], old: obj[field] };
}

function writeValue(buf, parsed, at, kind, text) {
  const [k, enumRef] = kind.split(':');
  const num = () => { const n = Number(text); if (!Number.isFinite(n)) throw new Error('not a number: ' + text); return n; };
  switch (k) {
    case 'bool': if (!/^(true|false|0|1)$/.test(text)) throw new Error('bool must be true/false'); buf[at] = /^(true|1)$/.test(text) ? 1 : 0; break;
    case 'int8': buf.writeInt8(num(), at); break; case 'uint8': buf.writeUInt8(num(), at); break;
    case 'int16': buf.writeInt16LE(num(), at); break; case 'uint16': buf.writeUInt16LE(num(), at); break;
    case 'int32': buf.writeInt32LE(num(), at); break; case 'uint32': buf.writeUInt32LE(num(), at); break;
    case 'int64': buf.writeBigInt64LE(BigInt(text), at); break; case 'uint64': buf.writeBigUInt64LE(BigInt(text), at); break;
    case 'float': buf.writeFloatLE(num(), at); break; case 'double': buf.writeDoubleLE(num(), at); break;
    case 'enum': {
      const e = parsed.cx[Number(enumRef)];
      const opt = parsed.fields.slice(e.first, e.first + e.n).find((f) => f.name === text);
      buf.writeUInt32LE(opt ? opt.off : num(), at); break;
    }
    case 'ref': if (text !== 'null') throw new Error('references can only be set to null'); buf.writeUInt32LE(0, at); break;
    default: throw new Error(`values of kind "${k}" cannot be edited in place`);
  }
}

module.exports = { readAsGameSees };

if (require.main === module) {
  const args = L.OPTS.rest;
  const mi = args.indexOf('--mods');
  const mods = path.resolve(mi >= 0 ? args.splice(mi, 2)[1] : 'mods');
  const [cmd, name, ...rest] = args;
  const index = L.loadIndex();
  if (cmd === 'show') {
    const { data, source } = readAsGameSees(index, name);
    const parsed = F.parse(data);
    console.log(`# ${name} (${source})`);
    const clean = (v) => JSON.stringify(v, (k, x) => (k[0] === '@' || k[0] === '%' ? undefined : x));
    parsed.instances.forEach((inst, i) => { if (!rest[0] || new RegExp(rest[0], 'i').test(clean(inst.value))) console.log(`[${i}] ${clean(inst.value)}`); });
  } else if (cmd === 'set') {
    const { data, source } = readAsGameSees(index, name);
    const buf = Buffer.from(data);
    let parsed = F.parse(buf);
    for (const a of rest) {
      const eq = a.indexOf('=');
      if (eq < 0) throw new Error('expected <path>=<value>: ' + a);
      const p = a.slice(0, eq), v = a.slice(eq + 1);
      const t = resolve(parsed, p);
      writeValue(buf, parsed, t.at, t.kind, v);
      parsed = F.parse(buf); // re-parse after every change: must still be a valid ebx
      console.log(`  ${p}: ${JSON.stringify(t.old)} -> ${JSON.stringify(resolve(parsed, p).old)}`);
    }
    const out = path.join(mods, 'ebx', name.toLowerCase() + '.ebx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    console.log(`edited ebx (from ${source}) written to ${out}`);
  } else console.log('Commands: show <ebx> [filter] | set <ebx> <path>=<value> ... [--mods ./mods]');
}
