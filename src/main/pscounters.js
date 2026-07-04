'use strict';
/**
 * Persistent PowerShell sampler for Windows performance counters that
 * systeminformation cannot provide on Windows:
 *   - per-physical-disk read/write throughput (bytes/sec)
 *   - vendor-agnostic GPU engine utilization (works for NVIDIA/AMD/Intel)
 *   - GPU dedicated memory usage
 *
 * A single long-lived powershell.exe child loops and emits one compact JSON
 * line per interval; spawning a fresh shell per sample would cost 1-2s each.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $disk = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
    Where-Object { $_.Name -ne '_Total' } |
    Select-Object Name, DiskReadBytesPersec, DiskWriteBytesPersec)
  $gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
    Where-Object { $_.UtilizationPercentage -gt 0 } |
    Select-Object Name, UtilizationPercentage)
  $vram = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory |
    Select-Object Name, DedicatedUsage)
  $out = @{ disk = $disk; gpu = $gpu; vram = $vram } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($out)
  Start-Sleep -Milliseconds __INTERVAL__
}
`;

class PsCounters extends EventEmitter {
  constructor(intervalMs = 1000) {
    super();
    this.intervalMs = Math.max(500, intervalMs);
    this.latest = null;
    this.child = null;
    this.stopped = false;
    this.buf = '';
  }

  start() {
    this.stopped = false;
    const script = PS_SCRIPT.replace('__INTERVAL__', String(this.intervalMs));
    this.child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.latest = this._normalize(JSON.parse(line));
          this.emit('sample', this.latest);
        } catch { /* partial or malformed line — skip */ }
      }
    });

    this.child.on('exit', () => {
      this.child = null;
      if (!this.stopped) setTimeout(() => this.start(), 3000);
    });
  }

  _normalize(raw) {
    const disks = (raw.disk || []).map((d) => ({
      name: String(d.Name || ''),
      read: Number(d.DiskReadBytesPersec) || 0,
      write: Number(d.DiskWriteBytesPersec) || 0,
    }));

    // GPU engine counters are per (process/adapter LUID, engine type). Total
    // utilization for an adapter = sum over engines of one type; the busiest
    // engine type is the honest "GPU usage" figure.
    const byType = new Map();
    for (const e of raw.gpu || []) {
      const m = /engtype_([A-Za-z0-9 ]+)$/.exec(String(e.Name || ''));
      const type = m ? m[1] : 'other';
      byType.set(type, (byType.get(type) || 0) + (Number(e.UtilizationPercentage) || 0));
    }
    let gpuUtil = 0;
    for (const v of byType.values()) gpuUtil = Math.max(gpuUtil, v);
    gpuUtil = Math.min(100, Math.round(gpuUtil));

    let vramUsed = 0;
    for (const v of raw.vram || []) vramUsed = Math.max(vramUsed, Number(v.DedicatedUsage) || 0);

    return { disks, gpuUtil, vramUsed, hasGpuData: (raw.gpu || []).length > 0 || vramUsed > 0 };
  }

  stop() {
    this.stopped = true;
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    this.child = null;
  }
}

module.exports = { PsCounters };
