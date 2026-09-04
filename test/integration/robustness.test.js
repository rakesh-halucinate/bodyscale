'use strict';
/**
 * INT-ROB — robustness against malformed and hostile input.
 *
 * `scale.js --serve` is a long-lived child of the Electron main process. It has
 * two duties that outrank every other: it must not die because of something a
 * host wrote down the pipe, and it must never put a byte on stdout that is not
 * one complete protocol object. Breaking the first leaves the app unable to
 * weigh anything until it is restarted; breaking the second desynchronises the
 * host's line reader, so every later reply is misparsed or dropped.
 *
 * So each test here writes something hostile and then proves survival the only
 * way a host can: it asks for a `status` and waits for the answer. If the
 * service died, the wait times out and the test fails. Nothing is caught and
 * ignored, and the recorded SSW533 session stands in for the radio throughout,
 * so this file needs no Bluetooth and no scale.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const H = require('./harness');

/* ---------- shared, read-only helpers ---------- */

/** The recorded transport session, parsed. Read only; never mutated by a test. */
const RECORDED = fs.readFileSync(H.FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const READY_AT = RECORDED.findIndex((e) => e.t === 'ready');

/** The recorded session with extra transport events spliced in just after `ready`. */
function splicedFixture(tag, injected) {
  return H.fixture(tag, [
    ...RECORDED.slice(0, READY_AT + 1),
    ...injected,
    ...RECORDED.slice(READY_AT + 1),
  ]);
}

/** Replies to our own requests: drops `hello` and the harness's own shutdown. */
const replies = (events) => events.filter((e) => e.type !== 'hello' && e.id !== '_harness_stop');

/** A compact, comparable summary of everything the service said back. */
const signature = (events) => replies(events).map((e) => [e.id, e.type, e.code || null]);

/** Every stdout line, as text, with the blank trailing one dropped. */
const stdoutLines = (stdout) => stdout.split('\n').filter((l) => l.trim());

/** Event types this protocol may ever put on stdout. */
const KNOWN_TYPES = new Set(['hello', ...H.TERMINAL, ...H.STREAMING]);

/**
 * Write something hostile, then ask for a status.
 *
 * The run only resolves when that status comes back, so a service that died,
 * hung, or silently swallowed the probe fails the test by timing out.
 */
function afterHostileInput(feed, opts = {}) {
  const probeId = opts.probeId || 'ALIVE';
  return H.serve({
    replay: opts.replay || H.FIXTURE,
    timeoutMs: opts.timeoutMs || 20000,
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        feed(send, raw);
        send({ id: probeId, cmd: 'status' });
        return false;
      }
      return ev.type === 'status' && ev.id === probeId;
    },
  }).then((r) => Object.assign(r, {
    probe: r.events.find((e) => e.type === 'status' && e.id === probeId),
  }));
}

/** The probe status must be a real, well-formed, idle status — not a husk. */
function assertAlive(result, where) {
  const probe = result.probe;
  assert.ok(probe, `${where}: a status came back after the hostile input`);
  assert.strictEqual(probe.proto, 1, `${where}: the probe reply carries proto 1`);
  assert.strictEqual(probe.busy, false, `${where}: no request was left stuck running`);
  assert.strictEqual(probe.runningId, null, `${where}: nothing is still marked as running`);
  assert.strictEqual(probe.platform, process.platform, `${where}: the reply is from this process`);
  assert.strictEqual(typeof probe.version, 'string', `${where}: the reply carries a version`);
  assert.ok(probe.version.length > 0, `${where}: the version is not empty`);
  assert.strictEqual(result.code, 0, `${where}: the service shut down cleanly afterwards`);
}

/** Every error the service raised, in order. */
const errorsIn = (events) => events.filter((e) => e.type === 'error');

/**
 * `H.serve`'s `raw()` always appends a newline, so it can never leave a partial
 * line dangling in the pipe. INT-ROB-17 needs exactly that, so it drives the
 * real process directly — the same thing handshake.test.js does for its own
 * lifecycle cases. Every other test in this file goes through the harness.
 */
function rawSession({ onHello, until, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [H.SCALE, '--serve', '--replay', H.FIXTURE], {
      cwd: H.ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: H.tmpdir('rob-raw') }),
    });

    const events = [];
    let stdout = '', stderr = '', buffer = '', settled = false;

    const write = (text) => { try { child.stdin.write(text); } catch (e) { /* gone */ } };
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(
      `timed out after ${timeoutMs} ms; saw: [${events.map((e) => e.type).join(', ')}]`))), timeoutMs);

    child.stdin.on('error', () => { /* the far end may already be gone */ });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); }
        catch (e) { return finish(() => reject(new Error(`stdout carried a non-JSON line: ${line}`))); }
        events.push(ev);
        if (ev.type === 'hello') { onHello(write, events); continue; }
        if (until(ev)) return finish(() => resolve({ events, stdout, stderr }));
      }
    });

    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', () => finish(() => resolve({ events, stdout, stderr })));
  });
}

// ------------------------------------------------------------ malformed lines

// Prevents: a renderer bug, a half-written line or a stray log statement in the
// host putting text down the pipe and killing the scale service, so the app can
// no longer weigh anyone until it is restarted.
test('INT-ROB-01  a line that is not JSON is reported as BAD_REQUEST and the service keeps answering', async () => {
  const junk = [
    'this is not JSON at all',
    '{ unterminated',
    "{'single':'quotes'}",
    '<html><body>oops</body></html>',
    'undefined',
    'NaN',
  ];
  const r = await afterHostileInput((send, raw) => { junk.forEach((line) => raw(line)); });

  assert.deepStrictEqual(
    signature(r.events),
    [...junk.map(() => [null, 'error', 'BAD_REQUEST']), ['ALIVE', 'status', null]],
    'one BAD_REQUEST per unparseable line, with no id to echo, then the probe');
  for (const e of errorsIn(r.events)) {
    assert.strictEqual(e.message, 'not valid JSON', 'the message names the real problem');
    assert.strictEqual(e.id, null, 'a line that would not parse has no id to correlate on');
    assert.strictEqual(e.detail, null, 'the envelope still carries a detail field');
  }
  assertAlive(r, 'INT-ROB-01');
});

// Prevents: an idle keep-alive newline, or the blank line a host writes when a
// buffer flushes early, being answered with a spurious error that the Electron
// app surfaces to the user as a failed measurement.
test('INT-ROB-02  an empty line and a whitespace-only line are ignored in silence', async () => {
  const r = await afterHostileInput((send, raw) => {
    raw('');                 // a bare newline
    raw('   ');              // spaces
    raw('\t\t');             // tabs
    raw('  \r  ');           // a stray carriage return
    raw('\n\n');             // several newlines in one write
  });

  assert.deepStrictEqual(signature(r.events), [['ALIVE', 'status', null]],
    'blank input produced no reply at all, not even an error');
  assert.strictEqual(errorsIn(r.events).length, 0, 'no error was invented for whitespace');
  assertAlive(r, 'INT-ROB-02');
});

// Prevents: a host that accidentally sends a batch as a JSON array having its
// commands silently executed, or the array crashing the switch on `req.cmd`.
test('INT-ROB-03  a JSON array is rejected as not an object, and a command wrapped in one is never run', async () => {
  const r = await afterHostileInput((send, raw) => {
    raw('[1,2,3]');
    raw('[]');
    raw('[{"id":"WRAPPED","cmd":"status"}]');
  });

  assert.deepStrictEqual(signature(r.events), [
    [null, 'error', 'BAD_REQUEST'],
    [null, 'error', 'BAD_REQUEST'],
    [null, 'error', 'BAD_REQUEST'],
    ['ALIVE', 'status', null],
  ], 'each array line drew exactly one BAD_REQUEST');
  for (const e of errorsIn(r.events)) {
    assert.strictEqual(e.message, 'expected a JSON object',
      'an array is typeof object, so the message must say what was really wrong');
  }
  assert.strictEqual(r.events.some((e) => e.id === 'WRAPPED'), false,
    'the command inside the array was never executed');
  assertAlive(r, 'INT-ROB-03');
});

// Prevents: a bare scalar — the shape you get from JSON.stringify of a string,
// a number, or a null the host meant to guard against — reaching the command
// switch and dereferencing a property of null.
test('INT-ROB-04  a JSON string, number, boolean or null as the whole message is a BAD_REQUEST, not a crash', async () => {
  const scalars = ['"a string"', '""', '42', '0', '-1.5e300', 'true', 'false', 'null'];
  const r = await afterHostileInput((send, raw) => { scalars.forEach((line) => raw(line)); });

  assert.deepStrictEqual(
    signature(r.events),
    [...scalars.map(() => [null, 'error', 'BAD_REQUEST']), ['ALIVE', 'status', null]],
    'all eight scalar messages were rejected, including the falsy ones');
  for (const e of errorsIn(r.events)) {
    assert.strictEqual(e.message, 'expected a JSON object', 'the same, accurate message every time');
    assert.strictEqual(e.id, null, 'a scalar carries no id');
  }
  assertAlive(r, 'INT-ROB-04');
});

// Prevents: a request whose `cmd` was lost or mistyped being dropped in silence,
// leaving the Electron client holding a promise that never settles and the UI
// stuck on a spinner.
test('INT-ROB-05  a valid object with no usable cmd is answered UNKNOWN_COMMAND with its id echoed', async () => {
  const r = await afterHostileInput((send) => {
    send({ id: 'NOCMD' });
    send({ id: 'NULLCMD', cmd: null });
    send({ id: 'OBJCMD', cmd: { nested: true } });
    send({ id: 'ARRCMD', cmd: ['status'] });
    send({ id: 'CASECMD', cmd: 'STATUS' });          // commands are case sensitive
    send({ cmd: 'nope' });                            // no id at all
  });

  assert.deepStrictEqual(signature(r.events), [
    ['NOCMD', 'error', 'UNKNOWN_COMMAND'],
    ['NULLCMD', 'error', 'UNKNOWN_COMMAND'],
    ['OBJCMD', 'error', 'UNKNOWN_COMMAND'],
    ['ARRCMD', 'error', 'UNKNOWN_COMMAND'],
    ['CASECMD', 'error', 'UNKNOWN_COMMAND'],
    [null, 'error', 'UNKNOWN_COMMAND'],
    ['ALIVE', 'status', null],
  ], 'every one was settled once, with its own id, and a missing id became null');

  const msg = (id) => r.events.find((e) => e.id === id).message;
  assert.strictEqual(msg('NOCMD'), 'no such command: undefined',
    'the message says the command was absent rather than unrecognised');
  assert.strictEqual(msg('NULLCMD'), 'no such command: null');
  assert.strictEqual(msg('OBJCMD'), 'no such command: [object Object]');
  assert.strictEqual(msg('CASECMD'), 'no such command: STATUS');
  assertAlive(r, 'INT-ROB-05');
});

// ------------------------------------------------------------ extreme shapes

// Prevents: an oversized request — a host that attached a whole photo or a log
// buffer to a command — truncating the pipe or being echoed back into the
// protocol stream and blowing up the host's parser.
test('INT-ROB-06  a several-hundred-kilobyte request is answered, its padding never echoed, and a real measurement still works', async () => {
  const padding = 'x'.repeat(300 * 1024);
  const { events, stdout, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'BIG', cmd: 'status', padding }); return false; }
      if (ev.type === 'status' && ev.id === 'BIG') {
        send({ id: 'M', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      return ev.id === 'M' && (ev.type === 'measurement' || ev.type === 'error');
    },
  });

  const big = events.find((e) => e.id === 'BIG');
  assert.strictEqual(big.type, 'status', 'the 300 KB line was parsed and answered normally');
  assert.strictEqual('padding' in big, false, 'the padding was not echoed back');
  assert.strictEqual(stdout.includes('xxxxxxxxxxxxxxxxxxxx'), false,
    'not one byte of the padding reached the protocol channel');
  assert.ok(stdout.length < 200 * 1024,
    `stdout stayed small (${stdout.length} bytes) instead of mirroring the request`);

  const m = events.find((e) => e.id === 'M' && H.TERMINAL.has(e.type));
  assert.strictEqual(m.type, 'measurement', 'a real measurement still ran afterwards');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(code, 0, 'the service shut down cleanly');
});

// Prevents: a recursive structure from a host's own serialiser overflowing the
// stack inside JSON.parse and taking the service down mid-measurement.
test('INT-ROB-07  deeply nested JSON is parsed without blowing the stack, both as the message and as an ignored field', async () => {
  let deep = 'bottom';
  for (let i = 0; i < 400; i++) deep = { a: deep };

  const r = await afterHostileInput((send) => {
    send(deep);                                       // 400 levels, and no cmd anywhere
    send({ id: 'DEEPFIELD', cmd: 'status', junk: deep });
  });

  assert.deepStrictEqual(signature(r.events), [
    [null, 'error', 'UNKNOWN_COMMAND'],               // an object, but nothing at the top level named cmd
    ['DEEPFIELD', 'status', null],
    ['ALIVE', 'status', null],
  ], 'the deep message was classified, and a deep field on a real command was simply ignored');

  const answered = r.events.find((e) => e.id === 'DEEPFIELD');
  assert.strictEqual('junk' in answered, false, 'the nested field was not echoed back');
  assertAlive(r, 'INT-ROB-07');
});

// Prevents: a newer host sending a field this build does not know about — a
// forward-compatible addition — having its whole command rejected, which would
// break every measurement after an app update.
test('INT-ROB-08  unexpected extra fields on a command are ignored, not rejected', async () => {
  const { events, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'S', cmd: 'status', bogus: 1, futureFlag: true, cmd2: 'shutdown', note: 'hello' });
        return false;
      }
      if (ev.type === 'status' && ev.id === 'S') {
        send({ id: 'M', cmd: 'measure', profile: H.PROFILE,
               unitPreference: 'stones', retries: 3, callbackUrl: 'http://example.invalid' });
        return false;
      }
      return ev.id === 'M' && (ev.type === 'measurement' || ev.type === 'error');
    },
  });

  const status = events.find((e) => e.id === 'S');
  assert.strictEqual(status.type, 'status', 'a status with four unknown fields is still a status');
  assert.deepStrictEqual(Object.keys(status).sort(),
    ['busy', 'device', 'id', 'platform', 'proto', 'runningId', 'type', 'version'],
    'the reply carries exactly the status fields, and none of the unknown ones');
  assert.strictEqual(events.some((e) => e.type === 'bye' && e.id === 'S'), false,
    'a field called cmd2 did not become a second command');

  const m = events.find((e) => e.id === 'M' && H.TERMINAL.has(e.type));
  assert.strictEqual(m.type, 'measurement', 'a measure with unknown fields still measured');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual('unitPreference' in m, false, 'the unknown fields were not reflected into the result');
  assert.strictEqual(code, 0);
});

// Prevents: an id containing a name, an emoji or a quote coming back mangled, so
// the host's pending-request map never finds its entry and the promise for that
// measurement is never settled.
test('INT-ROB-09  unicode, emoji and escape-bearing ids come back byte-identical without breaking framing', async () => {
  const ids = [
    'мера-🎉-✓-Ω',
    '日本語のid',
    '🇬🇧🏳️‍🌈-flags',
    'quote"backslash\\newline\ntab\t',
    { nested: ['🎉', 1] },
  ];
  const r = await afterHostileInput((send) => { ids.forEach((id) => send({ id, cmd: 'status' })); });

  assert.deepStrictEqual(signature(r.events),
    [...ids.map((id) => [id, 'status', null]), ['ALIVE', 'status', null]],
    'every id was echoed back exactly as sent, in order');

  const lines = stdoutLines(r.stdout);
  for (const id of ids) {
    const needle = `"id":${JSON.stringify(id)}`;
    const carrying = lines.filter((l) => l.includes(needle));
    assert.strictEqual(carrying.length, 1,
      `exactly one stdout line carries the raw bytes ${needle}`);
    assert.deepStrictEqual(JSON.parse(carrying[0]).id, id,
      'and that line parses back to the id that was sent');
  }
  assert.strictEqual(lines.filter((l) => l.includes('"type":"status"')).length, ids.length + 1,
    'the id carrying a literal newline did not split its reply across two lines');
  assertAlive(r, 'INT-ROB-09');
});

// Prevents: a scale renamed to something non-ASCII in the app's settings making
// every measurement fail, because the name could not survive the round trip.
test('INT-ROB-10  a unicode deviceName survives the round trip and the measurement still completes', async () => {
  const { events, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'U', cmd: 'measure', profile: H.PROFILE, deviceName: '体重計-🎉-Ω' });
        return false;
      }
      return ev.id === 'U' && (ev.type === 'measurement' || ev.type === 'error');
    },
  });

  const m = events.find((e) => e.id === 'U' && H.TERMINAL.has(e.type));
  assert.strictEqual(m.type, 'measurement', 'the unicode name did not turn into an error');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(m.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(m.device.name, H.EXPECTED.name,
    'the reported name is the one the transport announced, not the one the host asked for');
  assert.strictEqual(code, 0);
});

// ------------------------------------------------------------ hostile profiles

// Prevents: a renderer that reads its form fields as strings — which every HTML
// input does — having every measurement rejected, or worse, having "39" reach
// the arithmetic and produce a body-fat figure computed from string concatenation.
test('INT-ROB-11  a profile whose numbers are numeric strings is accepted and coerced to real numbers', async () => {
  const { events, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'STR', cmd: 'measure', profile: { age: '39', heightCm: '180', sex: 'MALE' } });
        return false;
      }
      return ev.id === 'STR' && (ev.type === 'measurement' || ev.type === 'error');
    },
  });

  const accepted = events.find((e) => e.type === 'accepted' && e.id === 'STR');
  assert.ok(accepted, 'the request was accepted rather than rejected as an invalid profile');
  assert.deepStrictEqual(accepted.profile, { sex: 'male', age: 39, heightCm: 180 },
    'the strings became numbers and the sex was lower-cased');
  assert.strictEqual(typeof accepted.profile.age, 'number');
  assert.strictEqual(typeof accepted.profile.heightCm, 'number');

  const m = events.find((e) => e.id === 'STR' && H.TERMINAL.has(e.type));
  assert.strictEqual(m.type, 'measurement');
  assert.deepStrictEqual(m.profile, { sex: 'male', age: 39, heightCm: 180 },
    'the result echoes the coerced profile, not the strings');
  assert.strictEqual(typeof m.derived.bmi, 'number', 'the arithmetic ran on numbers');
  assert.ok(m.derived.bmi > 25 && m.derived.bmi < 35,
    `BMI for 97.9 kg at 180 cm is plausible, got ${m.derived.bmi}`);
  assert.strictEqual(code, 0);
});

// Prevents: a form field left blank, or a parse that produced the literal text
// "NaN", sailing past validation and reaching the body-composition maths, where
// it would produce a page of nulls instead of an error the user can act on.
test('INT-ROB-12  the strings NaN and Infinity are rejected as an invalid profile, not treated as numbers', async () => {
  const r = await afterHostileInput((send) => {
    send({ id: 'A-NAN', cmd: 'measure', profile: { age: 'NaN', heightCm: 180, sex: 'male' } });
    send({ id: 'A-INF', cmd: 'measure', profile: { age: 'Infinity', heightCm: 180, sex: 'male' } });
    send({ id: 'A-NEGINF', cmd: 'measure', profile: { age: '-Infinity', heightCm: 180, sex: 'male' } });
    send({ id: 'H-INF', cmd: 'measure', profile: { age: 39, heightCm: 'Infinity', sex: 'male' } });
    send({ id: 'A-EMPTY', cmd: 'measure', profile: { age: '', heightCm: 180, sex: 'male' } });
  });

  assert.deepStrictEqual(signature(r.events), [
    ['A-NAN', 'error', 'INVALID_PROFILE'],
    ['A-INF', 'error', 'INVALID_PROFILE'],
    ['A-NEGINF', 'error', 'INVALID_PROFILE'],
    ['H-INF', 'error', 'INVALID_PROFILE'],
    ['A-EMPTY', 'error', 'INVALID_PROFILE'],
    ['ALIVE', 'status', null],
  ], 'every unreal number was refused before anything was spawned');

  const msg = (id) => r.events.find((e) => e.id === id).message;
  assert.strictEqual(msg('A-NAN'), 'age must be a number between 5 and 120');
  assert.strictEqual(msg('A-INF'), 'age must be a number between 5 and 120');
  assert.strictEqual(msg('H-INF'), 'heightCm must be a number between 90 and 250',
    'the message names the field that was wrong');
  assert.strictEqual(r.events.some((e) => e.type === 'accepted'), false,
    'no measurement was ever accepted, so no radio work was started');
  assertAlive(r, 'INT-ROB-12');
});

// Prevents: the app sending a measure before the user has filled in a profile
// and getting an unexplained INTERNAL error, or a crash, instead of the one
// message that tells the user what to do.
test('INT-ROB-13  a null, missing or non-object profile is INVALID_PROFILE with a message that says so', async () => {
  const r = await afterHostileInput((send) => {
    send({ id: 'P-NULL', cmd: 'measure', profile: null });
    send({ id: 'P-ABSENT', cmd: 'measure' });
    send({ id: 'P-STRING', cmd: 'measure', profile: 'male,39,180' });
    send({ id: 'P-NUMBER', cmd: 'measure', profile: 42 });
    send({ id: 'P-FALSE', cmd: 'measure', profile: false });
  });

  assert.deepStrictEqual(signature(r.events), [
    ['P-NULL', 'error', 'INVALID_PROFILE'],
    ['P-ABSENT', 'error', 'INVALID_PROFILE'],
    ['P-STRING', 'error', 'INVALID_PROFILE'],
    ['P-NUMBER', 'error', 'INVALID_PROFILE'],
    ['P-FALSE', 'error', 'INVALID_PROFILE'],
    ['ALIVE', 'status', null],
  ], 'each one settled once as an invalid profile');
  for (const e of errorsIn(r.events)) {
    assert.strictEqual(e.message, 'profile is required',
      'the message is the one a user can act on, not a stack trace');
  }
  assertAlive(r, 'INT-ROB-13');
});

// Prevents: a host that sends its profile positionally, as an array, getting an
// unhandled property access instead of a named validation failure.
test('INT-ROB-14  a profile sent as an array is rejected, and the message names the field it could not find', async () => {
  const r = await afterHostileInput((send) => {
    send({ id: 'P-ARR', cmd: 'measure', profile: ['male', 39, 180] });
    send({ id: 'P-EMPTYARR', cmd: 'measure', profile: [] });
  });

  assert.deepStrictEqual(signature(r.events), [
    ['P-ARR', 'error', 'INVALID_PROFILE'],
    ['P-EMPTYARR', 'error', 'INVALID_PROFILE'],
    ['ALIVE', 'status', null],
  ], 'both arrays were refused');
  for (const e of errorsIn(r.events)) {
    // An array is typeof 'object' and truthy, so it clears the first check and
    // fails on the fields it does not have. That is what the code does today.
    assert.strictEqual(e.message, 'age must be a number between 5 and 120',
      'the failure is reported against the missing field, not as "profile is required"');
  }
  assert.strictEqual(r.events.some((e) => e.type === 'accepted'), false,
    'nothing was accepted, so no transport was spawned for an array profile');
  assertAlive(r, 'INT-ROB-14');
});

// Prevents: extra personal data a host attaches to the profile — a name, a
// previous weight, an account id — being carried into the result or written to
// disk. The service's contract is that it handles exactly three fields.
test('INT-ROB-15  a profile with extra unknown fields is accepted, and only age, heightCm and sex come back', async () => {
  const { events, stdout, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'X', cmd: 'measure', profile: {
          age: 39, heightCm: 180, sex: 'male',
          name: 'Ada Lovelace', email: 'ada@example.invalid',
          weightKg: 200, athlete: true, previous: { weightKg: 99 },
        } });
        return false;
      }
      return ev.id === 'X' && (ev.type === 'measurement' || ev.type === 'error');
    },
  });

  const accepted = events.find((e) => e.type === 'accepted' && e.id === 'X');
  assert.ok(accepted, 'the extra fields did not make the profile invalid');
  assert.deepStrictEqual(Object.keys(accepted.profile).sort(), ['age', 'heightCm', 'sex'],
    'the echoed profile is exactly the three host fields');

  const m = events.find((e) => e.id === 'X' && H.TERMINAL.has(e.type));
  assert.strictEqual(m.type, 'measurement');
  assert.deepStrictEqual(m.profile, { sex: 'male', age: 39, heightCm: 180 },
    'the result carries the three fields and nothing else');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg,
    'the supplied weightKg was ignored in favour of the real reading');
  assert.strictEqual(stdout.includes('Ada Lovelace'), false, 'the extra name never reached stdout');
  assert.strictEqual(stdout.includes('ada@example.invalid'), false, 'nor the extra email');
  assert.strictEqual(code, 0);
});

// ------------------------------------------------------------ framing

// Prevents: a host that batches its writes losing every command but the first,
// so a measurement request queued behind a status is silently dropped.
test('INT-ROB-16  two complete commands written in one stdin write are both answered', async () => {
  const r = await afterHostileInput((send, raw) => {
    raw('{"id":"F1","cmd":"status"}\n{"id":"F2","cmd":"status"}');
    raw('{"id":"F3","cmd":"status"}\n\n   \n{"id":"F4","cmd":"status"}');
  });

  assert.deepStrictEqual(signature(r.events), [
    ['F1', 'status', null],
    ['F2', 'status', null],
    ['F3', 'status', null],
    ['F4', 'status', null],
    ['ALIVE', 'status', null],
  ], 'both commands in each write were answered, in order, and the blank filler was ignored');
  assert.strictEqual(errorsIn(r.events).length, 0, 'no error was raised for the batched writes');
  assertAlive(r, 'INT-ROB-16');
});

// Prevents: a command that arrives in two TCP-sized chunks being answered twice,
// or answered as two BAD_REQUESTs, because the reader did not buffer the partial
// line until its newline arrived.
test('INT-ROB-17  a command split across two stdin writes is answered exactly once, when the newline arrives', async () => {
  let seenBeforeTail = null;
  const r = await rawSession({
    onHello: (write, events) => {
      write('{"id":"SPLIT","cmd":"stat');
      setTimeout(() => {
        seenBeforeTail = events.length;      // still just `hello` if the half line was buffered
        write('us"}\n');
      }, 500);
    },
    until: (ev) => ev.type === 'status' && ev.id === 'SPLIT',
  });

  assert.strictEqual(seenBeforeTail, 1,
    'half a command produced no reply at all while its newline was outstanding');
  assert.deepStrictEqual(r.events.map((e) => e.type), ['hello', 'status'],
    'exactly one reply, and no BAD_REQUEST for the fragment');
  const status = r.events[1];
  assert.strictEqual(status.id, 'SPLIT', 'the reassembled command kept its id');
  assert.strictEqual(status.proto, 1);
  assert.strictEqual(status.busy, false);
});

// Prevents: a burst of requests — the app polling status while a measurement
// runs, or a re-render firing every handler at once — overflowing the pipe and
// losing or duplicating replies, which desynchronises the host's pending map.
test('INT-ROB-18  two hundred status commands sent rapidly are each answered exactly once', async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `L${i}`);
  const { events, stdout, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { ids.forEach((id) => send({ id, cmd: 'status' })); return false; }
      return ev.type === 'status' && ev.id === 'L199';
    },
  });

  const answered = replies(events).filter((e) => e.type === 'status');
  assert.deepStrictEqual(answered.map((e) => e.id), ids,
    'all two hundred were answered, in the order they were sent, none missing and none extra');
  assert.strictEqual(replies(events).length, 200, 'no reply beyond the two hundred statuses');
  assert.strictEqual(new Set(answered.map((e) => e.id)).size, 200, 'every id appears exactly once');
  for (const e of answered) {
    assert.strictEqual(e.proto, 1);
    assert.strictEqual(e.busy, false);
  }
  assert.strictEqual(stdoutLines(stdout).filter((l) => l.includes('"type":"status"')).length, 200,
    'two hundred status lines on stdout; nothing was merged or split under load');
  assert.strictEqual(code, 0);
});

// ------------------------------------------------------------ transport side

// Prevents: one corrupt notification from the scale — a truncated hex payload
// over a noisy link — throwing out of the frame decoder and killing the service
// while somebody is standing on the scale waiting for a number.
test('INT-ROB-19  a frame with odd-length hex is skipped and the measurement still completes', async () => {
  const replay = splicedFixture('rob-oddhex', [
    { t: 'frame', uuid: '0000ffb2-0000-1000-8000-00805f9b34fb', hex: 'a b c' },
    { t: 'frame', uuid: '0000ffb3-0000-1000-8000-00805f9b34fb', hex: '3' },
  ]);
  const { terminal, progress, stderr } = await H.measureOnce({ replay });

  assert.strictEqual(terminal.type, 'measurement', 'the malformed frames did not end the session');
  assert.strictEqual(terminal.measured.weightKg, H.EXPECTED.weightKg,
    'the good frames after the bad ones were decoded normally');
  assert.strictEqual(terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.ok(progress.some((p) => p.phase === 'settling' && p.weightKg > 0),
    'progress still flowed while the reading settled');
  assert.match(stderr, /skipping malformed frame 0000ffb2-0000-1000-8000-00805f9b34fb/,
    'the skip was reported on stderr, where a diagnostic belongs');
  assert.match(stderr, /odd number of digits/, 'and it says why the frame was skipped');
});

// Prevents: a future or third-party transport emitting an event this build does
// not know about and being treated as a fatal protocol violation, so an upgrade
// of ble.py breaks every measurement.
test('INT-ROB-20  an unknown transport event type is ignored and the measurement is unaffected', async () => {
  const replay = splicedFixture('rob-unknown-ev', [
    { t: 'pandemonium', msg: 'no such event type' },
    { t: 'rssi', value: -61 },
    { t: 42 },
    { notAnEventAtAll: true },
    { t: 'end-ish', reason: 'looks terminal but is not' },
  ]);
  const { terminal, progress, events } = await H.measureOnce({ replay });

  assert.strictEqual(terminal.type, 'measurement', 'the unknown events did not abort the run');
  assert.strictEqual(terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(events.some((e) => e.type === 'error'), false, 'no error was reported to the host');
  assert.deepStrictEqual(
    progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]),
    ['connected', 'ready', 'settling'],
    'the progress phases are exactly those of a clean run');
});

// Prevents: a session file cut off mid-write — a recording interrupted, or a
// transport killed between two writes — crashing the decoder instead of ending
// the measurement with whatever was already read.
test('INT-ROB-21  a truncated final line in a session is ignored and the reading already taken still settles', async () => {
  const dir = H.tmpdir('rob-truncated');
  const file = path.join(dir, 'truncated.jsonl');
  const body = RECORDED.slice(0, RECORDED.length - 1).map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(file, `${body}\n{"t":"end","reaso`);   // the last line stops mid-key

  const { terminal, events, stderr } = await H.measureOnce({ replay: file });

  assert.strictEqual(terminal.type, 'measurement', 'the half-written line did not become a failure');
  assert.strictEqual(terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(events.some((e) => e.type === 'error'), false, 'no error reached the host');
  assert.strictEqual(stderr.includes('{"t":"end","reaso'), false,
    'the unparseable fragment was dropped, not echoed as a diagnostic');
});

// ------------------------------------------------------------ the invariant

// Prevents: a stray console.log, a help banner or a human sentence landing on
// stdout while the host is mid-measurement. One such line desynchronises the
// reader for the rest of the session, so every later reply is lost.
test('INT-ROB-22  after a full hostile sequence, every stdout line is still one protocol object carrying proto 1', async () => {
  let deep = 'bottom';
  for (let i = 0; i < 300; i++) deep = { a: deep };

  const { events, stdout, stderr, code } = await H.serve({
    timeoutMs: 22000,
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        raw('not json at all');
        raw('');
        raw('    \t ');
        raw('[1,2,3]');
        raw('"scalar"');
        raw('null');
        raw('{"id":"H1","cmd":"status"}\n{"id":"H2"}');
        send(deep);
        send({ id: 'H3', cmd: 'measure', profile: { age: 'NaN', heightCm: 180 } });
        send({ id: 'H4', cmd: 'measure', profile: ['male', 39, 180] });
        send({ id: 'H5', cmd: 'cancel' });
        send({ id: '🎉-\n-"q"', cmd: 'status', padding: 'y'.repeat(64 * 1024) });
        send({ id: 'H6', cmd: 'measure', profile: H.PROFILE, extra: deep });
        return false;
      }
      return ev.id === 'H6' && (ev.type === 'measurement' || ev.type === 'error');
    },
  });

  const lines = stdoutLines(stdout);
  assert.ok(lines.length >= 12, `a real session ran; saw ${lines.length} stdout line(s)`);

  for (const line of lines) {
    const obj = JSON.parse(line);                    // throws, and fails the test, on anything else
    assert.strictEqual(obj.proto, 1, `every line carries proto 1: ${line.slice(0, 120)}`);
    assert.strictEqual(typeof obj.type, 'string', `every line is typed: ${line.slice(0, 120)}`);
    assert.ok(KNOWN_TYPES.has(obj.type), `known event type, got ${obj.type}`);
    if (obj.type === 'hello') {
      assert.strictEqual('id' in obj, false, 'hello answers nothing, so it carries no id');
    } else {
      assert.ok('id' in obj, `every other line carries an id to correlate on: ${line.slice(0, 120)}`);
    }
  }

  const m = events.find((e) => e.id === 'H6' && H.TERMINAL.has(e.type));
  assert.strictEqual(m.type, 'measurement', 'the service was still able to do real work at the end');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(stdout.includes('yyyyyyyyyyyyyyyy'), false, 'no padding leaked into the protocol');

  // The diagnostics really did happen; they simply went to the other stream.
  assert.match(stderr, /device SSW533 at/, 'the human commentary was written to stderr');
  assert.strictEqual(stdout.includes('device SSW533 at'), false, 'and never to stdout');
  assert.strictEqual(code, 0, 'and the process exited cleanly');
});
