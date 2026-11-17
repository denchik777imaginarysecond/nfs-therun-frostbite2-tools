'use strict';
/*
 * fb2_devmenu.js — one-click unlock of the hidden developer menu (Free Roam) in Need for Speed: The Run (PC).
 * A thin wrapper around the mod manager (fb2_mods.js) and the bundled mod examples/DeveloperMenu,
 * so it works together with any other installed mods.
 *
 *   node fb2_devmenu.js enable  [--game "<game dir>"] [--dry-run]
 *   node fb2_devmenu.js disable [--game "<game dir>"]
 *   node fb2_devmenu.js status  [--game "<game dir>"]
 * Or double-click enable_devmenu.bat / disable_devmenu.bat (they ask for administrator rights).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const pass = [];
const gi = argv.indexOf('--game');
if (gi >= 0) pass.push('--game', argv[gi + 1]);
const dry = argv.includes('--dry-run');
const cmd = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--game');
const ID = 'developer-menu';
const mods = (...a) => spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(__dirname, 'fb2_mods.js'), ...a, ...pass], { stdio: 'inherit' }).status === 0;
const installed = () => fs.existsSync(path.join(__dirname, 'mods', ID, 'mod.json'));

let ok = true;
if (cmd === 'enable') {
  if (!installed()) ok = mods('install', path.join(__dirname, 'examples', 'DeveloperMenu'));
  ok = ok && mods('enable', ID) && mods('apply', ...(dry ? ['--dry-run'] : []));
  if (ok && !dry) console.log('\nStart the game: main menu -> DEBUG -> Start Free Roam. Undo with disable_devmenu.bat.');
} else if (cmd === 'disable') {
  if (installed()) ok = mods('disable', ID);
  ok = ok && mods('apply'); // re-applies the remaining enabled mods, or just restores the game if there are none
} else if (cmd === 'status') {
  ok = mods('list');
} else {
  console.log('Commands: enable [--dry-run] | disable | status   (optional: --game "<game dir>")');
}
process.exit(ok ? 0 : 1);
