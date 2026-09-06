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

/*
 * Visceral fat, extracted from ICBodyFatAlgorithmWLA37::calc in the vendor's
 * own libICBodyFatAlgorithms.so and checked by executing that library against
 * 12,939 randomised inputs with no mismatch.
 *
 *   raw  = 0.502 * fatMass - 0.029 * fatFreeMass - 0.477
 *   vfal = min(20, max(1, trunc(raw)))
 *
 * It is a RATING FROM 1 TO 20, not a percentage. This file previously refused
 * to compute it at all, on the grounds that no peer-reviewed formula existed —
 * which was true of the general quantity and irrelevant to the question the
 * user was asking, which was what THEIR scale shows.
 */
test('visceral fat reproduces the rating the scale displays', () => {
  const r = BIA.estimate({ weightKg: 97.6, impedanceOhm: 606.4, heightCm: 180, age: 39, sex: 'male' });
  assert.strictEqual(r.vendorMatch.visceralFatRating, 17, 'the scale shows 17');
});

test('the visceral rating is an integer clamped to 1..20', () => {
  // Only readings that survive the trust checks carry a vendorMatch at all,
  // so these inputs are ones the rules accept.
  const at = (weightKg, impedanceOhm) => {
    const vm = BIA.estimate({ weightKg, impedanceOhm, heightCm: 180, age: 39, sex: 'male' }).vendorMatch;
    assert.ok(vm, `${weightKg} kg at ${impedanceOhm} Ω should produce a vendor panel`);
    return vm.visceralFatRating;
  };

  const ladder = [[70, 520], [75, 500], [97.6, 606.4], [160, 800]];
  const ratings = ladder.map(([w, z]) => at(w, z));

  for (const v of ratings) {
    assert.ok(Number.isInteger(v), `${v} is an integer rating, not a percentage`);
    assert.ok(v >= 1 && v <= 20, `${v} is inside the 1..20 clamp`);
  }

  // Rises with fatness rather than moving arbitrarily.
  for (let i = 1; i < ratings.length; i += 1) {
    assert.ok(ratings[i] >= ratings[i - 1],
      `rating must not fall as fatness rises: ${ratings.join(' -> ')}`);
  }

  // The top is a ceiling the clamp imposes, not a maximum anyone measured —
  // which is the whole reason this must not be shown as a percentage.
  assert.strictEqual(at(160, 800), 20, 'a very high fat mass saturates at 20');
});
