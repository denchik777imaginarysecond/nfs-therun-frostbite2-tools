'use strict';
/*
 * fb2_mesh.js — 3D models of Need for Speed: The Run (Frostbite 2): read MeshSet resources and export them to OBJ.
 *
 *   node fb2_mesh.js --game "<game dir>" selftest                check every model of the game (read-only)
 *   node fb2_mesh.js --game "<game dir>" export <name part> [lod] write output/obj/<model>_lod<n>.obj (+ .mtl)
 *   node fb2_mesh.js --game "<game dir>" car <car id> [lod]          whole car -> output/models/<car>_lod<n>.glb (Blender: Import glTF)
 *
 * A model is a res of type 49b156d4 (MeshSet), with an ebx of the same name (RigidMeshAsset / SkinnedMeshAsset...).
 * The res describes the model; the geometry (vertex and index buffers) is in a chunk, one per level of detail (LOD).
 *
 * MeshSet layout (offsets inside the res; "ptr" = 8-byte offset inside the res; all pointers are also listed in a
 * relocation table at the end of the res):
 *   0x00 u32 type, u32 ?, u32 LOD count, u32 ?      0x10 bounding box min (vec4), 0x20 max (vec4)
 *   0x30 5 x ptr LOD                                 0x58 ptr full name, 0x60 ptr short name, 0x68 u32 name hash
 *   LOD (0xb0 bytes): +0x00 u32 type, +0x04 u32 section count, +0x08 ptr sections,
 *     +0x10 4 x [u32 count][ptr list of section numbers] (render categories), +0x40 u32 flags,
 *     +0x48 u32 index buffer bytes, +0x4c u32 vertex buffer bytes, +0x54 chunk GUID (16), +0x64 u32 -1,
 *     +0x68 u32 start of the geometry block inside the res when it is not in a chunk (flag 0x40 clear, chunk GUID 0):
 *       the LODs' geometry follows one after another from there, each LOD 16-byte aligned,
 *     +0x70 / +0x78 / +0x80 ptr names, +0x88 u32 hash
 *   section (0x98 bytes): +0x08 ptr material name, +0x10 u32 material number, +0x14 u32 triangle count,
 *     +0x18 u32 first index, +0x1c u32 vertex buffer offset (bytes), +0x20 u32 vertex count, +0x24 u8 vertex size,
 *     +0x34 16 x [u8 usage][u8 format][u8 offset][u8 stream] (0x00 0x00 0xff 0x00 = unused),
 *     +0x74 u32 vertex size, +0x7c u32 element count, +0x80 6 x float
 *   geometry chunk: the vertices of every section one after another (each section at its vertex buffer offset),
 *     then the indices (16-bit), 16-byte aligned.
 */
const fs = require('fs');
const path = require('path');
const L = require('./fb2_extract.js');

const MESH_RES_TYPE = '49b156d4';

// vertex element formats seen in the game: size in bytes and how to read them
const half = (h) => { const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
const FORMATS = {
  1: { size: 4, read: (b, o) => [b.readFloatLE(o)] },                                                   // float
  2: { size: 8, read: (b, o) => [b.readFloatLE(o), b.readFloatLE(o + 4)] },                             // float2
  3: { size: 12, read: (b, o) => [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)] },      // float3
  4: { size: 16, read: (b, o) => [0, 4, 8, 12].map((i) => b.readFloatLE(o + i)) },                      // float4
  5: { size: 2, read: (b, o) => [half(b.readUInt16LE(o))] },                                            // half
  6: { size: 4, read: (b, o) => [half(b.readUInt16LE(o)), half(b.readUInt16LE(o + 2))] },              // half2
  7: { size: 6, read: (b, o) => [0, 2, 4].map((i) => half(b.readUInt16LE(o + i))) },                    // half3
  8: { size: 8, read: (b, o) => [0, 2, 4, 6].map((i) => half(b.readUInt16LE(o + i))) },                 // half4
};
const USAGE = { 1: 'position', 6: 'normal', 7: 'tangent', 0x21: 'uv0', 0x22: 'uv1' };

function parseMeshSet(r) {
  const u = (o) => r.readUInt32LE(o);
  const str = (o) => (o ? r.toString('latin1', o, r.indexOf(0, o)) : '');
  const v3 = (o) => [r.readFloatLE(o), r.readFloatLE(o + 4), r.readFloatLE(o + 8)];
  const mesh = { raw: r, type: u(0), lodCount: u(8), bboxMin: v3(0x10), bboxMax: v3(0x20), name: str(u(0x58)), shortName: str(u(0x60)), lods: [] };
  for (let i = 0; i < 5; i++) {
    const lp = u(0x30 + i * 8);
    if (!lp) continue;
    const lod = { at: lp, type: u(lp), indexBytes: u(lp + 0x48), vertexBytes: u(lp + 0x4c), flags: u(lp + 0x40), chunk: r.toString('hex', lp + 0x54, lp + 0x64), inline: u(lp + 0x68), name: str(u(lp + 0x80)), sections: [] };
    const n = u(lp + 4), sp = u(lp + 8);
    for (let s = 0; s < n; s++) {
      const so = sp + s * 0x98;
      const elements = [];
      for (let e = 0; e < 16; e++) {
        const q = so + 0x34 + e * 4;
        if (r[q] === 0 && r[q + 1] === 0 && r[q + 2] === 0xff) continue; // unused slot
        elements.push({ usage: r[q], format: r[q + 1], offset: r[q + 2], stream: r[q + 3] });
      }
      lod.sections.push({ material: str(u(so + 8)), materialIndex: u(so + 0x10), triangles: u(so + 0x14), firstIndex: u(so + 0x18), vertexOffset: u(so + 0x1c), vertexCount: u(so + 0x20), stride: u(so + 0x74), elementCount: u(so + 0x7c), elements });
    }
    mesh.lods.push(lod);
  }
  return mesh;
}

// geometry chunk -> { vertices: [{position, normal, uv0}], triangles: [[a,b,c]] } per section
function readGeometry(lod, data) {
  return lod.sections.map((s) => {
    const verts = [];
    for (let v = 0; v < s.vertexCount; v++) {
      const base = s.vertexOffset + v * s.stride, out = {};
      for (const e of s.elements) {
        const f = FORMATS[e.format], name = USAGE[e.usage];
        if (f && name) out[name] = f.read(data, base + e.offset);
        else if (e.usage === 2 && e.format === 12) out.bone = data[base + e.offset]; // bone number (each vertex follows one bone)
      }
      verts.push(out);
    }
    const tris = [];
    for (let t = 0; t < s.triangles; t++) {
      const o = lod.vertexBytes + (s.firstIndex + t * 3) * 2;
      tris.push([data.readUInt16LE(o), data.readUInt16LE(o + 2), data.readUInt16LE(o + 4)]);
    }
    return { material: s.material, vertices: verts, triangles: tris };
  });
}

// chunk GUID -> bytes (bundle copies with data, or the Chunks*.toc lists; the official patch first)
let chunkLocs = null;
function chunkData(index, guid) {
  if (!chunkLocs) {
    chunkLocs = new Map();
    const game = path.dirname(L.DATA_DIR);
    const walk = (d, o = []) => { if (!fs.existsSync(d)) return o; for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f, o); else if (/\.toc$/i.test(x.name) && x.name.toLowerCase() !== 'layout.toc') o.push(f); } return o; };
    for (const t of [...walk(path.join(game, 'Update', 'Patch', 'Data', 'Win32')), ...walk(path.join(L.DATA_DIR, 'Win32'))]) {
      for (const c of L.readToc(t).chunks || []) if (!chunkLocs.has(c.id)) chunkLocs.set(c.id, { file: t.replace(/\.toc$/i, '.sb'), pos: c.offset, size: c.size });
    }
    for (const e of index) if (e.kind === 'chunk' && e.size > 0 && !chunkLocs.has(e.name)) chunkLocs.set(e.name, { file: path.join(L.DATA_DIR, e.sb), pos: e.pos, size: e.size });
  }
  const loc = chunkLocs.get(guid);
  if (!loc) return null;
  const b = Buffer.alloc(loc.size);
  const fd = fs.openSync(loc.file, 'r'); fs.readSync(fd, b, 0, loc.size, loc.pos); fs.closeSync(fd);
  return L.unpackBlocks(b);
}

// ============================================================ writing geometry ===
// float -> half (IEEE 754 binary16, round to nearest even); exact for every value that came from a half
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v; const x = u32[0];
  const sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);            // inf / nan
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;                                     // too big: inf
  if (e <= 0) {                                                            // subnormal half
    if (e < -10) return sign;
    const m = mant | 0x800000, shift = 14 - e;
    let h = m >> shift; const rem = m & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >> 13); const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;                    // may carry into the exponent: still right
  return sign | h;
}
const WRITERS = {
  1: (b, o, v) => b.writeFloatLE(v[0], o), 2: (b, o, v) => { b.writeFloatLE(v[0], o); b.writeFloatLE(v[1], o + 4); },
  3: (b, o, v) => [0, 1, 2].forEach((i) => b.writeFloatLE(v[i], o + i * 4)), 4: (b, o, v) => [0, 1, 2, 3].forEach((i) => b.writeFloatLE(v[i], o + i * 4)),
  5: (b, o, v) => b.writeUInt16LE(toHalf(v[0]), o), 6: (b, o, v) => [0, 1].forEach((i) => b.writeUInt16LE(toHalf(v[i]), o + i * 2)),
  7: (b, o, v) => [0, 1, 2].forEach((i) => b.writeUInt16LE(toHalf(v[i]), o + i * 2)), 8: (b, o, v) => [0, 1, 2, 3].forEach((i) => b.writeUInt16LE(toHalf(v[i]), o + i * 2)),
};

// Editable geometry of a LOD: every vertex keeps its original bytes (bones, damage data, padding are carried over
// untouched); the known values (position, normal, tangent, uv0, uv1) are written over them.
function readEditable(lod, data) {
  return lod.sections.map((s) => {
    const vertices = [];
    for (let v = 0; v < s.vertexCount; v++) {
      const base = s.vertexOffset + v * s.stride, raw = Buffer.from(data.subarray(base, base + s.stride)), out = { raw };
      for (const e of s.elements) { const f = FORMATS[e.format], name = USAGE[e.usage]; if (f && name) out[name] = f.read(raw, e.offset); }
      vertices.push(out);
    }
    const triangles = [];
    for (let t = 0; t < s.triangles; t++) { const o = lod.vertexBytes + (s.firstIndex + t * 3) * 2; triangles.push([data.readUInt16LE(o), data.readUInt16LE(o + 2), data.readUInt16LE(o + 4)]); }
    return { material: s.material, stride: s.stride, elements: s.elements, vertices, triangles };
  });
}

// Editable geometry -> { data (vertex buffer + 16-bit indices, 16-byte aligned), sections: [{vertexOffset, vertexCount,
// firstIndex, triangles}], vertexBytes, indexBytes, bboxMin, bboxMax } — what the MeshSet must be updated with.
function writeGeometry(sections) {
  const vparts = [], iparts = [], layout = [];
  let vb = 0, firstIndex = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const s of sections) {
    if (s.vertices.length > 65536) throw new Error(`${s.material}: ${s.vertices.length} vertices; a part can have at most 65536 (16-bit indices)`);
    const buf = Buffer.alloc(s.vertices.length * s.stride);
    s.vertices.forEach((v, i) => {
      if (!v.raw || v.raw.length !== s.stride) throw new Error(`${s.material}: vertex ${i} has no template bytes of the right size`);
      v.raw.copy(buf, i * s.stride);
      for (const e of s.elements) {
        const name = USAGE[e.usage], w = WRITERS[e.format];
        if (!name || !w || !v[name]) continue;
        if (v[name].some((x) => !Number.isFinite(x))) throw new Error(`${s.material}: vertex ${i} ${name} is not a number`);
        w(buf, i * s.stride + e.offset, v[name]);
        if (name === 'position') for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v.position[k]); mx[k] = Math.max(mx[k], v.position[k]); }
      }
    });
    const ib = Buffer.alloc(s.triangles.length * 6);
    s.triangles.forEach((t, i) => t.forEach((x, k) => {
      if (!Number.isInteger(x) || x < 0 || x >= s.vertices.length) throw new Error(`${s.material}: triangle ${i} points to vertex ${x}, the part has ${s.vertices.length}`);
      ib.writeUInt16LE(x, (i * 3 + k) * 2);
    }));
    layout.push({ vertexOffset: vb, vertexCount: s.vertices.length, firstIndex, triangles: s.triangles.length });
    vparts.push(buf); iparts.push(ib);
    vb += buf.length; firstIndex += s.triangles.length * 3;
  }
  const ibytes = firstIndex * 2, total = Math.ceil((vb + ibytes) / 16) * 16;
  const data = Buffer.concat([...vparts, ...iparts, Buffer.alloc(total - vb - ibytes)]);
  return { data, sections: layout, vertexBytes: vb, indexBytes: ibytes, bboxMin: mn, bboxMax: mx };
}

// A new vertex for an editable section: it takes the bytes of the nearest existing vertex as its template (bone,
// damage cell, vertex colour, padding stay valid values the game already uses), then gets its own position, normal,
// tangent and UVs. values: { position, normal?, tangent?, uv0?, uv1? }.
// lookup structures for template search, built once per pool of vertices
// fields: which of normal / uv0 / uv1 the section's vertices have (a .glb always carries both UV sets)
const vertexKey = (v, fields) => ['position', ...fields].map((k) => (v[k] ? v[k].slice(0, 3).join(',') : '')).join('|');
const keyFields = (v) => ['normal', 'uv0', 'uv1'].filter((k) => v && v[k]);
const poolIndexes = new WeakMap();
function poolIndex(pool) {
  if (poolIndexes.has(pool)) return poolIndexes.get(pool);
  // exact matches: key -> every vertex with that key, in order. "Twins" (same position, normal and UV but other bone,
  // tangent or damage data, e.g. the left and right brake discs at the origin) are handed out in order of appearance.
  const exact = new Map(), withRaw = pool.filter((v) => v.raw && v.position), fields = keyFields(withRaw[0]);
  for (const v of withRaw) { const k = vertexKey(v, fields); if (!exact.has(k)) exact.set(k, []); exact.get(k).push(v); }
  const mn = [0, 1, 2].map((k) => Math.min(...withRaw.map((v) => v.position[k]))), mx = [0, 1, 2].map((k) => Math.max(...withRaw.map((v) => v.position[k])));
  const ext = Math.max(...[0, 1, 2].map((k) => mx[k] - mn[k]), 1e-3);
  const size = ext / Math.max(1, Math.cbrt(withRaw.length / 4)); // about 4 vertices per cell
  const cell = (p) => [0, 1, 2].map((k) => Math.floor((p[k] - mn[k]) / size));
  const grid = new Map();
  for (const v of withRaw) { const c = cell(v.position).join(','); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(v); }
  const ix = { exact, fields, used: new Map(), grid, cell, size: withRaw.length ? size : 0, maxRing: Math.ceil(ext / size) + 2 };
  poolIndexes.set(pool, ix);
  return ix;
}

function templatedVertex(section, values, pool = section.vertices) {
  // nearest by position; normal and UV break ties (vertices on a UV seam share a position), so an unchanged vertex
  // finds exactly itself
  const sq = (a, b, n) => { if (!a || !b) return 0; let s = 0; for (let k = 0; k < n; k++) s += (a[k] - b[k]) ** 2; return s; };
  const score = (v) => sq(v.position || [0, 0, 0], values.position, 3) + 1e-4 * (sq(v.normal, values.normal, 3) + sq(v.uv0, values.uv0, 2) + sq(v.uv1, values.uv1, 2)); // sq() skips missing fields
  const ix = poolIndex(pool);
  // 1) exactly the same vertex (unchanged geometry): instant
  const key = vertexKey(values, ix.fields), twins = ix.exact.get(key);
  let exact = null;
  if (twins) { const n = ix.used.get(key) || 0; exact = twins[Math.min(n, twins.length - 1)]; ix.used.set(key, n + 1); }
  let best = exact || null, bd = exact ? 0 : Infinity;
  // 2) otherwise the nearest one: look in the grid cells around the position, ring by ring
  if (!best && ix.size) {
    const c = ix.cell(values.position);
    for (let r = 0; r <= ix.maxRing; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue; // only the shell of this ring
        for (const v of ix.grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) || []) { const d = score(v); if (d < bd) { bd = d; best = v; } }
      }
      if (best && (r * ix.size) ** 2 > bd) break; // nothing in farther rings can be nearer
    }
  }
  if (!best) throw new Error(`${section.material}: no vertex to use as a template`);
  const v = { ...best, raw: Buffer.from(best.raw) };
  for (const k of ['position', 'normal', 'tangent', 'uv0', 'uv1']) {
    if (!values[k] || !best[k]) continue;
    v[k] = [...values[k], ...best[k].slice(values[k].length)]; // keep extra components (e.g. w) of the template
  }
  return v;
}

// A copy of the MeshSet res with new geometry facts for some LODs: lodUpdates = Map(lod number -> writeGeometry result).
// Only fixed-size fields change (sizes, counts, offsets, bounding box), so the res keeps its size and its pointers.
// The section count, materials and vertex format must stay the same. Geometry stored inside the res is not supported yet.
function updateMeshSet(mesh, lodUpdates) {
  const r = Buffer.from(mesh.raw);
  const w32 = (o, v) => r.writeUInt32LE(v >>> 0, o);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  mesh.lods.forEach((lod, li) => {
    const up = lodUpdates.get(li);
    if (!up) return;
    if (isInline(lod)) throw new Error('this model keeps its geometry inside the res; replacing it is not supported yet');
    if (up.sections.length !== lod.sections.length) throw new Error(`LOD ${li}: ${up.sections.length} parts, the model has ${lod.sections.length}`);
    w32(lod.at + 0x48, up.indexBytes); w32(lod.at + 0x4c, up.vertexBytes);
    const sp = r.readUInt32LE(lod.at + 8);
    up.sections.forEach((s, i) => {
      const so = sp + i * 0x98;
      w32(so + 0x14, s.triangles); w32(so + 0x18, s.firstIndex); w32(so + 0x1c, s.vertexOffset); w32(so + 0x20, s.vertexCount);
    });
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], up.bboxMin[k]); mx[k] = Math.max(mx[k], up.bboxMax[k]); }
  });
  // The game uses the bounding box to decide what is on screen: a box that is too small makes the model vanish early,
  // one that is a little too big is harmless. So the box only grows: it stays the original one unless the new geometry
  // reaches outside it by more than two half-precision steps at that distance: half-precision vertices of big
  // models are that far off the stored box anyway.
  const tol = (x) => 0.002 + Math.abs(x) / 512; // half precision: a step is |x|/1024
  if (lodUpdates.size) {
    for (let k = 0; k < 3; k++) {
      r.writeFloatLE(mn[k] < mesh.bboxMin[k] - tol(mesh.bboxMin[k]) ? mn[k] : mesh.bboxMin[k], 0x10 + k * 4);
      r.writeFloatLE(mx[k] > mesh.bboxMax[k] + tol(mesh.bboxMax[k]) ? mx[k] : mesh.bboxMax[k], 0x20 + k * 4);
    }
  }
  return r;
}

// the geometry of a LOD: from its chunk, or (rare: chunk GUID 0, flag 0x40 clear) from inside the res itself
const isInline = (lod) => /^0+$/.test(lod.chunk);
function lodData(index, mesh, lod) {
  if (!isInline(lod)) return chunkData(index, lod.chunk);
  let at = lod.inline; // the block start; earlier inline LODs come first
  for (const l of mesh.lods) { if (l === lod) break; if (isInline(l)) at = Math.ceil((at + l.vertexBytes + l.indexBytes) / 16) * 16; }
  return mesh.raw.subarray(at, at + lod.vertexBytes + lod.indexBytes);
}

function toObj(mesh, geo, mtlName) {
  const lines = [`# ${mesh.name}`, `# exported by fb2_mesh.js`, mtlName ? `mtllib ${mtlName}` : ''];
  let base = 1;
  for (const s of geo) {
    lines.push(`o ${s.material || 'section'}`, `usemtl ${s.material || 'default'}`);
    for (const v of s.vertices) lines.push(`v ${(v.position || [0, 0, 0]).slice(0, 3).map((x) => +x.toFixed(5)).join(' ')}`);
    for (const v of s.vertices) lines.push(`vt ${(v.uv0 || [0, 0]).map((x, i) => +(i ? 1 - x : x).toFixed(5)).join(' ')}`); // OBJ: v goes up
    for (const v of s.vertices) lines.push(`vn ${(v.normal || [0, 1, 0]).slice(0, 3).map((x) => +x.toFixed(4)).join(' ')}`);
    for (const t of s.triangles) lines.push('f ' + t.map((i) => `${i + base}/${i + base}/${i + base}`).join(' '));
    base += s.vertices.length;
  }
  return lines.join('\n') + '\n';
}

// ============================================================ whole cars ===
// A car is made of parts: <car>/kits/<car>_kit00_stream_mesh<part> (body, hood, doors, bumpers, ...). The wheels are one
// model at the origin (wheelsfront + wheelsrear, or one 'wheels' model for all four); the kit's ebx places the copies
// (RaceWheelComponentData.Transform.trans, front = positive z). Traffic cars have their wheels inside their 'traffic' model.
// Returns [{ name, mesh, geometry, transforms: [{ trans, flip }] }]; flip = turned 180 degrees (left side wheels).
function carParts(index, carId, lodNumber = 0) {
  const E = require('./fb2_ebx_edit.js'), W = require('./fb2_ebx_write.js');
  const prefix = `_c4/vehicles/nfs/${carId}/kits/${carId}_kit00_stream_mesh`;
  const kit = `_c4/vehicles/nfs/${carId}/kits/${carId}_kit00`;
  const wheels = [];
  try {
    for (const x of W.decode(E.readAsGameSees(index, kit).data).instances) {
      if (x.value.$type !== 'RaceWheelComponentData' || !x.value.Transform || !x.value.Transform.trans) continue;
      const t = x.value.Transform.trans;
      wheels.push([t.x, t.y, t.z]);
    }
  } catch { /* no kit ebx: the wheels stay at the origin */ }
  const seen = new Set(), parts = [];
  for (const e of index) {
    if (e.kind !== 'res' || e.extra !== MESH_RES_TYPE || !e.name.startsWith(prefix) || seen.has(e.name)) continue;
    seen.add(e.name);
    const fd = fs.openSync(path.join(L.DATA_DIR, e.sb), 'r');
    const mesh = parseMeshSet(L.readAsset(fd, e)); fs.closeSync(fd);
    const lod = mesh.lods[Math.min(lodNumber, mesh.lods.length - 1)];
    const data = lodData(index, mesh, lod);
    if (!data) continue;
    const part = e.name.slice(prefix.length);
    let transforms = [{ trans: [0, 0, 0], flip: false }];
    // wheelsfront / wheelsrear: two copies each; wheels (one model for all four, e.g. Porsche 911, cop cars): four copies
    if (/^wheels(front|rear)?$/.test(part) && wheels.length) {
      transforms = wheels.filter((p) => (part === 'wheelsfront' ? p[2] > 0 : part === 'wheelsrear' ? p[2] < 0 : true)).map((p) => ({ trans: p, flip: p[0] < 0 }));
    }
    const geometry = readGeometry(lod, data);
    const wheelBones = wheels.length ? wheelBoneGroups(geometry) : [];
    if (wheelBones.length && !/^wheels/.test(part)) {
      // take the wheel triangles out of this part; first wheel bone = front wheels, second (or the same) = rear wheels
      const pick = (bone) => geometry.map((g) => ({ material: g.material, vertices: g.vertices, triangles: g.triangles.filter((t) => g.vertices[t[0]].bone === bone) }));
      const front = wheelBones[0], rear = wheelBones[1] !== undefined ? wheelBones[1] : wheelBones[0];
      // named <part>_at_wheels_front/rear: wheels of traffic cars, brake discs and calipers of other cars
      for (const [name, bone, side] of [['at_wheels_front', front, 1], ['at_wheels_rear', rear, -1]]) {
        parts.push({ name: part + '_' + name, mesh, geometry: pick(bone), transforms: wheels.filter((p) => Math.sign(p[2]) === side).map((p) => ({ trans: p, flip: p[0] < 0 })) });
      }
      for (const g of geometry) g.triangles = g.triangles.filter((t) => !wheelBones.includes(g.vertices[t[0]].bone));
    }
    parts.push({ name: part, mesh, geometry, transforms });
  }
  return parts.sort((a, b) => a.name.localeCompare(b.name));
}

// bone groups that look like a wheel lying at the origin (centred, 0.2-1 m radius; tractors have big rear wheels): the game moves them into place
function wheelBoneGroups(geometry) {
  const box = new Map();
  for (const g of geometry) for (const v of g.vertices) {
    if (v.bone === undefined || !v.position) continue;
    if (!box.has(v.bone)) box.set(v.bone, { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] });
    const b = box.get(v.bone); for (let k = 0; k < 3; k++) { b.mn[k] = Math.min(b.mn[k], v.position[k]); b.mx[k] = Math.max(b.mx[k], v.position[k]); }
  }
  const out = [];
  for (const [bone, b] of [...box].sort((x, y) => x[0] - y[0])) {
    const c = [0, 1, 2].map((k) => (b.mn[k] + b.mx[k]) / 2), r = (b.mx[1] - b.mn[1]) / 2;
    if (c.every((x) => Math.abs(x) < 0.05) && r > 0.2 && r < 1 && Math.abs((b.mx[2] - b.mn[2]) / 2 - r) < 0.05) out.push(bone);
  }
  return out;
}

// ============================================================ glTF ===
// Binary glTF (.glb) with positions, normals, both UV sets and one primitive per material section.
// The game is left-handed (x right, y up, z forward); glTF is right-handed: x is mirrored and triangles reversed.
// opts.rawNormals: keep the normals exactly as stored (for export -> import round trips); opts.sectionNames: name the
// materials so that every section of a LOD has its own (duplicates get "__s<n>")
function toGlb(parts, title, opts = {}) {
  const bin = [], views = [], accessors = [], meshes = [], nodes = [], materials = [], matIndex = new Map();
  let binLen = 0;
  const addView = (buf, target) => {
    const pad = (4 - (binLen % 4)) % 4; if (pad) { bin.push(Buffer.alloc(pad)); binLen += pad; }
    views.push({ buffer: 0, byteOffset: binLen, byteLength: buf.length, ...(target ? { target } : {}) });
    bin.push(buf); binLen += buf.length;
    return views.length - 1;
  };
  const floats = (arr, n, target) => {
    const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeFloatLE(Number.isFinite(v) ? v : 0, i * 4));
    const acc = { bufferView: addView(b, target), componentType: 5126, count: arr.length / n, type: ['', 'SCALAR', 'VEC2', 'VEC3'][n] };
    if (n === 3) { acc.min = [0, 1, 2].map((k) => Math.min(...arr.filter((_, i) => i % 3 === k))); acc.max = [0, 1, 2].map((k) => Math.max(...arr.filter((_, i) => i % 3 === k))); }
    accessors.push(acc); return accessors.length - 1;
  };
  const material = (name) => {
    if (!matIndex.has(name)) { matIndex.set(name, materials.length); materials.push({ name, pbrMetallicRoughness: { baseColorFactor: /GLASS/i.test(name) ? [0.2, 0.25, 0.3, 0.5] : /CHROME|RIM/i.test(name) ? [0.8, 0.8, 0.85, 1] : /TIRE/i.test(name) ? [0.05, 0.05, 0.05, 1] : [0.6, 0.6, 0.62, 1], metallicFactor: /CHROME|RIM/i.test(name) ? 1 : 0, roughnessFactor: 0.5 }, ...(/GLASS/i.test(name) ? { alphaMode: 'BLEND' } : {}), doubleSided: true }); }
    return matIndex.get(name);
  };
  for (const part of parts) {
    const prims = [];
    const names = part.geometry.map((s) => s.material || 'default');
    part.geometry.forEach((s, si) => {
      if (!s.vertices.length || !s.triangles.length) return;
      const pos = [], nor = [], uv0 = [], uv1 = [];
      for (const v of s.vertices) {
        const p = v.position || [0, 0, 0], n = v.normal || [0, 1, 0];
        pos.push(-p[0], p[1], p[2]);
        const nl = opts.rawNormals ? 1 : Math.hypot(n[0], n[1], n[2]) || 1; nor.push(-n[0] / nl, n[1] / nl, n[2] / nl);
        uv0.push(...(v.uv0 || [0, 0]).slice(0, 2)); uv1.push(...(v.uv1 || v.uv0 || [0, 0]).slice(0, 2));
      }
      const big = s.vertices.length > 65535;
      const ib = Buffer.alloc(s.triangles.length * 3 * (big ? 4 : 2));
      s.triangles.forEach((t, i) => [t[0], t[2], t[1]].forEach((x, k) => (big ? ib.writeUInt32LE(x, (i * 3 + k) * 4) : ib.writeUInt16LE(x, (i * 3 + k) * 2)))); // reversed winding
      accessors.push({ bufferView: addView(ib, 34963), componentType: big ? 5125 : 5123, count: s.triangles.length * 3, type: 'SCALAR' });
      const indices = accessors.length - 1;
      const mname = opts.sectionNames && names.filter((x) => x === names[si]).length > 1 ? `${names[si]}__s${si}` : names[si];
      prims.push({ attributes: { POSITION: floats(pos, 3, 34962), NORMAL: floats(nor, 3, 34962), TEXCOORD_0: floats(uv0, 2, 34962), TEXCOORD_1: floats(uv1, 2, 34962) }, indices, material: material(mname) });
    });
    if (!prims.length) continue;
    meshes.push({ name: part.name, primitives: prims });
    for (const t of part.transforms) {
      // mirrored x; a flipped (left) wheel is turned 180 degrees around y
      nodes.push({ name: part.transforms.length > 1 ? `${part.name}_${t.trans[0] < 0 ? 'left' : 'right'}_${t.trans[2] > 0 ? 'front' : 'rear'}` : part.name, mesh: meshes.length - 1,
        translation: [-t.trans[0], t.trans[1], t.trans[2]], ...(t.flip ? { rotation: [0, 1, 0, 0] } : {}) });
    }
  }
  const json = { asset: { version: '2.0', generator: 'fb2_mesh.js (NFS The Run tools by denchik777)' }, scene: 0, scenes: [{ name: title, nodes: nodes.map((_, i) => i) }],
    nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: binLen }] };
  let jb = Buffer.from(JSON.stringify(json), 'utf8'); jb = Buffer.concat([jb, Buffer.alloc((4 - (jb.length % 4)) % 4, 0x20)]);
  let bb = Buffer.concat(bin); bb = Buffer.concat([bb, Buffer.alloc((4 - (bb.length % 4)) % 4)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
  const ch = (len, type) => { const c = Buffer.alloc(8); c.writeUInt32LE(len, 0); c.writeUInt32LE(type, 4); return c; };
  return Buffer.concat([head, ch(jb.length, 0x4e4f534a), jb, ch(bb.length, 0x004e4942), bb]);
}

// A res as the game sees it: from the official patch's delta bundle when the patch has its own version.
function resAsGameSees(index, name, type) {
  const R = require('./fb2_repack.js');
  name = String(name).toLowerCase();
  const PD = path.join(path.dirname(L.DATA_DIR), 'Update', 'Patch', 'Data');
  const hits = index.filter((e) => e.kind === 'res' && e.name.toLowerCase() === name && (!type || e.extra === type));
  if (!hits.length) throw new Error('model not found: ' + name);
  for (const hit of hits) {
    const ptoc = path.join(PD, hit.sb.replace(/\.sb$/i, '.toc'));
    if (!fs.existsSync(ptoc)) continue;
    const pe = (L.readToc(ptoc).bundles || []).find((b) => b.id.toLowerCase() === hit.bundle.toLowerCase());
    if (!pe || !pe.delta) continue;
    const rec = R.reconstructDelta(R.readDelta(ptoc.replace(/\.toc$/i, '.sb'), pe.offset, pe.size), path.join(L.DATA_DIR, hit.sb), path.join(PD, 'common.dat'));
    let data = null;
    R.withTempFile(rec.buf, (fd) => { const e = L.readBundle(fd, 0, rec.buf.length).entries.find((x) => x.kind === 'res' && x.name.toLowerCase() === name); if (e) data = L.readAsset(fd, e); });
    if (data) return data;
  }
  const fd = fs.openSync(path.join(L.DATA_DIR, hits[0].sb), 'r');
  try { return L.readAsset(fd, hits[0]); } finally { fs.closeSync(fd); }
}

// ============================================================ one model <-> .glb (for editing in Blender) ===
// Export: every LOD of the model is an object "lod<n>"; one material per section (named like the section's material).
function modelToGlb(index, mesh) {
  const parts = mesh.lods.map((lod, i) => {
    if (isInline(lod)) throw new Error('this model keeps its geometry inside the res; exporting it for editing is not supported yet');
    return { name: 'lod' + i, geometry: readGeometry(lod, lodData(index, mesh, lod)), transforms: [{ trans: [0, 0, 0], flip: false }] };
  });
  return toGlb(parts, mesh.shortName, { rawNormals: true, sectionNames: true });
}

// Reads a .glb (as Blender writes it): every node with a mesh, its world transform applied, every primitive's
// positions, normals, UVs (0 and 1), tangents and triangles. Coordinates stay glTF (right-handed).
function readGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a .glb file (binary glTF)');
  let p = 12, json = null, bin = null;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32LE(p), type = buf.readUInt32LE(p + 4), body = buf.subarray(p + 8, p + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8')); else if (type === 0x004e4942) bin = body;
    p += 8 + len;
  }
  if (!json) throw new Error('the .glb has no JSON part');
  const COMP = { 5120: [1, 'readInt8', 127], 5121: [1, 'readUInt8', 255], 5122: [2, 'readInt16LE', 32767], 5123: [2, 'readUInt16LE', 65535], 5125: [4, 'readUInt32LE', 0], 5126: [4, 'readFloatLE', 0] };
  const N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const read = (ai) => {
    const a = json.accessors[ai]; if (!a) throw new Error('bad accessor ' + ai);
    if (a.sparse) throw new Error('sparse accessors are not supported: export without them');
    const n = N[a.type], [size, fn, max] = COMP[a.componentType], out = [];
    if (a.bufferView === undefined) { for (let i = 0; i < a.count; i++) out.push(new Array(n).fill(0)); return out; }
    const v = json.bufferViews[a.bufferView];
    if (v.buffer !== 0 || !bin) throw new Error('the .glb uses an external buffer: export as .glb (binary), not .gltf');
    const stride = v.byteStride || n * size, base = (v.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < a.count; i++) {
      const e = [];
      for (let k = 0; k < n; k++) { let x = bin[fn](base + i * stride + k * size); if (a.normalized && max) x = Math.max(x / max, -1); e.push(x); }
      out.push(e);
    }
    return out;
  };
  // node world matrices (column-major 4x4)
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const local = (n) => {
    if (n.matrix) return n.matrix.slice();
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const out = [];
  const visit = (ni, parent) => {
    const n = json.nodes[ni], world = mul(parent, local(n));
    if (n.mesh !== undefined) {
      const m = json.meshes[n.mesh];
      const prims = m.primitives.map((pr) => {
        if (pr.mode !== undefined && pr.mode !== 4) throw new Error(`object "${n.name}": only triangles can be imported`);
        const pos = read(pr.attributes.POSITION);
        return {
          material: pr.material !== undefined ? (json.materials[pr.material].name || 'material' + pr.material) : '',
          positions: pos, normals: pr.attributes.NORMAL !== undefined ? read(pr.attributes.NORMAL) : null,
          uv0: pr.attributes.TEXCOORD_0 !== undefined ? read(pr.attributes.TEXCOORD_0) : null, uv1: pr.attributes.TEXCOORD_1 !== undefined ? read(pr.attributes.TEXCOORD_1) : null,
          tangents: pr.attributes.TANGENT !== undefined ? read(pr.attributes.TANGENT) : null,
          indices: pr.indices !== undefined ? read(pr.indices).map((x) => x[0]) : pos.map((_, i) => i),
        };
      });
      out.push({ name: n.name || m.name || '', meshName: m.name || '', matrix: world, primitives: prims });
    }
    for (const c of n.children || []) visit(c, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const roots = (json.scenes && json.scenes[json.scene || 0] && json.scenes[json.scene || 0].nodes) || json.nodes.map((_, i) => i);
  roots.forEach((r) => visit(r, identity));
  return out;
}

// glb objects -> new geometry for the model. Returns { res, chunks: Map(guid -> bytes), report: [lines] }.
// Object "lod<n>" replaces LOD n; LODs without an object get lod0's (opts.keepOtherLods: keep their own geometry).
// Primitives go to the section with the same material name (".001" suffixes of Blender are ignored); a section without
// primitives keeps its geometry. New vertices take bone / damage / colour data from the nearest original vertex.
function glbToModel(index, mesh, glbBuf, opts = {}) {
  const objs = readGlb(glbBuf);
  const lodObj = (i) => objs.find((o) => o.name.toLowerCase() === 'lod' + i) || objs.find((o) => o.meshName.toLowerCase() === 'lod' + i);
  if (!lodObj(0) && objs.length !== 1) throw new Error(`the .glb needs an object named "lod0" (it has: ${objs.map((o) => o.name).join(', ') || 'no objects'})`);
  const report = [], ups = new Map(), chunks = new Map();
  const strip = (n) => String(n).replace(/\.\d{3}$/, '');
  mesh.lods.forEach((lod, li) => {
    let obj = lodObj(li);
    if (!obj) { if (opts.keepOtherLods) return; obj = lodObj(0) || objs[0]; }
    if (isInline(lod)) throw new Error('this model keeps its geometry inside the res; replacing it is not supported yet');
    const ed = readEditable(lod, lodData(index, mesh, lod));
    // which section does a material name mean? exact name, or "<name>__s<n>" for duplicates
    const sectionOf = (name) => {
      const m = strip(name).match(/^(.*)__s(\d+)$/);
      if (m && ed[Number(m[2])] && ed[Number(m[2])].material === m[1]) return Number(m[2]);
      const i = ed.findIndex((s) => s.material === strip(name));
      if (i < 0) throw new Error(`LOD ${li}: material "${name}" is not a part of this model (parts: ${ed.map((s) => s.material).join(', ')})`);
      return i;
    };
    const M4 = obj.matrix, apply = (v) => [M4[0] * v[0] + M4[4] * v[1] + M4[8] * v[2] + M4[12], M4[1] * v[0] + M4[5] * v[1] + M4[9] * v[2] + M4[13], M4[2] * v[0] + M4[6] * v[1] + M4[10] * v[2] + M4[14]];
    const isIdentity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].every((x, k) => Math.abs(M4[k] - x) < 1e-9);
    // normals: inverse transpose of the 3x3 part
    const a = [M4[0], M4[4], M4[8], M4[1], M4[5], M4[9], M4[2], M4[6], M4[10]];
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    const it = [(a[4] * a[8] - a[5] * a[7]) / det, (a[5] * a[6] - a[3] * a[8]) / det, (a[3] * a[7] - a[4] * a[6]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[1] * a[5] - a[2] * a[4]) / det, (a[2] * a[3] - a[0] * a[5]) / det, (a[0] * a[4] - a[1] * a[3]) / det];
    const applyN = (n) => { const r = [it[0] * n[0] + it[1] * n[1] + it[2] * n[2], it[3] * n[0] + it[4] * n[1] + it[5] * n[2], it[6] * n[0] + it[7] * n[1] + it[8] * n[2]]; const l = Math.hypot(...r) || 1; return r.map((x) => x / l); };
    const flipWinding = det < 0; // a mirrored object turns its triangles inside out
    const groups = new Map(); // section -> primitives
    for (const pr of obj.primitives) { const si = sectionOf(pr.material); if (!groups.has(si)) groups.set(si, []); groups.get(si).push(pr); }
    for (const [si, prims] of groups) {
      const s = ed[si], pool = s.vertices, verts = [], tris = [];
      for (const pr of prims) {
        const base = verts.length;
        pr.positions.forEach((pp, i) => {
          const gp = isIdentity ? pp : apply(pp);
          const gn = pr.normals ? (isIdentity ? pr.normals[i] : applyN(pr.normals[i])) : null;
          // glTF (right-handed) -> game (left-handed): mirror x
          const values = { position: [-gp[0], gp[1], gp[2]] };
          if (gn) values.normal = [-gn[0], gn[1], gn[2]];
          if (pr.uv0) values.uv0 = pr.uv0[i].slice(0, 2);
          if (pr.uv1 || pr.uv0) values.uv1 = (pr.uv1 || pr.uv0)[i].slice(0, 2);
          if (pr.tangents) values.tangent = [-pr.tangents[i][0], pr.tangents[i][1], pr.tangents[i][2]];
          verts.push(templatedVertex(s, values, pool));
        });
        for (let k = 0; k + 2 < pr.indices.length; k += 3) {
          const t = [pr.indices[k], pr.indices[k + 1], pr.indices[k + 2]].map((x) => x + base);
          tris.push(flipWinding ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]); // mirroring x reverses the winding back
        }
      }
      report.push(`LOD ${li} ${s.material}: ${s.vertices.length} -> ${verts.length} vertices, ${s.triangles.length} -> ${tris.length} triangles`);
      s.vertices = verts; s.triangles = tris;
    }
    const w = writeGeometry(ed);
    ups.set(li, w); chunks.set(lod.chunk, w.data);
  });
  if (!ups.size) throw new Error('nothing to import: no LOD object matched');
  return { res: updateMeshSet(mesh, ups), chunks, report };
}

module.exports = { MESH_RES_TYPE, resAsGameSees, parseMeshSet, readGeometry, readEditable, writeGeometry, templatedVertex, updateMeshSet, toHalf, chunkData, lodData, isInline, toObj, carParts, toGlb, modelToGlb, readGlb, glbToModel, FORMATS, USAGE };

// ============================================================ CLI ===
if (require.main === module) {
  const [cmd, a1, a2] = L.OPTS.rest;
  const index = L.loadIndex();
  const fds = new Map(); const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  const meshes = new Map(); for (const e of index) if (e.kind === 'res' && e.extra === MESH_RES_TYPE && !meshes.has(e.name)) meshes.set(e.name, e);
  if (cmd === 'selftest') {
    const t = { meshes: 0, lods: 0, failed: 0, vertexBytesMatch: 0, indexBytesMatch: 0, chunkSizeMatch: 0, chunkMissing: 0, indicesInRange: 0, unknownFormats: {} };
    const errs = {};
    const deep = Number(a1) || 3000; // geometry checks on this many models (reading chunks is slower)
    for (const e of meshes.values()) {
      t.meshes++;
      try {
        const m = parseMeshSet(L.readAsset(fdOf(e.sb), e));
        for (const lod of m.lods) {
          t.lods++;
          const vb = lod.sections.reduce((s, x) => Math.max(s, x.vertexOffset + x.vertexCount * x.stride), 0);
          if (vb === lod.vertexBytes) t.vertexBytesMatch++;
          const ib = lod.sections.reduce((s, x) => Math.max(s, (x.firstIndex + x.triangles * 3) * 2), 0);
          if (ib === lod.indexBytes) t.indexBytesMatch++;
          for (const s of lod.sections) for (const el of s.elements) if (!FORMATS[el.format]) t.unknownFormats[el.format] = (t.unknownFormats[el.format] || 0) + 1;
          if (t.meshes <= deep) {
            const data = lodData(index, m, lod);
            if (!data) { t.chunkMissing++; continue; }
            if (isInline(lod)) t.inline = (t.inline || 0) + 1;
            if (data.length >= lod.vertexBytes + lod.indexBytes && data.length - (lod.vertexBytes + lod.indexBytes) < 16) t.chunkSizeMatch++;
            let ok = true;
            for (const s of lod.sections) for (let k = 0; k < s.triangles * 3; k++) if (data.readUInt16LE(lod.vertexBytes + (s.firstIndex + k) * 2) >= s.vertexCount) { ok = false; break; }
            if (ok) t.indicesInRange++;
          }
        }
      } catch (err) { t.failed++; const k = err.message.replace(/\d+/g, 'N'); errs[k] = (errs[k] || 0) + 1; }
    }
    console.log(t, errs);
  } else if (cmd === 'rebuild') {
    // decode + write every LOD's geometry without changes: must give the original bytes
    let same = 0, diff = 0, failed = 0, layoutOk = 0; const ex = {};
    for (const e of meshes.values()) {
      let m; try { m = parseMeshSet(L.readAsset(fdOf(e.sb), e)); } catch { continue; }
      for (const lod of m.lods) {
        const data = lodData(index, m, lod);
        try {
          const w = writeGeometry(readEditable(lod, data));
          const want = data.subarray(0, Math.max(w.data.length, lod.vertexBytes + lod.indexBytes));
          if (w.data.equals(want) || (isInline(lod) && w.data.subarray(0, lod.vertexBytes + lod.indexBytes).equals(data))) same++;
          else { diff++; let at = 0; while (at < w.data.length && w.data[at] === want[at]) at++; const k = at < lod.vertexBytes ? 'vertices' : at < lod.vertexBytes + lod.indexBytes ? 'indices' : 'padding'; ex[k] = ex[k] || `${e.name} @${at}`; ex[k + ' count'] = (ex[k + ' count'] || 0) + 1; }
          if (w.vertexBytes === lod.vertexBytes && w.indexBytes === lod.indexBytes && w.sections.every((x, i) => x.vertexOffset === lod.sections[i].vertexOffset && x.firstIndex === lod.sections[i].firstIndex)) layoutOk++;
        } catch (err) { failed++; ex[err.message.replace(/d+/g, 'N')] = e.name; }
      }
    }
    console.log(`geometry rebuild: ${same} byte-identical, ${diff} different, ${failed} failed; layout (offsets, sizes) identical: ${layoutOk}`, ex);
  } else if (cmd === 'export') {
    const e = [...meshes.values()].find((x) => x.name.includes(String(a1 || '').toLowerCase()));
    if (!e) { console.log('no model matches', a1); process.exit(1); }
    const m = parseMeshSet(L.readAsset(fdOf(e.sb), e));
    const lod = m.lods[Number(a2) || 0];
    const geo = readGeometry(lod, lodData(index, m, lod));
    const dir = path.join(L.OUT_DIR, 'obj'); fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${m.shortName}_lod${Number(a2) || 0}`);
    fs.writeFileSync(base + '.mtl', [...new Set(geo.map((s) => s.material || 'default'))].map((n) => `newmtl ${n}\nKd 0.7 0.7 0.7\n`).join('\n'));
    fs.writeFileSync(base + '.obj', toObj(m, geo, path.basename(base) + '.mtl'));
    console.log(`${m.name}: LOD ${Number(a2) || 0}, ${geo.length} parts, ${geo.reduce((s, x) => s + x.vertices.length, 0)} vertices, ${geo.reduce((s, x) => s + x.triangles.length, 0)} triangles -> ${base}.obj`);
  } else if (cmd === 'model') {
    // node fb2_mesh.js model <name part>  -> output/models/<model>.glb with every LOD (lod0, lod1, ...) for editing
    const e = [...meshes.values()].find((x) => x.name.includes(String(a1 || '').toLowerCase()));
    if (!e) { console.log('no model matches', a1); process.exit(1); }
    const m = parseMeshSet(L.readAsset(fdOf(e.sb), e));
    const dir = path.join(L.OUT_DIR, 'models'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, m.shortName + '.glb');
    fs.writeFileSync(file, modelToGlb(index, m));
    console.log(`${m.name}: ${m.lods.length} LODs -> ${file}`);
  } else if (cmd === 'glbtest') {
    // export every model to .glb and import it back unchanged: the res and every chunk must come out byte-identical
    const limit = Number(a1) || Infinity;
    let n = 0, same = 0, diff = 0, failed = 0, skipped = 0; const ex = {};
    const t0 = Date.now();
    for (const e of meshes.values()) {
      if (n >= limit) break;
      let m; try { m = parseMeshSet(L.readAsset(fdOf(e.sb), e)); } catch { continue; }
      if (m.lods.some(isInline)) { skipped++; continue; }
      n++;
      try {
        const r = glbToModel(index, m, modelToGlb(index, m));
        const ok = r.res.equals(m.raw) && m.lods.every((lod) => { const c = r.chunks.get(lod.chunk), d = lodData(index, m, lod); return c && c.equals(d.subarray(0, c.length)) && c.length >= lod.vertexBytes + lod.indexBytes; });
        if (ok) same++; else { diff++; if (Object.keys(ex).length < 5) ex[e.name] = 'different'; }
      } catch (err) { failed++; const k = err.message.replace(/\d+/g, 'N').slice(0, 90); ex[k] = (ex[k] || 0) + 1; }
    }
    console.log(`glb round trip: ${same} byte-identical, ${diff} different, ${failed} failed, ${skipped} skipped (geometry inside the res) — ${((Date.now() - t0) / 1000).toFixed(0)} s`, ex);
  } else if (cmd === 'car') {
    // node fb2_mesh.js car che_cam_ss_67 [lod]  -> output/models/<car>.glb (all parts, wheels in place)
    if (!a1) { console.log('usage: car <car id, e.g. che_cam_ss_67> [lod]'); process.exit(1); }
    const parts = carParts(index, a1, Number(a2) || 0);
    if (!parts.length) { console.log('no parts found for', a1, '(car ids look like che_cam_ss_67; see _c4/vehicles/nfs/)'); process.exit(1); }
    const dir = path.join(L.OUT_DIR, 'models'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${a1}_lod${Number(a2) || 0}.glb`);
    fs.writeFileSync(file, toGlb(parts, a1));
    const tris = parts.reduce((s, p) => s + p.geometry.reduce((q, g) => q + g.triangles.length, 0) * p.transforms.length, 0);
    console.log(`${a1}: ${parts.length} parts (${parts.map((p) => p.name + (p.transforms.length > 1 ? ' x' + p.transforms.length : '')).join(', ')}), ${tris} triangles -> ${file}`);
  } else console.log('Commands: selftest [models to check deeply] | rebuild | export <name part> [lod] | car <car id> [lod]');
}
