'use strict';
/**
 * INT-MEAS — the measurement path, end to end.
 *
 * Every test drives the real `scale.js --serve` over a real pipe with the
 * recorded Dr Trust SSW533 session standing in for the radio. Nothing is mocked
 * and no hardware is required.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const H = require('./harness');

/** The recorded session, decoded with H.PROFILE (male, 39, 180 cm). */
const GOLDEN_DERIVED = {
  bmi: 30.2,
  bmiCategoryWho: 'obese class I',
  bmiCategoryAsiaPacific: 'obese class II',
  bodyFatPercentBmiAnchor: 29,
  bmrKcal: 1914,
  healthyWeightRangeKg: '59.9 – 81',
  weightAboveHealthyRangeKg: 16.9,
  idealWeightRangeKg: '71.5 – 77.3',
  bodyWaterLitres: 45.89,
  bodyWaterPercent: 46.9,
  fatFreeMassKg: 62.69,
  fatFreeMassIndex: 19.3,
  bodyFatPercent: 36,
  fatMassKg: 35.21,
  muscleMassKg: 59.4,
  muscleMassPercent: 60.7,
  skeletalMuscleMassKg: 30.68,
  skeletalMusclePercent: 31.3,
  skeletalMuscleIndex: 9.5,
  boneMassKg: 3.29,
  proteinMassKg: 13.51,
  proteinPercent: 13.8,
  bodyFatGapPoints: 6.9,
  bodyFatRecommendedKey: 'bodyFatPercent',
};

/** Weight ladder the recorded session streams, in order, before it settles. */
/*
 * The live weights the recording streams, in order.
 *
 * 97.9 appears twice: the subtype 0x01 impedance frame arrives after the weight
 * has settled and carries no weight of its own, so the held one streams again
 * alongside the impedance.
 */
// 97.9 appears once. It used to repeat because the recording held a second
// record frame that carried no weight of its own and re-streamed the held one.
// That frame was fabricated: the scale sends a single record with the weight
// and every impedance slot in it.
const WEIGHT_LADDER = [69.25, 90, 94.5, 98.65, 97.95, 98.25, 97.9];

/** The recorded device, as the transport reports it. */
const RECORDED_ADDRESS = 'BEECC6EC-BD30-3EAC-B148-4833628A8A58';

/** Every top-level field of a `measurement`. */
const ENVELOPE_KEYS = [
  'bodyFatRecommended', 'confidence', 'crossCheck', 'derived', 'device', 'flags',
  'id', 'measured', 'model', 'ok', 'omitted', 'profile', 'proto', 'source',
  'timestamp', 'trust', 'type', 'units', 'vendorMatch', 'warnings',
];

const OMITTED_KEYS = [
  'visceralFatRating', 'metabolicAgeYears', 'bodyScore',
  'subcutaneousFatPercent', 'bodyWaterPercentOfFfm', 'fatFreeMassKyle2001',
];

/** The recorded session with the impedance moved outside the 150–1200 Ω band. */
function fixtureWithUntrustworthyImpedance(tag) {
  const events = fs.readFileSync(H.FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // One slot at 1300 Ω and the rest empty: a real number the scale could have
  // produced, but outside the plausible band, so the trust rules reject it.
  // Rebuilt rather than byte-patched, so the trailer is correct.
  const record = events.filter((e) => e.t === 'frame' && / a7 /.test(e.hex)).pop();
  assert.ok(record, 'the recorded session still contains a record frame');
  record.hex = H.recordFrame({ weightKg: 97.9, impedances: [1300] });
  return H.fixture(tag, events);
}

// A measurement that never arrives, or arrives out of order, leaves the Electron
// app spinning on "stand on the scale" for ever. This pins the whole exchange:
// greeting, acknowledgement, live progress, then exactly one answer.
test('INT-MEAS-01  a measure produces hello, accepted, nine progress events and one measurement, in that order', async () => {
  const { events, terminal } = await H.measureOnce({});
  const types = events.map((e) => e.type);
  const upToTerminal = types.slice(0, types.indexOf('measurement') + 1);

  assert.deepStrictEqual(upToTerminal, [
    'hello', 'accepted',
    // connected, ready, then one per live weight. The recording streams seven:
    // the eighth used to come from a fabricated second record frame.
    'progress', 'progress', 'progress', 'progress', 'progress',
    'progress', 'progress', 'progress', 'progress',
    'measurement',
  ]);
  assert.strictEqual(H.byType(events, 'measurement').length, 1, 'exactly one terminal event');
  assert.strictEqual(H.byType(events, 'error').length, 0, 'no error was emitted');
  assert.strictEqual(terminal.ok, true);
  assert.strictEqual(terminal.proto, 1);
  assert.strictEqual(terminal.id, 'M1');
  assert.deepStrictEqual(H.first(events, 'accepted').profile, H.PROFILE);
});

// The progress stream is the only thing on screen while someone is standing on
// the scale. If a phase name or the weight ladder changes, the app's live
// readout goes blank or freezes on the wrong number.
test('INT-MEAS-02  progress reports connected, ready and each settling weight, tagged with the request id', async () => {
  const { progress } = await H.measureOnce({});

  // Six live weights and the record that ends them. There used to be an eighth
  // settling event, from a second record frame carrying no weight of its own —
  // fabricated, and gone with the rest of the invented subtype-0x01 shape.
  assert.deepStrictEqual(progress.map((p) => p.phase),
    ['connected', 'ready', 'settling', 'settling', 'settling', 'settling', 'settling',
      'settling', 'settling']);
  for (const p of progress) {
    assert.strictEqual(p.id, 'M1', 'every progress event carries the request id');
    assert.strictEqual(p.proto, 1);
    assert.strictEqual(typeof p.message, 'string');
  }

  const connected = progress[0];
  assert.strictEqual(connected.driver, 'drtrust');
  assert.deepStrictEqual(connected.device, { name: H.EXPECTED.name, address: RECORDED_ADDRESS });

  const weights = progress.filter((p) => p.phase === 'settling');
  assert.deepStrictEqual(weights.map((p) => p.weightKg), WEIGHT_LADDER);
  // The live weights carry no impedance; only the record does, and it carries
  // the weight too, so the last event is the one with both.
  assert.deepStrictEqual(weights.slice(0, -1).map((p) => p.impedanceOhm),
    [null, null, null, null, null, null]);
  assert.strictEqual(weights[weights.length - 1].impedanceOhm, H.EXPECTED.impedanceOhm);
});

// The Electron main process destructures this envelope. A field that quietly
// disappears, or a new one that quietly appears, is a renderer crash or a
// silent leak of something the host never asked for.
test('INT-MEAS-03  the measurement envelope has exactly the twenty documented top-level fields', async () => {
  const { terminal } = await H.measureOnce({});
  assert.deepStrictEqual(Object.keys(terminal).sort(), ENVELOPE_KEYS);
});

// A field whose type changes — a number that becomes a string, an object that
// becomes null — is not caught until the renderer formats it and prints
// "undefined kg" to the person on the scale.
test('INT-MEAS-04  every envelope field has its documented type', async () => {
  const { terminal: m } = await H.measureOnce({});

  H.assertShape(assert, m, {
    proto: 'number', type: 'string', id: 'string', ok: 'boolean', timestamp: 'string',
    source: 'string',
    device: 'object', model: 'string', measured: 'object', derived: 'object',
    units: 'object', confidence: 'object', trust: 'object',
    bodyFatRecommended: 'object', crossCheck: 'object', vendorMatch: 'object', flags: 'array',
    warnings: 'array', omitted: 'object', profile: 'object',
  }, 'measurement');

  assert.strictEqual(m.type, 'measurement');
  assert.strictEqual(m.ok, true);
  H.assertShape(assert, m.device, { name: 'string', address: 'string' }, 'device');
  H.assertShape(assert, m.measured, { weightKg: 'number', impedanceOhm: 'number' }, 'measured');
  H.assertShape(assert, m.trust, { impedanceFree: 'boolean', impedanceDerived: 'boolean' }, 'trust');
  H.assertShape(assert, m.bodyFatRecommended, { key: 'string', value: 'number' }, 'bodyFatRecommended');
  H.assertShape(assert, m.crossCheck, {
    impedanceBased: 'number', bmiBased: 'number', gapPoints: 'number',
    oneSigma: 'number', twoSigma: 'number',
  }, 'crossCheck');
  H.assertShape(assert, m.profile, { sex: 'string', age: 'number', heightCm: 'number' }, 'profile');
  assert.deepStrictEqual(Object.keys(m.trust).sort(), ['impedanceDerived', 'impedanceFree']);
});

// The two numbers the scale actually sends. If the decoder drifts by a factor
// of ten or loses the impedance, the user is shown someone else's body.
test('INT-MEAS-05  measured.weightKg and measured.impedanceOhm are exactly what the recorded session sent', async () => {
  const { terminal, progress } = await H.measureOnce({});

  assert.strictEqual(terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.deepStrictEqual(Object.keys(terminal.measured).sort(), ['impedanceOhm', 'weightKg']);

  // The final progress frame and the envelope must agree; the app shows the
  // live number and then the settled one, and they must not disagree.
  const last = progress.filter((p) => p.phase === 'settling').pop();
  assert.strictEqual(last.weightKg, terminal.measured.weightKg);
  assert.strictEqual(last.impedanceOhm, terminal.measured.impedanceOhm);
});

// The renderer looks up units[k] and confidence[k] for each derived key. A
// missing entry prints a number with no unit; a stray entry renders a row with
// no value.
test('INT-MEAS-06  units and confidence carry exactly the same keys as derived, in the same order', async () => {
  const { terminal: m } = await H.measureOnce({});
  const keys = Object.keys(m.derived);

  assert.deepStrictEqual(Object.keys(m.units), keys);
  assert.deepStrictEqual(Object.keys(m.confidence), keys);
  for (const k of keys) {
    assert.strictEqual(typeof m.units[k], 'string', `units.${k} is a string`);
    assert.strictEqual(typeof m.confidence[k], 'string', `confidence.${k} is a string`);
  }

  assert.strictEqual(m.units.bmi, 'kg/m²');
  assert.strictEqual(m.units.bodyFatPercent, '%');
  assert.strictEqual(m.units.bmrKcal, 'kcal/day');
  assert.strictEqual(m.units.bodyWaterLitres, 'L');
  assert.strictEqual(m.confidence.bmi, 'derived-literature');
  assert.strictEqual(m.confidence.boneMassKg, 'derived-vendor-convention');
});

// NaN, Infinity and nested objects do not survive JSON, so any of them in
// `derived` reaches the renderer as null and is displayed as an empty cell.
test('INT-MEAS-07  derived holds twenty-four entries, each a finite number or a string', async () => {
  const { terminal: m } = await H.measureOnce({});
  const entries = Object.entries(m.derived);

  assert.strictEqual(entries.length, 24);
  assert.deepStrictEqual(Object.keys(m.derived).sort(),
    H.IMPEDANCE_FREE_KEYS.concat(H.IMPEDANCE_ONLY_KEYS).sort());
  for (const [k, v] of entries) {
    const ok = typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    assert.ok(ok, `derived.${k} is a finite number or a string, got ${JSON.stringify(v)}`);
  }
});

// These are the numbers a person reads about their own body. A silent change
// to any coefficient shows up here rather than in someone's weekly trend.
test('INT-MEAS-08  the derived panel matches the recorded session value for value', async () => {
  const { terminal } = await H.measureOnce({});
  assert.deepStrictEqual(terminal.derived, GOLDEN_DERIVED);
});

// stdout is the protocol channel. A line that is not exactly one canonical JSON
// object — a duplicate key, an embedded newline, a stray byte — desynchronises
// the host's line reader and every later reply is lost.
test('INT-MEAS-09  the measurement is one canonical JSON line that survives a parse and re-stringify unchanged', async () => {
  const { stdout, events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement';
    },
  });

  const lines = stdout.split('\n').filter((l) => l.trim());
  const raw = lines.filter((l) => l.includes('"type":"measurement"'));
  assert.strictEqual(raw.length, 1, 'exactly one measurement line on stdout');
  assert.strictEqual(JSON.stringify(JSON.parse(raw[0])), raw[0], 'the wire line is already canonical JSON');
  assert.deepStrictEqual(JSON.parse(raw[0]), H.first(events, 'measurement'));
});

// The Electron main process forwards this over IPC, which uses the structured
// clone algorithm. Anything not cloneable throws "object could not be cloned"
// and the renderer never receives the result.
test('INT-MEAS-10  the envelope survives a structuredClone round trip unchanged', async () => {
  const { terminal } = await H.measureOnce({});

  const clone = structuredClone(terminal);
  assert.notStrictEqual(clone, terminal, 'the clone is a distinct object');
  assert.deepStrictEqual(clone, terminal);
  assert.deepStrictEqual(structuredClone(JSON.parse(JSON.stringify(terminal))), terminal);
  assert.strictEqual(JSON.stringify(clone), JSON.stringify(terminal));
});

// The timestamp is what a history view sorts and groups by. A locale string, a
// millisecond epoch, or a stale value would file today's weigh-in under 1970.
test('INT-MEAS-11  the timestamp is an ISO 8601 UTC instant, and it is now', async () => {
  const before = Date.now();
  const { terminal } = await H.measureOnce({});
  const after = Date.now();

  const ts = terminal.timestamp;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const parsed = Date.parse(ts);
  assert.ok(Number.isFinite(parsed), 'the timestamp parses');
  assert.strictEqual(new Date(parsed).toISOString(), ts, 'it round trips through Date');
  assert.ok(parsed >= before - 1000 && parsed <= after + 1000,
    `timestamp ${ts} falls inside the run window`);
});

// The app names the scale it just read and remembers its address. A null here
// shows "connected to undefined" and loses the saved device on the next run.
test('INT-MEAS-12  device and model are populated from the session, not left null', async () => {
  const { terminal } = await H.measureOnce({});

  assert.deepStrictEqual(terminal.device, { name: H.EXPECTED.name, address: RECORDED_ADDRESS });
  assert.strictEqual(terminal.model, 'Dr Trust SSW532');
  assert.notStrictEqual(terminal.model, null);
});

// Replies may interleave, so the host correlates on id alone. An id that is
// coerced, dropped or renamed strands the caller's promise for ever.
test('INT-MEAS-13  a numeric request id is echoed unchanged on accepted, every progress and the measurement', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 42, cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });

  const measurement = H.first(events, 'measurement');
  assert.ok(measurement, 'the measurement arrived');
  assert.strictEqual(measurement.id, 42);
  assert.strictEqual(typeof measurement.id, 'number', 'the id was not stringified');
  assert.strictEqual(H.first(events, 'accepted').id, 42);

  const progress = H.byType(events, 'progress');
  assert.ok(progress.length > 0, 'progress was emitted');
  for (const p of progress) assert.strictEqual(p.id, 42);
});

// The host sets these per request. If the service rejected an unknown field, or
// echoed request fields back into the envelope, a caller that passes a device
// name would get BAD_REQUEST or leak the address into the stored result.
test('INT-MEAS-14  per-request options are accepted and never appear in the envelope', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({
          id: 'OPT', cmd: 'measure', profile: H.PROFILE,
          timeoutSec: 45, scanTimeoutSec: 8,
          deviceName: 'SSW533', address: 'AA:BB:CC:DD:EE:FF',
        });
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'OPT';
    },
  });

  const m = H.first(events, 'measurement');
  assert.ok(m, `expected a measurement, saw [${events.map((e) => e.type).join(', ')}]`);
  assert.strictEqual(H.byType(events, 'error').length, 0, 'no option was rejected');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
  assert.deepStrictEqual(Object.keys(m).sort(), ENVELOPE_KEYS);
  for (const leaked of ['timeoutSec', 'scanTimeoutSec', 'deviceName', 'address', 'cmd']) {
    assert.strictEqual(leaked in m, false, `${leaked} must not be echoed into the envelope`);
  }
  assert.deepStrictEqual(m.profile, H.PROFILE, 'options did not contaminate the profile');
});

// The service is long-lived: the app measures, the person steps off, and
// measures again. If state from the first run leaks, the second returns BUSY,
// or silently repeats the first result.
test('INT-MEAS-15  two sequential measurements on one service instance both succeed', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'A', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'measurement' && ev.id === 'A') { send({ id: 'B', cmd: 'measure', profile: H.PROFILE }); return false; }
      return (ev.type === 'measurement' && ev.id === 'B') || ev.type === 'error';
    },
  });

  assert.strictEqual(H.byType(events, 'error').length, 0, 'neither run failed');
  const [a, b] = H.byType(events, 'measurement');
  assert.ok(a && b, `expected two measurements, saw [${events.map((e) => e.type).join(', ')}]`);
  assert.strictEqual(a.id, 'A');
  assert.strictEqual(b.id, 'B');
  assert.deepStrictEqual(H.byType(events, 'accepted').map((e) => e.id), ['A', 'B']);
  assert.deepStrictEqual(b.measured, a.measured, 'the same session replays to the same numbers');
  assert.deepStrictEqual(b.derived, a.derived);
  assert.notStrictEqual(b.timestamp, a.timestamp, 'the second result is freshly computed');
  assert.ok(Date.parse(b.timestamp) >= Date.parse(a.timestamp));

  // The second run must not start before the first has been answered.
  const order = events.filter((e) => e.type === 'accepted' || e.type === 'measurement')
    .map((e) => `${e.type}:${e.id}`);
  assert.deepStrictEqual(order, ['accepted:A', 'measurement:A', 'accepted:B', 'measurement:B']);
});

// The host owns the profile and sends it every time. If the service normalised
// it wrongly, stored one, or added a field, one person's numbers would be
// computed from another person's height.
test('INT-MEAS-16  the profile is echoed back as exactly the three fields the host sent', async () => {
  const { terminal, hello } = await H.measureOnce({
    profile: { age: 39, heightCm: 180, sex: 'MALE' },
  });

  assert.deepStrictEqual(terminal.profile, { sex: 'male', age: 39, heightCm: 180 });
  assert.deepStrictEqual(Object.keys(terminal.profile).sort(), ['age', 'heightCm', 'sex']);
  assert.strictEqual(hello.profile.persisted, false);
  assert.strictEqual(hello.profile.suppliedBy, 'host');
});

// Proof the request's profile is actually used. If the service ever fell back
// to a remembered profile, everyone on a shared scale would be shown the same
// body composition.
test('INT-MEAS-17  a different profile on the same recorded session produces different numbers', async () => {
  const { terminal } = await H.measureOnce({ profile: { age: 25, heightCm: 160, sex: 'female' } });

  assert.deepStrictEqual(terminal.profile, { sex: 'female', age: 25, heightCm: 160 });
  assert.deepStrictEqual(terminal.measured, { weightKg: H.EXPECTED.weightKg, impedanceOhm: H.EXPECTED.impedanceOhm });

  assert.strictEqual(terminal.derived.bmi, 38.2);
  assert.strictEqual(terminal.derived.bmrKcal, 1693);
  assert.strictEqual(terminal.derived.bodyFatPercentBmiAnchor, 46.2);
  assert.strictEqual(terminal.derived.bodyFatPercent, 49);
  assert.strictEqual(terminal.derived.healthyWeightRangeKg, '47.4 – 64');

  assert.notStrictEqual(terminal.derived.bmi, GOLDEN_DERIVED.bmi);
  assert.notStrictEqual(terminal.derived.bmrKcal, GOLDEN_DERIVED.bmrKcal);
});

// The app shows one headline body fat figure. If the pointer and the value
// disagree, it prints the impedance number while labelling it as the BMI
// estimate, or the other way round.
test('INT-MEAS-18  bodyFatRecommended points at a real derived key and carries that key value', async () => {
  const { terminal: m } = await H.measureOnce({});

  const key = m.derived.bodyFatRecommendedKey;
  assert.strictEqual(key, 'bodyFatPercent');
  assert.deepStrictEqual(m.bodyFatRecommended, { key, value: m.derived[key] });
  assert.strictEqual(m.bodyFatRecommended.value, 36);
  assert.strictEqual(m.trust.impedanceDerived, true);
  assert.strictEqual(m.flags.some((f) => f.severity === 'fatal'), false,
    'no fatal rule fired, so the impedance figure is the recommended one');
});

// crossCheck is what justifies trusting the impedance half of the panel. If it
// stopped agreeing with the two body fat figures it summarises, the app would
// show a disagreement warning that contradicts the numbers beside it.
test('INT-MEAS-19  crossCheck restates the two body fat methods and their spread', async () => {
  const { terminal: m } = await H.measureOnce({});

  assert.strictEqual(m.crossCheck.impedanceBased, m.derived.bodyFatPercent);
  assert.strictEqual(m.crossCheck.bmiBased, m.derived.bodyFatPercentBmiAnchor);
  assert.strictEqual(m.crossCheck.gapPoints, m.derived.bodyFatGapPoints);
  assert.strictEqual(m.crossCheck.oneSigma, 6.7);
  assert.strictEqual(m.crossCheck.twoSigma, 13.4);

  // 6.9 points is over one sigma and under two, which is exactly the warn band.
  assert.ok(m.crossCheck.gapPoints > m.crossCheck.oneSigma);
  assert.ok(m.crossCheck.gapPoints <= m.crossCheck.twoSigma);
  assert.deepStrictEqual(m.flags.map((f) => f.rule).filter((r) => r === 'T8'), ['T8']);
  assert.strictEqual(m.flags.some((f) => f.rule === 'T3'), false, 'the fatal disagreement rule did not fire');
});

// Bare feet on a cold morning often produce no impedance at all. That is a
// normal weigh-in, not an error: the app must still show weight, BMI and BMR
// rather than a red failure dialog.
test('INT-MEAS-20  a session with no impedance still returns ok with exactly the nine impedance-free metrics', async () => {
  const { terminal: m } = await H.measureOnce({ replay: H.fixtureWithoutImpedance('meas-noimp') });

  assert.strictEqual(m.type, 'measurement');
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.measured.impedanceOhm, null);
  assert.strictEqual(m.measured.weightKg, 98.25, 'the last streamed weight is still reported');

  assert.deepStrictEqual(Object.keys(m.derived).sort(), H.IMPEDANCE_FREE_KEYS.slice().sort());
  assert.strictEqual(Object.keys(m.derived).length, 9);
  assert.deepStrictEqual(Object.keys(m.units), Object.keys(m.derived));
  assert.deepStrictEqual(Object.keys(m.confidence), Object.keys(m.derived));

  assert.deepStrictEqual(m.trust, { impedanceFree: true, impedanceDerived: false });
  assert.strictEqual(m.crossCheck, null);
  assert.deepStrictEqual(m.bodyFatRecommended,
    { key: 'bodyFatPercentBmiAnchor', value: m.derived.bodyFatPercentBmiAnchor });
  assert.deepStrictEqual(m.flags, []);
  assert.deepStrictEqual(m.warnings, [
    'No impedance was measured, so body composition is unavailable. Stand with bare feet on the metal pads.',
  ]);
});

// `omitted` is the app's answer to "where is my visceral fat rating?". If a key
// moved into `derived`, the app would start displaying a number the project
// deliberately refuses to invent.
test('INT-MEAS-21  flags, warnings and omitted are well formed and omitted never overlaps derived', async () => {
  const { terminal: m } = await H.measureOnce({});

  assert.deepStrictEqual(Object.keys(m.omitted), OMITTED_KEYS);
  for (const k of OMITTED_KEYS) {
    assert.strictEqual(typeof m.omitted[k], 'string', `omitted.${k} explains itself`);
    assert.ok(m.omitted[k].length > 20, `omitted.${k} carries a real reason`);
    assert.strictEqual(k in m.derived, false, `${k} is omitted, so it must not be derived`);
    assert.strictEqual(k in m.units, false);
  }

  assert.deepStrictEqual(m.flags.map((f) => f.rule), ['T8', 'T10']);
  for (const f of m.flags) {
    H.assertShape(assert, f, { rule: 'string', severity: 'string', message: 'string' }, 'flag');
    assert.ok(['fatal', 'warn'].includes(f.severity), `severity ${f.severity} is fatal or warn`);
  }

  assert.deepStrictEqual(m.warnings, [
    'The scale sent two numbers, your weight and one impedance value. Everything else was estimated from them.',
  ]);
});

// An impedance outside the physically possible band must not be presented as
// fact. It still yields a full panel, so the app has to read `trust`, not the
// key count, to decide what to grey out.
test('INT-MEAS-22  an impedance that fails its checks still yields twenty-four derived keys with trust.impedanceDerived false', async () => {
  const { terminal: m } = await H.measureOnce({ replay: fixtureWithUntrustworthyImpedance('meas-oob') });

  assert.strictEqual(m.type, 'measurement');
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.measured.impedanceOhm, 1300);
  assert.strictEqual(Object.keys(m.derived).length, 24,
    'the panel is still complete; only its trustworthiness changed');

  assert.deepStrictEqual(m.trust, { impedanceFree: true, impedanceDerived: false });
  assert.ok(m.flags.some((f) => f.rule === 'T2' && f.severity === 'fatal'), 'T2 fired');
  assert.strictEqual(m.derived.bodyFatRecommendedKey, 'bodyFatPercentBmiAnchor',
    'the headline falls back to the impedance-free estimate');
  assert.deepStrictEqual(m.bodyFatRecommended,
    { key: 'bodyFatPercentBmiAnchor', value: m.derived.bodyFatPercentBmiAnchor });

  // Every fatal rule must clear the trust flag, and nothing else may set it.
  const fatal = m.flags.filter((f) => f.severity === 'fatal');
  assert.ok(fatal.length > 0);
  assert.strictEqual(m.trust.impedanceDerived, false);
});

// stdout is the protocol and stderr is for humans. One human sentence written
// to stdout breaks the host's JSON reader mid-measurement, with a person still
// standing on the scale.
test('INT-MEAS-23  every stdout line during a measurement is one protocol object, and the commentary went to stderr', async () => {
  const { stdout, stderr } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement';
    },
  });

  const lines = stdout.split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 12, `expected the full exchange on stdout, got ${lines.length} lines`);
  const seen = [];
  for (const line of lines) {
    const o = JSON.parse(line);               // throws, and fails the test, on anything else
    assert.strictEqual(o.proto, 1, `line carries proto 1: ${line}`);
    assert.strictEqual(typeof o.type, 'string');
    assert.ok(H.TERMINAL.has(o.type) || H.STREAMING.has(o.type) || o.type === 'hello',
      `${o.type} is a documented event type`);
    seen.push(o.type);
  }
  assert.ok(seen.includes('measurement'));

  assert.ok(stderr.includes('device SSW533'), 'the human diagnostics went to stderr');
  assert.strictEqual(stderr.includes('"type":"measurement"'), false,
    'no protocol object was duplicated onto stderr');
});
