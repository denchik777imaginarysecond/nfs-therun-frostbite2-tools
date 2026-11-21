'use strict';
/*
 * fb2_carport.js — put a car model from a .glb (for example from another game) onto a car of NFS The Run.
 *
 *   node fb2_carport.js --game "<game dir>" <port.json>
 *
 * port.json (next to the .glb) says which car is replaced and where every piece of the new model goes:
 *   {
 *     "name": "BMW M3 GTR", "author": "you",
 *     "car": "che_cam_ss_67",              the car of The Run that is replaced (its id, see output/models or the editor)
 *     "glb": "bmw.glb",                    the new model
 *     "scale": 100,                        size multiplier (the model must end up in metres)
 *     "wheels": "Tire",                    pieces with this in their name are the tyres: used to line the model up
 *                                          with the car's wheels (or give "offset": [x, y, z] in metres yourself)
 *     "rules": [                           first match wins; "match" is a regular expression on "<piece name> <material>"
 *       { "match": "Carpaint", "to": ["BODY_FRONT", "BODY_TOP"], "model": "body" },
 *       { "match": "Glass", "to": ["GLASS_DMG_1", "GLASS_LEFT"], "split": ["default"] },
 *       { "match": "Tire|Hub", "skip": true }
 *     ],
 *     "livery": "Carpaint",              optional: the paint material. ALL paint jobs of the car are always replaced:
 *                                          race liveries (its picture by uv0), garage templates (split into colours),
 *                                          body colours. Found by name (paint/body) when left out; false keeps them.
 *     "keep": { "default": ["DRIVER"] },   parts of a model that stay (the rest of every model is hidden)
 *     "untouched": ["wheelsfront", "wheelsrear"]   models left as they are
 *   }
 * "to" lists the part names (materials of The Run) to use, the first one the model has. With "split": [models] every
 * triangle goes to the model and part (of "to") whose original vertex is nearest: the new hood ends up in the hood model,
 * the windscreen in the breakable glass, ... so the pieces get the bones and damage of the parts they replace. Every model of the car (all body
 * kits, hood and exhaust variants) gets the same treatment. The result is a mod folder "<port.json folder>/mod" with
 * mod.json and one .glb per model: install it with  node fb2_mods.js install <folder>.
 */
const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');
const M = require('./fb2_mesh.js');

// a .glb with one object "lod0"; primitives: { material, positions, normals, uv0, uv1, indices }
function writeGlb(prims) {
  const chunks = [], views = [], accessors = [];
  let off = 0;
  const add = (buf, target) => { const pad = (4 - (buf.length % 4)) % 4; chunks.push(buf, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target }); off += buf.length + pad; return views.length - 1; };
  const floats = (arr, n) => {
    const b = Buffer.alloc(arr.length * 4); arr.forEach((x, i) => b.writeFloatLE(x, i * 4));
    const acc = { bufferView: add(b, 34962), componentType: 5126, count: arr.length / n, type: ['', 'SCALAR', 'VEC2', 'VEC3'][n] };
    if (n === 3) { acc.min = [Infinity, Infinity, Infinity]; acc.max = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i++) { acc.min[i % 3] = Math.min(acc.min[i % 3], arr[i]); acc.max[i % 3] = Math.max(acc.max[i % 3], arr[i]); } }
    accessors.push(acc); return accessors.length - 1;
  };
  const materials = [], primitives = [];
  for (const p of prims) {
    let mi = materials.findIndex((m) => m.name === p.material);
    if (mi < 0) { materials.push({ name: p.material }); mi = materials.length - 1; }
    const ib = Buffer.alloc(p.indices.length * 4); p.indices.forEach((x, i) => ib.writeUInt32LE(x, i * 4));
    accessors.push({ bufferView: add(ib, 34963), componentType: 5125, count: p.indices.length, type: 'SCALAR' });
    const ind = accessors.length - 1;
    const attributes = { POSITION: floats(p.positions, 3) };
    if (p.normals) attributes.NORMAL = floats(p.normals, 3);
    if (p.uv0) attributes.TEXCOORD_0 = floats(p.uv0, 2);
    if (p.uv1) attributes.TEXCOORD_1 = floats(p.uv1, 2);
    primitives.push({ attributes, indices: ind, material: mi });
  }
  const bin = Buffer.concat(chunks);
  const json = { asset: { version: '2.0', generator: 'fb2_carport.js' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'lod0', mesh: 0 }],
    meshes: [{ name: 'lod0', primitives }], materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
}

// ============================================================ textures ===
// The car's own textures (headlight, brakelight, interior, misc, ...) get the new model's pictures. Pieces that end up
// in parts sharing a texture are packed into one picture (an atlas) and their uv0 moved into their place in it.
// Textures used by every car of the game (chassis, glass, tyres) are never changed.
function bakeTextures(index, car, pieces, glbFile, outDir) {
  const TI = require('./fb2_tex_import.js'), T = require('./fb2_texture.js'), W = require('./fb2_ebx_write.js'), E = require('./fb2_ebx_edit.js');
  // 1) the .glb's materials: base colour / emissive pictures, colour factors
  const b = fs.readFileSync(glbFile), jl = b.readUInt32LE(12), j = JSON.parse(b.toString('utf8', 20, 20 + jl)), bin = b.subarray(20 + jl + 8);
  const image = (t) => {
    if (!t) return null;
    const im = j.images[j.textures[t.index].source], v = im.bufferView !== undefined && j.bufferViews[im.bufferView];
    if (!v) return null;
    try { return TI.readPng(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength)); } catch { return null; } // not a PNG (JPEG): a plain colour instead
  };
  const mats = new Map();
  for (const m of j.materials || []) {
    const pb = m.pbrMetallicRoughness || {};
    mats.set(m.name, { base: image(pb.baseColorTexture), emis: image(m.emissiveTexture), factor: pb.baseColorFactor || [1, 1, 1, 1] });
  }
  // 2) which textures each material slot of the car uses (MeshVariationDatabase of the main kit)
  const kitModel = (part) => `_c4/vehicles/nfs/${car}/kits/${car}_kit00_stream_mesh${part}`;
  const sectionsOf = new Map();
  const sections = (part) => { if (!sectionsOf.has(part)) { try { sectionsOf.set(part, M.parseMeshSet(M.resAsGameSees(index, kitModel(part), M.MESH_RES_TYPE)).lods[0].sections); } catch { sectionsOf.set(part, []); } } return sectionsOf.get(part); };
  const names = new Map(); // ebx file GUID -> name (this car's assets only)
  const fds = new Map(), fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  for (const e of index) if (e.kind === 'ebx' && e.name.includes(`/${car}/`) && !names.has(e.name)) names.set(L.readAsset(fdOf(e.sb), e).toString('hex', 0x30, 0x40), e.name);
  for (const fd of fds.values()) fs.closeSync(fd);
  const slots = new Map(); // material index -> { base: [texture names], emis: [texture names] }
  try {
    const d = W.decode(E.readAsGameSees(index, `_c4/vehicles/nfs/${car}/kits/${car}_kit00_stream/meshvariationdb_win32`).data);
    for (const x of d.instances) {
      if (x.value.$type !== 'MeshVariationDatabaseEntry') continue;
      (x.value.Materials || []).forEach((m, mi) => {
        for (const t of m.TextureParameters || []) {
          const r = t.Value, n = r && r.$import !== undefined && names.get(d.imports[r.$import].file);
          if (!n || n.includes('/vinyls/')) continue; // only this car's own textures; liveries are separate
          const slot = /^diffuse$/i.test(t.ParameterName) ? 'base' : /^emis(sive)?$/i.test(t.ParameterName) ? 'emis' : null;
          if (!slot) continue;
          if (!slots.has(mi)) slots.set(mi, { base: new Set(), emis: new Set() });
          slots.get(mi)[slot].add(n);
        }
      });
    }
  } catch { console.log('  no texture table found for this car: textures are not changed'); return []; }
  // 3) the part (material slot) of every piece, as in the main kit
  for (const p of pieces) {
    if (!p.rule || p.rule.skip) continue;
    if (p.rule.uv === 'game') { p.slot = null; continue; } // keeps the game's own texture layout
    const part = p.part || p.rule.model || 'body', secs = sections(part);
    const name = [p.section, ...(p.rule.to || [])].find((t) => t && secs.some((s) => s.material === t));
    const sec = secs.find((s) => s.material === name);
    p.slot = sec ? sec.materialIndex : null;
  }
  // 4) groups of slots that share a texture: one atlas each
  const used = [...new Set(pieces.filter((p) => p.slot !== null && p.slot !== undefined && slots.has(p.slot) && slots.get(p.slot).base.size).map((p) => p.slot))];
  const groups = [];
  for (const s of used) {
    const tex = new Set([...slots.get(s).base, ...slots.get(s).emis]);
    const g = groups.find((x) => [...tex].some((t) => x.tex.has(t)));
    if (g) { g.slots.add(s); tex.forEach((t) => g.tex.add(t)); } else groups.push({ slots: new Set([s]), tex });
  }
  const changes = [];
  groups.forEach((g, gi) => {
    const members = pieces.filter((p) => g.slots.has(p.slot));
    // one entry per material: its picture, or a plain colour (no picture, or a picture repeated as tiles)
    const entries = new Map();
    for (const p of members) {
      if (entries.has(p.material)) continue;
      const m = mats.get(p.material) || { base: null, emis: null, factor: [0.5, 0.5, 0.5, 1] };
      const uv = p.uv0 || [], inside = uv.every((u) => u[0] > -0.02 && u[0] < 1.02 && u[1] > -0.02 && u[1] < 1.02);
      const avg = (img) => { const s = [0, 0, 0]; for (let i = 0; i < img.rgba.length; i += 4) for (let k = 0; k < 3; k++) s[k] += img.rgba[i + k]; return s.map((x) => x / (img.w * img.h)); };
      const colour = (m.base ? avg(m.base) : [255, 255, 255]).map((x, k) => Math.round(Math.min(255, x * m.factor[k])));
      if (m.base && inside && uv.length) {
        const sc = Math.min(1, 1024 / Math.max(m.base.w, m.base.h)), w = Math.max(8, Math.round(m.base.w * sc)), h = Math.max(8, Math.round(m.base.h * sc));
        const tint = (img) => { const o = TI.resize(img.rgba, img.w, img.h, w, h); for (let i = 0; i < o.length; i += 4) for (let k = 0; k < 3; k++) o[i + k] = Math.min(255, Math.round(o[i + k] * m.factor[k])); return o; };
        // glow: only where the model's emissive picture is brighter than its colour (bulbs, reflectors), as grey
        const base = tint(m.base);
        let emis = null;
        if (m.emis) {
          emis = TI.resize(m.emis.rgba, m.emis.w, m.emis.h, w, h);
          for (let i = 0; i < emis.length; i += 4) { const d = Math.max(0, Math.min(255, 2 * ((emis[i] + emis[i + 1] + emis[i + 2]) - (base[i] + base[i + 1] + base[i + 2])) / 3)); emis[i] = emis[i + 1] = emis[i + 2] = d; emis[i + 3] = 255; }
        }
        entries.set(p.material, { w, h, base, emis });
      } else {
        // a plain colour; a lamp lens without a picture glows in its own colour
        const fill = (c) => { const o = Buffer.alloc(16 * 16 * 4); for (let i = 0; i < 256; i++) { o[i * 4] = c[0]; o[i * 4 + 1] = c[1]; o[i * 4 + 2] = c[2]; o[i * 4 + 3] = 255; } return o; };
        entries.set(p.material, { w: 16, h: 16, base: fill(colour), emis: !m.base && [...g.tex].some((t) => /emis/.test(t)) ? fill([255, 255, 255]) : null, solid: true });
      }
    }
    // shelf packing into the smallest square that holds everything (at most 2048)
    const list = [...entries.values()].sort((a, c) => c.h - a.h);
    let S = 64;
    const pack = (S) => { let x = 0, y = 0, row = 0; for (const e of list) { if (e.w > S) return false; if (x + e.w > S) { x = 0; y += row; row = 0; } e.x = x; e.y = y; x += e.w; row = Math.max(row, e.h); } return y + row <= S; };
    while (!pack(S)) {
      if (S < 2048) { S *= 2; continue; }
      for (const e of list) if (!e.solid) { const w = Math.max(8, e.w >> 1), h = Math.max(8, e.h >> 1); e.base = TI.resize(e.base, e.w, e.h, w, h); if (e.emis) e.emis = TI.resize(e.emis, e.w, e.h, w, h); e.w = w; e.h = h; }
    }
    const baseImg = Buffer.alloc(S * S * 4), emisImg = Buffer.alloc(S * S * 4);
    for (let i = 3; i < baseImg.length; i += 4) { baseImg[i] = 255; emisImg[i] = 255; }
    for (const e of list) for (let y = 0; y < e.h; y++) {
      e.base.copy(baseImg, ((e.y + y) * S + e.x) * 4, y * e.w * 4, (y + 1) * e.w * 4);
      if (e.emis) e.emis.copy(emisImg, ((e.y + y) * S + e.x) * 4, y * e.w * 4, (y + 1) * e.w * 4);
    }
    for (let i = 3; i < baseImg.length; i += 4) baseImg[i] = 255; // no transparency in these textures
    // uv0 into the atlas (half a pixel inside each picture, so neighbours do not bleed in); uv1 keeps the original
    for (const p of members) {
      const e = entries.get(p.material);
      if (!p.uv1) p.uv1 = p.uv0 ? p.uv0.map((u) => u.slice()) : null;
      p.uv0 = (p.uv0 || p.positions.map(() => [0.5, 0.5])).map((u) => {
        const cu = e.solid ? 0.5 : Math.min(1, Math.max(0, u[0])), cv = e.solid ? 0.5 : Math.min(1, Math.max(0, u[1]));
        return [(e.x + 0.5 + cu * (e.w - 1)) / S, (e.y + 0.5 + cv * (e.h - 1)) / S];
      });
    }
    const file = `atlas${gi + 1}`;
    fs.writeFileSync(path.join(outDir, file + '.png'), T.encodePng(baseImg, S, S, true));
    const hasEmis = list.some((e) => e.emis);
    // the game's glow textures are masks, one switch per colour channel; copy the scheme of the car's own texture:
    // headlights: red = blue (green unused); rear lights: red = tail, red+blue = brake, green = reverse
    const glowFile = (t) => {
      let scheme = 'grey';
      try {
        const h = M.resAsGameSees(index, t, '5c4954a6'), w = h.readUInt16LE(0x10), hh = h.readUInt16LE(0x12);
        const o = T.decodePixels(h.readUInt32LE(8), M.chunkData(index, h.toString('hex', 0x1c, 0x2c)), w, hh);
        let g = 0, rb = 0, same = 0;
        for (let i = 0; i < o.length; i += 4) { if (o[i + 1] > 64 && o[i] < 64) g++; if (o[i] > 64 || o[i + 2] > 64) { rb++; if (Math.abs(o[i] - o[i + 2]) < 16) same++; } }
        scheme = g > 0 ? 'rear' : rb && same === rb ? 'front' : 'grey';
      } catch { /* keep grey */ }
      const out = Buffer.alloc(S * S * 4);
      for (let i = 0; i < out.length; i += 4) {
        const e = emisImg[i], r = baseImg[i], gg = baseImg[i + 1], b = baseImg[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        out[i + 3] = 255;
        if (scheme === 'front') { out[i] = out[i + 2] = e; }
        else if (scheme === 'rear') {
          if (r > 1.4 * Math.max(gg, b) && r > 60) { out[i] = out[i + 2] = e; } // red glass: tail light and brake
          else if (mx - mn < 40 && mx > 150) out[i + 1] = Math.max(e, 200); // white sections: reversing light
        } else out[i] = out[i + 1] = out[i + 2] = e;
      }
      const f = `${file}_glow_${scheme}.png`;
      if (!fs.existsSync(path.join(outDir, f))) fs.writeFileSync(path.join(outDir, f), T.encodePng(out, S, S, true));
      return f;
    };
    // the alpha channel of the car's textures is not transparency but a strength (gloss, reflections): keep the
    // original texture's average (the interior's is about 0: a white alpha made it shine like chrome)
    const baseFile = (t) => {
      let alpha = 255;
      try {
        const h = M.resAsGameSees(index, t, '5c4954a6'), f = h.readUInt32LE(8), w = h.readUInt16LE(0x10), hh = h.readUInt16LE(0x12);
        if (![1, 2, 9].includes(f)) return file + '.png'; // no alpha in this format
        const o = T.decodePixels(f, M.chunkData(index, h.toString('hex', 0x1c, 0x2c)), w, hh);
        let sum = 0; for (let i = 3; i < o.length; i += 4) sum += o[i];
        alpha = Math.round(sum / (w * hh));
      } catch { return file + '.png'; }
      if (alpha >= 250) return file + '.png';
      const f = `${file}_a${alpha}.png`;
      if (!fs.existsSync(path.join(outDir, f))) { const o = Buffer.from(baseImg); for (let i = 3; i < o.length; i += 4) o[i] = alpha; fs.writeFileSync(path.join(outDir, f), T.encodePng(o, S, S, false)); }
      return f;
    };
    const slotNames = [...g.slots].map((s) => [...new Set(pieces.filter((p) => p.slot === s).map((p) => p.section || (p.rule.to || [])[0]))].join('/')).join(', ');
    for (const s of g.slots) {
      for (const t of slots.get(s).base) if (!changes.some((c) => c.asset === t)) changes.push({ type: 'texture', asset: t, png: baseFile(t), size: 'png' });
      for (const t of slots.get(s).emis) if (!changes.some((c) => c.asset === t)) changes.push({ type: 'texture', asset: t, png: glowFile(t), size: 'png' });
    }
    console.log(`Textures: ${slotNames} <- ${[...entries.keys()].join(', ')} (${S}x${S}${hasEmis ? ', with glow' : ''})`);
  });
  return changes;
}

const mulPoint = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const mulDir = (m, v) => { const r = [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]; const l = Math.hypot(...r) || 1; return r.map((x) => x / l); };

function port(index, cfgFile) {
  const dir = path.dirname(path.resolve(cfgFile)), cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const car = cfg.car, scale = cfg.scale || 1;
  const objs = M.readGlb(fs.readFileSync(path.join(dir, cfg.glb)));
  const rules = (cfg.rules || []).map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));
  // every piece in world space (metres): [{ name, material, positions, normals, uv0, uv1, indices }]
  const pieces = [];
  for (const o of objs) for (const p of o.primitives) {
    const flip = (() => { const m = o.matrix; return (m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])) < 0; })();
    const idx = p.indices || p.positions.map((_, i) => i);
    const indices = [];
    for (let k = 0; k + 2 < idx.length; k += 3) flip ? indices.push(idx[k], idx[k + 2], idx[k + 1]) : indices.push(idx[k], idx[k + 1], idx[k + 2]);
    pieces.push({ name: o.name, material: p.material || '', positions: p.positions.map((v) => mulPoint(o.matrix, v).map((x) => x * scale)),
      normals: p.normals && p.normals.map((n) => mulDir(o.matrix, n)), uv0: p.uv0, uv1: p.uv1, indices });
  }
  // line the model up with the car's wheels (both in glTF axes: y up, z forward; mirroring x does not matter here)
  let offset = cfg.offset;
  const gameWheels = (() => {
    const W = require('./fb2_ebx_write.js'), E = require('./fb2_ebx_edit.js'), out = [];
    try { for (const x of W.decode(E.readAsGameSees(index, `_c4/vehicles/nfs/${car}/kits/${car}_kit00`).data).instances) if (x.value.$type === 'RaceWheelComponentData' && x.value.Transform && x.value.Transform.trans) { const t = x.value.Transform.trans; out.push([t.x, t.y, t.z]); } } catch { /* no kit ebx */ }
    return out;
  })();
  if (!offset && cfg.wheels) {
    const re = new RegExp(cfg.wheels, 'i'), pts = pieces.filter((p) => re.test(p.name + ' ' + p.material)).flatMap((p) => p.positions);
    if (!pts.length || gameWheels.length < 4) throw new Error('cannot line up the wheels: no tyre pieces in the .glb or no wheels in the game car; give "offset" instead');
    const centre = (sel) => { const q = pts.filter(sel); const mn = [0, 1, 2].map((k) => Math.min(...q.map((p) => p[k]))), mx = [0, 1, 2].map((k) => Math.max(...q.map((p) => p[k]))); return mn.map((x, k) => (x + mx[k]) / 2); };
    const front = centre((p) => p[2] > 0), rear = centre((p) => p[2] < 0);
    const gf = gameWheels.filter((p) => p[2] > 0), gr = gameWheels.filter((p) => p[2] < 0), avg = (a, k) => a.reduce((s, p) => s + p[k], 0) / a.length;
    offset = [0, (avg(gf, 1) + avg(gr, 1)) / 2 - (front[1] + rear[1]) / 2, (avg(gf, 2) + avg(gr, 2)) / 2 - (front[2] + rear[2]) / 2];
    console.log(`Wheelbase: new model ${(front[2] - rear[2]).toFixed(3)} m, ${car} ${(avg(gf, 2) - avg(gr, 2)).toFixed(3)} m. Model moved by [${offset.map((x) => x.toFixed(3)).join(', ')}] m.`);
  }
  offset = offset || [0, 0, 0];
  for (const p of pieces) p.positions = p.positions.map((v) => v.map((x, k) => x + offset[k]));
  // wheel centres of the new model (glTF axes, after the offset). The game's wheel models hold ONE wheel at the origin
  // with its outer face towards game +x (= glTF -x); the game places it at each wheel and mirrors it for the other side.
  const corners = {};
  if (cfg.wheels) {
    const re = new RegExp(cfg.wheels, 'i'), pts = pieces.filter((p) => re.test(p.name + ' ' + p.material)).flatMap((p) => p.positions);
    const centre = (sel) => { const q = pts.filter(sel); if (!q.length) return null; const mn = [0, 1, 2].map((k) => q.reduce((m, p) => Math.min(m, p[k]), Infinity)), mx = [0, 1, 2].map((k) => q.reduce((m, p) => Math.max(m, p[k]), -Infinity)); return mn.map((x, k) => (x + mx[k]) / 2); };
    corners.front = centre((p) => p[2] > 0 && p[0] < 0); corners.rear = centre((p) => p[2] < 0 && p[0] < 0);
  }
  // which rule does each piece follow?
  const unmatched = new Set();
  for (const p of pieces) { p.rule = rules.find((r) => r.re.test(p.name + ' ' + p.material)); if (!p.rule) unmatched.add(p.material); }
  if (unmatched.size) console.log('Pieces without a rule (left out):', [...unmatched].join(', '));
  // "copies": [{ "model", "to" }]: the same piece also goes there, e.g. glass: the glass layer and, on top of it,
  // the layers the game draws cracks on (the game's own cars have these as identical copies)
  for (const p of [...pieces]) for (const c of (p.rule && p.rule.copies) || []) pieces.push({ ...p, rule: { ...c, re: p.rule.re } });

  // "split": [models]: every triangle goes to the part (model + material from "to") whose original vertex is nearest,
  // so the new hood lands in the hood model, the front in the bumper, ... and gets their bones and damage.
  // The layout of the main kit (kit00) decides; the other kits use the same choice by part name.
  const kit00 = (part) => index.find((e) => e.kind === 'res' && e.extra === M.MESH_RES_TYPE && e.name === `_c4/vehicles/nfs/${car}/kits/${car}_kit00_stream_mesh${part}`);
  const splitCache = new Map();
  const splitTargets = (rule) => {
    const key = JSON.stringify([rule.split, rule.to]);
    if (splitCache.has(key)) return splitCache.get(key);
    const pts = []; // { p: [x,y,z] in glTF axes, part, material }
    for (const part of rule.split) {
      const e = kit00(part); if (!e) continue;
      const mesh = M.parseMeshSet(M.resAsGameSees(index, e.name, M.MESH_RES_TYPE)), lod = mesh.lods[0];
      for (const s of M.readGeometry(lod, M.lodData(index, mesh, lod))) {
        if (!rule.to.includes(s.material)) continue;
        for (const v of s.vertices) if (v.position) pts.push({ p: [-v.position[0], v.position[1], v.position[2]], part, material: s.material }); // game -> glTF: mirror x
      }
    }
    if (!pts.length) throw new Error(`split: none of ${rule.to.join(', ')} found in ${rule.split.join(', ')}`);
    const size = 0.15, cell = (p) => p.map((x) => Math.floor(x / size)), grid = new Map();
    for (const t of pts) { const c = cell(t.p).join(','); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(t); }
    const nearest = (q, only) => { // only: keep candidates for which only(t) is true
      const c = cell(q); let best = null, bd = Infinity;
      for (let r = 0; r < 40; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          for (const t of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) || []) { if (only && !only(t)) continue; const d = (t.p[0] - q[0]) ** 2 + (t.p[1] - q[1]) ** 2 + (t.p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = t; } }
        }
        if (best && ((r) * size) ** 2 > bd) break;
      }
      return best;
    };
    splitCache.set(key, nearest);
    return nearest;
  };
  const splitPieces = [];
  for (const p of pieces) {
    if (!p.rule || p.rule.skip || !p.rule.split) { splitPieces.push(p); continue; }
    const nearest = splitTargets(p.rule), groups = new Map();
    for (let k = 0; k < p.indices.length; k += 3) {
      const tri = [p.indices[k], p.indices[k + 1], p.indices[k + 2]];
      const c = [0, 1, 2].map((a) => (p.positions[tri[0]][a] + p.positions[tri[1]][a] + p.positions[tri[2]][a]) / 3);
      let t = nearest(c);
      // "near" (metres): a triangle goes to a moving part (bumper, door, ...) only when it is that close to it; otherwise it
      // stays with the first model of "split" (the body), so big panels do not swing with a small bumper
      if (p.rule.near && t.part !== p.rule.split[0] && Math.hypot(t.p[0] - c[0], t.p[1] - c[1], t.p[2] - c[2]) > p.rule.near) t = nearest(c, (x) => x.part === p.rule.split[0]) || t;
      const g = t.part + '|' + t.material;
      if (!groups.has(g)) groups.set(g, []); groups.get(g).push(tri);
    }
    for (const [g, tris] of groups) {
      // a piece of its own with only the vertices it uses
      const map = new Map(), sub = { name: p.name, material: p.material, rule: p.rule, positions: [], normals: p.normals ? [] : null, uv0: p.uv0 ? [] : null, uv1: p.uv1 ? [] : null, indices: [] };
      [sub.part, sub.section] = g.split('|');
      for (const tri of tris) for (const i of tri) {
        if (!map.has(i)) { map.set(i, sub.positions.length); sub.positions.push(p.positions[i]); if (sub.normals) sub.normals.push(p.normals[i]); if (sub.uv0) sub.uv0.push(p.uv0[i]); if (sub.uv1) sub.uv1.push(p.uv1[i]); }
        sub.indices.push(map.get(i));
      }
      splitPieces.push(sub);
    }
  }
  pieces.length = 0; pieces.push(...splitPieces);
  // "wheel": true: the part of the piece around one wheel (front for wheelsfront and a single "wheels" model, rear for
  // wheelsrear), moved so that wheel's centre is at the origin
  const wheelPieces = [];
  for (const p of pieces) {
    if (!p.rule || !p.rule.wheel) { wheelPieces.push(p); continue; }
    if (!corners.front || !corners.rear) throw new Error('"wheel" rules need "wheels" (which pieces are the tyres) to find the wheels');
    for (const [part, c] of [['wheelsfront', corners.front], ['wheelsrear', corners.rear], ['wheels', corners.front]]) {
      const map = new Map(), sub = { ...p, part, positions: [], normals: p.normals ? [] : null, uv0: p.uv0 ? [] : null, uv1: p.uv1 ? [] : null, indices: [] };
      for (let k = 0; k + 2 < p.indices.length; k += 3) {
        const t = [p.indices[k], p.indices[k + 1], p.indices[k + 2]];
        const cc = [0, 1, 2].map((a) => (p.positions[t[0]][a] + p.positions[t[1]][a] + p.positions[t[2]][a]) / 3);
        if (Math.hypot(cc[0] - c[0], cc[1] - c[1], cc[2] - c[2]) > (p.rule.radius || 0.45)) continue;
        for (const i of t) {
          if (!map.has(i)) { map.set(i, sub.positions.length); sub.positions.push(p.positions[i].map((x, a) => x - c[a])); if (sub.normals) sub.normals.push(p.normals[i]); if (sub.uv0) sub.uv0.push(p.uv0[i]); if (sub.uv1) sub.uv1.push(p.uv1[i]); }
          sub.indices.push(map.get(i));
        }
      }
      if (sub.indices.length) wheelPieces.push(sub);
    }
  }
  pieces.length = 0; pieces.push(...wheelPieces);
  if (corners.front) console.log(`Wheels: front ${corners.front.map((x) => x.toFixed(3)).join(', ')}, rear ${corners.rear.map((x) => x.toFixed(3)).join(', ')} (glTF axes)`);
  const share = new Map(); for (const p of pieces) if (p.part && p.section) share.set(`${p.part} ${p.section}`, (share.get(`${p.part} ${p.section}`) || 0) + p.indices.length / 3);
  if (share.size) console.log('Split by nearest part:', [...share].map(([k, v]) => `${k} ${v}`).join(', '));

  const outDir = path.join(dir, 'mod'); fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const textureChanges = cfg.textures === false ? [] : bakeTextures(index, car, pieces, path.join(dir, cfg.glb), outDir);

  // every model of the car: all kits, hood and exhaust variants
  const models = [...new Set(index.filter((e) => e.kind === 'res' && e.extra === M.MESH_RES_TYPE && e.name.includes(`/${car}/`) && e.name.includes('_stream_mesh')).map((e) => e.name))].sort();
  const changes = [...textureChanges], glbCache = new Map();
  // "livery": "<material>": that material's picture (the model's own paint job, laid out by its uv0) becomes every
  // livery of the car: the game draws the livery picture (vinyl) over the body colour by uv0, opaque = picture only
  // Agreed rule: a model that replaces a car always gets ALL of that car's paint jobs (race liveries, garage templates,
  // body colours). "livery" names the paint material; without it the material is found by name (paint / body), or
  // else it is the material covering most of the body. Only "livery": false keeps the car's own paint jobs.
  if (cfg.livery !== false) {
    const TI = require('./fb2_tex_import.js'), T = require('./fb2_texture.js');
    const b = fs.readFileSync(path.join(dir, cfg.glb)), jl = b.readUInt32LE(12), j = JSON.parse(b.toString('utf8', 20, 20 + jl)), bin = b.subarray(20 + jl + 8);
    const mats = j.materials || [], hasPic = (x) => !!(x.pbrMetallicRoughness && x.pbrMetallicRoughness.baseColorTexture);
    const want = cfg.livery ? new RegExp(cfg.livery, 'i') : /car.?paint|paint|body|exterior/i;
    let m = mats.find((x) => want.test(x.name || '') && hasPic(x)) || mats.find((x) => want.test(x.name || ''));
    if (!m) { // the material covering most of the painted body parts
      const area = new Map();
      for (const p of pieces) if (p.rule && !p.rule.skip && /^BODY_/.test(p.section || (p.rule.to || [])[0] || '')) area.set(p.material, (area.get(p.material) || 0) + p.indices.length);
      const top = [...area].sort((a, b) => b[1] - a[1])[0];
      m = top && mats.find((x) => x.name === top[0]);
    }
    if (!m) throw new Error('livery: no paint material found; name it with "livery": "<material name>"');
    const re = new RegExp('^' + (m.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    // its picture, or (no picture, or not a PNG) a plain picture of its colour
    let img = null;
    if (hasPic(m)) {
      const v = j.bufferViews[j.images[j.textures[m.pbrMetallicRoughness.baseColorTexture.index].source].bufferView];
      try { img = TI.readPng(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength)); } catch { console.log('  livery picture is not a PNG: using its colour'); }
    }
    if (!img) {
      const f = (m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorFactor) || [0.5, 0.5, 0.5, 1];
      const c = f.slice(0, 3).map((x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))); // linear -> sRGB
      img = { w: 16, h: 16, rgba: Buffer.alloc(16 * 16 * 4) };
      for (let i = 0; i < 256; i++) { img.rgba[i * 4] = c[0]; img.rgba[i * 4 + 1] = c[1]; img.rgba[i * 4 + 2] = c[2]; img.rgba[i * 4 + 3] = 255; }
    }
    const pow2 = (x) => Math.min(2048, 2 ** Math.round(Math.log2(Math.max(4, x)))); // the game needs powers of two
    const w = pow2(img.w), h = pow2(img.h), px = TI.resize(img.rgba, img.w, img.h, w, h);
    for (let i = 3; i < px.length; i += 4) px[i] = 255; // opaque: the picture covers the body colour everywhere
    fs.writeFileSync(path.join(outDir, 'livery.png'), T.encodePng(px, w, h, false));
    const vinyls = [...new Set(index.filter((e) => e.kind === 'res' && e.extra === '5c4954a6' && e.name.startsWith(`_c4/vehicles/nfs/${car}/vinyls/`)).map((e) => e.name))];
    for (const n of vinyls) changes.push({ type: 'texture', asset: n, png: 'livery.png', size: 'png' });
    console.log(`Livery: ${m.name} (${img.w}x${img.h} -> ${w}x${h}) on all ${vinyls.length} livery pictures of ${car}`);

    // The garage builds its preview from vinyl templates (NfsVinylTextureAsset): a stack of layers, each a grey mask
    // (where) filled with one colour (Color0). The livery picture is split into as many colours as a template has
    // layers (k-means); each layer gets the mask of its colour (smooth edges) and that colour.
    const W = require('./fb2_ebx_write.js'), E = require('./fb2_ebx_edit.js');
    const names = new Map(), fds = new Map(), fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
    for (const e of index) if (e.kind === 'ebx' && e.name.includes('/textures/vinyls/') && !names.has(e.name)) names.set(L.readAsset(fdOf(e.sb), e).toString('hex', 0x30, 0x40), e.name);
    for (const fd of fds.values()) fs.closeSync(fd);
    const templates = new Set(); // vinyl texture assets used by this car's vinyl templates
    for (const n of new Set(index.filter((e) => e.kind === 'ebx' && e.name.startsWith(`_c4/vehicles/nfs/${car}/vinyls/`)).map((e) => e.name))) {
      let d; try { d = W.decode(E.readAsGameSees(index, n).data); } catch { continue; }
      for (const x of d.instances) if (x.value.$type === 'NfsVinylTemplateItem' && x.value.Texture && x.value.Texture.$import !== undefined) { const t = names.get(d.imports[x.value.Texture.$import].file); if (t) templates.add(t); }
    }
    const S = 512, dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const quant = new Map(); // number of colours -> { colours, files }
    // the garage lays the template by uv0 like races, but upside down (a garage screenshot with the picture as it is
    // matched the livery turned upside down: white roof, striped hood). So the picture is flipped first.
    const G = 1024, flipped = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) px.copy(flipped, (h - 1 - y) * w * 4, y * w * 4, (y + 1) * w * 4);
    const gpx = TI.resize(flipped, w, h, G, G), hit = new Uint8Array(G * G).fill(1);
    fs.writeFileSync(path.join(outDir, 'garage_paint_preview.png'), T.encodePng(gpx, G, G, false)); // for checking by eye
    const quantize = (K) => {
      if (quant.has(K)) return quant.get(K);
      const pts = []; for (let i = 0; i < gpx.length; i += 4 * 17) if (hit[i / 4]) pts.push([gpx[i], gpx[i + 1], gpx[i + 2]]);
      const cs = [pts[0].slice()]; // start: colours far apart from each other
      while (cs.length < K) { let best = pts[0], bd = -1; for (const p of pts) { const d = Math.min(...cs.map((c) => dist2(p, c))); if (d > bd) { bd = d; best = p; } } cs.push(best.slice()); }
      for (let it = 0; it < 15; it++) { // k-means
        const sum = cs.map(() => [0, 0, 0, 0]);
        for (const p of pts) { let k = 0, bd = Infinity; cs.forEach((c, j) => { const d = dist2(p, c); if (d < bd) { bd = d; k = j; } }); sum[k][0] += p[0]; sum[k][1] += p[1]; sum[k][2] += p[2]; sum[k][3]++; }
        sum.forEach((s, j) => { if (s[3]) cs[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
      }
      // masks at the template's size: share of the full-size pixels of each colour in every mask pixel (smooth edges)
      // places of the layout no painted triangle reaches take the colour that covers most of the body
      const counts = cs.map(() => 0);
      for (let i = 0; i < G * G; i++) if (hit[i]) { const p = [gpx[i * 4], gpx[i * 4 + 1], gpx[i * 4 + 2]]; let k = 0, bd = Infinity; cs.forEach((c, j) => { const d = dist2(p, c); if (d < bd) { bd = d; k = j; } }); counts[k]++; }
      const main = counts.indexOf(Math.max(...counts));
      const cover = cs.map(() => new Float32Array(S * S)), f = G / S, n = f * f;
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        const i = (y * G + x) * 4;
        let k = main;
        if (hit[y * G + x]) { const p = [gpx[i], gpx[i + 1], gpx[i + 2]]; let bd = Infinity; cs.forEach((c, j) => { const d = dist2(p, c); if (d < bd) { bd = d; k = j; } }); }
        cover[k][Math.floor(y / f) * S + Math.floor(x / f)] += 1 / n;
      }
      const files = cover.map((cv, j) => {
        // the game's masks are inverted: black = the layer is here, white = empty (proven in-game with coloured bands);
        // layers are stacked in list order, the last on top
        const o = Buffer.alloc(S * S * 4); for (let i = 0; i < S * S; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = Math.round((1 - Math.min(1, cv[i])) * 255); o[i * 4 + 3] = 255; }
        const f = `vinyl_${K}colours_${j}.png`; fs.writeFileSync(path.join(outDir, f), T.encodePng(o, S, S, true)); return f;
      });
      const r = { colours: cs.map((c) => c.map((v) => Math.round(v))), files };
      quant.set(K, r); return r;
    };
    let layersDone = 0;
    for (const t of templates) {
      let d; try { d = W.decode(E.readAsGameSees(index, t).data); } catch { continue; }
      const layers = d.instances.map((x, i) => ({ x, i })).filter(({ x }) => x.value.$type === 'VinylLayer');
      if (!layers.length) continue;
      const q = quantize(layers.length);
      layers.forEach(({ x, i }, j) => {
        const r = x.value.Texture && x.value.Texture.$import !== undefined && names.get(d.imports[x.value.Texture.$import].file);
        const res = r && [r, r + '_win32'].find((n) => index.some((e) => e.kind === 'res' && e.extra === '5c4954a6' && e.name === n));
        if (res) changes.push({ type: 'texture', asset: res, png: q.files[j] }); // keeps the mask's own size
        const c = q.colours[j], set = {};
        // layer colours are plain picture colours / 255 (the game's own are exact multiples of 1/255, e.g. 128/255; a
        // linear conversion was tried in-game and came out far too dark)
        if ((x.value.Data.Effects || []).length) ['x', 'y', 'z'].forEach((k, ch) => { set[`Data.Effects.0.Color0.${k}`] = +(c[ch] / 255).toFixed(4); });
        if (Object.keys(set).length) changes.push({ type: 'ebx', asset: t, instance: i, set });
        layersDone++;
      });
    }
    const masks = { size: layersDone };
    // the main paint colour: the picture's colour at the centres of the painted triangles, weighted by their size
    // (vertices sit on the edges of the picture's islands, where the unused background shows)
    const samples = [];
    for (const p of pieces) {
      if (!re.test(p.material) || !p.uv0 || (p.rule && p.rule.skip)) continue;
      for (let k = 0; k + 2 < p.indices.length; k += 3) {
        const [a, b2, c] = [p.indices[k], p.indices[k + 1], p.indices[k + 2]].map((i) => p.positions[i]);
        const area = Math.hypot(...[0, 1, 2].map((q) => { const e1 = b2.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]); return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]][q]; })) / 2;
        const uv = [0, 1].map((q) => (p.uv0[p.indices[k]][q] + p.uv0[p.indices[k + 1]][q] + p.uv0[p.indices[k + 2]][q]) / 3);
        const u = Math.min(w - 1, Math.max(0, Math.floor(uv[0] * w))), v = Math.min(h - 1, Math.max(0, Math.floor(uv[1] * h))), i = (v * w + u) * 4;
        samples.push({ c: [px[i], px[i + 1], px[i + 2]], area });
      }
    }
    // weighted median of each channel
    const med = [0, 1, 2].map((ch) => { const s = samples.map((q) => [q.c[ch], q.area]).sort((x, y) => x[0] - y[0]); const half = s.reduce((t, q) => t + q[1], 0) / 2; let acc = 0; for (const [val, ar] of s) { acc += ar; if (acc >= half) return val; } return 0; });
    const lin = med.map((c) => +(((c / 255) <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)).toFixed(4)); // the game's colours are linear
    let liveries = 0;
    for (const n of new Set(index.filter((e) => e.kind === 'ebx' && e.name.startsWith(`_c4/vehicles/nfs/${car}/liveries/`)).map((e) => e.name))) {
      let d; try { d = W.decode(E.readAsGameSees(index, n).data); } catch { continue; }
      const live = d.instances.find((x) => x.value.$type === 'NfsVehicleLiveryData'); if (!live) continue;
      const set = {};
      live.value.PaintInstanceData.forEach((pi, i) => {
        if (!/Car_Vinyl|CarPaintMisc/i.test(pi.ShaderName)) return;
        pi.VectorParameters.forEach((q, j) => { if (q.ParameterName === 'paintColor') ['x', 'y', 'z'].forEach((k, c) => { set[`PaintInstanceData.${i}.VectorParameters.${j}.Value.${k}`] = lin[c]; }); });
      });
      if (Object.keys(set).length) { changes.push({ type: 'ebx', asset: n, where: { $type: 'NfsVehicleLiveryData' }, set }); liveries++; }
    }
    console.log(`Garage: livery split into ${[...quant.keys()].sort().join("/")} colours for ${templates.size} vinyl templates (${masks.size} layers); body colour of ${liveries} liveries = rgb(${med.join(', ')})`);
  }
  for (const name of models) {
    const part = name.slice(name.lastIndexOf('_stream_mesh') + '_stream_mesh'.length);
    if ((cfg.untouched || []).includes(part)) continue;
    const mesh = M.parseMeshSet(M.resAsGameSees(index, name, M.MESH_RES_TYPE));
    const have = new Set(mesh.lods[0].sections.map((s) => s.material));
    const prims = [];
    for (const p of pieces) {
      if (!p.rule || p.rule.skip || (p.part || p.rule.model || 'body') !== part) continue;
      const to = [p.section, ...(p.rule.to || []), ...(p.rule.else || [])].find((t) => t && have.has(t)); // "else": used only when none of "to" exists
      if (!to) { console.log(`  ${name.split('/').pop()}: no part ${[...p.rule.to, ...(p.rule.else || [])].join('/')} for ${p.material}; left out`); continue; }
      prims.push({ material: to, positions: p.positions.flat(), normals: p.normals && p.normals.flat(), uv0: p.uv0 && p.rule.uv !== 'game' ? p.uv0.flat() : undefined, indices: p.indices }); // "uv": "game": no uv0 either (the nearest original vertex's: e.g. a tyre on the game's shared tyre texture). no uv1: the importer takes the nearest original vertex's (the game car's mask layout)
    }
    const keepParts = (cfg.keep || {})[part];
    if (!prims.length) { changes.push({ type: 'mesh', asset: name, hide: true, ...(keepParts ? { keepParts } : {}) }); continue; }
    const key = part + JSON.stringify(prims.map((p) => p.material)); // kits with the same parts share one .glb
    if (!glbCache.has(key)) {
      const n = [...glbCache.keys()].filter((k) => k.startsWith(part + '[')).length, file = part + (n ? '_' + (n + 1) : '') + '.glb';
      glbCache.set(key, file); fs.writeFileSync(path.join(outDir, file), writeGlb(prims));
    }
    changes.push({ type: 'mesh', asset: name, glb: glbCache.get(key), clearOthers: true, evenShade: true, ...(keepParts ? { keepParts } : {}) });
  }
  // "lights": { "front": "<pieces of the headlights>", "rear": "<pieces of the rear lights>" }: the light flares and
  // glows (markers in the car's ebx) are moved onto the new model's lamps. Left = +x in the game (= -x in glTF).
  if (cfg.lights) {
    const lamp = (re, front) => {
      const r = new RegExp(re, 'i'), out = {};
      for (const side of [1, -1]) { // game x sign
        const pts = pieces.filter((p) => r.test(p.name + ' ' + p.material)).flatMap((p) => p.positions).filter((q) => -q[0] * side > 0.2);
        if (!pts.length) throw new Error(`lights: no vertices for "${re}"`);
        const avg = (a) => pts.reduce((s, q) => s + q[a], 0) / pts.length;
        const zs = pts.map((q) => q[2]).sort((a, b) => a - b), z = front ? zs[Math.floor(zs.length * 0.98)] : zs[Math.floor(zs.length * 0.02)];
        out[side] = [-avg(0), avg(1), z]; // game axes
      }
      return out;
    };
    const fr = cfg.lights.front && lamp(cfg.lights.front, true), rr = cfg.lights.rear && lamp(cfg.lights.rear, false);
    const where = {};
    if (fr) for (const [side, name] of [[1, 'LEFT'], [-1, 'RIGHT']]) for (const i of ['00', '01', '02']) where[`FLARE_HEADLIGHT_${name}_${i}`] = fr[side];
    if (rr) {
      for (const [side, name] of [[1, 'LEFT'], [-1, 'RIGHT']]) for (const i of ['00', '01', '02']) where[`FLARE_BRAKELIGHT_${name}_${i}`] = rr[side];
      const glow = [0, (rr[1][1] + rr[-1][1]) / 2, rr[1][2] - 0.06]; // the light thrown behind the car: centre, a little behind the lamps
      for (const k of ['LIGHTING_BRAKELIGHT_LEFT_00', 'LIGHTING_BRAKELIGHT_RIGHT_00', 'LIGHTING_REVERSE_LEFT_00', 'LIGHTING_REVERSE_RIGHT_00']) where[k] = glow;
    }
    // every ebx of the car that has these markers (the main kit and the other body kits)
    const W = require('./fb2_ebx_write.js'), E = require('./fb2_ebx_edit.js');
    const ebxNames = [...new Set(index.filter((e) => e.kind === 'ebx' && e.name.includes(`/${car}/`) && /_kit\d+\w*$/.test(e.name)).map((e) => e.name))];
    let moved = 0;
    for (const n of ebxNames) {
      let d; try { d = W.decode(E.readAsGameSees(index, n).data); } catch { continue; }
      const have = new Set(d.instances.filter((x) => x.value.$type === 'NfsVehicleMarkerTransform').map((x) => x.value.MarkerType));
      for (const [type, p] of Object.entries(where)) {
        if (!have.has(type)) continue;
        changes.push({ type: 'ebx', asset: n, where: { MarkerType: type }, set: { 'Transform.trans.x': +p[0].toFixed(4), 'Transform.trans.y': +p[1].toFixed(4), 'Transform.trans.z': +p[2].toFixed(4) } });
        moved++;
      }
    }
    console.log(`Lights: headlights at ${fr ? fr[1].map((x) => x.toFixed(2)).join(', ') : '-'}, rear lights at ${rr ? rr[1].map((x) => x.toFixed(2)).join(', ') : '-'} (left side); ${moved} markers moved in ${ebxNames.length} ebx.`);
  }
  const mod = { format: 1, name: cfg.name || 'Ported car', version: cfg.version || '0.1', author: cfg.author || '', description: cfg.description || `A new model on ${car}`, changes };
  fs.writeFileSync(path.join(outDir, 'mod.json'), JSON.stringify(mod, null, 1));
  const meshes = changes.filter((c) => c.type === 'mesh');
  console.log(`Mod written to ${outDir}: ${meshes.length} models (${meshes.filter((c) => c.hide).length} hidden), ${glbCache.size} .glb files, ${changes.filter((c) => c.type === 'texture').length} textures, ${changes.filter((c) => c.type === 'ebx').length} ebx edits (lights, body colours).`);
  return outDir;
}

module.exports = { writeGlb, port };

if (require.main === module) {
  const cfg = L.OPTS.rest[0];
  if (!cfg) { console.log('Usage: node fb2_carport.js --game "<game dir>" <port.json>'); process.exit(1); }
  port(L.loadIndex(), cfg);
}
