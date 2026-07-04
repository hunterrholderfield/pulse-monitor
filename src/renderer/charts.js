'use strict';
/* Canvas chart engine for Pulse. No dependencies.
 * All charts share: DPR-aware sizing, recessive grid, glowing 2px strokes,
 * ink-colored text (identity lives in the mark color, not the text).
 * IIFE-wrapped: classic scripts share top-level scope with app.js. */
(() => {

const INK = '#dbe7f4';
const INK2 = '#8296ad';
const INK3 = '#55677d';
const GRID = 'rgba(90,130,180,0.12)';
const MONO = '"Cascadia Mono", Consolas, monospace';

const tooltipEl = () => document.getElementById('tooltip');

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

/* ── Radial gauge: 240° arc, animated needle-less fill, center readout ── */
class RadialGauge {
  constructor(canvas, { color, glow, label = '', max = 100, unit = '%' }) {
    this.canvas = canvas;
    this.color = color; this.glow = glow;
    this.label = label; this.max = max; this.unit = unit;
    this.value = 0; this.shown = 0;
  }

  set(v) { this.value = v == null ? null : Math.max(0, Math.min(this.max, v)); }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.56, R = Math.min(w, h * 1.1) * 0.40;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;   // 240° sweep

    // ease toward target for smooth motion
    const target = this.value == null ? 0 : this.value;
    this.shown += (target - this.shown) * 0.12;
    const frac = this.shown / this.max;

    // track
    ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();

    // ticks
    ctx.save();
    ctx.strokeStyle = INK3; ctx.lineWidth = 1;
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (a1 - a0) * (i / 12);
      const r1 = R + 9, r2 = R + (i % 3 === 0 ? 15 : 12);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }
    ctx.restore();

    // value arc with glow
    if (this.value != null) {
      ctx.save();
      ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.strokeStyle = this.color;
      ctx.shadowColor = this.glow; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a0 + (a1 - a0) * Math.max(0.001, frac));
      ctx.stroke();
      // hot endpoint
      const ae = a0 + (a1 - a0) * frac;
      ctx.fillStyle = '#fff'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(cx + Math.cos(ae) * R, cy + Math.sin(ae) * R, 3, 0, 7); ctx.fill();
      ctx.restore();
    }

    // center readout — ink text, accent glow
    ctx.textAlign = 'center';
    ctx.fillStyle = this.value == null ? INK3 : INK;
    ctx.shadowColor = this.glow; ctx.shadowBlur = this.value == null ? 0 : 12;
    ctx.font = `600 ${Math.round(R * 0.62)}px ${MONO}`;
    ctx.fillText(this.value == null ? '—' : String(Math.round(this.shown)), cx, cy + R * 0.16);
    ctx.shadowBlur = 0;
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = INK2;
    ctx.fillText(this.unit, cx, cy + R * 0.48);
    if (this.label) {
      ctx.fillStyle = INK3;
      ctx.fillText(this.label, cx, cy + R + 18);
    }
  }
}

/* ── Streaming chart: ring buffer, sliding window, crosshair tooltip ──── */
class StreamChart {
  /**
   * opts: {
   *   series: [{ color, glow, dash?, label }],
   *   capacity=120, min=0, max=100|'auto', fill=true,
   *   fmt: v => 'label', intervalMs (expected push cadence, for slide anim)
   * }
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.o = Object.assign({ capacity: 120, min: 0, max: 100, fill: true,
      fmt: (v) => String(Math.round(v)), intervalMs: 1000 }, opts);
    this.data = [];       // [{t, v:[...]}]
    this.lastPush = 0;
    this.hover = null;    // x px within canvas
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, cx: e.clientX, cy: e.clientY };
    });
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      tooltipEl().classList.add('hidden');
    });
  }

  push(t, values) {
    this.data.push({ t, v: values });
    if (this.data.length > this.o.capacity + 2) this.data.shift();
    this.lastPush = performance.now();
  }

  _scaleMax() {
    if (this.o.max !== 'auto') return this.o.max;
    let m = 0;
    for (const d of this.data) for (const v of d.v) if (v != null && v > m) m = v;
    return niceCeil(m || 1);
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const max = this._scaleMax();
    const n = this.o.capacity;
    const step = w / (n - 1);
    // sub-pixel slide between pushes → holographic smooth scroll
    const frac = this.lastPush
      ? Math.min(1, (performance.now() - this.lastPush) / this.o.intervalMs) : 0;
    const xOf = (i) => w - ((this.data.length - 1 - i) + frac) * step;
    const yOf = (v) => h - 4 - (Math.max(0, v) / max) * (h - 14);

    // recessive grid: 3 horizontal lines
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const y = 4 + ((h - 14) * g) / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // max label
    ctx.font = `9px ${MONO}`; ctx.fillStyle = INK3; ctx.textAlign = 'left';
    ctx.fillText(this.o.fmt(max), 4, 12);

    if (this.data.length < 2) return this._drawHover(ctx, w, h, max, xOf, yOf);

    this.o.series.forEach((s, si) => {
      ctx.save();
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < this.data.length; i++) {
        const v = this.data[i].v[si];
        if (v == null) continue;
        const x = xOf(i), y = yOf(v);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = s.color;
      if (s.dash) ctx.setLineDash([4, 4]);
      ctx.shadowColor = s.glow; ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.setLineDash([]);

      // area fill under the first (solid) series only
      if (this.o.fill && si === 0 && started) {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, hexA(s.color, 0.22));
        grad.addColorStop(1, hexA(s.color, 0));
        ctx.lineTo(xOf(this.data.length - 1), h);
        ctx.lineTo(xOf(0), h);
        ctx.closePath();
        ctx.shadowBlur = 0;
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.restore();
    });

    this._drawHover(ctx, w, h, max, xOf, yOf);
  }

  _drawHover(ctx, w, h, max, xOf, yOf) {
    if (!this.hover || this.data.length < 2) return;
    // nearest point to cursor x
    let best = -1, bd = 1e9;
    for (let i = 0; i < this.data.length; i++) {
      const d = Math.abs(xOf(i) - this.hover.x);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return;
    const pt = this.data[best], x = xOf(best);

    ctx.save();
    ctx.strokeStyle = 'rgba(219,231,244,0.35)';
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.setLineDash([]);
    this.o.series.forEach((s, si) => {
      const v = pt.v[si];
      if (v == null) return;
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.glow; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, yOf(v), 3.5, 0, 7); ctx.fill();
      // 2px surface ring so overlapping markers stay separable
      ctx.shadowBlur = 0; ctx.lineWidth = 2; ctx.strokeStyle = '#060a12';
      ctx.stroke();
    });
    ctx.restore();

    const time = new Date(pt.t).toLocaleTimeString();
    const lines = [time, ...this.o.series.map((s, si) =>
      pt.v[si] == null ? null : `${s.label}  ${this.o.fmt(pt.v[si])}`).filter(Boolean)];
    showTooltip(this.hover.cx, this.hover.cy, lines.join('\n'));
  }
}

/* ── Per-core vertical bars ───────────────────────────────────────────── */
class CoreBars {
  constructor(canvas, { color, glow }) {
    this.canvas = canvas; this.color = color; this.glow = glow;
    this.values = []; this.shown = [];
  }

  set(values) {
    this.values = values;
    if (this.shown.length !== values.length) this.shown = values.slice();
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const n = this.values.length;
    if (!n) return;
    const gap = 2;
    const bw = Math.max(2, (w - gap * (n - 1)) / n);
    ctx.save();
    for (let i = 0; i < n; i++) {
      this.shown[i] += (this.values[i] - this.shown[i]) * 0.2;
      const x = i * (bw + gap);
      // track
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(x, 0, bw, h - 12);
      // bar, rounded data end, glowing
      const bh = Math.max(2, ((h - 12) * this.shown[i]) / 100);
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.glow; ctx.shadowBlur = 6;
      roundTopRect(ctx, x, h - 12 - bh, bw, bh, Math.min(4, bw / 2));
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    // core index labels, every 4th to stay recessive
    ctx.fillStyle = INK3; ctx.font = `8px ${MONO}`; ctx.textAlign = 'center';
    for (let i = 0; i < n; i += n > 16 ? 4 : 2) {
      ctx.fillText(String(i), i * (bw + gap) + bw / 2, h - 2);
    }
    ctx.restore();
  }
}

/* ── History overview: multi-series day chart with scrub playhead ─────── */
class HistoryChart {
  constructor(canvas, { series }) {
    this.canvas = canvas;
    this.series = series;      // [{key(row)=>v, color, glow, label}]
    this.rows = [];
    this.scrubT = null;        // epoch ms
    this.onScrub = null;
    this.hover = null;

    const pick = (e) => {
      if (!this.rows.length) return;
      const r = canvas.getBoundingClientRect();
      const fracX = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const t0 = this.rows[0].t, t1 = this.rows[this.rows.length - 1].t;
      this.scrubT = t0 + fracX * (t1 - t0);
      if (this.onScrub) this.onScrub(this.nearest(this.scrubT));
    };
    let dragging = false;
    canvas.addEventListener('mousedown', (e) => { dragging = true; pick(e); });
    window.addEventListener('mousemove', (e) => { if (dragging) pick(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, cx: e.clientX, cy: e.clientY };
    });
    canvas.addEventListener('mouseleave', () => {
      this.hover = null; tooltipEl().classList.add('hidden');
    });
  }

  setRows(rows) {
    this.rows = rows;
    this.scrubT = rows.length ? rows[rows.length - 1].t : null;
    if (rows.length && this.onScrub) this.onScrub(rows[rows.length - 1]);
  }

  nearest(t) {
    let best = null, bd = Infinity;
    for (const r of this.rows) {
      const d = Math.abs(r.t - t);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  step(dir) {
    if (!this.rows.length) return;
    const cur = this.nearest(this.scrubT == null ? this.rows[0].t : this.scrubT);
    const i = Math.max(0, Math.min(this.rows.length - 1, this.rows.indexOf(cur) + dir));
    this.scrubT = this.rows[i].t;
    if (this.onScrub) this.onScrub(this.rows[i]);
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    if (this.rows.length < 2) return;
    const t0 = this.rows[0].t, t1 = this.rows[this.rows.length - 1].t;
    const X = (t) => ((t - t0) / (t1 - t0)) * w;
    const Y = (v) => h - 16 - (Math.max(0, Math.min(100, v)) / 100) * (h - 30);

    // grid + hour labels
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.font = `9px ${MONO}`; ctx.fillStyle = INK3; ctx.textAlign = 'center';
    for (let g = 1; g <= 3; g++) {
      const y = 14 + ((h - 30) * g) / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const spanH = (t1 - t0) / 3600000;
    const stepH = spanH > 12 ? 4 : spanH > 4 ? 2 : 1;
    const firstHour = new Date(t0); firstHour.setMinutes(0, 0, 0);
    for (let tm = firstHour.getTime(); tm <= t1; tm += stepH * 3600000) {
      if (tm < t0) continue;
      const x = X(tm);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, h - 16); ctx.stroke();
      ctx.fillText(new Date(tm).getHours().toString().padStart(2, '0') + ':00', x, h - 4);
    }
    ctx.textAlign = 'left';
    ctx.fillText('100', 4, 12);

    // series lines + direct end labels
    this.series.forEach((s) => {
      ctx.save();
      ctx.beginPath();
      let started = false, lastY = null;
      for (const r of this.rows) {
        const v = s.key(r);
        if (v == null) continue;
        const x = X(r.t), y = Y(v);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true; lastY = y;
      }
      ctx.lineWidth = 2; ctx.strokeStyle = s.color;
      ctx.shadowColor = s.glow; ctx.shadowBlur = 6;
      ctx.stroke();
      if (started) {
        ctx.shadowBlur = 0; ctx.font = `9px ${MONO}`;
        ctx.fillStyle = INK2;
        ctx.fillText(' ' + s.label, Math.min(w - 34, w - 32), Math.max(10, Math.min(h - 20, lastY + 3)));
        ctx.fillStyle = s.color;
        ctx.fillRect(Math.min(w - 40, w - 38), Math.max(7, Math.min(h - 23, lastY)), 5, 5);
      }
      ctx.restore();
    });

    // scrub playhead
    if (this.scrubT != null) {
      const x = X(this.scrubT);
      ctx.save();
      ctx.strokeStyle = '#38d5f5'; ctx.lineWidth = 1.5;
      ctx.shadowColor = '#38d5f5'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 16); ctx.stroke();
      ctx.fillStyle = '#38d5f5';
      ctx.beginPath();
      ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // hover tooltip
    if (this.hover) {
      const t = t0 + (this.hover.x / w) * (t1 - t0);
      const r = this.nearest(t);
      if (r) {
        const lines = [new Date(r.t).toLocaleTimeString(),
          ...this.series.map((s) => {
            const v = s.key(r);
            return v == null ? null : `${s.label}  ${Math.round(v)}%`;
          }).filter(Boolean)];
        showTooltip(this.hover.cx, this.hover.cy, lines.join('\n'));
      }
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function roundTopRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function showTooltip(cx, cy, text) {
  const el = tooltipEl();
  el.textContent = text;
  el.classList.remove('hidden');
  const pad = 14;
  const rect = el.getBoundingClientRect();
  let x = cx + pad, y = cy - rect.height - 8;
  if (x + rect.width > window.innerWidth - 8) x = cx - rect.width - pad;
  if (y < 8) y = cy + pad;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function fmtBytes(b, perSec = false) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}${perSec ? '/s' : ''}`;
}

window.PulseCharts = { RadialGauge, StreamChart, CoreBars, HistoryChart, fmtBytes };

})();
