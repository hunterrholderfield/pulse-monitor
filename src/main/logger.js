'use strict';
/**
 * Rotating JSON-lines metrics logger.
 *
 * Files live in <userData>/logs as pulse-YYYY-MM-DD.jsonl. Rotation is
 * two-dimensional:
 *   - size: when the active file exceeds maxFileBytes it rolls to
 *     pulse-YYYY-MM-DD.N.jsonl and a fresh file starts
 *   - retention: files older than retentionDays are deleted on every roll
 *     and once at startup
 * Snapshots are appended every logIntervalMs (independent of the UI sample
 * rate), so a 1s dashboard can log at 5s without duplicating samplers.
 */
const fs = require('fs');
const path = require('path');

class MetricsLogger {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.logIntervalMs = opts.logIntervalMs || 5000;
    this.maxFileBytes = opts.maxFileBytes || 10 * 1024 * 1024;
    this.retentionDays = opts.retentionDays || 14;
    this.lastWrite = 0;
    this.stream = null;
    this.streamPath = null;
    this.bytes = 0;
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
  }

  configure({ logIntervalMs, maxFileBytes, retentionDays }) {
    if (logIntervalMs) this.logIntervalMs = Math.max(1000, logIntervalMs);
    if (maxFileBytes) this.maxFileBytes = Math.max(1024 * 1024, maxFileBytes);
    if (retentionDays) this.retentionDays = Math.max(1, retentionDays);
  }

  maybeLog(snapshot) {
    const now = snapshot.t;
    if (now - this.lastWrite < this.logIntervalMs) return false;
    this.lastWrite = now;
    this._write(snapshot);
    return true;
  }

  _write(snapshot) {
    const day = dayStamp(snapshot.t);
    const base = path.join(this.dir, `pulse-${day}.jsonl`);
    if (this.streamPath !== base || this.bytes >= this.maxFileBytes) {
      this._openStream(base, day);
    }
    const line = JSON.stringify(snapshot) + '\n';
    this.bytes += Buffer.byteLength(line);
    this.stream.write(line);
  }

  _openStream(base, day) {
    if (this.stream) this.stream.end();
    let target = base;
    // Size roll: shift to the next free .N suffix for today.
    if (fs.existsSync(base) && fs.statSync(base).size >= this.maxFileBytes) {
      let n = 1;
      while (fs.existsSync(path.join(this.dir, `pulse-${day}.${n}.jsonl`))) {
        const p = path.join(this.dir, `pulse-${day}.${n}.jsonl`);
        if (fs.statSync(p).size < this.maxFileBytes) break;
        n++;
      }
      target = path.join(this.dir, `pulse-${day}.${n}.jsonl`);
    }
    this.stream = fs.createWriteStream(target, { flags: 'a' });
    this.streamPath = base;
    this.bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    let files;
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const f of files) {
      const m = /^pulse-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/.exec(f);
      if (!m) continue;
      if (new Date(m[1] + 'T00:00:00').getTime() < cutoff - 86400000) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* locked; retry next roll */ }
      }
    }
  }

  close() {
    if (this.stream) this.stream.end();
    this.stream = null;
  }
}

function dayStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { MetricsLogger, dayStamp };
