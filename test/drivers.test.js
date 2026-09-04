'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BCS = require('../bcs.js');
const D = require('../drivers.js');

function frame(bytes) { const b = new Uint8Array(20); b.set(bytes); return b; }
function be24(v) { return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]; }
function le16(v) { return [v & 0xff, (v >> 8) & 0xff]; }

function makeCtx() {
  const calls = { logs: [], subs: [], writes: [] };
  return {
    calls,
    state: {}, scalesDb: require('../scales-db.js'),
    log: (m, c, d) => calls.logs.push([c, m, d]),
    profile: () => ({ sex: 'male', age: 35, heightCm: 175 }),
    now: () => 1767000000000,
    hex: BCS.hex,
    subscribe: async (s, c) => { calls.subs.push([s, c]); return true; },
    subscribeAll: async () => {},
    write: async (s, c, b, what) => { calls.writes.push({ s, c, hex: BCS.hex(b), what }); return true; },
  };
}

test('driver selection routes each device to the right driver', () => {
  assert.equal(D.select({ name: 'SSW533', family: 'vendorFFB0' }).id, 'drtrust');
  assert.equal(D.select({ name: 'SSW532', family: 'vendorFFB0' }).id, 'drtrust');
  assert.equal(D.select({ name: 'MIBFS', family: 'xiaomi' }).id, 'xiaomi');
  assert.equal(D.select({ name: 'Beurer BF720', family: 'standard' }).id, 'standard');
  assert.equal(D.select({ name: 'Nothing', family: 'unknown' }).id, 'generic');
});

test('Xiaomi driver decodes a Mi record and adds derived composition', async () => {
  const ctx = makeCtx();
  const r = D.xiaomi.onFrame(0x2a9c, BCS.hexToBytes('02 22 ea 07 09 04 0f 35 00 f4 01 c0 3a'), ctx);
  assert.equal(r.values.Weight, 75.2);
  assert.equal(r.values.Impedance, 500);
  assert.ok(r.values.bodyFatPercent > 0, 'derived body fat present');
  assert.ok(r.warnings.some((w) => /estimated from them/.test(w)));
  assert.equal(D.xiaomi.onFrame(0x2a9c, new Uint8Array(7), ctx), null);
});

test('standard driver subscribes to the standard measurement characteristics', async () => {
  const ctx = makeCtx();
  await D.standard.init(ctx);
  const pairs = ctx.calls.subs.map((x) => x[1]);
  assert.ok(pairs.includes(0x2a9c) && pairs.includes(0x2a9d) && pairs.includes(0x2a9f));
  assert.equal(D.standard.onFrame(), null, 'decoding is left to bcs.js');
});


// ===========================================================================
// Dr Trust SSW533 — every frame below is a verbatim capture from real hardware
// during one weigh-in. The scale's own display read 98.50 kg.
// ===========================================================================
const REAL = {
  idle:      '17 00 07 00 a2 01 00 00 00 00 00 03',
  stepOn:    '20 00 07 00 a2 01 00 00 00 32 00 15',
  rising:    '2f 00 07 00 a2 01 00 01 13 32 00 09',
  overshoot: '32 00 07 00 a2 01 00 01 8d 12 00 03',
  finalW:    '76 00 07 00 a2 00 00 01 80 c4 00 07',
  record:    '06 00 23 00 a7 00 00 0c 0e 25 01 80 c4 00 0a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 15',
  recordMid: '04 00 23 00 a7 00 00 0b ef 25 01 6b ac 00 0a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 08',
  setup:     '03 00 1d 00 aa 33 71 1e 1a 64 25 01 0a 00 00 00 00 00 00 00 00 00 00 00 00 00 44 00 00 00 00 00 00 1e',
};
const feed = async (hexes) => {
  const ctx = makeCtx();
  await D.drTrust.init(ctx);
  const out = [];
  for (const h of hexes) {
    const b = BCS.hexToBytes(h);
    const u = b.length === 12 ? 0xffb2 : 0xffb3;
    out.push(D.drTrust.onFrame(u, b, ctx));
  }
  return { ctx, out };
};

test('checksum rule sum(bytes 3..len-2) mod 32 holds for every real frame', () => {
  for (const [name, hex] of Object.entries(REAL)) {
    const b = BCS.hexToBytes(hex);
    assert.equal(D.drTrust.checksum(b), b[b.length - 1], name + ' checksum');
    assert.equal(D.drTrust.checksumOk(b), true, name);
  }
  const corrupt = BCS.hexToBytes(REAL.finalW);
  corrupt[7] ^= 0xff;
  assert.equal(D.drTrust.checksumOk(corrupt), false, 'a flipped byte must fail the checksum');
});

test('the real final frame decodes to exactly 98.50 kg — the number on the scale display', async () => {
  const { out } = await feed([REAL.finalW]);
  const r = out[0];
  assert.equal(r.values.weight, 98.5);
  assert.equal(r.values.state, 'final');
  assert.match(r.characteristic, /FINAL WEIGHT/);
});

test('the real step-on sequence decodes as a rising curve settling on 98.50', async () => {
  const { out } = await feed([REAL.idle, REAL.stepOn, REAL.rising, REAL.overshoot, REAL.finalW]);
  assert.deepEqual(out.map((r) => r.values.weight), [0, 0.05, 70.45, 101.65, 98.5]);
  assert.deepEqual(out.map((r) => r.values.state), ['idle', 'settling', 'settling', 'settling', 'final']);
});

test('an empty scale reads exactly 0, never a heuristic guess', async () => {
  const { out } = await feed([REAL.idle]);
  assert.equal(out[0].values.weight, 0);
  assert.equal(out[0].values.state, 'idle');
  assert.match(out[0].characteristic, /idle/);
  assert.ok(out[0].warnings.some((w) => /Nobody on the scale/.test(w)));
});

test('the held reading the scale repeats after step-off is reported once, then suppressed', async () => {
  const { out } = await feed([REAL.finalW, REAL.finalW, REAL.finalW]);
  assert.equal(out[0].values.state, 'final', 'first one is the real result');
  assert.equal(out[1], D.SUPPRESS, 'repeats are suppressed, not re-reported');
  assert.equal(out[2], D.SUPPRESS);
  assert.notEqual(out[1], null, 'suppressed must be distinct from "not my frame", or the viewer falls back to guessing');
});

test('stepping back on after a final reading starts a fresh measurement', async () => {
  const { out } = await feed([REAL.finalW, REAL.finalW, REAL.idle, REAL.rising, REAL.finalW]);
  assert.equal(out[0].values.state, 'final');
  assert.equal(out[1], D.SUPPRESS);
  assert.equal(out[2].values.state, 'idle');
  assert.equal(out[3].values.state, 'settling');
  assert.equal(out[4].values.state, 'final', 'a new final is reported, not suppressed');
});

test('the real record frame yields 98.50 kg and 308.6 ohm', async () => {
  const { out } = await feed([REAL.record]);
  const r = out[0];
  assert.equal(r.values.weight, 98.5);
  assert.equal(r.values.impedanceOhm, 308.6);
  assert.equal(r.fields.find((f) => f.name === 'Impedance').unit, 'Ω');
});

test('the mid-measurement record frame decodes its own weight and impedance', async () => {
  const { out } = await feed([REAL.recordMid]);
  assert.equal(out[0].values.weight, 93.1);
  assert.equal(out[0].values.impedanceOhm, 305.5);
});

test('a record frame carrying impedance drives derived body composition', async () => {
  const { out } = await feed([REAL.record]);
  const r = out[0];
  assert.ok(r.values.bodyFatPercent !== undefined, 'body composition is derived');
  assert.ok(r.values.bodyFatPercentBmiAnchor !== undefined, 'the impedance-free body fat anchor is included');
  assert.ok(r.warnings.some((w) => /did not survive their range checks/.test(w)),
    'and this reading is flagged, because 308.6 ohm is a bad-contact foot-to-foot value');
  assert.ok(r.fields.some((f) => /DERIVED/.test(f.note || '')));
  assert.ok(r.warnings.some((w) => /estimated from them/.test(w)));
});

test('the real setup frame is recognised and yields a session id', async () => {
  const { ctx, out } = await feed([REAL.setup]);
  assert.ok(out[0], 'the 0x1D setup frame must be recognised');
  assert.equal(ctx.state.drt.session, 0x00);
  assert.match(out[0].characteristic, /session setup/i);
});

test('SSW532 (openScale offset-1) frames still decode alongside the SSW533', async () => {
  // marker 0x07 at index 1, 0xA2 at index 3, stability 0x03, weight BE24 at 6
  const b = BCS.toBytes([0x01, 0x07, 0x00, 0xa2, 0x03, 0x00, 0x01, 0x80, 0xc4]);
  const ctx = makeCtx();
  await D.drTrust.init(ctx);
  const r = D.drTrust.onFrame(0xffb2, b, ctx);
  assert.ok(r, 'the older layout must still decode');
  assert.equal(r.values.weight, 98.5);
  assert.equal(ctx.state.drt.weightOffset, 1);
});

test('frames that are not ours are rejected rather than guessed at', async () => {
  const ctx = makeCtx();
  await D.drTrust.init(ctx);
  assert.equal(D.drTrust.onFrame(0xffb2, BCS.hexToBytes('01 02 03 04 05 06 07 08 09'), ctx), null);
  assert.equal(D.drTrust.onFrame(0xffb2, BCS.hexToBytes('17 00 07 00 99 01 00 00 00 00 00 03'), ctx), null,
    '0x07 without the 0xA2 confirmation must not match');
  assert.equal(D.drTrust.onFrame(0xffb3, BCS.hexToBytes('aa bb cc dd ee ff 11 22'), ctx), null);
});

test('a corrupt frame still decodes but is flagged', async () => {
  const ctx = makeCtx();
  await D.drTrust.init(ctx);
  const b = BCS.hexToBytes(REAL.finalW);
  b[11] = 0x00; // wrong checksum
  const r = D.drTrust.onFrame(0xffb2, b, ctx);
  assert.equal(r.values.weight, 98.5);
  assert.ok(r.warnings.some((w) => /Checksum mismatch/.test(w)));
});

test('the range checks catch the foot-to-foot problem on the real bad-contact reading', () => {
  const BIA = require('../bia.js');
  const bad = BIA.estimate({ weightKg: 98.5, impedanceOhm: 308.6, heightCm: 180, age: 39, sex: 'male' });
  assert.equal(bad.trust.impedanceDerived, false, 'impedance block is marked untrustworthy');
  assert.equal(bad.trust.impedanceFree, true, 'BMI and weight figures stay usable regardless');
  assert.equal(bad.values.bodyFatRecommendedKey, 'bodyFatPercentBmiAnchor', 'falls back to the impedance-free figure');
  const fired = bad.flags.filter((f) => f.severity === 'fatal').map((f) => f.rule);
  assert.ok(fired.includes('T3'), 'the two body-fat methods disagree beyond two standard errors');
  assert.ok(fired.includes('T4'), 'and fat-free mass index exceeds the drug-free ceiling');

  // The user's own good reading must pass, or the check is worthless.
  const good = BIA.estimate({ weightKg: 97.9, impedanceOhm: 529.9, heightCm: 180, age: 39, sex: 'male' });
  assert.equal(good.trust.impedanceDerived, true, 'a plausible reading is not cried wolf over');
  assert.equal(good.values.bodyFatRecommendedKey, 'bodyFatPercent');
  assert.ok(!good.flags.some((f) => f.severity === 'fatal'));
});

test('body composition is refused outright when there is no impedance', () => {
  const BIA = require('../bia.js');
  const r = BIA.estimate({ weightKg: 97.9, impedanceOhm: 0, heightCm: 180, age: 39, sex: 'male' });
  assert.equal(r.noImpedance, true);
  assert.equal(r.values.fatFreeMassKg, undefined, 'no lean tissue figures invented');
  assert.ok(r.values.bmi > 0, 'but BMI still works');
  assert.ok(r.values.bodyFatPercentBmiAnchor > 0, 'and so does the BMI body fat method');
  assert.equal(r.trust.impedanceFree, true);
});

test('metrics with no defensible formula are omitted with a stated reason', () => {
  const BIA = require('../bia.js');
  const r = BIA.estimate({ weightKg: 97.9, impedanceOhm: 529.9, heightCm: 180, age: 39, sex: 'male' });
  for (const k of ['visceralFatRating', 'metabolicAgeYears', 'subcutaneousFatPercent']) {
    assert.equal(r.values[k], undefined, k + ' must not be invented');
    assert.ok(r.omitted[k] && r.omitted[k].length > 40, k + ' must carry a stated reason');
  }
});

test('fat-free mass never uses the reactance-dependent equation this scale cannot feed', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'bia.js'), 'utf8');
  assert.ok(!/-10\.68\s*\+\s*0\.65/.test(src), 'the Kyle coefficients must not be present');
  assert.ok(/reactance/i.test(src), 'and the omission must be explained');
  const BIA = require('../bia.js');
  assert.ok(BIA.OMITTED.fatFreeMassKyle2001);
});

test('impedance from the record frame is carried onto the later final-weight panel', async () => {
  const { out } = await feed([REAL.record, REAL.finalW]);
  const final = out[1];
  assert.equal(final.values.weight, 98.5);
  assert.equal(final.values.impedanceOhm, 308.6, 'the final view must not lose the impedance');
  assert.ok(final.fields.some((f) => f.name === 'Impedance' && f.value === 308.6));
});

test('the full real weigh-in sequence ends on 98.50 kg with 308.6 ohm', async () => {
  const { out } = await feed([REAL.setup, REAL.idle, REAL.stepOn, REAL.rising, REAL.overshoot, REAL.recordMid, REAL.record, REAL.finalW]);
  const final = out[out.length - 1];
  assert.equal(final.values.weight, 98.5);
  assert.equal(final.values.impedanceOhm, 308.6);
  assert.equal(final.values.state, 'final');
  assert.equal(out.filter((r) => r && r.values && r.values.state === 'idle').length, 1);
});
