'use strict';
/*
 * fb2_texture.js — converts Frostbite 2 textures (Need for Speed: The Run) to PNG.
 *
 * How a texture is stored:
 *   ebx (TextureAsset) — just the name;
 *   res (type 5c4954a6) — 128-byte header: format, width, height, mips and the chunk GUID;
 *   chunk — the pixels (zlib block-compressed), stored in a bundle or in Chunks*.sb.
 * Pixels use the GPU format DXT (4x4 blocks), which we decode ourselves.
 *
 * Usage:
 *   node fb2_texture.js --game "<game dir>" word1 word2 ...   — textures whose name contains a word -> output/png
 *   node fb2_texture.js --game "<game dir>" --from-unpacked   — textures extracted by fb2_analyze.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./fb2_extract.js');

// PNGs go to <--out>/png
const OUT = path.join(L.OUT_DIR, 'png');
const TEXTURE_RES_TYPE = '5c4954a6';

// ---------------------------------------------------------- header --------
function parseTextureHeader(b) {
  return {
    format: b.readUInt32LE(0x08),
    width: b.readUInt16LE(0x10),
    height: b.readUInt16LE(0x12),
    mipCount: b[0x1a],
    chunk: b.toString('hex', 0x1c, 0x2c),
    mip0Size: b.readUInt32LE(0x2c),
  };
}

// ---------------------------------------------------------- find chunk ----
let chunkMap = null; // guid -> {sb, pos, size}
function loadChunkMap(index) {
  chunkMap = new Map();
  const walk = (d, o = []) => {
    if (!fs.existsSync(d)) return o;
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, x.name);
      if (x.isDirectory()) walk(f, o); else if (/\.toc$/i.test(x.name) && x.name.toLowerCase() !== 'layout.toc') o.push(f);
    }
    return o;
  };
  // 1) shared stores (a .toc with a chunks list), the official patch first: what the game streams
  const patchWin32 = path.join(path.dirname(L.DATA_DIR), 'Update', 'Patch', 'Data', 'Win32');
  for (const t of [...walk(patchWin32), ...walk(path.join(L.DATA_DIR, 'Win32'))]) {
    const sb = path.relative(L.DATA_DIR, t.replace(/\.toc$/i, '.sb')); // relative to Data (the patch is "../Update/...")
    for (const c of L.readToc(t).chunks || []) if (!chunkMap.has(c.id)) chunkMap.set(c.id, { sb, pos: c.offset, size: c.size });
  }
  // 2) copies inside bundles (from the index); entries without data (size 0) only refer to the stores above
  for (const e of index) if (e.kind === 'chunk' && e.size > 0 && !chunkMap.has(e.name)) chunkMap.set(e.name, { sb: e.sb, pos: e.pos, size: e.size });
}

// ---------------------------------------------------------- DXT -------------
function rgb565(c) { return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0]; }

// DXT1 color block (8 bytes): two colors + 16 two-bit indices
function colorBlock(src, o, out, w, x, y, dxt1) {
  const c0 = src.readUInt16LE(o), c1 = src.readUInt16LE(o + 2);
  const a = rgb565(c0), b = rgb565(c1);
  const pal = [a, b];
  if (c0 > c1 || !dxt1) {
    pal.push(a.map((v, i) => (2 * v + b[i]) / 3 | 0), a.map((v, i) => (v + 2 * b[i]) / 3 | 0));
  } else {
    pal.push(a.map((v, i) => (v + b[i]) / 2 | 0), null); // null = transparent
  }
  const bits = src.readUInt32LE(o + 4);
  for (let i = 0; i < 16; i++) {
    const px = x + (i & 3), py = y + (i >> 2);
    if (px >= w) continue;
    const c = pal[(bits >> (2 * i)) & 3];
    const d = (py * w + px) * 4;
    if (c) { out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = 255; } else out[d + 3] = 0;
  }
}

function decodeDXT(src, w, h, kind) { // kind: 1, 3 or 5
  const out = Buffer.alloc(w * h * 4);
  const bs = kind === 1 ? 8 : 16;
  let o = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4, o += bs) {
      if (o + bs > src.length) return out;
      if (kind === 1) { colorBlock(src, o, out, w, x, y, true); continue; }
      colorBlock(src, o + 8, out, w, x, y, false);
      // alpha channel
      const alpha = new Array(16);
      if (kind === 3) {
        for (let i = 0; i < 16; i++) alpha[i] = ((src[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      } else {
        const a0 = src[o], a1 = src[o + 1];
        const pal = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
        else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0); pal.push(0, 255); }
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(src[o + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
      }
      for (let i = 0; i < 16; i++) {
        const px = x + (i & 3), py = y + (i >> 2);
        if (px < w && py < h) out[(py * w + px) * 4 + 3] = alpha[i];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------- PNG -------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// PNG file bytes from RGBA pixels (opaque: drop the alpha channel)
function encodePng(rgba, w, h, opaque) {
  const ch = opaque ? 3 : 4;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0; // row filter: none
    for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) raw[y * (w * ch + 1) + 1 + x * ch + c] = rgba[(y * w + x) * 4 + c];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function writePng(file, rgba, w, h, opaque) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(rgba, w, h, opaque));
}

// ---------------------------------------------------------- main ----------
const fds = new Map();
const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };

// Pick the format by bytes per pixel (more reliable than guessing format codes)
// BC4 block (8 bytes) -> 16 values 0..255 (the same scheme as the DXT5 alpha block)
function bc4Block(src, o) {
  const a0 = src[o], a1 = src[o + 1], pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0); else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0); pal.push(0, 255); }
  const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16), hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
  return Array.from({ length: 16 }, (_, k) => pal[k < 8 ? (lo >> (3 * k)) & 7 : (hi >> (3 * (k - 8))) & 7]);
}
// BC4 (one channel, shown grey) and BC5 (two channels: a normal map; blue = the rebuilt z)
function decodeBC45(src, w, h, two) {
  const out = Buffer.alloc(w * h * 4), bs = two ? 16 : 8;
  let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4, o += bs) {
    if (o + bs > src.length) return out;
    const r = bc4Block(src, o), g = two ? bc4Block(src, o + 8) : null;
    for (let k = 0; k < 16; k++) {
      const x = bx + (k & 3), y = by + (k >> 2); if (x >= w || y >= h) continue;
      const q = (y * w + x) * 4;
      if (!two) { out[q] = out[q + 1] = out[q + 2] = r[k]; out[q + 3] = 255; continue; }
      const nx = r[k] / 127.5 - 1, ny = g[k] / 127.5 - 1;
      out[q] = r[k]; out[q + 1] = g[k]; out[q + 2] = Math.round((Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255); out[q + 3] = 255;
    }
  }
  return out;
}
// Texture formats by the code in the header (offset 0x08); each was checked by looking at decoded pictures
const TEXTURE_FORMATS = {
  0: { name: 'DXT1', bpp: 0.5 }, 18: { name: 'DXT1 (normal map)', bpp: 0.5 }, 1: { name: 'DXT3', bpp: 1 }, 2: { name: 'DXT5', bpp: 1 },
  3: { name: 'BC4 (one channel)', bpp: 0.5 }, 17: { name: 'BC5 (normal map)', bpp: 1 }, 20: { name: 'DXT5 normal map (x in alpha, y in green)', bpp: 1 },
  10: { name: 'L8 (grey, uncompressed)', bpp: 1 }, 11: { name: '16-bit lighting data (shown scaled)', bpp: 2 }, 9: { name: 'BGRA8 (uncompressed)', bpp: 4 },
};
function decodePixels(format, data, w, h) {
  switch (format) {
    case 0: case 18: return decodeDXT(data, w, h, 1);
    case 1: return decodeDXT(data, w, h, 3);
    case 2: return decodeDXT(data, w, h, 5);
    case 3: return decodeBC45(data, w, h, false);
    case 17: return decodeBC45(data, w, h, true);
    case 20: { // DXT5 with the normal's x in alpha and y in green; z rebuilt into blue
      const o = decodeDXT(data, w, h, 5);
      for (let i = 0; i < o.length; i += 4) { const nx = o[i + 3] / 127.5 - 1, ny = o[i + 1] / 127.5 - 1; o[i] = o[i + 3]; o[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255); o[i + 3] = 255; }
      return o;
    }
    case 10: { const o = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = data[i]; o[i * 4 + 3] = 255; } return o; }
    case 11: { // 16-bit numbers (lighting data, not a picture): scaled so the largest value is white
      let mx = 1; for (let i = 0; i < w * h; i++) mx = Math.max(mx, data.readUInt16LE(i * 2));
      const o = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = Math.round(data.readUInt16LE(i * 2) / mx * 255); o[i * 4 + 3] = 255; } return o;
    }
    case 9: { if (data.length < w * h * 4) return null; const o = Buffer.from(data.subarray(0, w * h * 4)); for (let i = 0; i < o.length; i += 4) { const t = o[i]; o[i] = o[i + 2]; o[i + 2] = t; } return o; } // BGRA -> RGBA
    default: return null;
  }
}

function decodeTexture(resEntry) {
  const hdr = parseTextureHeader(L.readAsset(fdOf(resEntry.sb), resEntry));
  const loc = chunkMap.get(hdr.chunk);
  if (!loc) return { hdr, error: 'chunk not found' };
  const data = L.unpackBlocks((() => { const b = Buffer.alloc(loc.size); fs.readSync(fdOf(loc.sb), b, 0, loc.size, loc.pos); return b; })());
  const rgba = decodePixels(hdr.format, data, hdr.width, hdr.height);
  if (!rgba) return { hdr, error: `format ${hdr.format} cannot be shown yet` };
  return { hdr, rgba };
}

function main() {
  const args = L.OPTS.rest;
  const index = L.loadIndex();
  loadChunkMap(index);
  const res = new Map();
  for (const e of index) if (e.kind === 'res' && e.extra === TEXTURE_RES_TYPE && !res.has(e.name.toLowerCase())) res.set(e.name.toLowerCase(), e);

  let names;
  if (args[0] === '--from-unpacked') { // take names from the extraction manifest
    names = fs.readFileSync(path.join(L.OUT_DIR, '_manifest.tsv'), 'utf8').split('\n').slice(1).map((l) => l.split('\t'))
      .filter((r) => r[1] === 'res' && r[3] && r[3].endsWith('.res_' + TEXTURE_RES_TYPE))
      .filter((r) => !args[1] || r[0] === args[1]) // --from-unpacked <category> — only that category
      .map((r) => [r[0], r[3].split('\\').slice(2).join('/').replace(/\.res_[0-9a-f]+$/, '').toLowerCase()]);
  } else {
    const w = args.map((x) => x.toLowerCase());
    names = [...res.keys()].filter((n) => w.some((x) => n.includes(x))).map((n) => ['search', n]);
  }
  const seen = new Set();
  let ok = 0, fail = 0;
  const failures = {};
  for (const [cat, n] of names) {
    if (seen.has(n) || !res.has(n)) continue;
    seen.add(n);
    try {
      const r = decodeTexture(res.get(n));
      if (r.error) { fail++; failures[r.error] = (failures[r.error] || 0) + 1; continue; }
      const file = path.join(OUT, cat, n.replace(/^_c4\//, '').replace(/[<>:"|?*]/g, '_') + '.png');
      const opaque = !r.rgba.some((v, i) => i % 4 === 3 && v !== 255);
      writePng(file, r.rgba, r.hdr.width, r.hdr.height, opaque);
      ok++;
      console.log(`${r.hdr.width}x${r.hdr.height}\t${path.relative(OUT, file)}`);
    } catch (err) { fail++; failures[err.message] = (failures[err.message] || 0) + 1; }
  }
  console.log(`\ndone: ${ok} PNG, failed: ${fail}`, failures);
}

if (require.main === module) main();
module.exports = { parseTextureHeader, decodeDXT, decodePixels, bc4Block, TEXTURE_FORMATS, writePng, encodePng, loadChunkMap, decodeTexture, TEXTURE_RES_TYPE };
