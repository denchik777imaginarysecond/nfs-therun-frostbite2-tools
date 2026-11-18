'use strict';
/*
 * fb2_game.js — finds the Need for Speed: The Run folder, so players never have to type a path.
 *
 * Order: --game "<dir>" (passed by the caller) -> NFS_THE_RUN_DIR -> the folder chosen before (game_path.txt next to
 * the tool) -> the Windows registry (EA / Origin install key, installer uninstall entries) -> the usual folders ->
 * a folder picker window (only when allowed). A folder counts as the game when it has Data\Win32.
 * A folder found automatically or chosen in the picker is remembered in game_path.txt; one given with --game is not.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SAVED = path.join(__dirname, 'game_path.txt');
const isGame = (d) => !!d && fs.existsSync(path.join(d, 'Data', 'Win32'));
// the game folder itself, also when its Data folder or a file inside it was chosen
function normalize(d) {
  if (!d) return null;
  d = String(d).trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  if (isGame(d)) return d;
  if (/[\\/]data$/i.test(d) && isGame(path.dirname(d))) return path.dirname(d);
  if (fs.existsSync(d) && fs.statSync(d).isFile() && isGame(path.dirname(d))) return path.dirname(d);
  return null;
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Need For Speed The Run', 'C:\\Program Files\\Need For Speed The Run',
  'C:\\Program Files (x86)\\Origin Games\\Need for Speed The Run', 'C:\\Program Files\\Origin Games\\Need for Speed The Run',
  'C:\\Program Files (x86)\\EA Games\\Need for Speed The Run', 'C:\\Program Files\\EA Games\\Need for Speed The Run',
];

// "reg query" output -> values of the given name
function regValues(key, name, recursive) {
  try {
    const out = execFileSync('reg', ['query', key, ...(recursive ? ['/s'] : []), '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    return out.split(/\r?\n/).map((l) => l.match(/^\s+\S.*?\s+REG_\w+\s+(.*)$/)).filter(Boolean).map((m) => m[1].trim());
  } catch { return []; }
}
function fromRegistry() {
  if (process.platform !== 'win32') return [];
  const found = [];
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node', 'HKLM\\SOFTWARE']) {
    for (const k of ['EA Games\\Need for Speed(TM) The Run', 'EA Games\\Need for Speed The Run', 'Electronic Arts\\Need for Speed The Run']) found.push(...regValues(`${root}\\${k}`, 'Install Dir'));
  }
  // installers (also repacks) register an uninstall entry; take the ones whose folder is the game
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node', 'HKLM\\SOFTWARE']) found.push(...regValues(`${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, 'InstallLocation', true));
  return found;
}

// a folder picker window (PowerShell + Windows Forms); returns the chosen folder or null
function pickFolder() {
  if (process.platform !== 'win32') return null;
  const ps = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
    "$d.Description = 'Where is Need for Speed The Run installed? Choose the game folder (the one with the Data folder).'; " +
    "$d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
  try { return execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

// ask: true -> show the folder picker when nothing was found
function findGame({ arg = null, ask = false } = {}) {
  // a folder given with --game is used for this run only and NOT remembered (a test run must not redirect the player's mods)
  if (arg) { const d = normalize(arg); if (!d) throw new Error(`"${arg}" is not the Need for Speed: The Run folder (it has no Data\\Win32 folder)`); return d; }
  const env = normalize(process.env.NFS_THE_RUN_DIR);
  if (env) return env;
  let saved = null; try { saved = normalize(fs.readFileSync(SAVED, 'utf8')); } catch { /* not chosen before */ }
  if (saved) return saved;
  for (const d of [...fromRegistry(), ...CANDIDATES]) { const n = normalize(d); if (n) { remember(n); return n; } }
  if (ask) {
    console.log('Could not find Need for Speed: The Run automatically. A window opens: please choose the game folder.');
    for (let tries = 0; tries < 3; tries++) {
      const picked = pickFolder();
      if (!picked) break;
      const n = normalize(picked);
      if (n) { remember(n); console.log('Game folder: ' + n + ' (remembered in game_path.txt)'); return n; }
      console.log(`"${picked}" is not the game folder (it has no Data\\Win32 folder). Please choose again.`);
    }
  }
  throw new Error('Could not find Need for Speed: The Run. Run again and choose the game folder, or use --game "<path to the game folder>"');
}
function remember(d) { try { fs.writeFileSync(SAVED, d + '\r\n'); } catch { /* read-only folder: fine */ } }

module.exports = { findGame, normalize, isGame, fromRegistry };

if (require.main === module) {
  try { console.log(findGame({ ask: process.argv.includes('--ask') })); } catch (e) { console.error(e.message); process.exit(1); }
}
