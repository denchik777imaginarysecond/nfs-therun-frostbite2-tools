'use strict';
/*
 * fb2_mods.js — mod manager for Need for Speed: The Run (PC).
 *
 * A mod is a .nfsmod file (a ZIP) or a folder with mod.json and optional PNG files. It holds no game files:
 * it describes changes, and the manager applies them to the player's own game.
 *
 *   node fb2_mods.js list                      installed mods, load order, enabled state
 *   node fb2_mods.js install <file.nfsmod|folder>
 *   node fb2_mods.js enable <id> | disable <id> | remove <id>
 *   node fb2_mods.js check                     resolve every change against the game, report conflicts (writes nothing)
 *   node fb2_mods.js apply [--dry-run]         restore the game, then apply all enabled mods together (administrator)
 *   node fb2_mods.js restore                   undo every change (administrator)
 *   node fb2_mods.js new "<name>"              create a mod folder with a mod.json template
 *   node fb2_mods.js pack <folder> [out.nfsmod]
 * Options: --game "<game dir>" (found automatically in the usual folders), --mods <dir> (default: ./mods)
 *
 * mod.json (format 1):
 *   { "format": 1, "name": "...", "version": "1.0.0", "author": "...", "description": "...",
 *     "changes": [
 *       { "type": "ebx", "asset": "<ebx name>", "where": { "<field>": <value>, ... } | "instance": <n>,
 *         "set": { "<field path>": <value>, ... } },
 *       { "type": "texture", "asset": "<texture name>", "png": "<file in the mod>" },
 *       { "type": "file", "kind": "ebx|res|chunk", "name": "<asset name or chunk guid>", "path": "<file in the mod>" } ] }
 * "where" picks the instance whose fields equal the given values (e.g. { "Label": "ID_MENU_DEBUG" } or { "$type": "..." }).
 * Mods are applied in load order (list); when two mods change the same value, the later one wins and a conflict is reported.
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

const CANDIDATES = [
  'C:\\Program Files (x86)\\Need For Speed The Run', 'C:\\Program Files\\Need For Speed The Run',
  'C:\\Program Files (x86)\\Origin Games\\Need for Speed The Run', 'C:\\Program Files\\Origin Games\\Need for Speed The Run',
  'C:\\Program Files (x86)\\EA Games\\Need for Speed The Run', 'C:\\Program Files\\EA Games\\Need for Speed The Run',
];

// ------------------------------------------------------------------ game access (loaded on demand)
let L, F, E, TI, GAME;
function loadGame() {
  if (L) return;
  GAME = GAME_ARG || process.env.NFS_THE_RUN_DIR || CANDIDATES.find((d) => fs.existsSync(path.join(d, 'Data', 'Win32')));
  if (!GAME) throw new Error('Could not find Need for Speed: The Run. Use --game "<path to the game folder>"');
  process.argv = [process.argv[0], process.argv[1], '--game', GAME, '--out', OUT]; // the modules read their options here
  L = require('./fb2_extract.js'); F = require('./fb2_ebx_fields.js'); E = require('./fb2_ebx_edit.js'); TI = require('./fb2_tex_import.js');
}
const runPatch = (...a) => spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(TOOL, 'fb2_patch.js'), '--game', GAME, '--out', OUT, ...a], { stdio: 'inherit' }).status === 0;
const gamePatched = () => fs.existsSync(path.join(GAME, 'fb2_patch_state.json'));

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
    if (c.type === 'ebx') { if (!c.asset || !c.set || typeof c.set !== 'object') bad(`${at}: ebx needs "asset" and "set"`); if (c.instance === undefined && !c.where) bad(`${at}: ebx needs "where" or "instance"`); }
    else if (c.type === 'texture') { if (!c.asset || !c.png) bad(`${at}: texture needs "asset" and "png"`); }
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
function build(write) {
  loadGame();
  if (!fs.existsSync(L.INDEX_FILE)) { console.log('Building the asset index (first run only)...'); L.buildIndex(); }
  const index = L.loadIndex();
  const l = loadList();
  const enabled = l.order.filter((id) => l.enabled[id]);
  const outDir = path.join(OUT, 'build');
  if (write) { fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true }); }
  const ebx = new Map();                 // asset -> Buffer being edited
  const owner = new Map();               // what was changed -> { mod, value }
  const conflicts = [];
  const claim = (key, mod, value, label) => {
    const prev = owner.get(key);
    if (prev && prev.mod !== mod && JSON.stringify(prev.value) !== JSON.stringify(value)) conflicts.push(`${label}: "${prev.mod}" set ${JSON.stringify(prev.value)}, "${mod}" sets ${JSON.stringify(value)} (${mod} wins)`);
    owner.set(key, { mod, value });
  };
  const writeOut = (rel, data) => { if (!write) return; const f = path.join(outDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  let count = 0;
  for (const id of enabled) {
    const dir = path.join(MODS, id), mod = readMod(dir);
    for (const c of mod.changes) {
      count++;
      if (c.type === 'ebx') {
        const asset = c.asset.toLowerCase();
        if (!ebx.has(asset)) ebx.set(asset, Buffer.from(E.readAsGameSees(index, asset).data));
        const buf = ebx.get(asset);
        let parsed = F.parse(buf);
        let targets;
        if (c.instance !== undefined) targets = [Number(c.instance)];
        else {
          targets = parsed.instances.map((x, i) => [x.value, i]).filter(([v]) => Object.entries(c.where).every(([k, want]) => JSON.stringify(v[k]) === JSON.stringify(want))).map(([, i]) => i);
          if (!targets.length) throw new Error(`${id}: no instance in ${asset} matches ${JSON.stringify(c.where)}`);
          if (targets.length > 1 && !c.all) throw new Error(`${id}: ${targets.length} instances in ${asset} match ${JSON.stringify(c.where)}; add "all": true to change all of them`);
        }
        for (const i of targets) for (const [p, v] of Object.entries(c.set)) {
          const t = E.resolve(parsed, `${i}.${p}`);
          claim(`ebx|${asset}|${t.at}`, id, v, `${asset} #${i}.${p}`);
          E.writeValue(buf, parsed, t.at, t.kind, v === null ? 'null' : String(v));
          parsed = F.parse(buf); // must still be a valid ebx
        }
      } else if (c.type === 'texture') {
        const name = c.asset.toLowerCase();
        const e = index.find((x) => x.kind === 'res' && x.extra === '5c4954a6' && x.name.toLowerCase() === name);
        if (!e) throw new Error(`${id}: texture not found: ${c.asset}`);
        const hdr = L.readAsset(fs.openSync(path.join(L.DATA_DIR, e.sb), 'r'), e);
        const tex = TI.buildTextureChunk(hdr, TI.readPng(insideMod(dir, c.png)));
        const guid = hdr.toString('hex', 0x1c, 0x2c);
        claim(`chunk|${guid}`, id, c.png, `texture ${c.asset}`);
        writeOut(`chunk/${guid}.chunk`, tex.data);
      } else {
        const name = c.name.toLowerCase();
        if (c.kind === 'ebx' && ebx.has(name)) conflicts.push(`${name}: replaced as a whole by "${id}" and also edited by value (the edit is lost)`);
        claim(`${c.kind}|${name}`, id, c.path, `${c.kind} ${name}`);
        writeOut(`${c.kind}/${name}.${c.kind}`, fs.readFileSync(insideMod(dir, c.path)));
      }
    }
  }
  for (const [asset, buf] of ebx) writeOut(`ebx/${asset}.ebx`, buf);
  return { enabled, count, conflicts, outDir };
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
  if (r.conflicts.length) { console.log('Conflicts:'); r.conflicts.forEach((c) => console.log('  - ' + c)); } else console.log('No conflicts.');
  if (gamePatched()) console.log('(The game is currently patched; values were read from the patched files.)');
}
function apply() {
  loadGame();
  if (!DRY && gamePatched()) { console.log('Restoring the original game files first...'); if (!runPatch('restore')) throw new Error('restore failed'); }
  const r = build(true);
  r.conflicts.forEach((c) => console.log('  CONFLICT: ' + c));
  if (!r.enabled.length) { console.log('No enabled mods: the game is in its original state.'); return; }
  console.log(`Applying ${r.enabled.length} mod(s): ${r.enabled.join(', ')}`);
  if (!runPatch('apply', '--mods', r.outDir, ...(DRY ? ['--dry-run'] : []))) throw new Error('fb2_patch failed');
  if (!DRY) console.log('Done. Start the game. Undo everything with: restore');
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

try {
  if (cmd === 'list') list();
  else if (cmd === 'install') { install(rest[0]); }
  else if (cmd === 'enable') setEnabled(rest[0], true);
  else if (cmd === 'disable') setEnabled(rest[0], false);
  else if (cmd === 'remove') { const l = loadList(); if (!l.order.includes(rest[0])) throw new Error('not installed: ' + rest[0]); fs.rmSync(path.join(MODS, rest[0]), { recursive: true, force: true }); delete l.enabled[rest[0]]; saveList(l); console.log(`Removed ${rest[0]}. Run "apply" to update the game.`); }
  else if (cmd === 'check') check();
  else if (cmd === 'apply') apply();
  else if (cmd === 'restore') { loadGame(); process.exit(runPatch('restore') ? 0 : 1); }
  else if (cmd === 'new') newMod(rest[0]);
  else if (cmd === 'pack') pack(rest[0], rest[1]);
  else console.log('Commands: list | install <file|folder> | enable <id> | disable <id> | remove <id> | check | apply [--dry-run] | restore | new "<name>" | pack <folder> [out]');
} catch (err) { console.error('ERROR: ' + err.message); process.exit(1); }

module.exports = { install, build, validateMod };
