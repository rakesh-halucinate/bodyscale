'use strict';
/**
 * INT-ELEC — the Electron main process and the preload bridge.
 *
 * Electron is not installed, and installing it would not make this suite any
 * more honest. `main.js` and `preload.js` are ordinary CommonJS modules whose
 * only Electron dependency is the `electron` module itself, so they are loaded
 * here against a stub that records everything they do: which IPC channels they
 * register, what the BrowserWindow is constructed with, what is pushed at the
 * renderer, and which URLs the shell is asked to open.
 *
 * Below that stub everything is real. `main.js` spawns the real
 * `scale.js --serve` over a real pipe through the real BodyScaleClient, driven
 * by the recorded SSW533 session, so a broken IPC reply or a dropped progress
 * event fails here exactly as it would in the packaged app.
 *
 * `main.js` is a singleton: requiring it twice would not re-run it. So it is
 * required once, at file scope, and the tests are ordered. The ones that need
 * the service down run before `whenReady` is resolved; the ones that mutate the
 * remembered device or stop the service run last.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const H = require('./harness');
const { BodyScaleClient } = require(H.CLIENT);

const EXAMPLE = path.dirname(H.CLIENT);
const MAIN_JS = path.join(EXAMPLE, 'main.js');
const PRELOAD_JS = path.join(EXAMPLE, 'preload.js');
const MAIN_SRC = fs.readFileSync(MAIN_JS, 'utf8');

/** The service keys the remembered address by platform; a Mac UUID means nothing on Windows. */
const ADDRESS_KEY = `address_${process.platform}`;

/** The exact surface the renderer is allowed to see. */
const SURFACE = ['start', 'measure', 'cancel', 'status', 'forget', 'openBluetoothSettings',
                 'onProgress', 'onLog', 'onError', 'onClosed'];

/** The six channels main must answer, and the four it pushes on. */
const INVOKE_CHANNELS = ['scale:start', 'scale:measure', 'scale:cancel',
                         'scale:status', 'scale:forget', 'scale:openBluetoothSettings'];
const PUSH_CHANNELS = ['scale:progress', 'scale:log', 'scale:error', 'scale:closed'];

// ------------------------------------------------------------------ the stub

const handlers = new Map();          // channel -> handler registered by ipcMain.handle
const pushed = [];                   // { channel, payload } sent at the renderer
const openedUrls = [];               // everything handed to shell.openExternal
const windows = [];                  // every BrowserWindow ever constructed
const invokes = [];                  // { channel, args } the preload asked ipcRenderer for
const rendererListeners = [];        // { channel, fn } the preload subscribed with
let exposed = [];                    // every contextBridge.exposeInMainWorld call
let quits = 0;

let releaseReady = null;
const readyGate = new Promise((resolve) => { releaseReady = resolve; });

const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  isQuiting: false,                                  // main.js sets this on before-quit
  whenReady() { return readyGate; },                 // held shut until boot()
  quit() { quits++; },
  getPath() { return CONFIG_DIR; },
});

class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.destroyed = false;
    this.file = null;
    this.webContents = { send: (channel, payload) => pushed.push({ channel, payload }) };
    windows.push(this);
  }
  loadFile(file) { this.file = file; }
  isDestroyed() { return this.destroyed; }
  static getAllWindows() { return windows.filter((w) => !w.destroyed); }
}

const electronStub = {
  app,
  BrowserWindow,
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  shell: { openExternal: async (url) => { openedUrls.push(url); } },
  contextBridge: { exposeInMainWorld: (key, api) => exposed.push({ key, api }) },
  ipcRenderer: {
    invoke: async (channel, ...args) => { invokes.push({ channel, args }); return { stubbed: true }; },
    on: (channel, fn) => { rendererListeners.push({ channel, fn }); },
    removeListener: (channel, fn) => {
      const i = rendererListeners.findIndex((l) => l.channel === channel && l.fn === fn);
      if (i >= 0) rendererListeners.splice(i, 1);
    },
  },
};

// --------------------------------------------------------------- the loading

/*
 * A scratch config directory, seeded with a config from an "older version":
 * it remembers a device AND a profile. The service must adopt the device and
 * drop the profile the first time it writes. Seeding rather than starting empty
 * also makes `hello.device` deterministic — an empty directory would still fall
 * back to any .scale-config.json sitting beside the script.
 */
const CONFIG_DIR = H.tmpdir('elec-cfg');
const CONFIG_FILE = path.join(CONFIG_DIR, 'scale-config.json');
const SEEDED = { name: 'OLD-NAME', profile: { sex: 'female', age: 61, heightCm: 155 } };
SEEDED[ADDRESS_KEY] = 'OLD-ADDRESS';
fs.writeFileSync(CONFIG_FILE, JSON.stringify(SEEDED, null, 2) + '\n');

process.env.BODYSCALE_REPLAY = H.FIXTURE;            // no radio, no scale
process.env.BODYSCALE_CONFIG_DIR = CONFIG_DIR;       // no touching the developer's own config
delete process.env.BODYSCALE_PYTHON;                 // replay never spawns Python

// main.js resolves 'electron' relative to its own directory, so a node_modules
// shim two levels up would never be found. Intercept resolution instead, and
// put it back once both modules are loaded.
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return '\0electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['\0electron-stub'] = {
  id: '\0electron-stub', filename: '\0electron-stub', loaded: true, exports: electronStub,
};
try {
  require(MAIN_JS);
  require(PRELOAD_JS);
} finally {
  Module._resolveFilename = realResolve;
}

const bridge = exposed[0];

// ---------------------------------------------------------------- the helpers

/** Invoke an IPC handler the way ipcMain would: (event, ...args). */
function call(channel, ...args) {
  const fn = handlers.get(channel);
  assert.ok(fn, `no handler is registered for ${channel}`);
  return fn({ sender: 'test' }, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The window main.js is currently pushing at. */
const currentWindow = () => windows[windows.length - 1];

/** Everything pushed at the renderer since a recorded mark. */
const pushesSince = (mark, channel) =>
  pushed.slice(mark).filter((p) => !channel || p.channel === channel);

/** Poll until a condition holds, so no test sleeps longer than it must. */
async function waitFor(pred, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** Run `fn` with process.platform pretending to be something else. */
async function asPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, 'platform', real); }
}

/**
 * Let `app.whenReady()` resolve, which is what makes main.js build its window
 * and start the service. Idempotent: every test after the pre-boot ones awaits
 * it, and only the first call does the work.
 */
let booting = null;
function boot() {
  if (!booting) {
    booting = (async () => {
      releaseReady();
      await sleep(30);                    // whenReady().then() assigns `client`
      const started = await call('scale:start');
      assert.strictEqual(started.ok, true, 'the service started: ' + JSON.stringify(started));
      return started;
    })();
  }
  return booting;
}

const readConfigFile = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

// ============================================================== before boot ==

// The preload is the contract, and it is the half that cannot be typo-checked:
// `ipcRenderer.invoke('scale:staus')` is valid JavaScript that returns a promise
// which never settles. The renderer would spin for ever on a button press with
// nothing in the log. So the channels are taken from the preload itself, by
// calling every method it exposes, and matched against what main registered.
test('INT-ELEC-01  main answers exactly the channels the preload invokes, and no others', async () => {
  const mark = invokes.length;
  const profile = { age: 39, heightCm: 180, sex: 'male' };
  await bridge.api.start();
  await bridge.api.measure(profile);
  await bridge.api.cancel();
  await bridge.api.status();
  await bridge.api.forget();
  await bridge.api.openBluetoothSettings();

  const asked = invokes.slice(mark).map((i) => i.channel);
  assert.deepStrictEqual(asked, INVOKE_CHANNELS,
    'the preload invokes exactly these six channels, in this order');
  assert.deepStrictEqual([...handlers.keys()].sort(), INVOKE_CHANNELS.slice().sort(),
    'main registers exactly those channels: none missing, none extra');

  const measured = invokes.slice(mark).find((i) => i.channel === 'scale:measure');
  assert.strictEqual(measured.args.length, 1, 'measure carries one argument');
  assert.deepStrictEqual(measured.args[0], profile,
    'the profile crosses the bridge unchanged; nothing is added to it');
  for (const i of invokes.slice(mark)) {
    if (i.channel !== 'scale:measure') {
      assert.deepStrictEqual(i.args, [], `${i.channel} sends nothing about the person`);
    }
  }
});

// contextBridge is the entire security boundary. Anything extra on `window.scale`
// — a stray debug helper, an exposed ipcRenderer, a path — is reachable by any
// script the renderer loads, and undoes the reason this app spawns Bluetooth in
// the main process at all.
test('INT-ELEC-02  the preload exposes one closed surface on window.scale, all functions', async () => {
  assert.strictEqual(exposed.length, 1, 'exposeInMainWorld was called exactly once');
  assert.strictEqual(bridge.key, 'scale', 'the surface is window.scale');
  assert.deepStrictEqual(Object.keys(bridge.api).sort(), SURFACE.slice().sort(),
    'exactly the intended methods, nothing more');
  for (const [name, value] of Object.entries(bridge.api)) {
    assert.strictEqual(typeof value, 'function', `window.scale.${name} is a function`);
  }
  for (const escape of ['require', 'process', 'ipcRenderer', 'send', 'invoke', '__proto__']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(bridge.api, escape), false,
      `window.scale does not carry ${escape}`);
  }
});

// A push handler that received Electron's event object would hand the renderer
// `event.sender`, which is the whole main process by another name. And a
// subscription with no way off leaks a listener per mount: a renderer that
// re-subscribes on every screen change ends up showing one progress update
// several times over and warning about a listener leak.
test('INT-ELEC-03  push subscriptions deliver the payload only, and can be undone', async () => {
  const before = rendererListeners.length;
  const seen = [];
  const off = bridge.api.onProgress((payload) => seen.push(payload));
  assert.strictEqual(rendererListeners.length, before + 1, 'one listener was registered');

  const registered = rendererListeners[rendererListeners.length - 1];
  assert.strictEqual(registered.channel, 'scale:progress');
  registered.fn({ sender: 'the whole main process' }, { phase: 'settling', weightKg: 97.9 });
  assert.deepStrictEqual(seen, [{ phase: 'settling', weightKg: 97.9 }],
    'the handler sees the payload and never the event');

  assert.strictEqual(typeof off, 'function', 'subscribing returns an unsubscribe');
  off();
  assert.strictEqual(rendererListeners.length, before, 'unsubscribing removes that listener');

  const offs = ['onProgress', 'onLog', 'onError', 'onClosed'].map((k) => bridge.api[k](() => {}));
  assert.deepStrictEqual(rendererListeners.slice(before).map((l) => l.channel), PUSH_CHANNELS,
    'the four push channels the preload listens on');
  offs.forEach((f) => f());
  assert.strictEqual(rendererListeners.length, before, 'all four unsubscribed cleanly');
});

// Every command is reachable from the UI before the service has announced
// itself — the window is on screen first. If a handler threw here instead of
// returning, ipcMain would reject the renderer's promise with a generic
// "Error invoking remote method", and the app would show that string to a user
// whose actual problem is a missing Python.
test('INT-ELEC-04  with the service not yet up, every command returns a typed failure', async () => {
  const measure = await call('scale:measure', H.PROFILE);
  assert.deepStrictEqual(measure,
    { ok: false, code: 'TRANSPORT_FAILED', message: 'the scale service is not running' },
    'measure explains itself');

  for (const channel of ['scale:status', 'scale:cancel', 'scale:forget']) {
    const r = await call(channel);
    assert.deepStrictEqual(r, { ok: false, code: 'TRANSPORT_FAILED' },
      `${channel} fails with a code the UI can switch on`);
  }
  assert.strictEqual(windows.length, 0, 'no window exists before whenReady resolves');
  assert.strictEqual(H.ALL_ERROR_CODES.includes('TRANSPORT_FAILED'), true,
    'TRANSPORT_FAILED is one of the service\'s own codes, not an invention of main.js');
});

// =============================================================== after boot ==

// A renderer with nodeIntegration can require('child_process') and spawn
// Bluetooth itself, which is precisely the arrangement this app exists to avoid;
// and one without contextIsolation shares a realm with the preload, so any page
// script can reach through the bridge's closure.
test('INT-ELEC-05  the renderer is created sandboxed, with no Node', async () => {
  await boot();
  assert.strictEqual(windows.length, 1, 'whenReady built exactly one window');
  const wp = windows[0].opts.webPreferences;
  assert.strictEqual(wp.contextIsolation, true, 'contextIsolation is on');
  assert.strictEqual(wp.nodeIntegration, false, 'nodeIntegration is off');
  assert.strictEqual(wp.sandbox, true, 'the renderer is sandboxed');

  // The constructed options and the source must agree: an option renamed in a
  // future Electron would still be present in one and meaningless in the other.
  assert.match(MAIN_SRC, /contextIsolation:\s*true/);
  assert.match(MAIN_SRC, /nodeIntegration:\s*false/);
  assert.match(MAIN_SRC, /sandbox:\s*true/);
});

// A preload path that does not exist is not an error in Electron: the window
// opens, the page loads, `window.scale` is undefined, and every button is dead.
test('INT-ELEC-06  the window loads a preload and a page that exist on disk', async () => {
  await boot();
  const win = windows[0];
  assert.strictEqual(path.isAbsolute(win.opts.webPreferences.preload), true,
    'the preload path is absolute, so it does not depend on the working directory');
  assert.strictEqual(win.opts.webPreferences.preload, PRELOAD_JS);
  assert.strictEqual(fs.existsSync(win.opts.webPreferences.preload), true, 'the preload file is there');
  assert.strictEqual(win.file, path.join(EXAMPLE, 'renderer', 'index.html'));
  assert.strictEqual(fs.existsSync(win.file), true, 'the renderer page is there');
  assert.strictEqual(win.opts.title, 'Body Scale');
});

// If start() reported success without a hello, the UI would enable its Measure
// button against a service that never came up. And a second start that spawned a
// second service would leave two children fighting over one Bluetooth radio.
test('INT-ELEC-07  scale:start reports a hello, and starting again is idempotent', async () => {
  const first = await boot();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.hello.proto, 1, 'the reply carries the protocol version');
  assert.strictEqual(first.hello.type, 'hello');
  assert.strictEqual(first.hello.app, 'bodyscale');
  assert.deepStrictEqual(first.hello.commands, ['measure', 'cancel', 'status', 'forget', 'shutdown']);
  assert.deepStrictEqual(first.hello.errorCodes, H.ALL_ERROR_CODES);

  const mark = pushed.length;
  const again = await call('scale:start');
  assert.strictEqual(again.ok, true);
  assert.deepStrictEqual(again.hello, first.hello, 'the same service, the same hello');
  assert.deepStrictEqual(pushesSince(mark, 'scale:closed'), [],
    'nothing was torn down and restarted underneath');
});

// The service must never hand back a remembered person. If it ever did, the
// renderer could stop sending age, height and sex, and the next machine — or the
// next user of this one — would silently get somebody else's body composition.
test('INT-ELEC-08  hello declares the profile host-supplied and never persisted', async () => {
  const { hello } = await boot();
  assert.deepStrictEqual(hello.profile.fields, ['age', 'heightCm', 'sex']);
  assert.strictEqual(hello.profile.required, true);
  assert.strictEqual(hello.profile.suppliedBy, 'host');
  assert.strictEqual(hello.profile.persisted, false);
  assert.strictEqual('sex' in hello.profile, false, 'hello carries no actual profile values');
  assert.strictEqual('age' in hello.profile, false);
  assert.strictEqual('heightCm' in hello.profile, false);
  assert.deepStrictEqual(hello.device, { name: 'OLD-NAME', address: 'OLD-ADDRESS', remembered: true },
    'the remembered device comes from BODYSCALE_CONFIG_DIR, not from the install directory');
});

// The UI disables Measure while the scale is busy. A status that could not
// answer, or that reported busy when nothing was running, would leave the
// button greyed out for the rest of the session.
test('INT-ELEC-09  scale:status answers idle, with the remembered device', async () => {
  await boot();
  const r = await call('scale:status');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status.busy, false, 'nothing is running');
  assert.strictEqual(r.status.runningId, null);
  assert.strictEqual(r.status.proto, 1);
  assert.strictEqual(r.status.platform, process.platform);
  assert.deepStrictEqual(r.status.device, { name: 'OLD-NAME', address: 'OLD-ADDRESS' });
});

// The remembered device is what makes the second measurement instant instead of
// a full scan. The profile must NOT be remembered with it: a config written by
// an older version still carries one, and leaving it there lets a later release
// fall back to a stale age and height instead of asking the host.
test('INT-ELEC-10  the first measurement remembers the scale and drops the inherited profile', async () => {
  await boot();
  const before = readConfigFile();
  assert.deepStrictEqual(before.profile, { sex: 'female', age: 61, heightCm: 155 },
    'the seeded config really did carry a profile');
  assert.strictEqual(before[ADDRESS_KEY], 'OLD-ADDRESS');

  const r = await call('scale:measure', H.PROFILE);
  assert.strictEqual(r.ok, true, JSON.stringify(r));

  const after = readConfigFile();
  assert.strictEqual('profile' in after, false, 'the inherited profile was deleted, not rewritten');
  assert.strictEqual(after[ADDRESS_KEY], r.result.device.address,
    'the device just measured is the one remembered');
  assert.notStrictEqual(after[ADDRESS_KEY], 'OLD-ADDRESS', 'the stale address was replaced');
  assert.strictEqual(after.name, H.EXPECTED.name);
  assert.strictEqual('address' in after, false, 'no platform-blind address key is written');
});

// Everything the app displays is in this one reply. A missing `derived` block,
// or nine keys instead of twenty-four, is a screen of blank rows next to a
// weight — the failure that looks like the scale half-worked.
test('INT-ELEC-11  scale:measure returns the whole result, all twenty-four derived metrics', async () => {
  await boot();
  const r = await call('scale:measure', H.PROFILE);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.result.type, 'measurement');
  assert.strictEqual(r.result.proto, 1);
  assert.strictEqual(r.result.ok, true);
  assert.strictEqual(r.result.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(r.result.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(r.result.device.name, H.EXPECTED.name);

  const keys = Object.keys(r.result.derived);
  assert.strictEqual(keys.length, 24, `twenty-four derived keys, got ${keys.length}`);
  for (const k of H.IMPEDANCE_FREE_KEYS) assert.ok(keys.includes(k), `derived.${k} is present`);
  for (const k of H.IMPEDANCE_ONLY_KEYS) assert.ok(keys.includes(k), `derived.${k} is present`);
  assert.strictEqual(r.result.trust.impedanceDerived, true,
    'the recorded impedance survived its checks, which is why all twenty-four are here');

  // The reply is about the profile the renderer sent on this call, not a stored one.
  assert.deepStrictEqual(r.result.profile,
    { sex: H.PROFILE.sex, age: H.PROFILE.age, heightCm: H.PROFILE.heightCm });
});

// Standing on a scale that shows nothing until it is finished feels broken, so
// the renderer draws the live weight as it settles. That needs main to forward
// the stream; if only the final reply arrived the display would jump from empty
// to done, and a measurement that timed out would have shown nothing at all.
test('INT-ELEC-12  live progress and service logs reach the renderer while measuring', async () => {
  await boot();
  const mark = pushed.length;
  const r = await call('scale:measure', H.PROFILE);
  assert.strictEqual(r.ok, true, JSON.stringify(r));

  const progress = pushesSince(mark, 'scale:progress');
  assert.ok(progress.length >= 3, `progress was forwarded, got ${progress.length}`);
  const phases = progress.map((p) => p.payload.phase);
  assert.ok(phases.includes('connected'), `a connected phase arrived, saw [${phases.join(', ')}]`);
  assert.ok(phases.includes('ready'), 'the "stand on the scale" phase arrived');
  const live = progress.filter((p) => typeof p.payload.weightKg === 'number' && p.payload.weightKg > 0);
  assert.ok(live.length >= 1, 'at least one live weight reached the renderer');
  assert.strictEqual(live[live.length - 1].payload.weightKg, H.EXPECTED.weightKg,
    'the last live weight is the one the reply settles on');
  for (const p of progress) assert.strictEqual(p.payload.proto, 1);

  const logs = pushesSince(mark, 'scale:log');
  assert.ok(logs.length >= 1, 'the service\'s stderr reached the renderer');
  for (const l of logs) assert.strictEqual(typeof l.payload, 'string', 'log lines are plain strings');

  const strays = pushesSince(mark).filter((p) => !PUSH_CHANNELS.includes(p.channel));
  assert.deepStrictEqual(strays, [], 'nothing is pushed on a channel the preload does not listen on');
});

// A rejected handler reaches the renderer as "Error invoking remote method
// 'scale:measure'" with the real reason buried in the string, so the UI cannot
// tell an impossible age from a scale that is switched off.
test('INT-ELEC-13  a bad profile comes back as a typed failure, not a throw', async () => {
  await boot();
  const r = await call('scale:measure', { age: 2, heightCm: 180 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INVALID_PROFILE');
  assert.strictEqual(typeof r.message, 'string');
  assert.ok(r.message.length > 0, 'and carries a message the UI can show');
  assert.strictEqual(r.detail, null);

  const missing = await call('scale:measure', undefined);
  assert.strictEqual(missing.ok, false, 'no profile at all is refused too');
  assert.strictEqual(missing.code, 'INVALID_PROFILE');

  const still = await call('scale:status');
  assert.strictEqual(still.ok, true, 'the service survived both');
  assert.strictEqual(still.status.busy, false, 'and did not leave itself marked busy');
});

// An error that belongs to a request is delivered by that request's reply.
// Pushing it on scale:error as well made the renderer show every failure twice:
// once in the result area and once as a toast, with no way for the UI to tell
// they were the same event.
test('INT-ELEC-14  a failure that belongs to a request is never also pushed on scale:error', async () => {
  await boot();
  const mark = pushed.length;
  const bad = await call('scale:measure', { age: 2, heightCm: 180 });
  assert.strictEqual(bad.code, 'INVALID_PROFILE', 'the reply carries the failure');
  assert.deepStrictEqual(pushesSince(mark, 'scale:error'), [],
    'and nothing was pushed at the renderer for the same failure');

  const mark2 = pushed.length;
  const cancel = await call('scale:cancel');
  assert.strictEqual(cancel.ok, false, 'cancelling with nothing running fails');
  assert.strictEqual(cancel.code, 'BAD_REQUEST');
  assert.deepStrictEqual(pushesSince(mark2, 'scale:error'), [],
    'that failure is not duplicated either');

  assert.deepStrictEqual(pushed.filter((p) => p.channel === 'scale:error'), [],
    'no attributed error has been pushed at any point in this run');
});

// ipcMain serialises every return value with the structured clone algorithm. A
// class instance, a function or an undefined-carrying object throws inside
// Electron at the moment of reply — and nowhere else, so plain Node tests of the
// client below would never see it.
test('INT-ELEC-15  every IPC reply survives structuredClone', async () => {
  const started = await boot();
  const replies = [
    started,
    await call('scale:status'),
    await call('scale:measure', H.PROFILE),
    await call('scale:measure', { age: 2, heightCm: 180 }),
    await call('scale:cancel'),
  ];
  for (const r of replies) {
    let clone;
    assert.doesNotThrow(() => { clone = structuredClone(r); },
      `reply is cloneable: ${JSON.stringify(r).slice(0, 120)}`);
    assert.deepStrictEqual(clone, r, 'and nothing is lost in the crossing');
  }
  assert.strictEqual(replies[2].ok, true, 'the measurement reply really was a full result');
  assert.strictEqual(Object.keys(replies[2].result.derived).length, 24);
});

// A measurement outlives the window if someone closes it mid-reading. Sending to
// a destroyed webContents throws "Object has been destroyed" inside the main
// process, which is an uncaught exception and takes the whole app down.
test('INT-ELEC-16  nothing is pushed at a destroyed window, and the reply still arrives', async () => {
  await boot();
  const win = currentWindow();
  win.destroyed = true;
  const mark = pushed.length;
  try {
    const r = await call('scale:measure', H.PROFILE);
    assert.strictEqual(r.ok, true, 'the measurement completed anyway: ' + JSON.stringify(r));
    assert.strictEqual(r.result.measured.weightKg, H.EXPECTED.weightKg);
    assert.deepStrictEqual(pushesSince(mark), [],
      'not one progress or log line was sent at the destroyed window');
  } finally {
    win.destroyed = false;
  }
  const mark2 = pushed.length;
  await call('scale:measure', H.PROFILE);
  assert.ok(pushesSince(mark2).length > 0, 'and pushing resumes once a live window is back');
});

// PERMISSION_DENIED cannot be retried away: on Windows the app must be ticked in
// the Bluetooth privacy list, on macOS in Privacy & Security. A button that
// opens the wrong page, or the Windows page on a Mac, leaves the user with an
// app that will never work and no way to find out why.
test('INT-ELEC-17  openBluetoothSettings opens the right page for each platform', async () => {
  await boot();
  const mark = openedUrls.length;

  const win = await asPlatform('win32', () => call('scale:openBluetoothSettings'));
  assert.deepStrictEqual(win, { ok: true });
  assert.strictEqual(openedUrls[openedUrls.length - 1], 'ms-settings:privacy-bluetooth');

  const mac = await asPlatform('darwin', () => call('scale:openBluetoothSettings'));
  assert.deepStrictEqual(mac, { ok: true });
  assert.strictEqual(openedUrls[openedUrls.length - 1],
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth');

  assert.strictEqual(openedUrls.length - mark, 2, 'exactly one page per call');

  // Neither of the two supported desktops is Linux, and the handler opens
  // nothing there. It still answers, so the UI does not hang on the click.
  const other = await asPlatform('linux', () => call('scale:openBluetoothSettings'));
  assert.deepStrictEqual(other, { ok: true });
  assert.strictEqual(openedUrls.length - mark, 2, 'and nothing was opened on an unsupported platform');
});

// Closing the last window on Windows must end the process. If it did not, the
// app would keep running headless with the Python helper still holding the
// Bluetooth radio, and the user's only clue would be Task Manager. On macOS the
// opposite is true: quitting there would break the expected dock behaviour.
test('INT-ELEC-18  the last window closing quits on Windows but not on macOS', async () => {
  await boot();
  const before = quits;
  await asPlatform('win32', () => { app.emit('window-all-closed'); });
  assert.strictEqual(quits, before + 1, 'Windows quits');
  await asPlatform('darwin', () => { app.emit('window-all-closed'); });
  assert.strictEqual(quits, before + 1, 'macOS stays running');
});

// On macOS clicking the dock icon after closing the window must bring it back.
// Without this the app is running, visible in the dock, and cannot be reached.
test('INT-ELEC-19  activating with no window open builds a new one', async () => {
  await boot();
  const openBefore = BrowserWindow.getAllWindows().length;
  assert.strictEqual(openBefore, 1, 'one window is open to begin with');
  currentWindow().destroyed = true;
  assert.strictEqual(BrowserWindow.getAllWindows().length, 0, 'now none are');

  const count = windows.length;
  app.emit('activate');
  assert.strictEqual(windows.length, count + 1, 'a replacement window was constructed');
  const fresh = currentWindow();
  assert.strictEqual(fresh.destroyed, false);
  assert.strictEqual(fresh.opts.webPreferences.sandbox, true, 'and it is sandboxed too');
  assert.strictEqual(fresh.file, path.join(EXAMPLE, 'renderer', 'index.html'));

  const mark = pushed.length;
  await call('scale:status');
  app.emit('activate');
  assert.strictEqual(windows.length, count + 1, 'activating with a window open builds nothing');
  assert.deepStrictEqual(pushesSince(mark, 'scale:closed'), [], 'and nothing was restarted');
});

// In a packaged app the scale cannot live inside app.asar: Python cannot read a
// script out of an archive and an interpreter cannot be spawned from one. If
// this resolved to the asar path the installed app would start, show its window,
// and fail every measurement with a file-not-found.
test('INT-ELEC-20  the packaged app looks for the scale beside the archive, not inside it', async () => {
  const dev = path.join(EXAMPLE, '..');
  assert.strictEqual(BodyScaleClient.resolveScaleDir({ isPackaged: false }, dev), dev,
    'development runs from the checkout');
  assert.strictEqual(BodyScaleClient.resolveScaleDir(null, dev), dev,
    'and so does anything with no app object');
  assert.strictEqual(fs.existsSync(path.join(dev, 'scale.js')), true,
    'that development path really does hold scale.js');

  const had = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  const previous = process.resourcesPath;
  process.resourcesPath = path.join(path.sep, 'opt', 'BodyScale', 'resources');
  try {
    assert.strictEqual(BodyScaleClient.resolveScaleDir({ isPackaged: true }, dev),
      path.join(process.resourcesPath, 'bodyscale'),
      'a packaged app reads it out of resources/bodyscale, which electron-builder unpacks');
  } finally {
    if (had) process.resourcesPath = previous; else delete process.resourcesPath;
  }
  assert.match(MAIN_SRC, /BodyScaleClient\.resolveScaleDir\(\s*app\s*,/,
    'main.js resolves the directory through that helper rather than hard-coding one');
});

// ============================================ state-mutating, ordered last ==

// "Forget this scale" exists for the user who replaced their scale, or whose
// saved address stopped matching after a Windows re-pair. If it only cleared
// memory and not the file, the stale address would come back on the next launch
// and every measurement would keep failing to find a device.
test('INT-ELEC-21  scale:forget clears the remembered device from status and from disk', async () => {
  await boot();
  const before = await call('scale:status');
  assert.ok(before.status.device && before.status.device.address,
    'a device is remembered to begin with: ' + JSON.stringify(before.status.device));
  assert.ok(readConfigFile()[ADDRESS_KEY], 'and it is on disk');

  const r = await call('scale:forget');
  assert.deepStrictEqual(r, { ok: true });

  const after = await call('scale:status');
  assert.strictEqual(after.ok, true);
  assert.strictEqual(after.status.device, null, 'status now reports no remembered device');

  const cfg = readConfigFile();
  assert.strictEqual(ADDRESS_KEY in cfg, false, 'and the address is gone from the file');
  assert.strictEqual('profile' in cfg, false, 'forget did not resurrect a profile either');
});

// The child MUST die with the app. before-quit is the only place early enough to
// close the pipe cleanly; skipping it, or quitting without waiting, orphans the
// Python helper, which goes on holding the Bluetooth radio until the machine is
// rebooted and makes the next launch fail to find the scale at all.
test('INT-ELEC-22  before-quit defers the quit, stops the service, and says so once', async () => {
  await boot();
  const running = await call('scale:status');
  assert.strictEqual(running.ok, true, 'the service is up before the quit');

  const mark = pushed.length;
  const quitsBefore = quits;
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true,
    'the quit is deferred so the child can be closed first');
  assert.strictEqual(app.isQuiting, true, 'and the flag is set so the handler does not re-enter');

  await waitFor(() => pushesSince(mark, 'scale:closed').length > 0, 'the service to close');
  const closed = pushesSince(mark, 'scale:closed');
  assert.strictEqual(closed.length, 1, 'the renderer is told exactly once');
  assert.strictEqual(closed[0].payload.intentional, true,
    'the close is marked intentional, which is what stops the respawn loop');
  assert.strictEqual(closed[0].payload.code, 0, 'the service exited cleanly rather than being killed');

  await waitFor(() => quits > quitsBefore, 'app.quit() to be called after the stop');
  assert.strictEqual(quits, quitsBefore + 1, 'and the app is quit exactly once');
});

// After the quit path the service is gone. Every command must still answer, and
// answer with a code, rather than hanging: a renderer left holding a promise
// that never settles shows a spinner that outlives the app it belongs to. And
// nothing may respawn behind it — that is the orphan this whole path prevents.
test('INT-ELEC-23  once the service is stopped, commands fail cleanly and nothing respawns', async () => {
  const closedBefore = pushed.filter((p) => p.channel === 'scale:closed').length;

  const measure = await call('scale:measure', H.PROFILE);
  assert.deepStrictEqual(measure,
    { ok: false, code: 'TRANSPORT_FAILED', message: 'the scale service is not running' });
  for (const channel of ['scale:status', 'scale:cancel', 'scale:forget']) {
    assert.deepStrictEqual(await call(channel), { ok: false, code: 'TRANSPORT_FAILED' },
      `${channel} fails cleanly with the service gone`);
  }

  await sleep(1200);                     // longer than the first respawn back-off
  assert.strictEqual(pushed.filter((p) => p.channel === 'scale:closed').length, closedBefore,
    'no second service was started and closed behind our backs');
  assert.deepStrictEqual((await call('scale:status')), { ok: false, code: 'TRANSPORT_FAILED' },
    'and the service is still down');
  assert.deepStrictEqual(pushed.filter((p) => p.channel === 'scale:error'), [],
    'the clean shutdown never looked like an error to the renderer');
});
