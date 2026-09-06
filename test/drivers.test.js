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
  /*
   * Frame type 0x23 has subtypes. 0x00 carries weight and a timestamp; 0x01
   * carries the impedances, as three little-endian uint16 in tenths of an ohm —
   * trunk, right leg, left leg — whose sum is the whole-body figure.
   *
   * The `record` frames above are subtype 0x00, and their bytes [7][8] are the
   * low half of that timestamp. Reading them as a big-endian impedance is what
   * this driver did for a long time, and it is why one recording appeared to
   * carry a perfectly plausible 529.9 ohm that was really a clock.
   */
  impedance:    '07 00 23 01 a7 00 00 04 04 05 04 05 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02',
  impedanceMid: '05 00 23 01 a7 00 00 f8 03 f9 03 f9 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1b',
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

test('the real record frame yields 98.50 kg and no impedance', async () => {
  // Subtype 0x00 carries a weight and a timestamp. It has never carried an
  // impedance; the bytes once read as one are the low half of that timestamp.
  const { out } = await feed([REAL.record]);
  const r = out[0];
  assert.equal(r.values.weight, 98.5);
  assert.equal(r.values.impedanceOhm, null, 'a weight frame carries no impedance');
  assert.equal(r.values.subtype, 0x00);
});

test('the impedance frame yields 308.6 ohm as three segments', async () => {
  const { out } = await feed([REAL.impedance]);
  const r = out[0];
  assert.equal(r.values.subtype, 0x01);
  assert.equal(r.values.impedanceOhm, 308.6, 'trunk plus right leg plus left leg');
  assert.equal(r.values.weight, undefined, 'and no weight: those bytes are impedance here');
  assert.equal(r.fields.find((f) => f.name === 'Impedance').unit, 'Ω');
});

test('the mid-measurement record frame decodes its own weight', async () => {
  const { out } = await feed([REAL.recordMid]);
  assert.equal(out[0].values.weight, 93.1);
  assert.equal(out[0].values.impedanceOhm, null, 'a weight frame never carries one');
});

test('the mid-measurement impedance frame decodes its own segments', async () => {
  const { out } = await feed([REAL.impedanceMid]);
  assert.equal(out[0].values.impedanceOhm, 305, 'trunk plus both legs');
});

test('a record frame carrying impedance drives derived body composition', async () => {
  // The impedance arrives on its own frame; body composition appears once the
  // driver has both that and a weight.
  const { out } = await feed([REAL.record, REAL.impedance]);
  const r = out[out.length - 1];
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
  // Byte 0, the frame's sequence number — not byte 1, which is padding. The
  // real frame here is `03 00 1d 00 aa ...`, so the id the scale wants echoed
  // is 0x03. This previously asserted 0x00, which was the bug, not the spec.
  assert.equal(ctx.state.drt.session, 0x03);
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
  const { out } = await feed([REAL.record, REAL.impedance, REAL.finalW]);
  const final = out[out.length - 1];
  assert.equal(final.values.weight, 98.5);
  assert.equal(final.values.impedanceOhm, 308.6, 'the final view must not lose the impedance');
  assert.ok(final.fields.some((f) => f.name === 'Impedance' && f.value === 308.6));
});

test('the full real weigh-in sequence ends on 98.50 kg with 308.6 ohm', async () => {
  const { out } = await feed([REAL.setup, REAL.idle, REAL.stepOn, REAL.rising, REAL.overshoot,
    REAL.recordMid, REAL.record, REAL.impedance, REAL.finalW]);
  const final = out[out.length - 1];
  assert.equal(final.values.weight, 98.5);
  assert.equal(final.values.impedanceOhm, 308.6);
  assert.equal(final.values.state, 'final');
  assert.equal(out.filter((r) => r && r.values && r.values.state === 'idle').length, 1);
});

/*
 * The impedance program has to be asked for.
 *
 * Nothing we did to the decoder could ever have produced body composition,
 * because the scale was never told to measure any. These lock the request and
 * the two profile fields that were being sent as constants.
 */
test('Dr Trust: the weight locking asks the scale to start its impedance program', async () => {
  const writes = [];
  const ctx = {
    state: { drt: { session: 0x2a, biaRequested: false } },
    profile: () => ({ heightCm: 180, age: 39, sex: 'male' }),
    now: () => 1757072503000,
    log: () => {},
    write: async (svc, chr, bytes, what) => { writes.push({ chr, bytes: [...bytes], what }); return true; },
  };

  await D.drTrust.startBia(ctx, 96.4);

  const start = writes.find((w) => /BD 09/i.test(w.what));
  assert.ok(start, `no start command was sent; wrote [${writes.map((w) => w.what).join(', ')}]`);
  assert.strictEqual(start.chr, 0xffb1, 'the command channel, not the notify one');
  assert.deepStrictEqual(start.bytes.slice(0, 5), [0x02, 0x02, 0x00, 0xbd, 0x09],
    'seq 2, length 2, fragment 0, type 0xBD, subcommand 0x09');
  assert.strictEqual(start.bytes.length, 20);
  // sum(bytes[3..18]) mod 32 = (0xBD + 0x09) mod 32 = 198 mod 32 = 6.
  assert.strictEqual(start.bytes[19], 0x06, 'checksum over bytes 3..18, mod 32');

  // It is asked for once per step-on, not once per settled frame.
  const before = writes.length;
  await D.drTrust.startBia(ctx, 96.4);
  assert.strictEqual(writes.length, before, 'a second call must not re-ask');
});

test('Dr Trust: the profile declares the real weight and the real sex', async () => {
  const run = async (sex, kg) => {
    const writes = [];
    const ctx = {
      state: { drt: { session: 0x2a } },
      profile: () => ({ heightCm: 180, age: 39, sex }),
      now: () => 1757072503000,
      log: () => {},
      write: async (s2, c, bytes, what) => { writes.push({ bytes: [...bytes], what }); return true; },
    };
    await D.drTrust.sendProfile(ctx, kg);
    return writes.find((w) => /user profile/.test(w.what));
  };

  const male = await run('male', 96.4);
  // Declared weight is a big-endian hundredth-kilo field at bytes 12 and 13.
  assert.strictEqual((male.bytes[12] << 8) | male.bytes[13], 9640,
    'the person on the scale weighs 96.4 kg, not openScale\'s hardcoded 60.00');
  assert.strictEqual(male.bytes[14], 0x80 | 39, 'sex bit set for male, age in the low bits');
  assert.strictEqual(male.bytes[11], 180, 'height in cm');

  const female = await run('female', 61.5);
  assert.strictEqual((female.bytes[12] << 8) | female.bytes[13], 6150);
  assert.strictEqual(female.bytes[14], 39, 'sex bit clear for female');

  // Absent a weight we still have to send something, but it must stay in range.
  const unknown = await run('male', undefined);
  const declared = (unknown.bytes[12] << 8) | unknown.bytes[13];
  assert.ok(declared >= 1000 && declared <= 30000, `declared ${declared} out of range`);
});

test('the session acknowledgement echoes the id the scale actually asked for', async () => {
  const { ctx } = await feed([REAL.setup]);
  await new Promise((r) => setTimeout(r, 20));           // the writes are not awaited
  const ack = ctx.calls.writes.find((w) => /session ack/.test(w.what));
  assert.ok(ack, 'a session ack must be written');
  const bytes = ack.hex.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16));
  // Packet is [seq][len][frag][type 0xB0][session id]; the real frame's id is 0x03.
  assert.strictEqual(bytes[3], 0xb0, 'the session-ack command type');
  assert.strictEqual(bytes[4], 0x03,
    'the id must be the scale\'s own byte 0, not the always-zero byte 1');
});

/*
 * The scale sets its measuring current from the weight it has been told, and
 * decides early. Declaring a stand-in until the weight locks means it decides
 * on a number that is wrong by tens of kilos.
 */
test('a settled live weight is declared, and a footfall is not', async () => {
  // One rising frame is someone mid-step. Two that agree is their weight.
  const { ctx } = await feed([REAL.setup, REAL.rising, REAL.rising]);
  await new Promise((r) => setTimeout(r, 20));

  const profiles = ctx.calls.writes.filter((w) => /user profile/.test(w.what));
  assert.ok(profiles.length >= 2,
    `expected a re-declare after the weight steadied, saw ${profiles.length}`);

  const last = profiles[profiles.length - 1];
  const bytes = last.hex.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16));
  assert.strictEqual(((bytes[12] << 8) | bytes[13]) / 100, 70.45);

  // The opening declaration is still a placeholder: nobody is on the scale
  // when the session opens.
  const first = profiles[0].hex.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16));
  assert.strictEqual(((first[12] << 8) | first[13]) / 100, 60);

  // A single ramping reading must NOT be declared. 10.45 kg went to the scale
  // as a 93.4 kg person's weight before this rule existed.
  const { ctx: solo } = await feed([REAL.setup, REAL.stepOn]);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(solo.calls.writes.filter((w) => /user profile/.test(w.what)).length, 1,
    'one mid-step reading is not a weight');

  // And the correction happens once, however long the stream runs.
  const { ctx: many } = await feed([REAL.setup, REAL.rising, REAL.rising, REAL.rising, REAL.overshoot]);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(many.calls.writes.filter((w) => /user profile/.test(w.what)).length, 2);

  // The re-declare is one packet: the session is not acknowledged twice.
  assert.strictEqual(many.calls.writes.filter((w) => /session ack/.test(w.what)).length, 1,
    'a session that is already open must not be re-acknowledged');
  assert.strictEqual(many.calls.writes.filter((w) => /app name/.test(w.what)).length, 1);
});
