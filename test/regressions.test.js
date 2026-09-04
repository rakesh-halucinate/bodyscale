'use strict';
// Regressions found by adversarial review of the Electron/Windows integration.
//
// Each test names the failure it prevents, because several of them look like
// trivia until you know what they cost: a user told to stand on a scale that
// will never respond, a service whose only diagnostic channel is dead, or a
// packaged app that silently forgets its scale on every launch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const SCALE = path.join(ROOT, 'scale.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');
const PROFILE = { age: 39, heightCm: 180, sex: 'male' };

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bodyscale-${name}-`));

// Drive the service, collecting stdout events and stderr text separately.
function serve({ replay = FIXTURE, env = {}, onEvent, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    // replay: null means take the real transport path, so the self-test runs.
    const args = [SCALE, '--serve'];
    if (replay) args.push('--replay', replay);
    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT,
      env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: tmp('cfg') }, env),
    });
    const events = [];
    let stderr = '';
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, timeoutMs);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); }
      catch (e) { clearTimeout(timer); child.kill(); return reject(new Error('stdout was not JSON: ' + line)); }
      events.push(ev);
      if (onEvent(ev, send)) { send({ id: '_q', cmd: 'shutdown' }); }
    });
    child.on('close', () => { clearTimeout(timer); resolve({ events, stderr }); });
  });
}

// --- finding 2: a permission refusal must not be reported as "no reading" ----

test('a permission refusal maps to PERMISSION_DENIED on every platform', async () => {
  // macOS signals this by killing the process with SIGABRT. Windows just
  // raises, so the transport classifies the exception and says so explicitly.
  // Without this mapping a Windows user with the Bluetooth privacy toggle off
  // is told "stand on the scale with bare feet", forever.
  const denied = path.join(tmp('deny'), 'denied.jsonl');
  fs.writeFileSync(denied, [
    JSON.stringify({ t: 'log', level: 'info', msg: 'scanning for SSW533' }),
    JSON.stringify({ t: 'end', reason: 'permission-denied',
                     detail: 'PermissionError: Access is denied. (0x80070005)' }),
  ].join('\n') + '\n');

  const { events, stderr } = await serve({
    replay: denied,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'error' && ev.id === 'm';
    },
  });
  const err = events.find((e) => e.type === 'error' && e.id === 'm');
  assert.ok(err, 'the measurement failed');
  assert.strictEqual(err.code, 'PERMISSION_DENIED');
  assert.ok(!/stand on the scale/i.test(err.message), 'it does not blame the user');
  assert.match(stderr, /Access is denied/, "the transport's own exception is visible for diagnosis");
});

// --- finding 3: the log channel must be alive in service mode ---------------

test('service mode still writes diagnostics to stderr', async () => {
  // stdout carries the protocol, so stderr is the only channel left. It was
  // silenced by the same flag that silences terminal chatter, which removed
  // every clue about why a connection failed.
  const { stderr } = await serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  assert.ok(stderr.length > 0, 'stderr carried something');
  assert.match(stderr, /device SSW533/, 'including what it connected to');
  assert.match(stderr, /driver/i, 'and which driver it chose');
});

// --- finding 4: nothing but protocol may ever reach stdout ------------------

test('an unknown option fails loudly instead of printing help onto stdout', async () => {
  // parseArgs treats an unknown option as --help. Printing help on stdout in
  // service mode fed the host twenty unparseable lines and then exit 0, which
  // reads as a clean shutdown rather than a mistake.
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCALE, '--serve', '--no-such-flag'],
      { cwd: ROOT, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  assert.strictEqual(r.stdout, '', 'stdout stayed clean, so the protocol is not corrupted');
  assert.notStrictEqual(r.code, 0, 'and it exits non-zero');
  assert.match(r.stderr, /unknown option/);
});

// --- finding 5: the config must not live in the install directory -----------

test('the remembered device is stored in the per-user data directory', async () => {
  // A packaged app lives in Program Files or inside a signed .app. Writing
  // there fails for a standard user and breaks the macOS signature, and the
  // failure used to be invisible, costing a full scan on every launch.
  const dir = tmp('cfg');
  await new Promise((resolve) => {
    execFile(process.execPath, [SCALE, '--replay', FIXTURE, '--quiet',
                                '--sex', 'female', '--age', '44', '--height', '162'],
      { cwd: ROOT, timeout: 30000, env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: dir }) },
      () => resolve());
  });
  const file = path.join(dir, 'scale-config.json');
  assert.ok(fs.existsSync(file), 'the config was written to the directory it was told to use');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(cfg.name, 'SSW533');
  assert.ok(cfg[`address_${process.platform}`], 'the address is keyed by platform');
});

test('an unwritable config directory is reported, not swallowed', async () => {
  const { stderr, events } = await serve({
    env: { BODYSCALE_CONFIG_DIR: '/dev/null/cannot-exist' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  assert.ok(events.some((e) => e.type === 'measurement'), 'the measurement still succeeded');
  assert.match(stderr, /could not save config/, 'and the user is told the device will not be remembered');
});

// --- finding 12: a virtualenv from another machine must not be trusted ------

test('a virtualenv built on another machine is ignored', async () => {
  // A venv records an absolute path to its base interpreter. Shipped to
  // another machine it is dead, and preferring it over a correctly bundled
  // runtime turns a working install into a failure at measure time.
  const dir = tmp('venv');
  for (const f of ['scale.js', 'bcs.js', 'bia.js', 'drivers.js', 'scales-db.js',
                   'replay.js', 'ble.py', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, 'fixtures', 'ssw533-session.jsonl'));

  const venvBin = path.join(dir, '.venv', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv', 'pyvenv.cfg'),
                   'home = /nonexistent/build-machine/bin\nversion = 3.11.9\n');
  fs.writeFileSync(path.join(venvBin, 'python'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(venvBin, 'python'), 0o755);

  const r = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(dir, 'scale.js'), '--replay',
                                path.join(dir, 'fixtures', 'ssw533-session.jsonl'), '--quiet'],
      { cwd: dir, timeout: 30000, env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: tmp('cfg') }) },
      (err, stdout, stderr) => resolve({ stdout, stderr }));
  });
  assert.match(r.stderr, /built on another machine/, 'the dead virtualenv was rejected');
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.ok, true, 'and it fell through to a working interpreter');
});

// --- low severity: a malformed frame must not kill the service --------------

test('a malformed frame is skipped, not fatal', async () => {
  // The stated contract is that errors never terminate the service. An
  // odd-length hex string threw inside the line handler and took it down.
  const dir = tmp('frame');
  const bad = path.join(dir, 'bad.jsonl');
  const good = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n');
  const at = good.findIndex((l) => l.includes('"frame"'));
  good.splice(at, 0, JSON.stringify({ t: 'frame', uuid: '0000ffb2-0000-1000-8000-00805f9b34fb', hex: 'abc' }));
  fs.writeFileSync(bad, good.join('\n') + '\n');

  const { events, stderr } = await serve({
    replay: bad,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  assert.match(stderr, /malformed frame/, 'the bad frame was noted');
  const m = events.find((e) => e.type === 'measurement');
  assert.ok(m, 'and the surrounding good frames still produced a reading');
  assert.strictEqual(m.measured.weightKg, 97.9);
});

// --- research findings: Windows failure modes the tests must pin down --------

test('the Microsoft Store Python placeholder is caught before any scan', async () => {
  // On a Windows machine with no Python, the name "python" still resolves:
  // Windows ships an App Execution Alias that spawns successfully, prints a
  // notice and exits 9009. An ENOENT check never fires, so the measurement
  // used to fail with "no reading arrived" and send the user to stand on a
  // scale that was never contacted.
  const dir = tmp('alias');
  const fake = path.join(dir, 'python');
  fs.writeFileSync(fake,
    '#!/bin/sh\necho "Python was not found; run without arguments to install from the Microsoft Store."\nexit 9009\n');
  fs.chmodSync(fake, 0o755);

  const { events } = await serve({
    env: { BODYSCALE_PYTHON: fake },
    replay: null,                            // the radio path, so the check runs
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE, scanTimeoutSec: 3 }); return false; }
      return ev.type === 'error' && ev.id === 'm';
    },
  });
  const err = events.find((e) => e.type === 'error' && e.id === 'm');
  assert.strictEqual(err.code, 'TRANSPORT_FAILED', 'not NO_READING');
  assert.match(err.message, /Microsoft Store placeholder/, 'and it names the actual problem');
});

test('an interpreter without bleak is caught before any scan', async () => {
  const { events } = await serve({
    env: { BODYSCALE_PYTHON: '/usr/bin/python3' },   // present, but no bleak
    replay: null,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE, scanTimeoutSec: 3 }); return false; }
      return ev.type === 'error' && ev.id === 'm';
    },
  });
  const err = events.find((e) => e.type === 'error' && e.id === 'm');
  assert.strictEqual(err.code, 'TRANSPORT_FAILED');
  assert.match(err.message, /bleak/i, 'and names the missing package');
});

test('a switched-off radio is not reported as a permission problem', async () => {
  // Telling someone to enable a privacy toggle that is already on, when the
  // real problem is that Bluetooth is off, is a dead end they cannot escape.
  const dir = tmp('btoff');
  const file = path.join(dir, 'off.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ t: 'log', level: 'info', msg: 'scanning' }),
    JSON.stringify({ t: 'end', reason: 'bluetooth-unavailable',
                     detail: 'BleakError: Element not found. (0x80070490)' }),
  ].join('\n') + '\n');

  const { events } = await serve({
    replay: file,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        assert.ok(ev.errorCodes.includes('BLUETOOTH_UNAVAILABLE'), 'the code is advertised');
        send({ id: 'm', cmd: 'measure', profile: PROFILE });
        return false;
      }
      return ev.type === 'error' && ev.id === 'm';
    },
  });
  const err = events.find((e) => e.type === 'error' && e.id === 'm');
  assert.strictEqual(err.code, 'BLUETOOTH_UNAVAILABLE');
  assert.match(err.message, /switched off|not available/i);
  assert.ok(!/privacy|desktop apps/i.test(err.message), 'it does not send them to the permission setting');
});

test('the transport classifier separates refusal from absence', async () => {
  const probe = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ble', ${JSON.stringify(path.join(ROOT, 'ble.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  'denied':      [m.classify_failure(Exception(t)) for t in
                  ['Access is denied. (0x80070005)', 'Unauthorized', 'permission denied']],
  'unavailable': [m.classify_failure(Exception(t)) for t in
                  ['Element not found.', 'The device is not ready for use.',
                   'Bluetooth device is turned off', 'no powered adapter']],
  'other':       [m.classify_failure(Exception(t)) for t in
                  ['device did not respond', 'connection reset']],
}))
`;
  const python = fs.existsSync(path.join(ROOT, 'blehost')) ? path.join(ROOT, 'blehost') : 'python3';
  const stdout = await new Promise((resolve, reject) => {
    execFile(python, ['-c', probe], { timeout: 30000 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  const got = JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{"denied"'))[0]);
  assert.deepStrictEqual(got.denied, Array(3).fill('permission-denied'));
  assert.deepStrictEqual(got.unavailable, Array(4).fill('bluetooth-unavailable'),
                         'a switched-off radio is its own category, not a permission refusal');
  assert.deepStrictEqual(got.other, Array(2).fill('error'));
});

test('the transport self-test reports its own health as JSON', async () => {
  const python = fs.existsSync(path.join(ROOT, 'blehost')) ? path.join(ROOT, 'blehost') : 'python3';
  const out = await new Promise((resolve) => {
    execFile(python, [path.join(ROOT, 'ble.py'), '--selftest'], { timeout: 30000 },
      (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
  });
  const line = JSON.parse(out.stdout.trim().split('\n').filter((l) => l.includes('selftest'))[0]);
  assert.strictEqual(line.ok, true);
  assert.strictEqual(out.code, 0, 'a healthy transport exits zero');
  assert.match(line.bleak, /^\d+\.\d+/, `it reports a real bleak version, got ${line.bleak}`);
});

// --- profile ownership: the host owns age, height and sex, not this service ---

test('the service never stores the profile, and strips one it inherits', async () => {
  // The Electron app is the sole authority for the person. A copy kept here
  // could outlive the host's own record and be silently wrong, and it is
  // personal data this process has no reason to hold.
  const dir = tmp('profile');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({
    name: 'SSW533',
    profile: { sex: 'female', age: 44, heightCm: 162 },   // left by an older version
    address_darwin: 'STALE', address_win32: 'STALE',
  }));

  const { events } = await serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  assert.ok(events.find((e) => e.type === 'measurement'), 'the measurement succeeded');

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.ok(!('profile' in cfg), 'the inherited profile was removed, not carried forward');
  assert.ok(cfg[`address_${process.platform}`], 'the device identity is still remembered');
});

test('the service refuses to invent a profile even when one was stored', async () => {
  const dir = tmp('profile2');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({
    name: 'SSW533', profile: { sex: 'female', age: 44, heightCm: 162 },
  }));
  const { events } = await serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure' }); return false; }   // no profile
      return ev.type === 'error' || ev.type === 'accepted';
    },
  });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'it was rejected rather than silently using the stored profile');
  assert.strictEqual(err.code, 'INVALID_PROFILE');
  assert.ok(!events.find((e) => e.type === 'accepted'), 'nothing was accepted');
});

test('the handshake states who owns the profile', async () => {
  const { events } = await serve({
    onEvent: (ev, send) => ev.type === 'hello',
  });
  const hello = events.find((e) => e.type === 'hello');
  assert.strictEqual(hello.profile.suppliedBy, 'host');
  assert.strictEqual(hello.profile.required, true);
  assert.strictEqual(hello.profile.persisted, false);
  assert.deepStrictEqual(hello.profile.fields, ['age', 'heightCm', 'sex']);
});

test('the same scale reading with two profiles gives two different results', async () => {
  // Proof that the profile is genuinely an input from outside: identical
  // hardware frames, different people, different derived values.
  const run = (profile) => serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  }).then(({ events }) => events.find((e) => e.type === 'measurement'));

  const [a, b] = await Promise.all([
    run({ age: 39, heightCm: 180, sex: 'male' }),
    run({ age: 25, heightCm: 165, sex: 'female' }),
  ]);
  assert.deepStrictEqual(a.measured, b.measured, 'the scale reading is identical');
  assert.notStrictEqual(a.derived.bmi, b.derived.bmi, 'height changed BMI');
  assert.notStrictEqual(a.derived.bodyFatPercent, b.derived.bodyFatPercent, 'sex changed body fat');
  assert.notStrictEqual(a.derived.bmrKcal, b.derived.bmrKcal, 'age changed BMR');
  assert.deepStrictEqual(a.profile, { sex: 'male', age: 39, heightCm: 180 },
                         'and each result carries back the profile it was given');
});

// --- the invariant the whole trust contract rests on --------------------------

test('any fatal flag always clears trust.impedanceDerived', async () => {
  // The Electron app decides whether to present body fat, water and muscle as
  // measurements purely from trust.impedanceDerived. If a fatal rule could fire
  // while that stayed true, the UI would show a value the maths had already
  // rejected. T5 and T6 raise fatal flags without assigning the flag themselves,
  // so the guarantee is worth proving rather than assuming.
  const BIA = require(path.join(ROOT, 'bia.js'));
  let tested = 0;
  const violations = [];
  for (let w = 20; w <= 200; w += 10) {
    for (let h = 90; h <= 250; h += 20) {
      for (let a = 5; a <= 120; a += 10) {
        for (let z = 100; z <= 3200; z += 100) {
          const r = BIA.estimate({ weightKg: w, impedanceOhm: z, heightCm: h, age: a,
                                   sex: w % 20 ? 'male' : 'female' });
          tested++;
          if (r.flags.some((f) => f.severity === 'fatal') && r.trust.impedanceDerived === true) {
            if (violations.length < 5) {
              violations.push(`${w}kg ${h}cm ${a}y ${z}ohm -> `
                + r.flags.filter((f) => f.severity === 'fatal').map((f) => f.rule).join(','));
            }
          }
        }
      }
    }
  }
  assert.ok(tested > 50000, `swept a meaningful space, got ${tested}`);
  assert.deepStrictEqual(violations, [], 'no input produces a fatal flag while still claiming trust');
});

test('a clean impedance reading is trusted and carries no fatal flag', async () => {
  const BIA = require(path.join(ROOT, 'bia.js'));
  const r = BIA.estimate({ weightKg: 75, impedanceOhm: 520, heightCm: 180, age: 39, sex: 'male' });
  assert.strictEqual(r.trust.impedanceDerived, true);
  assert.deepStrictEqual(r.flags.filter((f) => f.severity === 'fatal'), []);
  assert.strictEqual(r.values.bodyFatRecommendedKey, 'bodyFatPercent',
                     'and the impedance figure is the one recommended');
});

test('the impedance seen in the field is rejected and falls back to BMI', async () => {
  // 3115.6 ohm, measured on the real scale. Poor foot contact, not a person.
  const BIA = require(path.join(ROOT, 'bia.js'));
  const r = BIA.estimate({ weightKg: 58.55, impedanceOhm: 3115.6, heightCm: 180, age: 39, sex: 'male' });
  assert.strictEqual(r.trust.impedanceDerived, false);
  assert.strictEqual(r.trust.impedanceFree, true, 'weight, BMI and BMR are still fine');
  const fatal = r.flags.filter((f) => f.severity === 'fatal').map((f) => f.rule);
  assert.deepStrictEqual(fatal, ['T2', 'T3', 'T5']);
  assert.strictEqual(r.values.bodyFatRecommendedKey, 'bodyFatPercentBmiAnchor',
                     'the recommendation switches away from the impedance figure');
});

test('derived carries 24 keys with impedance and exactly 9 without', async () => {
  // A host that assumes a key exists will throw on the impedance-free result,
  // which is a normal outcome, not an error. Both shapes are part of the contract.
  const withZ = await serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  }).then(({ events }) => events.find((e) => e.type === 'measurement'));

  assert.strictEqual(Object.keys(withZ.derived).length, 24);

  const IMPEDANCE_FREE = ['bmi', 'bmiCategoryWho', 'bmiCategoryAsiaPacific', 'bodyFatPercentBmiAnchor',
                          'bmrKcal', 'healthyWeightRangeKg', 'weightAboveHealthyRangeKg',
                          'idealWeightRangeKg', 'bodyFatRecommendedKey'];
  for (const k of IMPEDANCE_FREE) {
    assert.ok(k in withZ.derived, `${k} is present when impedance is present too`);
  }

  // Now the same session with the impedance frame removed.
  const dir = tmp('noz');
  const file = path.join(dir, 'noz.jsonl');
  const lines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n')
    .filter((l) => !l.includes('ffb3'));            // the record channel carries impedance
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const noZ = await serve({
    replay: file,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  }).then(({ events }) => events.find((e) => e.type === 'measurement'));

  assert.ok(noZ, 'a weight-only measurement still succeeds');
  assert.strictEqual(noZ.measured.impedanceOhm, null);
  assert.deepStrictEqual(Object.keys(noZ.derived).sort(), IMPEDANCE_FREE.slice().sort(),
                         'exactly the nine impedance-free keys, no more');
  assert.strictEqual(noZ.trust.impedanceFree, true);
  assert.strictEqual(noZ.trust.impedanceDerived, false);
});

// --- synchronisation: the host and the service must never drift apart --------

test('every request gets exactly one terminal event, and only one', async () => {
  // A host keeps a promise per request id. Two terminal events for one id would
  // settle it twice and leak the second; zero would hang it forever. This is
  // the guarantee that lets the two processes stay in lockstep.
  const TERMINAL = new Set(['measurement', 'error', 'status', 'forgotten', 'cancelling', 'bye']);
  const { events } = await serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'a', cmd: 'status' });
        send({ id: 'b', cmd: 'frobnicate' });                 // unknown
        send({ id: 'c', cmd: 'measure', profile: { age: 2 } }); // invalid
        send({ id: 'd', cmd: 'forget' });
        send({ id: 'e', cmd: 'measure', profile: PROFILE });   // the real one
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'e';
    },
  });

  const terminals = {};
  for (const ev of events) {
    if (!TERMINAL.has(ev.type) || ev.id == null) continue;
    terminals[ev.id] = (terminals[ev.id] || 0) + 1;
  }
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    assert.strictEqual(terminals[id], 1, `request ${id} settled exactly once, got ${terminals[id]}`);
  }
  // accepted and progress are not terminal: they must not settle the promise.
  const accepted = events.filter((e) => e.type === 'accepted');
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].id, 'e', 'only the measure was accepted');
  assert.ok(events.filter((e) => e.type === 'progress').length > 0, 'progress streamed alongside');
});

test('replies may interleave, so a host must correlate on id and never on order', async () => {
  // The service answers cheap commands immediately while a measurement runs.
  // A host that assumed replies arrive in request order would mismatch them.
  const { events } = await serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'slow', cmd: 'measure', profile: PROFILE }); return false; }
      if (ev.type === 'accepted') { send({ id: 'fast', cmd: 'status' }); return false; }
      return ev.type === 'measurement' && ev.id === 'slow';
    },
  });
  const order = events.filter((e) => e.id === 'fast' || (e.id === 'slow' && e.type === 'measurement'))
                      .map((e) => e.id);
  assert.deepStrictEqual(order, ['fast', 'slow'],
    'the later request answered first, which is legal and why id correlation is mandatory');
});

test('status lets a host resynchronise after losing track', async () => {
  const { events } = await serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
      if (ev.type === 'accepted') { send({ id: 's', cmd: 'status' }); return false; }
      return ev.type === 'status' && ev.id === 's';
    },
  });
  const st = events.find((e) => e.type === 'status' && e.id === 's');
  assert.strictEqual(st.busy, true);
  assert.strictEqual(st.runningId, 'm', 'status names the in-flight request, so a host can recover it');
});
