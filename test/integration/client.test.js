'use strict';
/**
 * INT-CLI — BodyScaleClient, the wrapper the Electron main process owns.
 *
 * main.js never touches the pipe. It constructs one BodyScaleClient, calls
 * start() at app launch, measure() per reading, and stop() on quit, and it
 * forwards the client's events over IPC to the renderer. So every bug in this
 * file is a bug the user sees: a spinner that never stops, a reading that
 * belongs to a request nobody made, or — the worst one — an unhandled error
 * that takes the whole Electron process down while somebody is standing on a
 * scale.
 *
 * These cases drive the REAL client against the REAL `scale.js --serve`, over a
 * real pipe, with the recorded SSW533 session standing in for the radio. No
 * Bluetooth, no hardware, no mocks.
 *
 * Every client here is stopped in a `finally`, and every wait on a client event
 * is bounded, so a wrapper that stops answering fails the case with a message
 * instead of hanging the runner and leaking a child.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const H = require('./harness');
const { BodyScaleClient, ScaleError, PROTOCOL_VERSION } = require(H.CLIENT);

/** Last-resort ceiling. Nothing here takes more than ~1.5 s in practice. */
const T = { timeout: 25000 };

/** scale.js keys the remembered address by platform; so must the assertions. */
const ADDRESS_KEY = `address_${process.platform}`;

/** The address the recorded session advertises, which is what gets remembered. */
const FIXTURE_ADDRESS = 'BEECC6EC-BD30-3EAC-B148-4833628A8A58';

/**
 * A config directory holding an explicitly empty config.
 *
 * A bare empty directory is not enough: readConfig() falls back to the legacy
 * .scale-config.json beside scale.js when the per-user file cannot be read, and
 * this repo has one, remembered device and all. Writing `{}` makes the per-user
 * file the one that is found, so `hello.device` is null on every machine
 * instead of null on CI and populated on a developer's laptop.
 */
function configDir(tag) {
  const dir = H.tmpdir(tag);
  fs.writeFileSync(path.join(dir, 'scale-config.json'), '{}\n');
  return dir;
}

function readSavedConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
}

/** A client wired exactly the way electron-example/main.js wires one. */
function makeClient(tag, extra = {}) {
  const { env = {}, ...rest } = extra;
  return new BodyScaleClient(Object.assign({
    scaleDir: H.ROOT,
    replay: H.FIXTURE,
    env: Object.assign({ BODYSCALE_CONFIG_DIR: configDir(tag) }, env),
  }, rest));
}

/**
 * Resolve on the next occurrence of a client event.
 *
 * The deadline is a failsafe, never a synchronisation device: every event
 * waited on here arrives in tens of milliseconds. Without it a wrapper that
 * stopped emitting would hang the whole runner, and the `finally` that stops
 * the child would never run.
 */
function once(client, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const ok = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      client.off(event, ok);
      reject(new Error(`the client never emitted '${event}' within ${ms} ms`));
    }, ms);
    client.once(event, ok);
  });
}

/** Capture a rejection without swallowing it: the caller must assert on it. */
const rejection = (promise) => promise.then(
  (value) => { throw new Error(`expected a rejection, got ${JSON.stringify(value)}`); },
  (err) => err);

/* ---------------------------------------------------------------- start ---- */

// Prevents: main.js calling start() again on an already-running service — from a
// second window, or a retry after a failed measure — and spawning a second
// scale.js. Two services fighting over one Bluetooth radio is a hang, and the
// orphan outlives the app.
test('INT-CLI-01  start() resolves with hello and is idempotent', T, async () => {
  const client = makeClient('cli01');
  try {
    let hellos = 0;
    client.on('hello', () => { hellos++; });

    const h1 = await client.start();
    const child = client.child;
    const h2 = await client.start();
    const h3 = await client.start();

    assert.strictEqual(h1.type, 'hello');
    assert.strictEqual(h1.proto, PROTOCOL_VERSION);
    assert.strictEqual(h1.app, 'bodyscale');
    assert.deepStrictEqual(h1.commands, ['measure', 'cancel', 'status', 'forget', 'shutdown'],
      'hello names the five commands the client wraps');
    assert.deepStrictEqual(h1.errorCodes, H.ALL_ERROR_CODES,
      'and the eleven codes the renderer switches on');
    assert.strictEqual(h2, h1, 'the second start() handed back the same hello');
    assert.strictEqual(h3, h1, 'and so did the third');
    assert.strictEqual(client.child, child, 'no second child was spawned');
    assert.strictEqual(hellos, 1, 'exactly one service announced itself');
    assert.strictEqual(client.running, true);
  } finally {
    await client.stop();
  }
});

// Prevents: the renderer throwing "Cannot read properties of null (reading
// 'device')". Two windows calling start() in the same tick means the second
// call finds a spawned child and a hello that has not arrived. Handing back
// this.hello there would resolve with null.
test('INT-CLI-02  a second start() before hello has landed waits for it instead of resolving null', T, async () => {
  const client = makeClient('cli02');
  try {
    const first = client.start();
    assert.strictEqual(client.running, true, 'the child is spawned synchronously');
    assert.strictEqual(client.hello, null, 'and hello has not arrived yet');

    const second = client.start();
    const [h1, h2] = await Promise.all([first, second]);

    assert.notStrictEqual(h2, null, 'the racing start() did not resolve with null');
    assert.strictEqual(h2, h1, 'both callers got the one hello');
    assert.strictEqual(h2.type, 'hello');
    assert.strictEqual('device' in h2, true, 'a renderer reading hello.device cannot throw');
    assert.strictEqual(h2.device, null, 'nothing is remembered in a fresh config directory');
    assert.strictEqual(client.hello, h1, 'the client kept the hello for later start() calls');
  } finally {
    await client.stop();
  }
});

// Prevents: the app-launch spinner that never clears. A service that spawns but
// never announces itself — a half-installed Node, a scale.js wedged on an
// import — must fail start() rather than leave main.js awaiting for ever, and
// must not leave the mute child running.
test('INT-CLI-03  start() gives up on a service that never announces itself', T, async () => {
  // A stand-in scale.js, written into a scratch directory. It answers nothing
  // and exits when its stdin closes, which is exactly what a wedged service
  // looks like to the client.
  const dir = configDir('cli03');
  fs.writeFileSync(path.join(dir, 'scale.js'), [
    "'use strict';",
    'process.stdin.resume();',
    "process.stdin.on('end', () => process.exit(0));",
    "process.stderr.write('a service that never announces itself\\n');",
    '',
  ].join('\n'));

  const client = new BodyScaleClient({
    scaleDir: dir, startTimeoutMs: 600, env: { BODYSCALE_CONFIG_DIR: dir },
  });
  try {
    const err = await rejection(client.start());

    assert.ok(err instanceof ScaleError, 'a ScaleError, so the renderer can switch on it');
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.strictEqual(err.message, 'the scale service did not announce itself within 600 ms');
    assert.strictEqual(client.running, false, 'the mute child was retired, not left running');
    assert.strictEqual(client.child, null);
    assert.strictEqual(client.hello, null);
    assert.deepStrictEqual(client.eventNames(), [],
      'the failed start left no listeners behind either');
  } finally {
    await client.stop();
  }
});

/* -------------------------------------------------------------- measure ---- */

// Prevents: measure() resolving with an `accepted` or a `progress` envelope, so
// the app renders "undefined kg"; and prevents the host being asked to invent a
// request id, which is the client's own bookkeeping and must never leak into
// the API main.js calls.
test('INT-CLI-04  measure() resolves with the measurement envelope, under an id the client assigned', T, async () => {
  const client = makeClient('cli04');
  try {
    await client.start();
    const res = await client.measure(H.PROFILE);

    assert.strictEqual(res.type, 'measurement', 'not accepted, not progress');
    assert.strictEqual(res.proto, PROTOCOL_VERSION);
    assert.strictEqual(res.ok, true);
    H.assertShape(assert, res, {
      proto: 'number', type: 'string', id: 'string', ok: 'boolean', timestamp: 'string',
      device: 'object', model: 'string', measured: 'object', derived: 'object',
      units: 'object', confidence: 'object', trust: 'object',
      bodyFatRecommended: 'object', crossCheck: 'object?', flags: 'array',
      warnings: 'array', omitted: 'object', profile: 'object',
    }, 'measurement');

    assert.strictEqual(res.measured.weightKg, H.EXPECTED.weightKg);
    assert.strictEqual(res.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
    assert.strictEqual(res.device.name, H.EXPECTED.name);
    assert.strictEqual(res.trust.impedanceDerived, true,
      'no fatal flag fired on the recorded session');
    assert.strictEqual(Object.keys(res.derived).length, 24,
      'impedance survived its checks, so all 24 derived values are present');
    for (const key of H.IMPEDANCE_FREE_KEYS.concat(H.IMPEDANCE_ONLY_KEYS)) {
      assert.ok(key in res.derived, `derived.${key}`);
    }
    assert.deepStrictEqual(res.profile, { sex: 'male', age: 39, heightCm: 180 },
      'the service echoed the profile the host supplied, and invented nothing');

    // The id is the client's own counter, not anything the caller supplied.
    assert.strictEqual(res.id, 'r1', 'the first request of this client');
    const second = await client.measure(H.PROFILE);
    assert.strictEqual(second.id, 'r2', 'a fresh id per request');
    assert.strictEqual(second.measured.weightKg, H.EXPECTED.weightKg);
  } finally {
    await client.stop();
  }
});

// Prevents: a silent scale. main.js relays these to the renderer so the person
// on the scale sees "connected", "stand on the scale", then a live weight. The
// phase-named events are what a UI subscribes to per screen; if only the
// generic 'progress' fired, every one of those handlers would be dead code.
test('INT-CLI-05  progress arrives as a progress event and again under its phase name', T, async () => {
  const client = makeClient('cli05');
  try {
    await client.start();
    const progress = [];
    const named = { connected: [], ready: [], settling: [] };
    client.on('progress', (p) => progress.push(p));
    for (const phase of Object.keys(named)) client.on(phase, (p) => named[phase].push(p));

    const res = await client.measure(H.PROFILE);

    assert.deepStrictEqual([...new Set(progress.map((p) => p.phase))],
      ['connected', 'ready', 'settling'],
      'the recorded session walks connected, ready, then live weights');
    assert.strictEqual(named.connected.length, 1, 'one connected event');
    assert.strictEqual(named.ready.length, 1, 'one ready event');
    assert.ok(named.settling.length >= 2, `live weights streamed (${named.settling.length})`);
    assert.strictEqual(
      named.connected.length + named.ready.length + named.settling.length,
      progress.length,
      'every progress event was re-emitted under its phase name, and none twice');
    assert.strictEqual(named.connected[0], progress.find((p) => p.phase === 'connected'),
      'the phase-named event is the same object, not a copy');

    assert.strictEqual(named.connected[0].device.name, H.EXPECTED.name);
    assert.strictEqual(named.connected[0].device.address, FIXTURE_ADDRESS);
    assert.strictEqual(named.ready[0].message, 'stand on the scale');
    for (const p of named.settling) assert.ok(p.weightKg > 0, `settling weight ${p.weightKg}`);
    assert.strictEqual(named.settling[named.settling.length - 1].weightKg, res.measured.weightKg,
      'the last live weight is the weight that was reported');
    for (const p of progress) assert.strictEqual(p.id, res.id, 'progress carries the measure id');
  } finally {
    await client.stop();
  }
});

// Prevents: the reading that belongs to a request nobody made. Replies may
// interleave, so a wrapper that settled promises in arrival order would hand
// the status envelope to whoever called measure(). Three requests are in flight
// here at once and each must get its own answer.
test('INT-CLI-06  replies are correlated by id, not by arrival order', T, async () => {
  const client = makeClient('cli06', { env: { REPLAY_DELAY_MS: '80' } });
  try {
    await client.start();
    const progress = [];
    client.on('progress', (p) => progress.push(p));

    const measuring = client.measure(H.PROFILE);
    await once(client, 'ready');

    // Both are asked while the measurement is still streaming, and both are
    // answered before it finishes: their replies land in the middle of r1's.
    const [status, forgotten] = await Promise.all([client.status(), client.forget()]);

    assert.strictEqual(status.type, 'status', 'the status caller got the status');
    assert.strictEqual(status.id, 'r2');
    assert.strictEqual(status.busy, true, 'the service reports the measurement in flight');
    assert.strictEqual(status.runningId, 'r1', 'and names the request that is running');
    assert.strictEqual(status.device, null, 'nothing is remembered until a reading lands');

    assert.strictEqual(forgotten.type, 'forgotten', 'the forget caller got the forgotten');
    assert.strictEqual(forgotten.id, 'r3');

    const res = await measuring;
    assert.strictEqual(res.type, 'measurement', 'and the measure caller got the measurement');
    assert.strictEqual(res.id, 'r1');
    assert.strictEqual(res.measured.weightKg, H.EXPECTED.weightKg,
      'undisturbed by the two requests that overtook it');
    assert.ok(progress.length >= 3, `progress kept streaming throughout (${progress.length})`);
    for (const p of progress) assert.strictEqual(p.id, 'r1', 'and stayed addressed to the measure');
  } finally {
    await client.stop();
  }
});

/* ----------------------------------------------------------------- busy ---- */

// Prevents: a "measuring…" banner that never clears, or a Measure button that
// stays disabled for ever, because busy was set and nothing put it back.
test('INT-CLI-07  busy is true only while a measurement is genuinely in flight', T, async () => {
  const client = makeClient('cli07', { env: { REPLAY_DELAY_MS: '60' } });
  try {
    await client.start();
    assert.strictEqual(client.busy, false, 'idle before anything is asked');

    const measuring = client.measure(H.PROFILE);
    await once(client, 'accepted');
    assert.strictEqual(client.busy, true, 'busy from the moment the service accepted');

    const res = await measuring;
    assert.strictEqual(res.type, 'measurement');
    assert.strictEqual(client.busy, false, 'idle again the instant the measurement resolves');

    const status = await client.status();
    assert.strictEqual(status.busy, false, 'and the service agrees');
    assert.strictEqual(status.runningId, null);
  } finally {
    await client.stop();
  }
});

// Prevents: a double-click on Measure clearing busy. The second request is
// refused with BUSY, and that rejection belongs to a request that never ran —
// clearing the flag on it would report the machine idle while somebody is still
// standing on the scale, and let a third measure through.
test('INT-CLI-08  a BUSY rejection belonging to another request does not clear busy', T, async () => {
  const client = makeClient('cli08', { env: { REPLAY_DELAY_MS: '60' } });
  try {
    await client.start();
    const measuring = client.measure(H.PROFILE);
    await once(client, 'accepted');
    assert.strictEqual(client.busy, true);

    const refused = await rejection(client.measure(H.PROFILE));
    assert.strictEqual(refused.code, 'BUSY');
    assert.strictEqual(refused.message, 'a measurement is already running; cancel it first');
    assert.strictEqual(refused.detail, null);
    assert.strictEqual(client.busy, true,
      'the flag still belongs to the first measure, which is still running');

    const res = await measuring;
    assert.strictEqual(res.measured.weightKg, H.EXPECTED.weightKg,
      'the first measure was undisturbed by the refusal');
    assert.strictEqual(client.busy, false);
  } finally {
    await client.stop();
  }
});

/* --------------------------------------------------------------- errors ---- */

// Prevents: the app showing "Error: [object Object]" or a generic failure. The
// renderer switches on err.code to choose the remedy — turn Bluetooth on, step
// on the scale, grant permission — so the code, the human message and the
// diagnostic detail all have to survive the wrapper.
test('INT-CLI-09  a service failure rejects with a ScaleError carrying code, message and detail', T, async () => {
  const replay = H.fixture('cli09', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'end', reason: 'not-found', detail: 'no advertisement in 8 s' },
  ]);
  const client = makeClient('cli09', { replay });
  try {
    await client.start();
    const err = await rejection(client.measure(H.PROFILE));

    assert.ok(err instanceof ScaleError, 'a ScaleError');
    assert.ok(err instanceof Error, 'and an Error, so `throw` and stack traces behave');
    assert.strictEqual(err.name, 'ScaleError');
    assert.strictEqual(err.code, 'DEVICE_NOT_FOUND');
    assert.ok(H.ALL_ERROR_CODES.includes(err.code), 'the code is one the contract lists');
    assert.strictEqual(err.message, 'no scale answered; its radio sleeps when idle',
      'the message is the human remedy, not the code repeated');
    assert.deepStrictEqual(err.detail, { outcome: 'not-found', framesSeen: 0, spawnError: null },
      'the detail is the diagnostic the log needs');
    assert.ok(typeof err.stack === 'string' && err.stack.includes('ScaleError'), 'it has a stack');
    assert.strictEqual(client.busy, false, 'a failed measure leaves the client idle');
  } finally {
    await client.stop();
  }
});

// Prevents: the crash. An EventEmitter that emits 'error' with no listener
// throws, and this one emits from inside a readline handler, so the throw is an
// uncaught exception that kills the Electron process — on the ordinary path
// where Bluetooth happens to be switched off. The service's failures must
// arrive on a name that is inert when nobody is listening.
test('INT-CLI-10  a service error is emitted as error-event, never as error', T, async () => {
  const replay = H.fixture('cli10', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'end', reason: 'bluetooth-unavailable', detail: 'adapter is off' },
  ]);
  const client = makeClient('cli10', { replay });
  try {
    const seen = [];
    client.on('error-event', (err, envelope) => seen.push({ err, envelope }));
    await client.start();

    // Deliberately no 'error' listener: if the client emitted on that name the
    // throw would escape the readline handler and take this process down.
    assert.strictEqual(client.listenerCount('error'), 0, 'nothing is listening on error');

    const rejected = await rejection(client.measure(H.PROFILE));
    assert.strictEqual(rejected.code, 'BLUETOOTH_UNAVAILABLE');

    assert.strictEqual(seen.length, 1, 'the failure surfaced exactly once, on error-event');
    assert.strictEqual(seen[0].err, rejected,
      'the listener and the rejected promise got the same ScaleError');
    assert.ok(seen[0].err instanceof ScaleError);
    assert.strictEqual(seen[0].envelope.type, 'error', 'the raw envelope came with it');
    assert.strictEqual(seen[0].envelope.id, 'r1', 'addressed to the measure that failed');
    assert.strictEqual(seen[0].envelope.code, rejected.code);
    assert.strictEqual(seen[0].envelope.message, rejected.message);
    assert.deepStrictEqual(seen[0].envelope.detail, rejected.detail);
    assert.strictEqual(client.listenerCount('error'), 0, 'and still nothing on error');
  } finally {
    await client.stop();
  }
});

// Prevents: one bad reading wedging the app until it is restarted. A rejected
// request must be removed from the pending map and must not poison the next
// one, which is the retry the user is about to press.
test('INT-CLI-11  a rejected request leaves the client usable for the next one', T, async () => {
  const client = makeClient('cli11');
  try {
    await client.start();

    const bad = await rejection(client.measure({ age: 900, heightCm: 180, sex: 'male' }));
    assert.strictEqual(bad.code, 'INVALID_PROFILE');
    assert.strictEqual(bad.message, 'age must be a number between 5 and 120');
    assert.strictEqual(bad.detail, null);
    assert.strictEqual(client.busy, false, 'a refused profile never owned the flag');

    const status = await client.status();
    assert.strictEqual(status.type, 'status', 'the pipe still works');
    assert.strictEqual(status.id, 'r2');

    const res = await client.measure(H.PROFILE);
    assert.strictEqual(res.type, 'measurement');
    assert.strictEqual(res.id, 'r3', 'the retry used its own id');
    assert.strictEqual(res.measured.weightKg, H.EXPECTED.weightKg);
  } finally {
    await client.stop();
  }
});

/* --------------------------------------------------------------- cancel ---- */

// Prevents: Cancel resolving the measurement promise, so the app shows a reading
// that was never taken; or leaving busy set, so Measure stays disabled after the
// user backed out.
test('INT-CLI-12  cancel() rejects the pending measure with CANCELLED, clears busy, and a later measure succeeds', T, async () => {
  const client = makeClient('cli12', { env: { REPLAY_DELAY_MS: '80' } });
  try {
    await client.start();
    const measuring = client.measure(H.PROFILE);
    await once(client, 'ready');

    const ack = await client.cancel();
    const err = await rejection(measuring);

    assert.strictEqual(ack.type, 'cancelling', 'cancel() got its own acknowledgement');
    // These are the client's first two requests, in order, so the ids are known.
    assert.strictEqual(ack.cancelling, 'r1', 'the acknowledgement names the measure it stopped');
    assert.strictEqual(ack.id, 'r2', 'and is addressed to the cancel itself');
    assert.ok(err instanceof ScaleError);
    assert.strictEqual(err.code, 'CANCELLED');
    assert.strictEqual(err.message, 'the measurement was cancelled');
    assert.strictEqual(client.busy, false, 'the cancelled measure released the flag');

    const again = await client.measure(H.PROFILE);
    assert.strictEqual(again.type, 'measurement');
    assert.strictEqual(again.id, 'r3', 'the retry is a fresh request');
    assert.strictEqual(again.measured.weightKg, H.EXPECTED.weightKg);
    assert.strictEqual(client.busy, false);
  } finally {
    await client.stop();
  }
});

/* ----------------------------------------------------- stop and restart ---- */

// Prevents: the crash this whole design exists to avoid. If stop() waited for
// 'close' to null the child, `running` would stay true for up to three seconds,
// a caller's guard would pass, and the write would land on an ended stdin —
// which does not throw synchronously, it emits asynchronously and takes the
// Electron process with it.
test('INT-CLI-13  stop() retires the child at once, and a request racing it rejects instead of crashing', T, async () => {
  const client = makeClient('cli13');
  try {
    await client.start();
    assert.strictEqual(client.running, true);

    const stopping = client.stop();
    assert.strictEqual(client.running, false, 'the child is retired synchronously');
    assert.strictEqual(client.hello, null, 'and the stale hello is dropped with it');

    const err = await rejection(client.measure(H.PROFILE));
    assert.ok(err instanceof ScaleError);
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.strictEqual(err.message, 'the scale service is not running; call start() first');

    const alsoRefused = await rejection(client.status());
    assert.strictEqual(alsoRefused.code, 'TRANSPORT_FAILED');

    await stopping;
    assert.strictEqual(client.running, false);

    // The process survived the race, which is the point.
    const hello = await client.start();
    assert.strictEqual(hello.type, 'hello');
  } finally {
    await client.stop();
  }
});

// Prevents: an EPIPE on the child's stdin — an ordinary shutdown race, seen
// every time the app quits mid-measurement — arriving as an uncaught exception.
// A stream 'error' with no listener is exactly that, and in Electron it kills
// the app rather than logging a line.
test('INT-CLI-14  every stdio stream has an error listener, so a broken pipe becomes a log line', T, async () => {
  const client = makeClient('cli14');
  try {
    await client.start();
    const child = client.child;
    const logs = [];
    client.on('log', (line) => { if (line.startsWith('stdio: ')) logs.push(line); });

    for (const name of ['stdin', 'stdout', 'stderr']) {
      const stream = child[name];
      assert.ok(stream, `child.${name} exists`);
      assert.ok(stream.listenerCount('error') >= 1,
        `child.${name} has an 'error' listener, so an EPIPE cannot go unhandled`);
      // The client registers its handler before readline wraps the stream, so
      // it is the first. It is invoked directly rather than emitted: emitting on
      // stdout or stderr would also reach readline's wrapper, which re-raises.
      logs.length = 0;
      stream.listeners('error')[0].call(stream, new Error(`broken-${name}`));
      assert.deepStrictEqual(logs, [`stdio: broken-${name}`],
        `the client's own handler turned the ${name} error into a log line`);
    }

    // stdin is the stream that really takes the EPIPE, so raise a genuine one.
    // If no listener were attached this emit would throw and fail the test.
    logs.length = 0;
    const epipe = new Error('write EPIPE');
    epipe.code = 'EPIPE';
    child.stdin.emit('error', epipe);
    assert.deepStrictEqual(logs, ['stdio: write EPIPE'], 'a real EPIPE was absorbed');

    const status = await client.status();
    assert.strictEqual(status.type, 'status', 'and the client still works afterwards');
  } finally {
    await client.stop();
  }
});

// Prevents: the spinner that outlives the service. If scale.js dies while
// somebody is on the scale — killed by the OS, or crashed — the pending
// measure() must reject so the renderer can say so. Left pending, the app waits
// for a reading from a process that no longer exists.
test('INT-CLI-15  a service that dies mid-measurement rejects the pending request', T, async () => {
  const client = makeClient('cli15', { env: { REPLAY_DELAY_MS: '80' } });
  try {
    await client.start();
    const closes = [];
    client.on('close', (code, wasStopping) => closes.push(wasStopping));

    const measuring = client.measure(H.PROFILE);
    await once(client, 'ready');
    assert.strictEqual(client.busy, true);

    client.child.kill('SIGKILL');
    const err = await rejection(measuring);

    assert.ok(err instanceof ScaleError);
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.match(err.message, /^the scale service exited \(code /,
      'the message says the service went away');
    assert.strictEqual(client.busy, false, 'nothing is in flight any more');
    assert.strictEqual(client.running, false, 'and the client knows the child is gone');
    assert.deepStrictEqual(closes, [false], 'reported as an exit nobody asked for');

    // The retry a user would press next has to be able to work.
    const refused = await rejection(client.status());
    assert.strictEqual(refused.code, 'TRANSPORT_FAILED');
    const hello = await client.start();
    assert.strictEqual(hello.type, 'hello', 'and the client restarts from there');
  } finally {
    await client.stop();
  }
});

// Prevents: "the scale stopped working until I restarted the app". main.js
// stops the service when the last window closes and starts it again when one
// opens. If start() handed back the dead client, every later call would reject
// with TRANSPORT_FAILED for the life of the process.
test('INT-CLI-16  start() after stop() respawns rather than returning a dead client', T, async () => {
  const client = makeClient('cli16');
  try {
    const h1 = await client.start();
    const pid1 = client.child.pid;
    await client.stop();
    assert.strictEqual(client.running, false, 'stopped');
    assert.strictEqual(client.hello, null, 'and the old hello is gone');

    const h2 = await client.start();
    assert.strictEqual(client.running, true, 'running again');
    assert.notStrictEqual(client.child.pid, pid1, 'a genuinely new process');
    assert.strictEqual(h2.type, 'hello');
    assert.notStrictEqual(h2, h1, 'a fresh announcement, not the stale one');

    const res = await client.measure(H.PROFILE);
    assert.strictEqual(res.measured.weightKg, H.EXPECTED.weightKg,
      'the respawned service takes a reading');
  } finally {
    await client.stop();
  }
});

// Prevents: the slow leak that ends in "MaxListenersExceededWarning" and then a
// start() that resolves against a hello from a service two generations old.
// start() settles on one of three paths and each has to remove BOTH listeners;
// dropping either leaks one per open/close of a window.
test('INT-CLI-17  six start/stop cycles leave no hello or _startFailed listeners behind', T, async () => {
  const client = makeClient('cli17');
  try {
    for (let i = 0; i < 6; i++) {
      const hello = await client.start();
      assert.strictEqual(hello.type, 'hello', `cycle ${i + 1} announced itself`);
      await client.stop();
      assert.strictEqual(client.running, false, `cycle ${i + 1} stopped`);
    }
    assert.strictEqual(client.listenerCount('hello'), 0, "no 'hello' listeners survived");
    assert.strictEqual(client.listenerCount('_startFailed'), 0, "no '_startFailed' listeners survived");
    assert.deepStrictEqual(client.eventNames(), [],
      'the emitter is as clean as it was before the first cycle');
  } finally {
    await client.stop();
  }
});

/* -------------------------------------------------------- configuration ---- */

// Prevents: the remembered scale being written into the developer's home
// directory, or into a read-only location inside a packaged app, instead of the
// app's own userData directory. When that silently fails the user pays a full
// Bluetooth scan on every single measurement.
test('INT-CLI-18  the env option reaches the service, so the remembered device lands in the given directory', T, async () => {
  const dir = configDir('cli18');
  const first = new BodyScaleClient({
    scaleDir: H.ROOT, replay: H.FIXTURE, env: { BODYSCALE_CONFIG_DIR: dir },
  });
  try {
    const hello = await first.start();
    assert.strictEqual(hello.device, null, 'the service read the directory we gave it, which is empty');

    const res = await first.measure(H.PROFILE);
    assert.strictEqual(res.device.address, FIXTURE_ADDRESS);

    const saved = readSavedConfig(dir);
    assert.strictEqual(saved[ADDRESS_KEY], FIXTURE_ADDRESS, 'the address was written into our directory');
    assert.strictEqual(saved.name, H.EXPECTED.name);
    assert.strictEqual('profile' in saved, false,
      'the service stored the device and no part of the person');
  } finally {
    await first.stop();
  }

  // A second service pointed at the same directory proves the env round-tripped.
  const second = new BodyScaleClient({
    scaleDir: H.ROOT, replay: H.FIXTURE, env: { BODYSCALE_CONFIG_DIR: dir },
  });
  try {
    const hello = await second.start();
    assert.ok(hello.device, 'the next launch remembered the scale');
    assert.strictEqual(hello.device.address, FIXTURE_ADDRESS);
    assert.strictEqual(hello.device.name, H.EXPECTED.name);
    assert.strictEqual(hello.device.remembered, true);
  } finally {
    await second.stop();
  }
});

// Prevents: the packaged-app failure that is otherwise a silent hang — scale.js
// left inside app.asar, where spawn cannot reach it. The message has to name
// asarUnpack, because that is the only thing the developer can act on.
test('INT-CLI-19  a missing scale.js reports TRANSPORT_FAILED and names asarUnpack', T, async () => {
  const emptyDir = configDir('cli19');
  const client = new BodyScaleClient({
    scaleDir: emptyDir, replay: H.FIXTURE, env: { BODYSCALE_CONFIG_DIR: emptyDir },
  });
  try {
    const err = await rejection(client.start());
    assert.ok(err instanceof ScaleError);
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.ok(err.message.includes(path.join(emptyDir, 'scale.js')),
      `the message names the path it looked at: ${err.message}`);
    assert.ok(err.message.includes('asarUnpack'), 'and the fix');
    assert.strictEqual(client.running, false, 'nothing was spawned');
    assert.strictEqual(client.child, null);
  } finally {
    await client.stop();
  }
});

// Prevents: an IPC handler that calls measure() before start() has resolved
// leaving the renderer's promise pending for ever, which is a spinner nobody
// can dismiss. Rejecting is the only outcome the UI can show.
test('INT-CLI-20  measure() before start() rejects rather than hanging', T, async () => {
  const client = makeClient('cli20');
  try {
    assert.strictEqual(client.running, false);
    const err = await rejection(client.measure(H.PROFILE));
    assert.ok(err instanceof ScaleError);
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.strictEqual(err.message, 'the scale service is not running; call start() first');

    for (const call of [() => client.status(), () => client.forget(), () => client.cancel()]) {
      const e = await rejection(call());
      assert.strictEqual(e.code, 'TRANSPORT_FAILED', 'every command refuses before start()');
    }
    assert.strictEqual(client.busy, false);
  } finally {
    await client.stop();
  }
});

/* -------------------------------------------------- the other commands ---- */

// Prevents: status() resolving with whatever line happened to arrive next —
// a progress event, say — so a "is it busy?" poll returns nonsense and the app
// disables the Measure button at random.
test('INT-CLI-21  status() resolves with the status event', T, async () => {
  const client = makeClient('cli21');
  try {
    const hello = await client.start();
    const status = await client.status();

    assert.strictEqual(status.type, 'status');
    assert.strictEqual(status.proto, PROTOCOL_VERSION);
    assert.strictEqual(status.id, 'r1');
    assert.strictEqual(status.busy, false);
    assert.strictEqual(status.runningId, null);
    assert.strictEqual(status.device, null, 'nothing remembered yet');
    assert.strictEqual(status.platform, process.platform);
    assert.strictEqual(status.version, hello.version, 'the same build that announced itself');
    assert.match(status.version, /^\d+\.\d+\.\d+/);

    await client.measure(H.PROFILE);
    const after = await client.status();
    assert.strictEqual(after.device.address, FIXTURE_ADDRESS,
      'the same call reports the scale once one has been read');
    assert.strictEqual(after.device.name, H.EXPECTED.name);
    assert.strictEqual(after.busy, false);
    assert.strictEqual(after.id, 'r3');
  } finally {
    await client.stop();
  }
});

// Prevents: "Forget this scale" appearing to work while the address is still on
// disk, so the next measurement silently reconnects to the scale the user just
// told the app to forget.
test('INT-CLI-22  forget() resolves with forgotten and drops the remembered address', T, async () => {
  const dir = configDir('cli22');
  const client = new BodyScaleClient({
    scaleDir: H.ROOT, replay: H.FIXTURE, env: { BODYSCALE_CONFIG_DIR: dir },
  });
  try {
    await client.start();
    await client.measure(H.PROFILE);
    assert.strictEqual(readSavedConfig(dir)[ADDRESS_KEY], FIXTURE_ADDRESS, 'remembered first');

    const forgotten = await client.forget();
    assert.strictEqual(forgotten.type, 'forgotten');
    assert.strictEqual(forgotten.proto, PROTOCOL_VERSION);
    assert.strictEqual(forgotten.id, 'r2');

    assert.strictEqual(ADDRESS_KEY in readSavedConfig(dir), false, 'the address is off disk');
    const status = await client.status();
    assert.strictEqual(status.device, null, 'and out of the running service');
  } finally {
    await client.stop();
  }
});

// Prevents: the support call with nothing to go on. stdout is the protocol and
// stderr is the only diagnostic channel, so the wrapper has to hand main.js
// every stderr line — and must never let a protocol envelope leak into that
// stream, which would mean the reading itself had gone missing from stdout.
test('INT-CLI-23  the service stderr reaches the host, and carries no protocol', T, async () => {
  const viaOption = [];
  const viaEvent = [];
  const client = makeClient('cli23', { onLog: (line) => viaOption.push(line) });
  try {
    client.on('log', (line) => viaEvent.push(line));
    await client.start();
    const res = await client.measure(H.PROFILE);
    const option = viaOption.slice();
    const event = viaEvent.filter((l) => !l.startsWith('stdio: '));

    assert.strictEqual(res.measured.weightKg, H.EXPECTED.weightKg,
      'the protocol still came back clean on stdout');
    assert.ok(option.length >= 8, `the service diagnosed itself out loud (${option.length} lines)`);
    assert.deepStrictEqual(option, event,
      'the onLog callback and the log event are the one stderr stream');

    assert.ok(option.some((l) => l.startsWith(`device ${H.EXPECTED.name} at `)),
      'stderr names the device it connected to');
    assert.ok(option.includes('ready — stand on the scale'),
      'and the moment it was ready');
    assert.ok(option.some((l) => l.includes(`${H.EXPECTED.weightKg} kg`)),
      'and the reading it took');

    for (const line of option) {
      assert.strictEqual(line.trim().startsWith('{'), false,
        `no protocol object leaked onto stderr: ${line}`);
    }
  } finally {
    await client.stop();
  }
});

/* ------------------------------------------------------------- shutdown ---- */

// Prevents: app quit throwing. main.js calls stop() from 'window-all-closed'
// and again from 'will-quit', and an app that never started calls it too. None
// of those may reject or hang.
test('INT-CLI-24  stop() is harmless before start() and when called twice', T, async () => {
  const client = makeClient('cli24');
  try {
    await client.stop();
    assert.strictEqual(client.running, false, 'stopping a client that never started is a no-op');

    await client.start();
    assert.strictEqual(client.running, true);

    const [a, b] = await Promise.all([client.stop(), client.stop()]);
    assert.strictEqual(a, undefined, 'stop() resolves with nothing');
    assert.strictEqual(b, undefined);
    assert.strictEqual(client.running, false);

    await client.stop();
    assert.strictEqual(client.running, false, 'still a no-op');

    const hello = await client.start();
    assert.strictEqual(hello.type, 'hello', 'and the client is still startable');
  } finally {
    await client.stop();
  }
});

// Prevents: the app showing "the scale service crashed" every time the user
// quits, or — much worse — staying silent when it really did crash. The second
// argument is the only thing that distinguishes the two.
test('INT-CLI-25  the close event says whether the exit was intentional', T, async () => {
  const crashed = makeClient('cli25a');
  try {
    await crashed.start();
    const seen = [];
    const closed = new Promise((resolve) => crashed.once('close', (code, wasStopping) => {
      seen.push({ code, wasStopping });
      resolve();
    }));
    crashed.child.kill('SIGKILL');            // the service dying on its own
    await closed;

    assert.strictEqual(seen.length, 1, 'close fired once');
    assert.strictEqual(seen[0].wasStopping, false, 'an unasked-for exit is reported as such');
    assert.strictEqual(crashed.running, false, 'and the client knows the child is gone');
    assert.strictEqual(crashed.hello, null);
    assert.strictEqual(crashed.busy, false);
  } finally {
    await crashed.stop();
  }

  const quit = makeClient('cli25b');
  try {
    await quit.start();
    const seen = [];
    quit.on('close', (code, wasStopping) => seen.push({ code, wasStopping }));
    await quit.stop();

    assert.strictEqual(seen.length, 1, 'close fired once');
    assert.strictEqual(seen[0].wasStopping, true, 'we asked for this one');
    assert.strictEqual(seen[0].code, 0, 'and the service exited cleanly');
  } finally {
    await quit.stop();
  }
});

// Prevents: "An object could not be cloned" on the IPC boundary. main.js returns
// the envelope straight out of an ipcMain.handle, and Electron puts it through
// the structured clone algorithm. Anything non-plain the wrapper attached —
// a class instance, a function, an undefined — throws there, not here, and the
// renderer just sees a rejected invoke with no reading.
test('INT-CLI-26  the measurement survives structuredClone, which is what IPC does to it', T, async () => {
  const client = makeClient('cli26');
  try {
    await client.start();
    const progress = [];
    client.on('progress', (p) => progress.push(p));
    const res = await client.measure(H.PROFILE);

    const clone = structuredClone(res);
    assert.deepStrictEqual(clone, res, 'nothing was lost or changed in transit');
    assert.strictEqual(clone.measured.weightKg, H.EXPECTED.weightKg);
    assert.strictEqual(clone.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
    assert.strictEqual(Object.keys(clone.derived).length, 24);
    assert.strictEqual(clone.trust.impedanceDerived, res.trust.impedanceDerived);
    assert.strictEqual(Object.getPrototypeOf(res), Object.prototype,
      'the envelope is a plain object, not a class instance');

    // The progress events cross the same boundary, one per live update.
    assert.ok(progress.length >= 3, `progress was streamed (${progress.length} events)`);
    for (const p of progress) {
      assert.deepStrictEqual(structuredClone(p), p,
        `the ${p.phase} progress event survives the boundary too`);
    }
  } finally {
    await client.stop();
  }
});
