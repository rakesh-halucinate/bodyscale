'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../bcs.js');

test('SI full packet parses every field in spec order with spec resolutions', () => {
  const r = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull, { version: '1.0.1' });
  assert.equal(r.flagsHex, '0x0ffe');
  assert.equal(r.units, 'SI');
  assert.deepEqual(r.fields.map((f) => f.name), [
    'Body Fat Percentage', 'Time Stamp', 'User ID', 'Basal Metabolism', 'Muscle Percentage', 'Muscle Mass',
    'Fat Free Mass', 'Soft Lean Mass', 'Body Water Mass', 'Impedance', 'Weight', 'Height',
  ]);
  assert.deepEqual(r.values, {
    bodyFatPercent: 20, timeStamp: '2026-09-04T15:53:00', userId: 1, basalMetabolismKJ: 8000,
    musclePercent: 40, muscleMass: 35, fatFreeMass: 60, softLeanMass: 57, bodyWaterMass: 40,
    impedanceOhm: 500, weight: 75, height: 1.75,
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.length, 30);
});

test('Imperial flag switches units and resolutions (0.01 lb, 0.1 in)', () => {
  const r = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmImperial, { version: '1.0' });
  assert.equal(r.units, 'imperial');
  assert.equal(r.values.weight, 165.4);
  assert.equal(r.fields.find((f) => f.name === 'Weight').unit, 'lb');
  assert.equal(r.values.height, 70.2);
  assert.equal(r.fields.find((f) => f.name === 'Height').unit, 'in');
  assert.equal(r.values.bodyFatPercent, 30);
});

test('v1.0 and v1.0.1 produce identical values for the same bytes', () => {
  const a = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull, { version: '1.0' });
  const b = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull, { version: '1.0.1' });
  assert.deepEqual(a.values, b.values);
  assert.deepEqual(a.fields, b.fields);
  assert.notEqual(a.spec, b.spec);
});

test('0xFFFF body fat = measurement unsuccessful; 0xFF user = unknown', () => {
  const r = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmUnsuccessful);
  assert.equal(r.measurementUnsuccessful, true);
  assert.equal(r.values.bodyFatPercent, null);
  assert.equal(r.values.userId, 255);
  assert.match(r.fields.find((f) => f.name === 'User ID').note, /unknown user/);
  assert.deepEqual(r.warnings, []);
});

test('multiple packet pair merges into one measurement', () => {
  const p1 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart1);
  const p2 = B.parseBodyCompositionMeasurement(B.SAMPLES.bcmMultiPart2);
  assert.equal(p1.multiplePacket, true);
  assert.equal(p2.multiplePacket, true);
  assert.ok(p1.length <= 20 && p2.length <= 20, 'each half fits a default 23-byte MTU (20-byte value)');
  const m = B.mergeMultiPacket(p1, p2);
  assert.deepEqual(m.values, B.parseBodyCompositionMeasurement(B.SAMPLES.bcmSiFull).values);
  assert.deepEqual(m.warnings, []);
});

test('truncated packet reports a warning instead of throwing', () => {
  const r = B.parseBodyCompositionMeasurement('fe 0f c8 00 ea 07');
  assert.equal(r.values.bodyFatPercent, 20);
  assert.ok(r.warnings.some((w) => /truncated/.test(w)));
  assert.equal(r.fields.length, 1);
});

test('trailing bytes and RFU bits are reported', () => {
  const r = B.parseBodyCompositionMeasurement('00 e0 c8 00 aa bb');
  assert.ok(r.warnings.some((w) => /Reserved-for-future-use/.test(r.warnings.join(' '))));
  assert.equal(r.leftover, 'aa bb');
});

test('empty and 1-byte input do not throw', () => {
  assert.equal(B.parseBodyCompositionMeasurement(new Uint8Array(0)).warnings.length, 1);
  assert.equal(B.parseBodyCompositionMeasurement('01').warnings.length, 1);
});

test('Weight Measurement (0x2A9D) parses flags, weight, timestamp, user, BMI, height', () => {
  const r = B.parseWeightMeasurement(B.SAMPLES.wsmSi);
  assert.deepEqual(r.values, { weight: 75, timeStamp: '2026-09-04T15:53:00', userId: 1, bmi: 24.5, height: 1.75 });
  assert.deepEqual(r.warnings, []);
  const imp = B.parseWeightMeasurement('01 9c 40');
  assert.equal(imp.values.weight, 165.4);
  assert.equal(imp.fields[0].unit, 'lb');
  const bad = B.parseWeightMeasurement('00 ff ff');
  assert.equal(bad.measurementUnsuccessful, true);
});

test('Body Composition Feature (0x2A9B) decodes support bits and resolution fields', () => {
  const r = B.parseBodyCompositionFeature(B.SAMPLES.bcfAll);
  assert.equal(r.flagsHex, '0x0001bfff');
  assert.equal(r.values['Weight Supported'], true);
  assert.equal(r.values['Height Supported'], true);
  assert.match(r.values['Mass Measurement Resolution (bits 11–14)'], /^7 → 0\.005 kg/);
  assert.match(r.values['Height Measurement Resolution (bits 15–17)'], /^3 → 0\.001 m/);
  const none = B.parseBodyCompositionFeature('00 00 00 00');
  assert.equal(none.values['Time Stamp Supported'], false);
  assert.match(none.values['Mass Measurement Resolution (bits 11–14)'], /Not specified/);
});

test('Weight Scale Feature (0x2A9E) decodes support bits and resolution fields', () => {
  const r = B.parseWeightScaleFeature(B.SAMPLES.wsfAll);
  assert.equal(r.values['BMI Supported'], true);
  assert.match(r.values['Weight Measurement Resolution (bits 3–6)'], /^7 →/);
  assert.match(r.values['Height Measurement Resolution (bits 7–9)'], /^3 →/);
});

test('uuid helpers accept numbers, short hex and 128-bit base UUIDs', () => {
  assert.equal(B.uuid16(0x2a9c), 0x2a9c);
  assert.equal(B.uuid16('2a9c'), 0x2a9c);
  assert.equal(B.uuid16('0x2A9C'), 0x2a9c);
  assert.equal(B.uuid16('00002a9c-0000-1000-8000-00805f9b34fb'), 0x2a9c);
  assert.equal(B.uuid16('6e400001-b5a3-f393-e0a9-e50e24dcca9e'), null);
  assert.equal(B.nameOf('0000181b-0000-1000-8000-00805f9b34fb'), 'Body Composition Service');
  assert.equal(B.hex([1, 255]), '01 ff');
  assert.throws(() => B.hexToBytes('abc'));
});

test('parseByUuid dispatches and handles DIS strings / battery', () => {
  assert.equal(B.parseByUuid('2a9c', B.SAMPLES.bcmSiFull).characteristic, 'Body Composition Measurement');
  assert.equal(B.parseByUuid('2a9d', B.SAMPLES.wsmSi).characteristic, 'Weight Measurement');
  assert.equal(B.parseByUuid('2a29', Buffer.from('ACME')).values.text, 'ACME');
  assert.equal(B.parseByUuid('2a19', [87]).values.percent, 87);
  assert.equal(B.parseByUuid('ffe1', [1, 2, 3]), null);
});

test('Date Time: zero date is flagged, out-of-range flagged', () => {
  const z = B.parseDateTime('00 00 00 00 00 00 00');
  assert.equal(z.iso, null);
  assert.equal(z.warnings.length, 1);
  const bad = B.parseDateTime('ea 07 0d 04 0f 35 00');
  assert.equal(bad.warnings.length, 1);
});
