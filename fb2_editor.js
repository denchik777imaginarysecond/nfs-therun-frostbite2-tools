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
 *   GET /api/project                   the edits so far (and the mod.json they make)
 *   POST /api/set {asset, instance, path, value}   change a value (checked, then kept in the project)
 *   POST /api/unset {asset, instance, path}        undo one change
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
const CANDIDATES = [
  'C:\\Program Files (x86)\\Need For Speed The Run', 'C:\\Program Files\\Need For Speed The Run',
  'C:\\Program Files (x86)\\Origin Games\\Need for Speed The Run', 'C:\\Program Files\\Origin Games\\Need for Speed The Run',
  'C:\\Program Files (x86)\\EA Games\\Need for Speed The Run', 'C:\\Program Files\\EA Games\\Need for Speed The Run',
];
const GAME = opt('--game', null) || process.env.NFS_THE_RUN_DIR || CANDIDATES.find((d) => fs.existsSync(path.join(d, 'Data', 'Win32')));
if (!GAME) { console.error('Could not find Need for Speed: The Run. Use --game "<path to the game folder>"'); process.exit(1); }
process.argv = [process.argv[0], process.argv[1], '--game', GAME, '--out', path.join(__dirname, 'output')]; // the modules read their options here
const L = require('./fb2_extract.js');
const F = require('./fb2_ebx_fields.js');
const E = require('./fb2_ebx_edit.js');
const T = require('./fb2_texture.js');
const TI = require('./fb2_tex_import.js');
const crypto = require('crypto');

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
let project = { name: 'My Mod', version: '1.0.0', author: '', description: '', changes: [], textures: [] };
const FILES_DIR = path.join(__dirname, 'output', 'editor_files'); // PNGs added to the project
try { project = { ...project, ...JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8')) }; } catch { /* new project */ }
if (!Array.isArray(project.textures)) project.textures = [];
const saveProject = () => { fs.mkdirSync(path.dirname(PROJECT_FILE), { recursive: true }); fs.writeFileSync(PROJECT_FILE, JSON.stringify(project, null, 1)); };

const baseCache = new Map(); // ebx name -> { data, source } as the game sees it (no edits)
function baseEbx(name) {
  const k = name.toLowerCase();
  if (!baseCache.has(k)) { if (baseCache.size > 50) baseCache.clear(); baseCache.set(k, E.readAsGameSees(index, name)); }
  return baseCache.get(k);
}
// the ebx with every project edit applied
function editedEbx(name) {
  const base = baseEbx(name);
  const buf = Buffer.from(base.data);
  let p = F.parse(buf);
  for (const c of project.changes.filter((x) => x.asset === name.toLowerCase())) {
    const t = E.resolve(p, `${c.instance}.${c.path}`);
    E.writeValue(buf, p, t.at, t.kind, c.value === null ? 'null' : String(c.value));
    p = F.parse(buf);
  }
  return { buf, p, source: base.source, original: F.parse(base.data) };
}

// How a mod finds the object again: by a unique Name/Label/Id text if it has one (survives game updates better than a number)
function whereFor(p, i) {
  const v = p.instances[i].value;
  for (const k of ['Name', 'Label', 'Id', 'ID']) {
    if (typeof v[k] !== 'string' || !v[k]) continue;
    const same = p.instances.filter((x) => x.value.$type === v.$type && x.value[k] === v[k]).length;
    if (same === 1) return { $type: v.$type, [k]: v[k] };
  }
  return null;
}

// text from the page -> the JSON value stored in mod.json
function toValue(kind, text) {
  const k = kind.split(':')[0];
  if (k === 'bool') return /^(true|1)$/i.test(text);
  if (k === 'ref') return null;
  if (k === 'enum') return text;
  if (/^u?int64$/.test(k)) return String(BigInt(text));
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error('not a number: ' + text);
  return n;
}

function setValue(name, inst, fieldPath, text) {
  const asset = name.toLowerCase();
  const cur = editedEbx(name);
  const t = E.resolve(cur.p, `${inst}.${fieldPath}`);
  const k = t.kind.split(':')[0];
  if (k === 'cstring') throw new Error('text values cannot be edited yet');
  if (!/^(bool|u?int(8|16|32|64)|float|double|enum|ref)$/.test(k)) throw new Error(`values of type "${k}" cannot be edited yet`);
  const value = toValue(t.kind, text);
  // check that the value can really be written (range, enum name) before keeping it
  const test = Buffer.from(cur.buf);
  E.writeValue(test, cur.p, t.at, t.kind, value === null ? 'null' : String(value));
  F.parse(test);
  const orig = E.resolve(cur.original, `${inst}.${fieldPath}`).old;
  project.changes = project.changes.filter((c) => !(c.asset === asset && c.instance === inst && c.path === fieldPath));
  if (JSON.stringify(normal(orig)) !== JSON.stringify(normal(value))) {
    project.changes.push({ asset, instance: inst, where: whereFor(cur.original, inst), type: cur.original.instances[inst].value.$type, path: fieldPath, value, original: normal(orig) });
  }
  saveProject();
  return { changes: project.changes.length };
}
const normal = (v) => (typeof v === 'bigint' ? v.toString() : v && typeof v === 'object' ? '(reference)' : v); // a reference differs from null

function unsetValue(name, inst, fieldPath) {
  project.changes = project.changes.filter((c) => !(c.asset === name.toLowerCase() && c.instance === inst && c.path === fieldPath));
  saveProject();
  return { changes: project.changes.length };
}

// mod.json from the project: edits of the same object are grouped into one "ebx" change
const modPngName = (t) => t.asset.split('/').pop() + '.png';
function modJson(meta) {
  const groups = new Map();
  for (const c of project.changes) {
    const key = c.asset + '|' + c.instance;
    if (!groups.has(key)) groups.set(key, { type: 'ebx', asset: c.asset, ...(c.where ? { where: c.where } : { instance: c.instance }), set: {} });
    groups.get(key).set[c.path] = c.value;
  }
  const tex = project.textures.map((t) => ({ type: 'texture', asset: t.asset, png: 'textures/' + modPngName(t) }));
  return { format: 1, name: meta.name, version: meta.version || '1.0.0', author: meta.author || '', description: meta.description || '', changes: [...groups.values(), ...tex] };
}

function saveMod(meta, install) {
  if (!meta.name || !meta.name.trim()) throw new Error('give the mod a name');
  if (!project.changes.length && !project.textures.length) throw new Error('the project has no changes yet');
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

function ebx(name) {
  const cur = editedEbx(name);
  const p = cur.p, data = cur.buf, source = cur.source;
  const edits = {};
  for (const c of project.changes.filter((x) => x.asset === name.toLowerCase())) edits[`${c.instance}.${c.path}`] = { original: c.original };
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
  return { name, source, guid: p.guid, primaryGuid: p.primaryGuid, imports: p.imports, enums, size: data.length, edits,
    bundles: bundlesOf('ebx', name), instances: p.instances.map((i, n) => ({ index: n, guid: i.guid, value: i.value })) };
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
    importable: hdr.format === 0 || hdr.format === 2, replaced: rep ? { original: rep.original, w: rep.w, h: rep.h } : null };
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
      if (u.pathname === '/api/set') return json(res, setValue(b.asset, Number(b.instance), b.path, String(b.value)));
      if (u.pathname === '/api/unset') return json(res, unsetValue(b.asset, Number(b.instance), b.path));
      if (u.pathname === '/api/save') return json(res, saveMod(b, !!b.install));
      if (u.pathname === '/api/texture/remove') return json(res, removeTexture(String(b.name)));
      if (u.pathname === '/api/project/clear') { project.changes = []; project.textures = []; saveProject(); return json(res, { changes: 0 }); }
      return json(res, { error: 'not found' }, 404);
    }
    if (u.pathname === '/api/project') return json(res, { ...project, modJson: modJson(project) });
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
