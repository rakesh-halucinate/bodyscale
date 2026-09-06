'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BCS = require('../bcs.js');
const H = require('./integration/harness.js');
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
   * There are no impedance frames here.
   *
   * Two used to be, named REAL.impedance and REAL.impedanceMid and described
   * as hardware captures. They were not. Under this protocol's actual grammar
   * — [package][length BE16][fragment][command] — both are malformed: they
   * declare fragment 1 while repeating a command byte that only a fragment 0
   * carries. They were constructed to fit a misreading of the format, and then
   * used as the evidence for "three little-endian uint16, trunk / right leg /
   * left leg", which is also wrong.
   *
   * The one genuine record capture we have, REAL.record, says the scale
   * returned N=10 impedance slots and left every one of them zero. Until a
   * real non-zero record exists, there is nothing here to decode against, and
   * inventing one to make a test pass is what produced this mess.
   */
};
/*
 * Frames, as they arrive on hardware.
 *
 * A record is preceded by the live weight stream, always: the scale uploads a
 * stored record the moment the channel opens, and the driver ignores those, so
 * a test that feeds a record cold is testing the history path by accident.
 * `feed` therefore starts with someone stepping on unless told otherwise.
 */
const feedCold = async (hexes) => {
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

const feed = async (hexes) => {
  const needsStepOn = hexes.some((h) => / a7 | a5 /.test(h));
  if (!needsStepOn) return feedCold(hexes);
  const r = await feedCold([REAL.rising, ...hexes]);
  // Drop the step-on's own result so `out` still lines up with `hexes`.
  return { ctx: r.ctx, out: r.out.slice(1) };
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

test('the real record frame yields 98.50 kg and ten empty impedance slots', async () => {
  /*
   * One record carries the weight AND the impedances; there are no "subtypes".
   * This genuine capture declares ten slots at byte 14 and leaves every one of
   * them zero, which is the scale saying it weighed but never swept.
   */
  const { out } = await feed([REAL.record]);
  const r = out[0];
  assert.equal(r.values.weight, 98.5);
  assert.strictEqual(r.values.impedanceCount, 10, 'the count comes off the wire');
  assert.deepStrictEqual(r.values.impedances, new Array(10).fill(0));
  assert.equal(r.values.impedanceOhm, null, 'nothing measured, so nothing reported');
  assert.ok(r.warnings.some((w) => /measured none of them/.test(w)),
    'and the panel says so rather than showing a silent blank');
});



test('the mid-measurement record frame decodes its own weight', async () => {
  const { out } = await feed([REAL.recordMid]);
  assert.equal(out[0].values.weight, 93.1);
  assert.equal(out[0].values.impedanceOhm, null, 'a weight frame never carries one');
});







test('SSW532 (openScale offset-1) frames still decode alongside the SSW533', async () => {
  // The older three-byte header: command 0xA2 at index 3 rather than 4, state
  // at 4, and a plain big-endian 24-bit weight rather than a packed word.
  const b = BCS.toBytes([0x01, 0x07, 0x00, 0xa2, 0x03, 0x00, 0x01, 0x80, 0xc4]);
  const ctx = makeCtx();
  await D.drTrust.init(ctx);
  const r = D.drTrust.onFrame(0xffb2, b, ctx);
  assert.ok(r, 'the older layout must still decode');
  assert.equal(r.values.weight, 98.5);
  assert.strictEqual(ctx.state.drt.wireVersion, 1, 'recognised as the older framing');
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





/*
 * The impedance program has to be asked for.
 *
 * Nothing we did to the decoder could ever have produced body composition,
 * because the scale was never told to measure any. These lock the request and
 * the two profile fields that were being sent as constants.
 */






/*
 * The scale sets its measuring current from the weight it has been told, and
 * decides early. Declaring a stand-in until the weight locks means it decides
 * on a number that is wrong by tens of kilos.
 */

// ===========================================================================
// The wire format, as the scale actually speaks it.
//
//     [0] package index   [1..2] payload length, big-endian
//     [3] fragment index  [4..]  payload, whose first byte is the command
//     [last] trailer = (unit << 5) | (sum(payload) & 0x1F)
//
// Confirmed against every genuine frame we hold. The driver previously used a
// three-byte header, which put the command where the fragment index belongs
// and made every packet it ever sent unparseable.
// ===========================================================================

test('every real frame from the scale parses under the four-byte header', () => {
  const cases = [
    [REAL.setup, 0x03, 29, 0xaa], [REAL.idle, 0x17, 7, 0xa2],
    [REAL.stepOn, 0x20, 7, 0xa2], [REAL.rising, 0x2f, 7, 0xa2],
    [REAL.finalW, 0x76, 7, 0xa2], [REAL.record, 0x06, 35, 0xa7],
  ];
  for (const [hex, pkg, len, cmd] of cases) {
    const b = BCS.hexToBytes(hex);
    assert.strictEqual(b[0], pkg, `${hex.slice(0, 11)}: package index`);
    assert.strictEqual((b[1] << 8) | b[2], len, `${hex.slice(0, 11)}: payload length`);
    assert.strictEqual(b[3], 0x00, `${hex.slice(0, 11)}: fragment index`);
    assert.strictEqual(b[4], cmd, `${hex.slice(0, 11)}: command`);
  }
});

test('a built frame carries its command at index 4, not index 3', () => {
  const p = D.drTrust.packet([0xb0, 0x03, 0x00], 0);
  assert.deepStrictEqual([...p], [0x00, 0x00, 0x03, 0x00, 0xb0, 0x03, 0x00, 0x13]);
  // The trailer covers the payload only: (0xB0 + 3 + 0) & 0x1F = 0x13.
  assert.strictEqual(p[p.length - 1], 0x13);
});

test('the package index advances, because the scale de-duplicates on it', () => {
  const st = { pkg: 0 };
  assert.strictEqual(D.drTrust.nextPkg(st), 1);
  assert.strictEqual(D.drTrust.nextPkg(st), 2);
  st.pkg = 0xff;
  assert.strictEqual(D.drTrust.nextPkg(st), 0, 'and wraps rather than overflowing the byte');
});

/*
 * Checked against a Bluetooth capture of the phone app talking to this exact
 * scale. The whole session contains two writes:
 *
 *     handle 0x001d   0b 00 03 ...    8 bytes   a 3-byte 0xB0 reply
 *     handle 0x001d   0c 00 1e ...   35 bytes   a 30-byte user info
 *
 * 0x001e is 30, and counting the writes in encodeUserInfo_C0 gives 24 fixed
 * bytes plus a length-prefixed nickname: 24 + 6 = 30. Not 0xB8's 26, and not
 * 0xBE's 23 — both of which this driver sent, and neither of which the app
 * ever sends.
 */
test('the profile is the 30-byte 0xC0 frame the app actually sends', async () => {
  const writes = [];
  const ctx = {
    state: { drt: { pkg: 11 } },
    profile: () => ({ heightCm: 180, age: 39, sex: 'male' }),
    now: () => 1757155200000, log: () => {},
    write: async (s2, c, b, what) => { writes.push({ c, b: [...b], what }); return true; },
  };
  await D.drTrust.writeProfile(ctx, 98.5);

  assert.strictEqual(writes.length, 1, 'one write, unfragmented: 35 bytes fits the MTU');
  const { c, b, what } = writes[0];
  assert.strictEqual(c, 0xffb1);
  assert.strictEqual(b.length, 35, 'the length the phone sent');
  assert.strictEqual((b[1] << 8) | b[2], 30, 'declared payload length 0x001e');
  assert.strictEqual(b[3], 0x00, 'a single fragment');
  assert.strictEqual(b[4], 0xc0, 'command 0xC0');

  assert.strictEqual(b[12], 180, 'height');
  assert.strictEqual((b[13] << 8) | b[14], 9850, 'weight x100 big-endian');
  assert.strictEqual(b[15], 0x80 | 39, 'male bit and age');
  assert.strictEqual(b[10] & 0x80, 0, 'a positive UTC offset leaves the sign bit clear');

  // Payload byte 16 — frame index 20 — is the function bitmask. Bit 0 is
  // fun_open_imp, and it is the only request for a body-composition sweep
  // anywhere in this protocol.
  assert.strictEqual(b[4 + 16] & 0x01, 0x01, 'bit 0 asks for the impedance sweep');

  // The tail is a length-prefixed nickname, which is what the packet this
  // driver used to send as a separate "app name" always was.
  assert.strictEqual(b[4 + 23], 6, 'nickname length');
  assert.strictEqual(String.fromCharCode(...b.slice(4 + 24, 4 + 30)), 'icomon');

  const sum = b.slice(4, -1).reduce((a, x) => a + x, 0);
  assert.strictEqual(b[b.length - 1] & 0x1f, sum & 0x1f, 'trailer over the payload');
  assert.match(what, /0xC0/);
});

test('a female profile clears the sex bit rather than always claiming male', async () => {
  const writes = [];
  const ctx = {
    state: { drt: { pkg: 0 } },
    profile: () => ({ heightCm: 165, age: 34, sex: 'female' }),
    now: () => 1757155200000, log: () => {},
    write: async (s2, c, b) => { writes.push([...b]); return true; },
  };
  await D.drTrust.writeProfile(ctx, 61.5);
  assert.strictEqual(writes[0][15], 34, 'age with the male bit clear');
  assert.strictEqual((writes[0][13] << 8) | writes[0][14], 6150);
});

test('the scale is acknowledged with the package index it used', async () => {
  const writes = [];
  const ctx = { state: { drt: { pkg: 5 } }, log: () => {},
    write: async (s2, c, b, what) => { writes.push({ b: [...b], what }); return true; } };
  await D.drTrust.ack(ctx, 0x2e);
  const { b, what } = writes[0];
  assert.strictEqual(b[0], 6, 'our own index, advanced');
  assert.strictEqual(b[4], 0xb0, 'reply command');
  assert.strictEqual(b[5], 0x2e, 'echoing the package index being answered');
  assert.strictEqual(b[6], 0x00, 'state 0 = success');
  assert.match(what, /ack of package 0x2e/);
});

/*
 * The weight stream announces the impedance phase; nothing requests it.
 * State 1 is plain weighing, 2 and 3 are the ADC sweep — the P-1 display.
 * In every capture we hold, it never leaves 1.
 */
test('the live frame state byte is where the impedance phase would show', () => {
  const state = (hex) => BCS.hexToBytes(hex)[5];
  assert.strictEqual(state(REAL.idle), 1);
  assert.strictEqual(state(REAL.rising), 1);
  assert.strictEqual(state(REAL.finalW), 0);
  for (const h of [REAL.idle, REAL.stepOn, REAL.rising, REAL.finalW]) {
    assert.ok(![2, 3].includes(state(h)),
      'no capture we hold ever reached the impedance phase');
  }
});

test('the one real record says ten impedance slots, all of them empty', () => {
  const b = BCS.hexToBytes(REAL.record);
  assert.strictEqual(b[4], 0xa7, 'record upload');
  assert.strictEqual(b[14], 10, 'the count is on the wire, not three and not assumed');
  const values = [];
  for (let i = 0; i < 10; i += 1) values.push((b[15 + i * 2] << 8) | b[16 + i * 2]);
  assert.deepStrictEqual(values, new Array(10).fill(0),
    'the scale returned the form and measured nothing');
});

/*
 * The scale introduces itself with command 0xAA and the SDK answers it. We
 * never did — we read a "session id" out of it and replied with a malformed
 * frame, or latterly nothing at all.
 */
test('the device-info frame is acknowledged with its own package index', async () => {
  const { ctx } = await feed([REAL.setup]);
  await new Promise((r) => setTimeout(r, 30));

  const ack = ctx.calls.writes.find((w) => /ack of package/.test(w.what));
  assert.ok(ack, `no acknowledgement sent; wrote [${ctx.calls.writes.map((w) => w.what).join(', ')}]`);
  const b = ack.hex.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16));
  assert.strictEqual(b[4], 0xb0, 'reply command');
  // REAL.setup starts `03 00 1d 00 aa`, so its package index is 0x03.
  assert.strictEqual(b[5], 0x03, 'echoing the package index of the frame being answered');
  assert.strictEqual(b[6], 0x00, 'state 0 = success');

  // And the user is declared again, as the SDK does after the introduction.
  assert.ok(ctx.calls.writes.some((w) => /user profile/.test(w.what)),
    'the profile is re-declared once the device has introduced itself');
});

/*
 * The state byte was read backwards, and it is the most expensive mistake in
 * this driver. The SDK maps it 1 = weighing, 2/3 = impedance sweep running —
 * the P-1 display — and 4 = heart rate. This code called 3 "stable, final".
 *
 * So the instant the scale began the sweep every run was waiting for, the
 * driver declared the weight final, latched it, suppressed what followed and
 * closed the link. The measurement was being interrupted at the moment it
 * started, and the silence that looked like "the scale never tried" was us.
 */
test('the impedance sweep is not mistaken for a finished weighing', async () => {
  // A V2 live frame in state 3: packed weight 98.50 kg, sweep running.
  const sweeping = '2f 00 07 00 a2 03 00 01 80 c4 00 00';
  const { ctx, out } = await feed([sweeping]);

  assert.strictEqual(out[0], D.SUPPRESS,
    'a sweep frame must report nothing: it is not a reading, it is work in progress');
  assert.strictEqual(ctx.state.drt.finalReported, false,
    'and above all it must not latch a final weight');
  assert.ok(ctx.calls.logs.some(([, m]) => /impedance sweep/i.test(m)),
    'the run should say the sweep started, since that is what we have been waiting for');

  // State 2 is the same phase.
  const { out: out2 } = await feed(['2f 00 07 00 a2 02 00 01 80 c4 00 00']);
  assert.strictEqual(out2[0], D.SUPPRESS);
});

test('the older framing keeps its own meaning for state 3', async () => {
  // On the SSW532's three-byte header 0x03 means stable, and we have no
  // vendor evidence to overrule that — only the V2 mapping is documented.
  const b = BCS.toBytes([0x01, 0x07, 0x00, 0xa2, 0x03, 0x00, 0x01, 0x80, 0xc4]);
  const ctx = makeCtx();
  await D.drTrust.init(ctx);
  const r = D.drTrust.onFrame(0xffb2, b, ctx);
  assert.ok(r && r.values, 'still decodes');
  assert.strictEqual(r.values.weight, 98.5);
  assert.strictEqual(r.values.state, 'final', 'stable on V1, not a sweep');
});

test('the packed weight word is masked to its low 18 bits', async () => {
  // The upper 14 bits are flags. A frame with them set must still read 98.50,
  // where the old big-endian 24-bit read would return nonsense.
  const withFlags = '2f 00 07 00 a2 01 fc 01 80 c4 00 00';
  const { out } = await feed([withFlags]);
  assert.ok(out[0] && out[0].values, 'decodes despite the flag bits');
  assert.strictEqual(out[0].values.weight, 98.5, 'flags masked off, not read as weight');
});

/*
 * A real reading from the scale, once P-1 finally ran:
 *
 *   27.8  325.3 333.5 320.4 350.9  |  25.7  294.0 299.7 285.5 318.3
 *   ^^^^  ^^^^^^^^^^^^^^^^^^^^^^^     ^^^^  ^^^^^^^^^^^^^^^^^^^^^^^
 *   trunk        four limbs           trunk        four limbs
 *
 * Ten values are two groups of five. The trunk is 20-30 ohm because the path
 * is short and wide; a limb is 250-350. Both groups show that shape in the
 * same position, which is what tells us it is a segmental set and not ten
 * independent readings.
 */
test('ten impedances are read as two segmental groups, not summed', async () => {
  const REAL_TEN = [27.8, 325.3, 333.5, 320.4, 350.9, 25.7, 294, 299.7, 285.5, 318.3];
  const hex = H.recordFrame({ weightKg: 97.6, impedances: REAL_TEN });
  const { out } = await feed([hex]);
  const r = out[0];

  assert.deepStrictEqual(r.values.impedances, REAL_TEN, 'every slot is reported raw');
  assert.strictEqual(r.values.impedanceCount, 10);

  /*
   * Hand to foot down one side of the SECOND group: one arm, the trunk, one
   * leg. Checked against the scale's own display for this reading — it shows
   * 40.7 % fat and 54 kg muscle, which imply 606.8 and 618.9 Ω. Group 2 gives
   * 606.4 and reproduces both; group 1 gives 674.7 and reproduces neither.
   *
   * Summing all ten, which came before this, walked every limb twice and gave
   * 2581 Ω — outside any physical band, so the trust rules discarded the whole
   * reading and the panel came back empty.
   */
  assert.strictEqual(r.values.impedanceOhm, 605.2);
  assert.notStrictEqual(r.values.impedanceOhm, 2581.1);

  // And it now survives the plausibility band, which is the whole point.
  assert.ok(r.values.impedanceOhm >= 150 && r.values.impedanceOhm <= 1200,
    'a whole-body figure the equations will accept');
  assert.ok(r.values.bodyFatPercent > 0, 'so body composition is actually produced');

  // The provisional mapping must announce itself rather than pass as settled.
  assert.ok(r.warnings.some((w) => /not yet established|provisional/i.test(w)),
    'the combination is inferred from magnitudes, and says so');
});

test('a partial sweep is not forced into a segmental reading', async () => {
  // Fewer than five values cannot be a group; the driver must not invent one.
  const hex = H.recordFrame({ weightKg: 97.6, impedances: [300, 25] });
  const { out } = await feed([hex]);
  assert.deepStrictEqual(out[0].values.impedances.slice(0, 2), [300, 25]);
  assert.strictEqual(out[0].values.impedanceOhm, 325, 'falls back to the plain total');
});

/*
 * The scale uploads whatever it has stored the moment the record channel
 * opens — before anyone has stepped on, before the sweep, before the display
 * shows P-1. Taking that as the reading is why every run after the first
 * successful measurement returned that same first measurement, byte for byte,
 * and why P-1 appeared to stop working when nothing in the write path had
 * changed. It only started once the scale had something to dump.
 */
test('a record that arrives before anyone stands on the scale is history', async () => {
  const stored = H.recordFrame({ weightKg: 97.55, impedances: [28, 324.8, 333.2, 321.3, 348.5, 25.7, 293.6, 298.9, 286.2, 316.1] });
  const { ctx, out } = await feedCold([stored]);

  assert.strictEqual(out[0], null, 'the history upload is not a measurement');
  assert.strictEqual(ctx.state.drt.impedanceOhm, null, 'and nothing is captured from it');
  assert.ok(ctx.calls.logs.some(([, m]) => /history upload|stored record/i.test(m)),
    'the run says what it ignored, rather than going quiet');
});

test('the same record counts once someone is actually on the scale', async () => {
  const stored = H.recordFrame({ weightKg: 97.55, impedances: [28, 324.8, 333.2, 321.3, 348.5, 25.7, 293.6, 298.9, 286.2, 316.1] });
  const { out } = await feedCold([REAL.rising, stored]);

  const r = out[1];
  assert.ok(r && r.values, 'now it is a reading');
  assert.strictEqual(r.values.weight, 97.55);
  assert.strictEqual(r.values.impedanceOhm, 605.5);
});

test('the impedance sweep alone is proof enough that someone is on it', async () => {
  // If the stream jumps straight to the sweep, that is a person on the plate.
  const sweeping = '2f 00 07 00 a2 03 00 01 80 c4 00 00';
  const stored = H.recordFrame({ weightKg: 98.5, impedances: H.segmentalFor(600) });
  const { out } = await feedCold([sweeping, stored]);
  assert.ok(out[1] && out[1].values.impedanceOhm > 0,
    'a record after the sweep is a measurement, however the weight arrived');
});
