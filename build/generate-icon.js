/* Generates build/icon.ico (+ icon.png) — Pulse branding: dark rounded tile
 * with the glowing cyan heartbeat waveform from the default theme.
 * Pure Node (zlib only); rerun with `node build/generate-icon.js` after
 * tweaking colors below to match styles.css tokens. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Brand tokens (default "Pulse cyan" theme in src/renderer/styles.css)
const SURFACE_TOP = [16, 27, 48];    // gradient top, a touch lighter than --surface
const SURFACE_BOT = [6, 10, 18];     // --surface #060a12
const EDGE = [64, 96, 140];          // --panel-edge
const GLOW = [34, 195, 230];         // between --accent-ui and --glow-ui
const CORE = [174, 244, 255];        // hot line core

// Heartbeat polyline, normalized coords (y down)
const WAVE = [
  [0.12, 0.55], [0.32, 0.55], [0.40, 0.66], [0.48, 0.26],
  [0.58, 0.74], [0.66, 0.55], [0.88, 0.55],
];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

// Render one RGBA frame at `size` px, drawn 4x supersampled then box-averaged.
function render(size) {
  const SS = 4, W = size * SS;
  const hi = new Float64Array(W * W * 4);
  const cx = W / 2, cy = W / 2;
  const margin = 0.035 * W, r = 0.22 * W;
  const hw = W / 2 - margin, hh = W / 2 - margin;
  const coreR = W * (size <= 32 ? 0.05 : 0.036);
  const glowR = W * (size <= 32 ? 0.13 : 0.10);
  const edgeW = Math.max(1, W * 0.008);
  const wave = WAVE.map(([x, y]) => [x * W, y * W]);

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      // signed distance to rounded rect
      const qx = Math.abs(px - cx) - (hw - r);
      const qy = Math.abs(py - cy) - (hh - r);
      const sd = Math.min(Math.max(qx, qy), 0) +
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
      const o = (y * W + x) * 4;
      if (sd > 0) continue; // outside tile → transparent

      // background gradient + faint centered cyan haze
      const t = py / W;
      let rr = SURFACE_TOP[0] + (SURFACE_BOT[0] - SURFACE_TOP[0]) * t;
      let gg = SURFACE_TOP[1] + (SURFACE_BOT[1] - SURFACE_TOP[1]) * t;
      let bb = SURFACE_TOP[2] + (SURFACE_BOT[2] - SURFACE_TOP[2]) * t;
      const dc2 = (px - cx) ** 2 + (py - cy) ** 2;
      const haze = Math.exp(-dc2 / (0.38 * W) ** 2) * 0.10;
      rr += GLOW[0] * haze; gg += GLOW[1] * haze; bb += GLOW[2] * haze;

      // waveform: soft glow halo + hot core
      let dmin = Infinity;
      for (let i = 0; i < wave.length - 1; i++) {
        const d = distToSegment(px, py, wave[i][0], wave[i][1], wave[i + 1][0], wave[i + 1][1]);
        if (d < dmin) dmin = d;
      }
      const halo = Math.exp(-((dmin / glowR) ** 2)) * 0.65;
      rr += (GLOW[0] - rr) * halo; gg += (GLOW[1] - gg) * halo; bb += (GLOW[2] - bb) * halo;
      if (dmin < coreR) {
        const k = Math.min(1, (coreR - dmin) / (SS * 0.5));
        rr += (CORE[0] - rr) * k; gg += (CORE[1] - gg) * k; bb += (CORE[2] - bb) * k;
      }

      // subtle edge ring just inside the border
      if (sd > -edgeW) {
        const k = 0.35 * (1 - (-sd / edgeW));
        rr += (EDGE[0] - rr) * k; gg += (EDGE[1] - gg) * k; bb += (EDGE[2] - bb) * k;
      }

      hi[o] = rr; hi[o + 1] = gg; hi[o + 2] = bb; hi[o + 3] = 255;
    }
  }

  // 4x4 box downsample → final RGBA buffer
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r0 += hi[o]; g0 += hi[o + 1]; b0 += hi[o + 2]; a0 += hi[o + 3];
        }
      }
      const n = SS * SS, o = (y * size + x) * 4;
      out[o] = Math.round(r0 / n); out[o + 1] = Math.round(g0 / n);
      out[o + 2] = Math.round(b0 / n); out[o + 3] = Math.round(a0 / n);
    }
  }
  return out;
}

// ── PNG encoder (RGBA8, filter 0) ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO entry as classic 32-bit DIB (BGRA bottom-up + AND mask) ────────
function encodeDIB(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND heights
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4, dst = (y * size + x) * 4;
      px[dst] = rgba[src + 2]; px[dst + 1] = rgba[src + 1];
      px[dst + 2] = rgba[src]; px[dst + 3] = rgba[src + 3];
    }
  }
  const mask = Buffer.alloc(((size + 31) >> 5) * 4 * size); // all opaque
  return Buffer.concat([header, px, mask]);
}

function buildICO(frames) {
  // frames: [{size, data (encoded entry bytes)}]
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e[0] = f.size >= 256 ? 0 : f.size;
    e[1] = f.size >= 256 ? 0 : f.size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += f.data.length;
  }
  return Buffer.concat([dir, ...entries, ...frames.map((f) => f.data)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map((size) => {
  const rgba = render(size);
  // 256 entry stored as PNG (per ICO spec); smaller sizes as classic DIBs
  const data = size >= 256 ? encodePNG(rgba, size) : encodeDIB(rgba, size);
  return { size, data, rgba };
});

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO(frames));
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(frames[frames.length - 1].rgba, 256));
console.log(`wrote build/icon.ico (${sizes.join(', ')} px) and build/icon.png`);
