'use strict';
/**
 * Electron main process.
 *
 * Owns the body scale service and bridges it to the renderer over IPC. The
 * renderer never touches Bluetooth, never spawns anything and never sees a
 * file path; it asks for a measurement and receives JSON.
 *
 * Run it:
 *   npm install
 *   npm start              # real scale
 *   npm run start:replay   # no hardware, replays a recorded session
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { BodyScaleClient } = require('./bodyscale-client');

// In development the scale lives one directory up. In a packaged app it is in
// resources/bodyscale, placed there by extraResources and kept out of asar.
const SCALE_DIR = BodyScaleClient.resolveScaleDir(app, path.join(__dirname, '..'));

let win = null;
let client = null;
let respawns = 0;
const MAX_RESPAWNS = 5;

// ---------------------------------------------------------------- the service

function createClient() {
  const c = new BodyScaleClient({
    scaleDir: SCALE_DIR,

    // process.execPath inside Electron IS Electron, and the client sets
    // ELECTRON_RUN_AS_NODE, so the user needs no separate Node install.
    nodePath: process.execPath,

    // Point at a bundled interpreter when you ship one. Leave it unset to let
    // the service find .venv or the system Python.
    pythonPath: process.env.BODYSCALE_PYTHON || null,

    // Set by `npm run start:replay`. Develop the whole UI with no scale.
    replay: process.env.BODYSCALE_REPLAY || null,
  });

  // Forward everything the renderer needs. Guard each send: the window may
  // already be gone while a measurement is still finishing.
  const toRenderer = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  c.on('progress', (p) => toRenderer('scale:progress', p));
  c.on('log', (line) => toRenderer('scale:log', line));
  // Errors that belong to a request are delivered by rejecting that request's
  // IPC reply. Pushing them here as well made the renderer show every failure
  // twice. Only unattributed errors are pushed.
  c.on('error-event', (err, ev) => {
    if (ev && ev.id != null) return;                 // the caller is already being told
    toRenderer('scale:error', { code: err.code, message: err.message });
  });
  c.on('close', (code, intentional) => {
    toRenderer('scale:closed', { code, intentional });
    if (intentional || app.isQuiting) { respawns = 0; return; }

    // The service died on its own. Bring it back, but back off and give up
    // rather than respawning once a second forever: a bad Python path or a
    // missing file fails instantly every time, and an uncapped loop would
    // flood the renderer with close events and never recover.
    if (respawns >= MAX_RESPAWNS) {
      toRenderer('scale:error', { code: 'TRANSPORT_FAILED',
        message: `the scale service kept exiting (${MAX_RESPAWNS} attempts). Check the setup step.` });
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, respawns), 15000);
    respawns++;
    setTimeout(() => {
      if (app.isQuiting) return;
      client = createClient();
      client.start().catch(() => { /* the close handler will decide what next */ });
    }, delay);
  });

  return c;
}

// -------------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Body Scale',
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,       // the renderer gets no Node access
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// ----------------------------------------------------------------------- IPC

ipcMain.handle('scale:start', async () => {
  if (!client) client = createClient();
  try {
    const hello = await client.start();
    return { ok: true, hello };
  } catch (err) {
    return { ok: false, code: err.code || 'INTERNAL', message: err.message };
  }
});

/**
 * The renderer sends age, height and sex. Nothing else. Everything in the
 * reply, including weight and all twenty-four derived metrics, comes from the
 * service.
 */
ipcMain.handle('scale:measure', async (_event, profile) => {
  if (!client || !client.running) {
    return { ok: false, code: 'TRANSPORT_FAILED', message: 'the scale service is not running' };
  }
  try {
    const result = await client.measure(profile);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, code: err.code || 'INTERNAL', message: err.message, detail: err.detail };
  }
});

ipcMain.handle('scale:cancel', async () => {
  if (!client || !client.running) return { ok: false, code: 'TRANSPORT_FAILED' };
  try { await client.cancel(); return { ok: true }; }
  catch (err) { return { ok: false, code: err.code, message: err.message }; }
});

ipcMain.handle('scale:status', async () => {
  if (!client || !client.running) return { ok: false, code: 'TRANSPORT_FAILED' };
  try { return { ok: true, status: await client.status() }; }
  catch (err) { return { ok: false, code: err.code, message: err.message }; }
});

ipcMain.handle('scale:forget', async () => {
  if (!client || !client.running) return { ok: false, code: 'TRANSPORT_FAILED' };
  try { await client.forget(); return { ok: true }; }
  catch (err) { return { ok: false, code: err.code, message: err.message }; }
});

/**
 * PERMISSION_DENIED needs a settings change, not a retry. Take the user there.
 */
ipcMain.handle('scale:openBluetoothSettings', async () => {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:privacy-bluetooth');
  } else if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth');
  }
  return { ok: true };
});

// ------------------------------------------------------------------ lifecycle

app.whenReady().then(() => {
  createWindow();
  client = createClient();
  client.start().catch((err) => {
    // Not fatal: the renderer shows the error and can retry.
    console.error('scale service failed to start:', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * The child MUST die with the app. On Windows an orphaned Python holds the
 * Bluetooth radio, and the next launch cannot find the scale at all.
 *
 * `before-quit` fires early enough to close the pipe cleanly. The extra
 * `will-quit` and `exit` handlers cover a force-quit path.
 */
app.on('before-quit', async (event) => {
  if (!client || !client.running || app.isQuiting) return;
  event.preventDefault();
  app.isQuiting = true;
  try { await client.stop({ timeoutMs: 2000 }); } catch (e) { /* going away anyway */ }
  app.quit();
});

/*
 * Last-ditch cleanup on a force quit.
 *
 * Closing stdin first is what actually matters: the service exits on EOF and
 * kills its own Python helper on the way out. Calling kill() alone on Windows
 * terminates the service without running any of that, and the helper survives
 * holding the Bluetooth radio, which makes the NEXT launch fail to find the
 * scale at all.
 */
const hardStop = () => {
  const child = client && client.child;
  if (!child) return;
  try { child.stdin.end(); } catch (e) { /* already closed */ }
  try { child.kill(); } catch (e) { /* already gone */ }
};
app.on('will-quit', hardStop);
process.on('exit', hardStop);
process.on('SIGINT', () => { hardStop(); process.exit(0); });
process.on('SIGTERM', () => { hardStop(); process.exit(0); });
