'use strict';
/**
 * INT-HS — handshake, lifecycle and process management.
 *
 * The Electron main process spawns `scale.js --serve` once, at start-up, and
 * talks to it for the whole life of the app. Everything here is about that
 * relationship: what the service says before it is asked anything, that it
 * survives whatever the host sends, and that it dies when — and only when — it
 * should. No Bluetooth is involved: every case runs over --replay.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const H = require('./harness');

const PKG = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'package.json'), 'utf8'));

/** scale.js keys the saved address by platform; a Mac UUID means nothing on Windows. */
const ADDRESS_KEY = `address_${process.platform}`;

/** The exact field set of `hello`, which the host parses. */
const HELLO_KEYS = ['proto', 'type', 'app', 'version', 'platform', 'node',
  'device', 'commands', 'errorCodes', 'profile', 'note'];

const POSIX_ONLY = process.platform === 'win32' ? 'ps(1) is POSIX-only' : false;

/*
 * A config directory holding an explicitly empty config.
 *
 * Not a bare empty directory: scale.js falls back to the legacy
 * .scale-config.json beside the script when the per-user one is missing, and a
 * developer machine has one, remembered device and all. Writing `{}` makes the
 * per-user config the one that is found, so these tests see the same state on
 * every machine.
 */
function emptyConfigDir(tag) {
  const dir = H.tmpdir(tag);
  fs.writeFileSync(path.join(dir, 'scale-config.json'), '{}\n');
  return dir;
}

function configDirWith(tag, config) {
  const dir = H.tmpdir(tag);
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify(config, null, 2) + '\n');
  return dir;
}

function readSavedConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
}

/**
 * A replay session long enough to still be running while the test looks at it:
 * device and ready arrive early, then it dawdles.
 */
function slowFixture(tag) {
  const events = [
    { t: 'log', level: 'info', msg: 'replaying a deliberately slow session' },
    { t: 'device', name: 'SSW533', address: 'HS-TEST-ADDRESS' },
    { t: 'ready' },
  ];
  for (let i = 0; i < 40; i++) events.push({ t: 'log', level: 'info', msg: `holding ${i}` });
  return H.fixture(tag, events);
}

/**
 * A service the test keeps a handle on.
 *
 * H.serve() drives a session to completion, which is what most integration
 * tests want; the cases below need the pipe and the process itself — to close
 * stdin, to signal it, to look it up in the process table — so they spawn the
 * same command line the harness does and hold on to the child.
 */
function spawnService({ configDir, replay = H.FIXTURE, env = {}, args = [] } = {}) {
  const argv = [H.SCALE, '--serve'];
  if (replay) argv.push('--replay', replay);
  argv.push(...args);
  const child = spawn(process.execPath, argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: H.ROOT,
    env: Object.assign({}, process.env,
      { BODYSCALE_CONFIG_DIR: configDir || emptyConfigDir('svc') }, env),
  });

  const state = {
    child, events: [], stdout: '', stderr: '', waiters: new Set(),
    exit: new Promise((res) => child.on('close', (code, signal) => res({ code, signal }))),
  };
  let buffer = '';
  child.stdin.on('error', () => { /* the far end may already be gone */ });
  child.stderr.on('data', (d) => { state.stderr += d.toString(); });
  child.stdout.on('data', (d) => {
    const text = d.toString();
    state.stdout += text;
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);            // a non-JSON line must break the test
      state.events.push(ev);
      for (const w of Array.from(state.waiters)) w(ev);
    }
  });

  state.send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { /* gone */ } };
  state.stop = () => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } };
  state.waitFor = (label, pred, ms = 15000) => {
    const already = state.events.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waiters.delete(watcher);
        reject(new Error(`timed out waiting for ${label}; saw [${state.events.map((e) => e.type).join(', ')}]`));
      }, ms);
      const watcher = (ev) => {
        if (!pred(ev)) return;
        clearTimeout(timer);
        state.waiters.delete(watcher);
        resolve(ev);
      };
      state.waiters.add(watcher);
    });
  };
  /** Resolves once the service has answered something, so its handlers are installed. */
  state.settle = async (id) => {
    state.send({ id, cmd: 'status' });
    return state.waitFor(`status ${id}`, (e) => e.type === 'status' && e.id === id);
  };
  return state;
}

/** Run the CLI to completion and collect both streams. */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [H.SCALE, ...args], {
      cwd: H.ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: emptyConfigDir('cli') }, env),
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

/** Process-table lines whose command mentions `needle`. */
function processesMentioning(needle) {
  const out = execFileSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(needle));
}

async function waitUntil(label, pred, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------- handshake

// Prevents: the Electron app hanging on start-up with a blank scale panel
// because it was waiting for a greeting that only arrives if it asks first.
test('INT-HS-01  hello is emitted unprompted and is the first line on stdout', async () => {
  const svc = spawnService({ configDir: emptyConfigDir('hs01') });
  try {
    const hello = await svc.waitFor('hello', (e) => e.type === 'hello');
    // Nothing has been written to the child's stdin at this point.
    assert.strictEqual(svc.events.length, 1, 'hello arrived before anything else');
    assert.strictEqual(svc.events[0], hello);
    const firstLine = svc.stdout.split('\n')[0];
    assert.strictEqual(JSON.parse(firstLine).type, 'hello', 'the very first byte-run is the hello object');
  } finally {
    svc.stop();
    await svc.exit;
  }
});

// Prevents: a host that reads hello.version or hello.platform to decide how to
// behave getting undefined, or a renamed field silently breaking the greeting
// the whole session is built on.
test('INT-HS-02  hello carries exactly its documented fields, with the right types and identity', async () => {
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs02') },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');
  assert.ok(hello, 'a hello was emitted');

  assert.deepStrictEqual(Object.keys(hello).slice().sort(), HELLO_KEYS.slice().sort(),
    'hello has exactly the fields the host is promised, no more and no fewer');
  H.assertShape(assert, hello, {
    proto: 'number', type: 'string', app: 'string', version: 'string',
    platform: 'string', node: 'string', commands: 'array', errorCodes: 'array',
    profile: 'object', note: 'string',
  }, 'hello');

  assert.strictEqual(hello.proto, 1, 'protocol version 1');
  assert.strictEqual(hello.type, 'hello');
  assert.strictEqual(hello.app, 'bodyscale');
  assert.strictEqual(hello.version, PKG.version, 'the version is package.json\'s, not the 0.0.0 fallback');
  assert.strictEqual(hello.platform, process.platform);
  assert.strictEqual(hello.node, process.versions.node);
  assert.ok(hello.note.length > 0, 'the note is not an empty string');
  assert.ok(!('id' in hello), 'hello answers no request, so it carries no id');
});

// Prevents: the Electron app offering a button for a command the service does
// not have, or hiding one it does — the command list is the host's menu.
test('INT-HS-03  hello declares the six commands the service accepts', async () => {
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs03') },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');
  assert.deepStrictEqual(hello.commands, ['measure', 'compute', 'cancel', 'status', 'forget', 'shutdown']);
});

// Prevents: the host writing a message for an error code the service can emit
// but never advertised, so a real failure reaches the user as "undefined".
test('INT-HS-04  hello declares every error code the service can emit', async () => {
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs04') },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');
  assert.deepStrictEqual(hello.errorCodes, H.ALL_ERROR_CODES,
    'the advertised codes are exactly the eleven the contract lists, in order');
  assert.strictEqual(new Set(hello.errorCodes).size, hello.errorCodes.length, 'no duplicates');
});

// Prevents: a host assuming the service remembers who is standing on the scale,
// shipping an app that measures the wrong person after the first profile edit.
test('INT-HS-05  hello states that the host owns the profile and the service never keeps it', async () => {
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs05') },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');
  H.assertShape(assert, hello.profile, {
    required: 'boolean', suppliedBy: 'string', fields: 'array',
    persisted: 'boolean', note: 'string',
  }, 'hello.profile');
  assert.strictEqual(hello.profile.required, true);
  assert.strictEqual(hello.profile.suppliedBy, 'host');
  assert.strictEqual(hello.profile.persisted, false);
  assert.deepStrictEqual(hello.profile.fields, ['age', 'heightCm', 'sex']);
  assert.match(hello.profile.note, /never stores/);
  assert.match(hello.profile.note, /never defaults/);
  // The greeting must not leak a remembered person, only a remembered device.
  assert.strictEqual(hello.profile.age, undefined);
  assert.strictEqual(hello.profile.heightCm, undefined);
  assert.strictEqual(hello.profile.sex, undefined);
});

// Prevents: a first-run app showing "connected to SSW533" for a scale it has
// never seen, instead of telling the user to step on it so it can be found.
test('INT-HS-06  hello.device is null when no device has been remembered', async () => {
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs06') },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');
  assert.strictEqual(hello.device, null, 'no saved address means no device block at all');
});

// Prevents: the app re-scanning on every launch because it cannot tell that the
// service already knows the scale's address — a slow, avoidable wait.
test('INT-HS-07  a remembered device is reported in hello.device, marked remembered', async () => {
  const dir = configDirWith('hs07', { [ADDRESS_KEY]: 'HS-07-SAVED-ADDRESS', name: 'SSW533' });
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev) => ev.type === 'hello',
  });
  const hello = H.first(events, 'hello');
  assert.deepStrictEqual(hello.device,
    { name: 'SSW533', address: 'HS-07-SAVED-ADDRESS', remembered: true });
});

// Prevents: the scale being forgotten between app launches, so every session
// starts with a full scan even though the device was found minutes ago.
test('INT-HS-08  a device learned during a measurement is greeted by the next service instance', async () => {
  const dir = emptyConfigDir('hs08');

  const firstHello = H.first((await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  })).events, 'hello');
  assert.strictEqual(firstHello.device, null, 'the first instance knew nothing');

  const saved = readSavedConfig(dir);
  assert.strictEqual(saved[ADDRESS_KEY], 'BEECC6EC-BD30-3EAC-B148-4833628A8A58');
  assert.strictEqual(saved.name, H.EXPECTED.name);

  const secondHello = H.first((await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev) => ev.type === 'hello',
  })).events, 'hello');
  assert.deepStrictEqual(secondHello.device, {
    name: H.EXPECTED.name,
    address: 'BEECC6EC-BD30-3EAC-B148-4833628A8A58',
    remembered: true,
  });
});

// ---------------------------------------------------------------- lifecycle

// Prevents: a stray console.log or a progress line landing on stdout and
// crashing the host's JSON.parse in the middle of a measurement.
test('INT-HS-09  every stdout line is one protocol object; human diagnostics go to stderr', async () => {
  const { stdout, stderr, events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs09') },
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw('this line is not JSON at all');
        send({ id: 'q', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'q';
    },
  });
  const known = new Set([...H.TERMINAL, ...H.STREAMING, 'hello']);
  const lines = stdout.split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 4, `expected a real session, saw ${lines.length} line(s)`);
  for (const line of lines) {
    const obj = JSON.parse(line);                 // throws, and fails the test, on anything else
    assert.strictEqual(obj.proto, 1, `every line carries proto 1: ${line}`);
    assert.ok(known.has(obj.type), `known event type, got ${obj.type}`);
  }
  assert.ok(H.first(events, 'measurement'), 'the session really did produce a measurement');

  // The commentary exists, and none of it reached the protocol channel.
  assert.match(stderr, /device SSW533 at BEECC6EC-BD30-3EAC-B148-4833628A8A58/);
  assert.ok(!stdout.includes('device SSW533 at'), 'diagnostics never appear on stdout');
});

// Prevents: one bad request from the renderer killing the service, leaving the
// app unable to weigh anything until it is restarted.
test('INT-HS-10  the service survives a run of good, unknown and malformed input and keeps answering', async () => {
  const dir = configDirWith('hs10', { [ADDRESS_KEY]: 'HS-10-OLD-ADDRESS', name: 'OLD' });
  const { events, code } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        send({ id: 'a', cmd: 'status' });
        send({ id: 'b', cmd: 'levitate' });
        raw('{ not json');
        send({ id: 'c', cmd: 'forget' });
        send({ id: 'd', cmd: 'cancel' });
        send({ id: 'e', cmd: 'status' });
        send({ id: 'f', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      if (ev.type === 'measurement' && ev.id === 'f') { send({ id: 'g', cmd: 'status' }); return false; }
      if (ev.type === 'status' && ev.id === 'g') { send({ id: 'h', cmd: 'shutdown' }); return false; }
      return false;
    },
  });

  const settled = events.filter((e) => e.type !== 'progress' && e.type !== 'accepted');
  assert.deepStrictEqual(settled.map((e) => `${e.type}:${e.id === undefined ? '-' : e.id}`), [
    'hello:-',
    'status:a',        // answered
    'error:b',         // unknown command, not fatal
    'error:null',      // malformed line, no id to echo
    'forgotten:c',
    'error:d',         // nothing to cancel
    'status:e',
    'measurement:f',   // still able to do real work afterwards
    'status:g',
    'bye:h',
  ], 'every request was answered once, in order, with its own id echoed');

  const reply = (id) => settled.find((e) => e.id === id);
  assert.strictEqual(reply('b').code, 'UNKNOWN_COMMAND', 'an unknown command is reported, not fatal');
  assert.strictEqual(settled[3].code, 'BAD_REQUEST', 'the unparseable line was reported with a null id');
  assert.strictEqual(reply('d').code, 'BAD_REQUEST', 'cancelling nothing is a bad request');
  assert.strictEqual(reply('e').device, null, 'forget really dropped the old address');
  assert.strictEqual(reply('g').device.address, 'BEECC6EC-BD30-3EAC-B148-4833628A8A58',
    'the measurement taught it the new address');
  assert.strictEqual(reply('g').busy, false, 'idle again once the measurement settled');
  assert.strictEqual(code, 0);
});

// Prevents: the app closing while the service lingers, or a shutdown that is
// answered with nothing so the host waits for a reply that never comes.
test('INT-HS-11  shutdown answers bye, emits nothing further, and the process exits 0', async () => {
  const { events, code } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs11') },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'SD', cmd: 'shutdown' }); }
      return false;                                // let the service end itself
    },
  });
  assert.deepStrictEqual(events.map((e) => e.type), ['hello', 'bye'],
    'nothing was written after bye');
  assert.strictEqual(events[1].id, 'SD', 'bye echoes the shutdown request id');
  assert.strictEqual(code, 0, 'a clean exit, so Electron sees no crash');
});

// Prevents: a host assuming the stream goes silent the instant it sends
// shutdown, and treating the reply to an already-queued command as a protocol
// violation. Work already in the pipe is still answered, after bye.
test('INT-HS-12  a request queued behind shutdown in the same write is still answered after bye', async () => {
  const { events, code } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs12') },
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw('{"id":"SD","cmd":"shutdown"}\n{"id":"AFTER","cmd":"status"}');
      }
      return false;
    },
  });
  assert.deepStrictEqual(events.map((e) => `${e.type}:${e.id === undefined ? '-' : e.id}`),
    ['hello:-', 'bye:SD', 'status:AFTER'],
    'bye is not a hard stop: the line behind it in the same chunk is still served');
  assert.strictEqual(code, 0);
});

// Prevents: quitting the app mid-weigh-in leaving a measurement running, or the
// host being handed a result for a session the user has already walked away from.
test('INT-HS-13  shutdown during a measurement still exits 0 and never delivers a measurement', async () => {
  const { events, code } = await H.serve({
    // The recorded session, played slowly: left alone it settles at 97.9 kg, so
    // the absence of a measurement below is the shutdown's doing, not the
    // fixture's.
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs13'), REPLAY_DELAY_MS: '200' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted') { send({ id: 'SD', cmd: 'shutdown' }); return false; }
      return false;
    },
  });
  assert.ok(H.first(events, 'accepted'), 'the measurement had started');
  const bye = H.first(events, 'bye');
  assert.ok(bye, 'shutdown was still answered while busy');
  assert.strictEqual(bye.id, 'SD');
  assert.strictEqual(H.first(events, 'measurement'), undefined,
    'the abandoned measurement never produced a result');
  assert.strictEqual(code, 0);
});

// ------------------------------------------------------- process management

// Prevents: the single most damaging leak in this design — the Electron app
// closing and leaving scale.js alive, holding the radio, forever.
test('INT-HS-14  closing stdin terminates the service with exit code 0', async () => {
  const svc = spawnService({ configDir: emptyConfigDir('hs14') });
  try {
    await svc.settle('ready-check');              // handlers are installed by now
    svc.child.stdin.end();
    const { code, signal } = await svc.exit;
    assert.strictEqual(code, 0, 'the pipe closing is a normal end, not a crash');
    assert.strictEqual(signal, null, 'it exited on its own, it was not killed');
  } finally {
    svc.stop();
  }
});

// Prevents: the app being closed mid-measurement and leaving the Bluetooth
// helper behind, so the next launch cannot connect to the scale at all.
test('INT-HS-15  closing stdin mid-measurement takes the transport child down too',
  { skip: POSIX_ONLY }, async () => {
    const fixturePath = slowFixture('hs15fx');
    const svc = spawnService({
      configDir: emptyConfigDir('hs15'),
      replay: fixturePath,
      env: { REPLAY_DELAY_MS: '100' },
    });
    try {
      await svc.waitFor('hello', (e) => e.type === 'hello');
      svc.send({ id: 'M', cmd: 'measure', profile: H.PROFILE });
      await svc.waitFor('the transport to be live',
        (e) => e.type === 'progress' && e.phase === 'ready');

      const during = processesMentioning(fixturePath);
      assert.strictEqual(during.length, 2,
        `expected the service and its transport, saw:\n${during.join('\n')}`);
      assert.ok(during.some((l) => l.includes('replay.js')), 'the transport child is running');

      svc.child.stdin.end();
      const { code } = await svc.exit;
      assert.strictEqual(code, 0);
      await waitUntil('the transport child to go away',
        () => processesMentioning(fixturePath).length === 0);
    } finally {
      svc.stop();
    }
  });

// Prevents: a Windows or macOS shutdown of the app hanging on a service that
// ignores the polite kill and has to be forced.
test('INT-HS-16  SIGTERM terminates the service cleanly', async () => {
  const svc = spawnService({ configDir: emptyConfigDir('hs16') });
  try {
    await svc.settle('ready-check');              // the signal handler is installed by now
    svc.child.kill('SIGTERM');
    const { code, signal } = await svc.exit;
    assert.strictEqual(signal, null, 'it handled the signal instead of dying from it');
    assert.strictEqual(code, 0);
  } finally {
    svc.stop();
  }
});

// Prevents: a Ctrl+C in a terminal-launched session leaving the service running
// in the background while the developer thinks it is gone.
test('INT-HS-17  SIGINT terminates the service cleanly', async () => {
  const svc = spawnService({ configDir: emptyConfigDir('hs17') });
  try {
    await svc.settle('ready-check');
    svc.child.kill('SIGINT');
    const { code, signal } = await svc.exit;
    assert.strictEqual(signal, null);
    assert.strictEqual(code, 0);
  } finally {
    svc.stop();
  }
});

// Prevents: a second window, or a relaunch racing a slow exit, breaking the
// first — two services must not fight over one pipe, config or result.
test('INT-HS-18  two service instances run concurrently and each answers its own caller', async () => {
  const run = (tag) => H.serve({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir(tag) },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: tag, cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  const [a, b] = await Promise.all([run('hs18a'), run('hs18b')]);

  for (const [tag, result] of [['hs18a', a], ['hs18b', b]]) {
    const m = H.first(result.events, 'measurement');
    assert.ok(m, `${tag} produced a measurement, not an error`);
    assert.strictEqual(m.id, tag, `${tag} got its own id back`);
    assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
    assert.strictEqual(m.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
    assert.strictEqual(H.first(result.events, 'error'), undefined, `${tag} saw no error`);
  }
});

// Prevents: a second instance being wrongly reported as busy because the two
// share state, so the app refuses to weigh anyone while another window is open.
test('INT-HS-19  a busy service does not make a concurrent second instance busy', async () => {
  const busy = spawnService({
    configDir: emptyConfigDir('hs19a'),
    replay: slowFixture('hs19fx'),
    env: { REPLAY_DELAY_MS: '100' },
  });
  const idle = spawnService({ configDir: emptyConfigDir('hs19b') });
  try {
    await busy.waitFor('hello', (e) => e.type === 'hello');
    busy.send({ id: 'M', cmd: 'measure', profile: H.PROFILE });
    await busy.waitFor('the measurement to be live',
      (e) => e.type === 'progress' && e.phase === 'ready');

    const busyStatus = await busy.settle('S-busy');
    assert.strictEqual(busyStatus.busy, true, 'the first instance knows it is measuring');
    assert.strictEqual(busyStatus.runningId, 'M');

    const idleStatus = await idle.settle('S-idle');
    assert.strictEqual(idleStatus.busy, false, 'the second instance is unaffected');
    assert.strictEqual(idleStatus.runningId, null);
    assert.strictEqual(idleStatus.device, null, 'and it did not inherit the other one\'s config');
  } finally {
    busy.stop();
    idle.stop();
    await Promise.all([busy.exit, idle.exit]);
  }
});

// Prevents: a typo in the host's spawn arguments producing help text on the
// protocol channel, which the host would try to parse as JSON, and a service
// that looks like it started but can never measure.
test('INT-HS-20  an unknown option exits non-zero and writes nothing to stdout', async () => {
  const { stdout, stderr, code } = await runCli(['--serve', '--replay', H.FIXTURE, '--bogus']);
  assert.strictEqual(code, 2, 'a rejected option is a failure, not a silent start');
  assert.strictEqual(stdout, '', 'the protocol channel stayed completely empty');
  assert.match(stderr, /unknown option: --bogus/);
  assert.match(stderr, /read a Bluetooth LE body scale/, 'the help went to stderr, where it cannot corrupt stdout');
});

// Prevents: losing the one case where stdout text is legitimate — a human
// asking for help must still get it, and must not be told the run failed.
test('INT-HS-21  --help prints help on stdout and exits 0, even alongside --serve', async () => {
  const plain = await runCli(['--help']);
  assert.strictEqual(plain.code, 0);
  assert.match(plain.stdout, /read a Bluetooth LE body scale/);
  assert.strictEqual(plain.stderr, '', 'help asked for is not a diagnostic');

  const withServe = await runCli(['--serve', '--help']);
  assert.strictEqual(withServe.code, 0, '--help wins over --serve rather than starting a service');
  assert.match(withServe.stdout, /node scale\.js --serve/);
  assert.strictEqual(withServe.stdout.includes('"type":"hello"'), false, 'no protocol was spoken');
});

// Prevents: a "replay" run silently reaching for the real radio, so the test
// suite passes only on a machine with Bluetooth, Python and bleak installed.
test('INT-HS-22  --serve --replay measures without ever consulting the Python transport', async () => {
  const nowhere = path.join(H.tmpdir('hs22py'), 'definitely-not-python');
  assert.ok(!fs.existsSync(nowhere), 'the interpreter path really does not exist');

  const { terminal, stderr } = await H.measureOnce({
    env: { BODYSCALE_CONFIG_DIR: emptyConfigDir('hs22'), BODYSCALE_PYTHON: nowhere },
  });
  // Had the radio path been taken, the self-test would have failed the spawn and
  // this would be a TRANSPORT_FAILED error instead of a reading.
  assert.strictEqual(terminal.type, 'measurement',
    `expected a replayed measurement, got ${JSON.stringify(terminal)}`);
  assert.strictEqual(terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.ok(!/transport ok/.test(stderr), 'the transport self-test never ran');
  assert.ok(!/could not start the transport/.test(stderr), 'nothing tried to start Python');
  assert.ok(!/Bluetooth helper cannot run/.test(stderr));
});

// Prevents: --replay spawning ble.py as well as the recording, which would pop
// the operating system's Bluetooth permission prompt during an automated run.
test('INT-HS-23  the transport under --replay is replay.js, and ble.py is never spawned',
  { skip: POSIX_ONLY }, async () => {
    const fixturePath = slowFixture('hs23fx');
    const svc = spawnService({
      configDir: emptyConfigDir('hs23'),
      replay: fixturePath,
      env: { REPLAY_DELAY_MS: '100' },
    });
    try {
      await svc.waitFor('hello', (e) => e.type === 'hello');
      svc.send({ id: 'M', cmd: 'measure', profile: H.PROFILE });
      await svc.waitFor('the transport to be live',
        (e) => e.type === 'progress' && e.phase === 'ready');

      const involved = processesMentioning(fixturePath);
      assert.strictEqual(involved.length, 2,
        `expected exactly the service and one transport, saw:\n${involved.join('\n')}`);
      assert.strictEqual(involved.filter((l) => l.includes('replay.js')).length, 1,
        'the transport is the recorded session');
      assert.strictEqual(involved.filter((l) => l.includes('ble.py')).length, 0,
        'no Bluetooth helper was started');
    } finally {
      svc.stop();
      await svc.exit;
    }
  });
