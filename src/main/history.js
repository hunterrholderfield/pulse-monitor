'use strict';
/**
 * Reads the JSONL metric logs back for the history view.
 * Days can span multiple size-rolled files (pulse-DAY.jsonl, pulse-DAY.1.jsonl…);
 * loadDay merges and downsamples them so the renderer never gets more than
 * maxPoints snapshots regardless of how long the app has been logging.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function listDays(dir) {
  let files;
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const days = new Map();
  for (const f of files) {
    const m = /^pulse-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/.exec(f);
    if (!m) continue;
    const stat = await fs.promises.stat(path.join(dir, f));
    const cur = days.get(m[1]) || { day: m[1], bytes: 0, files: 0 };
    cur.bytes += stat.size;
    cur.files += 1;
    days.set(m[1], cur);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function loadDay(dir, day, maxPoints = 1500) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  let files;
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const parts = files
    .filter((f) => f === `pulse-${day}.jsonl` || f.startsWith(`pulse-${day}.`))
    .filter((f) => /^pulse-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(f))
    .sort((a, b) => suffixNum(a) - suffixNum(b));

  const rows = [];
  for (const f of parts) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, f), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* torn write at rotation */ }
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return downsample(rows, maxPoints);
}

function suffixNum(f) {
  const m = /\.(\d+)\.jsonl$/.exec(f);
  return m ? Number(m[1]) : 0;
}

// Stride-sample but always keep first and last so the scrub range is exact.
function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const stride = rows.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(rows[Math.floor(i * stride)]);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

module.exports = { listDays, loadDay };
