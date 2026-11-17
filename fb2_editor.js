'use strict';
/*
 * fb2_editor.js — asset browser/editor for Need for Speed: The Run (PC) that runs in your web browser.
 *
 *   node fb2_editor.js [--game "<game dir>"] [--port 8777]     then open http://localhost:8777
 *   (or double-click editor.bat)
 *
 * A small local web server: it listens on 127.0.0.1 only (this computer), reads the game files (never writes them)
 * and serves the page in editor/index.html. No third-party libraries.
 *
 * API (JSON unless noted):
 *   GET /api/info                      game folder, number of assets
 *   GET /api/list?dir=<folder>         sub-folders and assets in a folder of the asset tree
 *   GET /api/search?q=<words>          assets whose name contains every word (max 300)
 *   GET /api/ebx?name=<ebx>            all instances and field values, as the game sees them (official patch applied)
 *   GET /api/texture?name=<texture>    texture size and format
 *   GET /api/texture.png?name=<texture>[&alpha=0]  the texture as PNG (image/png); alpha=0 drops transparency
 *   GET /api/texture.png?name=<texture>&modded=1   the texture as it will look in the game with your PNG (after DXT compression)
 *   POST /api/texture/replace?name=<texture>  (body: PNG file)   replace a texture with your picture
 *   POST /api/texture/remove {name}    undo a texture replacement
 *   GET /api/texts?q=<words or id>     texts the player sees (all languages), max 300, with your edits
 *   POST /api/text/set {id, value}     change a text (any length; in every installed language)
 *   POST /api/text/unset {id}          undo a text change
 *   GET /api/project                   the edits so far (and the mod.json they make)
 *   POST /api/set {asset, instance, path, value}   change a value (checked, then kept in the project)
 *   POST /api/unset {asset, instance, path}        undo one value change
 *   POST /api/list/remove {asset, instance, path: "<list>.<n>"}   remove a list item
 *   POST /api/list/append {asset, instance, path: "<list>"}       add an item (a copy of the last one)
 *   POST /api/undo {id}                undo any change of the project
 *   POST /api/object/duplicate {asset, instance}   add a copy of an object (new GUID)
 *   POST /api/object/delete {asset, instance}      remove an object
 *   GET /api/assets?q=<words>          ebx names for the reference picker
 *   POST /api/save {name, version, author, description, install}  write my_mods/<name>.nfsmod (and install it)
 *   POST /api/project/clear            remove all changes
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('--port', 8777));

let GAME;
try { GAME = require('./fb2_game.js').findGame({ arg: opt('--game', null), ask: true }); } // registry, usual folders, or a folder picker
catch (err) { console.error(err.message); process.exit(1); }
process.argv = [process.argv[0], process.argv[1], '--game', GAME, '--out', path.join(__dirname, 'output')]; // the modules read their options here
const L = require('./fb2_extract.js');
const F = require('./fb2_ebx_fields.js');
const E = require('./fb2_ebx_edit.js');
const T = require('./fb2_texture.js');
const TI = require('./fb2_tex_import.js');
const crypto = require('crypto');
const LOC = require('./fb2_loc.js');
const W = require('./fb2_ebx_write.js');

// ---------------------------------------------------------------- asset lists (built once at start)
if (!fs.existsSync(L.INDEX_FILE)) { console.log('Building the asset index (first run only, a few minutes)...'); L.buildIndex(); }
console.log('Loading the asset index...');
const index = L.loadIndex();
const assets = new Map(); // lower-case name -> { name, kind: 'ebx' | 'texture' }
for (const e of index) {
  const kind = e.kind === 'ebx' ? 'ebx' : e.kind === 'res' && e.extra === T.TEXTURE_RES_TYPE ? 'texture' : null;
  if (!kind) continue;
  const key = kind + ':' + e.name.toLowerCase();
  if (!assets.has(key)) assets.set(key, { name: e.name, kind, entry: e });
}
const sorted = [...assets.values()].sort((a, b) => a.name.localeCompare(b.name));
let chunksReady = false;
const ensureChunks = () => { if (!chunksReady) { T.loadChunkMap(index); chunksReady = true; } };
console.log(`${sorted.filter((a) => a.kind === 'ebx').length} ebx, ${sorted.filter((a) => a.kind === 'texture').length} textures`);

// ---------------------------------------------------------------- references between ebx files
// Every ebx has a file GUID (header offset 0x30). A reference to another file stores that GUID in the import table
// (header: import count at 0x0c, table at 0x40, 32 bytes per import, file GUID in the second half).
// One pass over all ebx (a few seconds): GUID -> name, and for each file the list of files that use it.
console.log('Mapping references between assets...');
const guidName = new Map();   // file guid -> ebx name
const usedBy = new Map();     // file guid -> Set(names of ebx that import it)
const nameGuid = new Map();   // lower-case ebx name -> file guid
const importedObjects = new Map(); // object guid -> Set(names of ebx files that reference it)
{
  const fds = new Map();
  const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  for (const a of sorted) {
    if (a.kind !== 'ebx') continue;
    const b = L.readAsset(fdOf(a.entry.sb), a.entry);
    guidName.set(b.toString('hex', 0x30, 0x40), a.name);
    nameGuid.set(a.name.toLowerCase(), b.toString('hex', 0x30, 0x40));
    const n = b.readUInt32LE(0x0c);
    for (let i = 0; i < n; i++) {
      const g = b.toString('hex', 0x50 + i * 32, 0x60 + i * 32); // imports from 0x50: [file GUID][object GUID]
      if (!usedBy.has(g)) usedBy.set(g, new Set());
      usedBy.get(g).add(a.name);
      const og = b.toString('hex', 0x60 + i * 32, 0x70 + i * 32);
      if (!importedObjects.has(og)) importedObjects.set(og, new Set());
      importedObjects.get(og).add(a.name);
    }
  }
  for (const fd of fds.values()) fs.closeSync(fd);
}

// ---------------------------------------------------------------- API
function list(dir) {
  const prefix = dir ? dir.toLowerCase().replace(/\/$/, '') + '/' : '';
  const dirs = new Map(), files = [];
  for (const a of sorted) {
    const n = a.name.toLowerCase();
    if (!n.startsWith(prefix)) continue;
    const rest = a.name.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) files.push({ name: a.name, kind: a.kind });
    else { const d = rest.slice(0, slash); dirs.set(d.toLowerCase(), { name: d, count: (dirs.get(d.toLowerCase())?.count || 0) + 1 }); }
  }
  return { dir: prefix.replace(/\/$/, ''), dirs: [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name)), files };
}

function search(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], more: false };
  const out = [];
  for (const a of sorted) {
    const n = a.name.toLowerCase();
    if (words.every((w) => n.includes(w))) { out.push({ name: a.name, kind: a.kind }); if (out.length > 300) break; }
  }
  return { results: out.slice(0, 300), more: out.length > 300 };
}

// bundles that contain an asset: tells which car / level / menu it belongs to
function bundlesOf(kind, name) {
  const n = name.toLowerCase(), k = kind === 'texture' ? 'res' : kind, out = new Set();
  for (const e of index) if (e.kind === k && e.name.toLowerCase() === n) out.add(e.bundle);
  return [...out].sort();
}

// ---------------------------------------------------------------- project: the edits that will become a mod
// Saved after every change to output/editor_project.json, so closing the editor loses nothing.
const PROJECT_FILE = path.join(__dirname, 'output', 'editor_project.json');
let project = { name: 'My Mod', version: '1.0.0', author: '', description: '', changes: [], textures: [], texts: [] };
const FILES_DIR = path.join(__dirname, 'output', 'editor_files'); // PNGs added to the project
try { project = { ...project, ...JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8')) }; } catch { /* new project */ }
if (!Array.isArray(project.textures)) project.textures = [];
if (!Array.isArray(project.texts)) project.texts = [];
const saveProject = () => { fs.mkdirSync(path.dirname(PROJECT_FILE), { recursive: true }); fs.writeFileSync(PROJECT_FILE, JSON.stringify(project, null, 1)); };

const baseCache = new Map(); // ebx name -> { data, source } as the game sees it (no edits)
function baseEbx(name) {
  const k = name.toLowerCase();
  if (!baseCache.has(k)) { if (baseCache.size > 50) baseCache.clear(); baseCache.set(k, E.readAsGameSees(index, name)); }
  return baseCache.get(k);
}
// A project change is one operation on one object of an ebx, applied in the order they were made:
//   { id, op: 'set',    asset, object, type, path, value, original }
//   { id, op: 'remove', asset, object, type, path: "<list>.<n>", original }
//   { id, op: 'append', asset, object, type, path: "<list>", value }
//   { id, op: 'duplicate', asset, object (the original), guid (the copy), type }
//   { id, op: 'delete', asset, object, type }
// Objects are found by GUID: their numbers shift when objects are added or removed.
// (Older projects stored "instance" numbers; those still work while no object was added/removed before them.)
// Values are in mod.json form (references to other assets as { ref, object }).

// reference to another asset by name -> its file GUID and object (main object unless given)
function refTo(name, object) {
  const g = nameGuid.get(String(name).toLowerCase());
  if (!g) throw new Error('no ebx asset named ' + name);
  const p = F.parse(baseEbx(name).data);
  const inst = object ? String(object).toLowerCase() : p.primaryGuid;
  if (!p.instances.some((x) => x.guid === inst)) throw new Error(`${name} has no object ${object}`);
  return { file: g, instance: inst };
}
// in mod.json, references to other files are written by name, not by the file's own import number
function portable(doc, v) {
  if (Array.isArray(v)) return v.map((x) => portable(doc, x));
  if (v && typeof v === 'object') {
    if ('$import' in v) { const im = doc.imports[v.$import]; const n = im && guidName.get(im.file); if (!n) throw new Error('reference to an unknown file'); return { ref: n, object: im.instance }; }
    const o = {}; for (const [k, x] of Object.entries(v)) if (k[0] !== '@' && k[0] !== '%') o[k] = portable(doc, x); return o;
  }
  return v;
}

const objOf = (doc, c) => {
  const n = c.object ? W.objectIndex(doc, c.object) : c.instance;
  if (n < 0 || !doc.instances[n]) throw new Error('the object of a change is missing (' + (c.object || '#' + c.instance) + ')');
  return n;
};
function applyChange(doc, c0) {
  const op = c0.op || 'set';
  if (op === 'duplicate') { W.addObject(doc, objOf(doc, c0), c0.guid); return; }
  if (op === 'delete') { W.deleteObject(doc, objOf(doc, c0)); return; }
  const c = { ...c0, instance: objOf(doc, c0) };
  if (op === 'set') {
    const t = W.locate(doc, c.instance, c.path);
    t.holder[t.key] = t.f.kind === 'array' ? W.convertArray(doc, t.f, c.value, refTo) : W.convert(doc, t.f, c.value, refTo);
  } else if (op === 'remove') {
    const m = c.path.match(/^(.*)\.(\d+)$/);
    const t = W.locate(doc, c.instance, m[1]);
    const list = t.holder[t.key];
    if (t.f.kind !== 'array' || Number(m[2]) >= list.length) throw new Error(c.path + ': no such list item');
    list.splice(Number(m[2]), 1);
  } else if (op === 'append') {
    const t = W.locate(doc, c.instance, c.path);
    if (t.f.kind !== 'array') throw new Error(c.path + ' is not a list');
    const itemF = W.itemFieldOf(doc, t.f);
    t.holder[t.key].push(itemF.kind === 'array' ? W.convertArray(doc, itemF, c.value, refTo) : W.convert(doc, itemF, c.value, refTo));
  }
}

// the ebx with every project change applied; written and read back, so the view shows exactly what the game gets
function editedEbx(name) {
  const base = baseEbx(name);
  const doc = W.decode(base.data);
  for (const c of project.changes.filter((x) => x.asset === name.toLowerCase())) applyChange(doc, c);
  const buf = W.encode(doc);
  return { doc, buf, p: F.parse(buf), source: base.source, base: W.decode(base.data) };
}

// How a mod finds the object again: by a unique Name/Label/Id text if it has one (survives game updates better than a number)
function whereFor(doc, i) {
  const v = doc.instances[i].value;
  for (const k of ['Name', 'Label', 'Id', 'ID']) {
    if (typeof v[k] !== 'string' || !v[k]) continue;
    const same = doc.instances.filter((x) => x.value.$type === v.$type && x.value[k] === v[k]).length;
    if (same === 1) return { $type: v.$type, [k]: v[k] };
  }
  return null;
}

// value from the page -> mod.json value for this field (numbers typed as text become numbers)
function fromPage(f, v) {
  if (/^(u?int(8|16|32)|float|double)$/.test(f.kind) && typeof v === 'string') { const n = Number(v.trim()); if (v.trim() === '' || !Number.isFinite(n)) throw new Error('not a number: ' + v); return n; }
  if (/^u?int64$/.test(f.kind) && typeof v === 'string') return String(BigInt(v.trim()));
  if (f.kind === 'bool' && typeof v === 'string') return /^(true|1)$/i.test(v);
  return v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let nextId = Date.now();
const newChange = (cur, asset, inst, extra) => ({ id: String(nextId++), asset, object: cur.doc.instances[inst].guid, type: cur.doc.instances[inst].value.$type, label: whereLabel(cur.doc.instances[inst].value), ...extra });
const whereLabel = (v) => { for (const k of ['Name', 'Label', 'Id', 'ID']) if (typeof v[k] === 'string' && v[k]) return v[k]; return ''; };
const sameObject = (c, cur, asset, inst) => c.asset === asset && (c.object ? c.object === cur.doc.instances[inst].guid : c.instance === inst);

function setValue(name, inst, fieldPath, raw) {
  const asset = name.toLowerCase();
  const cur = editedEbx(name);
  const t = W.locate(cur.doc, inst, fieldPath);
  if (t.f.kind === 'array' || t.f.kind === 'struct') throw new Error('change the items of a list or the fields of a group one by one');
  const value = fromPage(t.f, raw);
  const now = portable(cur.doc, t.holder[t.key]);
  // check it can be written: apply to a copy and encode
  const test = W.decode(cur.buf);
  applyChange(test, { op: 'set', instance: inst, path: fieldPath, value });
  F.parse(W.encode(test));
  // a value set before (and not followed by list changes on this file) is updated in place
  const prev = project.changes.findIndex((c) => (c.op || 'set') === 'set' && sameObject(c, cur, asset, inst) && c.path === fieldPath);
  const listAfter = prev >= 0 && project.changes.slice(prev + 1).some((c) => c.asset === asset && c.op !== 'set');
  if (prev >= 0 && !listAfter) {
    if (same(project.changes[prev].original, value)) project.changes.splice(prev, 1); // back to where it was
    else project.changes[prev].value = value;
  } else if (!same(now, value)) {
    project.changes.push(newChange(cur, asset, inst, { op: 'set', path: fieldPath, value, original: now }));
  }
  saveProject();
  return { changes: project.changes.length };
}

function listRemove(name, inst, itemPath) {
  const asset = name.toLowerCase();
  const cur = editedEbx(name);
  const m = String(itemPath).match(/^(.*)\.(\d+)$/);
  if (!m) throw new Error('not a list item: ' + itemPath);
  const t = W.locate(cur.doc, inst, m[1]);
  if (t.f.kind !== 'array' || Number(m[2]) >= t.holder[t.key].length) throw new Error('no such list item: ' + itemPath);
  project.changes.push(newChange(cur, asset, inst, { op: 'remove', path: itemPath, original: portable(cur.doc, t.holder[t.key][Number(m[2])]) }));
  saveProject();
  return { changes: project.changes.length };
}
// a new item: a copy of the last one, or an empty item for an empty list
function listAppend(name, inst, listPath) {
  const asset = name.toLowerCase();
  const cur = editedEbx(name);
  const t = W.locate(cur.doc, inst, listPath);
  if (t.f.kind !== 'array') throw new Error(listPath + ' is not a list');
  const list = t.holder[t.key], itemF = W.itemFieldOf(cur.doc, t.f);
  const value = list.length ? portable(cur.doc, list[list.length - 1]) : portable(cur.doc, W.defaultFor(cur.doc, itemF));
  project.changes.push(newChange(cur, asset, inst, { op: 'append', path: listPath, value }));
  saveProject();
  return { changes: project.changes.length };
}

function duplicateObject(name, inst) {
  const asset = name.toLowerCase();
  const cur = editedEbx(name);
  if (!cur.doc.instances[inst]) throw new Error('no object #' + inst);
  const guid = crypto.randomBytes(16).toString('hex');
  project.changes.push(newChange(cur, asset, inst, { op: 'duplicate', guid }));
  saveProject();
  return { changes: project.changes.length, guid };
}
function deleteObjectChange(name, inst) {
  const asset = name.toLowerCase();
  const cur = editedEbx(name);
  const x = cur.doc.instances[inst];
  if (!x) throw new Error('no object #' + inst);
  if (x.guid === cur.doc.primaryGuid) throw new Error('the main object of a file cannot be removed');
  const outside = [...(importedObjects.get(x.guid) || [])];
  project.changes.push(newChange(cur, asset, inst, { op: 'delete' }));
  try { editedEbx(name); } catch (err) { project.changes.pop(); throw err; }
  saveProject();
  return { changes: project.changes.length, usedOutside: outside.length };
}

// undo: a value change can always be undone; a list change only if it is the latest change of that file
function undoChange(id) {
  const i = project.changes.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('change not found');
  const c = project.changes[i];
  if ((c.op || 'set') !== 'set' && project.changes.slice(i + 1).some((x) => x.asset === c.asset)) throw new Error('undo the later changes of this file first');
  project.changes.splice(i, 1);
  try { if (project.changes.some((x) => x.asset === c.asset)) editedEbx(c.asset); } // the remaining changes must still apply
  catch (err) { project.changes.splice(i, 0, c); throw new Error('cannot undo this one: a later change depends on it (' + err.message + ')'); }
  saveProject();
  return { changes: project.changes.length };
}
function unsetValue(name, inst, fieldPath) {
  const c = project.changes.find((x) => (x.op || 'set') === 'set' && x.asset === name.toLowerCase() && x.instance === inst && x.path === fieldPath);
  if (!c) return { changes: project.changes.length };
  return undoChange(c.id);
}
// older projects: give every change an id and an op
for (const c of project.changes) { if (!c.id) c.id = String(nextId++); if (!c.op) c.op = 'set'; }

// mod.json from the project: edits of the same object are grouped into one "ebx" change
const modPngName = (t) => t.asset.split('/').pop() + '.png';
function modJson(meta) {
  const out = [];
  let last = null;
  for (const c of project.changes) {
    const sel = c.object ? { object: c.object } : { instance: c.instance }; // objects by GUID: stable when objects are added or removed
    const key = c.asset + '|' + (c.object || c.instance);
    const op = c.op || 'set';
    if (op === 'duplicate' || op === 'delete') { out.push({ type: 'ebx', asset: c.asset, ...sel, ...(op === 'delete' ? { delete: true } : { duplicate: { guid: c.guid } }) }); last = null; continue; }
    if (op === 'set' && last && last.key === key && last.change.set) { last.change.set[c.path] = c.value; continue; }
    const change = { type: 'ebx', asset: c.asset, ...sel };
    if (op === 'set') change.set = { [c.path]: c.value };
    else if (op === 'remove') change.remove = [c.path];
    else change.append = { [c.path]: c.value };
    out.push(change);
    last = op === 'set' ? { key, change } : null;
  }
  const tex = project.textures.map((t) => ({ type: 'texture', asset: t.asset, png: 'textures/' + modPngName(t) }));
  tex.push(...project.texts.map((t) => ({ type: 'text', id: t.id, value: t.value })));
  return { format: 1, name: meta.name, version: meta.version || '1.0.0', author: meta.author || '', description: meta.description || '', changes: [...out, ...tex] };
}

function saveMod(meta, install) {
  if (!meta.name || !meta.name.trim()) throw new Error('give the mod a name');
  if (!project.changes.length && !project.textures.length && !project.texts.length) throw new Error('the project has no changes yet');
  Object.assign(project, { name: meta.name.trim(), version: meta.version || '1.0.0', author: meta.author || '', description: meta.description || '' });
  saveProject();
  const M = require('./fb2_mods.js');
  const Z = require('./fb2_zip.js');
  const mod = M.validateMod(modJson(project), 'editor');
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mod';
  const outDir = path.join(__dirname, 'my_mods');
  const folder = path.join(outDir, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.rmSync(folder, { recursive: true, force: true }); // a fresh folder: no PNGs left over from an older save
  fs.mkdirSync(path.join(folder, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'mod.json'), JSON.stringify(mod, null, 2) + '\n');
  const files = [{ name: 'mod.json', data: fs.readFileSync(path.join(folder, 'mod.json')) }];
  for (const t of project.textures) {
    const data = fs.readFileSync(path.join(FILES_DIR, t.file));
    fs.writeFileSync(path.join(folder, 'textures', modPngName(t)), data);
    files.push({ name: 'textures/' + modPngName(t), data });
  }
  const file = path.join(outDir, `${slug}-${mod.version}.nfsmod`);
  fs.writeFileSync(file, Z.writeZip(files));
  if (install) M.install(folder);
  return { file, folder, installed: install, id: slug };
}

// ---------------------------------------------------------------- texts the player sees (localization)
const locCache = new Map(); // language -> table as the game sees it (no edits)
const locOf = (lang) => { if (!locCache.has(lang)) locCache.set(lang, LOC.readLoc(lang)); return locCache.get(lang); };

function searchTexts(query) {
  const langs = LOC.languages();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const edited = new Map(project.texts.map((t) => [t.id, t.value]));
  const results = [];
  const first = locOf(langs[0]);
  const byLang = langs.map((l) => new Map(locOf(l).strings.map((y) => [y.id, y.text]))); // id -> text, per language
  for (const x of first.strings) {
    const id = LOC.hexId(x.id);
    const texts = Object.fromEntries(langs.map((l, i) => [l, byLang[i].get(x.id)]));
    const now = edited.has(id) ? edited.get(id) : null;
    const hay = (id + ' ' + Object.values(texts).join(' ') + ' ' + (now || '')).toLowerCase();
    if (words.length ? words.every((w) => hay.includes(w)) : now !== null) {
      results.push({ id, texts, edited: now });
      if (results.length > 300) break;
    }
  }
  return { languages: langs, total: first.strings.length, results: results.slice(0, 300), more: results.length > 300 };
}

function setText(id, value) {
  const tid = LOC.parseId(id), hex = LOC.hexId(tid);
  for (const lang of LOC.languages()) {
    const loc = locOf(lang);
    const x = loc.strings.find((y) => y.id === tid);
    if (!x) throw new Error(`text ${hex} does not exist in ${lang}`);
    // check that it can be stored (a copy of the character table, so a failed check changes nothing)
    LOC.encodeText(value, { ...loc, table: [...loc.table], slotOf: undefined });
  }
  const original = locOf(LOC.languages()[0]).strings.find((y) => y.id === tid).text;
  project.texts = project.texts.filter((t) => t.id !== hex);
  if (value !== original) project.texts.push({ id: hex, value, original });
  saveProject();
  return { ok: true };
}
function unsetText(id) {
  const hex = LOC.hexId(LOC.parseId(id));
  project.texts = project.texts.filter((t) => t.id !== hex);
  saveProject();
  return { ok: true };
}

function ebx(name) {
  const cur = editedEbx(name);
  const p = cur.p, data = cur.buf, source = cur.source;
  const edits = {}, lists = {};
  const created = new Set();
  for (const c of project.changes.filter((x) => x.asset === name.toLowerCase())) {
    if (c.op === 'duplicate') { created.add(c.guid); continue; }
    if (c.op === 'delete') continue;
    const n = c.object ? W.objectIndex(cur.doc, c.object) : c.instance;
    if (n < 0) continue; // its object was deleted later
    if ((c.op || 'set') === 'set') edits[`${n}.${c.path}`] = { original: c.original, id: c.id };
    else { const lp = c.op === 'remove' ? c.path.replace(/\.\d+$/, '') : c.path; lists[`${n}.${lp}`] = (lists[`${n}.${lp}`] || 0) + 1; }
  }
  // enum choices for the drop-down lists: complex index -> option names
  const enums = {};
  const scan = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k[0] === '%' && typeof x === 'string' && x.startsWith('enum:')) {
        const ref = Number(x.slice(5)), c = p.cx[ref];
        if (c && !enums[ref]) enums[ref] = p.fields.slice(c.first, c.first + c.n).map((f) => f.name);
      } else if (typeof x === 'object') scan(x);
    }
  };
  p.instances.forEach((i) => scan(i.value));
  const users = [...(usedBy.get(p.guid) || [])].sort();
  return { name, source, guid: p.guid, primaryGuid: p.primaryGuid, enums, size: data.length, edits, lists,
    imports: p.imports.map((i) => ({ ...i, name: guidName.get(i.file) || null })), usedBy: users.slice(0, 500), usedByCount: users.length,
    bundles: bundlesOf('ebx', name), instances: p.instances.map((i, n) => ({ index: n, guid: i.guid, value: i.value, isNew: created.has(i.guid), usedOutside: (importedObjects.get(i.guid) || new Set()).size })) };
}

function textureEntry(name) {
  const a = assets.get('texture:' + name.toLowerCase());
  if (!a) throw new Error('texture not found: ' + name);
  return a.entry;
}
function texture(name) {
  ensureChunks();
  const e = textureEntry(name);
  const fd = fs.openSync(path.join(L.DATA_DIR, e.sb), 'r');
  const hdr = T.parseTextureHeader(L.readAsset(fd, e));
  fs.closeSync(fd);
  const rep = project.textures.find((t) => t.asset === name.toLowerCase());
  return { name, width: hdr.width, height: hdr.height, format: hdr.format, bytesPerPixel: hdr.mip0Size / (hdr.width * hdr.height), bundles: bundlesOf('texture', name),
    importable: hdr.format === 0 || hdr.format === 2,
    // the TextureAsset ebx with the same name, and the files that use it (materials, cars, ...)
    ebx: nameGuid.has(name.toLowerCase()) ? guidName.get(nameGuid.get(name.toLowerCase())) : null,
    usedBy: [...(usedBy.get(nameGuid.get(name.toLowerCase())) || [])].sort().slice(0, 500),
    usedByCount: (usedBy.get(nameGuid.get(name.toLowerCase())) || new Set()).size, replaced: rep ? { original: rep.original, w: rep.w, h: rep.h } : null };
}
// header bytes of a texture (size, format, mip sizes): needed to build the replacement
function textureHeader(name) {
  const e = textureEntry(name);
  const fd = fs.openSync(path.join(L.DATA_DIR, e.sb), 'r');
  try { return L.readAsset(fd, e); } finally { fs.closeSync(fd); }
}
// the replacement as the game will get it: resized, mip-mapped and DXT-compressed (cached, encoding takes a moment)
const builtCache = new Map();
function builtTexture(name) {
  const t = project.textures.find((x) => x.asset === name.toLowerCase());
  if (!t) return null;
  const key = t.asset + '|' + t.file;
  if (!builtCache.has(key)) { if (builtCache.size > 8) builtCache.clear(); builtCache.set(key, TI.buildTextureChunk(textureHeader(name), TI.readPng(path.join(FILES_DIR, t.file)))); }
  return builtCache.get(key);
}

function replaceTexture(name, png) {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('this is not a PNG file');
  const asset = textureEntry(name).name.toLowerCase();
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const file = crypto.createHash('sha1').update(png).digest('hex').slice(0, 16) + '.png';
  fs.writeFileSync(path.join(FILES_DIR, file), png);
  const img = TI.readPng(path.join(FILES_DIR, file)); // throws for unsupported PNG variants
  TI.buildTextureChunk(textureHeader(name), img);       // throws for unsupported texture formats
  project.textures = project.textures.filter((t) => t.asset !== asset);
  project.textures.push({ asset, file, w: img.w, h: img.h, original: 'png' });
  saveProject();
  return { ok: true, w: img.w, h: img.h };
}
function removeTexture(name) {
  project.textures = project.textures.filter((t) => t.asset !== name.toLowerCase());
  saveProject();
  return { ok: true };
}

function texturePng(name, alpha, modded) {
  ensureChunks();
  if (modded) {
    const b = builtTexture(name);
    if (!b) throw new Error('this texture is not replaced');
    return T.encodePng(T.decodeDXT(b.data, b.w, b.h, b.kind), b.w, b.h, !alpha); // decode the first mip level we built
  }
  const r = T.decodeTexture(textureEntry(name));
  if (r.error) throw new Error(r.error);
  return T.encodePng(r.rgba, r.hdr.width, r.hdr.height, !alpha); // opaque = drop the alpha channel
}

// ---------------------------------------------------------------- web server
const PAGE = path.join(__dirname, 'editor', 'index.html');
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const json = (res, obj, code = 200) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

// requests that change something are POST with a JSON body
const readBody = (req) => new Promise((ok, bad) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 1e6) { bad(new Error('request too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});

const readRaw = (req, limit) => new Promise((ok, bad) => {
  const parts = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > limit) { bad(new Error('file too large')); req.destroy(); } else parts.push(d); });
  req.on('end', () => ok(Buffer.concat(parts)));
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = (k) => u.searchParams.get(k) || '';
  try {
    if (req.method === 'POST') {
      // accept only requests from the editor page itself (a web site in another tab cannot send them)
      // (other sites can only send "simple" requests without a preflight; JSON and PNG bodies need one, and we never allow it)
      const ctype = req.headers['content-type'];
      if (!['application/json', 'image/png'].includes(ctype) || (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin))) return json(res, { error: 'forbidden' }, 403);
      if (ctype === 'image/png') {
        if (u.pathname === '/api/texture/replace') return json(res, replaceTexture(q('name'), await readRaw(req, 64 << 20)));
        return json(res, { error: 'not found' }, 404);
      }
      const b = await readBody(req);
      if (u.pathname === '/api/set') return json(res, setValue(b.asset, Number(b.instance), b.path, b.value));
      if (u.pathname === '/api/list/remove') return json(res, listRemove(b.asset, Number(b.instance), b.path));
      if (u.pathname === '/api/list/append') return json(res, listAppend(b.asset, Number(b.instance), b.path));
      if (u.pathname === '/api/undo') return json(res, undoChange(String(b.id)));
      if (u.pathname === '/api/object/duplicate') return json(res, duplicateObject(b.asset, Number(b.instance)));
      if (u.pathname === '/api/object/delete') return json(res, deleteObjectChange(b.asset, Number(b.instance)));
      if (u.pathname === '/api/unset') return json(res, unsetValue(b.asset, Number(b.instance), b.path));
      if (u.pathname === '/api/save') return json(res, saveMod(b, !!b.install));
      if (u.pathname === '/api/texture/remove') return json(res, removeTexture(String(b.name)));
      if (u.pathname === '/api/text/set') return json(res, setText(String(b.id), String(b.value)));
      if (u.pathname === '/api/text/unset') return json(res, unsetText(String(b.id)));
      if (u.pathname === '/api/project/clear') { project.changes = []; project.textures = []; project.texts = []; saveProject(); return json(res, { changes: 0 }); }
      return json(res, { error: 'not found' }, 404);
    }
    if (u.pathname === '/api/project') return json(res, { ...project, modJson: modJson(project) });
    if (u.pathname === '/api/texts') return json(res, searchTexts(q('q')));
    if (u.pathname === '/api/assets') return json(res, { results: search(q('q')).results.filter((a) => a.kind === 'ebx').slice(0, 50).map((a) => a.name) });
    if (u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE)); // re-read: edits show up on reload
    if (u.pathname === '/api/info') return json(res, { game: GAME, ebx: sorted.filter((a) => a.kind === 'ebx').length, textures: sorted.filter((a) => a.kind === 'texture').length });
    if (u.pathname === '/api/list') return json(res, list(q('dir')));
    if (u.pathname === '/api/search') return json(res, search(q('q')));
    if (u.pathname === '/api/ebx') return json(res, ebx(q('name')));
    if (u.pathname === '/api/texture') return json(res, texture(q('name')));
    if (u.pathname === '/api/texture.png') return send(res, 200, 'image/png', texturePng(q('name'), q('alpha') !== '0', q('modded') === '1'));
    json(res, { error: 'not found' }, 404);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nEditor is running: ${url}\nKeep this window open while you use it; close it (or press Ctrl+C) to stop.`);
  if (!args.includes('--no-browser')) require('child_process').exec(`start "" ${url}`); // open the default browser (Windows)
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy: the editor may already be running (open http://localhost:${PORT}), or use --port 8778` : e.message); process.exit(1); });
