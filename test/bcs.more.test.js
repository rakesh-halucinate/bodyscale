'use strict';
// Additional tests: sample-packet byte correctness (hand-derived constants, not
// copied from parser output), multi-packet merge edge cases, imperial Weight
// Measurement, truncation mid-field, DataView/offset inputs, and a few
// spec-rule checks. Tests marked "[expected to fail]" document current defects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../bcs.js');

const bytesOf = (k) => B.hexToBytes(B.SAMPLES[k]);
const flags16 = (b) => b[0] | (b[1] << 8);
const u32le = (b) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

// ---------------------------------------------------------------------------
// 1. Sample packets are byte-correct for what their labels claim
// ---------------------------------------------------------------------------
test('SAMPLES.bcmSiFull: flags 0x0FFE, SI, 30 bytes, every raw field hand-checked', () => {
  const b = bytesOf('bcmSiFull');
  assert.equal(b.length, 30);
  assert.equal(flags16(b), 0x0ffe);            // bits 1..11 set, bit 0 (imperial) and 12 (multi) clear
  // Raw little-endian uint16 values at the spec offsets
  assert.equal(b[2] | (b[3] << 8), 200);        // Body Fat 20.0 %
  assert.equal(b[4] | (b[5] << 8), 2026);       // year
  assert.deepEqual([b[6], b[7], b[8], b[9], b[10]], [9, 4, 15, 53, 0]);
  assert.equal(b[11], 1);                       // User ID
  assert.equal(b[12] | (b[13] << 8), 8000);     // Basal Metabolism kJ
  assert.equal(b[14] | (b[15] << 8), 400);      // Muscle % 40.0
  assert.equal(b[16] | (b[17] << 8), 7000);     // Muscle Mass 7000*0.005 = 35 kg
  assert.equal(b[18] | (b[19] << 8), 12000);    // Fat Free Mass 60 kg
  assert.equal(b[20] | (b[21] << 8), 11400);    // Soft Lean Mass 57 kg
  assert.equal(b[22] | (b[23] << 8), 8000);     // Body Water Mass 40 kg
  assert.equal(b[24] | (b[25] << 8), 5000);     // Impedance 500.0 ohm
  assert.equal(b[26] | (b[27] << 8), 15000);    // Weight 75 kg
  assert.equal(b[28] | (b[29] << 8), 1750);     // Height 1.75 m
});

test('SAMPLES.bcmImperial: flags 0x0C03 (imperial, TS, weight, height), 15 bytes', () => {
  const b = bytesOf('bcmImperial');
  assert.equal(b.length, 15);
  assert.equal(flags16(b), 0x0c03);
  assert.equal(b[2] | (b[3] << 8), 300);        // 30.0 %
  assert.equal(b[11] | (b[12] << 8), 16540);    // 165.40 lb
  assert.equal(b[13] | (b[14] << 8), 702);      // 70.2 in
});

test('SAMPLES.bcmMultiPart1/2: bit 12 set on both, each <= 20 bytes, disjoint optional fields covering 0x0FFE, no TS/User ID in the continuation', () => {
  const p1 = bytesOf('bcmMultiPart1'), p2 = bytesOf('bcmMultiPart2');
  assert.equal(p1.length, 18);
  assert.equal(p2.length, 16);
  assert.ok(p1.length <= 20 && p2.length <= 20);
  const f1 = flags16(p1), f2 = flags16(p2);
  assert.equal(f1, 0x103e);
  assert.equal(f2, 0x1fc0);
  assert.ok(f1 & 0x1000); assert.ok(f2 & 0x1000);
  assert.equal((f1 | f2) & 0x0fff, 0x0ffe, 'union of optional-field bits equals the single-packet sample');
  assert.equal(f1 & f2 & 0x0fff, 0, 'no optional field appears in both halves');
  assert.equal(f2 & 0x0006, 0, 'continuation carries neither Time Stamp nor User ID (BCS 3.2.1)');
  assert.equal(p1[2] | (p1[3] << 8), 200);
  assert.equal(p2[2] | (p2[3] << 8), 200, 'both halves carry the same mandatory Body Fat %');
});

test('SAMPLES.bcmUnsuccessful: flags 0x0006, BF 0xFFFF, user 0xFF, 12 bytes', () => {
  const b = bytesOf('bcmUnsuccessful');
  assert.equal(b.length, 12);
  assert.equal(flags16(b), 0x0006);
  assert.equal(b[2] | (b[3] << 8), 0xffff);
  assert.equal(b[11], 0xff);
});

test('SAMPLES.wsmSi: flags 0x0E, weight 15000, BMI 245, height 1750, 15 bytes', () => {
  const b = bytesOf('wsmSi');
  assert.equal(b.length, 15);
  assert.equal(b[0], 0x0e);
  assert.equal(b[1] | (b[2] << 8), 15000);
  assert.equal(b[3] | (b[4] << 8), 2026);
  assert.equal(b[10], 1);
  assert.equal(b[11] | (b[12] << 8), 245);
  assert.equal(b[13] | (b[14] << 8), 1750);
});

test('SAMPLES.bcfAll: bits 0-10 set, mass res (11-14) = 7, height res (15-17) = 3, RFU 18-31 clear', () => {
  const v = u32le(bytesOf('bcfAll'));
  assert.equal(v, 0x0001bfff);
  assert.equal(v & 0x7ff, 0x7ff);
  assert.equal((v >>> 11) & 0x0f, 7);
  assert.equal((v >>> 15) & 0x07, 3);
  assert.equal(v >>> 18, 0);
});

test('SAMPLES.wsfAll: bits 0-2 set, weight res (3-6) = 7, height res (7-9) = 3, RFU 10-31 clear', () => {
  const v = u32le(bytesOf('wsfAll'));
  assert.equal(v, 0x000001bf);
  assert.equal(v & 0x7, 0x7);
  assert.equal((v >>> 3) & 0x0f, 7);
  assert.equal((v >>> 7) & 0x07, 3);
  assert.equal(v >>> 10, 0);
});

// ---------------------------------------------------------------------------
// 2. Multi-packet merge
// ---------------------------------------------------------------------------
test('mergeMultiPacket keeps exactly one Body Fat field, in spec order, with the continuation fields appended', () => {
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  const p2 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart2);
  const m = B.mergeMultiPacket(p1, p2);
  const names = m.fields.map((f) => f.name);
  assert.equal(names.filter((n) => n === 'Body Fat Percentage').length, 1);
  assert.deepEqual(names, [
    'Body Fat Percentage', 'Time Stamp', 'User ID', 'Basal Metabolism', 'Muscle Percentage', 'Muscle Mass',
    'Fat Free Mass', 'Soft Lean Mass', 'Body Water Mass', 'Impedance', 'Weight', 'Height',
  ]);
  assert.equal(m.values.bodyFatPercent, 20);
  assert.equal(m.values.timeStamp, '2026-09-04T15:53:00');
  assert.equal(m.values.height, 1.75);
  assert.equal(m.length, 34);
  assert.deepEqual(m.flags, ['0x103e', '0x1fc0']);
  assert.deepEqual(m.warnings, []);
});

test('mergeMultiPacket warns when the continuation carries Time Stamp / User ID (packets in wrong order)', () => {
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  const p2 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart2);
  const m = B.mergeMultiPacket(p2, p1);
  assert.ok(m.warnings.some((w) => /Time Stamp or User ID/.test(w)));
});

test('[expected to fail] mergeMultiPacket: flagBits should cover both packets so the UI "flag bits set" list shows the continuation fields', () => {
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  const p2 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart2);
  const m = B.mergeMultiPacket(p1, p2);
  const set = m.flagBits.filter((b) => b.set).map((b) => b.bit);
  // Weight (bit 10) and Height (bit 11) are present in the merged fields, so they must show as set.
  assert.ok(set.includes(10) && set.includes(11), 'merged flagBits only reflect the first packet: ' + JSON.stringify(set));
});

test('[expected to fail] mergeMultiPacket: measurementUnsuccessful should be a boolean on the merged result', () => {
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  const p2 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart2);
  const m = B.mergeMultiPacket(p1, p2);
  assert.equal(typeof m.measurementUnsuccessful, 'boolean');
});

test('[expected to fail] mergeMultiPacket: Body Fat mismatch between halves should be warned (two first-halves from different measurements)', () => {
  // Same as bcmMultiPart2 but Body Fat = 25.0 % (fa 00) instead of 20.0 %.
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  const p2 = B.parseBodyCompositionMeasurement('c0 1f fa 00 e0 2e 88 2c 40 1f 88 13 98 3a d6 06');
  const m = B.mergeMultiPacket(p1, p2);
  assert.ok(m.warnings.length > 0, 'silently merged with bodyFatPercent=' + m.values.bodyFatPercent);
});

test('single packet with bit 12 set exposes the multi-packet note; single packet without it has no note', () => {
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  assert.ok(Array.isArray(p1.notes) && p1.notes.length === 1);
  assert.equal(B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull).notes, undefined);
});

// ---------------------------------------------------------------------------
// 3. Weight Measurement (0x2A9D) imperial + unsuccessful
// ---------------------------------------------------------------------------
test('Weight Measurement imperial with BMI + Height: 0.01 lb, BMI 0.1, height 0.1 in', () => {
  // flags 0x09 = imperial + BMI/Height; weight 16540, bmi 245, height 702
  const r = B.parseWeightMeasurement('09 9c 40 f5 00 be 02');
  assert.equal(r.units, 'imperial');
  assert.deepEqual(r.values, { weight: 165.4, bmi: 24.5, height: 70.2 });
  assert.deepEqual(r.fields.map((f) => f.unit), ['lb', 'kg/m²', 'in']);
  assert.deepEqual(r.warnings, []);
});

test('Weight Measurement 0xFFFF with Time Stamp and User ID still parses the trailing fields', () => {
  const r = B.parseWeightMeasurement('06 ff ff ea 07 09 04 0f 35 00 ff');
  assert.equal(r.measurementUnsuccessful, true);
  assert.equal(r.values.weight, null);
  assert.equal(r.values.timeStamp, '2026-09-04T15:53:00');
  assert.equal(r.values.userId, 255);
  assert.deepEqual(r.warnings, []);
});

test('Weight Measurement flags RFU bits 4-7 warn', () => {
  const r = B.parseWeightMeasurement('10 98 3a');
  assert.equal(r.values.weight, 75);
  assert.ok(r.warnings.some((w) => /Reserved flag bits 4/.test(w)));
});

// ---------------------------------------------------------------------------
// 4. Truncation mid-field
// ---------------------------------------------------------------------------
test('[expected to fail] BCM truncated mid-Time-Stamp: exactly one warning, no "unexpected trailing bytes", no leftover', () => {
  // 4 of the 7 Time Stamp bytes present
  const r = B.parseBodyCompositionMeasurement('fe 0f c8 00 ea 07 09 04');
  assert.equal(r.values.bodyFatPercent, 20);
  assert.equal(r.fields.length, 1);
  assert.ok(r.warnings.some((w) => /truncated/.test(w)));
  assert.ok(!r.warnings.some((w) => /unexpected trailing/.test(w)), 'partial Time Stamp bytes reported as unexpected trailing bytes: ' + JSON.stringify(r.warnings));
  assert.equal(r.leftover, undefined);
});

test('[expected to fail] WSS truncated mid-Height: no contradictory trailing-bytes warning', () => {
  const r = B.parseWeightMeasurement('08 98 3a f5 00 d6');
  assert.equal(r.values.bmi, 24.5);
  assert.ok(r.warnings.some((w) => /truncated/.test(w)));
  assert.ok(!r.warnings.some((w) => /unexpected trailing/.test(w)), JSON.stringify(r.warnings));
});

test('truncation stops parsing: later flagged fields are not attempted and values are absent', () => {
  // flags 0x0c02 = TS + weight + height; only the TS is present, weight/height missing
  const r = B.parseBodyCompositionMeasurement('02 0c c8 00 ea 07 09 04 0f 35 00');
  assert.equal(r.values.timeStamp, '2026-09-04T15:53:00');
  assert.equal(r.values.weight, undefined);
  assert.equal(r.values.height, undefined);
  assert.equal(r.warnings.filter((w) => /truncated/.test(w)).length, 1, 'only the first missing field is reported');
});

test('Feature characteristics shorter than 4 bytes warn instead of throwing', () => {
  assert.ok(B.parseBodyCompositionFeature('ff bf').warnings.some((w) => /truncated/.test(w)));
  assert.ok(B.parseWeightScaleFeature('bf').warnings.some((w) => /truncated/.test(w)));
  assert.ok(B.parseBodyCompositionFeature(new Uint8Array(0)).warnings.length >= 1);
});

// ---------------------------------------------------------------------------
// 5. Input types: DataView with offset, subarray, ArrayBuffer, Buffer, array
// ---------------------------------------------------------------------------
test('DataView with non-zero byteOffset / shorter byteLength parses identically to the plain bytes', () => {
  const sample = bytesOf('bcmSiFull');
  const buf = new ArrayBuffer(sample.length + 5);
  const all = new Uint8Array(buf);
  all.set([0xaa, 0xbb, 0xcc], 0);
  all.set(sample, 3);
  all.set([0xdd, 0xee], 3 + sample.length);
  const dv = new DataView(buf, 3, sample.length);
  const viaDv = B.parseBodyCompositionMeasurement(dv);
  const viaU8 = B.parseBodyCompositionMeasurement(sample);
  assert.deepEqual(viaDv.values, viaU8.values);
  assert.deepEqual(viaDv.fields, viaU8.fields);
  assert.deepEqual(viaDv.warnings, []);
  assert.equal(viaDv.raw, viaU8.raw);
  // Same for the other parsers
  const wsm = bytesOf('wsmSi');
  const wbuf = new Uint8Array(wsm.length + 2); wbuf[0] = 0x99; wbuf.set(wsm, 1);
  assert.deepEqual(B.parseWeightMeasurement(new DataView(wbuf.buffer, 1, wsm.length)).values, B.parseWeightMeasurement(wsm).values);
  const feat = bytesOf('bcfAll');
  const fbuf = new Uint8Array(6); fbuf.set(feat, 2);
  assert.equal(B.parseBodyCompositionFeature(new DataView(fbuf.buffer, 2, 4)).flagsHex, '0x0001bfff');
});

test('Uint8Array.subarray (shared buffer, offset) parses identically', () => {
  const sample = bytesOf('bcmImperial');
  const big = new Uint8Array(sample.length + 4); big.set([1, 2], 0); big.set(sample, 2);
  const sub = big.subarray(2, 2 + sample.length);
  assert.deepEqual(B.parseBodyCompositionMeasurement(sub).values, B.parseBodyCompositionMeasurement(sample).values);
  assert.deepEqual(B.parseBodyCompositionMeasurement(sub).warnings, []);
});

test('ArrayBuffer, Node Buffer and plain number[] inputs are accepted', () => {
  const sample = bytesOf('wsmSi');
  const ab = sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength);
  assert.deepEqual(B.parseWeightMeasurement(ab).values, B.parseWeightMeasurement(sample).values);
  assert.deepEqual(B.parseWeightMeasurement(Buffer.from(sample)).values, B.parseWeightMeasurement(sample).values);
  assert.deepEqual(B.parseWeightMeasurement(Array.from(sample)).values, B.parseWeightMeasurement(sample).values);
  assert.throws(() => B.toBytes({}), TypeError);
});

test('parseDateTime honours the offset argument inside a larger buffer', () => {
  const b = B.hexToBytes('00 00 ea 07 09 04 0f 35 00 ff');
  assert.equal(B.parseDateTime(b, 2).iso, '2026-09-04T15:53:00');
});

test('[expected to fail] index.html should feed the DataView (or BCS.toBytes(value)) to the parser, not new Uint8Array(value.buffer)', () => {
  // A DataView that does not span its whole buffer is a legal characteristic.value;
  // new Uint8Array(dv.buffer) would parse the wrong bytes while BCS.toBytes(dv) is correct.
  const sample = bytesOf('bcmUnsuccessful');
  const big = new Uint8Array(sample.length + 3); big.set([0xfe, 0x0f, 0x00], 0); big.set(sample, 3);
  const dv = new DataView(big.buffer, 3, sample.length);
  assert.equal(B.parseBodyCompositionMeasurement(B.toBytes(dv)).measurementUnsuccessful, true);
  assert.notDeepEqual(B.parseBodyCompositionMeasurement(new Uint8Array(dv.buffer)).values, B.parseBodyCompositionMeasurement(dv).values);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!/new Uint8Array\(\s*ch\.value\.buffer\s*\)/.test(html), 'index.html onValue() discards DataView byteOffset/byteLength');
});

// ---------------------------------------------------------------------------
// 6. Spec rules around 0xFFFF
// ---------------------------------------------------------------------------
test('0xFFFF with only Time Stamp + User ID (the spec-allowed shape) produces no warning', () => {
  const r = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmUnsuccessful);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.fields.find((f) => f.name === 'Body Fat Percentage').value, null);
});

test('[expected to fail] 0xFFFF with Weight present (no TS/User ID) must warn that optional fields shall be disabled', () => {
  // flags 0x0400 = Weight present; BF = 0xFFFF; weight 15000
  const r = B.parseBodyCompositionMeasurement('00 04 ff ff 98 3a');
  assert.equal(r.measurementUnsuccessful, true);
  assert.equal(r.values.weight, 75);
  assert.ok(r.warnings.some((w) => /unsuccessful/.test(w)), 'no warning: ' + JSON.stringify(r.warnings));
});

test('0xFFFF with TS + User ID + Weight (4 fields) does warn', () => {
  const r = B.parseBodyCompositionMeasurement('06 04 ff ff ea 07 09 04 0f 35 00 01 98 3a');
  assert.ok(r.warnings.some((w) => /unsuccessful/.test(w)));
});

// ---------------------------------------------------------------------------
// 7. Misc resolution / labelling checks
// ---------------------------------------------------------------------------
test('Basal Metabolism note converts kJ to kcal (8000 kJ ≈ 1912 kcal)', () => {
  const r = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull);
  assert.match(r.fields.find((f) => f.name === 'Basal Metabolism').note, /1912 kcal/);
});

test('imperial BCM mass fields use 0.01 lb for every mass field, not just Weight', () => {
  // flags 0x0021 = imperial + Muscle Mass; BF 300; muscle mass 5000 -> 50.00 lb
  const r = B.parseBodyCompositionMeasurement('21 00 2c 01 88 13');
  assert.equal(r.values.muscleMass, 50);
  assert.equal(r.fields.find((f) => f.name === 'Muscle Mass').unit, 'lb');
});

test('Feature resolution codes outside the tables are labelled Reserved', () => {
  // mass res bits 11-14 = 8 -> 0x00004000
  assert.match(B.parseBodyCompositionFeature('00 40 00 00').values['Mass Measurement Resolution (bits 11–14)'], /^8 → Reserved/);
  // height res bits 15-17 = 4 -> 0x00020000
  assert.match(B.parseBodyCompositionFeature('00 00 02 00').values['Height Measurement Resolution (bits 15–17)'], /^4 → Reserved/);
  assert.ok(B.parseBodyCompositionFeature('00 00 04 00').warnings.some((w) => /RFU bits 18/.test(w)));
  assert.ok(B.parseWeightScaleFeature('00 04 00 00').warnings.some((w) => /RFU bits 10/.test(w)));
});

test('unknown version string is reported but the packet still parses', () => {
  const r = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull, { version: '2.0' });
  assert.equal(r.values.weight, 75);
  assert.ok(r.warnings.some((w) => /Unknown spec version/.test(w)));
});
