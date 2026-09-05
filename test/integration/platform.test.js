'use strict';
/**
 * INT-PLAT — the behaviours that decide whether the Windows port works.
 *
 * This code was written on a Mac and has to run on Windows, where four things
 * differ and none of them are cosmetic: where a per-user file may be written,
 * what a device identifier means, which interpreter the Bluetooth helper runs
 * under, and how the operating system says no. Every case here is provable on
 * any platform with no radio: the transport is a replay fixture or a stub
 * interpreter, and the platform-specific branches are asserted through the
 * values the code actually derives from `process.platform`.
 *
 * Nothing here writes outside a scratch directory. The project tree is read,
 * never touched: ble.py is COPIED into scratch before being imported, so no
 * __pycache__ appears beside the source.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const H = require('./harness');

/** scale.js keys the saved address by platform. A Mac UUID means nothing on Windows. */
const ADDRESS_KEY = `address_${process.platform}`;
const IS_DARWIN = process.platform === 'darwin';

/** The three platforms the code names, minus the one running the test. */
const OTHER_PLATFORMS = ['darwin', 'win32', 'linux'].filter((p) => p !== process.platform);

/** The file name the per-user config must have. Not the dotfile beside the script. */
const CONFIG_NAME = 'scale-config.json';

/** The address the recorded session advertises, and so the one that gets saved. */
const REPLAY_ADDRESS = 'BEECC6EC-BD30-3EAC-B148-4833628A8A58';

/**
 * Shell stubs need a shebang and an exec bit, and Node refuses to spawn a .cmd
 * without a shell, so every stub-interpreter case is POSIX-only. The Windows
 * failures they model are still asserted here on POSIX, where the stub can run.
 */
const POSIX_ONLY = process.platform === 'win32' ? 'stub interpreters are POSIX-only' : false;

/** chmod cannot make a file unwritable on Windows, and root ignores it. */
const CHMOD_WORKS = process.platform !== 'win32'
  && !(typeof process.getuid === 'function' && process.getuid() === 0);

/**
 * The interpreter the project itself would reach for: the signed bundle on
 * macOS, plain python3 anywhere else.
 */
const PYTHON = fs.existsSync(path.join(H.ROOT, 'blehost'))
  ? path.join(H.ROOT, 'blehost')
  : 'python3';

/** Whether that interpreter can be run at all. It cannot be assumed in CI. */
const PYTHON_RUNS = (() => {
  try {
    const r = spawnSync(PYTHON, ['-c', 'pass'], { encoding: 'utf8', timeout: 20000 });
    return !r.error && r.status === 0;
  } catch (e) { return false; }
})();
const NEEDS_PYTHON = PYTHON_RUNS ? false : `no usable interpreter at ${PYTHON}`;

/* ---------- config directories ---------- */

/*
 * A config directory holding an explicitly empty config.
 *
 * Not a bare empty directory: readConfig falls back to the legacy
 * .scale-config.json beside the script when the per-user file is missing, and a
 * developer machine has one, remembered device and all. Writing `{}` makes the
 * per-user file the one that is found, so these tests see the same state
 * everywhere.
 */
function configDirWith(tag, config) {
  const dir = H.tmpdir(tag);
  fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify(config, null, 2) + '\n');
  return dir;
}
const emptyConfigDir = (tag) => configDirWith(tag, {});
const readSaved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8'));

/** Everything the config directory holds, sorted, so a stray file is visible. */
const listConfigDir = (dir) => fs.readdirSync(dir).sort();

/** The bytes of a file, or null when it is not there. */
function snapshot(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

/* ---------- driving a service ---------- */

/**
 * H.serve() always drives the checked-out scale.js with a config directory of
 * its own choosing. These cases also need to drive a *copy* of the script,
 * because the interpreter search looks beside it, and one case needs no
 * BODYSCALE_CONFIG_DIR at all so the default location can be observed.
 *
 * `configDir: null` removes the override; any inherited BODYSCALE_PYTHON is
 * always dropped, so a developer's own export cannot decide these results.
 */
function driveService({ script = H.SCALE, cwd = H.ROOT, configDir, replay, env = {},
                        args = [], timeoutMs = 22000, onEvent }) {
  return new Promise((resolve, reject) => {
    const argv = [script, '--serve'];
    if (replay) argv.push('--replay', replay);
    argv.push(...args);

    const childEnv = Object.assign({}, process.env);
    delete childEnv.BODYSCALE_PYTHON;
    if (configDir === null) delete childEnv.BODYSCALE_CONFIG_DIR;
    else childEnv.BODYSCALE_CONFIG_DIR = configDir;
    Object.assign(childEnv, env);

    const child = spawn(process.execPath, argv, {
      stdio: ['pipe', 'pipe', 'pipe'], cwd, env: childEnv,
    });

    const events = [];
    let stdout = '', stderr = '', settled = false;
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { /* gone */ } };
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(
      `timed out after ${timeoutMs} ms; saw [${events.map((e) => e.type).join(', ')}]; stderr: ${stderr}`))), timeoutMs);

    child.stdin.on('error', () => { /* the far end may already be gone */ });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); }
      catch (e) { return finish(() => reject(new Error(`stdout carried a non-JSON line: ${line}`))); }
      events.push(ev);
      let done = false;
      try { done = onEvent(ev, send); }
      catch (e) { return finish(() => reject(e)); }
      if (done) send({ id: '_stop', cmd: 'shutdown' });
    });

    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => resolve({ events, stdout, stderr, code })));
  });
}

/** Ask for one measurement and stop at its terminal reply. */
function measureWith(opts) {
  return driveService(Object.assign({}, opts, {
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'M1', cmd: 'measure', profile: H.PROFILE, scanTimeoutSec: 2 });
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'M1';
    },
  })).then((r) => Object.assign(r, {
    hello: H.first(r.events, 'hello'),
    terminal: r.events.find((e) => (e.type === 'measurement' || e.type === 'error') && e.id === 'M1'),
  }));
}

/**
 * The type of the settling reply, or a description of what arrived instead, so
 * a missing terminal reads as a comparison failure rather than a TypeError.
 */
const settledAs = (r) => (r.terminal ? r.terminal.type
  : `no terminal reply; saw [${r.events.map((e) => e.type).join(', ')}]; stderr: ${r.stderr}`);

/* ---------- a relocated copy of the project ---------- */

const PROJECT_FILES = ['scale.js', 'ble.py', 'bia.js', 'drivers.js', 'bcs.js',
  'scales-db.js', 'replay.js', 'package.json'];

/**
 * A working copy of the tool somewhere else on disk, with no .venv and no
 * blehost bundle, so a test owns the whole interpreter search.
 */
function copyTree(tag) {
  const dir = H.tmpdir(tag);
  for (const f of PROJECT_FILES) fs.copyFileSync(path.join(H.ROOT, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.copyFileSync(H.FIXTURE, path.join(dir, 'fixtures', 'ssw533-session.jsonl'));
  return {
    dir,
    script: path.join(dir, 'scale.js'),
    replay: path.join(dir, 'fixtures', 'ssw533-session.jsonl'),
    venv: path.join(dir, '.venv'),
    venvPython: path.join(dir, '.venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python'),
  };
}

/** Give a tree a .venv whose pyvenv.cfg says what `cfgText` says. */
function makeVenv(tree, cfgText, body) {
  fs.mkdirSync(path.dirname(tree.venvPython), { recursive: true });
  fs.writeFileSync(path.join(tree.venv, 'pyvenv.cfg'), cfgText);
  fs.writeFileSync(tree.venvPython, body);
  if (process.platform !== 'win32') fs.chmodSync(tree.venvPython, 0o755);
  return tree.venvPython;
}

/* ---------- stub interpreters (POSIX only) ---------- */

/**
 * A stand-in for Python that answers `--selftest` with a distinctive bleak
 * version and otherwise replays a recorded session on stdout, which is exactly
 * the contract ble.py has with scale.js. Nothing here touches a radio.
 */
function workingStubBody(marker, fixture) {
  return '#!/bin/sh\n'
    + 'for arg in "$@"; do\n'
    + '  if [ "$arg" = "--selftest" ]; then\n'
    + `    printf '%s\\n' '{"t":"selftest","ok":true,"bleak":"${marker}","python":"${marker}",`
    + '"executable":"stub"}\'\n'
    + '    exit 0\n'
    + '  fi\n'
    + 'done\n'
    + `cat '${fixture}'\n`
    + 'exit 0\n';
}

/** Windows' App Execution Alias: it runs, prints an advert, and exits 9009. */
const STORE_ALIAS_SH = '#!/bin/sh\n'
  + 'echo "Python was not found; run without arguments to install from the Microsoft Store, '
  + 'or disable this shortcut from Settings > Manage App Execution Aliases."\n'
  + 'exit 9009\n';

/** A real interpreter with a half-finished install: it runs, bleak does not. */
const NO_BLEAK_SH = '#!/bin/sh\n'
  + 'echo \'{"t":"selftest","ok":false,"error":"ModuleNotFoundError: No module named bleak"}\'\n'
  + 'exit 1\n';

/** Write an executable stub and return its path. */
function writeStub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A directory holding a `python3` and a `python` stub, ready to go on PATH. */
function stubOnPath(tag, body) {
  const dir = H.tmpdir(tag);
  writeStub(dir, 'python3', body);
  writeStub(dir, 'python', body);
  return dir;
}
const withPath = (dir) => ({ PATH: dir + path.delimiter + process.env.PATH });

/* ---------- calling into the real ble.py ---------- */

/**
 * Run ble.py's own classify_failure over a list of message texts.
 *
 * ble.py is copied into scratch first, so importing it as a module leaves its
 * __pycache__ there rather than beside the project source.
 */
function classify(texts) {
  const dir = H.tmpdir('classify');
  fs.copyFileSync(path.join(H.ROOT, 'ble.py'), path.join(dir, 'ble.py'));
  const helper = path.join(dir, 'classify.py');
  fs.writeFileSync(helper, [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    'import ble',
    'print(json.dumps([ble.classify_failure(Exception(t)) for t in sys.argv[1:]]))',
    '',
  ].join('\n'));
  const r = spawnSync(PYTHON, [helper, ...texts], {
    encoding: 'utf8', cwd: dir, timeout: 30000,
    env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' }),
  });
  assert.ok(!r.error, `running classify_failure: ${r.error && r.error.message}`);
  assert.strictEqual(r.status, 0, `classify_failure exited ${r.status}: ${r.stderr}`);
  const line = (r.stdout || '').trim().split('\n').pop();
  return JSON.parse(line);
}

/* ================================================================ config ==
 *
 * Where the remembered device is written, and what is in it.
 */

// Prevents: a packaged Windows build saving the remembered device inside
// Program Files, where a standard user cannot write, so every launch rescans —
// or, on macOS, writing into its own signed bundle and breaking the signature.
test('INT-PLAT-01  with no override the config lands in this platform per-user data directory', async () => {
  const home = H.tmpdir('plat01home');
  const expectedDir = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'bodyscale')
    : IS_DARWIN
      ? path.join(home, 'Library', 'Application Support', 'bodyscale')
      : path.join(home, '.config', 'bodyscale');
  const legacyBeside = path.join(H.ROOT, '.scale-config.json');
  const besideBefore = snapshot(legacyBeside);

  const r = await measureWith({
    configDir: null,                       // no override: exercise the real default
    replay: H.FIXTURE,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
    },
  });
  assert.strictEqual(settledAs(r), 'measurement', 'the replay produced a reading');

  // The directory did not exist: writeConfig has to create the whole chain.
  assert.strictEqual(fs.existsSync(path.join(expectedDir, CONFIG_NAME)), true,
    `the config was created at ${expectedDir}; the home tree holds ${JSON.stringify(fs.readdirSync(home))}`);
  assert.strictEqual(readSaved(expectedDir)[ADDRESS_KEY], REPLAY_ADDRESS,
    'and it is the device this run found');

  assert.strictEqual(fs.existsSync(path.join(H.ROOT, CONFIG_NAME)), false,
    'no scale-config.json appeared next to scale.js');
  assert.strictEqual(snapshot(legacyBeside), besideBefore,
    'the legacy config beside the script was not rewritten');
});

// Prevents: a host that sets BODYSCALE_CONFIG_DIR (an Electron app pointing at
// app.getPath('userData')) having it quietly ignored, so the remembered device
// lands somewhere the packaged app cannot read back.
test('INT-PLAT-02  BODYSCALE_CONFIG_DIR is honoured exactly, and holds nothing but scale-config.json', async () => {
  const dir = emptyConfigDir('plat02');
  const legacyBeside = path.join(H.ROOT, '.scale-config.json');
  const besideBefore = snapshot(legacyBeside);

  const r = await H.measureOnce({ env: { BODYSCALE_CONFIG_DIR: dir } });
  assert.strictEqual(r.terminal.type, 'measurement', 'the replay produced a reading');

  assert.deepStrictEqual(listConfigDir(dir), [CONFIG_NAME],
    'exactly one file, named scale-config.json, and nothing else');
  assert.strictEqual(readSaved(dir)[ADDRESS_KEY], REPLAY_ADDRESS,
    'the device found during the measurement was saved there');

  assert.strictEqual(fs.existsSync(path.join(H.ROOT, CONFIG_NAME)), false,
    'no scale-config.json appeared next to scale.js');
  assert.strictEqual(snapshot(legacyBeside), besideBefore,
    'the legacy config beside the script was not touched');
});

// Prevents: a config carried from a Mac to a PC (a synced folder, a restored
// backup) offering a CoreBluetooth UUID as a Windows MAC address, so the
// connect silently never matches and every measurement falls back to a scan.
test('INT-PLAT-03  the saved address is keyed by the platform the service reports, with no bare address key', async () => {
  const dir = emptyConfigDir('plat03');
  const r = await H.measureOnce({ env: { BODYSCALE_CONFIG_DIR: dir } });
  assert.strictEqual(r.terminal.type, 'measurement');
  const saved = readSaved(dir);

  // The key is read back from the service's own hello, not from a constant
  // this file computes, so a service keying by something else is caught.
  assert.strictEqual(r.hello.platform, process.platform,
    'the service names the platform it is running on');
  assert.deepStrictEqual(Object.keys(saved).filter((k) => /address/i.test(k)),
    [`address_${r.hello.platform}`],
    `exactly one address key, named for that platform; got [${Object.keys(saved)}]`);
  assert.strictEqual(saved[ADDRESS_KEY], REPLAY_ADDRESS);
  assert.strictEqual('address' in saved, false, 'no unqualified address key is ever written');
  for (const other of OTHER_PLATFORMS) {
    assert.strictEqual(`address_${other}` in saved, false,
      `nothing was written under address_${other}`);
  }
  assert.strictEqual(saved.name, H.EXPECTED.name, 'the device name is remembered alongside it');
});

// Prevents: an identifier leaking across platforms — the Windows build reading
// a Mac's saved UUID, announcing a remembered device, and then failing to
// connect to something that does not exist on this machine.
test('INT-PLAT-04  an address saved under another platform key is never offered as this platform device', async () => {
  const foreign = {};
  for (const other of OTHER_PLATFORMS) foreign[`address_${other}`] = `FOREIGN-${other.toUpperCase()}-ADDR`;
  foreign.name = 'SSW533';
  const dir = configDirWith('plat04', foreign);

  const r = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'S1', cmd: 'status' }); return false; }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  const status = r.events.find((e) => e.type === 'status' && e.id === 'S1');
  assert.strictEqual(hello.device, null, 'hello offers no device');
  assert.strictEqual(status.device, null, 'status offers no device either');
  assert.strictEqual(status.platform, process.platform, 'status names the platform it is running on');
  for (const other of OTHER_PLATFORMS) {
    assert.strictEqual(r.stdout.includes(`FOREIGN-${other.toUpperCase()}-ADDR`), false,
      `the ${other} identifier never reached the protocol stream`);
  }
});

// Prevents: an upgrade losing the device an existing Mac install already knew,
// which would make the first run after the update scan from scratch.
test('INT-PLAT-05  a legacy plain address is adopted into the platform key only on darwin', async () => {
  const dir = configDirWith('plat05', { address: 'LEGACY-PLAIN-ADDR', name: 'SSW533' });
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');

  if (IS_DARWIN) {
    assert.deepStrictEqual(hello.device,
      { name: 'SSW533', address: 'LEGACY-PLAIN-ADDR', remembered: true },
      'on macOS the old key is where that UUID was written, so it is adopted');
  } else {
    assert.strictEqual(hello.device, null,
      'off macOS a bare address is of unknown origin and must not be adopted');
  }
});

// Prevents: the migration leaving a duplicate behind on macOS, and — the far
// worse half — a Windows run deleting the only copy of a Mac's remembered
// device from a config the two machines share.
test('INT-PLAT-06  a write after reading a legacy config migrates on darwin and preserves elsewhere', async () => {
  const dir = configDirWith('plat06', { address: 'LEGACY-PLAIN-ADDR', name: 'SSW533' });
  const r = await H.measureOnce({ env: { BODYSCALE_CONFIG_DIR: dir } });
  assert.strictEqual(r.terminal.type, 'measurement', 'the replay produced a reading');
  const saved = readSaved(dir);

  assert.strictEqual(saved[ADDRESS_KEY], REPLAY_ADDRESS,
    'the platform key holds the device this run actually found');
  if (IS_DARWIN) {
    assert.strictEqual('address' in saved, false,
      'the legacy key was consumed by the migration, not duplicated');
  } else {
    assert.strictEqual(saved.address, 'LEGACY-PLAIN-ADDR',
      'off macOS the legacy key is left exactly as it was found');
  }
});

// Prevents: the data loss the migration is guarded against. A config that
// already has this platform's key must not have the legacy one stripped, or a
// single Windows run erases the Mac's remembered device for good.
test('INT-PLAT-07  a legacy address alongside a platform key survives a write untouched', async () => {
  const dir = configDirWith('plat07', {
    address: 'MAC-ONLY-LEGACY-UUID',
    [ADDRESS_KEY]: 'ALREADY-KEYED-ADDR',
    name: 'SSW533',
  });

  const r = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'F1', cmd: 'forget' }); return false; }
      return ev.type === 'forgotten' && ev.id === 'F1';
    },
  });
  assert.ok(r.events.find((e) => e.type === 'forgotten' && e.id === 'F1'), 'the forget was answered');

  const hello = H.first(r.events, 'hello');
  assert.strictEqual(hello.device.address, 'ALREADY-KEYED-ADDR',
    'the platform key wins while both are present');

  const saved = readSaved(dir);
  assert.strictEqual(saved.address, 'MAC-ONLY-LEGACY-UUID',
    'the legacy key is still there, byte for byte, after a rewrite');
  assert.strictEqual(ADDRESS_KEY in saved, false, 'only this platform key was forgotten');
});

// Prevents: the service quietly becoming the owner of the person's details.
// The host sends age, height and sex on every measure; a copy kept here would
// go stale, and would be a body-composition profile sitting in a plain file.
test('INT-PLAT-08  the profile is never persisted, and an existing one is left alone', async () => {
  const dir = configDirWith('plat08', {
    profile: { sex: 'female', age: 22, heightCm: 155 },
    name: 'OLD-NAME',
    [ADDRESS_KEY]: 'OLD-SAVED-ADDRESS',
  });

  const r = await H.measureOnce({ env: { BODYSCALE_CONFIG_DIR: dir } });
  assert.strictEqual(r.terminal.type, 'measurement');
  assert.deepStrictEqual(r.terminal.profile, { sex: 'male', age: 39, heightCm: 180 },
    'the reply echoes the profile the host sent, not the one in the file');

  const saved = readSaved(dir);
  // The service neither writes a profile nor removes one. The terminal tool
  // owns that key, and deleting it silently reset a real user's age and height.
  assert.ok('profile' in saved, 'an existing profile survives a service measurement');
  for (const leaked of ['age', 'heightCm', 'sex', 'weightKg']) {
    assert.strictEqual(leaked in saved, false, `${leaked} was not persisted at the top level either`);
  }
  // The device identity is the one thing that is meant to survive.
  assert.strictEqual(saved[ADDRESS_KEY], REPLAY_ADDRESS, 'the device address was updated and kept');
  assert.strictEqual(saved.name, H.EXPECTED.name, 'the device name was updated and kept');
  // The service adds nothing but the device identity. The profile key is
  // present only because it was already there; the service never created it.
  assert.deepStrictEqual(Object.keys(saved).sort(), [ADDRESS_KEY, 'name', 'profile'].sort(),
    'the service added the device identity and nothing else of its own');
  assert.deepStrictEqual(saved.profile, { sex: 'female', age: 22, heightCm: 155 },
    'and the pre-existing profile is byte-identical, neither read nor rewritten');
});

// Prevents: a locked-down Windows install failing silently — the config write
// dies, the app still measures, and nobody ever learns why every launch takes a
// full scan.
test('INT-PLAT-09  an unwritable config file is reported on stderr and the measurement still succeeds',
  { skip: CHMOD_WORKS ? false : 'file permissions are not enforced here' }, async () => {
    const dir = configDirWith('plat09', {});
    const file = path.join(dir, CONFIG_NAME);
    // The file must be read-only, not just the directory: a directory's write
    // bit governs creating and removing entries, not rewriting one in place.
    fs.chmodSync(file, 0o444);
    fs.chmodSync(dir, 0o555);
    try {
      const r = await H.measureOnce({ env: { BODYSCALE_CONFIG_DIR: dir } });

      assert.strictEqual(r.terminal.type, 'measurement', 'the reading is delivered anyway');
      assert.strictEqual(r.terminal.measured.weightKg, H.EXPECTED.weightKg);
      assert.ok(r.stderr.includes(`could not save config to ${file}`),
        `stderr names the file it could not write; got: ${r.stderr}`);
      assert.match(r.stderr, /will not be remembered/,
        'stderr says what the user loses, not just that a write failed');
      assert.deepStrictEqual(readSaved(dir), {}, 'the config on disk is untouched');
      assert.deepStrictEqual(listConfigDir(dir), [CONFIG_NAME],
        'and no half-written temporary file was left behind');
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(file, 0o644);
    }
  });

// Prevents: forget on one machine wiping the identifiers the other platforms
// learned, when the config is shared between a Mac and a PC.
test('INT-PLAT-10  forget removes only this platform key and leaves the others alone', async () => {
  const config = { name: 'SSW533', [ADDRESS_KEY]: 'THIS-PLATFORM-ADDR' };
  for (const other of OTHER_PLATFORMS) config[`address_${other}`] = `KEEP-${other}`;
  const dir = configDirWith('plat10', config);

  const r = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'F1', cmd: 'forget' }); return false; }
      if (ev.type === 'forgotten' && ev.id === 'F1') { send({ id: 'S1', cmd: 'status' }); return false; }
      return ev.type === 'status' && ev.id === 'S1';
    },
  });

  const hello = H.first(r.events, 'hello');
  assert.strictEqual(hello.device.address, 'THIS-PLATFORM-ADDR', 'it knew the device to begin with');
  const status = r.events.find((e) => e.type === 'status' && e.id === 'S1');
  assert.strictEqual(status.device, null, 'and has forgotten it afterwards');

  const saved = readSaved(dir);
  assert.strictEqual(ADDRESS_KEY in saved, false, 'this platform key is gone');
  for (const other of OTHER_PLATFORMS) {
    assert.strictEqual(saved[`address_${other}`], `KEEP-${other}`,
      `the ${other} identifier was left alone`);
  }
});

/* ==================================================== transport discovery ==
 *
 * Which interpreter runs ble.py, and what happens when the obvious one is a
 * relic of the machine that built the installer.
 */

// Prevents: a build that ships a .venv made on the build machine preferring it
// on the user's PC, then failing at measure time — after the person is already
// standing on the scale — instead of at start-up.
test('INT-PLAT-11  a virtualenv built on another machine is refused by name and the service still measures', async () => {
  const tree = copyTree('plat11');
  makeVenv(tree, 'home = /definitely/not/here/bin\nversion = 3.11.15\n', '');

  const r = await measureWith({
    script: tree.script,
    cwd: tree.dir,
    configDir: emptyConfigDir('plat11cfg'),
    replay: tree.replay,
  });

  assert.match(r.stderr, /built on another machine/,
    `the refusal is explained on stderr; got: ${r.stderr}`);
  assert.ok(r.stderr.includes(tree.venvPython), 'and names the interpreter it refused');
  assert.strictEqual(settledAs(r), 'measurement',
    'refusing the venv is not fatal: the run carries on');
  assert.strictEqual(r.terminal.measured.weightKg, H.EXPECTED.weightKg);
});

// Prevents: the Windows installer's fallback never being reached — a refused
// venv that ended the search would leave a machine with a perfectly good
// interpreter on PATH unable to measure at all.
test('INT-PLAT-12  after refusing the venv the search falls through to a working interpreter and reads the scale',
  { skip: POSIX_ONLY }, async () => {
    const tree = copyTree('plat12');
    makeVenv(tree, 'home = /definitely/not/here/bin\nversion = 3.11.15\n', '');
    const onPath = stubOnPath('plat12path', workingStubBody('7.7.7', tree.replay));

    // replay is undefined: this is the real transport path, satisfied by a stub
    // interpreter that speaks ble.py's protocol. No radio is involved.
    const r = await measureWith({
      script: tree.script,
      cwd: tree.dir,
      configDir: emptyConfigDir('plat12cfg'),
      env: withPath(onPath),
    });

    assert.match(r.stderr, /built on another machine/, 'the venv was refused');
    assert.match(r.stderr, /transport ok: python 7\.7\.7, bleak 7\.7\.7/,
      `the fallback interpreter answered the self-test; got: ${r.stderr}`);
    assert.strictEqual(settledAs(r), 'measurement', 'a reading arrived through the fallback');
    assert.strictEqual(r.terminal.measured.weightKg, H.EXPECTED.weightKg);
    assert.strictEqual(r.terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
    assert.strictEqual(r.terminal.device.address, REPLAY_ADDRESS);
  });

// Prevents: the relocation check becoming over-eager and rejecting the venv
// that setup-win.ps1 just built on this very machine, which would break every
// correct install.
test('INT-PLAT-13  a virtualenv whose home exists is used, not refused',
  { skip: POSIX_ONLY }, async () => {
    const tree = copyTree('plat13');
    // A home that exists, as it does on the machine that made the venv.
    makeVenv(tree, `home = ${path.dirname(process.execPath)}\nversion = 3.11.15\n`,
      workingStubBody('4.4.4', tree.replay));
    // If the venv were wrongly refused, the search would reach this instead and
    // the measurement would fail as the Microsoft Store placeholder.
    const onPath = stubOnPath('plat13path', STORE_ALIAS_SH);

    const r = await measureWith({
      script: tree.script,
      cwd: tree.dir,
      configDir: emptyConfigDir('plat13cfg'),
      env: withPath(onPath),
    });

    assert.doesNotMatch(r.stderr, /built on another machine/, 'a local venv is not refused');
    assert.match(r.stderr, /transport ok: python 4\.4\.4, bleak 4\.4\.4/,
      `the venv interpreter is the one that ran; got: ${r.stderr}`);
    assert.strictEqual(settledAs(r), 'measurement');
    assert.strictEqual(r.terminal.measured.weightKg, H.EXPECTED.weightKg);
  });

// Prevents: an embedded or hand-made environment with no `home =` line being
// thrown away on a guess, when there is nothing to judge it by.
test('INT-PLAT-14  a pyvenv.cfg with no home line is trusted rather than refused',
  { skip: POSIX_ONLY }, async () => {
    const tree = copyTree('plat14');
    makeVenv(tree, 'version = 3.11.15\ninclude-system-site-packages = false\n',
      workingStubBody('5.5.5', tree.replay));

    const r = await measureWith({
      script: tree.script,
      cwd: tree.dir,
      configDir: emptyConfigDir('plat14cfg'),
      env: withPath(stubOnPath('plat14path', STORE_ALIAS_SH)),
    });

    assert.doesNotMatch(r.stderr, /built on another machine/,
      'nothing recorded a home, so there is nothing to reject it for');
    assert.match(r.stderr, /transport ok: python 5\.5\.5, bleak 5\.5\.5/,
      `the venv interpreter is the one that ran; got: ${r.stderr}`);
    assert.strictEqual(settledAs(r), 'measurement');
  });

// Prevents: a user with a broken bundled venv having no way out. The documented
// escape hatch has to win outright, before the venv is even considered.
test('INT-PLAT-15  BODYSCALE_PYTHON overrides a broken virtualenv with no refusal at all',
  { skip: POSIX_ONLY }, async () => {
    const tree = copyTree('plat15');
    makeVenv(tree, 'home = /definitely/not/here/bin\nversion = 3.11.15\n',
      workingStubBody('0.0.0', tree.replay));
    const chosen = writeStub(H.tmpdir('plat15py'), 'python3',
      workingStubBody('6.6.6', tree.replay));

    const r = await measureWith({
      script: tree.script,
      cwd: tree.dir,
      configDir: emptyConfigDir('plat15cfg'),
      env: { BODYSCALE_PYTHON: chosen },
    });

    assert.doesNotMatch(r.stderr, /built on another machine/,
      'the venv was never examined, so it was never refused');
    assert.match(r.stderr, /transport ok: python 6\.6\.6, bleak 6\.6\.6/,
      `the override is the interpreter that ran; got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /bleak 0\.0\.0/, 'the venv interpreter never ran');
    assert.strictEqual(settledAs(r), 'measurement');
  });

/* ============================================================== self-test ==
 *
 * The check that runs before anything is promised to the user.
 */

// Prevents: shipping a helper that cannot answer the one question scale.js asks
// it at start-up, which would make every measurement fail as TRANSPORT_FAILED
// on a machine that is in fact perfectly set up.
test('INT-PLAT-16  ble.py --selftest on a healthy interpreter exits 0 and reports a bleak version',
  { skip: NEEDS_PYTHON }, () => {
    const r = spawnSync(PYTHON, [path.join(H.ROOT, 'ble.py'), '--selftest'],
      { encoding: 'utf8', cwd: os.tmpdir(), timeout: 30000 });

    assert.ok(!r.error, `the interpreter ran: ${r.error && r.error.message}`);
    assert.strictEqual(r.status, 0, `--selftest exited 0; stdout: ${r.stdout} stderr: ${r.stderr}`);

    const line = (`${r.stdout}${r.stderr}`).match(/^\{.*"selftest".*\}$/m);
    assert.ok(line, `a single JSON line reports the result; got: ${r.stdout}${r.stderr}`);
    const info = JSON.parse(line[0]);
    assert.strictEqual(info.t, 'selftest');
    assert.strictEqual(info.ok, true, `bleak is importable: ${JSON.stringify(info)}`);
    assert.match(String(info.bleak), /^\d+\.\d+/, 'a real bleak version, not "unknown"');
    assert.match(String(info.python), /^\d+\.\d+/, 'and the interpreter version it ran under');
    assert.strictEqual(typeof info.executable, 'string');
  });

// Prevents: the single most likely Windows failure. With no Python installed,
// `python` still resolves — to the Store App Execution Alias, which spawns
// fine, prints an advert and exits. Without this check the user is told to
// stand on a scale that was never contacted.
test('INT-PLAT-17  the Microsoft Store placeholder is TRANSPORT_FAILED naming the placeholder',
  { skip: POSIX_ONLY }, async () => {
    const alias = writeStub(H.tmpdir('plat17'), 'python3', STORE_ALIAS_SH);

    const r = await H.serve({
      replay: null,                       // the real transport path; the self-test stops it
      env: { BODYSCALE_PYTHON: alias, BODYSCALE_CONFIG_DIR: emptyConfigDir('plat17cfg') },
      onEvent: (ev, send) => {
        if (ev.type === 'hello') {
          send({ id: 'M1', cmd: 'measure', profile: H.PROFILE, scanTimeoutSec: 2 });
          return false;
        }
        return (ev.type === 'error' || ev.type === 'measurement') && ev.id === 'M1';
      },
    });

    const ev = r.events.find((e) => (e.type === 'error' || e.type === 'measurement') && e.id === 'M1');
    assert.strictEqual(ev && ev.type, 'error', `the placeholder cannot measure anything; stderr: ${r.stderr}`);
    assert.strictEqual(ev.code, 'TRANSPORT_FAILED',
      'not NO_READING: the scale was never contacted');
    assert.match(ev.message, /Microsoft Store placeholder/, 'says what the executable really is');
    assert.ok(ev.message.includes(alias), 'names the executable it tried');
    assert.match(ev.message, /python\.org|setup-win\.ps1|BODYSCALE_PYTHON/, 'offers a way out');
    assert.doesNotMatch(ev.message, /stand on|step on|bare feet|metal pads/i,
      'must never send the user to the scale');
    assert.strictEqual(ev.detail.outcome, 'spawn-failed');
    assert.strictEqual(ev.detail.framesSeen, 0, 'nothing was ever read');
    assert.match(r.stderr, /Microsoft Store placeholder/, 'the same explanation reaches the host log');
  });

// Prevents: a half-finished setup (Python present, bleak not) being reported as
// a scale that would not answer, sending the user to the bathroom floor instead
// of to the installer.
test('INT-PLAT-18  an interpreter without bleak is TRANSPORT_FAILED naming bleak',
  { skip: POSIX_ONLY }, async () => {
    const broken = writeStub(H.tmpdir('plat18'), 'python3', NO_BLEAK_SH);

    const r = await H.serve({
      replay: null,
      env: { BODYSCALE_PYTHON: broken, BODYSCALE_CONFIG_DIR: emptyConfigDir('plat18cfg') },
      onEvent: (ev, send) => {
        if (ev.type === 'hello') {
          send({ id: 'M1', cmd: 'measure', profile: H.PROFILE, scanTimeoutSec: 2 });
          return false;
        }
        return (ev.type === 'error' || ev.type === 'measurement') && ev.id === 'M1';
      },
    });

    const ev = r.events.find((e) => (e.type === 'error' || e.type === 'measurement') && e.id === 'M1');
    assert.strictEqual(ev && ev.type, 'error', `stderr: ${r.stderr}`);
    assert.strictEqual(ev.code, 'TRANSPORT_FAILED');
    assert.match(ev.message, /the Bluetooth helper cannot run/);
    assert.match(ev.message, /bleak/, "quotes the interpreter's own reason, which names bleak");
    assert.match(ev.message, /setup-mac\.sh|setup-win\.ps1/, 'names the script that fixes it');
    assert.doesNotMatch(ev.message, /stand on|step on|bare feet/i, 'the person is not the problem');
    assert.strictEqual(ev.detail.outcome, 'spawn-failed');
  });

/* ====================================================== classify_failure ==
 *
 * Windows refuses Bluetooth by raising an exception with no prompt and no
 * signal, so the message text is the only evidence there is. Refusal and a
 * switched-off radio need opposite advice.
 */

// Prevents: a Windows privacy refusal being read as a radio problem, sending
// the user to toggle Bluetooth on when it already is, for ever.
test('INT-PLAT-19  classify_failure maps access-denied texts to permission-denied',
  { skip: NEEDS_PYTHON }, () => {
    const texts = [
      'Access is denied. (0x80070005)',
      'AccessDenied: the app is not allowed to use Bluetooth',
      'Unauthorized',
      'operation not permitted',
      'Bluetooth permission was refused by the system',
    ];
    assert.deepStrictEqual(classify(texts), texts.map(() => 'permission-denied'));
  });

// Prevents: a switched-off radio being reported as a permission refusal, which
// sends the user to a privacy toggle that is already on and cannot help.
test('INT-PLAT-20  classify_failure maps radio-off texts to bluetooth-unavailable',
  { skip: NEEDS_PYTHON }, () => {
    const texts = [
      'Element not found',
      'The device is not ready',
      'Bluetooth device is turned off',
      'WinError -2147023728 (0x80070490)',
      'no such device',
    ];
    assert.deepStrictEqual(classify(texts), texts.map(() => 'bluetooth-unavailable'));
  });

// Prevents: an ordinary failure being dressed up as a permission or radio
// problem, which would hide a real bug behind a Settings page.
test('INT-PLAT-21  classify_failure maps an ordinary failure to error, and the three verdicts differ',
  { skip: NEEDS_PYTHON }, () => {
    const texts = [
      'connection failed',
      'timed out while connecting to the scale',
      'the characteristic could not be subscribed',
    ];
    assert.deepStrictEqual(classify(texts), texts.map(() => 'error'));
    // The three outcomes really are distinguished, not all the same answer.
    assert.deepStrictEqual(
      classify(['Access is denied', 'Element not found', 'connection failed']),
      ['permission-denied', 'bluetooth-unavailable', 'error']);
  });

/* =============================================================== wording ==
 */

// Prevents: the two Windows Settings pages being confused with each other. One
// tells the user to turn the radio on, the other to grant an app permission;
// each is a dead end for the other's problem.
test('INT-PLAT-22  the PERMISSION_DENIED and BLUETOOTH_UNAVAILABLE messages are not interchangeable', async () => {
  const radioOff = await H.measureOnce({
    replay: H.fixture('plat22a', [
      { t: 'end', reason: 'bluetooth-unavailable', detail: 'BleakError: Element not found' }]),
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('plat22a-cfg') },
  });
  const refused = await H.measureOnce({
    replay: H.fixture('plat22b', [
      { t: 'end', reason: 'permission-denied', detail: 'BleakError: Access is denied' }]),
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('plat22b-cfg') },
  });

  assert.strictEqual(radioOff.terminal.code, 'BLUETOOTH_UNAVAILABLE');
  assert.strictEqual(refused.terminal.code, 'PERMISSION_DENIED');
  const off = radioOff.terminal.message, denied = refused.terminal.message;
  assert.notStrictEqual(off, denied, 'two different problems, two different sentences');

  // The radio-off message must not send anyone to a privacy setting.
  assert.doesNotMatch(off, /privacy/i);
  assert.doesNotMatch(off, /desktop apps/i);
  assert.doesNotMatch(off, /refused/i);
  assert.match(off, /switched off|adapter/i, 'it names the radio');

  // The permission message must not tell anyone to stand on the scale, nor to
  // flip a radio switch that is already on.
  assert.doesNotMatch(denied, /stand on|step on|bare feet|metal pads/i);
  assert.doesNotMatch(denied, /switched off/i);
  assert.match(denied, /refused/i, 'it names the refusal');
  assert.match(denied, /bluetooth/i, 'and what was refused');
});

// Prevents: the traceback a user sees on their terminal AFTER a measurement has
// already succeeded. scale.js takes its reading and closes the pipe; the
// transport is still mid-write. One closed pipe used to cascade into three
// separate failures — the final `end` event, the error handler trying to LOG
// that failure down the same dead pipe, and the interpreter's own exit flush
// raising it a third time as "Exception ignored in: <_io.TextIOWrapper>".
// A closed pipe is the normal end of a measurement, not a fault.
test('INT-PLAT-23  the transport exits quietly when its reader goes away mid-write', async (t) => {
  const probeDir = H.tmpdir('pipe');
  const probe = path.join(probeDir, 'probe.py');
  // Import the REAL ble.py and hammer emit() until the reader vanishes.
  fs.writeFileSync(probe, [
    'import importlib.util, sys, time',
    'spec = importlib.util.spec_from_file_location("ble", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'for i in range(100000):',
    '    m.emit(t="frame", uuid="0000ffb2-0000-1000-8000-00805f9b34fb", hex="aa" * 20, n=i)',
    '    time.sleep(0.0005)',
    'm.emit(t="end", reason="finished")',
    '',
  ].join('\n'));

  const python = fs.existsSync(path.join(H.ROOT, 'blehost'))
    ? path.join(H.ROOT, 'blehost') : 'python3';

  const result = await new Promise((resolve) => {
    const child = spawn(python, [probe, path.join(H.ROOT, 'ble.py')],
                        { stdio: ['ignore', 'pipe', 'pipe'], cwd: H.ROOT });
    let lines = 0;
    let stderr = '';
    child.stdout.on('data', (d) => { lines += (d.toString().match(/\n/g) || []).length; });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Let it stream first, so the close genuinely lands mid-write rather than
    // before the process has produced anything.
    const pull = setTimeout(() => child.stdout.destroy(), 500);
    const bail = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 15000);
    child.on('close', (code, signal) => {
      clearTimeout(pull); clearTimeout(bail);
      resolve({ lines, stderr, code, signal });
    });
  });

  assert.ok(result.lines > 10,
    `it was genuinely mid-stream when the reader left, saw ${result.lines} lines`);
  assert.doesNotMatch(result.stderr, /Traceback/,
    `no traceback reached the terminal, got: ${result.stderr.slice(0, 400)}`);
  assert.doesNotMatch(result.stderr, /BrokenPipeError/, 'and no BrokenPipeError');
  assert.doesNotMatch(result.stderr, /Exception ignored/,
    'including the one the interpreter raises during its own exit flush');
  assert.strictEqual(result.signal, null, 'it exited on its own rather than being killed');
  assert.strictEqual(result.code, 0, 'a reader that goes away is a normal end, so exit 0');
});
