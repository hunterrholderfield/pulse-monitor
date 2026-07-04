'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Sampler } = require('./sampler');
const { MetricsLogger } = require('./logger');
const { Settings } = require('./settings');
const history = require('./history');

const SMOKE = process.argv.includes('--smoke');

let win = null;
let sampler = null;
let logger = null;
let settings = null;
let logDir = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    backgroundColor: '#060a12',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  settings = new Settings(app.getPath('userData'));
  logDir = path.join(app.getPath('userData'), 'logs');

  const cfg = settings.get();
  logger = new MetricsLogger(logDir, cfg);
  sampler = new Sampler(cfg.sampleIntervalMs);

  sampler.on('snapshot', (snap) => {
    logger.maybeLog(snap);
    if (win && !win.isDestroyed()) win.webContents.send('pulse:snapshot', snap);
  });
  sampler.start();

  registerIpc();
  createWindow();

  if (SMOKE) runSmokeTest();
});

function registerIpc() {
  ipcMain.handle('pulse:getStatic', () => sampler.getStatic());
  ipcMain.handle('pulse:getLatest', () => sampler.latest);
  ipcMain.handle('pulse:getSettings', () => settings.get());
  ipcMain.handle('pulse:setSettings', (_e, patch) => {
    const next = settings.update(patch || {});
    sampler.setInterval_(next.sampleIntervalMs);
    logger.configure(next);
    return next;
  });
  ipcMain.handle('pulse:listDays', () => history.listDays(logDir));
  ipcMain.handle('pulse:loadDay', (_e, day, maxPoints) => history.loadDay(logDir, day, maxPoints));
  ipcMain.handle('pulse:logDir', () => logDir);

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('win:close', () => win && win.close());
}

/**
 * --smoke: headless-ish verification. Waits for real snapshots to flow,
 * screenshots the rendered dashboard, prints a JSON report, exits 0/1.
 */
async function runSmokeTest() {
  const outDir = process.env.PULSE_SMOKE_DIR || app.getPath('temp');
  const t0 = Date.now();
  let snaps = 0;
  const consoleLines = [];
  sampler.on('snapshot', () => snaps++);
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    consoleLines.push(`[${level}] ${source}:${line} ${message}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    consoleLines.push(`[preload-error] ${p}: ${err}`);
  });

  const finish = async (ok, extra) => {
    let shot = null;
    try {
      if (win && !win.isDestroyed()) {
        const img = await win.webContents.capturePage();
        shot = path.join(outDir, 'pulse-smoke.png');
        fs.writeFileSync(shot, img.toPNG());
      }
    } catch { /* screenshot is best-effort */ }
    const report = {
      ok,
      snapshots: snaps,
      elapsedMs: Date.now() - t0,
      latest: sampler.latest,
      logDir,
      logFiles: fs.existsSync(logDir) ? fs.readdirSync(logDir) : [],
      screenshot: shot,
      console: consoleLines.slice(0, 20),
      ...extra,
    };
    console.log('SMOKE_REPORT ' + JSON.stringify(report));
    app.exit(ok ? 0 : 1);
  };

  setTimeout(async () => {
    const latest = sampler.latest;
    const ok = !!(latest && snaps >= 3 && latest.cpu && latest.mem && latest.dsk && latest.net);
    let rendererOk = false;
    try {
      rendererOk = await win.webContents.executeJavaScript(
        'window.__pulseRendered === true'
      );
    } catch { /* renderer probe failed */ }
    // also exercise the history view before the final (live) screenshot
    let historyShot = null;
    try {
      await win.webContents.executeJavaScript(
        `document.getElementById('tab-history').click(); true`);
      await new Promise((r) => setTimeout(r, 1500));
      const img = await win.webContents.capturePage();
      historyShot = path.join(outDir, 'pulse-smoke-history.png');
      fs.writeFileSync(historyShot, img.toPNG());
      await win.webContents.executeJavaScript(
        `document.getElementById('tab-live').click(); true`);
      await new Promise((r) => setTimeout(r, 400));
    } catch { /* history capture is best-effort */ }
    finish(ok && rendererOk, { rendererOk, historyShot });
  }, 9000);
}

app.on('window-all-closed', () => {
  if (sampler) sampler.stop();
  if (logger) logger.close();
  app.quit();
});
