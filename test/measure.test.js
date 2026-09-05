'use strict';
// Covers the measure-on-demand flow in index.html: pair once, stand on the
// scale, press one button, get the full panel. The fake Bluetooth stack can be
// taken offline so the connect-retry window is exercised for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const full = (u) => '0000' + u + '-0000-1000-8000-00805f9b34fb';
const hexToBytes = (s) => Uint8Array.from(s.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real frames from the hardware. The scale's display read 98.50 kg.
const FRAMES = {
  settling: '2f 00 07 00 a2 01 00 01 13 32 00 09',
  record:   '06 00 23 00 a7 00 00 0c 0e 25 01 80 c4 00 0a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 15',
  // Subtype 0x01: the impedances, three little-endian uint16 in tenths of an
  // ohm — trunk, right leg, left leg — summing to 308.6. The 0x00 frame above
  // carries a weight and a timestamp, and never an impedance.
  impedance: '07 00 23 01 a7 00 00 04 04 05 04 05 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02',
  // 1300.0 ohm, all in the trunk slot: a real number, but outside the plausible
  // band, so the trust rules reject the panel it produces.
  impedanceBad: '08 00 23 01 a7 00 00 c8 32 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02',
  final:    '76 00 07 00 a2 00 00 01 80 c4 00 07',
};

function mkEl(id) {
  const el = { id, _t: '', value: '', checked: false, hidden: false, className: '', innerHTML: '', children: [], style: {},
    dataset: {}, _handlers: {},
    set textContent(v) { this._t = v; }, get textContent() { return this._t; },
    appendChild(c) { this.children.push(c); },
    addEventListener(ev, cb) { this._handlers[ev] = cb; }, removeEventListener() {},
    querySelector: () => null };
  return el;
}

function boot(opts) {
  const o = opts || {};
  const nodes = {};
  ['log','env','progress','results','identity','pairState','verNote','hexIn','hexChar','extraUuids','udsRow','writeRow','writeChar',
   'writeHex','opTimeout','pSex','pAge','pHeight','udsIndex','udsConsent','btnPair','btnForget','btnMeasure','btnCancel','btnClear',
   'btnCopy','btnDownload','btnParseHex','btnUdsList','btnUdsRegister','btnUdsConsent','btnWrite','chkMonitor','chkReadAll',
   'connectWindow','measureWindow','retryInterval','counts','caps','chkUseScan','btnDiag'].forEach((i) => nodes[i] = mkEl(i));
  nodes.opTimeout.value = '400'; nodes.retryInterval.value = '150';
  nodes.connectWindow.value = String(o.connectWindow || 3);
  nodes.measureWindow.value = String(o.measureWindow || 3);
  nodes.pSex.value = 'male'; nodes.pAge.value = '39'; nodes.pHeight.value = '180';
  nodes.chkReadAll.checked = false; nodes.chkMonitor.checked = false;
  // Mirror the initial state the real markup carries.
  nodes.btnMeasure.disabled = false;
  nodes.btnForget.hidden = true;
  nodes.pairState.textContent = 'Not paired yet.';
  nodes.caps.hidden = true;
  nodes.chkUseScan.checked = o.useScan !== false;
  nodes.progress.textContent = 'Press Measure. It will ask for your scale the first time.';
  nodes.btnCancel.hidden = true;
  nodes.results.hidden = true;
  nodes.udsRow.hidden = true;
  nodes.writeRow.hidden = true;

  const timers = new Set();
  const sTimeout = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); timers.add(t); return t; };
  const sInterval = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); timers.add(t); return t; };
  const clearAll = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); };

  const state = { reachable: true, connectCalls: 0, listeners: {}, disconnectCb: null,
                  chooserFails: o.chooserFails || false, disconnectCalls: 0,
                  chooserCalls: 0, getDevicesCalls: 0, advWatchCalls: 0 };
  const mkChar = (u, props) => ({
    uuid: full(u),
    properties: Object.assign({ read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false }, props),
    async startNotifications() { return this; },
    addEventListener(_, cb) { state.listeners[u] = cb; },
    async getDescriptors() { return []; },
    async readValue() { throw new Error('no read'); },
  });
  const chars = { ffb1: mkChar('ffb1', { write: true }), ffb2: mkChar('ffb2', { notify: true }), ffb3: mkChar('ffb3', { indicate: true }) };
  const services = [{ uuid: full('ffb0'), async getCharacteristics() { return [chars.ffb1, chars.ffb2, chars.ffb3]; } }];
  const server = { async getPrimaryServices() { return services; } };
  const device = {
    name: 'SSW533', id: 'fake',
    gatt: {
      connected: false,
      async connect() {
        state.connectCalls++;
        if (!state.reachable) { const e = new Error('Connection attempt failed.'); e.name = 'NetworkError'; throw e; }
        this.connected = true; return server;
      },
      disconnect() { state.disconnectCalls++; this.connected = false; },
    },
    addEventListener(ev, cb) {
      if (ev === 'gattserverdisconnected') state.disconnectCb = cb;
      if (ev === 'advertisementreceived') state.advCb = cb;
    },
    removeEventListener() {},
  };
  if (o.watchAdvertisements !== false) {
    device.watchAdvertisements = async function () { state.advWatchCalls++; };
  }
  state.scanStops = 0;

  const radio = { value: '1.0.1', checked: true, addEventListener() {} };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: sTimeout, clearTimeout, setInterval: sInterval, clearInterval, Date, Math, JSON, TextDecoder, Promise,
    Uint8Array, DataView, ArrayBuffer, Blob: function () {}, URL: { createObjectURL: () => '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {
      bluetooth: Object.assign({
        async getAvailability() { return true; },
        async requestDevice() {
          state.chooserCalls++;
          if (state.chooserFails) { const e = new Error('User cancelled'); e.name = 'NotFoundError'; throw e; }
          return device;
        },
        addEventListener() {}, removeEventListener() {},
      }, o.getDevices === false ? {} : {
        async getDevices() { state.getDevicesCalls++; return o.knownDevices === false ? [] : [device]; },
      }, o.requestLEScan !== true ? {} : {
        async requestLEScan() {
          state.scanCalls = (state.scanCalls || 0) + 1;
          return { stop() { state.scanStops++; } };
        },
      }),
      userAgent: 'Chrome/148', clipboard: { writeText: async () => {} },
    },
    isSecureContext: true, window: {}, self: null,
    location: { protocol: o.fileOrigin ? 'file:' : 'http:', origin: o.fileOrigin ? null : 'http://localhost:8777' },
    document: {
      getElementById: (id) => nodes[id] || mkEl(id),
      createElement: () => mkEl('t'),
      querySelector: (s) => (s.includes('name=ver') ? radio : null),
      querySelectorAll: (s) => (s.includes('name=ver') ? [radio] : []),
    },
  };
  sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['bcs.js', 'scales-db.js', 'bia.js', 'drivers.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1], sandbox, { filename: 'index.html' });

  const emit = (u, hex) => state.listeners[u] && state.listeners[u]({ target: { uuid: full(u), value: hexToBytes(hex) } });
  const lines = () => nodes.log.children.map((c) => c.textContent.replace(/^\[[^\]]+\]\s*/, ''));
  return { nodes, state, device, emit, lines, stop: () => clearAll() };
}

test('a previously granted scale is restored on load with no chooser', async () => {
  const h = boot();
  await sleep(30);
  assert.equal(h.state.getDevicesCalls, 1, 'getDevices is consulted at startup');
  assert.equal(h.state.chooserCalls, 0, 'and no chooser is shown');
  assert.match(h.nodes.pairState.textContent, /SSW533/);
  h.stop();
});

test('Measure is never left disabled, so it can always recover the scale', async () => {
  const h = boot({ knownDevices: false, chooserFails: true });
  await sleep(30);
  assert.equal(h.nodes.btnMeasure.disabled, false);
  await h.nodes.btnMeasure.onclick();
  assert.equal(h.nodes.btnMeasure.disabled, false, 'still pressable after a cancelled chooser');
  h.stop();
});

test('a cancelled chooser leaves the app usable and says so', async () => {
  const h = boot({ knownDevices: false, chooserFails: true });
  await sleep(30);
  await h.nodes.btnMeasure.onclick();
  assert.match(h.nodes.progress.textContent, /No scale selected/);
  h.stop();
});

test('a granted scale connects with no chooser at all', async () => {
  const h = boot();
  await sleep(30);
  const chooserBefore = h.state.chooserCalls;
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb3', FRAMES.record);
  await m;
  assert.equal(h.state.chooserCalls, chooserBefore, 'no chooser was opened');
  assert.match(h.nodes.results.innerHTML, /98\.5 kg/);
  h.stop();
});

test('after a failed window it still recovers silently, without a chooser', async () => {
  const h = boot({ connectWindow: 1 });
  await sleep(30);
  h.state.reachable = false;
  await h.nodes.btnMeasure.onclick();           // window expires, needsRepair set
  const chooserBefore = h.state.chooserCalls;

  h.state.reachable = true;
  const m = h.nodes.btnMeasure.onclick();
  await sleep(150);
  assert.equal(h.state.chooserCalls, chooserBefore,
    'getDevices can supply the scale, so the chooser must stay shut');
  h.emit('ffb3', FRAMES.record);
  await m;
  assert.match(h.nodes.results.innerHTML, /98\.5 kg/);
  h.stop();
});

test('the chooser is only used when nothing was ever granted', async () => {
  const h = boot({ knownDevices: false });
  await sleep(30);
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  assert.equal(h.state.chooserCalls, 1, 'the one case that genuinely needs a pick');
  h.emit('ffb3', FRAMES.record);
  await m;
  h.stop();
});

test('scanning and connecting never overlap, and the scan is always stopped', async () => {
  const h = boot({ connectWindow: 4, requestLEScan: true });
  await sleep(30);
  h.state.reachable = false;                    // force repeated connect failures
  const m = h.nodes.btnMeasure.onclick();
  await sleep(1800);                            // long enough for a discovery burst
  assert.ok(h.state.scanCalls >= 1, 'a discovery burst runs between connect attempts');
  h.nodes.btnCancel.onclick();
  await m;
  await sleep(250);                             // let any in-flight burst unwind
  assert.equal(h.state.scanCalls, h.state.scanStops,
    'every scan started is stopped again, so none is ever live during a connect');
  h.stop();
});

test('turning scanning off removes it entirely', async () => {
  const h = boot({ connectWindow: 2, requestLEScan: true, useScan: false });
  await sleep(30);
  h.state.reachable = false;
  await h.nodes.btnMeasure.onclick();
  assert.equal(h.state.scanCalls || 0, 0, 'no scan when the user has switched it off');
  assert.ok(h.lines().some((l) => /no scanning API, or scanning turned off/.test(l)));
  h.stop();
});

test('a Chrome with no discovery at all still measures, and says what is missing', async () => {
  const h = boot({ watchAdvertisements: false });
  await sleep(30);
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb3', FRAMES.record);
  await m;
  assert.match(h.nodes.results.innerHTML, /98\.5 kg/);
  assert.ok(h.lines().some((l) => /plain connect attempts only/.test(l)));
  h.stop();
});

test('a sleeping scale with no way to check says so honestly', async () => {
  const h = boot({ connectWindow: 1, watchAdvertisements: false });
  await sleep(30);
  h.state.reachable = false;
  await h.nodes.btnMeasure.onclick();
  assert.ok(h.lines().some((l) => /No scanning was possible/.test(l)),
    'does not claim to know whether the scale was advertising');
  h.stop();
});

test('missing discovery APIs raise a banner naming the exact flag', async () => {
  const h = boot({ getDevices: false, watchAdvertisements: false });
  await sleep(40);
  assert.equal(h.nodes.caps.hidden, false);
  assert.match(h.nodes.caps.innerHTML, /enable-experimental-web-platform-features/);
  assert.match(h.nodes.caps.innerHTML, /getDevices/);
  h.stop();
});

test('diagnostics report the capability set and the device in use', async () => {
  const h = boot();
  await sleep(30);
  await h.nodes.btnDiag.onclick();
  const l = h.lines().join('\n');
  assert.match(l, /getDevices=true/);
  assert.match(l, /current device: "SSW533"/);
  assert.match(l, /granted devices/);
  h.stop();
});

test('one press of Measure captures weight and impedance and renders the full panel', async () => {
  const h = boot();
  await sleep(30);
  const measuring = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb2', FRAMES.settling);
  h.emit('ffb3', FRAMES.record);        // the weight
  h.emit('ffb3', FRAMES.impedance);     // and the impedance, on its own frame
  await measuring;

  assert.equal(h.nodes.results.hidden, false, 'result panel is shown');
  const out = h.nodes.results.innerHTML;
  assert.match(out, /98\.5 kg/, 'the weight from the hardware');
  assert.match(out, /308\.6/, 'the impedance from the hardware');
  for (const label of ['Body fat, from impedance', 'Body fat, from BMI', 'Fat-free mass', 'Skeletal muscle',
                       'Body water', 'Bone mass', 'Protein', 'Basal metabolic rate', 'BMI category']) {
    assert.ok(out.includes(label), `panel is missing ${label}`);
  }
  assert.ok(!out.includes('Visceral fat rating'), 'a metric with no defensible formula must not be shown');
  assert.ok(out.includes('no visceral fat rating'), 'but the omission must be explained');
  assert.match(h.nodes.progress.textContent, /Done/);
  h.stop();
});

test('the panel labels every number as measured, derived or approximate', async () => {
  const h = boot();
  await sleep(30);
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb3', FRAMES.record);
  h.emit('ffb3', FRAMES.impedance);
  await m;
  const out = h.nodes.results.innerHTML;
  assert.ok(out.includes('tag measured'), 'weight is marked as measured');
  assert.ok(out.includes('tag lit'), 'literature-backed values are marked');
  assert.ok(out.includes('tag conv'), 'vendor conventions are marked');
  assert.ok(out.includes('% body fat'), 'one body fat figure is led with');
  h.stop();
});

test('an untrustworthy body fat figure is called out on the panel', async () => {
  const h = boot();
  await sleep(30);
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb3', FRAMES.record);
  h.emit('ffb3', FRAMES.impedanceBad);
  await m;
  assert.match(h.nodes.results.innerHTML, /not trustworthy in absolute terms/);
  assert.match(h.nodes.results.innerHTML, /foot-to-foot/);
  h.stop();
});

test('the scale is released after a measurement so it is free for the next one', async () => {
  const h = boot();
  await sleep(30);
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb3', FRAMES.record);
  await m;
  assert.ok(h.state.disconnectCalls >= 1, 'disconnected when done');
  assert.equal(h.device.gatt.connected, false);
  h.stop();
});

test('Measure retries while the scale is asleep, then succeeds when it wakes', async () => {
  const h = boot({ connectWindow: 4 });
  await sleep(30);
  h.state.reachable = false;
  const m = h.nodes.btnMeasure.onclick();
  await sleep(700);
  assert.ok(h.state.connectCalls >= 3, `expected several attempts, got ${h.state.connectCalls}`);
  assert.match(h.nodes.progress.textContent, /Reaching the scale/);

  h.state.reachable = true;             // user steps on the scale
  for (let i = 0; i < 60 && !h.state.listeners.ffb3; i++) await sleep(100);
  assert.ok(h.state.listeners.ffb3, 'reconnected and re-subscribed once the scale woke');
  h.emit('ffb3', FRAMES.record);
  await m;
  assert.match(h.nodes.results.innerHTML, /98\.5 kg/, 'measurement completed after the scale woke');
  h.stop();
});

test('a scale that never wakes gives a clear message, not a hang', async () => {
  const h = boot({ connectWindow: 1 });
  await sleep(30);
  h.state.reachable = false;
  await h.nodes.btnMeasure.onclick();
  assert.match(h.nodes.progress.textContent, /Could not reach the scale/);
  assert.equal(h.nodes.btnMeasure.disabled, false, 'the button is usable again');
  h.stop();
});

test('a weight-only measurement still reports, and explains the missing impedance', async () => {
  const h = boot({ measureWindow: 2 });
  await sleep(30);
  const m = h.nodes.btnMeasure.onclick();
  await sleep(120);
  h.emit('ffb2', FRAMES.final);         // final weight, no record frame at all
  await m;
  const out = h.nodes.results.innerHTML;
  assert.match(out, /98\.5 kg/);
  assert.match(out, /No impedance was measured/);
  assert.ok(!out.includes('Body fat, from impedance'), 'no impedance means no impedance-based body fat');
  assert.ok(out.includes('Body fat, from BMI'), 'but the BMI method still works');
  h.stop();
});

test('no data at all times out with an instruction rather than failing silently', async () => {
  const h = boot({ measureWindow: 1 });
  await sleep(30);
  await h.nodes.btnMeasure.onclick();
  assert.match(h.nodes.progress.textContent, /No reading in/);
  assert.match(h.nodes.progress.textContent, /bare feet/);
  h.stop();
});

test('Cancel stops a measurement in progress', async () => {
  const h = boot({ connectWindow: 5 });
  await sleep(30);
  h.state.reachable = false;
  const m = h.nodes.btnMeasure.onclick();
  await sleep(300);
  h.nodes.btnCancel.onclick();
  await m;
  assert.match(h.nodes.progress.textContent, /Cancelled/);
  assert.equal(h.nodes.btnMeasure.disabled, false);
  h.stop();
});

test('Forget clears the pairing but leaves Measure able to recover it', async () => {
  const h = boot();
  await sleep(30);
  assert.match(h.nodes.pairState.textContent, /SSW533/);
  h.nodes.btnForget.onclick();
  assert.match(h.nodes.pairState.textContent, /Not paired/);
  assert.equal(h.nodes.btnMeasure.disabled, false, 'Measure stays pressable and re-acquires the scale');
  h.stop();
});

test('missing discovery APIs raise a banner naming the exact flag', async () => {
  const h = boot({ getDevices: false, watchAdvertisements: false });
  await sleep(40);
  assert.equal(h.nodes.caps.hidden, false, 'the banner is shown');
  assert.match(h.nodes.caps.innerHTML, /enable-experimental-web-platform-features/);
  assert.match(h.nodes.caps.innerHTML, /getDevices/);
  h.stop();
});

test('two measurements in a row both work', async () => {
  const h = boot();
  await sleep(30);
  for (let i = 0; i < 2; i++) {
    h.nodes.results.innerHTML = '';
    const m = h.nodes.btnMeasure.onclick();
    await sleep(120);
    h.emit('ffb3', FRAMES.record);
    await m;
    assert.match(h.nodes.results.innerHTML, /98\.5 kg/, `measurement ${i + 1}`);
  }
  h.stop();
});


test('a file:// page explains that the grant cannot persist, and names the fix', async () => {
  const h = boot({ fileOrigin: true, knownDevices: false });
  await sleep(60);
  assert.equal(h.nodes.caps.hidden, false, 'the banner is shown');
  assert.match(h.nodes.caps.innerHTML, /file:\/\//, 'names the origin as the cause');
  assert.match(h.nodes.caps.innerHTML, /start\.command/, 'points at the launcher');
  assert.match(h.nodes.caps.innerHTML, /enable-web-bluetooth-new-permissions-backend/, 'names the second flag');
  h.stop();
});

test('an empty granted list is reported as Chrome not remembering, not as a missing API', async () => {
  const h = boot({ knownDevices: false });
  await sleep(60);
  assert.equal(h.nodes.caps.hidden, false);
  assert.match(h.nodes.caps.innerHTML, /not remembering your scale/);
  assert.ok(h.lines().some((l) => /getDevices returned an empty list/.test(l)));
  h.stop();
});

test('a served page with a remembered scale and full APIs shows no banner at all', async () => {
  const h = boot({ requestLEScan: true });
  await sleep(60);
  assert.equal(h.nodes.caps.hidden, true, 'nothing to complain about once it works');
  assert.match(h.nodes.pairState.textContent, /SSW533/);
  h.stop();
});

test('the launcher serves a real origin and documents both flags', () => {
  const fsx = require('fs');
  const sh = fsx.readFileSync(require('path').join(__dirname, '..', 'start.command'), 'utf8');
  assert.match(sh, /http\.server/, 'starts a server');
  assert.match(sh, /localhost/, 'on a real origin');
  assert.match(sh, /enable-web-bluetooth-new-permissions-backend/, 'documents the persistence flag');
  assert.match(sh, /enable-experimental-web-platform-features/, 'documents the discovery flag');
  assert.ok((fsx.statSync(require('path').join(__dirname, '..', 'start.command')).mode & 0o111) !== 0,
    'and is executable so it can be double-clicked');
});
