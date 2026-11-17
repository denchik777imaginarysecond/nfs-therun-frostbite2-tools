'use strict';
/*
 * fb2_devmenu.js — one-click unlock of the hidden developer menu (Free Roam) in Need for Speed: The Run (PC).
 *
 *   node fb2_devmenu.js enable  [--game "<game dir>"] [--dry-run]
 *   node fb2_devmenu.js disable [--game "<game dir>"]
 *   node fb2_devmenu.js status  [--game "<game dir>"]
 *
 * Or double-click enable_devmenu.bat / disable_devmenu.bat (they ask for administrator rights).
 *
 * What it does: in _c4/ui/flow/screen/menu_mainmenu (as patched by the official update) the main menu item
 * ID_MENU_DEBUG has a visibility condition that hides it in the retail game. "enable" makes the item always
 * visible, like the other main menu items, and applies that with fb2_patch.js (backups + clean restore).
 * "disable" runs fb2_patch.js restore, which undoes every change made by fb2_patch.js.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- find the game before loading the other modules (they need --game) ----
const argv = process.argv.slice(2);
const gi = argv.indexOf('--game');
const CANDIDATES = [
  'C:\\Program Files (x86)\\Need For Speed The Run',
  'C:\\Program Files\\Need For Speed The Run',
  'C:\\Program Files (x86)\\Origin Games\\Need for Speed The Run',
  'C:\\Program Files\\Origin Games\\Need for Speed The Run',
  'C:\\Program Files (x86)\\EA Games\\Need for Speed The Run',
  'C:\\Program Files\\EA Games\\Need for Speed The Run',
];
let game = gi >= 0 ? argv[gi + 1] : process.env.NFS_THE_RUN_DIR || CANDIDATES.find((d) => fs.existsSync(path.join(d, 'Data', 'Win32')));
if (!game) {
  console.error('Could not find Need for Speed: The Run. Run again with: --game "<path to the game folder>"');
  process.exit(1);
}
if (gi < 0) process.argv.push('--game', game);

const L = require('./fb2_extract.js');
const F = require('./fb2_ebx_fields.js');
const { readAsGameSees } = require('./fb2_ebx_edit.js');

const EBX = '_c4/ui/flow/screen/menu_mainmenu';
const MODS = path.join(__dirname, 'output', 'mods_devmenu');
const cmd = L.OPTS.rest[0];
const DRY = L.OPTS.rest.includes('--dry-run');

const runPatch = (...a) => {
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(__dirname, 'fb2_patch.js'), '--game', game, '--out', L.OUT_DIR, ...a], { stdio: 'inherit' });
  return r.status === 0;
};

function enable() {
  console.log('Game:', game);
  // start from the original files, so changes from an earlier patch are not baked into this mod
  if (!DRY && fs.existsSync(path.join(game, 'fb2_patch_state.json'))) {
    console.log('Restoring previously patched files first...');
    if (!runPatch('restore')) throw new Error('could not restore the previous patch');
  }
  if (!fs.existsSync(L.INDEX_FILE)) { console.log('Building the asset index (first run only)...'); L.buildIndex(); }
  const index = L.loadIndex();
  const { data, source } = readAsGameSees(index, EBX);
  const buf = Buffer.from(data);
  const parsed = F.parse(buf);
  const item = parsed.instances.map((x) => x.value).find((v) => v.Label === 'ID_MENU_DEBUG');
  if (!item || !item.Visibility) throw new Error('ID_MENU_DEBUG menu item not found in ' + EBX + ' — unexpected game version');
  const vis = item.Visibility;
  console.log(`Found ID_MENU_DEBUG in ${EBX} (${source}); visibility now: key ${vis.DataKey}, invert ${vis.InvertValue}`);
  // same as the always-visible items: no data source, not inverted
  buf.writeUInt32LE(0, vis['@DataCategory']);
  buf.writeUInt32LE(0, vis['@DataKey']);
  buf[vis['@InvertValue']] = 0;
  const check = F.parse(buf).instances.map((x) => x.value).find((v) => v.Label === 'ID_MENU_DEBUG').Visibility;
  if (check.DataCategory !== null || check.DataKey !== 0 || check.InvertValue !== false) throw new Error('self-check failed, nothing applied');
  fs.rmSync(MODS, { recursive: true, force: true });
  const out = path.join(MODS, 'ebx', EBX + '.ebx');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log('Mod prepared. Applying...');
  if (!runPatch('apply', '--mods', MODS, ...(DRY ? ['--dry-run'] : []))) process.exit(1);
  if (!DRY) console.log('\nDone. Start the game: the main menu now has a DEBUG item -> developer menu -> Start Free Roam.\nUndo with disable_devmenu.bat (or: node fb2_devmenu.js disable).');
}

if (cmd === 'enable') {
  try { enable(); } catch (err) { console.error('ERROR:', err.message); process.exit(1); }
} else if (cmd === 'disable') {
  console.log('Game:', game);
  process.exit(runPatch('restore') ? 0 : 1);
} else if (cmd === 'status') {
  runPatch('status', '--mods', MODS);
} else {
  console.log('Commands: enable [--dry-run] | disable | status   (optional: --game "<game dir>")');
}
