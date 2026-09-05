'use strict';
/**
 * INT-ERR — every error code, provoked deliberately.
 *
 * The Electron app has exactly one way to tell a user what went wrong: the
 * `error` event. If a code is wrong, the app shows the wrong remedy; if a
 * message is wrong, the user is sent to the wrong Settings page; if an error
 * kills the service, the app is dead until it is restarted. So every code the
 * service advertises is provoked here through the real process and the real
 * pipe, with the radio replaced by a fixture.
 *
 * Ten of the eleven codes are reachable with no hardware. INTERNAL is not — see
 * INT-ERR-18 for what the code actually does with an unclassified failure.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('./harness');

/* ---------- shared, read-only helpers ---------- */

/**
 * Every error must be a well-formed envelope whose code the host was told about
 * in `hello`. Checked on every error this file provokes, not just in the one
 * test that is about envelopes, because a malformed envelope anywhere is a
 * crash in the host's parser.
 */
function assertErrorEnvelope(ev, hello, where) {
  assert.strictEqual(ev.type, 'error', `${where}: is an error event`);
  assert.strictEqual(ev.proto, 1, `${where}: proto is 1`);
  assert.ok('id' in ev, `${where}: carries an id field`);
  assert.ok('detail' in ev, `${where}: carries a detail field`);
  assert.strictEqual(typeof ev.code, 'string', `${where}: code is a string`);
  assert.strictEqual(typeof ev.message, 'string', `${where}: message is a string`);
  assert.ok(ev.message.length > 0, `${where}: message is not empty`);
  assert.notStrictEqual(ev.message, ev.code, `${where}: message is prose, not the code repeated`);
  assert.ok(ev.detail === null || (typeof ev.detail === 'object' && !Array.isArray(ev.detail)),
    `${where}: detail is an object or null, got ${JSON.stringify(ev.detail)}`);
  assert.ok(hello.errorCodes.includes(ev.code),
    `${where}: code ${ev.code} is one of the codes hello advertised`);
}

/** A replay that keeps the transport alive far longer than any test needs. */
function stallingFixture(tag) {
  const events = [
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'ready' },
  ];
  for (let i = 0; i < 300; i++) events.push({ t: 'log', level: 'info', msg: `waiting ${i}` });
  events.push({ t: 'end', reason: 'finished' });
  return H.fixture(tag, events);
}

/**
 * A stand-in for `python` on PATH. Used only to make the transport self-test
 * fail; because it fails, ble.py is never spawned and no radio is touched.
 */
function fakeInterpreter(tag, sh, cmd) {
  const isWin = process.platform === 'win32';
  const file = path.join(H.tmpdir(tag), isWin ? 'python.cmd' : 'python');
  fs.writeFileSync(file, isWin ? cmd : sh);
  if (!isWin) fs.chmodSync(file, 0o755);
  return file;
}

/**
 * Ask for one measurement over a given fixture, then ask for status, so every
 * transport-driven error test also proves the service answered afterwards.
 */
function measureThenStatus({ replay, args = [], env = {} }) {
  return H.serve({
    replay,
    args,
    env,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'error' && ev.id === 'M1') { send({ id: 'S1', cmd: 'status' }); return false; }
      return ev.type === 'status' && ev.id === 'S1';
    },
  }).then((r) => ({
    hello: H.first(r.events, 'hello'),
    error: r.events.find((e) => e.type === 'error' && e.id === 'M1'),
    status: r.events.find((e) => e.type === 'status' && e.id === 'S1'),
    events: r.events,
    stderr: r.stderr,
    code: r.code,
  }));
}

/* ---------- BAD_REQUEST ---------- */

// Prevents: an Electron main process that writes a truncated or double-encoded
// line — easy to do with a stray string concat — killing the service instead of
// getting an error back, which would leave the app unable to measure at all.
test('INT-ERR-01  a line that is not JSON is answered with BAD_REQUEST and the service keeps running', async () => {
  const r = await H.serve({
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw('}{ this is not JSON at all');
        send({ id: 'S1', cmd: 'status' });
        return false;
      }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const errors = H.byType(r.events, 'error');
  assert.strictEqual(errors.length, 1, 'exactly one error for one bad line');
  assertErrorEnvelope(errors[0], hello, 'non-JSON');
  assert.strictEqual(errors[0].code, 'BAD_REQUEST');
  assert.strictEqual(errors[0].message, 'not valid JSON');
  assert.strictEqual(errors[0].detail, null);
  // There is no id to echo: the line could not be parsed far enough to find one.
  assert.strictEqual(errors[0].id, null, 'an unparseable line reports a null id');

  const status = r.events.find((e) => e.type === 'status' && e.id === 'S1');
  assert.ok(status, 'the service answered the next command');
  assert.strictEqual(status.busy, false);
});

// Prevents: a host that sends a batch of commands as a JSON array being told
// nothing useful, or worse being silently ignored while the user waits at the
// scale for a measurement that was never started.
test('INT-ERR-02  a JSON array is rejected as BAD_REQUEST, not treated as a command', async () => {
  const r = await H.serve({
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw(JSON.stringify([{ id: 'A', cmd: 'measure', profile: H.PROFILE }]));
        send({ id: 'S1', cmd: 'status' });
        return false;
      }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const errors = H.byType(r.events, 'error');
  assert.strictEqual(errors.length, 1);
  assertErrorEnvelope(errors[0], hello, 'array');
  assert.strictEqual(errors[0].code, 'BAD_REQUEST');
  assert.strictEqual(errors[0].message, 'expected a JSON object');
  assert.strictEqual(errors[0].id, null);

  // The array wrapped a valid measure. It must NOT have been unwrapped and run.
  assert.strictEqual(H.byType(r.events, 'accepted').length, 0, 'nothing was accepted');
  assert.strictEqual(H.byType(r.events, 'measurement').length, 0, 'nothing was measured');
  const status = r.events.find((e) => e.type === 'status' && e.id === 'S1');
  assert.strictEqual(status.busy, false, 'no measurement was started by the array');
});

// Prevents: a bare number, string or `null` arriving on stdin (a logging line
// leaking into the command channel, say) being coerced into a command object
// and dispatched, or throwing inside the line handler and taking the pipe down.
test('INT-ERR-03  JSON scalars are rejected as BAD_REQUEST, one error each', async () => {
  const scalars = ['42', '"measure"', 'true', 'null'];
  const r = await H.serve({
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        scalars.forEach((s) => raw(s));
        send({ id: 'S1', cmd: 'status' });
        return false;
      }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const errors = H.byType(r.events, 'error');
  assert.strictEqual(errors.length, scalars.length, 'one error per scalar, none swallowed');
  errors.forEach((e, i) => {
    assertErrorEnvelope(e, hello, `scalar ${scalars[i]}`);
    assert.strictEqual(e.code, 'BAD_REQUEST', `${scalars[i]} is BAD_REQUEST`);
    assert.strictEqual(e.message, 'expected a JSON object', `${scalars[i]} says what was expected`);
    assert.strictEqual(e.id, null);
  });
  assert.ok(r.events.find((e) => e.type === 'status' && e.id === 'S1'), 'service still answering');
});

// Prevents: a Cancel button that is pressed after the measurement already
// finished leaving the host waiting for ever for a reply that never comes.
test('INT-ERR-04  cancel with nothing running is BAD_REQUEST and echoes the request id', async () => {
  const r = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'CANCEL-1', cmd: 'cancel' }); return false; }
      return ev.type === 'error' && ev.id === 'CANCEL-1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const err = r.events.find((e) => e.type === 'error');
  assertErrorEnvelope(err, hello, 'idle cancel');
  assert.strictEqual(err.code, 'BAD_REQUEST');
  assert.strictEqual(err.message, 'nothing is running');
  assert.strictEqual(err.id, 'CANCEL-1', 'the reply is correlatable with the request');
  assert.strictEqual(err.detail, null);
  // A cancel that found nothing must not manufacture a cancelling event, or the
  // host would settle a request twice.
  assert.strictEqual(H.byType(r.events, 'cancelling').length, 0);
});

/* ---------- UNKNOWN_COMMAND ---------- */

// Prevents: a typo or a newer host asking for a command this build does not have
// and getting silence. The message names the command so the mismatch is obvious
// in a bug report instead of looking like a hung scale.
test('INT-ERR-05  an unrecognised cmd is UNKNOWN_COMMAND and the message names it', async () => {
  const r = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'U1', cmd: 'calibrate' }); return false; }
      return ev.type === 'error' && ev.id === 'U1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const err = r.events.find((e) => e.type === 'error');
  assertErrorEnvelope(err, hello, 'unknown cmd');
  assert.strictEqual(err.code, 'UNKNOWN_COMMAND');
  assert.strictEqual(err.message, 'no such command: calibrate');
  assert.strictEqual(err.id, 'U1');
  // hello is the host's contract; a command it does not list must be refused.
  assert.strictEqual(hello.commands.includes('calibrate'), false);
  assert.deepStrictEqual(hello.commands, ['measure', 'compute', 'cancel', 'status', 'forget', 'shutdown']);
});

// Prevents: a request object built without its `cmd` field (a destructuring
// slip in the IPC layer) being dispatched to whatever the default happens to be.
test('INT-ERR-06  a request with no cmd at all is UNKNOWN_COMMAND, not a default action', async () => {
  const r = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 42, profile: H.PROFILE }); return false; }
      return ev.type === 'error' && ev.id === 42;
    },
  });

  const hello = H.first(r.events, 'hello');
  const err = r.events.find((e) => e.type === 'error');
  assertErrorEnvelope(err, hello, 'missing cmd');
  assert.strictEqual(err.code, 'UNKNOWN_COMMAND');
  assert.strictEqual(err.message, 'no such command: undefined');
  assert.strictEqual(err.id, 42, 'a numeric id round-trips as a number');
  // A profile rode along with the request; it must not have started anything.
  assert.strictEqual(H.byType(r.events, 'accepted').length, 0);
});

/* ---------- INVALID_PROFILE ---------- */

// Prevents: the app shipping an empty or nonsense profile form straight through
// to the maths, which would produce a confident-looking body-fat number derived
// from an age of zero. The message must say which field is wrong so the app can
// point at the right input.
test('INT-ERR-07  each way of getting the profile wrong is INVALID_PROFILE, naming the field', async () => {
  const cases = [
    { id: 'no-profile', req: {}, message: 'profile is required' },
    { id: 'profile-null', req: { profile: null }, message: 'profile is required' },
    { id: 'profile-string', req: { profile: 'male,39,180' }, message: 'profile is required' },
    { id: 'age-missing', req: { profile: { heightCm: 180, sex: 'male' } }, message: 'age must be a number between 5 and 120' },
    { id: 'age-too-low', req: { profile: { age: 4, heightCm: 180, sex: 'male' } }, message: 'age must be a number between 5 and 120' },
    { id: 'age-too-high', req: { profile: { age: 121, heightCm: 180, sex: 'male' } }, message: 'age must be a number between 5 and 120' },
    { id: 'height-missing', req: { profile: { age: 39, sex: 'male' } }, message: 'heightCm must be a number between 90 and 250' },
    { id: 'height-too-low', req: { profile: { age: 39, heightCm: 89, sex: 'male' } }, message: 'heightCm must be a number between 90 and 250' },
    { id: 'height-too-high', req: { profile: { age: 39, heightCm: 251, sex: 'male' } }, message: 'heightCm must be a number between 90 and 250' },
    { id: 'sex-nonsense', req: { profile: { age: 39, heightCm: 180, sex: 'wombat' } }, message: "sex must be 'male' or 'female'" },
  ];

  const r = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        cases.forEach((c) => send(Object.assign({ id: c.id, cmd: 'measure' }, c.req)));
        send({ id: 'S1', cmd: 'status' });
        return false;
      }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const errors = H.byType(r.events, 'error');
  assert.strictEqual(errors.length, cases.length, 'one rejection per bad profile');
  cases.forEach((c, i) => {
    assertErrorEnvelope(errors[i], hello, c.id);
    assert.strictEqual(errors[i].id, c.id, `${c.id}: id echoed`);
    assert.strictEqual(errors[i].code, 'INVALID_PROFILE', `${c.id}: code`);
    assert.strictEqual(errors[i].message, c.message, `${c.id}: message names the field`);
  });
  // Nothing was accepted, so no transport was started for any of them.
  assert.strictEqual(H.byType(r.events, 'accepted').length, 0);
  const status = r.events.find((e) => e.type === 'status' && e.id === 'S1');
  assert.strictEqual(status.busy, false, 'the service is idle and still answering');
});

// Prevents: a host that sends a broken profile during a run being told BUSY,
// then retrying the same broken profile for ever once the run ends. The profile
// is the caller's mistake and must be reported as such, whatever else is going on.
test('INT-ERR-08  a bad profile sent during a run reports INVALID_PROFILE, not BUSY', async () => {
  const r = await H.serve({
    replay: stallingFixture('err08'),
    env: { REPLAY_DELAY_MS: '80' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'RUN', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'RUN') {
        send({ id: 'BAD', cmd: 'measure', profile: { age: 2, heightCm: 180, sex: 'male' } });
        return false;
      }
      return ev.type === 'error' && ev.id === 'BAD';
    },
  });

  const hello = H.first(r.events, 'hello');
  const err = r.events.find((e) => e.type === 'error' && e.id === 'BAD');
  assertErrorEnvelope(err, hello, 'bad profile while busy');
  assert.strictEqual(err.code, 'INVALID_PROFILE');
  assert.strictEqual(err.message, 'age must be a number between 5 and 120');
  assert.notStrictEqual(err.code, 'BUSY', 'the caller must learn the profile is wrong');
});

/* ---------- BUSY ---------- */

// Prevents: two measurements fighting over one radio because the user
// double-clicked Measure. The second must be refused, and — the part that
// actually matters — the first must be untouched and still deliver its reading.
test('INT-ERR-09  a second measure during a run is BUSY, and the first still completes', async () => {
  const r = await H.serve({
    env: { REPLAY_DELAY_MS: '150' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'FIRST', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'FIRST') {
        send({ id: 'SECOND', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'FIRST';
    },
  });

  const hello = H.first(r.events, 'hello');
  const err = r.events.find((e) => e.type === 'error' && e.id === 'SECOND');
  assert.ok(err, 'the second measure was answered');
  assertErrorEnvelope(err, hello, 'busy');
  assert.strictEqual(err.code, 'BUSY');
  assert.strictEqual(err.message, 'a measurement is already running; cancel it first');
  assert.strictEqual(err.detail, null);

  // Only one run was ever accepted, and it produced the real reading.
  assert.deepStrictEqual(H.byType(r.events, 'accepted').map((e) => e.id), ['FIRST']);
  const m = r.events.find((e) => e.type === 'measurement' && e.id === 'FIRST');
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(m.measured.impedanceOhm, H.EXPECTED.impedanceOhm);

  // The BUSY refusal must arrive before the measurement it was refused for.
  const codes = r.events.map((e) => e.type);
  assert.ok(codes.indexOf('error') < codes.indexOf('measurement'),
    'the refusal is immediate, not deferred until the run ends');
});

/* ---------- transport-driven codes ---------- */

// Prevents: "no scale answered" being reported as a reading failure. The scale's
// radio sleeps, so the remedy is to step on it — a different instruction from
// the one NO_READING gives, and the app picks the wording from this code.
test('INT-ERR-10  a transport that reports not-found produces DEVICE_NOT_FOUND', async () => {
  const replay = H.fixture('err10', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'end', reason: 'not-found' },
  ]);
  const r = await measureThenStatus({ replay });

  assertErrorEnvelope(r.error, r.hello, 'not-found');
  assert.strictEqual(r.error.code, 'DEVICE_NOT_FOUND');
  assert.strictEqual(r.error.message, 'no scale answered; its radio sleeps when idle');
  assert.strictEqual(r.error.id, 'M1');
  assert.deepStrictEqual(r.error.detail, { outcome: 'not-found', framesSeen: 0, spawnError: null });
  assert.ok(r.status, 'the service answered a command after the failure');
  assert.strictEqual(r.status.busy, false, 'the failed run was cleared, so the next measure can start');
});

// Prevents: the user standing on a scale that connected but sent nothing being
// told the scale could not be found, and hunting for a pairing problem that
// does not exist.
test('INT-ERR-11  a connection that delivered no frames produces NO_READING', async () => {
  const replay = H.fixture('err11', [
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'services', items: [{ service: '0000ffb0-0000-1000-8000-00805f9b34fb', char: '0000ffb2-0000-1000-8000-00805f9b34fb', props: ['notify'] }] },
    { t: 'ready' },
    { t: 'end', reason: 'finished' },
  ]);
  const r = await measureThenStatus({ replay });

  assertErrorEnvelope(r.error, r.hello, 'no frames');
  assert.strictEqual(r.error.code, 'NO_READING');
  assert.strictEqual(r.error.message, 'connected but no reading arrived');
  assert.deepStrictEqual(r.error.detail, { outcome: 'no-reading', framesSeen: 0, spawnError: null });
  // The device WAS reached, so this is not a discovery failure.
  assert.notStrictEqual(r.error.code, 'DEVICE_NOT_FOUND');
  assert.ok(r.events.find((e) => e.type === 'progress' && e.phase === 'connected'),
    'the host was told a connection happened before it failed');
  assert.ok(r.status, 'still answering');
});

// Prevents: the single worst wrong turn in this app — a switched-off Bluetooth
// adapter sending the user into Privacy & security to grant a permission they
// already have. The remedy is the Bluetooth toggle, and the message must say so
// without mentioning privacy or app permissions.
test('INT-ERR-12  bluetooth-unavailable produces BLUETOOTH_UNAVAILABLE and never points at a privacy setting', async () => {
  const replay = H.fixture('err12', [
    { t: 'end', reason: 'bluetooth-unavailable', detail: 'BleakError: Bluetooth device is turned off' },
  ]);
  const r = await measureThenStatus({ replay });

  assertErrorEnvelope(r.error, r.hello, 'bluetooth off');
  assert.strictEqual(r.error.code, 'BLUETOOTH_UNAVAILABLE');
  assert.deepStrictEqual(r.error.detail,
    { outcome: 'bluetooth-unavailable', framesSeen: 0, spawnError: null });

  const msg = r.error.message;
  assert.match(msg, /bluetooth/i, 'names Bluetooth');
  assert.match(msg, /switched off|no adapter/i, 'names the actual condition');
  assert.doesNotMatch(msg, /privacy/i, 'must not send the user to a privacy setting');
  assert.doesNotMatch(msg, /desktop apps/i, 'must not talk about app permissions');
  assert.doesNotMatch(msg, /refused/i, 'this is not a permission refusal');
  assert.doesNotMatch(msg, /stand on|step on|bare feet/i, 'the scale is not the problem');
  assert.ok(r.status, 'still answering');
});

// Prevents: an OS permission refusal being reported as "stand on the scale".
// The user would stand there for ever: nothing was ever allowed to scan.
test('INT-ERR-13  permission-denied produces PERMISSION_DENIED and never tells the user to stand on the scale', async () => {
  const replay = H.fixture('err13', [
    { t: 'end', reason: 'permission-denied', detail: 'BleakError: access denied' },
  ]);
  const r = await measureThenStatus({ replay });

  assertErrorEnvelope(r.error, r.hello, 'permission denied');
  assert.strictEqual(r.error.code, 'PERMISSION_DENIED');
  assert.deepStrictEqual(r.error.detail,
    { outcome: 'tcc-denied', framesSeen: 0, spawnError: null });

  const msg = r.error.message;
  assert.doesNotMatch(msg, /stand on|step on|bare feet|metal pads/i,
    'must not blame the person or the scale');
  assert.doesNotMatch(msg, /switched off/i,
    'must not send the user to the Bluetooth toggle; Bluetooth is on and refused');
  assert.match(msg, /refused|turn on/i, 'names the refusal or its remedy');
  assert.match(msg, /bluetooth/i, 'names what was refused');
  assert.ok(r.status, 'still answering');
});

// Prevents: a machine with no Python reporting "no reading arrived", which sends
// the user to the scale when the real fix is to run the installer. Nothing was
// ever spawned, so nothing could have read anything.
test('INT-ERR-14  an interpreter that does not exist produces TRANSPORT_FAILED, not NO_READING', async () => {
  const missing = path.join(H.tmpdir('err14'), 'definitely-not-python');
  // replay: null takes the real transport path. The self-test fails before
  // ble.py is spawned, so no Bluetooth is touched.
  const r = await measureThenStatus({ replay: null, args: ['--python', missing] });

  assertErrorEnvelope(r.error, r.hello, 'missing interpreter');
  assert.strictEqual(r.error.code, 'TRANSPORT_FAILED');
  assert.notStrictEqual(r.error.code, 'NO_READING', 'the scale was never contacted');
  assert.match(r.error.message, /ENOENT/, 'says the executable was not found');
  assert.ok(r.error.message.includes(missing), 'names the interpreter it tried');
  assert.strictEqual(r.error.detail.outcome, 'spawn-failed');
  assert.strictEqual(r.error.detail.framesSeen, 0);
  assert.strictEqual(r.error.detail.spawnError, r.error.message,
    'detail.spawnError carries the same explanation as the message');
  assert.ok(r.status, 'still answering');
});

// Prevents: the Windows failure this whole self-test exists for. `python.exe`
// resolves to the Microsoft Store App Execution Alias on a machine with no
// Python, so the spawn succeeds and ENOENT never fires. Without this check the
// user is told to stand on a scale that was never contacted.
test('INT-ERR-15  the Microsoft Store alias placeholder produces TRANSPORT_FAILED naming the placeholder', async () => {
  const alias = fakeInterpreter('err15',
    '#!/bin/sh\n'
    + 'echo "Python was not found; run without arguments to install from the Microsoft Store, '
    + 'or disable this shortcut from Settings > Manage App Execution Aliases."\n'
    + 'exit 9009\n',
    '@echo off\r\n'
    + 'echo Python was not found; run without arguments to install from the Microsoft Store.\r\n'
    + 'exit /b 9009\r\n');
  const r = await measureThenStatus({ replay: null, args: ['--python', alias] });

  assertErrorEnvelope(r.error, r.hello, 'store alias');
  assert.strictEqual(r.error.code, 'TRANSPORT_FAILED');
  assert.notStrictEqual(r.error.code, 'NO_READING', 'the alias printed a message; it did not measure');
  const msg = r.error.message;
  assert.match(msg, /Microsoft Store placeholder/, 'says what the executable actually is');
  assert.ok(msg.includes(alias), 'names the executable');
  assert.match(msg, /python\.org/, 'offers a real remedy');
  assert.match(msg, /BODYSCALE_PYTHON/, 'offers the override');
  assert.doesNotMatch(msg, /stand on|step on|bare feet/i, 'must not send the user to the scale');
  assert.strictEqual(r.error.detail.outcome, 'spawn-failed');
  // stderr is the host's diagnostic channel and must carry the same explanation.
  assert.match(r.stderr, /Microsoft Store placeholder/);
  assert.ok(r.status, 'still answering');
});

// Prevents: a Python that runs but has no bleak (a half-finished setup, or a
// venv copied between machines) being reported as a scale problem. The remedy
// is the setup script, and the message has to say which one.
test('INT-ERR-16  an interpreter that runs but cannot import bleak produces TRANSPORT_FAILED with the reason', async () => {
  const broken = fakeInterpreter('err16',
    '#!/bin/sh\necho \'{"t":"selftest","ok":false,"error":"No module named bleak"}\' >&2\nexit 3\n',
    '@echo off\r\necho {"t":"selftest","ok":false,"error":"No module named bleak"} 1>&2\r\nexit /b 3\r\n');
  const r = await measureThenStatus({ replay: null, args: ['--python', broken] });

  assertErrorEnvelope(r.error, r.hello, 'bleak missing');
  assert.strictEqual(r.error.code, 'TRANSPORT_FAILED');
  assert.match(r.error.message, /the Bluetooth helper cannot run/);
  assert.match(r.error.message, /No module named bleak/, 'quotes the interpreter\'s own reason');
  assert.match(r.error.message, /setup-mac\.sh|setup-win\.ps1/, 'names the fix');
  assert.strictEqual(r.error.detail.outcome, 'spawn-failed');
  assert.ok(r.status, 'still answering');
});

/* ---------- CANCELLED ---------- */

// Prevents: a Cancel button that leaves the measure request unsettled, so the
// app's spinner never stops; and the opposite mistake of settling the cancel
// request with the measurement's own error, which would leave the host
// correlating two replies to one id.
test('INT-ERR-17  cancel settles the cancel with cancelling and the measurement with CANCELLED', async () => {
  const r = await H.serve({
    replay: stallingFixture('err17'),
    env: { REPLAY_DELAY_MS: '80' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'RUN', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'RUN') { send({ id: 'STOP', cmd: 'cancel' }); return false; }
      if (ev.type === 'error' && ev.id === 'RUN') { send({ id: 'S1', cmd: 'status' }); return false; }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');

  const cancelling = r.events.find((e) => e.type === 'cancelling');
  assert.ok(cancelling, 'the cancel request got its own terminal event');
  assert.strictEqual(cancelling.proto, 1);
  assert.strictEqual(cancelling.id, 'STOP', 'settled against the cancel request');
  assert.strictEqual(cancelling.cancelling, 'RUN', 'names the run it is stopping');

  const err = r.events.find((e) => e.type === 'error');
  assertErrorEnvelope(err, hello, 'cancelled run');
  assert.strictEqual(err.code, 'CANCELLED');
  assert.strictEqual(err.message, 'the measurement was cancelled');
  assert.strictEqual(err.id, 'RUN', 'the measurement, not the cancel, is what failed');
  assert.strictEqual(err.detail, null);

  // Exactly one terminal per request, and no measurement was emitted.
  assert.strictEqual(H.byType(r.events, 'error').length, 1);
  assert.strictEqual(H.byType(r.events, 'cancelling').length, 1);
  assert.strictEqual(H.byType(r.events, 'measurement').length, 0);

  const status = r.events.find((e) => e.type === 'status' && e.id === 'S1');
  assert.strictEqual(status.busy, false, 'the radio was released, so the user can retry immediately');
  assert.strictEqual(status.runningId, null);
});

/* ---------- INTERNAL, and the codes hello promises ---------- */

/*
 * INTERNAL cannot be provoked from outside the process.
 *
 * measureOnce() always resolves, never rejects, so the `catch` that raises
 * INTERNAL in doMeasure is unreachable; and every outcome it can resolve with
 * ('ok', 'not-found', 'tcc-denied', 'bluetooth-unavailable', 'no-reading',
 * 'spawn-failed') has an entry in OUTCOME_TO_ERROR, so the `|| 'INTERNAL'`
 * fallback is unreachable too. OUTCOME_TO_ERROR also maps an outcome named
 * 'error' to INTERNAL, but nothing ever produces that outcome: the transport's
 * own `end reason:"error"` is classified as 'no-reading' by measureOnce.
 * Provoking INTERNAL would need fault injection inside the process, which is
 * not an integration test. What IS worth pinning down is that the transport's
 * unclassified failure does NOT surface as "unexpected failure".
 */

// Prevents: a transport that failed for a reason nobody anticipated (bleak
// raising something new, say) reaching the user as "unexpected failure", which
// tells them nothing they can act on.
test('INT-ERR-18  an unclassified transport failure is reported as NO_READING, never INTERNAL', async () => {
  const replay = H.fixture('err18', [
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'ready' },
    { t: 'end', reason: 'error', detail: 'RuntimeError: something nobody predicted' },
  ]);
  const r = await measureThenStatus({ replay });

  assertErrorEnvelope(r.error, r.hello, 'unclassified end');
  assert.strictEqual(r.error.code, 'NO_READING');
  assert.notStrictEqual(r.error.code, 'INTERNAL', 'the user gets an actionable code');
  assert.strictEqual(r.error.message, 'connected but no reading arrived');
  assert.deepStrictEqual(r.error.detail, { outcome: 'no-reading', framesSeen: 0, spawnError: null });
  // INTERNAL is still advertised, so a host that switches on it stays valid.
  assert.ok(r.hello.errorCodes.includes('INTERNAL'));
  assert.ok(r.status, 'still answering');
});

// Prevents: the host writing a switch over error codes against a list that has
// drifted from what the service can actually send, so a real failure falls
// through to a generic "something went wrong" dialog.
test('INT-ERR-19  hello advertises exactly the eleven error codes, each once', async () => {
  const r = await H.serve({ onEvent: (ev) => ev.type === 'hello' });
  const hello = H.first(r.events, 'hello');

  assert.deepStrictEqual(hello.errorCodes, H.ALL_ERROR_CODES,
    'the advertised codes are exactly the documented eleven, in order');
  assert.strictEqual(new Set(hello.errorCodes).size, 11, 'no duplicates');
  hello.errorCodes.forEach((c) => {
    assert.strictEqual(typeof c, 'string');
    assert.match(c, /^[A-Z_]+$/, `${c} is a stable machine-readable code`);
  });
});

// Prevents: one error type arriving in a different shape from the rest — a
// missing `detail`, an absent `id`, a numeric code — which breaks the single
// place the host parses errors and turns a handled failure into a crash.
test('INT-ERR-20  every error, whatever its code, has the same envelope and echoes its id', async () => {
  // Six codes, four id types, one process.
  const sent = [
    { id: 'str-id', cmd: 'cancel', want: 'BAD_REQUEST' },
    { id: 99, cmd: 'nonsense', want: 'UNKNOWN_COMMAND' },
    { id: 'p', cmd: 'measure', profile: { age: 0, heightCm: 180 }, want: 'INVALID_PROFILE' },
    { id: null, cmd: 'also-nonsense', want: 'UNKNOWN_COMMAND' },
    { id: 'trailing', cmd: 'measure', want: 'INVALID_PROFILE' },
  ];

  const r = await H.serve({
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw('not json');                       // id-less: nothing to echo
        sent.forEach((s) => {
          const req = { id: s.id, cmd: s.cmd };
          if (s.profile) req.profile = s.profile;
          send(req);
        });
        send({ id: 'S1', cmd: 'status' });
        return false;
      }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const errors = H.byType(r.events, 'error');
  assert.strictEqual(errors.length, sent.length + 1, 'every bad request was answered exactly once');

  errors.forEach((e, i) => {
    assertErrorEnvelope(e, hello, `error ${i}`);
    H.assertShape(assert, e, {
      proto: 'number', type: 'string', code: 'string', message: 'string', detail: 'object?',
    }, `error ${i}`);
  });

  // The unparseable line reports null; every parsed request echoes its own id
  // with its own JSON type preserved.
  assert.strictEqual(errors[0].id, null, 'no id could be recovered from a non-JSON line');
  sent.forEach((s, i) => {
    const e = errors[i + 1];
    assert.strictEqual(e.id, s.id, `request ${i}: id echoed unchanged`);
    assert.strictEqual(e.code, s.want, `request ${i}: expected code`);
  });

  const codes = new Set(errors.map((e) => e.code));
  assert.deepStrictEqual([...codes].sort(),
    ['BAD_REQUEST', 'INVALID_PROFILE', 'UNKNOWN_COMMAND']);
});

// Prevents: the failure mode that would make every other error test moot — an
// error leaving the service dead, so the app looks fine until the user presses
// Measure and nothing ever happens again. Errors are answers, not endings.
test('INT-ERR-21  no error terminates the service: a barrage of failures, then a real measurement', async () => {
  const r = await H.serve({
    env: { REPLAY_DELAY_MS: '10' },
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw('}{');                                                    // BAD_REQUEST
        raw('[{"cmd":"measure"}]');                                   // BAD_REQUEST
        raw('7');                                                     // BAD_REQUEST
        raw('"cmd"');                                                 // BAD_REQUEST
        raw('null');                                                  // BAD_REQUEST
        send({ id: 'c', cmd: 'cancel' });                             // BAD_REQUEST
        send({ id: 'u', cmd: 'reboot' });                             // UNKNOWN_COMMAND
        send({ id: 'n' });                                            // UNKNOWN_COMMAND
        send({ id: 'p1', cmd: 'measure' });                           // INVALID_PROFILE
        send({ id: 'p2', cmd: 'measure', profile: { age: 39 } });     // INVALID_PROFILE
        send({ id: 'GO', cmd: 'measure', profile: H.PROFILE });       // must still work
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'GO';
    },
  });

  const hello = H.first(r.events, 'hello');
  const errors = H.byType(r.events, 'error');
  assert.strictEqual(errors.length, 10, 'ten failures, ten answers, none fatal');
  errors.forEach((e, i) => assertErrorEnvelope(e, hello, `barrage ${i}`));
  assert.deepStrictEqual(errors.map((e) => e.code), [
    'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST',
    'UNKNOWN_COMMAND', 'UNKNOWN_COMMAND', 'INVALID_PROFILE', 'INVALID_PROFILE',
  ]);

  const m = r.events.find((e) => e.type === 'measurement' && e.id === 'GO');
  assert.ok(m, 'the service measured normally after ten errors');
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.proto, 1);
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(m.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(Object.keys(m.derived).length, 24, 'a full result, not a degraded one');

  // And it shut down cleanly rather than having limped along in a broken state.
  assert.strictEqual(r.code, 0, 'the process exited 0');
  assert.ok(H.first(r.events, 'bye'), 'shutdown was acknowledged');
});
