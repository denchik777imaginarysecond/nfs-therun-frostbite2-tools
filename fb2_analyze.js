'use strict';
/*
 * fb2_analyze.js — structural analysis of Need for Speed: The Run data, looking for cut content.
 *
 * Run (build the index once first: node fb2_extract.js --game "<game dir>" index):
 *   node fb2_analyze.js --game "<game dir>"               — analysis + extraction into output/ + REPORT.md
 *   node fb2_analyze.js --game "<game dir>" --no-extract  — report only
 *
 * What counts as "suspect" (based on data structure, not just words):
 *   1. Orphans            — ebx that NOTHING references and that is not a bundle root.
 *   2. Dangling references — ebx references a GUID that exists nowhere in the game (trace of a removed asset).
 *   3. Phantoms           — paths, levels and cars named in data strings but missing from the game.
 *   4. Dev/Debug/Test     — developer folders (dev, debug, test, proto, temp...) and Debug types.
 *   5. Telling strings    — cheat, unlock, debug, todo, secret... inside ebx.
 * The game files are only read.
 */

const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');
const { parseEbx } = require('./fb2_ebx.js');

const OUT = L.OUT_DIR;
const DB_FILE = path.join(L.OUT_DIR, 'ebx_db.jsonl');
const ORPHAN_EXTRACT_MAX = 10000; // ~250 MB on disk is fine; with more orphans, list them in the report but don't extract
const doExtract = !process.argv.includes('--no-extract');

const DEV_RE = /(^|[\/_])(dev|debug|debugmenu|test|tests|testing|testlevel|proto|prototype|prototypes|temp|tmp|wip|old|unused|cut|deprecated|obsolete|placeholder|sandbox|dummy|cheat|cheats)([\/_]|\d|$)/;
const TALK_RE = /cheat|debug|unlock|secret|easter|hidden|invincib|infinite|god ?mode|todo|fixme|hack|placeholder|do ?n.?t ship|test only|not final|temporary|cut content|remove(d)? (this|before)|dev only|developer/i;
const LEVEL_RE = /level_(\d{4})_([a-z0-9]+)/g;
const PATH_RE = /^[a-z0-9_\-]+(\/[a-z0-9_\-\.]+){2,}$/;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const norm = (s) => s.toLowerCase().replace(/^win32\//, '').replace(/^_c4\//, '');

// ------------------------------------------------------------ 1. index ------
log('reading index...');
const index = L.loadIndex();
const allNames = new Set();       // all ebx/res names (normalized)
const bundleIds = new Set();      // all bundles
const ebxFirst = new Map();       // ebx name -> first entry (where to read it from)
const ebxBundles = new Map();     // ebx name -> number of bundles containing it
const resByName = new Map();      // name -> res entry (a resource usually shares its ebx's name)
for (const e of index) {
  bundleIds.add(norm(e.bundle));
  if (e.kind === 'chunk') continue;
  const n = e.name.toLowerCase();
  allNames.add(norm(n));
  if (e.kind === 'ebx') {
    if (!ebxFirst.has(n)) ebxFirst.set(n, e);
    ebxBundles.set(n, (ebxBundles.get(n) || 0) + 1);
  } else if (!resByName.has(n)) resByName.set(n, e);
}
log(`unique ebx: ${ebxFirst.size}, res: ${resByName.size}, bundles: ${bundleIds.size}`);

// --------------------------------------------------- 2. parse every ebx ----
let db;
if (fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).mtimeMs > fs.statSync(L.INDEX_FILE).mtimeMs) {
  log('using cached parse', DB_FILE);
  db = fs.readFileSync(DB_FILE, 'latin1').split('\n').filter(Boolean).map((l) => JSON.parse(l));
} else {
  log('parsing all ebx (reading in file order, which is faster)...');
  const list = [...ebxFirst.values()].sort((a, b) => (a.sb < b.sb ? -1 : a.sb > b.sb ? 1 : a.pos - b.pos));
  const fds = new Map();
  const out = fs.openSync(DB_FILE, 'w');
  db = [];
  let bad = 0;
  list.forEach((e, i) => {
    if (!fds.has(e.sb)) fds.set(e.sb, fs.openSync(path.join(L.DATA_DIR, e.sb), 'r'));
    let r = null;
    try { r = parseEbx(L.readAsset(fds.get(e.sb), e)); } catch (err) { /* broken — counted below */ }
    if (!r) { bad++; return; }
    const rec = { name: e.name.toLowerCase(), ...r, strings: r.strings.slice(0, 3000) };
    db.push(rec);
    fs.writeSync(out, JSON.stringify(rec) + '\n');
    if (i % 20000 === 0) log(`  ${i}/${list.length}`);
  });
  fs.closeSync(out);
  for (const fd of fds.values()) fs.closeSync(fd);
  log(`parsed ${db.length}, failed ${bad}`);
}

// --------------------------------------------------- 3. reference graph ----
const byGuid = new Map(db.map((r) => [r.guid, r]));
const inbound = new Map();   // guid -> how many files reference it
const dangling = new Map();  // missing guid -> who references it
for (const r of db) {
  for (const g of r.imports) {
    if (byGuid.has(g)) inbound.set(g, (inbound.get(g) || 0) + 1);
    else { if (!dangling.has(g)) dangling.set(g, []); dangling.get(g).push(r.name); }
  }
}
const ROOT_TYPES = new Set(['LevelData', 'SubWorldData', 'BlueprintBundle', 'NFSGameConfiguration', 'GameConfiguration']);
const isBundleRoot = (r) => {
  const n = norm(r.name);
  for (const suf of ['', '_blueprintbundle', '_bundle', '_resourcebundle']) if (bundleIds.has(n + suf)) return true;
  return false;
};
const orphans = db.filter((r) => !inbound.get(r.guid) && !isBundleRoot(r) && !ROOT_TYPES.has(r.type));
const orphanRoots = db.filter((r) => !inbound.get(r.guid) && (isBundleRoot(r) || ROOT_TYPES.has(r.type)));
log(`orphans: ${orphans.length}, unreferenced roots: ${orphanRoots.length}, dangling guids: ${dangling.size}`);

// --------------------------------------------------- 4. phantoms -----------
// Levels that really exist (they have their own .toc/level bundle)
const realLevels = new Set();
for (const b of bundleIds) for (const m of b.matchAll(LEVEL_RE)) if (b.startsWith('levels/')) realLevels.add(m[1] + '_' + m[2]);
const levelMentions = new Map(); // level -> where it is mentioned
const pathPhantoms = new Map();  // missing path -> who mentions it
const talk = [];                 // telling strings
const scanText = (text, where) => {
  const low = text.toLowerCase();
  for (const m of low.matchAll(LEVEL_RE)) {
    const k = m[1] + '_' + m[2];
    if (!levelMentions.has(k)) levelMentions.set(k, new Set());
    if (levelMentions.get(k).size < 30) levelMentions.get(k).add(where);
  }
};
// Does the path exist, or is it an instance INSIDE an existing file ("file/InstanceName")?
const existsOrInside = (p) => {
  const parts = norm(p).split('/');
  for (let i = parts.length; i >= 2; i--) {
    const pre = parts.slice(0, i).join('/');
    if (allNames.has(pre) || bundleIds.has(pre)) return true;
  }
  return false;
};
for (const n of ebxFirst.keys()) scanText(n, n);
for (const n of resByName.keys()) scanText(n, n);
for (const r of db) {
  for (const s of r.strings) {
    scanText(s, r.name);
    const ls = s.toLowerCase();
    if (PATH_RE.test(ls) && !ls.includes('.') && !existsOrInside(ls)) {
      if (!pathPhantoms.has(ls)) pathPhantoms.set(ls, new Set());
      pathPhantoms.get(ls).add(r.name);
    }
    if (TALK_RE.test(s) && s.length < 200) talk.push([r.name, s]);
  }
}
// "level_3000_chicagodowntownpc" is a variant of an existing level, not a cut one
const cutLevels = [...levelMentions.keys()].filter((k) => ![...realLevels].some((r) => k.startsWith(r))).sort();

// Cars: "roster" = ids that have a vehicles/nfs/<id> folder; look for ids of the same shape in names/strings
const roster = new Set();
for (const n of ebxFirst.keys()) { const m = n.match(/vehicles\/nfs\/([a-z0-9_]+)\//); if (m) roster.add(m[1]); }
const makers = new Set([...roster].map((id) => id.split('_')[0]));
const CAR_RE = /\b([a-z]{3})_([a-z0-9]{2,4})_([a-z0-9]{1,4})_(\d{2})\b/g;
const carMentions = new Map();
const scanCars = (text, where) => {
  for (const m of text.toLowerCase().replace(/[\/\-\.]/g, ' ').matchAll(CAR_RE)) {
    const id = m[0];
    if (!makers.has(m[1]) || roster.has(id)) continue;
    if (!carMentions.has(id)) carMentions.set(id, new Set());
    if (carMentions.get(id).size < 20) carMentions.get(id).add(where);
  }
};
for (const n of ebxFirst.keys()) scanCars(n, n);
for (const r of db) for (const s of r.strings) scanCars(s, r.name);
// ids that only appear in map objects (e.g. city lots like "lot_sec4_b_01") are not cars
for (const [id, w] of carMentions) if ([...w].every((x) => x.includes('/worldobjects/'))) carMentions.delete(id);
// engine sound presets — show which cars got engine sounds
const presets = new Set();
for (const n of ebxFirst.keys()) { const m = n.match(/preset_([a-z0-9_]+)/); if (m) presets.add(m[1]); }

// --------------------------------------------------- 5. dev / debug ---------
const dev = db.filter((r) => DEV_RE.test(r.name) || r.types.some((t) => /^Debug|Cheat/i.test(t)));

// --------------------------------------------------- 6. extraction --------
const manifest = [];
const fds = new Map();
function save(category, name) {
  for (const [kind, e] of [['ebx', ebxFirst.get(name)], ['res', resByName.get(name)]]) {
    if (!e) continue;
    try {
      if (!fds.has(e.sb)) fds.set(e.sb, fs.openSync(path.join(L.DATA_DIR, e.sb), 'r'));
      const data = L.readAsset(fds.get(e.sb), e);
      const safe = e.name.replace(/[<>:"|?*]/g, '_').replace(/\.\./g, '_');
      const target = path.join(OUT, category, kind, safe + '.' + kind + (kind === 'res' ? '_' + e.extra : ''));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      manifest.push([category, kind, data.length, path.relative(OUT, target)].join('\t'));
    } catch (err) { manifest.push([category, kind, 'ERROR ' + err.message, e.name].join('\t')); }
  }
}
const groups = {
  '01_dev_debug_test': dev.map((r) => r.name),
  '02_cut_levels': [...ebxFirst.keys()].filter((n) => cutLevels.some((k) => n.includes('level_' + k))),
  '03_cut_vehicles': [...ebxFirst.keys()].filter((n) => [...carMentions.keys()].some((id) => n.includes(id)) || /test_[a-z]+_car/.test(n)),
  '04_orphans': orphans.length <= ORPHAN_EXTRACT_MAX ? orphans.map((r) => r.name) : [],
};
if (doExtract) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [cat, names] of Object.entries(groups)) {
    log(`extracting ${cat}: ${names.length} ebx (+ res with the same names)`);
    for (const n of new Set(names)) save(cat, n);
  }
  for (const fd of fds.values()) fs.closeSync(fd);
  fs.writeFileSync(path.join(OUT, '_manifest.tsv'), 'category\tkind\tbytes\tfile\n' + manifest.join('\n') + '\n');
}

// --------------------------------------------------- 7. report ------------
const count = (arr, key) => { const m = new Map(); for (const x of arr) m.set(key(x), (m.get(key(x)) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
const folder = (n, depth) => norm(n).split('/').slice(0, depth).join('/');
const md = [];
const h = (s) => md.push('', s, '');
const table = (head, rows) => { md.push('| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'); for (const r of rows) md.push('| ' + r.map((x) => String(x).replace(/\|/g, '\\|')).join(' | ') + ' |'); };

md.push('# NFS The Run — hidden and cut content report', '',
  `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by fb2_analyze.js.`, '',
  `Parsed: ${db.length} unique ebx, ${resByName.size} resources, ${bundleIds.size} bundles from ${new Set(index.map((e) => e.sb)).size} .sb files.`, '',
  '> "Orphan", "dangling reference" and "phantom" are structural signals, not proof that content was cut.',
  '> Treat them as candidates. The strongest cases are where several signals agree (e.g. a level with no data of its own but with sound and a bundle).');

h('## 1. Cut levels (mentioned, but no data of their own)');
if (!cutLevels.length) md.push('None found.');
for (const k of cutLevels) {
  md.push(`### Level_${k}`, '', 'Mentioned in:', '');
  for (const w of levelMentions.get(k)) md.push('- `' + w + '`');
  md.push('');
}
md.push(`For comparison, levels that exist in the game (${realLevels.size}): ` + [...realLevels].sort().map((x) => '`' + x + '`').join(', '));

h('## 2. Cars: mentioned, but missing from the roster');
md.push(`Roster (vehicles/nfs folders): ${roster.size} ids. All ebx names and strings were checked for ids of the same shape (maker_model_version_year).`, '');
if (carMentions.size) table(['id', 'mentioned in'], [...carMentions].sort().map(([id, w]) => [id, [...w].slice(0, 4).map((x) => '`' + x + '`').join('<br>')]));
else md.push('No unknown ids found.');
md.push('', '**Test cars in the data:** ' + [...ebxFirst.keys()].filter((n) => /test_[a-z]+_car/.test(n)).slice(0, 20).map((x) => '`' + x + '`').join(', '));
md.push('', `**Engine sound presets (${presets.size})** — show which cars got engine sounds; compare with the roster:`, '', [...presets].sort().map((x) => '`' + x + '`').join(', '));

h('## 3. Debug / Dev / Test content');
md.push(`Found ${dev.length} ebx. By folder:`, '');
table(['folder', 'files'], count(dev, (r) => folder(r.name, 3)).slice(0, 40));
md.push('', '### Highlights: strings from debug/dev assets', '');
for (const r of dev.filter((r) => r.strings.length && /debug|cheat|dev\//.test(r.name)).slice(0, 25)) {
  md.push(`**\`${r.name}\`** (${r.type})`, '', r.strings.slice(0, 40).map((s) => '`' + s.slice(0, 80) + '`').join(' · '), '');
}

h('## 4. Telling strings inside the data');
md.push(`Matches: ${talk.length}. Unique (up to 200):`, '');
{
  const uniq = new Map();
  for (const [n, s] of talk) if (!uniq.has(s)) uniq.set(s, n);
  table(['string', 'asset'], [...uniq].slice(0, 200).map(([s, n]) => ['`' + s.slice(0, 90) + '`', '`' + n + '`']));
}

h('## 5. Phantom paths (name references to things that do not exist)');
{
  // Most phantoms are build noise: names of non-existent *_resourcebundle, source texture paths,
  // typos. Only the ones with a dev/cut/unknown-car signal are listed in detail.
  const all = [...pathPhantoms];
  const noise = all.filter(([p]) => p.endsWith('_resourcebundle'));
  const strong = all.filter(([p]) => !p.endsWith('_resourcebundle') &&
    (DEV_RE.test(p) || cutLevels.some((k) => p.includes(k)) || [...carMentions.keys()].some((id) => p.includes(id))));
  md.push(`Total: ${all.length}; of these, ${noise.length} point to non-existent *_resourcebundle (normal build noise).`,
    'Most of the rest are source paths of textures/sublevels that were merged into other files during the build.', '',
    `**Significant phantoms (${strong.length})** — with dev/test/cut or cut car/level signals:`, '');
  for (const [p, w] of strong.slice(0, 150)) md.push(`- \`${p}\` ← \`${[...w][0]}\``);
  md.push('', 'The rest, by top-level folder:', '');
  table(['folder', 'paths'], count(all.map(([p]) => p), (p) => folder(p, 2)).slice(0, 15));
}

h('## 6. Dangling references (GUIDs that do not exist in the game)');
md.push(`Missing GUIDs: ${dangling.size}. Assets with the most references to removed data:`, '');
table(['asset', 'type', 'lost references'], count([...dangling.values()].flat(), (n) => n).slice(0, 40).map(([n, c]) => ['`' + n + '`', (db.find((r) => r.name === n) || {}).type, c]));

h('## 7. Orphans (nothing references them)');
md.push(`Total ${orphans.length}` + (orphans.length > ORPHAN_EXTRACT_MAX ? ` — more than ${ORPHAN_EXTRACT_MAX}, so they were NOT extracted, only listed.` : ' — extracted to 04_orphans.'), '',
  'Note: the game loads some assets by name rather than by GUID, so not every orphan is cut content.', '');
table(['type', 'count'], count(orphans, (r) => r.type).slice(0, 30));
md.push('');
table(['folder', 'count'], count(orphans, (r) => folder(r.name, 3)).slice(0, 30));
md.push('', `Root assets (levels/bundles) that nothing references: ${orphanRoots.length}.`, '');
table(['asset', 'type'], orphanRoots.filter((r) => DEV_RE.test(r.name) || cutLevels.some((k) => r.name.includes(k))).slice(0, 60).map((r) => ['`' + r.name + '`', r.type]));

h('## 8. What was extracted');
if (doExtract) {
  for (const cat of Object.keys(groups)) {
    const rows = manifest.filter((m) => m.startsWith(cat + '\t'));
    md.push(`- **${cat}** — ${rows.length} files, ${(rows.reduce((s, m) => s + (+m.split('\t')[2] || 0), 0) / 1048576).toFixed(1)} MB`);
  }
  md.push('', 'Full list: `_manifest.tsv`. Resources are named `<name>.res_<type>` (type = hex ResourceType code).',
    'Chunk data (geometry/texture mips; chunks have no names, only GUIDs) was not extracted.');
} else md.push('Run was started with --no-extract.');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'REPORT.md'), md.join('\n') + '\n');
log('report:', path.join(OUT, 'REPORT.md'));
console.log(JSON.stringify({
  ebx: db.length, cutLevels, carsNotInRoster: [...carMentions.keys()], dev: dev.length, talk: talk.length,
  phantoms: pathPhantoms.size, danglingGuids: dangling.size, orphans: orphans.length,
  extracted: Object.fromEntries(Object.keys(groups).map((c) => [c, manifest.filter((m) => m.startsWith(c + '\t')).length])),
}, null, 1));
