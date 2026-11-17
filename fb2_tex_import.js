'use strict';
/*
 * fb2_tex_import.js — PNG -> DXT1/DXT5 -> texture chunk mod for Need for Speed: The Run (Frostbite 2).
 *
 *   node fb2_tex_import.js --game "<game dir>" <image.png> <texture name or part of it> [--mods ./mods] [--preview out.png]
 *
 * Every texture (TextureAsset res, type 5c4954a6) whose name contains the given text gets the image:
 * the PNG is resized to the texture's size, mip levels are generated, each level is DXT-encoded, and the result
 * is written to mods/chunk/<pixel chunk guid>.chunk. Apply it with fb2_patch.js.
 * The texture header is not changed: size, format and mip count stay the same.
 * Supported texture formats: DXT1 (format 0) and DXT5 (format 2). Needs the index (fb2_extract.js index).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./fb2_extract.js');
const T = require('./fb2_texture.js');

// ============================================================ PNG reader ===

function readPng(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file: ' + file);
  let p = 8, w, h, depth, ctype, interlace, plte = null, trns = null;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG is not supported: re-save it without interlacing');
  if (depth !== 8 && depth !== 16) throw new Error('PNG bit depth ' + depth + ' is not supported (use 8-bit)');
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans) throw new Error('PNG color type ' + ctype + ' is not supported');
  const bpp = chans * (depth / 8), stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { // undo the per-row filters
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, up = y ? px[row - stride + x] : 0, c = x >= bpp && y ? px[row - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[row + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  const s8 = (i) => px[i * (depth / 8)]; // 16-bit: take the high byte
  for (let i = 0; i < w * h; i++) {
    const o = i * chans;
    let r, g, bl, al = 255;
    if (ctype === 0) r = g = bl = s8(o);
    else if (ctype === 4) { r = g = bl = s8(o); al = s8(o + 1); }
    else if (ctype === 2) { r = s8(o); g = s8(o + 1); bl = s8(o + 2); }
    else if (ctype === 6) { r = s8(o); g = s8(o + 1); bl = s8(o + 2); al = s8(o + 3); }
    else { const k = px[i]; r = plte[k * 3]; g = plte[k * 3 + 1]; bl = plte[k * 3 + 2]; al = trns && k < trns.length ? trns[k] : 255; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = bl; rgba[i * 4 + 3] = al;
  }
  return { w, h, rgba };
}

// ============================================================ resize / mips ===

function resize(src, sw, sh, dw, dh) { // bilinear
  if (sw === dw && sh === dh) return Buffer.from(src);
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * sh / dh - 0.5), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * sw / dw - 0.5), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c], d = src[(y1 * sw + x0) * 4 + c], e = src[(y1 * sw + x1) * 4 + c];
        out[(y * dw + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return out;
}

// ============================================================ DXT encoders ===

const to565 = (r, g, b) => ((r * 31 + 127) / 255 << 11) | ((g * 63 + 127) / 255 << 5) | ((b * 31 + 127) / 255);
const from565 = (c) => [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0];

function blockPixels(img, w, h, bx, by) { // 16 RGBA pixels, edges clamped
  const px = [];
  for (let i = 0; i < 16; i++) {
    const x = Math.min(w - 1, bx + (i & 3)), y = Math.min(h - 1, by + (i >> 2)), o = (y * w + x) * 4;
    px.push([img[o], img[o + 1], img[o + 2], img[o + 3]]);
  }
  return px;
}

function colorBlock(px, out, o) { // 4-color mode (c0 > c1), endpoints = bounding box of the block colors
  let mn = [255, 255, 255], mx = [0, 0, 0];
  for (const p of px) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], p[c]); mx[c] = Math.max(mx[c], p[c]); }
  let c0 = to565(...mx), c1 = to565(...mn);
  if (c0 < c1) [c0, c1] = [c1, c0];
  let bits = 0;
  if (c0 !== c1) {
    const a = from565(c0), b = from565(c1);
    const pal = [a, b, a.map((v, i) => (2 * v + b[i]) / 3 | 0), a.map((v, i) => (v + 2 * b[i]) / 3 | 0)];
    px.forEach((p, i) => {
      let best = 0, bd = Infinity;
      pal.forEach((q, k) => { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (d < bd) { bd = d; best = k; } });
      bits |= best << (2 * i);
    });
  }
  out.writeUInt16LE(c0, o); out.writeUInt16LE(c1, o + 2); out.writeUInt32LE(bits >>> 0, o + 4);
}

function alphaBlock(px, out, o) { // 8-alpha mode (a0 > a1)
  let a0 = 0, a1 = 255;
  for (const p of px) { a0 = Math.max(a0, p[3]); a1 = Math.min(a1, p[3]); }
  out[o] = a0; out[o + 1] = a1;
  let bits = 0n;
  if (a0 !== a1) {
    const pal = [a0, a1]; for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
    px.forEach((p, i) => {
      let best = 0, bd = Infinity;
      pal.forEach((q, k) => { const d = Math.abs(p[3] - q); if (d < bd) { bd = d; best = k; } });
      bits |= BigInt(best) << BigInt(3 * i);
    });
  }
  for (let i = 0; i < 6; i++) out[o + 2 + i] = Number((bits >> BigInt(8 * i)) & 255n);
}

function encodeDXT(img, w, h, kind) {
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), bs = kind === 1 ? 8 : 16;
  const out = Buffer.alloc(bw * bh * bs);
  let o = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, o += bs) {
    const px = blockPixels(img, w, h, bx * 4, by * 4);
    if (kind === 1) colorBlock(px, out, o);
    else { alphaBlock(px, out, o); colorBlock(px, out, o + 8); }
  }
  return out;
}

// Builds the full chunk (all mip levels) for a texture header; checks sizes against the header.
function buildTextureChunk(hdrBuf, image) {
  const fmt = hdrBuf.readUInt32LE(0x08), w = hdrBuf.readUInt16LE(0x10), h = hdrBuf.readUInt16LE(0x12), mips = hdrBuf[0x1a];
  const kind = { 0: 1, 2: 5 }[fmt];
  if (!kind) throw new Error('texture format ' + fmt + ' is not supported (only DXT1 = 0 and DXT5 = 2)');
  const parts = [];
  let level = resize(image.rgba, image.w, image.h, w, h), lw = w, lh = h;
  for (let m = 0; m < mips; m++) {
    const want = hdrBuf.readUInt32LE(0x2c + m * 4);
    const data = encodeDXT(level, lw, lh, kind);
    if (data.length !== want) throw new Error(`mip ${m}: encoded ${data.length} bytes, header expects ${want}; refusing`);
    parts.push(data);
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    level = resize(level, lw, lh, nw, nh); lw = nw; lh = nh;
  }
  return { data: Buffer.concat(parts), w, h, kind, mips };
}

module.exports = { readPng, resize, encodeDXT, buildTextureChunk };

// ============================================================ CLI ===
if (require.main === module) {
  const args = L.OPTS.rest;
  const opt = (f, d) => { const i = args.indexOf(f); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const mods = path.resolve(opt('--mods', 'mods'));
  const preview = opt('--preview', null);
  const [pngFile, pattern] = args;
  if (!pngFile || !pattern) { console.log('Usage: node fb2_tex_import.js --game "<game dir>" <image.png> <texture name or part of it> [--mods ./mods] [--preview out.png]'); process.exit(1); }
  const image = readPng(pngFile);
  console.log(`image: ${image.w}x${image.h}`);
  const index = L.loadIndex();
  const fds = new Map(); const fdOf = (sb) => { if (!fds.has(sb)) fds.set(sb, fs.openSync(path.join(L.DATA_DIR, sb), 'r')); return fds.get(sb); };
  const seen = new Set();
  let n = 0;
  for (const e of index) {
    if (e.kind !== 'res' || e.extra !== '5c4954a6' || seen.has(e.name) || !e.name.toLowerCase().includes(pattern.toLowerCase())) continue;
    seen.add(e.name);
    const hdr = L.readAsset(fdOf(e.sb), e);
    const guid = hdr.toString('hex', 0x1c, 0x2c);
    try {
      const t = buildTextureChunk(hdr, image);
      const f = path.join(mods, 'chunk', guid + '.chunk');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t.data);
      if (preview && n === 0) T.writePng(preview, T.decodeDXT(t.data, t.w, t.h, t.kind), t.w, t.h, false);
      console.log(`  ${e.name}  ${t.w}x${t.h} DXT${t.kind}, ${t.mips} mip(s) -> chunk/${guid}.chunk`);
      n++;
    } catch (err) { console.log(`  SKIPPED ${e.name}: ${err.message}`); }
  }
  console.log(n ? `${n} texture mod(s) written to ${mods}. Apply with: node fb2_patch.js --game "<game dir>" apply` : 'No matching textures.');
}
