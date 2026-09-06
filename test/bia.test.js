'use strict';
/*
 * The body-composition maths, checked against the vendor's own app.
 *
 * Everything else in this suite checks internal consistency. This file is the
 * only external reference point: a real reading, and the numbers the phone
 * showed for it.
 */
const test = require('node:test');
const assert = require('node:assert');
const BIA = require('../bia.js');

/*
 * The vendor panel, checked against a real reading from the scale's own app.
 *
 *   97.60 kg, 180 cm, 39, male, 606.4 Ω whole-body
 *
 * These are the numbers on the phone for that measurement. They are the only
 * external check this file has, and every one of them must stay within 3%:
 * beyond that the two panels look like different people to anyone holding the
 * phone next to the terminal, which is what "the values are wrong" meant.
 */
test('the vendor panel reproduces the app to within 3% on every metric', () => {
  const r = BIA.estimate({ weightKg: 97.6, impedanceOhm: 606.4, heightCm: 180, age: 39, sex: 'male' });
  const vm = r.vendorMatch;
  const APP = {
    bmi: 30.10, bodyFatPercent: 40.60, muscleMassPercent: 55.40,
    bodyWaterPercent: 43.60, boneMassKg: 3.90, bmrKcal: 1622,
    proteinMassKg: 11.90, muscleMassKg: 54.07, fatFreeMassKg: 57.97,
    bodyWaterLitres: 42.55, fatMassKg: 39.63, idealWeightKg: 71.30,
  };

  for (const [key, expected] of Object.entries(APP)) {
    const got = vm[key];
    assert.strictEqual(typeof got, 'number', `${key} must be produced, not omitted`);
    const off = Math.abs((got - expected) / expected) * 100;
    assert.ok(off <= 3,
      `${key}: ${got} against the app's ${expected} is ${off.toFixed(1)}% out`);
  }
});

/*
 * Two relations close exactly, and they are why the clinical panel diverged so
 * far. The app uses Katch-McArdle from lean mass, not Mifflin-St Jeor from
 * weight and height, and it defines muscle as what is left of lean mass after
 * its bone figure. Getting either wrong moves the number by 17%.
 */
test('the vendor conventions that close exactly, still close exactly', () => {
  const r = BIA.estimate({ weightKg: 97.6, impedanceOhm: 606.4, heightCm: 180, age: 39, sex: 'male' });
  const vm = r.vendorMatch;

  assert.strictEqual(vm.bmrKcal, Math.round(370 + 21.6 * vm.fatFreeMassKg),
    'BMR is Katch-McArdle from lean mass');
  assert.ok(Math.abs(vm.muscleMassKg - (vm.fatFreeMassKg - vm.boneMassKg)) < 0.01,
    'muscle is fat-free mass minus bone');
  assert.ok(Math.abs(vm.proteinMassKg - (vm.fatFreeMassKg - vm.bodyWaterLitres - vm.boneMassKg)) < 0.01,
    'protein is the four-compartment remainder, not a fitted ratio');

  // And skeletal muscle stays out, because three readings prove it is not a
  // fraction of anything here.
  assert.ok(vm.unresolved && vm.unresolved.skeletalMuscleMassKg,
    'skeletal muscle is named as unresolved rather than guessed at');
  assert.strictEqual(vm.skeletalMuscleMassKg, undefined);
});
