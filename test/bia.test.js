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

/*
 * Age is optional; sex and height are not, and the asymmetry is measured.
 * Holding one real reading fixed, sex male -> female moves body fat by 12.3%
 * while age 25 -> 60 moves it by 0.0%. Age reaches only BMR, skeletal muscle
 * and the BMI anchor that the trust cross-check compares against.
 */
test('without an age the composition panel is unchanged', () => {
  const base = { weightKg: 97.7, impedanceOhm: 606.4, heightCm: 180, sex: 'male' };
  const withAge = BIA.estimate({ ...base, age: 39 }).values;
  const noAge = BIA.estimate(base).values;

  // Exactly identical: age is nowhere in the equations behind these.
  for (const k of ['bodyFatPercent', 'fatMassKg', 'fatFreeMassKg', 'fatFreeMassIndex',
    'bodyWaterLitres', 'bodyWaterPercent', 'bmi']) {
    assert.strictEqual(noAge[k], withAge[k], `${k} must not depend on age at all`);
  }

  /*
   * Not quite identical: bone mass carries a small age term, worth 1.8% across
   * an adult range and below the rounding a panel shows. Rather than withhold
   * bone — and muscle and protein with it, since both are derived from it —
   * they are computed against a mid-range age. The cost is a hundredth of a
   * kilogram, and it must stay that small.
   */
  for (const k of ['muscleMassKg', 'boneMassKg', 'proteinMassKg']) {
    const drift = Math.abs(noAge[k] - withAge[k]);
    assert.ok(drift <= 0.05,
      `${k} drifted ${drift.toFixed(3)} kg on a mid-range age; anything larger means it `
      + 'should be withheld rather than assumed');
  }
});

test('what needs an age is withheld with a reason, not guessed at', () => {
  const r = BIA.estimate({ weightKg: 97.7, impedanceOhm: 606.4, heightCm: 180, sex: 'male' });

  for (const k of ['bmrKcal', 'bmrAlternatesKcal', 'skeletalMuscleMassKg',
    'skeletalMusclePercent', 'skeletalMuscleIndex', 'bodyFatPercentBmiAnchor',
    'bodyFatGapPoints']) {
    assert.ok(!(k in r.values), `${k} takes age as a term and must be withheld`);
    assert.ok(r.omitted[k], `${k} must say why it is absent`);
    assert.match(r.omitted[k], /age/i);
  }

  /*
   * The cross-check is the real cost. It compares the impedance figure against
   * Deurenberg's BMI estimate, which takes age as a term worth 16% across an
   * adult range — run against an assumed age it would reject good readings and
   * pass bad ones, and T3 is fatal, so it would withdraw trust silently.
   */
  assert.strictEqual(r.crossCheck, null, 'the check cannot run');
  assert.ok(!r.flags.some((f) => f.rule === 'T3' || f.rule === 'T8'),
    'and neither rule that depends on it fires');
  assert.ok(r.warnings.some((w) => /cross-check did not run/i.test(w)),
    'losing a safety net is said out loud');
});

test('a blank age is an omission; an impossible one is still a mistake', () => {
  const base = { weightKg: 97.7, impedanceOhm: 606.4, heightCm: 180, sex: 'male' };
  // A blank form field means "not given", which is what a host actually sends.
  for (const age of [undefined, null, '']) {
    const r = BIA.estimate({ ...base, age });
    assert.ok(!('bmrKcal' in r.values), `age ${JSON.stringify(age)} reads as omitted`);
    assert.ok(r.values.bodyFatPercent > 0, 'and the panel still computes');
  }
  // A real age is used.
  assert.ok('bmrKcal' in BIA.estimate({ ...base, age: 39 }).values);
});

test('sex still changes everything, which is why it is not optional', () => {
  const base = { weightKg: 97.7, impedanceOhm: 606.4, heightCm: 180, age: 39 };
  const m = BIA.estimate({ ...base, sex: 'male' }).values;
  const f = BIA.estimate({ ...base, sex: 'female' }).values;
  const shift = Math.abs((f.bodyFatPercent - m.bodyFatPercent) / m.bodyFatPercent) * 100;
  assert.ok(shift > 10,
    `sex must move body fat by more than 10%, moved ${shift.toFixed(1)}% — if this `
    + 'ever falls, the case for requiring sex needs rechecking');
});

/*
 * Measured, not assumed: the identity written to the scale during the
 * handshake does not change what it measures.
 *
 * Two readings of the same person, back to back. The first told the scale the
 * truth; the second told it a 70-year-old, 140 cm woman was standing there.
 *
 *   told the truth   97.55 kg   609.2 Ω   26.7, 327.2, 333.3, 322.7, 345.3, ...
 *   told a lie       97.55 kg   604.6 Ω   26.6, 325.8, 333.3, 320.3, 345.5, ...
 *
 * Identical to the gram, 0.8% apart on impedance — a tenth of the drift
 * between two honest readings hours apart. So the handshake identity affects
 * what the scale DISPLAYS, not what it sends, and nobody needs to be asked
 * anything before standing on it.
 *
 * This is here rather than in a comment because it is the evidence for a
 * design decision that was made, reversed on a wrong diagnosis, and remade.
 */
test('the two handshake readings agree, which is why no profile is asked for first', () => {
  const truth = { weightKg: 97.55, impedanceOhm: 609.2, heightCm: 180, age: 39, sex: 'male' };
  const lie = { ...truth, impedanceOhm: 604.6 };

  const a = BIA.estimate(truth).values;
  const b = BIA.estimate(lie).values;

  const gap = Math.abs(a.bodyFatPercent - b.bodyFatPercent);
  assert.ok(gap <= 0.5,
    `body fat differed by ${gap.toFixed(1)} points between the two handshakes; anything `
    + 'larger and the identity would be load-bearing after all');

  // And both land where the vendor app does for this person.
  for (const v of [a, b]) {
    assert.ok(Math.abs(v.bodyFatPercent - 40.7) <= 1,
      `${v.bodyFatPercent}% should sit near the app's 40.7%`);
  }
});
