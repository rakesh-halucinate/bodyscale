'use strict';
/**
 * Shared harness for the integration suite.
 *
 * Every integration test drives the REAL `scale.js --serve` process over a REAL
 * pipe, exactly as the Electron main process does. Nothing is mocked. The
 * Bluetooth radio is replaced by a recorded session from the actual Dr Trust
 * SSW533, so the suite runs anywhere, including CI, with no hardware.
 *
 * Test case ids are stable and traceable: INT-<AREA>-<NN>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCALE = path.join(ROOT, 'scale.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');
const CLIENT = path.join(ROOT, 'electron-example', 'bodyscale-client.js');

/** The three fields the host owns. Nothing else may be sent about the person. */
const PROFILE = { age: 39, heightCm: 180, sex: 'male' };

/** What the recorded session settles at. */
const EXPECTED = { weightKg: 97.9, impedanceOhm: 529.9, name: 'SSW533' };

/** Terminal event types: exactly one of these settles a request. */
const TERMINAL = new Set(['measurement', 'error', 'status', 'forgotten', 'cancelling', 'bye']);

/** Non-terminal: these stream alongside and must never settle a promise. */
const STREAMING = new Set(['accepted', 'progress']);

/** The nine keys present in `derived` whatever happens. */
const IMPEDANCE_FREE_KEYS = [
  'bmi', 'bmiCategoryWho', 'bmiCategoryAsiaPacific', 'bodyFatPercentBmiAnchor',
  'bmrKcal', 'healthyWeightRangeKg', 'weightAboveHealthyRangeKg',
  'idealWeightRangeKg', 'bodyFatRecommendedKey',
];

/** The fifteen that appear only when impedance survived its checks. */
const IMPEDANCE_ONLY_KEYS = [
  'bodyWaterLitres', 'bodyWaterPercent', 'fatFreeMassKg', 'fatFreeMassIndex',
  'bodyFatPercent', 'fatMassKg', 'muscleMassKg', 'muscleMassPercent',
  'skeletalMuscleMassKg', 'skeletalMusclePercent', 'skeletalMuscleIndex',
  'boneMassKg', 'proteinMassKg', 'proteinPercent', 'bodyFatGapPoints',
];

const ALL_ERROR_CODES = [
  'BAD_REQUEST', 'UNKNOWN_COMMAND', 'INVALID_PROFILE', 'BUSY', 'DEVICE_NOT_FOUND',
  'NO_READING', 'BLUETOOTH_UNAVAILABLE', 'PERMISSION_DENIED', 'TRANSPORT_FAILED',
  'CANCELLED', 'INTERNAL',
];

/** A scratch directory, so no test reads or writes the developer's own config. */
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bodyscale-${tag}-`));
}

/**
 * Make a config directory hermetic.
 *
 * `readConfig()` tries the per-user config first and then falls back to a
 * `.scale-config.json` sitting beside the script. So pointing a test at an
 * EMPTY scratch directory does not isolate it: the service reads the
 * developer's own remembered device instead, and 21 test files running
 * concurrently all see the same shared state.
 *
 * Writing an empty object stops the fallback dead while still presenting a
 * service that remembers nothing, which is the state most tests want. An
 * existing file is never overwritten, so a test that seeds its own config
 * still gets it.
 */
function seedConfigDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'scale-config.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}\n');
  } catch (e) { /* an unwritable directory is itself under test */ }
  return dir;
}

/** A scratch config directory that is already isolated from the repository. */
function configDir(tag) {
  return seedConfigDir(tmpdir(tag || 'cfg'));
}

/**
 * Write a one-off replay fixture.
 * @param {string} tag  directory tag
 * @param {object[]} events  transport events, one per line
 * @returns {string} the file path
 */
function fixture(tag, events) {
  const dir = tmpdir(tag);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

/** The recorded session with the impedance-bearing record channel removed. */
function fixtureWithoutImpedance(tag) {
  const dir = tmpdir(tag);
  const file = path.join(dir, 'no-impedance.jsonl');
  const lines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n')
    .filter((l) => !l.includes('ffb3'));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/**
 * Drive the service.
 *
 * @param {object} opts
 * @param {string|null} [opts.replay]   fixture path, or null to take the real radio path
 * @param {object} [opts.env]           extra environment
 * @param {string[]} [opts.args]        extra argv
 * @param {number} [opts.timeoutMs]
 * @param {(ev, send, raw) => boolean} opts.onEvent  return true when done
 * @returns {Promise<{events: object[], stdout: string, stderr: string, code: number|null}>}
 */
function serve(opts) {
  const { replay = FIXTURE, env = {}, args = [], timeoutMs = 25000, onEvent } = opts;
  // REPLAY_HOLD_MS in `env` makes the stand-in transport stay connected and
  // silent after the recording ends, which is how a real scale behaves when it
  // is sitting on a stale reading.
  return new Promise((resolve, reject) => {
    const argv = [SCALE, '--serve'];
    if (replay) argv.push('--replay', replay);
    argv.push(...args);

    // Seed whichever config directory this run will use, including one the
    // caller supplied, so the legacy fallback can never reach the repository.
    const childEnv = Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: tmpdir('cfg') }, env);
    seedConfigDir(childEnv.BODYSCALE_CONFIG_DIR);

    const child = spawn(process.execPath, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT,
      env: childEnv,
    });

    const events = [];
    let stdout = '';
    let stderr = '';
    let settled = false;

    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { /* gone */ } };
    const raw = (text) => { try { child.stdin.write(text + '\n'); } catch (e) { /* gone */ } };

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(
      new Error(`timed out after ${timeoutMs} ms; saw: [${events.map((e) => e.type).join(', ')}]`))), timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); }
      catch (e) { return finish(() => reject(new Error(`stdout carried a non-JSON line: ${line}`))); }
      events.push(ev);
      let done = false;
      try { done = onEvent(ev, send, raw); }
      catch (e) { return finish(() => reject(e)); }
      if (done) send({ id: '_harness_stop', cmd: 'shutdown' });
    });

    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => resolve({ events, stdout, stderr, code })));
  });
}

/** Run one measurement and return its terminal event. */
function measureOnce({ profile = PROFILE, replay = FIXTURE, env = {}, options = {} } = {}) {
  return serve({
    replay,
    env,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send(Object.assign({ id: 'M1', cmd: 'measure', profile }, options));
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'M1';
    },
  }).then(({ events, stderr }) => ({
    events,
    stderr,
    terminal: events.find((e) => (e.type === 'measurement' || e.type === 'error') && e.id === 'M1'),
    progress: events.filter((e) => e.type === 'progress'),
    hello: events.find((e) => e.type === 'hello'),
  }));
}

const byType = (events, type) => events.filter((e) => e.type === type);
const first = (events, type) => events.find((e) => e.type === type);

/** Assert an object's fields have the expected primitive types. */
function assertShape(assert, obj, spec, where) {
  for (const [key, type] of Object.entries(spec)) {
    const optional = type.endsWith('?');
    const want = optional ? type.slice(0, -1) : type;
    const present = obj != null && key in obj;
    if (!present) {
      assert.ok(optional, `${where}.${key} is present`);
      continue;
    }
    const v = obj[key];
    if (want === 'null') { assert.strictEqual(v, null, `${where}.${key} is null`); continue; }
    if (v === null && optional) continue;
    const got = Array.isArray(v) ? 'array' : typeof v;
    assert.strictEqual(got, want, `${where}.${key} is ${want}, got ${got} (${JSON.stringify(v)})`);
  }
}

module.exports = {
  ROOT, SCALE, FIXTURE, CLIENT, PROFILE, EXPECTED,
  TERMINAL, STREAMING, IMPEDANCE_FREE_KEYS, IMPEDANCE_ONLY_KEYS, ALL_ERROR_CODES,
  tmpdir, configDir, seedConfigDir, fixture, fixtureWithoutImpedance, serve, measureOnce,
  byType, first, assertShape,
};
