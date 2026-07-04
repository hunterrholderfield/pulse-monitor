'use strict';
/** Tiny JSON settings store in <userData>/settings.json. */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  sampleIntervalMs: 1000,   // dashboard refresh
  logIntervalMs: 5000,      // JSONL snapshot cadence
  maxFileBytes: 10 * 1024 * 1024,
  retentionDays: 14,
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
    } catch { /* first run */ }
  }

  get() { return { ...this.data }; }

  update(patch) {
    const clean = {};
    if (isNum(patch.sampleIntervalMs)) clean.sampleIntervalMs = clamp(patch.sampleIntervalMs, 500, 60000);
    if (isNum(patch.logIntervalMs)) clean.logIntervalMs = clamp(patch.logIntervalMs, 1000, 3600000);
    if (isNum(patch.maxFileBytes)) clean.maxFileBytes = clamp(patch.maxFileBytes, 1048576, 1073741824);
    if (isNum(patch.retentionDays)) clean.retentionDays = clamp(patch.retentionDays, 1, 365);
    this.data = { ...this.data, ...clean };
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* non-fatal: settings just won't persist */ }
    return this.get();
  }
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(v))); }

module.exports = { Settings, DEFAULTS };
