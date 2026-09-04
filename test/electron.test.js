// Tests for the Electron main process and preload, without installing Electron.
//
// `main.js` is the file most likely to break silently: a renamed IPC channel or
// a missing forward produces an app that launches and then does nothing. These
// tests load it against a stub `electron` module and drive its handlers, so the
// wiring is checked on every run.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'electron-example');
const FIXTURE = path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');

// ------------------------------------------------------------- the stub

const handlers = new Map();
const sentToRenderer = [];
const openedUrls = [];

const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  isQuiting: false,
  whenReady() { return Promise.resolve(); },
  quit() { this.emit('_quit'); },
  getPath() { return '/tmp'; },
});

class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = { send: (channel, payload) => sentToRenderer.push({ channel, payload }) };
  }
  loadFile(file) { this.file = file; }
  isDestroyed() { return false; }
  static getAllWindows() { return []; }
}

let bridge = null;
const electronStub = {
  app,
  BrowserWindow,
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  shell: { openExternal: async (url) => { openedUrls.push(url); } },
  contextBridge: { exposeInMainWorld: (key, api) => { bridge = { key, api }; } },
  ipcRenderer: { invoke: async () => ({}), on: () => {}, removeListener: () => {} },
};

// main.js requires 'electron' relative to its own directory, so resolution has
// to be intercepted rather than shadowed with a node_modules folder.
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return '\0electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['\0electron-stub'] = { id: '\0electron-stub', filename: '\0electron-stub',
                                     loaded: true, exports: electronStub };

// Replay, so no radio and no scale are involved.
process.env.BODYSCALE_REPLAY = FIXTURE;
require(path.join(EXAMPLE, 'main.js'));
require(path.join(EXAMPLE, 'preload.js'));

const call = (channel, ...args) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `no handler registered for ${channel}`);
  return fn({}, ...args);
};
const settled = () => new Promise((r) => setTimeout(r, 400));

// ------------------------------------------------------------- the tests

test('electron: main registers every channel the preload calls', async () => {
  await settled();
  // The preload is the contract. Any channel it invokes must exist in main.
  for (const channel of ['scale:start', 'scale:measure', 'scale:cancel',
                         'scale:status', 'scale:forget', 'scale:openBluetoothSettings']) {
    assert.ok(handlers.has(channel), `main.js handles ${channel}`);
  }
});

test('electron: the preload exposes a closed surface, and no Node', async () => {
  assert.ok(bridge, 'the preload called exposeInMainWorld');
  assert.strictEqual(bridge.key, 'scale');
  const expected = ['start', 'measure', 'cancel', 'status', 'forget',
                    'openBluetoothSettings', 'onProgress', 'onLog', 'onError', 'onClosed'];
  assert.deepStrictEqual(Object.keys(bridge.api).sort(), expected.sort(),
                         'exactly the intended methods, nothing more');
  for (const fn of Object.values(bridge.api)) assert.strictEqual(typeof fn, 'function');
});

test('electron: the window is created with the renderer sandboxed', async () => {
  // A renderer with nodeIntegration would be able to spawn processes itself,
  // which is precisely what this architecture exists to prevent.
  const win = new BrowserWindow({});
  assert.ok(win);                                  // the stub is usable
  const src = require('fs').readFileSync(path.join(EXAMPLE, 'main.js'), 'utf8');
  assert.match(src, /contextIsolation:\s*true/);
  assert.match(src, /nodeIntegration:\s*false/);
  assert.match(src, /sandbox:\s*true/);
});

test('electron: scale:start reports the service is up', async () => {
  const r = await call('scale:start');
  assert.strictEqual(r.ok, true, 'start succeeded: ' + JSON.stringify(r));
  assert.strictEqual(r.hello.proto, 1);
  assert.strictEqual(r.hello.app, 'bodyscale');
});

test('electron: scale:status answers without touching hardware', async () => {
  const r = await call('scale:status');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status.busy, false);
});

test('electron: scale:measure returns the full result to the renderer', async () => {
  const before = sentToRenderer.length;
  const r = await call('scale:measure', { age: 39, heightCm: 180, sex: 'male' });
  assert.strictEqual(r.ok, true, 'measure succeeded: ' + JSON.stringify(r));
  assert.strictEqual(r.result.measured.weightKg, 97.9);
  assert.strictEqual(r.result.measured.impedanceOhm, 529.9);
  assert.strictEqual(Object.keys(r.result.derived).length, 24);

  // Live progress must reach the renderer, not just the final result.
  const progress = sentToRenderer.slice(before).filter((m) => m.channel === 'scale:progress');
  assert.ok(progress.length >= 3, `progress was forwarded (${progress.length} events)`);
  assert.ok(progress.some((m) => typeof m.payload.weightKg === 'number' && m.payload.weightKg > 0),
            'live weight reached the renderer');
});

test('electron: a bad profile comes back as a typed failure, not a throw', async () => {
  const r = await call('scale:measure', { age: 2, heightCm: 180 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INVALID_PROFILE');
  assert.ok(r.message, 'and carries a message the UI can show');
});

test('electron: every IPC reply is structured-cloneable', async () => {
  // ipcMain serialises the return value. A class instance or a function here
  // throws at runtime inside Electron but not under plain Node, so check it.
  const r = await call('scale:measure', { age: 39, heightCm: 180, sex: 'male' });
  assert.doesNotThrow(() => structuredClone(r));
  const bad = await call('scale:measure', { age: 2, heightCm: 180 });
  assert.doesNotThrow(() => structuredClone(bad), 'error replies clone too');
});

test('electron: scale:openBluetoothSettings opens the right page for this platform', async () => {
  const before = openedUrls.length;
  await call('scale:openBluetoothSettings');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.strictEqual(openedUrls.length, before + 1, 'a settings URL was opened');
    const url = openedUrls[openedUrls.length - 1];
    assert.match(url, process.platform === 'win32' ? /^ms-settings:/ : /^x-apple\.systempreferences:/);
  }
});

test('electron: quitting stops the service instead of orphaning it', async () => {
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true,
    'the quit is deferred so the child can be closed first; without this, Python is orphaned and holds the radio');
  await new Promise((r) => setTimeout(r, 1200));
  const after = await call('scale:status');
  assert.strictEqual(after.ok, false, 'the service is gone after the quit path ran');
  assert.strictEqual(after.code, 'TRANSPORT_FAILED');
});
