'use strict';
/* Pulse renderer wiring: live dashboard + history playback. */

const { RadialGauge, StreamChart, CoreBars, HistoryChart, fmtBytes } = window.PulseCharts;

const C = {
  cpu: { color: '#0891b2', glow: '#38d5f5' },
  gpu: { color: '#d946ef', glow: '#f07dfc' },
  mem: { color: '#059669', glow: '#2fe3a7' },
  dsk: { color: '#d97706', glow: '#f7b23b' },
  net: { color: '#6366f1', glow: '#9aa0ff' },
};

const $ = (id) => document.getElementById(id);
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

/* ── chart instances ──────────────────────────────────────────────────── */
const cpuGauge = new RadialGauge($('cpu-gauge'), { ...C.cpu, label: 'LOAD', unit: '%' });
const gpuGauge = new RadialGauge($('gpu-gauge'), { ...C.gpu, label: 'UTIL', unit: '%' });
const memGauge = new RadialGauge($('mem-gauge'), { ...C.mem, label: 'USED', unit: '%' });
const coreBars = new CoreBars($('cpu-cores'), C.cpu);

const cpuStream = new StreamChart($('cpu-stream'), {
  series: [{ ...C.cpu, label: 'LOAD' }], fmt: (v) => `${Math.round(v)}%`,
});
const gpuStream = new StreamChart($('gpu-stream'), {
  series: [{ ...C.gpu, label: 'UTIL' }], fmt: (v) => `${Math.round(v)}%`,
});
const memStream = new StreamChart($('mem-stream'), {
  series: [{ ...C.mem, label: 'USED' }], fmt: (v) => `${Math.round(v)}%`,
});
const dskStream = new StreamChart($('dsk-stream'), {
  series: [{ ...C.dsk, label: 'READ' }, { ...C.dsk, dash: true, label: 'WRITE' }],
  max: 'auto', fmt: (v) => fmtBytes(v, true),
});
const netStream = new StreamChart($('net-stream'), {
  series: [{ ...C.net, label: 'DOWN' }, { ...C.net, dash: true, label: 'UP' }],
  max: 'auto', fmt: (v) => fmtBytes(v, true),
});

const histChart = new HistoryChart($('hist-overview'), {
  series: [
    { key: (r) => r.cpu?.avg, ...C.cpu, label: 'CPU' },
    { key: (r) => r.gpu?.util, ...C.gpu, label: 'GPU' },
    { key: (r) => (r.mem ? (r.mem.used / r.mem.total) * 100 : null), ...C.mem, label: 'RAM' },
  ],
});
const hdCores = new CoreBars($('hd-cores'), C.cpu);

/* ── live snapshot handling ───────────────────────────────────────────── */
let firstSnap = true;
let lastSnapAt = 0;
let sampleIntervalMs = 1000;

window.pulse.onSnapshot((s) => {
  lastSnapAt = performance.now();

  cpuGauge.set(s.cpu.avg);
  coreBars.set(s.cpu.cores);
  cpuStream.o.intervalMs = sampleIntervalMs;
  cpuStream.push(s.t, [s.cpu.avg]);
  $('cpu-ghz').textContent = s.cpu.ghz != null ? `${s.cpu.ghz.toFixed(2)} GHz` : '—';
  $('cpu-temp').textContent = s.cpu.temp != null ? `${Math.round(s.cpu.temp)} °C` : 'N/A';

  gpuGauge.set(s.gpu.util);
  gpuStream.o.intervalMs = sampleIntervalMs;
  gpuStream.push(s.t, [s.gpu.util]);
  $('gpu-temp').textContent = s.gpu.temp != null ? `${Math.round(s.gpu.temp)} °C` : 'N/A';
  $('gpu-vram').textContent = s.gpu.vramUsed != null
    ? fmtBytes(s.gpu.vramUsed) + (s.gpu.vramTotal ? ` / ${fmtBytes(s.gpu.vramTotal)}` : '')
    : '—';
  setBar('gpu-vram-bar', s.gpu.vramTotal ? (s.gpu.vramUsed / s.gpu.vramTotal) * 100 : null);

  const memPct = (s.mem.used / s.mem.total) * 100;
  memGauge.set(memPct);
  memStream.o.intervalMs = sampleIntervalMs;
  memStream.push(s.t, [memPct]);
  $('mem-used').textContent = fmtBytes(s.mem.used);
  $('mem-avail').textContent = fmtBytes(s.mem.avail);
  $('mem-sub').textContent = `${fmtBytes(s.mem.total)} TOTAL`;
  $('mem-pf').textContent = s.mem.pfTotal
    ? `${fmtBytes(s.mem.pfUsed)} / ${fmtBytes(s.mem.pfTotal)}` : '—';
  setBar('pf-bar', s.mem.pfTotal ? (s.mem.pfUsed / s.mem.pfTotal) * 100 : null);

  renderDrives(s.dsk.drives);
  dskStream.o.intervalMs = sampleIntervalMs;
  dskStream.push(s.t, [s.dsk.read, s.dsk.write]);
  $('dsk-read').textContent = fmtBytes(s.dsk.read, true);
  $('dsk-write').textContent = fmtBytes(s.dsk.write, true);
  $('dsk-sub').textContent = `${s.dsk.drives.length} VOLUME${s.dsk.drives.length === 1 ? '' : 'S'}`;

  netStream.o.intervalMs = sampleIntervalMs;
  netStream.push(s.t, [s.net.rx, s.net.tx]);
  $('net-rx').textContent = fmtBytes(s.net.rx, true);
  $('net-tx').textContent = fmtBytes(s.net.tx, true);
  $('net-iface').textContent = s.net.iface;

  if (firstSnap) {
    firstSnap = false;
    $('boot-status').textContent = 'TELEMETRY ONLINE';
    setTimeout(() => $('boot').classList.add('done'), 500);
    window.__pulseRendered = true;
  }
});

function setBar(id, p) {
  const el = $(id);
  el.querySelector('i').style.width = p == null ? '0%' : `${Math.min(100, p)}%`;
  el.querySelector('em').textContent = p == null ? '—' : `${Math.round(p)}%`;
}

function renderDrives(drives) {
  const host = $('drives');
  // rebuild only when the drive set changes
  if (host.childElementCount !== drives.length) {
    host.innerHTML = drives.map((d, i) => `
      <div class="drive" data-i="${i}">
        <div class="drive-line"><b></b><span></span></div>
        <div class="hbar"><i></i><em></em></div>
      </div>`).join('');
  }
  drives.forEach((d, i) => {
    const el = host.children[i];
    if (!el) return;
    el.querySelector('b').textContent = d.fs;
    el.querySelector('span').textContent = `${fmtBytes(d.used)} / ${fmtBytes(d.size)}`;
    el.querySelector('.hbar i').style.width = `${Math.min(100, d.pct)}%`;
    el.querySelector('.hbar em').textContent = `${Math.round(d.pct)}%`;
  });
}

/* ── static info + statusbar ──────────────────────────────────────────── */
(async () => {
  const info = await window.pulse.getStatic();
  if (info && !info.error) {
    $('cpu-model').textContent = `${info.cpu.brand} · ${info.cpu.physicalCores}C/${info.cpu.cores}T`;
    $('gpu-model').textContent = info.gpu.model;
    $('host-line').textContent = `${info.host.toUpperCase()} // MISSION CONTROL`;
    $('status-os').textContent = info.os;
  }
  const cfg = await window.pulse.getSettings();
  sampleIntervalMs = cfg.sampleIntervalMs;
  $('status-log').textContent =
    `LOGGING EVERY ${cfg.logIntervalMs / 1000}s · ROTATE ${Math.round(cfg.maxFileBytes / 1048576)}MB · KEEP ${cfg.retentionDays}d`;
})();

setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  const stale = performance.now() - lastSnapAt > sampleIntervalMs * 3 + 2000;
  const tick = $('status-tick');
  tick.classList.toggle('stale', stale);
  tick.textContent = stale ? '● TELEMETRY STALE' : '● TELEMETRY LIVE';
}, 500);

/* ── render loop (~30fps) ─────────────────────────────────────────────── */
let liveVisible = true;
let raf = 0, lastFrame = 0;
function frame(ts) {
  raf = requestAnimationFrame(frame);
  if (ts - lastFrame < 33) return;
  lastFrame = ts;
  if (liveVisible) {
    cpuGauge.draw(); gpuGauge.draw(); memGauge.draw();
    coreBars.draw();
    cpuStream.draw(); gpuStream.draw(); memStream.draw();
    dskStream.draw(); netStream.draw();
  } else {
    histChart.draw();
    hdCores.draw();
  }
}
raf = requestAnimationFrame(frame);

/* ── tabs ─────────────────────────────────────────────────────────────── */
$('tab-live').addEventListener('click', () => switchView(true));
$('tab-history').addEventListener('click', () => switchView(false));

function switchView(live) {
  liveVisible = live;
  $('tab-live').classList.toggle('active', live);
  $('tab-history').classList.toggle('active', !live);
  $('view-live').classList.toggle('hidden', !live);
  $('view-history').classList.toggle('hidden', live);
  if (!live) refreshHistoryDays();
}

/* ── history view ─────────────────────────────────────────────────────── */
async function refreshHistoryDays() {
  const days = await window.pulse.listDays();
  const sel = $('hist-day');
  const prev = sel.value;
  sel.innerHTML = days.map((d) =>
    `<option value="${d.day}">${d.day} · ${(d.bytes / 1024).toFixed(0)} KB</option>`).join('');
  $('hist-empty').classList.toggle('hidden', days.length > 0);
  $('hist-detail').classList.toggle('hidden', days.length === 0);
  if (!days.length) { histChart.setRows([]); $('hist-meta').textContent = 'NO LOG FILES'; return; }
  sel.value = days.some((d) => d.day === prev) ? prev : days[days.length - 1].day;
  loadHistoryDay(sel.value);
}

async function loadHistoryDay(day) {
  const rows = await window.pulse.loadDay(day, 1500);
  histChart.setRows(rows);
  $('hist-meta').textContent = rows.length
    ? `${rows.length} SNAPSHOTS · ${new Date(rows[0].t).toLocaleTimeString()} → ${new Date(rows[rows.length - 1].t).toLocaleTimeString()}`
    : 'EMPTY LOG';
}

$('hist-day').addEventListener('change', (e) => loadHistoryDay(e.target.value));
$('hist-reload').addEventListener('click', refreshHistoryDays);

histChart.onScrub = (r) => {
  if (!r) return;
  $('scrub-time').textContent =
    `◄ ${new Date(r.t).toLocaleString()} ► — drag chart or use ← → keys`;
  $('hd-cpu').textContent = pct(r.cpu?.avg);
  hdCores.set(r.cpu?.cores || []);
  $('hd-gpu').textContent = pct(r.gpu?.util);
  $('hd-gpu2').textContent =
    `VRAM ${r.gpu?.vramUsed != null ? fmtBytes(r.gpu.vramUsed) : '—'}\nTEMP ${r.gpu?.temp != null ? Math.round(r.gpu.temp) + ' °C' : '—'}`;
  $('hd-mem').textContent = r.mem ? pct((r.mem.used / r.mem.total) * 100) : '—';
  $('hd-mem2').textContent = r.mem
    ? `${fmtBytes(r.mem.used)} / ${fmtBytes(r.mem.total)}\nPF ${fmtBytes(r.mem.pfUsed)}` : '—';
  $('hd-dsk').textContent = r.dsk ? fmtBytes(r.dsk.read + r.dsk.write, true) : '—';
  $('hd-dsk2').textContent = r.dsk
    ? `R ${fmtBytes(r.dsk.read, true)}\nW ${fmtBytes(r.dsk.write, true)}` : '—';
  $('hd-net').textContent = r.net ? fmtBytes(r.net.rx, true) : '—';
  $('hd-net2').textContent = r.net
    ? `▼ ${fmtBytes(r.net.rx, true)}\n▲ ${fmtBytes(r.net.tx, true)}` : '—';
};

window.addEventListener('keydown', (e) => {
  if (liveVisible) return;
  if (e.key === 'ArrowLeft') histChart.step(-1);
  if (e.key === 'ArrowRight') histChart.step(1);
});

/* ── settings modal ───────────────────────────────────────────────────── */
$('btn-settings').addEventListener('click', async () => {
  const cfg = await window.pulse.getSettings();
  $('set-sample').value = cfg.sampleIntervalMs;
  $('set-log').value = cfg.logIntervalMs;
  $('set-size').value = Math.round(cfg.maxFileBytes / 1048576);
  $('set-days').value = cfg.retentionDays;
  $('set-dir').textContent = await window.pulse.logDir();
  $('modal').classList.remove('hidden');
});
$('set-cancel').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) $('modal').classList.add('hidden');
});
$('set-save').addEventListener('click', async () => {
  const next = await window.pulse.setSettings({
    sampleIntervalMs: Number($('set-sample').value),
    logIntervalMs: Number($('set-log').value),
    maxFileBytes: Number($('set-size').value) * 1048576,
    retentionDays: Number($('set-days').value),
  });
  sampleIntervalMs = next.sampleIntervalMs;
  $('status-log').textContent =
    `LOGGING EVERY ${next.logIntervalMs / 1000}s · ROTATE ${Math.round(next.maxFileBytes / 1048576)}MB · KEEP ${next.retentionDays}d`;
  $('modal').classList.add('hidden');
});

/* ── window controls ──────────────────────────────────────────────────── */
$('win-min').addEventListener('click', () => window.pulse.win.minimize());
$('win-max').addEventListener('click', () => window.pulse.win.maximize());
$('win-close').addEventListener('click', () => window.pulse.win.close());
