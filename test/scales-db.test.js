'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scales-db.js');

test('identify matches known scales by advertised name', () => {
  assert.equal(S.identify('MIBFS').family, 'xiaomi');
  assert.equal(S.identify('Beurer BF720').family, 'standard');
  assert.equal(S.identify('SBF72').family, 'standard');
  assert.equal(S.identify('YUNMAI-ISM').family, 'vendorFFE0');
  assert.equal(S.identify('Chipsea-BLE').family, 'broadcast');
  assert.equal(S.identify('FITTRACK Dara').family, 'vendorFFB0');
  assert.equal(S.identify('some unheard-of scale').family, 'unknown');
});

test('identify falls back to service UUIDs when the name is unknown', () => {
  const r = S.identify('No Name', ['0000ffb0-0000-1000-8000-00805f9b34fb']);
  assert.equal(r.family, 'vendorFFB0');
  assert.match(r.matchedBy, /service UUID/);
  const std = S.identify('No Name', ['0000181b-0000-1000-8000-00805f9b34fb']);
  assert.equal(std.family, 'standard');
  assert.equal(std.hasStandardServices, true);
});

test('name match wins over service UUID match', () => {
  // Mi scales expose 0x181B but do NOT speak the standard 0x2A9C layout
  const r = S.identify('MIBCS', ['0000181b-0000-1000-8000-00805f9b34fb']);
  assert.equal(r.family, 'xiaomi');
  assert.equal(r.matchedBy, 'name');
});

test('optionalServices covers standard and vendor UUIDs with no duplicates', () => {
  const o = S.optionalServices();
  assert.equal(o.length, new Set(o).size);
  for (const u of [0x181b, 0x181d, 0x181c, 0x180a, 0xffb0, 0xfff0, 0xffe0, 0x1a10, 0x78b2]) {
    assert.ok(o.includes(u), 'missing 0x' + u.toString(16));
  }
});

test('Mi Scale v2 13-byte record decodes weight and impedance', () => {
  const r = S.parseMiScaleRecord('02 22 ea 07 09 04 0f 35 00 f4 01 c0 3a');
  assert.equal(r.variant, 'Mi Body Composition Scale v2 (13-byte record)');
  assert.equal(r.values.Weight, 75.2);          // 0x3ac0 = 15040 / 200
  assert.equal(r.values.Impedance, 500);        // 0x01f4
  assert.equal(r.values['Time Stamp'], '2026-09-04T15:53:00');
  assert.equal(r.fields.find((f) => f.name === 'Weight').unit, 'kg');
});

test('Mi Scale v2 in pounds uses the /100 divisor', () => {
  const r = S.parseMiScaleRecord('03 22 ea 07 09 04 0f 35 00 f4 01 b8 40');
  assert.equal(r.fields.find((f) => f.name === 'Weight').unit, 'lb');
  assert.equal(r.values.Weight, 165.68);        // 0x40b8 = 16568 / 100
});

test('Mi Scale v1 10-byte record decodes weight', () => {
  const r = S.parseMiScaleRecord('22 c0 3a ea 07 09 04 0f 35 00');
  assert.equal(r.variant, 'Mi Scale v1 (10-byte record)');
  assert.equal(r.values.Weight, 75.2);
});

test('Mi Scale flags: unstable weight and stepped-off are warned about', () => {
  const unstable = S.parseMiScaleRecord('02 00 ea 07 09 04 0f 35 00 ff ff c0 3a');
  assert.ok(unstable.warnings.some((w) => /not stabilised/.test(w)));
  assert.equal(unstable.values.Impedance, null);
  const off = S.parseMiScaleRecord('22 c0 3a ea 07 09 04 0f 35 80'.replace('22', 'a2'));
  assert.ok(off.warnings.some((w) => /stepped off/.test(w)));
});

test('Mi Scale rejects a wrong-length record instead of inventing values', () => {
  const r = S.parseMiScaleRecord('01 02 03 04 05');
  assert.ok(r.warnings.some((w) => /Not a known Mi Scale record length/.test(w)));
  assert.deepEqual(r.values, {});
});

test('guessFields finds a plausible weight in an unknown frame', () => {
  // 0x3a98 = 15000; /200 = 75 kg
  const g = S.guessFields('aa 55 98 3a 00 00');
  assert.ok(g.guesses.some((x) => x.offset === 2 && x.endian === 'LE' && x.divisor === 200 && x.asKg === 75));
});

test('guessFields returns nothing for a frame with no plausible values', () => {
  const g = S.guessFields('00 00 00 00');
  assert.equal(g.guesses.length, 0);
});

test('POPULATION reports the surveyed protocol split', () => {
  const p = S.POPULATION;
  assert.equal(p.standardProfile + p.broadcastOnly + p.proprietaryGatt + p.unclassified, p.surveyedHandlers);
  assert.ok(p.standardProfile / p.surveyedHandlers < 0.15, 'standard profile is a small minority');
});

test('every database entry names a family that exists', () => {
  for (const d of S.DEVICES) {
    assert.ok(S.FAMILIES[d.family], `${d.name} has unknown family ${d.family}`);
    assert.ok(d.match.length && d.match.every((m) => m === m.toLowerCase()), `${d.name} patterns must be lowercase`);
  }
});
