'use strict';
// Covers scale.js, the terminal tool. The BLE transport is replaced by a
// recorded session so the decode and reporting path is provable without
// hardware and without Bluetooth permission.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCALE = path.join(ROOT, 'scale.js');
const SESSION = path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');
const { parseArgs, buildResult } = require(SCALE);

// The tool stores its remembered device in the per-user data directory, not
// beside the script, because a packaged app cannot write to its own install
// directory. Point the tests at a scratch directory so they neither read nor
// clobber the developer's real config.
const CONFIG_DIR = path.join(require('os').tmpdir(), 'bodyscale-test-config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'scale-config.json');
const TEST_ENV = Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: CONFIG_DIR });

const run = (args, opts) => new Promise((resolve) => {
  execFile(process.execPath, [SCALE, ...args],
    Object.assign({ cwd: ROOT, timeout: 30000, env: TEST_ENV }, opts),
    (err, stdout, stderr) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr }));
});

test('argument parsing covers the documented flags', () => {
  const a = parseArgs(['--watch', '--quiet', '--raw', '--name', 'X1', '--sex', 'female',
                       '--age', '41', '--height', '165', '--scan-timeout', '7']);
  assert.equal(a.watch, true);
  assert.equal(a.quiet, true);
  assert.equal(a.raw, true);
  assert.equal(a.name, 'X1');
  assert.equal(a.sex, 'female');
  assert.equal(a.age, 41);
  assert.equal(a.heightCm, 165);
  assert.equal(a.scanTimeout, 7);
  assert.equal(parseArgs([]).name, 'SSW533', 'defaults to the known scale');
});

test('the recorded session is a valid protocol transcript', () => {
  const lines = fs.readFileSync(SESSION, 'utf8').split('\n').filter(Boolean);
  const kinds = lines.map((l) => JSON.parse(l).t);
  assert.ok(kinds.includes('device'));
  assert.ok(kinds.includes('services'));
  assert.ok(kinds.includes('ready'));
  assert.ok(kinds.filter((k) => k === 'frame').length >= 5);
  assert.equal(kinds[kinds.length - 1], 'end');
});

test('replaying a real session yields the weight and impedance the hardware sent', async () => {
  const r = await run(['--replay', SESSION, '--quiet', '--sex', 'male', '--age', '39', '--height', '180']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.measured.weightKg, 97.9);
  assert.equal(out.measured.impedanceOhm, 529.9);
  assert.equal(out.device.name, 'SSW533');
  assert.equal(out.model, 'Dr Trust SSW532');
});

test('quiet mode puts exactly one line of JSON on stdout and nothing else', async () => {
  const r = await run(['--replay', SESSION, '--quiet']);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'a single line, so it pipes cleanly');
  assert.doesNotThrow(() => JSON.parse(lines[0]));
  assert.equal(r.stderr, '', 'progress chatter is suppressed');
});

test('the payload carries everything another app needs', async () => {
  const r = await run(['--replay', SESSION, '--quiet', '--sex', 'male', '--age', '39', '--height', '180']);
  const out = JSON.parse(r.stdout.trim());
  for (const key of ['ok', 'timestamp', 'device', 'measured', 'derived', 'units', 'confidence',
                     'trust', 'bodyFatRecommended', 'flags', 'warnings', 'omitted', 'profile']) {
    assert.ok(key in out, `payload is missing ${key}`);
  }
  for (const m of ['bmi', 'bodyFatPercent', 'fatFreeMassKg', 'skeletalMuscleMassKg',
                   'bodyWaterPercent', 'boneMassKg', 'proteinMassKg', 'bmrKcal']) {
    assert.ok(typeof out.derived[m] === 'number', `derived.${m} should be a number`);
  }
  assert.equal(out.units.bmi, 'kg/m²');
  assert.equal(out.confidence.weightKg, undefined, 'measured values live under measured, not derived');
  assert.equal(out.confidence.bodyFatPercent, 'derived-literature');
});

test('this reading passes its checks, so the impedance figure is the recommended one', async () => {
  const r = await run(['--replay', SESSION, '--quiet', '--sex', 'male', '--age', '39', '--height', '180']);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.trust.impedanceDerived, true);
  assert.equal(out.bodyFatRecommended.key, 'bodyFatPercent');
  assert.ok(out.bodyFatRecommended.value > 25 && out.bodyFatRecommended.value < 45);
  assert.ok(!out.flags.some((f) => f.severity === 'fatal'));
});

test('the profile is remembered so later runs need no flags', async () => {
  const cfgPath = CONFIG_FILE;
  await run(['--replay', SESSION, '--quiet', '--sex', 'female', '--age', '44', '--height', '162']);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.profile.sex, 'female');
  assert.equal(cfg.profile.age, 44);
  assert.equal(cfg.profile.heightCm, 162);
  assert.equal(cfg.name, 'SSW533');
  // Bluetooth identifiers are not portable: macOS hands out a CoreBluetooth
  // UUID, Windows a MAC address, so the address is stored per platform.
  assert.ok(cfg[`address_${process.platform}`], 'and the address, so no scan is needed next time');
  assert.ok(!('address' in cfg), 'the old platform-blind key is gone');

  const r = await run(['--replay', SESSION, '--quiet']);          // no flags at all
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.profile.age, 44, 'picked the profile back up');
  // Put it back so a later manual run is not surprised.
  await run(['--replay', SESSION, '--quiet', '--sex', 'male', '--age', '39', '--height', '180']);
});

test('a session that carries no reading fails loudly with a reason, not silently', async () => {
  const empty = path.join(ROOT, 'fixtures', 'empty-session.jsonl');
  fs.writeFileSync(empty, '{"t":"device","name":"SSW533","address":"AA"}\n{"t":"ready"}\n{"t":"end","reason":"finished"}\n');
  const r = await run(['--replay', empty, '--quiet']);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.match(out.reason, /bare feet|no reading/i);
  assert.notEqual(r.code, 0, 'a non-zero exit so a caller can branch on it');
  fs.unlinkSync(empty);
});

test('buildResult refuses to invent body composition for an object on the scale', () => {
  const res = { capture: { weight: 15.1, impedance: 1121 }, device: { name: 'SSW533' }, identified: null };
  const out = buildResult(res, { sex: 'male', age: 39, heightCm: 180 });
  assert.equal(out.measured.weightKg, 15.1);
  assert.equal(out.derived.bodyFatPercent, undefined, 'no body fat for a 15 kg object');
  assert.ok(out.warnings.some((w) => /too low to be a person/.test(w)));
});

test('help lists the flags and exits cleanly', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  for (const f of ['--watch', '--quiet', '--raw', '--forget', '--replay', '--sex', '--age', '--height']) {
    assert.ok(r.stdout.includes(f), `help is missing ${f}`);
  }
});

test('the macOS setup and runner scripts are present and executable', () => {
  for (const f of ['setup-mac.sh', 'run.command', 'ble.py', 'replay.js']) {
    const p = path.join(ROOT, f);
    assert.ok(fs.existsSync(p), `${f} is missing`);
    assert.ok((fs.statSync(p).mode & 0o111) !== 0, `${f} is not executable`);
  }
  const setup = fs.readFileSync(path.join(ROOT, 'setup-mac.sh'), 'utf8');
  assert.match(setup, /NSBluetoothAlwaysUsageDescription/, 'setup declares the Bluetooth usage description');
  assert.match(setup, /Resources\/Python\.app/, 'and targets the framework bundle that actually runs');
  const runner = fs.readFileSync(path.join(ROOT, 'run.command'), 'utf8');
  assert.match(runner, /responsible/, 'the runner explains why it must come from Terminal');
});

test('scale.js explains a macOS Bluetooth refusal instead of leaving an abort trap', () => {
  const src = fs.readFileSync(SCALE, 'utf8');
  assert.match(src, /SIGABRT/, 'detects the signal macOS uses to enforce the refusal');
  assert.match(src, /tcc-denied/);
  assert.match(src, /run\.command/, 'and tells the user what to do about it');
});

test('loop mode keeps measuring instead of exiting after one reading', async () => {
  const r = await run(['--replay', SESSION, '--watch', '--repeats', '--max-attempts', '3',
                       '--interval', '0', '--quiet']);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'one JSON payload per attempt');
  lines.forEach((l, i) => {
    const out = JSON.parse(l);
    assert.equal(out.ok, true);
    assert.equal(out.measurementNumber, i + 1, 'each reading is numbered');
    assert.equal(out.measured.weightKg, 97.9);
  });
});

test('a held reading is not reported twice, because the scale repeats it', async () => {
  const r = await run(['--replay', SESSION, '--watch', '--max-attempts', '3', '--interval', '0']);
  const payloads = (r.stdout.match(/"ok": true/g) || []).length;
  assert.equal(payloads, 1, 'the identical repeats are suppressed');
  assert.match(r.stderr, /still holding it/, 'and the reason is explained');
  assert.match(r.stderr, /Step off/, 'with what to do about it');
});

test('--max stops after the requested number of measurements', async () => {
  const r = await run(['--replay', SESSION, '--watch', '--repeats', '--max', '2',
                       '--interval', '0', '--quiet']);
  assert.equal(r.stdout.trim().split('\n').filter(Boolean).length, 2);
  assert.equal(r.code, 0);
});

test('--max-attempts bounds a loop that never sees a new reading', async () => {
  const r = await run(['--replay', SESSION, '--watch', '--max-attempts', '2', '--interval', '0']);
  assert.match(r.stderr, /Reached 2 attempt/);
  assert.equal(r.code, 0, 'having taken at least one measurement is a success');
});

test('quiet mode really is quiet, even in a loop', async () => {
  const r = await run(['--replay', SESSION, '--watch', '--repeats', '--max-attempts', '2',
                       '--interval', '0', '--quiet']);
  assert.equal(r.stderr, '', 'nothing on stderr to corrupt a piped consumer');
  r.stdout.trim().split('\n').filter(Boolean).forEach((l) => assert.doesNotThrow(() => JSON.parse(l)));
});

test('the transport attaches on the first matching advertisement', () => {
  const py = fs.readFileSync(path.join(ROOT, 'ble.py'), 'utf8');
  assert.match(py, /detection_callback/, 'uses a callback rather than a fixed-length scan');
  assert.match(py, /matched by/, 'and reports how it matched');
  assert.match(py, /advertisement from .* after .* ms/, 'timing the attach so a delay is visible');
  // Address and name must be matched in the SAME scan; a two-phase search can
  // miss an entire advertising burst.
  const fn = py.slice(py.indexOf('async def find_device'), py.indexOf('async def run('));
  assert.match(fn, /want_addr/);
  assert.match(fn, /want_name/);
  assert.equal((fn.match(/BleakScanner\(/g) || []).length, 1, 'exactly one scanner');
  assert.match(fn, /await scanner\.stop\(\)/, 'stops scanning before connecting');
});

test('run.command loops by default so repeated tests need no restart', () => {
  const r = fs.readFileSync(path.join(ROOT, 'run.command'), 'utf8');
  assert.match(r, /--watch/);
  assert.match(r, /step off, step on again/i);
});
