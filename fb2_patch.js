'use strict';
/*
 * fb2_patch.js — applies mods from a mods/ folder to Need for Speed: The Run (PC, Frostbite 2).
 *
 *   node fb2_patch.js --game "<game dir>" apply   [--mods ./mods] [--dry-run]
 *   node fb2_patch.js --game "<game dir>" restore
 *   node fb2_patch.js --game "<game dir>" status  [--mods ./mods]
 *   node fb2_patch.js --game "<game dir>" apply --package "<game dir>/Update/Mods"   build an update package instead (game files untouched)
 *   node fb2_patch.js --game "<game dir>" remove-package --package "<game dir>/Update/Mods"
 *
 * mods/ layout (data is the UNPACKED asset, as produced by the extract tools):
 *   mods/chunk/<32-hex guid>.chunk          replaces a chunk (in a .toc chunk list or inside a bundle)
 *   mods/ebx/<asset path>.ebx               replaces an ebx in every bundle that contains it
 *   mods/res/<asset path>.res[_<type>]      replaces a res in every bundle that contains it
 *   mods/adds/<any>.json                    { "next": "<ebx name>", "add": ["<asset name>", ...] }: copies those assets
 *                                           (ebx, res of the same name, the chunks the res uses) from a bundle that
 *                                           has them into every bundle that holds "next" (e.g. a picture for a livery)
 *   (ebx/res and bundle chunks need the asset index: node fb2_extract.js --game "<game dir>" index)
 *
 * Safety:
 *   - Append-only: new data is written at the end of the .sb; existing bytes are never changed.
 *   - Before a .toc is first modified, it is copied to <file>.toc.bak.
 *   - For each touched .sb the original size and sha1 of its first/last MB are recorded;
 *     `restore` checks those hashes and truncates the file back to its original size.
 *   - `apply` always restores first, so applying again starts from clean game files.
 *   - Bundles that the official patch stores as deltas get a new delta appended to the patch .sb
 *     (new header + changed data inline, unchanged data referenced at its original place).
 *   State file: <game dir>/fb2_patch_state.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./fb2_extract.js');
const R = require('./fb2_repack.js');

const GAME = path.dirname(L.DATA_DIR);
const PATCH_DATA = path.join(GAME, 'Update', 'Patch', 'Data');
const STATE_FILE = path.join(GAME, 'fb2_patch_state.json');
const MB = 1 << 20;

const args = L.OPTS.rest;
const cmd = args[0];
const flag = (f) => args.includes(f);
const optVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MODS = path.resolve(optVal('--mods', 'mods'));
const DRY = flag('--dry-run');
// Package mode (--package <dir>, normally <game>/Update/Mods): the game files are never written.
// The official patch is copied to <dir>.new, the mods are applied to that copy, and it becomes an extra
// update package with a higher version than the patch, which the game loads instead of Update/Patch.
const PKG = optVal('--package', null) ? path.resolve(optVal('--package')) : null;
let PD = PATCH_DATA; // the patch data that is read and modified: the game's own patch, or the package copy

const rel = (f) => path.relative(GAME, f);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const readAt = (file, pos, len) => { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); fs.closeSync(fd); return b; };

// ---------------------------------------------------------------- state / backups

function loadState() { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { version: 1, files: {} }; }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

function protectToc(state, file) {
  if (PKG) return; // package mode only writes to its own copy: nothing to back up
  const k = rel(file);
  if (state.files[k]) return;
  if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
  state.files[k] = { type: 'toc', backup: k + '.bak' };
  saveState(state);
}

function protectSb(state, file) {
  if (PKG) return;
  const k = rel(file);
  if (state.files[k]) return;
  const size = fs.statSync(file).size;
  const n = Math.min(MB, size);
  state.files[k] = { type: 'sb', originalSize: size, headSha1: sha1(readAt(file, 0, n)), tailSha1: sha1(readAt(file, size - n, n)) };
  saveState(state);
}

function restore({ quiet } = {}) {
  const state = loadState();
  const keys = Object.keys(state.files);
  if (!keys.length) { if (!quiet) console.log('Nothing to restore: no patch state found.'); return true; }
  let ok = true;
  for (const k of keys) {
    const f = path.join(GAME, k), e = state.files[k];
    if (e.type === 'toc') {
      const bak = path.join(GAME, e.backup);
      if (!fs.existsSync(bak)) { console.error('  MISSING backup, cannot restore:', bak); ok = false; continue; }
      fs.copyFileSync(bak, f); fs.unlinkSync(bak);
      console.log('  restored', k);
    } else {
      const size = fs.statSync(f).size;
      const n = Math.min(MB, e.originalSize);
      if (size < e.originalSize || sha1(readAt(f, 0, n)) !== e.headSha1 || sha1(readAt(f, e.originalSize - n, n)) !== e.tailSha1) {
        console.error('  REFUSED (original bytes changed, not truncating):', k); ok = false; continue;
      }
      fs.truncateSync(f, e.originalSize);
      console.log(`  truncated ${k} to ${e.originalSize} bytes`);
    }
    delete state.files[k];
  }
  if (ok) fs.unlinkSync(STATE_FILE); else saveState(state);
  return ok;
}

// ---------------------------------------------------------------- game layout

const walkToc = (d, o = []) => { if (!fs.existsSync(d)) return o; for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walkToc(f, o); else if (/\.toc$/i.test(x.name) && x.name.toLowerCase() !== 'layout.toc') o.push(f); } return o; };

// superbundle name ("Win32/UI") -> 'delta' | 'same' | ...
function patchLayout() {
  const f = path.join(PD, 'layout.toc');
  const m = new Map();
  if (!fs.existsSync(f)) return m;
  for (const s of L.readToc(f).superBundles || []) m.set(s.name.toLowerCase(), Object.keys(s).filter((k) => k !== 'name').join('+'));
  return m;
}

const tocCache = new Map(); // file -> parsed toc (lossless)
const dirty = new Set();
function toc(file) { if (!tocCache.has(file)) tocCache.set(file, R.readTocFile(file)); return tocCache.get(file); }

function findTocChunk(guid) {
  for (const f of [...walkToc(PD), ...walkToc(L.DATA_DIR)]) {
    const e = R.tocChunks(toc(f)).find((c) => R.entryId(c) === guid);
    if (e) return { tocFile: f, sbFile: f.replace(/\.toc$/i, '.sb'), entry: e };
  }
  return null;
}

// ---------------------------------------------------------------- mods

function collectMods() {
  const mods = [];
  if (!fs.existsSync(MODS)) return mods;
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f); else mods.push(f); } };
  walk(MODS);
  return mods.map((f) => {
    const parts = path.relative(MODS, f).split(/[\\/]/);
    const kind = parts.shift();
    let name = parts.join('/').toLowerCase();
    if (kind === 'chunk') name = name.replace(/\.chunk$/, '');
    else if (kind === 'ebx') name = name.replace(/\.ebx$/, '');
    else if (kind === 'res') name = name.replace(/\.res(_[0-9a-f]+)?$/, '');
    return { file: f, kind, name };
  }).filter((m) => ['chunk', 'ebx', 'res'].includes(m.kind) && !m.file.endsWith('.json')); // <guid>.chunk.json: hints, not mods
}
function collectAdds() {
  const d = path.join(MODS, 'adds');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
}

function apply() {
  const mods = collectMods(), adds = collectAdds();
  if (!mods.length && !adds.length) { console.log('No mods found in', MODS); return; }
  if (PKG) {
    // the package is built from the ORIGINAL official patch, so the game's own files must not be patched in place
    if (Object.keys(loadState().files).length) throw new Error('the game files are patched in place; run "restore" first');
    if (!DRY) {
      const stage = PKG + '.new';
      fs.rmSync(stage, { recursive: true, force: true });
      copyDir(PATCH_DATA, path.join(stage, 'Data'));
      PD = path.join(stage, 'Data');
    }
  } else if (!DRY && !restore({ quiet: true })) { console.error('Previous patch could not be restored cleanly; stopping.'); process.exit(1); }
  const state = loadState();
  const layout = patchLayout();
  let index = null;
  const getIndex = () => index || (index = L.loadIndex());
  const haveIndex = () => fs.existsSync(L.INDEX_FILE);
  const warn = (msg) => console.log('  WARNING: ' + msg);
  const plan = [];                 // human-readable actions
  const bundleJobs = new Map();    // key sb|bundleId -> { sbFile, bundleId, repl: Map(name -> raw) }

  for (const m of mods) {
    const raw = fs.readFileSync(m.file);
    // a resized texture: where its streamed-later levels end (bundles that hold only the rest need it)
    if (m.kind === 'chunk' && fs.existsSync(m.file + '.json')) raw.logicalOffset = JSON.parse(fs.readFileSync(m.file + '.json', 'utf8')).logicalOffset;
    let inToc = false;
    if (m.kind === 'chunk') {
      const hit = findTocChunk(m.name);
      if (hit) {
        const keys = hit.entry.v.map((n) => n.name.toString('latin1')).sort().join(',');
        if (keys !== 'id,offset,size') throw new Error(`chunk ${m.name}: unexpected toc fields (${keys}), refusing`);
        plan.push({ m, where: rel(hit.tocFile), hit, raw });
        inToc = true;
      }
      // the same chunk may also be stored inside bundles: update those copies too
      if (!haveIndex()) { if (inToc) { warn('no asset index: copies of ' + m.name + ' inside bundles are not updated'); continue; } }
    }
    const hits = getIndex().filter((e) => e.kind === m.kind && e.name.toLowerCase() === m.name);
    if (!hits.length && !inToc) throw new Error(`${m.kind} "${m.name}" not found in the game (check the name, or rebuild the index)`);
    for (const e of hits) {
      const key = e.sb + '|' + e.bundle;
      if (!bundleJobs.has(key)) bundleJobs.set(key, { sbFile: path.join(L.DATA_DIR, e.sb), sbRel: e.sb, bundleId: e.bundle, repl: new Map() });
      bundleJobs.get(key).repl.set(m.kind + ':' + m.name, raw);
    }
  }
  // assets copied into other bundles: where they come from, and the bundles that get them
  if (adds.length) {
    const modRaw = new Map(mods.map((m) => [m.kind + ':' + m.name, m]));
    const sources = new Map(); // bundle -> parsed (each read once)
    const parsed = (e) => {
      const k = e.sb + '|' + e.bundle;
      if (!sources.has(k)) {
        const t = R.tocBundles(toc(path.join(L.DATA_DIR, e.sb.replace(/\.sb$/i, '.toc')))).find((b) => R.entryId(b) === e.bundle);
        if (!t) throw new Error('bundle not found: ' + e.bundle);
        sources.set(k, R.parseBundle(readAt(path.join(L.DATA_DIR, e.sb), R.numOf(R.child(t, 'offset')), R.numOf(R.child(t, 'size')))));
      }
      return sources.get(k);
    };
    for (const a of adds) {
      const next = a.next.toLowerCase();
      const targets = getIndex().filter((e) => e.kind === 'ebx' && e.name.toLowerCase() === next);
      if (!targets.length) throw new Error(`adds: "${a.next}" not found in the game`);
      const list = [];
      for (const name of a.add.map((x) => x.toLowerCase())) {
        const src = getIndex().find((e) => e.kind === 'ebx' && e.name.toLowerCase() === name);
        if (!src) throw new Error(`adds: "${name}" not found in the game`);
        const from = parsed(src);
        list.push({ from, kind: 'ebx', name });
        const res = from.entries.find((x) => x.kind === 'res' && x.name.toLowerCase() === name);
        if (res) {
          list.push({ from, kind: 'res', name });
          const data = res.size === res.orig ? res.data : L.unpackBlocks(res.data);
          const hex = data.toString('hex');
          for (const c of from.entries.filter((x) => x.kind === 'chunk')) if (hex.includes(c.name)) list.push({ from, kind: 'chunk', name: c.name });
        }
      }
      for (const e of targets) {
        const key = e.sb + '|' + e.bundle;
        if (!bundleJobs.has(key)) bundleJobs.set(key, { sbFile: path.join(L.DATA_DIR, e.sb), sbRel: e.sb, bundleId: e.bundle, repl: new Map() });
        const job = bundleJobs.get(key);
        job.adds = [...(job.adds || []), ...list];
        // the copies get the mods' versions too (e.g. a new picture)
        for (const x of list) { const m = modRaw.get(x.kind + ':' + x.name); if (m) { const raw = fs.readFileSync(m.file); if (m.kind === 'chunk' && fs.existsSync(m.file + '.json')) raw.logicalOffset = JSON.parse(fs.readFileSync(m.file + '.json', 'utf8')).logicalOffset; job.repl.set(x.kind + ':' + x.name, raw); } }
      }
    }
  }
  const chunkOnly = (job) => [...job.repl.keys()].every((k) => k.startsWith('chunk:'));

  // check bundles against the official patch before writing anything
  for (const job of bundleJobs.values()) {
    const superName = job.sbRel.replace(/\.sb$/i, '').split(/[\\/]/).join('/').toLowerCase();
    job.flag = layout.get(superName) || '';
    if (job.flag.includes('delta')) {
      const pf = path.join(PD, job.sbRel.replace(/\.sb$/i, '.toc'));
      const pe = fs.existsSync(pf) && R.tocBundles(toc(pf)).find((b) => R.entryId(b).toLowerCase() === job.bundleId.toLowerCase());
      if (pe && R.entryFlag(pe, 'delta')) { job.deltaToc = pf; continue; } // the game reads this bundle from the patch delta
      if (pe) job.patchToc = pf;
      else if (PKG) { job.skip = true; warn(`${job.bundleId}: not used by the patched game, skipped`); }
    } else if (PKG) {
      throw new Error(`${job.bundleId} is in ${job.sbRel}, which the official patch does not change; package mode does not support it yet`);
    }
  }

  for (const [k, job] of bundleJobs) if (job.skip) bundleJobs.delete(k);
  console.log(`${DRY ? 'Plan (dry run)' : 'Applying'}: ${plan.length} toc chunk(s), ${bundleJobs.size} bundle(s)`);
  for (const p of plan) console.log(`  chunk ${p.m.name} -> ${p.where}`);
  for (const j of bundleJobs.values()) console.log(`  bundle ${j.bundleId} (${j.deltaToc ? 'official patch delta -> new delta in patch .sb' : j.sbRel + (j.patchToc ? ', also patch toc' : '')}) <- ${[...j.repl.keys()].join(', ')}${j.adds ? ' + adds ' + j.adds.map((x) => x.kind + ':' + x.name).join(', ') : ''}`);
  if (DRY) return;

  // 1) chunks listed directly in a .toc
  for (const p of plan) {
    let e = p.hit.entry, tocFile = p.hit.tocFile, sbFile = p.hit.sbFile;
    const origSize = R.numOf(R.child(e, 'size'));
    const orig = readAt(p.hit.sbFile, R.numOf(R.child(e, 'offset')), Math.min(64, origSize));
    const stored = R.isBlockFramed(orig, origSize) ? R.packChunk(p.raw) : p.raw; // keep the original storage style (and the tail border)
    if (PKG && tocFile.startsWith(L.DATA_DIR + path.sep)) {
      // the chunk lives in a base toc: patch tocs list only new/changed chunks, so add an entry to the package copy
      tocFile = path.join(PD, path.relative(L.DATA_DIR, tocFile));
      sbFile = tocFile.replace(/\.toc$/i, '.sb');
      const list = fs.existsSync(tocFile) && R.child(toc(tocFile).root, 'chunks');
      if (!list) throw new Error(`chunk ${p.m.name} is in ${rel(p.hit.tocFile)}, which the official patch does not change; package mode does not support it yet`);
      e = R.dbRead(R.dbWrite(e)).root; // a copy of the original entry (same id and field types)
      list.v.push(e);
    }
    protectToc(state, tocFile); protectSb(state, sbFile);
    const off = R.appendToSb(sbFile, stored);
    R.setNum(R.child(e, 'offset'), off); R.setNum(R.child(e, 'size'), stored.length);
    dirty.add(tocFile);
  }

  // 2a) bundles the official patch stores as deltas: write a new delta into the patch .sb
  const COMMON = path.join(PD, 'common.dat');
  for (const job of [...bundleJobs.values()].filter((j) => j.deltaToc)) {
    const pe = R.tocBundles(toc(job.deltaToc)).find((b) => R.entryId(b).toLowerCase() === job.bundleId.toLowerCase());
    const pSb = job.deltaToc.replace(/\.toc$/i, '.sb');
    const res = R.rebuildDeltaBundle(pSb, R.numOf(R.child(pe, 'offset')), R.numOf(R.child(pe, 'size')), job.sbFile, COMMON,
      (e) => job.repl.get(e.kind + ':' + e.name.toLowerCase()) || null, job.adds);
    if (res.replaced !== job.repl.size) throw new Error('could not locate every asset inside the patched ' + job.bundleId);
    protectToc(state, job.deltaToc); protectSb(state, pSb);
    const newOff = R.appendToSb(pSb, res.delta);
    R.setNum(R.child(pe, 'offset'), newOff); R.setNum(R.child(pe, 'size'), res.delta.length);
    dirty.add(job.deltaToc);
  }

  // 2b) regular bundles: rebuild with replaced entries, append, repoint the .toc entries
  for (const job of [...bundleJobs.values()].filter((j) => !j.deltaToc)) {
    const baseToc = job.sbFile.replace(/\.sb$/i, '.toc');
    const be = R.tocBundles(toc(baseToc)).find((b) => R.entryId(b) === job.bundleId);
    if (!be) throw new Error('bundle not found in ' + rel(baseToc) + ': ' + job.bundleId);
    const off = R.numOf(R.child(be, 'offset')), size = R.numOf(R.child(be, 'size'));
    const fd = fs.openSync(job.sbFile, 'r');
    const info = L.readBundle(fd, off, size);
    const replacements = new Map();
    info.entries.forEach((e, i) => { const r = job.repl.get(e.kind + ':' + e.name.toLowerCase()); if (r) replacements.set(i, r); });
    if (job.adds) {
      // the bundle gets new entries: everything is done on the grown copy (package mode)
      fs.closeSync(fd);
      if (!PKG) throw new Error(job.bundleId + ': adding assets to a bundle needs package mode');
      const res = R.rebuildBaseAsDelta(job.sbFile, off, size, COMMON, (e) => job.repl.get(e.kind + ':' + e.name.toLowerCase()) || null, job.adds);
      if (res.replaced !== job.repl.size) throw new Error('could not locate every asset inside ' + job.bundleId);
      const pe = R.tocBundles(toc(job.patchToc)).find((b) => R.entryId(b).toLowerCase() === job.bundleId.toLowerCase());
      const flagN = R.child(pe, 'base');
      if (!flagN) throw new Error('unexpected patch toc entry for ' + job.bundleId);
      flagN.name = Buffer.from('delta', 'latin1');
      const newOff = R.appendToSb(job.patchToc.replace(/\.sb$/i, '.sb').replace(/\.toc$/i, '.sb'), res.delta);
      R.setNum(R.child(pe, 'offset'), newOff); R.setNum(R.child(pe, 'size'), res.delta.length);
      dirty.add(job.patchToc);
      continue;
    }
    if (replacements.size !== job.repl.size) { fs.closeSync(fd); throw new Error('could not locate every asset inside ' + job.bundleId); }
    // trimmed chunk copies (logical offset != 0) are not supported yet: skip them, keep the rest
    const hb4 = Buffer.alloc(4); fs.readSync(fd, hb4, 0, 4, off);
    const hbuf = Buffer.alloc(hb4.readUInt32BE(0) + 4); fs.readSync(fd, hbuf, 0, hbuf.length, off);
    const lay = R.bundleLayout(hbuf);
    for (const i of [...replacements.keys()]) {
      if (info.entries[i].kind !== 'chunk') continue;
      if (hbuf.readUInt32BE(lay.chunkAt(i - lay.nEbx - lay.nRes) + 16) !== 0) {
        warn(`skipping trimmed chunk copy ${info.entries[i].name} in ${job.bundleId}`);
        replacements.delete(i);
      }
    }
    if (!replacements.size) { fs.closeSync(fd); continue; }
    if (PKG) {
      // the patch reads this bundle from the base game ("base" flag): write it into the package as a delta
      // against the base .sb, and switch the entry's flag to "delta"
      fs.closeSync(fd);
      const keep = new Set([...replacements.keys()].map((i) => info.entries[i].kind + ':' + info.entries[i].name.toLowerCase()));
      const res = R.rebuildBaseAsDelta(job.sbFile, off, size, COMMON, (e) => { const k = e.kind + ':' + e.name.toLowerCase(); return keep.has(k) ? job.repl.get(k) : null; });
      if (res.replaced !== keep.size) throw new Error('could not locate every asset inside ' + job.bundleId);
      const pe = R.tocBundles(toc(job.patchToc)).find((b) => R.entryId(b).toLowerCase() === job.bundleId.toLowerCase());
      const flagN = R.child(pe, 'base');
      if (!flagN) throw new Error('unexpected patch toc entry for ' + job.bundleId);
      flagN.name = Buffer.from('delta', 'latin1');
      const newOff = R.appendToSb(job.patchToc.replace(/\.toc$/i, '.sb'), res.delta);
      R.setNum(R.child(pe, 'offset'), newOff); R.setNum(R.child(pe, 'size'), res.delta.length);
      dirty.add(job.patchToc);
      continue;
    }
    const rebuilt = R.rebuildBundle(fd, off, size, replacements);
    fs.closeSync(fd);
    protectToc(state, baseToc); protectSb(state, job.sbFile);
    const newOff = R.appendToSb(job.sbFile, rebuilt);
    R.setNum(R.child(be, 'offset'), newOff); R.setNum(R.child(be, 'size'), rebuilt.length);
    dirty.add(baseToc);
    if (job.patchToc) {
      const pe = R.tocBundles(toc(job.patchToc)).find((b) => R.entryId(b).toLowerCase() === job.bundleId.toLowerCase());
      protectToc(state, job.patchToc);
      R.setNum(R.child(pe, 'offset'), newOff); R.setNum(R.child(pe, 'size'), rebuilt.length);
      dirty.add(job.patchToc);
    }
  }

  for (const f of dirty) fs.writeFileSync(f, R.encodeToc(toc(f)));
  if (PKG) { finishPackage(); return; }
  console.log(`Done. Modified ${dirty.size} toc file(s). Undo with: node fb2_patch.js --game "<game dir>" restore`);
}

// ---------------------------------------------------------------- package mode helpers

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const x of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, x.name), b = path.join(to, x.name);
    if (x.isDirectory()) copyDir(a, b);
    else if (!/\.bak$/i.test(x.name)) fs.copyFileSync(a, b); // never carry our own backups into the package
  }
}

// A package we created has a package.mft with "Name mods"; anything else in that place is left alone.
function isOurPackage(dir) {
  const f = path.join(dir, 'package.mft');
  return fs.existsSync(f) && /^Name\s+mods\s*$/im.test(fs.readFileSync(f, 'latin1'));
}

function finishPackage() {
  const stage = PKG + '.new';
  // the game prefers the package with the higher version: one above the official patch
  const pm = fs.readFileSync(path.join(GAME, 'Update', 'Patch', 'package.mft'), 'latin1').match(/^Version\s+(\d+)/im);
  const version = (pm ? Number(pm[1]) : 35) + 1;
  fs.writeFileSync(path.join(stage, 'package.mft'), `Name mods\r\nAuthoritative\r\nVersion ${version}\r\n`);
  if (fs.existsSync(PKG)) {
    if (!isOurPackage(PKG)) throw new Error(`${PKG} exists and was not created by this tool; not replacing it`);
    fs.rmSync(PKG, { recursive: true, force: true });
  }
  fs.renameSync(stage, PKG);
  console.log(`Done. Mod package written to ${rel(PKG)} (version ${version}). The original game files were not changed.`);
}

function removePackage() {
  if (!PKG) throw new Error('usage: remove-package --package <dir>');
  fs.rmSync(PKG + '.new', { recursive: true, force: true });
  if (!fs.existsSync(PKG)) { console.log('No mod package installed.'); return; }
  if (!isOurPackage(PKG)) throw new Error(`${PKG} was not created by this tool; not removing it`);
  fs.rmSync(PKG, { recursive: true, force: true });
  console.log(`Removed ${rel(PKG)}. The game runs with its original files.`);
}

function status() {
  const s = loadState();
  const files = Object.entries(s.files);
  console.log(files.length ? 'Patched files:' : 'Game files are not patched.');
  for (const [k, e] of files) console.log(`  ${e.type.padEnd(3)} ${k}` + (e.type === 'sb' ? `  (original ${e.originalSize} bytes, now ${fs.statSync(path.join(GAME, k)).size})` : ''));
  const mods = collectMods();
  console.log(`Mods in ${MODS}: ${mods.length}`);
  for (const m of mods) console.log(`  ${m.kind} ${m.name}`);
}

if (cmd === 'apply') { try { apply(); } catch (e) { if (PKG) fs.rmSync(PKG + '.new', { recursive: true, force: true }); console.error('ERROR: ' + e.message); process.exit(1); } }
else if (cmd === 'remove-package') removePackage();
else if (cmd === 'restore') { const ok = restore(); process.exit(ok ? 0 : 1); }
else if (cmd === 'status') status();
else console.log('Commands: apply [--mods <dir>] [--dry-run] | restore | status   (shared option: --game <game dir>)');
