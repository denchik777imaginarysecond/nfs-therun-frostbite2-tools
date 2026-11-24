'use strict';
/*
 * fb2_mods.js — mod manager for Need for Speed: The Run (PC).
 *
 * A mod is a .nfsmod file (a ZIP) or a folder with mod.json and optional PNG files. It holds no game files:
 * it describes changes, and the manager applies them to the player's own game.
 *
 *   node fb2_mods.js menu                      simple menu: switch mods on/off, remove, reorder, apply (manage_mods.bat)
 *   node fb2_mods.js list                      installed mods, load order, enabled state
 *   node fb2_mods.js install <file.nfsmod|folder>
 *   node fb2_mods.js enable <id> | disable <id> | remove <id>
 *   node fb2_mods.js check                     resolve every change against the game, report conflicts (writes nothing)
 *   node fb2_mods.js apply [--dry-run]         build all enabled mods into <game>/Update/Mods (administrator)
 *   node fb2_mods.js restore                   remove Update/Mods: the game runs with its original files (administrator)
 *   node fb2_mods.js new "<name>"              create a mod folder with a mod.json template
 *   node fb2_mods.js pack <folder> [out.nfsmod]
 * Options: --game "<game dir>" (found automatically: registry, usual folders, or you are asked once), --mods <dir> (default: ./mods)
 *
 * mod.json (format 1):
 *   { "format": 1, "name": "...", "version": "1.0.0", "author": "...", "description": "...",
 *     "changes": [
 *       { "type": "ebx", "asset": "<ebx name>", "where": { "<field>": <value>, ... } | "object": "<object GUID>" | "instance": <n>,
 *         "duplicate": { "guid": "<32 hex digits for the copy>", "set": { ... } },
 *         "delete": true,
 *         "remove": ["<list path>.<item number>", ...],
 *         "append": { "<list path>": <item> | [<items>] },
 *         "set": { "<field path>": <value>, ... } },
 *       { "type": "texture", "asset": "<texture name>", "png": "<file in the mod>", "size": <optional "png" or [width, height]> },
 *       { "type": "text", "id": "<8-hex text id>", "value": "<new text>", "lang": "<optional: ru, en, ...>" },
 *       { "type": "mesh", "asset": "<model name>", "glb": "<file in the mod>", "keepOtherLods": <optional true> },
 *       { "type": "file", "kind": "ebx|res|chunk", "name": "<asset name or chunk guid>", "path": "<file in the mod>" } ] }
 * "texture" keeps the texture's size and format unless "size" is given ("png" = the picture's own size); sizes are powers
 * of two from 4 to 4096. Formats: DXT1, DXT3, DXT5, BC4, BC5 and DXT5 normal maps, L8, BGRA8 (the texture keeps its own).
 * "mesh" replaces a 3D model with a .glb ("clearOthers": true hides the parts the .glb does not have, except "keepParts": [names]; "evenShade": true gives
 * new geometry an even light baked shade instead of the old shape's; "hide": true
 * without a .glb hides the whole model). Export one with: node fb2_mesh.js model <name>, edit it in Blender, export
 * as .glb. Objects "lod0", "lod1", ... replace those levels of detail; LODs without an object get lod0's. Parts are
 * matched by material name. The geometry is built on the player's PC from their own game and the .glb.
 * "text" changes a text the player sees (any length; find ids with: node fb2_loc.js find <words>, or in the editor).
 * Without "lang" it is changed in every installed language.
 * "where" picks the instance whose fields equal the given values (e.g. { "Label": "ID_MENU_DEBUG" } or { "$type": "..." }).
 * ebx edits run in this order: "duplicate" (a copy of the object, then its own "set"), "remove" (item numbers of the
 * original list), "append", "set". "delete": true removes the object (alone); references to it become null and list
 * items pointing to it are taken out. The main object of a file cannot be deleted.
 * { "object": "<GUID>" } as a value refers to an object of the same file (for example a copy made with "duplicate").
 * Paths: "Visibility.InvertValue", "Items.3.Name". Values: true/false, numbers, enum names, text, null,
 * a reference to another asset { "ref": "<ebx name>" } (its main object) or { "ref": "<ebx name>", "object": "<instance GUID>" },
 * or an object in the same file { "$instance": <n> }. A new list item that is an object only needs the fields you
 * want to set; the others start at zero/empty.
 * Mods are applied in load order (list); when two mods change the same value, the later one wins and a conflict is reported.
 * The game files are never changed: mods are written into an extra update package <game>/Update/Mods (a copy of the
 * official patch with the changes, and a higher version number), which the game loads instead of Update/Patch.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Z = require('./fb2_zip.js');

const TOOL = __dirname;
const OUT = path.join(TOOL, 'output');
const args = process.argv.slice(2);
const takeOpt = (f, d) => { const i = args.indexOf(f); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const takeFlag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const GAME_ARG = takeOpt('--game', null);
const MODS = path.resolve(takeOpt('--mods', path.join(TOOL, 'mods')));
const DRY = takeFlag('--dry-run');
const [cmd, ...rest] = args;



// ------------------------------------------------------------------ game access (loaded on demand)
let L, F, E, TI, LOC, W, MESH, GAME;
function loadGame() {
  if (L) return;
  GAME = require('./fb2_game.js').findGame({ arg: GAME_ARG, ask: true }); // registry, usual folders, or a folder picker
  process.argv = [process.argv[0], process.argv[1], '--game', GAME, '--out', OUT]; // the modules read their options here
  L = require('./fb2_extract.js'); F = require('./fb2_ebx_fields.js'); E = require('./fb2_ebx_edit.js'); TI = require('./fb2_tex_import.js'); LOC = require('./fb2_loc.js'); W = require('./fb2_ebx_write.js'); MESH = require('./fb2_mesh.js');
}
const runPatch = (...a) => spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(TOOL, 'fb2_patch.js'), '--game', GAME, '--out', OUT, ...a], { stdio: 'inherit' }).status === 0;
const gamePatched = () => fs.existsSync(path.join(GAME, 'fb2_patch_state.json'));
const PKG_DIR = () => path.join(GAME, 'Update', 'Mods'); // our update package, loaded by the game on top of the official patch

// ------------------------------------------------------------------ mods on disk
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mod';
const LIST = path.join(MODS, 'modlist.json');
function loadList() {
  let l = { order: [], enabled: {} };
  try { l = JSON.parse(fs.readFileSync(LIST, 'utf8')); } catch { /* new list */ }
  const present = fs.existsSync(MODS) ? fs.readdirSync(MODS).filter((d) => fs.existsSync(path.join(MODS, d, 'mod.json'))) : [];
  l.order = l.order.filter((id) => present.includes(id));
  for (const id of present) if (!l.order.includes(id)) { l.order.push(id); if (l.enabled[id] === undefined) l.enabled[id] = true; }
  return l;
}
function saveList(l) { fs.mkdirSync(MODS, { recursive: true }); fs.writeFileSync(LIST, JSON.stringify(l, null, 1)); }

function validateMod(m, where) {
  const bad = (msg) => { throw new Error(`${where}: ${msg}`); };
  if (m.format !== 1) bad('"format" must be 1');
  if (!m.name || typeof m.name !== 'string') bad('"name" is required');
  if (!Array.isArray(m.changes) || !m.changes.length) bad('"changes" must be a non-empty list');
  m.changes.forEach((c, i) => {
    const at = `change #${i + 1}`;
    if (c.type === 'ebx') {
      if (!c.asset) bad(`${at}: ebx needs "asset"`);
      if (c.instance === undefined && !c.where && !c.object) bad(`${at}: ebx needs "where", "object" or "instance"`);
      if (!c.set && !c.remove && !c.append && !c.duplicate && !c.delete) bad(`${at}: ebx needs "set", "remove", "append", "duplicate" or "delete"`);
      if (c.object !== undefined && !/^[0-9a-f]{32}$/i.test(c.object)) bad(`${at}: "object" is a 32-digit hex GUID`);
      if (c.delete !== undefined && (c.delete !== true || c.set || c.remove || c.append || c.duplicate)) bad(`${at}: "delete": true must be alone`);
      if (c.duplicate !== undefined && (typeof c.duplicate !== 'object' || !/^[0-9a-f]{32}$/i.test(c.duplicate.guid || ''))) bad(`${at}: "duplicate" needs a "guid" of 32 hex digits for the copy`);
      if (c.set !== undefined && (typeof c.set !== 'object' || Array.isArray(c.set))) bad(`${at}: "set" must be an object of path: value`);
      if (c.remove !== undefined && (!Array.isArray(c.remove) || c.remove.some((p) => !/\.\d+$/.test(p)))) bad(`${at}: "remove" must be a list of "<list path>.<item number>"`);
      if (c.append !== undefined && (typeof c.append !== 'object' || Array.isArray(c.append))) bad(`${at}: "append" must be an object of list path: item(s)`);
    }
    else if (c.type === 'texture') {
      if (!c.asset || !c.png) bad(`${at}: texture needs "asset" and "png"`);
      if (c.size !== undefined && c.size !== 'png' && !(Array.isArray(c.size) && c.size.length === 2)) bad(`${at}: "size" is "png" or [width, height]`);
    }
    else if (c.type === 'mesh') { if (!c.asset || (!c.glb && c.hide !== true)) bad(`${at}: mesh needs "asset" (model name) and "glb" (file in the mod), or "hide": true`); }
    else if (c.type === 'text') { if (!/^(0x)?[0-9a-f]{1,8}$/i.test(String(c.id || '')) || typeof c.value !== 'string') bad(`${at}: text needs "id" (hex) and "value" (text)`); if (c.lang !== undefined && !/^[a-z]{2}$/i.test(c.lang)) bad(`${at}: "lang" must be a two-letter code like "en"`); }
    else if (c.type === 'add') { if (!c.next || !Array.isArray(c.add) || !c.add.length || c.add.some((x) => typeof x !== 'string')) bad(`${at}: add needs "next" (ebx name) and "add" (a list of asset names)`); }
    else if (c.type === 'file') { if (!['ebx', 'res', 'chunk'].includes(c.kind) || !c.name || !c.path) bad(`${at}: file needs "kind" (ebx/res/chunk), "name" and "path"`); }
    else bad(`${at}: unknown type "${c.type}"`);
  });
  return m;
}
const readMod = (dir) => validateMod(JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8')), path.basename(dir));
const insideMod = (dir, p) => { const f = path.resolve(dir, p); if (!f.startsWith(path.resolve(dir) + path.sep)) throw new Error('file outside the mod folder: ' + p); return f; };

function install(src) {
  if (!src || !fs.existsSync(src)) throw new Error('file or folder not found: ' + src);
  let files;
  if (fs.statSync(src).isDirectory()) {
    files = new Map();
    const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f); else files.set(path.relative(src, f).split(path.sep).join('/'), fs.readFileSync(f)); } };
    walk(src);
  } else files = Z.readZip(fs.readFileSync(src));
  // allow archives whose content sits in one top-level folder
  if (!files.has('mod.json')) {
    const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
    if (tops.size === 1 && files.has([...tops][0] + '/mod.json')) { const t = [...tops][0] + '/'; files = new Map([...files].map(([n, d]) => [n.slice(t.length), d])); }
  }
  if (!files.has('mod.json')) throw new Error('mod.json not found in ' + src);
  const mod = validateMod(JSON.parse(files.get('mod.json').toString('utf8')), path.basename(src));
  const id = slug(mod.name), dir = path.join(MODS, id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [n, d] of files) { const f = insideMod(dir, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); }
  const l = loadList(); l.enabled[id] = true; saveList(l);
  console.log(`Installed "${mod.name}" ${mod.version || ''} as ${id} (enabled).`);
  return id;
}

// ------------------------------------------------------------------ build: turn enabled mods into game-file mods for fb2_patch
const resAsGameSees = (index, name, type) => MESH.resAsGameSees(index, name, type); // shared with the editor

// ------------------------------------------------------------------ build cache
// Building a model or a texture takes up to a second; with two cars that is a minute every time. A result is kept in
// output/cache under a key made of everything it depends on: the change itself, the bytes of the mod's file (.glb /
// .png), the game (the asset index: rebuilt when the game changes) and the code that builds it. Same key = same result.
const crypto = require('crypto');
const CACHE = path.join(OUT, 'cache');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
let stamps = null;
function cacheStamps() {
  if (stamps) return stamps;
  const st = fs.statSync(L.INDEX_FILE);
  const code = ['fb2_mesh.js', 'fb2_tex_import.js', 'fb2_texture.js', 'fb2_extract.js', 'fb2_repack.js'].map((f) => sha1(fs.readFileSync(path.join(TOOL, f)))).join('');
  stamps = sha1(`${st.size}|${st.mtimeMs}|${code}`);
  return stamps;
}
const fileHashes = new Map(); // a mod file's bytes are hashed once per run
const fileHash = (f) => { if (!fileHashes.has(f)) fileHashes.set(f, sha1(fs.readFileSync(f))); return fileHashes.get(f); };
const cacheKey = (kind, change, file) => sha1([kind, cacheStamps(), JSON.stringify(change), file ? fileHash(file) : ''].join('|'));
function cacheGet(key) {
  const d = path.join(CACHE, key.slice(0, 2), key);
  if (!fs.existsSync(path.join(d, 'meta.json'))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
    const now = new Date(); try { fs.utimesSync(path.join(d, 'meta.json'), now, now); } catch { /* only for clean-up */ } // last used
    return { meta, read: (n) => fs.readFileSync(path.join(d, n)) };
  } catch { return null; }
}
function cachePut(key, meta, files) {
  const d = path.join(CACHE, key.slice(0, 2), key), tmp = d + '.tmp' + process.pid;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const [n, data] of Object.entries(files)) fs.writeFileSync(path.join(tmp, n), data);
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta)); // written last: a half-written entry has no meta
    fs.rmSync(d, { recursive: true, force: true }); fs.renameSync(tmp, d);
  } catch { fs.rmSync(tmp, { recursive: true, force: true }); } // the cache is only a speed-up: never fail the build for it
}
// entries not used for 30 days are removed, so the cache does not grow for ever
function cachePrune() {
  if (!fs.existsSync(CACHE)) return;
  const old = Date.now() - 30 * 24 * 3600 * 1000;
  for (const a of fs.readdirSync(CACHE)) for (const k of fs.readdirSync(path.join(CACHE, a))) {
    const d = path.join(CACHE, a, k);
    try { if (fs.statSync(path.join(d, 'meta.json')).mtimeMs < old) fs.rmSync(d, { recursive: true, force: true }); } catch { fs.rmSync(d, { recursive: true, force: true }); } // no meta = half written
  }
}
const pngs = new Map(); // a picture used by many textures (a livery) is read once
const readPngOnce = (f) => { if (!pngs.has(f)) pngs.set(f, TI.readPng(f)); return pngs.get(f); };

function build(write) {
  loadGame();
  if (!fs.existsSync(L.INDEX_FILE)) { console.log('Building the asset index (first run only)...'); L.buildIndex(); }
  const index = L.loadIndex();
  const l = loadList();
  const enabled = l.order.filter((id) => l.enabled[id]);
  const outDir = path.join(OUT, 'build');
  if (write) { fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true }); }
  const ebx = new Map();                 // asset -> decoded ebx being edited (fb2_ebx_write)
  const texts = new Map();               // language -> Map(text id -> new text)
  const meshReports = [];                // what each "mesh" change did (vertices / triangles per part)
  const owner = new Map();               // what was changed -> { mod, value }
  const conflicts = [];
  const claim = (key, mod, value, label) => {
    const prev = owner.get(key);
    if (prev && prev.mod !== mod && JSON.stringify(prev.value) !== JSON.stringify(value)) conflicts.push(`${label}: "${prev.mod}" set ${JSON.stringify(prev.value)}, "${mod}" sets ${JSON.stringify(value)} (${mod} wins)`);
    owner.set(key, { mod, value });
  };
  const writeOut = (rel, data) => { if (!write) return; const f = path.join(outDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  const refCache = new Map();
  const refTo = (name, object) => {
    const key = name.toLowerCase();
    if (!refCache.has(key)) {
      const p = F.parse(E.readAsGameSees(index, key).data); // throws "ebx not found" for unknown names
      refCache.set(key, { file: p.guid, primary: p.primaryGuid, objects: new Set(p.instances.map((x) => x.guid)) });
    }
    const t = refCache.get(key);
    const inst = object ? String(object).toLowerCase() : t.primary;
    if (!t.objects.has(inst)) throw new Error(`${name} has no object ${object}`);
    return { file: t.file, instance: inst };
  };
  let count = 0;
  for (const id of enabled) {
    const dir = path.join(MODS, id), mod = readMod(dir);
    for (const c of mod.changes) {
      count++;
      if (c.type === 'ebx') {
        const asset = c.asset.toLowerCase();
        if (!ebx.has(asset)) ebx.set(asset, W.decode(E.readAsGameSees(index, asset).data)); // the whole file, as values
        const doc = ebx.get(asset);
        let targets;
        if (c.object !== undefined) { targets = [W.objectIndex(doc, c.object)]; if (targets[0] < 0) throw new Error(`${id}: ${asset} has no object ${c.object}`); }
        else if (c.instance !== undefined) { targets = [Number(c.instance)]; if (!doc.instances[targets[0]]) throw new Error(`${id}: ${asset} has no object #${c.instance}`); }
        else {
          const norm = (x) => JSON.stringify(W.copyValue(x));
          targets = doc.instances.map((x, i) => [x.value, i]).filter(([v]) => Object.entries(c.where).every(([k, want]) => norm(v[k]) === norm(want))).map(([, i]) => i);
          if (!targets.length) throw new Error(`${id}: no instance in ${asset} matches ${JSON.stringify(c.where)}`);
          if (targets.length > 1 && !c.all) throw new Error(`${id}: ${targets.length} instances in ${asset} match ${JSON.stringify(c.where)}; add "all": true to change all of them`);
        }
        const why = (p, err) => new Error(`${id}: ${asset} #${targets[0]} ${p}: ${err.message}`);
        if (c.delete) {
          // object numbers shift when one is removed: remove by GUID, one after another
          for (const g of targets.map((i) => doc.instances[i].guid)) {
            claim(`ebx|${asset}|${g}|object`, id, 'delete', `${asset} object ${g}`);
            try { W.deleteObject(doc, W.objectIndex(doc, g)); } catch (err) { throw new Error(`${id}: ${asset} ${g}: ${err.message}`); }
          }
          continue;
        }
        if (c.duplicate) {
          if (targets.length !== 1) throw new Error(`${id}: "duplicate" needs exactly one object`);
          const g = c.duplicate.guid.toLowerCase();
          claim(`ebx|${asset}|${g}|object`, id, 'duplicate', `${asset} new object ${g}`);
          let n;
          try { n = W.addObject(doc, targets[0], g); } catch (err) { throw new Error(`${id}: ${asset}: ${err.message}`); }
          if (n <= targets[0]) targets[0]++; // (never happens: copies go after the original) keep pointing at the original
          for (const [p, v] of Object.entries(c.duplicate.set || {})) {
            let t; try { t = W.locate(doc, n, p); } catch (err) { throw new Error(`${id}: ${asset} copy ${g} ${p}: ${err.message}`); }
            claim(`ebx|${asset}|${g}|${p}`, id, v, `${asset} copy ${g}.${p}`);
            try { t.holder[t.key] = t.f.kind === 'array' ? W.convertArray(doc, t.f, v, refTo) : W.convert(doc, t.f, v, refTo); } catch (err) { throw new Error(`${id}: ${asset} copy ${g} ${p}: ${err.message}`); }
          }
        }
        for (const i of targets) {
          // 1) remove list items: highest numbers first, so the numbers refer to the original list
          const rm = (c.remove || []).map((p) => { const m = p.match(/^(.*)\.(\d+)$/); return { list: m[1], n: Number(m[2]), p }; }).sort((a, b) => b.n - a.n);
          for (const r of rm) {
            let t; try { t = W.locate(doc, i, r.list); } catch (err) { throw why(r.p, err); }
            const list = t.holder[t.key];
            if (t.f.kind !== 'array') throw why(r.p, new Error('not a list'));
            if (r.n >= list.length) throw why(r.p, new Error(`item ${r.n} does not exist (the list has ${list.length})`));
            claim(`ebx|${asset}|${doc.instances[i].guid}|${r.list}|list`, id, 'remove ' + r.n, `${asset} #${i}.${r.list}`);
            list.splice(r.n, 1);
          }
          // 2) append list items
          for (const [lp, items] of Object.entries(c.append || {})) {
            let t; try { t = W.locate(doc, i, lp); } catch (err) { throw why(lp, err); }
            if (t.f.kind !== 'array') throw why(lp, new Error('not a list'));
            const itemF = W.itemFieldOf(doc, t.f);
            claim(`ebx|${asset}|${doc.instances[i].guid}|${lp}|list`, id, items, `${asset} #${i}.${lp}`);
            for (const item of Array.isArray(items) && itemF.kind !== 'array' ? items : [items]) {
              try { t.holder[t.key].push(itemF.kind === 'array' ? W.convertArray(doc, itemF, item, refTo) : W.convert(doc, itemF, item, refTo)); } catch (err) { throw why(lp, err); }
            }
          }
          // 3) set values
          for (const [p, v] of Object.entries(c.set || {})) {
            let t; try { t = W.locate(doc, i, p); } catch (err) { throw why(p, err); }
            claim(`ebx|${asset}|${doc.instances[i].guid}|${p}`, id, v, `${asset} #${i}.${p}`);
            try { t.holder[t.key] = t.f.kind === 'array' ? W.convertArray(doc, t.f, v, refTo) : W.convert(doc, t.f, v, refTo); } catch (err) { throw why(p, err); }
          }
        }
      } else if (c.type === 'texture') {
        const name = c.asset.toLowerCase(), pngFile = insideMod(dir, c.png);
        const key = cacheKey('texture', { asset: name, size: c.size || null }, pngFile);
        let hit = cacheGet(key);
        if (!hit) {
          let hdr;
          try { hdr = MESH.resAsGameSees(index, name, '5c4954a6'); } catch { throw new Error(`${id}: texture not found: ${c.asset}`); } // header as the game sees it
          const img = readPngOnce(pngFile);
          let tex;
          try { tex = TI.buildTextureChunk(hdr, img, c.size ? { size: c.size === 'png' ? [img.w, img.h] : c.size } : {}); }
          catch (err) { throw new Error(`${id}: texture ${c.asset}: ${err.message}`); }
          // levels the game streams later (header 0x1b): some bundles keep only the rest. Every copy is packed with a
          // block border where that rest starts (as the game does), so the patcher is told where it is, resized or not
          const later = tex.header[0x1b];
          let off = 0; for (let m = 0; m < later; m++) off += tex.header.readUInt32LE(0x2c + m * 4);
          const meta = { guid: hdr.toString('hex', 0x1c, 0x2c), resized: !!tex.resized, logicalOffset: later ? off : null };
          cachePut(key, meta, { 'chunk.bin': tex.data, ...(tex.resized ? { 'header.bin': tex.header } : {}) });
          hit = { meta, read: (n) => (n === 'chunk.bin' ? tex.data : tex.header) };
        }
        const { guid, resized, logicalOffset } = hit.meta;
        claim(`chunk|${guid}`, id, c.png, `texture ${c.asset}`);
        writeOut(`chunk/${guid}.chunk`, hit.read('chunk.bin'));
        if (resized) { claim(`res|${name}`, id, c.png, `texture ${c.asset} size`); writeOut(`res/${name}.res`, hit.read('header.bin')); } // new size: new header too
        if (logicalOffset !== null) writeOut(`chunk/${guid}.chunk.json`, Buffer.from(JSON.stringify({ logicalOffset })));
      } else if (c.type === 'mesh') {
        const name = c.asset.toLowerCase();
        const src = c.hide ? '(hidden)' : c.glb, glbFile = c.hide ? null : insideMod(dir, c.glb);
        const opts = { keepOtherLods: !!c.keepOtherLods, clearOthers: !!c.clearOthers, keepParts: c.keepParts, hide: !!c.hide, evenShade: !!c.evenShade };
        const key = cacheKey('mesh', { asset: name, ...opts }, glbFile);
        let r;
        const hit = cacheGet(key);
        if (hit) r = { res: hit.read('res.bin'), chunks: new Map(hit.meta.chunks.map((g) => [g, hit.read(g + '.bin')])), report: hit.meta.report };
        else {
          r = MESH.glbToModel(index, MESH.parseMeshSet(resAsGameSees(index, name, MESH.MESH_RES_TYPE)), glbFile ? fs.readFileSync(glbFile) : null, opts);
          cachePut(key, { chunks: [...r.chunks.keys()], report: r.report }, { 'res.bin': r.res, ...Object.fromEntries([...r.chunks].map(([g, d]) => [g + '.bin', d])) });
        }
        claim(`res|${name}`, id, src, `model ${name}`);
        writeOut(`res/${name}.res`, r.res);
        for (const [guid, data] of r.chunks) { claim(`chunk|${guid}`, id, src, `model ${name} geometry`); writeOut(`chunk/${guid}.chunk`, data); }
        meshReports.push(...r.report.map((x) => `${id}: ${name.split('/').pop()} ${x}`));
      } else if (c.type === 'add') {
        // { "type": "add", "next": "<ebx name>", "add": ["<asset name>", ...] }: put those assets (with their picture
        // data) into every bundle that holds "next", e.g. a vinyl picture for a livery that had none
        if (!c.next || !Array.isArray(c.add) || !c.add.length) throw new Error(`${id}: "add" needs "next" and a list "add"`);
        const next = c.next.toLowerCase(), list = c.add.map((x) => x.toLowerCase());
        if (!index.some((e) => e.kind === 'ebx' && e.name === next)) throw new Error(`${id}: ${c.next} not found in the game`);
        for (const n of list) if (!index.some((e) => e.kind === 'ebx' && e.name === n)) throw new Error(`${id}: ${n} not found in the game`);
        for (const n of list) claim(`add|${next}|${n}`, id, true, `${n} next to ${next}`);
        writeOut(`adds/${sha1(next + '|' + list.join('|')).slice(0, 16)}.json`, Buffer.from(JSON.stringify({ next, add: list })));
      } else if (c.type === 'text') {
        const installed = LOC.languages();
        const langs = c.lang ? [c.lang.toLowerCase()] : installed;
        if (c.lang && !installed.includes(langs[0])) { console.log(`  note: ${id} changes a ${langs[0]} text, but this game has ${installed.join(', ')}; skipped`); continue; }
        for (const lang of langs) {
          const tid = LOC.parseId(c.id);
          claim(`text|${lang}|${tid}`, id, c.value, `text ${LOC.hexId(tid)} (${lang})`);
          if (!texts.has(lang)) texts.set(lang, new Map());
          texts.get(lang).set(tid, c.value);
        }
      } else {
        const name = c.name.toLowerCase();
        if (c.kind === 'ebx' && ebx.has(name)) conflicts.push(`${name}: replaced as a whole by "${id}" and also edited by value (the edit is lost)`);
        claim(`${c.kind}|${name}`, id, c.path, `${c.kind} ${name}`);
        writeOut(`${c.kind}/${name}.${c.kind}`, fs.readFileSync(insideMod(dir, c.path)));
      }
    }
  }
  for (const [asset, doc] of ebx) {
    const out = W.encode(doc);
    F.parse(out); // must read back as a valid ebx
    writeOut(`ebx/${asset}.ebx`, out);
  }
  // texts: one rebuilt string table per language (+ the character table if new characters were needed)
  for (const [lang, changes] of texts) {
    const r = LOC.buildLoc(LOC.readLoc(lang), changes); // throws for unknown ids or characters that do not fit
    writeOut(`chunk/${r.strId}.chunk`, r.str);
    if (r.chars) writeOut(`chunk/${r.charsId}.chunk`, r.chars);
  }
  if (write) cachePrune();
  return { enabled, count, conflicts, outDir, meshReports };
}

// ------------------------------------------------------------------ commands
function list() {
  const l = loadList();
  if (!l.order.length) { console.log(`No mods installed in ${MODS}`); return; }
  console.log(`Mods in ${MODS} (load order: later wins):`);
  l.order.forEach((id, i) => {
    let m = {}; try { m = readMod(path.join(MODS, id)); } catch (e) { m = { name: id + ' (BROKEN: ' + e.message + ')' }; }
    console.log(`  ${String(i + 1).padStart(2)}. [${l.enabled[id] ? 'x' : ' '}] ${id.padEnd(24)} ${m.name} ${m.version || ''}${m.author ? ' by ' + m.author : ''}`);
  });
  saveList(l);
}
function setEnabled(id, on) {
  const l = loadList();
  if (!l.order.includes(id)) throw new Error(`mod "${id}" is not installed (see: list)`);
  l.enabled[id] = on; saveList(l);
  console.log(`${id}: ${on ? 'enabled' : 'disabled'}. Run "apply" to update the game.`);
}
function check() {
  const r = build(false);
  console.log(`${r.enabled.length} enabled mod(s), ${r.count} change(s): all resolved against the game.`);
  if (r.meshReports.length) { console.log('Models:'); r.meshReports.forEach((x) => console.log('  ' + x)); }
  if (r.conflicts.length) { console.log('Conflicts:'); r.conflicts.forEach((c) => console.log('  - ' + c)); } else console.log('No conflicts.');
  if (gamePatched()) console.log('(The game files are patched in place by an older version of this tool; values were read from the patched files.)');
}
// Older versions patched the game files in place; undo that first so the package is built from the original files.
function undoInPlace() {
  if (!gamePatched()) return;
  console.log('Restoring game files patched by an older version of this tool...');
  if (!runPatch('restore')) throw new Error('restore failed');
}
function apply() {
  loadGame();
  if (!DRY) undoInPlace();
  const r = build(true);
  r.conflicts.forEach((c) => console.log('  CONFLICT: ' + c));
  if (!r.enabled.length) {
    if (!DRY && !runPatch('remove-package', '--package', PKG_DIR())) throw new Error('could not remove the mod package');
    console.log('No enabled mods: the game runs with its original files.');
    return;
  }
  // the build's fingerprint: every file it wrote (name + bytes). Same as for the package in the game: nothing to do
  const files = [];
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f); else files.push(f); } };
  walk(r.outDir);
  const digest = sha1(files.sort().map((f) => path.relative(r.outDir, f) + ':' + sha1(fs.readFileSync(f))).join('\n'));
  const digestFile = path.join(PKG_DIR(), 'mods_build.sha1');
  if (!DRY && fs.existsSync(path.join(PKG_DIR(), 'package.mft')) && fs.existsSync(digestFile) && fs.readFileSync(digestFile, 'utf8') === digest) {
    console.log('Nothing changed since the last apply: the game already has these mods.');
    return;
  }
  console.log(`Applying ${r.enabled.length} mod(s): ${r.enabled.join(', ')}`);
  // mods go into a separate update package (Update/Mods); the game's own files are never changed
  if (!runPatch('apply', '--mods', r.outDir, '--package', PKG_DIR(), ...(DRY ? ['--dry-run'] : []))) throw new Error('fb2_patch failed');
  if (!DRY) fs.writeFileSync(digestFile, digest);
  if (!DRY) console.log('Done. Start the game. Undo everything with: restore');
}
function restoreAll() {
  loadGame();
  undoInPlace();
  if (!runPatch('remove-package', '--package', PKG_DIR())) throw new Error('could not remove the mod package');
}
// A simple text menu for players (manage_mods.bat): no commands to remember.
async function menu() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  // read lines through an iterator: lines that arrive early are queued, none get lost; end of input = quit
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => { process.stdout.write(q); const r = await lines.next(); if (r.done) { console.log(''); return 'Q'; } return r.value; };
  const yes = async (q) => /^y/i.test((await ask(q + ' (Y/N) ')).trim());
  let pending = false; // changes not yet applied to the game
  const nameOf = (id) => { try { const m = readMod(path.join(MODS, id)); return `${m.name} ${m.version || ''}${m.author ? ' by ' + m.author : ''}`; } catch (e) { return id + ' (BROKEN: ' + e.message + ')'; } };
  for (;;) {
    const l = loadList(); saveList(l);
    console.log('');
    console.log('=== Mods for Need for Speed: The Run ===');
    if (!l.order.length) console.log('  No mods installed yet. Drag a .nfsmod file onto install_mod.bat to install one.');
    l.order.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2)}. [${l.enabled[id] ? 'ON ' : 'OFF'}] ${nameOf(id)}`));
    console.log('');
    console.log('  number    switch that mod on/off');
    console.log('  R number  remove it (e.g. R2)');
    console.log('  U number  move it up (later mods win when two change the same thing)');
    console.log('  C         add a car model (.glb) in place of a car of the game');
    console.log('  A         apply to the game' + (pending ? '   <- your changes are not in the game yet' : ''));
    console.log('  Q         quit');
    const a = (await ask('> ')).trim().toUpperCase();
    const m = a.match(/^([RU]?)\s*(\d+)$/);
    const pick = m && l.order[Number(m[2]) - 1];
    if (m && !pick) { console.log('  There is no mod number ' + m[2] + '.'); continue; }
    if (m && !m[1]) { l.enabled[pick] = !l.enabled[pick]; saveList(l); pending = true; console.log(`  ${nameOf(pick)}: ${l.enabled[pick] ? 'ON' : 'OFF'}`); }
    else if (m && m[1] === 'R') {
      if (await yes(`  Remove "${nameOf(pick)}"?`)) { fs.rmSync(path.join(MODS, pick), { recursive: true, force: true }); delete l.enabled[pick]; saveList(loadList()); pending = true; console.log('  Removed.'); }
    } else if (m && m[1] === 'U') {
      const i = l.order.indexOf(pick);
      if (i > 0) { l.order.splice(i, 1); l.order.splice(i - 1, 0, pick); saveList(l); pending = true; }
    } else if (a === 'C') {
      try { if (await addCarModel(ask)) pending = true; } catch (err) { console.log('ERROR: ' + err.message); }
    } else if (a === 'A') {
      try { apply(); pending = false; } catch (err) { console.log('ERROR: ' + err.message); }
    } else if (a === 'Q' || a === '') {
      if (pending && await yes('  Your changes are not in the game yet. Apply them now?')) { try { apply(); } catch (err) { console.log('ERROR: ' + err.message); } }
      break;
    } else console.log('  Type a number, R and a number, U and a number, C, A or Q.');
  }
  rl.close();
}

// The cars a model can replace: id -> the name the garage shows (cars that have a main body kit)
function gameCars(index) {
  const ids = [...new Set(index.filter((e) => e.kind === 'res' && /^_c4\/vehicles\/nfs\/([^/]+)\/kits\/\1_kit00_stream_meshbody$/.test(e.name)).map((e) => e.name.split('/')[3]))];
  const shown = new Map();
  for (const e of index) {
    if (e.kind !== 'ebx' || !e.name.startsWith('_c4/gameplay/garage/')) continue;
    const id = ids.find((x) => e.name.split('/').pop().startsWith(x + '_') || e.name.split('/').pop() === x);
    if (!id || shown.has(id)) continue;
    try { const v = W.decode(E.readAsGameSees(index, e.name).data).instances[0].value; if (v && v.DisplayString) shown.set(id, v.DisplayString); } catch { /* not a garage car */ }
  }
  // cars without a garage name (add-ons, police): a readable name from the id, e.g. for_mus_bos_12 -> Ford mus bos 2012
  const MAKES = { ast: 'Aston Martin', aud: 'Audi', bmw: 'BMW', bug: 'Bugatti', che: 'Chevrolet', cop: 'Police', dod: 'Dodge', for: 'Ford (Mustang)', gum: 'Gumpert', hen: 'Hennessey', koe: 'Koenigsegg', lam: 'Lamborghini', lex: 'Lexus', lot: 'Lotus', maz: 'Mazda', mcl: 'McLaren', mer: 'Mercedes-Benz', mit: 'Mitsubishi', nis: 'Nissan', pag: 'Pagani', pon: 'Pontiac', por: 'Porsche', ren: 'Renault', she: 'Shelby (Mustang)', sub: 'Subaru', toy: 'Toyota', vol: 'Volkswagen' };
  const guess = (id) => { const p = id.split('_'), y = Number(p[p.length - 1]); return [MAKES[p[0]] || p[0], ...p.slice(1, -1), Number.isFinite(y) ? (y > 30 ? 1900 + y : 2000 + y) : p[p.length - 1]].join(' '); };
  return ids.map((id) => ({ id, name: shown.get(id) || guess(id) })).sort((a, b) => a.name.localeCompare(b.name));
}

// Menu "C": a car model (.glb) in place of a car of the game. The model is copied to my_ports/<name>-on-<car>, a
// port.json is written for it automatically (fb2_carport.js auto) and the mod is built and installed (switched on).
async function addCarModel(ask) {
  loadGame();
  if (!fs.existsSync(L.INDEX_FILE)) { console.log('Building the asset index (first run only)...'); L.buildIndex(); }
  const index = L.loadIndex();
  const file = (await ask('  Drag your car model (.glb) into this window, then press Enter: ')).trim().replace(/^"|"$/g, '');
  if (!file || file.toUpperCase() === 'Q') return false;
  if (!fs.existsSync(file) || !/\.glb$/i.test(file)) { console.log('  That is not a .glb file. In Blender: File > Export > glTF 2.0, format "glTF Binary (.glb)".'); return false; }
  console.log('  Reading the cars of the game...');
  const cars = gameCars(index);
  const q = (await ask('  Which car of the game should it replace? Type part of its name (e.g. camaro): ')).trim().toLowerCase();
  const found = cars.filter((c) => (c.name + ' ' + c.id).toLowerCase().includes(q)).slice(0, 30);
  if (!found.length) { console.log('  No car of the game matches "' + q + '".'); return false; }
  found.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.name}  (${c.id})`));
  const n = Number((await ask('  Number of the car: ')).trim());
  const car = found[n - 1];
  if (!car) { console.log('  No such number.'); return false; }
  const dir = path.join(TOOL, 'my_ports', slug(path.basename(file, path.extname(file))) + '-on-' + car.id);
  fs.mkdirSync(dir, { recursive: true });
  const glb = path.join(dir, path.basename(file));
  if (path.resolve(file) !== path.resolve(glb)) fs.copyFileSync(file, glb);
  console.log(`  Fitting the model onto the ${car.name} (this takes a few minutes)...`);
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(TOOL, 'fb2_carport.js'), '--game', GAME, 'auto', glb, car.id], { stdio: 'inherit' });
  if (r.status !== 0) { console.log('  The model could not be fitted (see the message above). Its settings are in ' + path.join(dir, 'port.json')); return false; }
  install(path.join(dir, 'mod'));
  console.log('');
  console.log(`  Done: the model replaces the ${car.name}. Lines starting with CHECK above say what to look at in the game.`);
  console.log('  Press A to put it in the game. To fine-tune it, edit ' + path.join(dir, 'port.json'));
  console.log('  and add the model again. Please do not share models taken from other games.');
  return true;
}

function newMod(name) {
  if (!name) throw new Error('usage: new "<mod name>"');
  const dir = path.resolve(slug(name));
  if (fs.existsSync(dir)) throw new Error('folder already exists: ' + dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    format: 1, name, version: '1.0.0', author: '', description: '',
    changes: [{ type: 'ebx', asset: '_c4/ui/flow/screen/menu_mainmenu', where: { Label: 'ID_MENU_DEBUG' }, set: { 'Visibility.InvertValue': false } }],
  }, null, 2) + '\n');
  console.log(`Created ${dir}\\mod.json. Edit it, then: node fb2_mods.js install "${dir}"  (or pack it into a .nfsmod)`);
}
function pack(dir, out) {
  if (!dir) throw new Error('usage: pack <mod folder> [out.nfsmod]');
  const m = readMod(dir);
  const files = [];
  const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f); else files.push({ name: path.relative(dir, f).split(path.sep).join('/'), data: fs.readFileSync(f) }); } };
  walk(dir);
  const target = path.resolve(out || `${slug(m.name)}-${m.version || '1.0.0'}.nfsmod`);
  fs.writeFileSync(target, Z.writeZip(files));
  console.log(`Packed "${m.name}" (${files.length} file(s)) -> ${target}`);
}

if (require.main === module) try {
  if (cmd === 'menu') menu().catch((err) => { console.error('ERROR: ' + err.message); process.exit(1); });
  else if (cmd === 'list') list();
  else if (cmd === 'install') { install(rest[0]); }
  else if (cmd === 'enable') setEnabled(rest[0], true);
  else if (cmd === 'disable') setEnabled(rest[0], false);
  else if (cmd === 'remove') { const l = loadList(); if (!l.order.includes(rest[0])) throw new Error('not installed: ' + rest[0]); fs.rmSync(path.join(MODS, rest[0]), { recursive: true, force: true }); delete l.enabled[rest[0]]; saveList(l); console.log(`Removed ${rest[0]}. Run "apply" to update the game.`); }
  else if (cmd === 'check') check();
  else if (cmd === 'apply') apply();
  else if (cmd === 'restore') restoreAll();
  else if (cmd === 'new') newMod(rest[0]);
  else if (cmd === 'pack') pack(rest[0], rest[1]);
  else console.log('Commands: menu | list | install <file|folder> | enable <id> | disable <id> | remove <id> | check | apply [--dry-run] | restore | new "<name>" | pack <folder> [out]');
} catch (err) { console.error('ERROR: ' + err.message); process.exit(1); }

module.exports = { install, build, validateMod };
