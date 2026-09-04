// Tests for --serve, the newline-JSON service the Electron app talks to.
//
// These drive the real CLI as a child process over a pipe, exactly the way the
// Electron main process does, and replay a recorded SSW533 session so they need
// no scale and no Bluetooth radio.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scale.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');
const PROFILE = { age: 39, heightCm: 180, sex: 'male' };

// Start the service and let a script drive it. `onLine` returns true to finish.
function drive(onLine, { replay = true, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [CLI, '--serve'];
    if (replay) args.push('--replay', FIXTURE);
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const events = [];
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    const raw = (s) => child.stdin.write(s + '\n');
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer);
                             try { child.kill(); } catch (e) { /* already gone */ } fn(); };
    const timer = setTimeout(
      () => finish(() => reject(new Error('timed out; saw: ' + events.map((e) => e.type).join(',')))),
      timeoutMs);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); }
      catch (e) { return finish(() => reject(new Error('stdout was not JSON: ' + line))); }
      events.push(ev);
      let done;
      try { done = onLine(ev, send, raw, events); }
      catch (e) { return finish(() => reject(e)); }
      if (done) finish(() => resolve(events));
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', () => finish(() => resolve(events)));
  });
}

const byType = (events, type) => events.filter((e) => e.type === type);
const first = (events, type) => events.find((e) => e.type === type);

test('serve: every stdout line is a JSON object carrying the protocol version', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 1, cmd: 'status' }); return false; }
    return ev.type === 'status';
  });
  assert.ok(events.length >= 2);
  for (const ev of events) {
    assert.strictEqual(ev.proto, 1, `every event carries proto: ${JSON.stringify(ev)}`);
    assert.strictEqual(typeof ev.type, 'string');
  }
});

test('serve: hello announces the contract before any command is sent', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 1, cmd: 'shutdown' }); return false; }
    return ev.type === 'bye';
  });
  const hello = first(events, 'hello');
  assert.ok(hello, 'hello is the first event');
  assert.strictEqual(events[0].type, 'hello', 'hello is sent unprompted, before any request');
  assert.strictEqual(hello.app, 'bodyscale');
  assert.strictEqual(hello.platform, process.platform);
  for (const cmd of ['measure', 'cancel', 'status', 'forget', 'shutdown']) {
    assert.ok(hello.commands.includes(cmd), `hello advertises ${cmd}`);
  }
  for (const code of ['INVALID_PROFILE', 'DEVICE_NOT_FOUND', 'BUSY', 'CANCELLED']) {
    assert.ok(hello.errorCodes.includes(code), `hello advertises ${code}`);
  }
});

test('serve: a measurement returns weight, impedance and the full derived set', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'm1', cmd: 'measure', profile: PROFILE }); return false; }
    return ev.type === 'measurement' || ev.type === 'error';
  });
  const m = first(events, 'measurement');
  assert.ok(m, 'a measurement arrived; got ' + events.map((e) => e.type).join(','));
  assert.strictEqual(m.id, 'm1', 'the reply carries the request id');
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.measured.weightKg, 97.9);
  assert.strictEqual(m.measured.impedanceOhm, 529.9);

  // The caller supplies age, height and sex. Everything else comes from here.
  assert.deepStrictEqual(m.profile, { sex: 'male', age: 39, heightCm: 180 });
  for (const key of ['bmi', 'bodyFatPercent', 'fatMassKg', 'muscleMassKg', 'skeletalMuscleMassKg',
                     'bodyWaterLitres', 'boneMassKg', 'proteinMassKg', 'bmrKcal', 'fatFreeMassKg']) {
    assert.ok(key in m.derived, `derived carries ${key}`);
  }
  // Every derived number is accompanied by a unit and a confidence label.
  for (const key of Object.keys(m.derived)) {
    assert.ok(key in m.units, `${key} has a unit`);
    assert.ok(key in m.confidence, `${key} has a confidence label`);
  }
  assert.ok(m.bodyFatRecommended && m.bodyFatRecommended.key, 'one body fat number is recommended');
  assert.strictEqual(typeof m.trust.impedanceDerived, 'boolean');
  assert.ok(Array.isArray(m.flags) && Array.isArray(m.warnings));
  assert.ok(!Number.isNaN(Date.parse(m.timestamp)), 'timestamp is ISO 8601');
});

test('serve: accepted precedes progress, and progress precedes the result', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'm1', cmd: 'measure', profile: PROFILE }); return false; }
    return ev.type === 'measurement' || ev.type === 'error';
  });
  const order = events.map((e) => e.type);
  assert.ok(order.indexOf('accepted') < order.indexOf('progress'), 'accepted comes first');
  assert.ok(order.indexOf('progress') < order.indexOf('measurement'), 'progress comes before the result');

  const progress = byType(events, 'progress');
  assert.ok(progress.length >= 3, 'live progress is streamed, not just a final answer');
  for (const p of progress) assert.strictEqual(p.id, 'm1', 'progress is tagged with the request id');
  const phases = new Set(progress.map((p) => p.phase));
  assert.ok(phases.has('connected') && phases.has('settling'),
            'progress reports connection and live weight: ' + [...phases].join(','));
  const live = progress.filter((p) => typeof p.weightKg === 'number' && p.weightKg > 0);
  assert.ok(live.length >= 2, 'live weight is streamed while the user is standing on the scale');
});

test('serve: a bad profile is rejected before any radio work starts', async () => {
  const cases = [
    [{ heightCm: 180 }, 'age'],
    [{ age: 39 }, 'heightCm'],
    [{ age: 2, heightCm: 180 }, 'age'],
    [{ age: 39, heightCm: 40 }, 'heightCm'],
    [{ age: 39, heightCm: 180, sex: 'other' }, 'sex'],
    [null, 'profile'],
  ];
  for (const [profile, word] of cases) {
    const events = await drive((ev, send) => {
      if (ev.type === 'hello') { send({ id: 'x', cmd: 'measure', profile }); return false; }
      return ev.type === 'error' || ev.type === 'accepted';
    });
    const err = first(events, 'error');
    assert.ok(err, `rejected ${JSON.stringify(profile)}`);
    assert.strictEqual(err.code, 'INVALID_PROFILE');
    assert.strictEqual(err.id, 'x');
    assert.ok(err.message.includes(word), `message names the bad field: ${err.message}`);
    assert.ok(!first(events, 'accepted'), 'nothing was accepted, so no radio work began');
  }
});

test('serve: malformed input and unknown commands do not kill the service', async () => {
  const events = await drive((ev, send, raw) => {
    if (ev.type === 'hello') { raw('this is not json'); return false; }
    if (ev.type === 'error' && ev.code === 'BAD_REQUEST' && ev.message === 'not valid JSON') {
      raw('[1,2,3]'); return false;                          // valid JSON, wrong shape
    }
    if (ev.type === 'error' && ev.message === 'expected a JSON object') {
      send({ id: 'u', cmd: 'frobnicate' }); return false;
    }
    if (ev.type === 'error' && ev.code === 'UNKNOWN_COMMAND') {
      send({ id: 'ok', cmd: 'status' }); return false;       // still alive?
    }
    return ev.type === 'status';
  });
  const status = first(events, 'status');
  assert.ok(status, 'the service survived three bad inputs and still answered');
  assert.strictEqual(status.id, 'ok');
  assert.strictEqual(byType(events, 'error').length, 3);
});

test('serve: a second measurement while one is running is refused as BUSY', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'first', cmd: 'measure', profile: PROFILE }); return false; }
    if (ev.type === 'accepted') { send({ id: 'second', cmd: 'measure', profile: PROFILE }); return false; }
    return ev.type === 'error' && ev.id === 'second';
  });
  const err = events.find((e) => e.type === 'error' && e.id === 'second');
  assert.ok(err, 'the second request was answered');
  assert.strictEqual(err.code, 'BUSY');
  assert.ok(first(events, 'accepted').id, 'the first request was still accepted');
});

test('serve: status reports whether a measurement is in flight', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'idle', cmd: 'status' }); return false; }
    if (ev.type === 'status' && ev.id === 'idle') {
      assert.strictEqual(ev.busy, false, 'idle before anything runs');
      send({ id: 'm', cmd: 'measure', profile: PROFILE });
      return false;
    }
    if (ev.type === 'accepted') { send({ id: 'busy', cmd: 'status' }); return false; }
    return ev.type === 'status' && ev.id === 'busy';
  });
  const busy = events.find((e) => e.type === 'status' && e.id === 'busy');
  assert.strictEqual(busy.busy, true);
  assert.strictEqual(busy.runningId, 'm', 'status names the running request');
});

test('serve: cancel stops a running measurement and reports CANCELLED', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
    if (ev.type === 'accepted') { send({ id: 'c', cmd: 'cancel' }); return false; }
    return ev.type === 'error' && ev.id === 'm';
  });
  const cancelling = first(events, 'cancelling');
  assert.ok(cancelling, 'cancel is acknowledged immediately');
  assert.strictEqual(cancelling.cancelling, 'm', 'it names the request being cancelled');
  const err = events.find((e) => e.type === 'error' && e.id === 'm');
  assert.strictEqual(err.code, 'CANCELLED', 'the measurement resolves as cancelled, not as a result');
  assert.ok(!first(events, 'measurement'), 'no measurement was emitted after cancelling');
});

test('serve: cancel with nothing running is a plain error, not a crash', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'c', cmd: 'cancel' }); return false; }
    if (ev.type === 'error') { send({ id: 's', cmd: 'status' }); return false; }
    return ev.type === 'status';
  });
  assert.strictEqual(first(events, 'error').code, 'BAD_REQUEST');
  assert.ok(first(events, 'status'), 'the service is still alive');
});

test('serve: after cancelling, a new measurement is accepted', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'a', cmd: 'measure', profile: PROFILE }); return false; }
    if (ev.type === 'accepted' && ev.id === 'a') { send({ id: 'c', cmd: 'cancel' }); return false; }
    if (ev.type === 'error' && ev.id === 'a') { send({ id: 'b', cmd: 'measure', profile: PROFILE }); return false; }
    return ev.type === 'measurement' || (ev.type === 'error' && ev.id === 'b');
  });
  const m = first(events, 'measurement');
  assert.ok(m, 'the retry ran; the cancel did not wedge the service');
  assert.strictEqual(m.id, 'b');
  assert.strictEqual(m.measured.weightKg, 97.9);
});

test('serve: an id round-trips unchanged, including a string id', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'req-abc-123', cmd: 'status' }); return false; }
    return ev.type === 'status';
  });
  assert.strictEqual(first(events, 'status').id, 'req-abc-123');
});

test('serve: a request with no id is answered with a null id, not dropped', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ cmd: 'status' }); return false; }
    return ev.type === 'status';
  });
  assert.strictEqual(first(events, 'status').id, null);
});

test('serve: shutdown acknowledges and then exits', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'q', cmd: 'shutdown' }); return false; }
    return false;                                   // run to child close
  }, { timeoutMs: 8000 });
  const bye = first(events, 'bye');
  assert.ok(bye, 'shutdown is acknowledged before exit');
  assert.strictEqual(bye.id, 'q');
  assert.strictEqual(events[events.length - 1].type, 'bye', 'nothing is emitted after bye');
});

test('serve: the caller supplies only age, height and sex', async () => {
  // Two different profiles over the same recorded frames must give the same
  // measured numbers and different derived ones. That is the contract: the
  // scale supplies weight and impedance, the Electron app supplies the person.
  const run = (profile) => drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile }); return false; }
    return ev.type === 'measurement' || ev.type === 'error';
  }).then((events) => first(events, 'measurement'));

  const [a, b] = await Promise.all([
    run({ age: 39, heightCm: 180, sex: 'male' }),
    run({ age: 25, heightCm: 165, sex: 'female' }),
  ]);
  assert.ok(a && b);
  assert.deepStrictEqual(a.measured, b.measured, 'the scale reading does not depend on the profile');
  assert.notStrictEqual(a.derived.bmi, b.derived.bmi, 'height changes BMI');
  assert.notStrictEqual(a.derived.bodyFatPercent, b.derived.bodyFatPercent, 'sex changes body fat');
  assert.notStrictEqual(a.derived.bmrKcal, b.derived.bmrKcal, 'age changes BMR');
});

test('serve: sex defaults to male when omitted, and the reply says so', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: { age: 39, heightCm: 180 } }); return false; }
    return ev.type === 'accepted' || ev.type === 'error';
  });
  const acc = first(events, 'accepted');
  assert.ok(acc, 'a profile without sex is accepted');
  assert.strictEqual(acc.profile.sex, 'male', 'the reply states the assumption it made');
});

test('serve: derived values are plain JSON numbers and strings, safe to send over IPC', async () => {
  const events = await drive((ev, send) => {
    if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: PROFILE }); return false; }
    return ev.type === 'measurement' || ev.type === 'error';
  });
  const m = first(events, 'measurement');
  for (const [k, v] of Object.entries(m.derived)) {
    const t = typeof v;
    assert.ok(t === 'number' || t === 'string', `${k} is ${t}, which structuredClone can carry`);
    if (t === 'number') assert.ok(Number.isFinite(v), `${k} is finite, not NaN or Infinity`);
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m)), m, 'the whole envelope survives a JSON round trip');
});
