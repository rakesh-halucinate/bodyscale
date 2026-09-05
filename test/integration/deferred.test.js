'use strict';
// INT-DEFER — capturing a reading before the profile is known.
//
// The scale's radio sleeps within seconds of going idle, so the weight has to
// be taken the moment it settles. A person's age does not. `derived` is a pure
// function of `measured` and the profile, so a reading captured without one
// loses nothing — it simply has not been interpreted yet.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');

const PROFILE = { age: 39, heightCm: 180, sex: 'male' };

/** Capture with no profile, then interpret with one. */
function deferThenCompute(profile, { measuredAt, model } = {}) {
  return H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', withoutProfile: true }); return false; }
      if (ev.type === 'measurement' && ev.id === 'm') {
        send(Object.assign({ id: 'c', cmd: 'compute', measured: ev.measured, profile },
                           measuredAt ? { measuredAt } : {}, model ? { model } : {}));
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'c';
    },
  }).then(({ events }) => ({
    captured: events.find((e) => e.type === 'measurement' && e.id === 'm'),
    computed: events.find((e) => (e.type === 'measurement' || e.type === 'error') && e.id === 'c'),
    accepted: H.first(events, 'accepted'),
  }));
}

// Prevents: losing the reading entirely because the profile form was not filled
// in before the user stepped on. The radio window is seconds; the form is not.
test('INT-DEFER-01  a measure can capture weight and impedance with no profile', async () => {
  const r = await deferThenCompute(PROFILE);
  const c = r.captured;
  assert.ok(c, 'the measurement completed');
  assert.strictEqual(c.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(c.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(c.profileDeferred, true, 'and says the profile was deferred');
  assert.strictEqual(c.profile, null, 'no profile is invented');
  assert.deepStrictEqual(c.derived, {}, 'nothing is interpreted without one');
  assert.strictEqual(c.trust.impedanceDerived, false);
  assert.strictEqual(c.trust.impedanceFree, false, 'not even BMI, since height is unknown');
  assert.match(c.warnings[0], /compute/, 'and it says how to finish the job');
});

// Prevents: a host discovering only at render time that it deferred.
test('INT-DEFER-02  accepted announces the deferral immediately', async () => {
  const r = await deferThenCompute(PROFILE);
  assert.strictEqual(r.accepted.profileDeferred, true);
  assert.strictEqual(r.accepted.profile, null);
});

// THE guarantee. If a recomputed panel differed from a live one, deferring
// would quietly produce different numbers for the same body.
test('INT-DEFER-03  a recomputed result is identical to a live measurement', async () => {
  const [live, deferred] = await Promise.all([
    H.measureOnce({ profile: PROFILE }).then((r) => r.terminal),
    deferThenCompute(PROFILE).then((r) => r.computed),
  ]);
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    // Timing and provenance legitimately differ; nothing else may.
    for (const k of ['timestamp', 'id', 'source', 'measuredAt', 'device', 'model']) delete c[k];
    return c;
  };
  assert.deepStrictEqual(strip(deferred), strip(live),
    'every derived value, unit, confidence label, flag and warning matches');
});

// Prevents: a host unable to tell a live reading from a recomputed one, which
// matters for anything that records provenance.
test('INT-DEFER-04  a recomputed result says so, and can carry when it was taken', async () => {
  const when = '2026-09-05T09:12:34.583Z';
  const r = await deferThenCompute(PROFILE, { measuredAt: when, model: 'Dr Trust SSW532' });
  assert.strictEqual(r.computed.source, 'recomputed');
  assert.strictEqual(r.computed.measuredAt, when, 'the original moment is carried through');
  assert.notStrictEqual(r.computed.timestamp, when, 'and is distinct from when it was computed');
  assert.strictEqual(r.computed.model, 'Dr Trust SSW532');
  assert.strictEqual(r.captured.source, 'scale', 'the live one is labelled differently');
});

// Prevents: a host that forgot to send a profile silently getting a useless
// result instead of an error. Deferring must be a deliberate choice.
test('INT-DEFER-05  omitting the profile without asking is still an error', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'x', cmd: 'measure' }); return false; }
      return ev.type === 'error' || ev.type === 'accepted';
    },
  });
  const err = H.first(events, 'error');
  assert.ok(err, 'still rejected');
  assert.strictEqual(err.code, 'INVALID_PROFILE');
  assert.ok(!H.first(events, 'accepted'), 'and no radio work began');
});

// Prevents: an ambiguous request where both a profile and a deferral are sent.
test('INT-DEFER-06  sending both a profile and withoutProfile is refused', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'x', cmd: 'measure', withoutProfile: true, profile: PROFILE });
        return false;
      }
      return ev.type === 'error' || ev.type === 'accepted';
    },
  });
  const err = H.first(events, 'error');
  assert.strictEqual(err.code, 'BAD_REQUEST');
  assert.match(err.message, /not both/);
});

// Prevents: garbage weights being interpreted as though a scale had produced
// them, since compute takes its numbers from the host rather than the hardware.
test('INT-DEFER-07  compute validates the measured pair it is handed', async () => {
  const bad = [
    [undefined, /measured is required/],
    [{}, /weightKg/],
    [{ weightKg: 0 }, /positive/],
    [{ weightKg: -5 }, /positive/],
    [{ weightKg: 'heavy' }, /weightKg/],
    [{ weightKg: 900 }, /above 500/],
    [{ weightKg: 80, impedanceOhm: 'high' }, /impedanceOhm/],
    [{ weightKg: 80, impedanceOhm: -1 }, /impedanceOhm/],
  ];
  for (const [measured, pattern] of bad) {
    const { events } = await H.serve({
      onEvent: (ev, send) => {
        if (ev.type === 'hello') { send({ id: 'c', cmd: 'compute', measured, profile: PROFILE }); return false; }
        return ev.type === 'error' || ev.type === 'measurement';
      },
    });
    const err = H.first(events, 'error');
    assert.ok(err, `rejected ${JSON.stringify(measured)}`);
    assert.strictEqual(err.code, 'BAD_REQUEST');
    assert.match(err.message, pattern);
  }
});

// Prevents: computing a panel for a person whose age was never actually given,
// which is the whole failure this feature exists to avoid.
test('INT-DEFER-08  compute still requires a complete profile', async () => {
  for (const profile of [undefined, {}, { age: 39 }, { heightCm: 180 }, { age: 2, heightCm: 180 }]) {
    const { events } = await H.serve({
      onEvent: (ev, send) => {
        if (ev.type === 'hello') {
          send({ id: 'c', cmd: 'compute', measured: { weightKg: 97.9, impedanceOhm: 529.9 }, profile });
          return false;
        }
        return ev.type === 'error' || ev.type === 'measurement';
      },
    });
    const err = H.first(events, 'error');
    assert.ok(err, `rejected ${JSON.stringify(profile)}`);
    assert.strictEqual(err.code, 'INVALID_PROFILE');
  }
});

// Prevents: a host believing it must re-weigh someone to correct a typo in
// their age. One reading can be reinterpreted as often as needed.
test('INT-DEFER-09  one reading can be recomputed repeatedly for different people', async () => {
  const measured = { weightKg: 97.9, impedanceOhm: 529.9 };
  const run = (profile) => H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'c', cmd: 'compute', measured, profile }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  }).then(({ events }) => H.first(events, 'measurement'));

  const [a, b] = await Promise.all([
    run({ age: 39, heightCm: 180, sex: 'male' }),
    run({ age: 25, heightCm: 165, sex: 'female' }),
  ]);
  assert.deepStrictEqual(a.measured, b.measured, 'the reading is untouched');
  assert.notStrictEqual(a.derived.bmi, b.derived.bmi, 'height changes BMI');
  assert.notStrictEqual(a.derived.bodyFatPercent, b.derived.bodyFatPercent, 'sex changes body fat');
  assert.notStrictEqual(a.derived.bmrKcal, b.derived.bmrKcal, 'age changes BMR');
});

// Prevents: compute touching the radio. It is arithmetic, and must never wait
// on hardware or fail because a scale is asleep.
test('INT-DEFER-10  compute needs no scale and emits no progress', async () => {
  const started = Date.now();
  const { events } = await H.serve({
    replay: null,                       // the real radio path: it must not be used
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'c', cmd: 'compute', measured: { weightKg: 97.9, impedanceOhm: 529.9 }, profile: PROFILE });
        return false;
      }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  const m = H.first(events, 'measurement');
  assert.ok(m, 'it answered with no scale present');
  assert.strictEqual(Object.keys(m.derived).length, 24);
  assert.deepStrictEqual(H.byType(events, 'progress'), [], 'no progress: nothing was connected to');
  assert.ok(!H.first(events, 'accepted'), 'and no measurement was accepted');
  assert.ok(Date.now() - started < 8000, 'it answered immediately rather than scanning');
});

// Prevents: the deferred capture leaving `busy` stuck, so the next measurement
// is refused with BUSY for ever.
test('INT-DEFER-11  a deferred capture releases the service for the next one', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'a', cmd: 'measure', withoutProfile: true }); return false; }
      if (ev.type === 'measurement' && ev.id === 'a') { send({ id: 's', cmd: 'status' }); return false; }
      return ev.type === 'status';
    },
  });
  const st = H.first(events, 'status');
  assert.strictEqual(st.busy, false, 'the service is idle again');
  assert.strictEqual(st.runningId, null);
});

// Prevents: a deferred run writing a profile it never had.
test('INT-DEFER-12  a deferred capture still remembers the device', async () => {
  const fs = require('fs');
  const path = require('path');
  const dir = H.tmpdir('defer-cfg');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), '{}\n');

  await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', withoutProfile: true }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.ok(cfg[`address_${process.platform}`], 'the device is remembered, so the next scan is instant');
  assert.ok(!cfg.profile, 'and no profile was invented');
});
