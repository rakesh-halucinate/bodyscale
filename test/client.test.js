// Tests for BodyScaleClient, the Electron main-process wrapper.
//
// It is deliberately free of Electron imports so it can be driven under plain
// Node against the real service, replaying a recorded SSW533 session.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { BodyScaleClient, ScaleError } = require(path.join(ROOT, 'electron-example', 'bodyscale-client.js'));
const FIXTURE = path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');
const PROFILE = { age: 39, heightCm: 180, sex: 'male' };

const make = (opts = {}) => new BodyScaleClient(Object.assign({ scaleDir: ROOT, replay: FIXTURE }, opts));

// Always stop the client, even when an assertion throws, or the test run hangs
// on a live child process.
async function withClient(fn, opts) {
  const client = make(opts);
  try { return await fn(client); }
  finally { await client.stop(); }
}

test('client: start resolves with hello and reports the protocol', async () => {
  await withClient(async (client) => {
    const hello = await client.start();
    assert.strictEqual(hello.type, 'hello');
    assert.strictEqual(hello.proto, 1);
    assert.strictEqual(hello.app, 'bodyscale');
    assert.ok(hello.commands.includes('measure'));
    assert.strictEqual(client.running, true);
    assert.strictEqual(client.hello, hello);
  });
});

test('client: start is idempotent and does not spawn twice', async () => {
  await withClient(async (client) => {
    const a = await client.start();
    const b = await client.start();
    assert.strictEqual(a, b, 'the second start returns the same hello');
  });
});

test('client: measure resolves with the full envelope', async () => {
  await withClient(async (client) => {
    await client.start();
    const m = await client.measure(PROFILE);
    assert.strictEqual(m.type, 'measurement');
    assert.strictEqual(m.ok, true);
    assert.strictEqual(m.measured.weightKg, 97.9);
    assert.strictEqual(m.measured.impedanceOhm, 529.9);
    assert.deepStrictEqual(m.profile, { sex: 'male', age: 39, heightCm: 180 });
    assert.ok(m.derived.bodyFatPercent > 0);
    assert.ok(m.derived.muscleMassKg > 0);
    assert.ok(m.bodyFatRecommended.key);
  });
});

test('client: progress is emitted as an event stream while the measure is pending', async () => {
  await withClient(async (client) => {
    await client.start();
    const seen = [];
    const weights = [];
    client.on('progress', (p) => {
      seen.push(p.phase);
      if (typeof p.weightKg === 'number' && p.weightKg > 0) weights.push(p.weightKg);
    });
    // Phase-named events are a convenience for wiring UI directly.
    let readyFired = false;
    client.on('ready', () => { readyFired = true; });

    const m = await client.measure(PROFILE);
    assert.ok(seen.includes('connected'), 'saw connected: ' + seen.join(','));
    assert.ok(seen.includes('settling'), 'saw live weight');
    assert.ok(readyFired, 'the phase-named event fired too');
    assert.ok(weights.length >= 2, 'several live weights streamed');
    assert.strictEqual(weights[weights.length - 1], m.measured.weightKg,
                       'the last live weight equals the final reading');
  });
});

test('client: busy is true only while a measurement is in flight', async () => {
  await withClient(async (client) => {
    await client.start();
    assert.strictEqual(client.busy, false);
    let busyDuring = null;
    client.on('settling', () => { if (busyDuring === null) busyDuring = client.busy; });
    await client.measure(PROFILE);
    assert.strictEqual(busyDuring, true, 'busy was set while measuring');
    assert.strictEqual(client.busy, false, 'and cleared afterwards');
  });
});

test('client: an invalid profile rejects with a typed ScaleError', async () => {
  await withClient(async (client) => {
    await client.start();
    await assert.rejects(
      () => client.measure({ heightCm: 180 }),
      (err) => {
        assert.ok(err instanceof ScaleError, 'it is a ScaleError');
        assert.strictEqual(err.code, 'INVALID_PROFILE');
        assert.ok(/age/.test(err.message), 'the message names the field: ' + err.message);
        return true;
      });
    // The client survives a rejected request.
    const s = await client.status();
    assert.strictEqual(s.busy, false);
  });
});

test('client: rejection does not leave the client stuck busy', async () => {
  await withClient(async (client) => {
    await client.start();
    await client.measure({ age: 1, heightCm: 180 }).catch(() => {});
    assert.strictEqual(client.busy, false);
    const m = await client.measure(PROFILE);          // and a real one still works
    assert.strictEqual(m.ok, true);
  });
});

test('client: cancel rejects the pending measure with CANCELLED', async () => {
  await withClient(async (client) => {
    await client.start();
    const pending = client.measure(PROFILE);
    await new Promise((r) => client.once('accepted', r));
    const ack = await client.cancel();
    assert.strictEqual(ack.type, 'cancelling');
    await assert.rejects(() => pending, (err) => {
      assert.strictEqual(err.code, 'CANCELLED');
      return true;
    });
    assert.strictEqual(client.busy, false, 'cancelling clears busy');
  });
});

test('client: a measure after a cancel succeeds', async () => {
  await withClient(async (client) => {
    await client.start();
    const first = client.measure(PROFILE);
    await new Promise((r) => client.once('accepted', r));
    await client.cancel();
    await first.catch(() => {});
    const m = await client.measure(PROFILE);
    assert.strictEqual(m.measured.weightKg, 97.9, 'the retry produced a real reading');
  });
});

test('client: concurrent requests are matched to their own replies', async () => {
  await withClient(async (client) => {
    await client.start();
    const [a, b, c] = await Promise.all([client.status(), client.status(), client.status()]);
    assert.notStrictEqual(a.id, b.id, 'each request got its own id');
    assert.notStrictEqual(b.id, c.id);
    for (const r of [a, b, c]) assert.strictEqual(r.type, 'status');
  });
});

test('client: measure before start rejects rather than hanging', async () => {
  const client = make();
  await assert.rejects(() => client.measure(PROFILE), (err) => {
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.ok(/not running/.test(err.message));
    return true;
  });
});

test('client: a missing scale.js is reported as TRANSPORT_FAILED with a useful hint', async () => {
  const client = new BodyScaleClient({ scaleDir: path.join(ROOT, 'no-such-directory') });
  await assert.rejects(() => client.start(), (err) => {
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.ok(/asarUnpack/.test(err.message), 'the message explains the packaging trap');
    return true;
  });
});

test('client: stop terminates the child and reports it once', async () => {
  const client = make();
  await client.start();
  let closes = 0;
  let wasIntentional = null;
  client.on('close', (code, stopping) => { closes++; wasIntentional = stopping; });
  await client.stop();
  assert.strictEqual(client.running, false);
  assert.strictEqual(closes, 1);
  assert.strictEqual(wasIntentional, true, 'the close is reported as intentional, not a crash');
  await client.stop();                             // stopping twice is harmless
});

test('client: stopping mid-measurement rejects the pending promise', async () => {
  const client = make();
  await client.start();
  const pending = client.measure(PROFILE);
  await new Promise((r) => client.once('accepted', r));
  await client.stop();
  await assert.rejects(() => pending, (err) => {
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    return true;
  });
});

test('client: forget and status round-trip', async () => {
  await withClient(async (client) => {
    await client.start();
    const f = await client.forget();
    assert.strictEqual(f.type, 'forgotten');
    const s = await client.status();
    assert.strictEqual(s.type, 'status');
    assert.strictEqual(s.device, null, 'after forget, no device is remembered');
    assert.strictEqual(s.platform, process.platform);
  });
});

test('client: the measurement remembers the device for next time', async () => {
  await withClient(async (client) => {
    await client.start();
    await client.forget();
    await client.measure(PROFILE);
    const s = await client.status();
    assert.ok(s.device && s.device.address, 'the address is remembered after a measurement');
    assert.strictEqual(s.device.name, 'SSW533');
  });
});

test('client: an error event never throws as an unhandled EventEmitter error', async () => {
  // EventEmitter throws when an 'error' event has no listener. The client uses
  // 'error-event' precisely so a caller that ignores errors cannot crash the app.
  await withClient(async (client) => {
    await client.start();
    let seen = null;
    client.on('error-event', (err) => { seen = err; });
    await client.measure({ age: 200, heightCm: 180 }).catch(() => {});
    assert.ok(seen instanceof ScaleError, 'the error surfaced on error-event');
    assert.strictEqual(seen.code, 'INVALID_PROFILE');
  });
});

test('client: the whole result survives structuredClone, so it can cross to a renderer', async () => {
  await withClient(async (client) => {
    await client.start();
    const m = await client.measure(PROFILE);
    const cloned = structuredClone(m);            // exactly what ipcMain does
    assert.deepStrictEqual(cloned, m);
  });
});

test('client: a missing Python interpreter is TRANSPORT_FAILED, not a scale problem', async () => {
  // This is the likeliest Windows failure, and it used to be reported as
  // "connected but no reading arrived. Stand on the scale with bare feet",
  // which sends the user to the wrong place entirely.
  const client = new BodyScaleClient({ scaleDir: ROOT, pythonPath: '/nonexistent/python' });
  try {
    await client.start();
    const err = await client.measure(PROFILE, { scanTimeoutSec: 3 }).catch((e) => e);
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    assert.ok(/ENOENT|not found|cannot find/i.test(err.message),
              'the message names the real cause: ' + err.message);
    assert.strictEqual(err.detail.outcome, 'spawn-failed');
    assert.ok(err.detail.spawnError, 'the spawn error is passed through for diagnosis');
    assert.ok(!/stand on the scale/i.test(err.message), 'it does not blame the user');
  } finally { await client.stop(); }
});

test('client: repeated start/stop cycles leak no listeners', async () => {
  // A leak here is invisible until Node prints a MaxListenersExceededWarning
  // in production, so assert on the actual counts.
  const client = make();
  for (let i = 0; i < 6; i++) {
    await client.start();
    await client.stop();
  }
  for (const name of ['hello', '_startFailed']) {
    assert.strictEqual(client.listenerCount(name), 0,
      `no ${name} listeners survive a start/stop cycle, found ${client.listenerCount(name)}`);
  }
  // And it still works after all that.
  await client.start();
  const m = await client.measure(PROFILE);
  assert.strictEqual(m.measured.weightKg, 97.9);
  await client.stop();
});

// --- regressions found by adversarial review ---------------------------------

test('client: a request racing stop() rejects instead of killing the process', async () => {
  // stop() ends stdin but used to leave `running` true for up to timeoutMs, so
  // a caller's `if (client.running)` guard passed and the write landed on an
  // ended stream. That does not throw synchronously; it emits asynchronously
  // and, with no error listener, takes down the whole Electron app.
  const client = make();
  await client.start();
  const stopping = client.stop();                 // deliberately not awaited
  assert.strictEqual(client.running, false, 'the client reports itself down immediately');
  await assert.rejects(() => client.measure(PROFILE), (err) => {
    assert.strictEqual(err.code, 'TRANSPORT_FAILED');
    return true;
  });
  await stopping;
});

test('client: an uncaught stdio error cannot escape', async () => {
  const client = make();
  await client.start();
  const child = client.child;
  assert.ok(child.stdin.listenerCount('error') > 0, 'stdin has an error listener');
  assert.ok(child.stdout.listenerCount('error') > 0, 'stdout has an error listener');
  assert.ok(child.stderr.listenerCount('error') > 0, 'stderr has an error listener');
  await client.stop();
});

test('client: a BUSY rejection does not clear busy for the run still in flight', async () => {
  await withClient(async (client) => {
    await client.start();
    const first = client.measure(PROFILE);
    await new Promise((r) => client.once('accepted', r));
    const refused = await client.measure(PROFILE).catch((e) => e);
    assert.strictEqual(refused.code, 'BUSY');
    assert.strictEqual(client.busy, true,
      'the first measurement still owns the flag; the refused one never did');
    await first;
    assert.strictEqual(client.busy, false, 'and it clears when the real one finishes');
  });
});

test('client: start() during stop() does not hand back a dead client', async () => {
  const client = make();
  await client.start();
  const stopping = client.stop();
  await stopping;
  const hello = await client.start();             // must respawn, not return a corpse
  assert.ok(hello && hello.type === 'hello');
  assert.strictEqual(client.running, true);
  const m = await client.measure(PROFILE);        // and actually work
  assert.strictEqual(m.measured.weightKg, 97.9);
  await client.stop();
});

test('client: a second start() before hello arrives waits rather than resolving null', async () => {
  // main.js starts the service at whenReady; the renderer calls start() a
  // moment later. The second caller used to get hello === null and then throw
  // on hello.device.
  const client = make();
  const first = client.start();
  const second = client.start();                  // no await between them
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a && a.type === 'hello');
  assert.ok(b && b.type === 'hello', 'the second caller got a real hello, not null');
  assert.ok(b.device !== undefined, 'and can read hello.device without throwing');
  await client.stop();
});

test('client: the env option reaches the service', async () => {
  // Documented for BODYSCALE_CONFIG_DIR, so a host can keep the remembered
  // device in its own data directory rather than beside the script.
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'bs-env-'));
  const client = make({ env: { BODYSCALE_CONFIG_DIR: dir } });
  try {
    await client.start();
    await client.measure(PROFILE);
    const file = require('path').join(dir, 'scale-config.json');
    assert.ok(require('fs').existsSync(file), 'the service wrote its config where it was told');
  } finally { await client.stop(); }
});
