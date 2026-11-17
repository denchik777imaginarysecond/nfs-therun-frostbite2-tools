'use strict';
/*
 * fb2_chunks.js — looks for "abandoned" chunks: data blocks that nothing references.
 *
 * Idea: a chunk has no name, only a GUID (16 bytes). Whatever uses it (texture, mesh, sound)
 * stores that GUID inside its own data. So instead of parsing every format, we simply
 * search all ebx and res data for the bytes of every GUID. Not found anywhere = abandoned chunk.
 *
 *   node fb2_chunks.js --game "<game dir>"   -> output/_chunk_orphans.tsv, output/_chunk_cut.tsv + summary
 */
const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');

const OUT_TSV = path.join(L.OUT_DIR, '_chunk_orphans.tsv');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const index = L.loadIndex();

// ---------------------------------------------- 1. all chunks and where they live
const chunks = new Map(); // guid -> {sb, pos, size, bundle, ref}
for (const e of index) {
  if (e.kind === 'chunk' && !chunks.has(e.name)) chunks.set(e.name, { sb: e.sb, pos: e.pos, size: e.size, bundle: e.bundle, ref: null });
}
const inBundles = chunks.size;
const walk = (d, o = []) => {
  for (const x of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, x.name);
    if (x.isDirectory()) walk(f, o); else if (/\.toc$/i.test(x.name) && x.name.toLowerCase() !== 'layout.toc') o.push(f);
  }
  return o;
};
for (const t of walk(path.join(L.DATA_DIR, 'Win32'))) {
  const sb = path.relative(L.DATA_DIR, t.replace(/\.toc$/i, '.sb'));
  for (const c of L.readToc(t).chunks || []) if (!chunks.has(c.id)) chunks.set(c.id, { sb, pos: c.offset, size: c.size, bundle: '', ref: null });
}
log(`chunks: ${chunks.size} (in bundles ${inBundles}, in shared stores ${chunks.size - inBundles})`);

// Fast lookup: first by the first 4 bytes (as a number), then a full compare
const byPrefix = new Map();
for (const g of chunks.keys()) {
  const p = Buffer.from(g, 'hex').readUInt32LE(0);
  if (!byPrefix.has(p)) byPrefix.set(p, []);
  byPrefix.get(p).push(g);
}

// ---------------------------------------------- 2. scan all ebx and res
const seen = new Set();
const list = index.filter((e) => e.kind !== 'chunk' && !seen.has(e.kind + e.name.toLowerCase()) && seen.add(e.kind + e.name.toLowerCase()))
  .sort((a, b) => (a.sb < b.sb ? -1 : a.sb > b.sb ? 1 : a.pos - b.pos));
log(`scanning ${list.length} ebx/res...`);
const fds = new Map();
let bytes = 0, hits = 0;
list.forEach((e, i) => {
  if (!fds.has(e.sb)) fds.set(e.sb, fs.openSync(path.join(L.DATA_DIR, e.sb), 'r'));
  let buf;
  try { buf = L.readAsset(fds.get(e.sb), e); } catch { return; }
  bytes += buf.length;
  // Search at EVERY byte: e.g. the terrain streaming tree (.streamingtree) stores GUIDs unaligned
  for (let o = 0; o + 16 <= buf.length; o++) {
    const cand = byPrefix.get(buf.readUInt32LE(o));
    if (!cand) continue;
    const hex = buf.toString('hex', o, o + 16);
    for (const g of cand) {
      if (g !== hex) continue;
      const c = chunks.get(g);
      if (!c.ref) { c.ref = new Set(); hits++; }
      if (c.ref.size < 50) c.ref.add(e.name.toLowerCase()); // remember every referrer
    }
  }
  if (i % 40000 === 0) log(`  ${i}/${list.length}, ${(bytes / 1048576).toFixed(0)} MB`);
});
for (const fd of fds.values()) fs.closeSync(fd);
log(`scanned ${(bytes / 1048576).toFixed(0)} MB, found references to ${hits} chunks`);

// ---------------------------------------------- 3. summary
const orphans = [...chunks].filter(([, c]) => !c.ref);
const sum = (arr) => arr.reduce((s, [, c]) => s + c.size, 0);
const group = (arr, key) => {
  const m = new Map();
  for (const x of arr) { const k = key(x); const v = m.get(k) || [0, 0]; v[0]++; v[1] += x[1].size; m.set(k, v); }
  return [...m].sort((a, b) => b[1][1] - a[1][1]);
};
console.log(`\nTotal ${chunks.size}, referenced: ${chunks.size - orphans.length}, abandoned: ${orphans.length} (${(sum(orphans) / 1048576).toFixed(0)} MB compressed)`);
console.log('\nAbandoned, by file:');
for (const [k, [n, s]] of group(orphans, ([, c]) => c.sb)) console.log(`  ${String(n).padStart(6)}  ${(s / 1048576).toFixed(1).padStart(7)} MB  ${k}`);
console.log('\nAbandoned inside bundles (top 25 bundles):');
for (const [k, [n, s]] of group(orphans.filter(([, c]) => c.bundle), ([, c]) => c.bundle).slice(0, 25)) console.log(`  ${String(n).padStart(5)}  ${(s / 1048576).toFixed(1).padStart(6)} MB  ${k}`);

fs.writeFileSync(OUT_TSV, 'guid\tsb\tpos\tsize\tbundle\n' + orphans.map(([g, c]) => [g, c.sb, c.pos, c.size, c.bundle].join('\t')).join('\n') + '\n');
log('list:', OUT_TSV);

// ---------------------------------------------- 4. chunks needed ONLY by suspect assets
// Suspect = orphans (no ebx references them) + dev/debug/test by name (same rule as fb2_analyze.js)
const DEV_RE = /(^|[\/_])(dev|debug|debugmenu|test|tests|testing|testlevel|proto|prototype|prototypes|temp|tmp|wip|old|unused|cut|deprecated|obsolete|placeholder|sandbox|dummy|cheat|cheats)([\/_]|\d|$)/;
const db = fs.readFileSync(path.join(L.OUT_DIR, 'ebx_db.jsonl'), 'latin1').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const referenced = new Set();
for (const r of db) for (const g of r.imports) referenced.add(g);
const suspect = new Set(db.filter((r) => !referenced.has(r.guid) || DEV_RE.test(r.name)).map((r) => r.name));
// bundle roots are not orphans (they are loaded by bundle name)
const bundleNames = new Set(index.map((e) => e.bundle.toLowerCase().replace(/^win32\//, '')));
for (const n of [...suspect]) if (!DEV_RE.test(n) && [...['', '_blueprintbundle', '_bundle']].some((s) => bundleNames.has(n + s))) suspect.delete(n);

const cutChunks = [...chunks].filter(([, c]) => c.ref && [...c.ref].every((n) => suspect.has(n)));
console.log(`\nChunks referenced ONLY by suspect assets: ${cutChunks.length} (${(sum(cutChunks) / 1048576).toFixed(1)} MB compressed)`);
for (const [k, [n, s]] of group(cutChunks, ([, c]) => [...c.ref][0].split('/').slice(0, 4).join('/')).slice(0, 30)) {
  console.log(`  ${String(n).padStart(5)}  ${(s / 1048576).toFixed(1).padStart(6)} MB  ${k}`);
}
fs.writeFileSync(path.join(L.OUT_DIR, '_chunk_cut.tsv'), 'guid\tsb\tpos\tsize\treferrers\n' +
  cutChunks.map(([g, c]) => [g, c.sb, c.pos, c.size, [...c.ref].join(' ')].join('\t')).join('\n') + '\n');
log('list:', path.join(L.OUT_DIR, '_chunk_cut.tsv'));
