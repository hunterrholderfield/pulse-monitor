'use strict';
/**
 * Fallback temperature source for machines whose CPU die/package sensor is
 * not readable (systeminformation's cpuTemperature() returns null on many
 * consumer boards). All-in-one liquid coolers (Corsair Hydro/iCUE, NZXT
 * Kraken, Aquacomputer, MSI CoreLiquid, ASUS Ryujin, ...) report a coolant
 * temperature instead, which Windows exposes through the
 * LibreHardwareMonitor / OpenHardwareMonitor WMI namespaces when one of
 * those monitoring apps is running.
 *
 * Same persistent-PowerShell pattern as pscounters.js: one long-lived
 * powershell.exe child loops and emits a JSON line per interval. Coolant
 * temperature moves slowly, so this polls on a fixed 5s cadence.
 *
 * latest: { temp: number, device: string } | null
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const POLL_MS = 5000;

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $sensors = @(); $hw = @()
  foreach ($ns in 'root\\LibreHardwareMonitor','root\\OpenHardwareMonitor') {
    $s = Get-CimInstance -Namespace $ns -ClassName Sensor -Filter "SensorType='Temperature'" |
      Select-Object Name, Value, Identifier, Parent
    if ($s) { $sensors += @($s) }
    $h = Get-CimInstance -Namespace $ns -ClassName Hardware |
      Select-Object Identifier, Name, HardwareType
    if ($h) { $hw += @($h) }
  }
  $out = @{ sensors = @($sensors); hw = @($hw) } | ConvertTo-Json -Compress -Depth 3
  [Console]::Out.WriteLine($out)
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

// Sensor names AIOs use for the loop/coolant reading.
const COOLANT_SENSOR = /coolant|liquid|water/i;
// Hardware (parent device) names of common AIO / liquid-cooling controllers.
const AIO_DEVICE = /kraken|nzxt|corsair|icue|hydro\s?h\d|commander|aquacomputer|aqua\s?computer|alphacool|eisbaer|liqtech|enermax|coreliquid|ryujin|ryuo|galahad|lian\s?li|castle|deepcool|arctic\s+liquid/i;

class AioTemp extends EventEmitter {
  constructor() {
    super();
    this.latest = null;
    this.child = null;
    this.stopped = false;
    this.buf = '';
  }

  start() {
    if (this.child) return;
    this.stopped = false;
    this.child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT,
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
      if (!this.stopped) setTimeout(() => this.start(), 10000);
    });
  }

  _normalize(raw) {
    const hwByIdent = new Map();
    for (const h of raw.hw || []) {
      hwByIdent.set(String(h.Identifier || ''), {
        name: String(h.Name || ''),
        type: String(h.HardwareType || ''),
      });
    }

    let best = null;
    for (const s of raw.sensors || []) {
      const value = Number(s.Value);
      // plausible coolant range — reject garbage/uninitialized readings
      if (!Number.isFinite(value) || value < 5 || value > 90) continue;
      const name = String(s.Name || '');
      const ident = String(s.Identifier || '');
      const parent = hwByIdent.get(String(s.Parent || '')) || { name: '', type: '' };

      const coolantNamed = COOLANT_SENSOR.test(name) || COOLANT_SENSOR.test(ident);
      const aioDevice = AIO_DEVICE.test(parent.name);
      if (!coolantNamed && !aioDevice) continue;

      // prefer an explicit coolant/liquid sensor on a recognized AIO, then
      // any coolant-named sensor, then any temp sensor on a known AIO
      const score = (coolantNamed ? 2 : 0) + (aioDevice ? 1 : 0);
      if (!best || score > best.score) {
        best = { score, temp: value, device: parent.name || name };
      }
    }

    return best ? { temp: best.temp, device: best.device } : null;
  }

  stop() {
    this.stopped = true;
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    this.child = null;
  }
}

module.exports = { AioTemp };
