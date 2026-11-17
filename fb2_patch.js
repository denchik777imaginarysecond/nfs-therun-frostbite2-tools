'use strict';
/*
 * fb2_patch.js — applies mods from a mods/ folder to Need for Speed: The Run (PC, Frostbite 2).
 *
 *   node fb2_patch.js --game "<game dir>" apply   [--mods ./mods] [--dry-run]
 *   node fb2_patch.js --game "<game dir>" restore
 *   node fb2_patch.js --game "<game dir>" status  [--mods ./mods]
 *
 * mods/ layout (data is the UNPACKED asset, as produced by the extract tools):
 *   mods/chunk/<32-hex guid>.chunk          replaces a chunk (in a .toc chunk list or inside a bundle)
 *   mods/ebx/<asset path>.ebx               replaces an ebx in every bundle that contains it
 *   mods/res/<asset path>.res[_<type>]      replaces a res in every bundle that contains it
 *   (ebx/res and bundle chunks need the asset index: node fb2_extract.js --game "<game dir>" index)
 *
 * Safety:
 *   - Append-only: new data is written at the end of the .sb; existing bytes are never changed.
 *   - Before a .toc is first modified, it is copied to <file>.toc.bak.
 *   - For each touched .sb the original size and sha1 of its first/last MB are recorded;
 *     `restore` checks those hashes and truncates the file back to its original size.
 *   - `apply` always restores first, so applying again starts from clean game files.
 *   - Bundles that the official patch replaces with a delta bundle are refused (format not supported yet).
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

const rel = (f) => path.relative(GAME, f);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const readAt = (file, pos, len) => { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); fs.closeSync(fd); return b; };

// ---------------------------------------------------------------- state / backups

function loadState() { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { version: 1, files: {} }; }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

function protectToc(state, file) {
  const k = rel(file);
  if (state.files[k]) return;
  if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
  state.files[k] = { type: 'toc', backup: k + '.bak' };
  saveState(state);
}

function protectSb(state, file) {
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
  const f = path.join(PATCH_DATA, 'layout.toc');
  const m = new Map();
  if (!fs.existsSync(f)) return m;
  for (const s of L.readToc(f).superBundles || []) m.set(s.name.toLowerCase(), Object.keys(s).filter((k) => k !== 'name').join('+'));
  return m;
}

const tocCache = new Map(); // file -> parsed toc (lossless)
const dirty = new Set();
function toc(file) { if (!tocCache.has(file)) tocCache.set(file, R.readTocFile(file)); return tocCache.get(file); }

function findTocChunk(guid) {
  for (const f of [...walkToc(PATCH_DATA), ...walkToc(L.DATA_DIR)]) {
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
  }).filter((m) => ['chunk', 'ebx', 'res'].includes(m.kind));
}

function apply() {
  const mods = collectMods();
  if (!mods.length) { console.log('No mods found in', MODS); return; }
  if (!DRY && !restore({ quiet: true })) { console.error('Previous patch could not be restored cleanly; stopping.'); process.exit(1); }
  const state = loadState();
  const layout = patchLayout();
  let index = null;
  const getIndex = () => index || (index = L.loadIndex());
  const plan = [];                 // human-readable actions
  const bundleJobs = new Map();    // key sb|bundleId -> { sbFile, bundleId, repl: Map(name -> raw) }

  for (const m of mods) {
    const raw = fs.readFileSync(m.file);
    if (m.kind === 'chunk') {
      const hit = findTocChunk(m.name);
      if (hit) {
        const keys = hit.entry.v.map((n) => n.name.toString('latin1')).sort().join(',');
        if (keys !== 'id,offset,size') throw new Error(`chunk ${m.name}: unexpected toc fields (${keys}), refusing`);
        plan.push({ m, where: rel(hit.tocFile), hit, raw });
        continue;
      }
    }
    const hits = getIndex().filter((e) => e.kind === m.kind && e.name.toLowerCase() === m.name);
    if (!hits.length) throw new Error(`${m.kind} "${m.name}" not found in the game (check the name, or rebuild the index)`);
    for (const e of hits) {
      const key = e.sb + '|' + e.bundle;
      if (!bundleJobs.has(key)) bundleJobs.set(key, { sbFile: path.join(L.DATA_DIR, e.sb), sbRel: e.sb, bundleId: e.bundle, repl: new Map() });
      bundleJobs.get(key).repl.set(m.kind + ':' + m.name, raw);
    }
  }

  // check bundles against the official patch before writing anything
  for (const job of bundleJobs.values()) {
    const superName = job.sbRel.replace(/\.sb$/i, '').split(/[\\/]/).join('/').toLowerCase();
    job.flag = layout.get(superName) || '';
    if (job.flag.includes('delta')) {
      const pf = path.join(PATCH_DATA, job.sbRel.replace(/\.sb$/i, '.toc'));
      const pe = fs.existsSync(pf) && R.tocBundles(toc(pf)).find((b) => R.entryId(b).toLowerCase() === job.bundleId.toLowerCase());
      if (pe && R.entryFlag(pe, 'delta')) throw new Error(`bundle ${job.bundleId} is replaced by an official patch delta bundle — not supported yet`);
      if (pe) job.patchToc = pf;
    }
  }

  console.log(`${DRY ? 'Plan (dry run)' : 'Applying'}: ${plan.length} toc chunk(s), ${bundleJobs.size} bundle(s)`);
  for (const p of plan) console.log(`  chunk ${p.m.name} -> ${p.where}`);
  for (const j of bundleJobs.values()) console.log(`  bundle ${j.bundleId} (${j.sbRel}${j.patchToc ? ', also patch toc' : ''}) <- ${[...j.repl.keys()].join(', ')}`);
  if (DRY) return;

  // 1) chunks listed directly in a .toc
  for (const p of plan) {
    const e = p.hit.entry;
    const offN = R.child(e, 'offset'), sizeN = R.child(e, 'size');
    const origSize = R.numOf(sizeN);
    const orig = readAt(p.hit.sbFile, R.numOf(offN), Math.min(64, origSize));
    const stored = R.isBlockFramed(orig, origSize) ? R.packBlocks(p.raw) : p.raw; // keep the original storage style
    protectToc(state, p.hit.tocFile); protectSb(state, p.hit.sbFile);
    const off = R.appendToSb(p.hit.sbFile, stored);
    R.setNum(offN, off); R.setNum(sizeN, stored.length);
    dirty.add(p.hit.tocFile);
  }

  // 2) bundles: rebuild with replaced entries, append, repoint the .toc entries
  for (const job of bundleJobs.values()) {
    const baseToc = job.sbFile.replace(/\.sb$/i, '.toc');
    const be = R.tocBundles(toc(baseToc)).find((b) => R.entryId(b) === job.bundleId);
    if (!be) throw new Error('bundle not found in ' + rel(baseToc) + ': ' + job.bundleId);
    const off = R.numOf(R.child(be, 'offset')), size = R.numOf(R.child(be, 'size'));
    const fd = fs.openSync(job.sbFile, 'r');
    const info = L.readBundle(fd, off, size);
    const replacements = new Map();
    info.entries.forEach((e, i) => { const r = job.repl.get(e.kind + ':' + e.name.toLowerCase()); if (r) replacements.set(i, r); });
    if (replacements.size !== job.repl.size) { fs.closeSync(fd); throw new Error('could not locate every asset inside ' + job.bundleId); }
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
  console.log(`Done. Modified ${dirty.size} toc file(s). Undo with: node fb2_patch.js --game "<game dir>" restore`);
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

if (cmd === 'apply') apply();
else if (cmd === 'restore') { const ok = restore(); process.exit(ok ? 0 : 1); }
else if (cmd === 'status') status();
else console.log('Commands: apply [--mods <dir>] [--dry-run] | restore | status   (shared option: --game <game dir>)');
