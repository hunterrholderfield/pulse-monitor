'use strict';
/**
 * Polls systeminformation + the PowerShell counter bridge and emits one
 * merged snapshot per tick. Snapshots use short keys because they are also
 * the on-disk JSONL log format.
 *
 * Snapshot shape:
 * {
 *   t: epoch-ms,
 *   cpu: { avg, cores[], ghz, temp|null, tempSrc:'cpu'|'aio'|null, tempDev? },
 *   mem: { total, used, avail, pfTotal, pfUsed },
 *   gpu: { util, vramUsed, vramTotal|null, temp|null },
 *   dsk: { drives:[{ fs, size, used, pct }], read, write },
 *   net: { iface, rx, tx }
 * }
 */
const si = require('systeminformation');
const { EventEmitter } = require('events');
const { PsCounters } = require('./pscounters');
const { AioTemp } = require('./aiotemp');

class Sampler extends EventEmitter {
  constructor(intervalMs = 1000) {
    super();
    this.intervalMs = Math.max(500, intervalMs);
    this.timer = null;
    this.ps = new PsCounters(this.intervalMs);
    this.staticInfo = null;
    this.gfx = { util: null, vramUsed: null, vramTotal: null, temp: null };
    this.gfxTimer = null;
    this.defaultIface = null;
    this.cpuTempSupported = true;
    this.aio = null; // AIO coolant-temp fallback, spawned only if the CPU sensor is dead
    this.latest = null;
  }

  async start() {
    this.ps.start();
    this._staticPromise = this._loadStatic();
    await this._staticPromise;
    this._pollGraphics();
    // graphics() shells out to nvidia-smi/WMI — too slow for the main tick
    this.gfxTimer = setInterval(() => this._pollGraphics(), 5000);
    this._tick();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
  }

  async getStatic() {
    if (this._staticPromise) await this._staticPromise;
    return this.staticInfo;
  }

  setInterval_(ms) {
    this.intervalMs = Math.max(500, ms);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this._tick(), this.intervalMs);
    }
  }

  async _loadStatic() {
    try {
      const [cpu, mem, os, gfx, net] = await Promise.all([
        si.cpu(), si.mem(), si.osInfo(), si.graphics(), si.networkInterfaceDefault(),
      ]);
      this.defaultIface = net || null;
      const controller = pickController(gfx.controllers);
      this.staticInfo = {
        cpu: {
          brand: `${cpu.manufacturer} ${cpu.brand}`.trim(),
          physicalCores: cpu.physicalCores,
          cores: cpu.cores,
          baseGhz: cpu.speed,
        },
        memTotal: mem.total,
        gpu: controller ? {
          model: controller.model,
          vramTotal: controller.vram ? controller.vram * 1024 * 1024 : null,
        } : { model: 'Unknown adapter', vramTotal: null },
        os: `${os.distro} ${os.release} (${os.arch})`,
        host: os.hostname,
        iface: this.defaultIface,
      };
    } catch (err) {
      this.staticInfo = { error: String(err) };
    }
  }

  async _pollGraphics() {
    try {
      const gfx = await si.graphics();
      const c = pickController(gfx.controllers);
      if (c) {
        this.gfx = {
          util: numOrNull(c.utilizationGpu),
          vramUsed: c.memoryUsed != null ? c.memoryUsed * 1024 * 1024 : null,
          vramTotal: c.memoryTotal != null ? c.memoryTotal * 1024 * 1024
            : (c.vram ? c.vram * 1024 * 1024 : null),
          temp: numOrNull(c.temperatureGpu),
        };
      }
    } catch { /* keep last reading */ }
  }

  async _tick() {
    try {
      const wantTemp = this.cpuTempSupported;
      const [load, speed, temp, mem, fs, netStats] = await Promise.all([
        si.currentLoad(),
        si.cpuCurrentSpeed(),
        wantTemp ? si.cpuTemperature().catch(() => null) : Promise.resolve(null),
        si.mem(),
        si.fsSize(),
        si.networkStats(this.defaultIface || '*'),
      ]);

      if (wantTemp && (!temp || temp.main == null)) this.cpuTempSupported = false;

      // CPU die sensor unavailable → fall back to the AIO coolant temperature.
      let cpuTemp = temp && temp.main != null ? round1(temp.main) : null;
      let tempSrc = cpuTemp != null ? 'cpu' : null;
      let tempDev = null;
      if (cpuTemp == null) {
        if (!this.aio) { this.aio = new AioTemp(); this.aio.start(); }
        const a = this.aio.latest;
        if (a && a.temp != null) {
          cpuTemp = round1(a.temp);
          tempSrc = 'aio';
          tempDev = a.device || null;
        }
      }

      const psData = this.ps.latest;
      let read = 0, write = 0;
      if (psData) for (const d of psData.disks) { read += d.read; write += d.write; }

      // Prefer nvidia-smi numbers when present; fall back to perf counters.
      const gpuUtil = this.gfx.util != null ? this.gfx.util
        : (psData && psData.hasGpuData ? psData.gpuUtil : null);
      const vramUsed = this.gfx.vramUsed != null ? this.gfx.vramUsed
        : (psData ? psData.vramUsed : null);

      const n = netStats && netStats[0];

      const snap = {
        t: Date.now(),
        cpu: {
          avg: round1(load.currentLoad),
          cores: load.cpus.map((c) => round1(c.load)),
          ghz: speed ? round2(speed.avg) : null,
          temp: cpuTemp,
          tempSrc,
          ...(tempDev ? { tempDev } : {}),
        },
        mem: {
          total: mem.total,
          used: mem.active,
          avail: mem.available,
          pfTotal: mem.swaptotal,
          pfUsed: mem.swapused,
        },
        gpu: {
          util: gpuUtil != null ? round1(gpuUtil) : null,
          vramUsed,
          vramTotal: this.gfx.vramTotal,
          temp: this.gfx.temp,
        },
        dsk: {
          drives: fs
            .filter((d) => d.size > 0)
            .map((d) => ({ fs: d.fs, size: d.size, used: d.used, pct: round1(d.use) })),
          read: Math.round(read),
          write: Math.round(write),
        },
        net: {
          iface: n ? n.iface : (this.defaultIface || '—'),
          rx: n && n.rx_sec != null ? Math.max(0, Math.round(n.rx_sec)) : 0,
          tx: n && n.tx_sec != null ? Math.max(0, Math.round(n.tx_sec)) : 0,
        },
      };

      this.latest = snap;
      this.emit('snapshot', snap);
    } catch (err) {
      this.emit('error', err);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.gfxTimer) clearInterval(this.gfxTimer);
    this.timer = this.gfxTimer = null;
    this.ps.stop();
    if (this.aio) { this.aio.stop(); this.aio = null; }
  }
}

function pickController(controllers) {
  if (!controllers || !controllers.length) return null;
  // Prefer the discrete card / the one reporting utilization or VRAM.
  const scored = controllers.map((c) => {
    let score = 0;
    if (c.utilizationGpu != null) score += 4;
    if (c.memoryTotal != null) score += 2;
    if (c.vram) score += 1;
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].c;
}

function numOrNull(v) { return typeof v === 'number' && !Number.isNaN(v) ? v : null; }
function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

module.exports = { Sampler };
