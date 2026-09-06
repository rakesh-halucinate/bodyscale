'use strict';
/*
 * INT-TRUST - derived data, trust, and the payload shapes an Electron app may draw.
 *
 * Everything here runs against the real `scale.js --serve` over a real pipe, with
 * the radio replaced by the recorded Dr Trust SSW533 session or by a hand-built
 * fixture. The last group drives bia.js in-process, because a swept invariant
 * needs thousands of subjects and no process can be spawned that many times.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const H = require('./harness');
const BIA = require(path.join(H.ROOT, 'bia.js'));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ALL_DERIVED_KEYS = H.IMPEDANCE_FREE_KEYS.concat(H.IMPEDANCE_ONLY_KEYS);
const CONFIDENCE_VOCABULARY = ['derived-literature', 'derived-vendor-convention', ''];
const VENDOR_CONVENTION_KEYS = [
  'muscleMassKg', 'muscleMassPercent', 'boneMassKg', 'proteinMassKg', 'proteinPercent',
];
const OMITTED_KEYS = [
  'visceralFatRating', 'metabolicAgeYears', 'bodyScore',
  'subcutaneousFatPercent', 'bodyWaterPercentOfFfm', 'fatFreeMassKyle2001',
];
const FATAL_RULES = new Set(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
const WARN_RULES = new Set(['T7', 'T8', 'T9', 'T10', 'T11']);

/** The superscript two, written as an escape so this file stays pure ASCII. */
const PER_M2 = 'kg/m\u00b2';

const UNITS_IMPEDANCE_FREE = {
  bmi: PER_M2,
  bmiCategoryWho: '',
  bmiCategoryAsiaPacific: '',
  bodyFatPercentBmiAnchor: '%',
  bmrKcal: 'kcal/day',
  healthyWeightRangeKg: 'kg',
  weightAboveHealthyRangeKg: 'kg',
  idealWeightRangeKg: 'kg',
  bodyFatRecommendedKey: '',
};

const UNITS_IMPEDANCE_ONLY = {
  bodyWaterLitres: 'L',
  bodyWaterPercent: '%',
  fatFreeMassKg: 'kg',
  fatFreeMassIndex: PER_M2,
  bodyFatPercent: '%',
  fatMassKg: 'kg',
  muscleMassKg: 'kg',
  muscleMassPercent: '%',
  skeletalMuscleMassKg: 'kg',
  skeletalMusclePercent: '%',
  skeletalMuscleIndex: PER_M2,
  boneMassKg: 'kg',
  proteinMassKg: 'kg',
  proteinPercent: '%',
  bodyFatGapPoints: 'points',
};

/**
 * One Dr Trust measurement-record frame, built by hand.
 *
 * The layout is read straight out of drivers.js (drTrust.onFrame): the 0x23
 * marker sits at byte 2, the impedance is a big-endian 16-bit count of tenths
 * of an ohm at bytes 7..8, and the weight is a big-endian 24-bit gram count at
 * bytes 10..12. Byte 9 is the filler the real device sends between them.
 */
/**
 * One measurement record, the way the scale sends one.
 *
 * These cases used to build TWO frames: a "subtype 0x00" weight record and a
 * "subtype 0x01" impedance record. Neither subtype exists. A real record is a
 * single 0xA7 message carrying the weight and every impedance slot together,
 * with the slot count declared in byte 14. Building two meant the weight from
 * one frame and the impedance from another could disagree, which is a state
 * the hardware cannot produce.
 */
function recordFixture(tag, impedanceTenths, grams) {
  return H.fixture(tag, [
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'ready' },
    { t: 'frame',
      uuid: '0000ffb3-0000-1000-8000-00805f9b34fb',
      hex: H.recordFrame({ weightKg: grams / 1000, impedances: [impedanceTenths / 10] }) },
    { t: 'end', reason: 'finished' },
  ]);
}

/** A measurement from the recorded session: weight AND impedance. */
async function withImpedance(profile) {
  const r = await H.measureOnce(profile ? { profile } : {});
  assert.strictEqual(r.terminal && r.terminal.type, 'measurement',
    `expected a measurement, got ${JSON.stringify(r.terminal)}`);
  return r.terminal;
}

/** A measurement from the recorded session with the impedance channel deleted. */
async function withoutImpedance(tag) {
  const r = await H.measureOnce({ replay: H.fixtureWithoutImpedance(tag) });
  assert.strictEqual(r.terminal && r.terminal.type, 'measurement',
    `expected a measurement, got ${JSON.stringify(r.terminal)}`);
  return r.terminal;
}

/** The bia.js input grid. Read-only; every test builds its own results. */
const GRID = {
  weights: [15, 19.9, 20, 45, 60, 80, 97.9, 130, 200],
  heights: [80, 90, 150, 168, 180, 195, 250, 260],
  ages: [4, 5, 12, 25, 39, 60, 89, 121],
  sexes: ['male', 'female'],
  impedances: [0, 100, 149.9, 150, 250, 400, 529.9, 700, 900, 1200, 1200.1, 1400],
};

/** Weight, height and age that bia.js will not reject out of hand (rule T1). */
function isValidSubject(p) {
  return p.weightKg >= 20 && p.heightCm >= 90 && p.heightCm <= 250 && p.age >= 5 && p.age <= 120;
}

/** Call `fn(input, result, label)` for every point on the grid. Returns the count. */
function sweep(fn) {
  let n = 0;
  for (const weightKg of GRID.weights) {
    for (const heightCm of GRID.heights) {
      for (const age of GRID.ages) {
        for (const sex of GRID.sexes) {
          for (const impedanceOhm of GRID.impedances) {
            const input = { weightKg, heightCm, age, sex, impedanceOhm };
            fn(input, BIA.estimate(input),
              `${weightKg}kg ${heightCm}cm ${age}y ${sex} ${impedanceOhm}ohm`);
            n++;
          }
        }
      }
    }
  }
  return n;
}

/** The keys scale.js copies out of bia.values into `derived`. */
function derivedKeysOf(bia) {
  return Object.keys(bia.values).filter(
    (k) => k !== 'weightKg' && k !== 'impedanceOhm' && typeof bia.values[k] !== 'object');
}

// ---------------------------------------------------------------------------
// the full panel
// ---------------------------------------------------------------------------

// Prevents the app rendering a half-built panel: if a key silently disappears
// from `derived`, a tile the user expects (bone mass, protein, skeletal muscle)
// goes blank with no error anywhere.
test('INT-TRUST-01  a reading with impedance yields exactly the 24 documented derived keys', async () => {
  const m = await withImpedance();
  const keys = Object.keys(m.derived);
  assert.strictEqual(keys.length, 24, `derived had ${keys.length} keys: ${keys.join(', ')}`);
  assert.deepStrictEqual(keys.slice().sort(), ALL_DERIVED_KEYS.slice().sort());
  for (const k of ALL_DERIVED_KEYS) assert.ok(k in m.derived, `derived is missing ${k}`);
});

// Prevents the app labelling a good foot-to-foot reading as untrustworthy, or
// quietly dropping the raw numbers the user actually stood on the scale for.
test('INT-TRUST-02  a reading that survives its checks is marked trusted and echoes both raw numbers', async () => {
  const m = await withImpedance();
  assert.deepStrictEqual(m.trust, { impedanceFree: true, impedanceDerived: true });
  assert.deepStrictEqual(m.measured, {
    weightKg: H.EXPECTED.weightKg, impedanceOhm: H.EXPECTED.impedanceOhm,
  });
  assert.strictEqual(m.derived.bodyFatPercent, 36);
  assert.strictEqual(m.derived.bmi, 30.2);
  assert.strictEqual(m.derived.bmiCategoryWho, 'obese class I');
});

// Prevents the app inventing body composition when the user stood on the scale
// in socks: no fat-free mass, no muscle, no bone must reach the screen at all.
test('INT-TRUST-03  a reading without impedance yields exactly the 9 impedance-free keys and nothing else', async () => {
  const m = await withoutImpedance('trust03');
  const keys = Object.keys(m.derived);
  assert.strictEqual(keys.length, 9, `derived had ${keys.length} keys: ${keys.join(', ')}`);
  assert.deepStrictEqual(keys.slice().sort(), H.IMPEDANCE_FREE_KEYS.slice().sort());
  for (const k of H.IMPEDANCE_ONLY_KEYS) {
    assert.ok(!(k in m.derived), `${k} leaked into an impedance-free panel`);
  }
});

// Prevents the app printing "0 ohm" or "undefined" where the scale sent nothing,
// and prevents it offering a cross-check panel that has no impedance side.
test('INT-TRUST-04  a reading without impedance reports impedanceOhm null, keeps impedanceFree trust, and has no crossCheck', async () => {
  const m = await withoutImpedance('trust04');
  assert.strictEqual(m.measured.impedanceOhm, null);
  assert.strictEqual(m.measured.weightKg, 98.25);
  assert.deepStrictEqual(m.trust, { impedanceFree: true, impedanceDerived: false });
  assert.strictEqual(m.crossCheck, null);
  assert.strictEqual(m.derived.bmi, 30.3);
});

// Prevents the headline body-fat tile reading "undefined": bodyFatRecommended is
// the one number the app puts front and centre, so its key must exist in derived
// and its value must be the same number the panel below it shows.
test('INT-TRUST-05  bodyFatRecommended always names a key that exists in derived, in both shapes', async () => {
  const good = await withImpedance();
  assert.ok(good.bodyFatRecommended, 'bodyFatRecommended was null on a good reading');
  assert.strictEqual(good.bodyFatRecommended.key, 'bodyFatPercent');
  assert.ok(good.bodyFatRecommended.key in good.derived,
    `${good.bodyFatRecommended.key} is not a derived key`);
  assert.strictEqual(good.bodyFatRecommended.value, good.derived[good.bodyFatRecommended.key]);
  assert.strictEqual(good.derived.bodyFatRecommendedKey, good.bodyFatRecommended.key);

  const bare = await withoutImpedance('trust05');
  assert.ok(bare.bodyFatRecommended, 'bodyFatRecommended was null on an impedance-free reading');
  assert.strictEqual(bare.bodyFatRecommended.key, 'bodyFatPercentBmiAnchor');
  assert.ok(bare.bodyFatRecommended.key in bare.derived,
    `${bare.bodyFatRecommended.key} is not a derived key`);
  assert.strictEqual(bare.bodyFatRecommended.value, bare.derived[bare.bodyFatRecommended.key]);
  assert.strictEqual(bare.derived.bodyFatRecommendedKey, bare.bodyFatRecommended.key);
});

// Prevents a number appearing with no unit beside it, or a stale unit surviving
// after a metric is removed. The app indexes units and confidence by derived key,
// so the three key sets have to be identical or a lookup returns undefined.
test('INT-TRUST-06  units and confidence cover exactly the derived keys, in both shapes', async () => {
  for (const m of [await withImpedance(), await withoutImpedance('trust06')]) {
    const keys = Object.keys(m.derived).sort();
    assert.ok(keys.length > 0, 'derived was empty');
    assert.deepStrictEqual(Object.keys(m.units).sort(), keys);
    assert.deepStrictEqual(Object.keys(m.confidence).sort(), keys);
    for (const k of keys) {
      assert.strictEqual(typeof m.units[k], 'string', `units.${k} is not a string`);
      assert.strictEqual(typeof m.confidence[k], 'string', `confidence.${k} is not a string`);
    }
  }
});

// Prevents a vendor-convention guess (bone mass, protein, "muscle mass") being
// presented with the same authority as a published equation. The app greys these
// out; if the label flips to derived-literature the user reads a guess as fact.
test('INT-TRUST-07  confidence uses only the known vocabulary and marks exactly the vendor-convention metrics', async () => {
  const m = await withImpedance();
  for (const [k, v] of Object.entries(m.confidence)) {
    assert.ok(CONFIDENCE_VOCABULARY.includes(v), `confidence.${k} was ${JSON.stringify(v)}`);
  }
  const vendor = Object.keys(m.confidence)
    .filter((k) => m.confidence[k] === 'derived-vendor-convention').sort();
  assert.deepStrictEqual(vendor, VENDOR_CONVENTION_KEYS.slice().sort());

  const literature = Object.keys(m.confidence)
    .filter((k) => m.confidence[k] === 'derived-literature');
  assert.strictEqual(literature.length, 18);
  // bodyFatRecommendedKey is a pointer, not a measurement, so it carries no claim.
  assert.strictEqual(m.confidence.bodyFatRecommendedKey, '');
  assert.strictEqual(m.confidence.bmi, 'derived-literature');
  assert.strictEqual(m.confidence.boneMassKg, 'derived-vendor-convention');
});

// Prevents a kilogram being drawn as a percent, or a category string acquiring a
// unit suffix. The app concatenates value + unit, so a wrong unit is a wrong claim
// on screen with no way for the user to tell.
test('INT-TRUST-08  every derived key carries its exact documented unit, in both shapes', async () => {
  const good = await withImpedance();
  assert.deepStrictEqual(good.units,
    Object.assign({}, UNITS_IMPEDANCE_FREE, UNITS_IMPEDANCE_ONLY));

  const bare = await withoutImpedance('trust08');
  assert.deepStrictEqual(bare.units, UNITS_IMPEDANCE_FREE);
});

// Prevents an unreadable or unroutable warning banner: the app groups flags by
// severity and prints the message verbatim, so a missing rule id, an unknown
// severity, or an empty message is a blank red box the user cannot act on.
test('INT-TRUST-09  flags entries carry rule, severity and a real sentence, and the recorded session raises only warnings', async () => {
  const m = await withImpedance();
  assert.ok(Array.isArray(m.flags), 'flags is not an array');
  for (const f of m.flags) {
    H.assertShape(assert, f, { rule: 'string', severity: 'string', message: 'string' }, 'flag');
    assert.ok(FATAL_RULES.has(f.rule) || WARN_RULES.has(f.rule), `unknown rule ${f.rule}`);
    assert.ok(f.severity === 'fatal' || f.severity === 'warn', `bad severity ${f.severity}`);
    assert.strictEqual(f.severity, FATAL_RULES.has(f.rule) ? 'fatal' : 'warn');
    assert.ok(f.message.trim().length > 20, `flag ${f.rule} message is too short: ${f.message}`);
    assert.ok(f.message.trim().endsWith('.'), `flag ${f.rule} message is not a sentence: ${f.message}`);
  }
  // This particular subject trips the one-sigma disagreement and the protein
  // range check, and nothing fatal, which is why the panel stays trusted.
  assert.deepStrictEqual(m.flags.map((f) => `${f.rule}:${f.severity}`), ['T8:warn', 'T10:warn']);
  assert.ok(m.flags[0].message.includes('6.9 points'), m.flags[0].message);
  assert.strictEqual(m.flags.filter((f) => f.severity === 'fatal').length, 0);
});

// Prevents the app silently showing a visceral-fat or metabolic-age tile that
// this project deliberately refuses to compute. The reason string is what the
// app shows when the user taps the empty slot, so it cannot be blank.
test('INT-TRUST-10  omitted lists the six refused metrics with a real reason, in both shapes', async () => {
  for (const m of [await withImpedance(), await withoutImpedance('trust10')]) {
    assert.deepStrictEqual(Object.keys(m.omitted).sort(), OMITTED_KEYS.slice().sort());
    for (const [k, reason] of Object.entries(m.omitted)) {
      assert.strictEqual(typeof reason, 'string', `omitted.${k} is not a string`);
      assert.ok(reason.trim().length >= 40, `omitted.${k} reason is too short: ${reason}`);
      assert.ok(!(k in m.derived), `${k} is both omitted and derived`);
    }
  }
});

// Prevents an empty string or a null landing in the warning list the app renders
// as bullet points, and prevents the one actionable instruction ("bare feet")
// disappearing when the impedance channel is missing.
test('INT-TRUST-11  warnings is an array of real sentences and names the fix when impedance is missing', async () => {
  const good = await withImpedance();
  assert.ok(Array.isArray(good.warnings));
  for (const w of good.warnings) {
    assert.strictEqual(typeof w, 'string');
    assert.ok(w.trim().length > 20, `warning is too short: ${JSON.stringify(w)}`);
  }
  assert.deepStrictEqual(good.warnings, [
    'The scale sent two numbers, your weight and one impedance value. '
    + 'Everything else was estimated from them.',
  ]);

  const bare = await withoutImpedance('trust11');
  assert.deepStrictEqual(bare.warnings, [
    'No impedance was measured, so body composition is unavailable. '
    + 'Stand with bare feet on the metal pads.',
  ]);
});

// Prevents the "the two methods disagree by N points" panel contradicting the
// two numbers printed directly above it, which would read to the user as a bug.
test('INT-TRUST-12  crossCheck is an object whose figures match the derived panel', async () => {
  const m = await withImpedance();
  H.assertShape(assert, m.crossCheck, {
    impedanceBased: 'number', bmiBased: 'number', gapPoints: 'number',
    oneSigma: 'number', twoSigma: 'number',
  }, 'crossCheck');
  assert.strictEqual(m.crossCheck.impedanceBased, m.derived.bodyFatPercent);
  assert.strictEqual(m.crossCheck.bmiBased, m.derived.bodyFatPercentBmiAnchor);
  assert.strictEqual(m.crossCheck.gapPoints, m.derived.bodyFatGapPoints);
  assert.strictEqual(m.crossCheck.oneSigma, 6.7);
  assert.strictEqual(m.crossCheck.twoSigma, 13.4);
  assert.ok(m.crossCheck.twoSigma > m.crossCheck.oneSigma);
});

// ---------------------------------------------------------------------------
// impedance that arrives but fails its checks
// ---------------------------------------------------------------------------

// Prevents the app showing a 140-ohm foot-to-foot artefact as a real body
// composition: the numbers are still in the payload (the shape does not change)
// but trust says do not headline them, and the recommended figure moves to BMI.
test('INT-TRUST-13  a rejected impedance keeps all 24 keys but drops trust and switches the anchor', async () => {
  const r = await H.measureOnce({ replay: recordFixture('trust13', 1400, 97900) });
  const m = r.terminal;
  assert.strictEqual(m.type, 'measurement', JSON.stringify(m));
  assert.strictEqual(m.measured.impedanceOhm, 140);
  assert.strictEqual(Object.keys(m.derived).length, 24);
  assert.deepStrictEqual(m.trust, { impedanceFree: true, impedanceDerived: false });
  assert.strictEqual(m.bodyFatRecommended.key, 'bodyFatPercentBmiAnchor');
  assert.strictEqual(m.bodyFatRecommended.value, m.derived.bodyFatPercentBmiAnchor);
  assert.strictEqual(m.derived.bodyFatRecommendedKey, 'bodyFatPercentBmiAnchor');

  const fatal = m.flags.filter((f) => f.severity === 'fatal').map((f) => f.rule);
  assert.deepStrictEqual(fatal, ['T2', 'T3', 'T4', 'T5', 'T6']);
  // Every fatal message is repeated in warnings, which is the list the app shows.
  for (const f of m.flags.filter((x) => x.severity === 'fatal')) {
    assert.ok(m.warnings.includes(f.message), `fatal ${f.rule} never reached warnings`);
  }
  assert.ok(m.warnings.some((w) => w.includes('not trustworthy in absolute terms')),
    JSON.stringify(m.warnings));
});

// Prevents the impedance-free half of the panel being collateral damage when the
// impedance is rejected. BMI, BMR and the weight targets must read identically
// whether or not the electrode reading was usable, because they never used it.
test('INT-TRUST-14  changing only the impedance bytes flips trust and leaves every impedance-free number untouched', async () => {
  const bad = (await H.measureOnce({ replay: recordFixture('trust14a', 1400, 97900) })).terminal;
  const good = (await H.measureOnce({ replay: recordFixture('trust14b', 5299, 97900) })).terminal;
  assert.strictEqual(bad.type, 'measurement');
  assert.strictEqual(good.type, 'measurement');

  assert.strictEqual(bad.measured.weightKg, good.measured.weightKg);
  assert.strictEqual(bad.measured.impedanceOhm, 140);
  assert.strictEqual(good.measured.impedanceOhm, H.EXPECTED.impedanceOhm);

  assert.strictEqual(bad.trust.impedanceDerived, false);
  assert.strictEqual(good.trust.impedanceDerived, true);
  assert.strictEqual(bad.bodyFatRecommended.key, 'bodyFatPercentBmiAnchor');
  assert.strictEqual(good.bodyFatRecommended.key, 'bodyFatPercent');

  for (const k of H.IMPEDANCE_FREE_KEYS) {
    if (k === 'bodyFatRecommendedKey') continue;
    assert.deepStrictEqual(bad.derived[k], good.derived[k], `${k} changed with the impedance`);
  }
  assert.notStrictEqual(bad.derived.bodyFatPercent, good.derived.bodyFatPercent);
});

// Prevents a crash when someone rests a bag on the scale. This is a third payload
// shape: derived, units, confidence and omitted are all EMPTY and
// bodyFatRecommended is null, so any app that dereferences it blindly throws.
test('INT-TRUST-15  a sub-20 kg reading returns an empty derived panel and a null bodyFatRecommended', async () => {
  const r = await H.measureOnce({ replay: recordFixture('trust15', 0, 5000) });
  const m = r.terminal;
  assert.strictEqual(m.type, 'measurement', JSON.stringify(m));
  assert.strictEqual(m.measured.weightKg, 5);
  assert.strictEqual(m.measured.impedanceOhm, null);
  assert.deepStrictEqual(m.derived, {});
  assert.deepStrictEqual(m.units, {});
  assert.deepStrictEqual(m.confidence, {});
  assert.deepStrictEqual(m.omitted, {});
  assert.strictEqual(m.bodyFatRecommended, null);
  assert.strictEqual(m.crossCheck, null);
  assert.deepStrictEqual(m.trust, { impedanceFree: false, impedanceDerived: false });
  assert.deepStrictEqual(m.flags.map((f) => `${f.rule}:${f.severity}`), ['T1:fatal']);
  assert.strictEqual(m.warnings.length, 1);
  assert.ok(m.warnings[0].includes('too low to be a person'), m.warnings[0]);
});

// Prevents the app trusting an impedance figure that is only implausible once the
// host's own age and height are applied. The same recorded electrode reading is
// trustworthy for one profile and not for another, and the app must follow trust,
// not the presence of the number.
test('INT-TRUST-16  the host profile alone can reject the impedance half while the impedance-free half survives', async () => {
  const tall = await withImpedance({ age: 39, heightCm: 250, sex: 'male' });
  assert.deepStrictEqual(tall.trust, { impedanceFree: true, impedanceDerived: false });
  assert.strictEqual(Object.keys(tall.derived).length, 24);
  assert.strictEqual(tall.bodyFatRecommended.key, 'bodyFatPercentBmiAnchor');
  assert.strictEqual(tall.bodyFatRecommended.value, tall.derived.bodyFatPercentBmiAnchor);
  assert.strictEqual(tall.derived.bodyFatPercentBmiAnchor, 11.6);
  assert.deepStrictEqual(
    tall.flags.filter((f) => f.severity === 'fatal').map((f) => f.rule), ['T5', 'T6']);
  for (const k of H.IMPEDANCE_FREE_KEYS) {
    assert.ok(k in tall.derived, `${k} vanished when the impedance was rejected`);
  }
  assert.deepStrictEqual(tall.profile, { sex: 'male', age: 39, heightCm: 250 });
});

// ---------------------------------------------------------------------------
// the invariant, swept over bia.js directly
// ---------------------------------------------------------------------------

// Prevents the single rule the whole UI hangs on from breaking: if a fatal check
// ever fires while trust stays true, the app headlines a number the code itself
// has already judged impossible.
test('INT-TRUST-17  any fatal flag means trust.impedanceDerived is false, over the whole input grid', async () => {
  let fatalCases = 0, trustedCases = 0;
  const n = sweep((input, r, label) => {
    const fatal = r.flags.filter((f) => f.severity === 'fatal');
    if (fatal.length) {
      fatalCases++;
      assert.strictEqual(r.trust.impedanceDerived, false,
        `${label}: fatal ${fatal.map((f) => f.rule).join(',')} but still trusted`);
    }
    if (r.trust.impedanceDerived) {
      trustedCases++;
      assert.strictEqual(fatal.length, 0, `${label}: trusted with a fatal flag`);
    }
    // For a physically sensible subject with an impedance, the two are equivalent.
    if (isValidSubject(input) && input.impedanceOhm > 0) {
      assert.strictEqual(r.trust.impedanceDerived, fatal.length === 0,
        `${label}: trust and the fatal flags disagree`);
      assert.strictEqual(r.unreliable, !r.trust.impedanceDerived, `${label}: unreliable disagrees with trust`);
    }
  });
  assert.ok(n > 5000, `the sweep only covered ${n} points`);
  assert.ok(fatalCases > 100, `only ${fatalCases} fatal cases; the sweep proves nothing`);
  assert.ok(trustedCases > 100, `only ${trustedCases} trusted cases; the sweep proves nothing`);
});

// Prevents the headline tile pointing at an impedance number the code has just
// disowned, and prevents it pointing at a key that does not exist.
test('INT-TRUST-18  bodyFatRecommendedKey follows trust exactly and always names a value that exists', async () => {
  let impedanceAnchored = 0, bmiAnchored = 0;
  sweep((input, r, label) => {
    const key = r.values.bodyFatRecommendedKey;
    if (key === undefined) {
      // Only the degenerate T1 subjects get no recommendation at all.
      assert.ok(!isValidSubject(input), `${label}: valid subject with no recommended key`);
      return;
    }
    assert.ok(key in r.values, `${label}: recommended key ${key} is not in values`);
    assert.strictEqual(typeof r.values[key], 'number', `${label}: ${key} is not a number`);
    const want = r.trust.impedanceDerived ? 'bodyFatPercent' : 'bodyFatPercentBmiAnchor';
    assert.strictEqual(key, want, `${label}: recommended ${key}, expected ${want}`);
    if (key === 'bodyFatPercent') impedanceAnchored++; else bmiAnchored++;
  });
  assert.ok(impedanceAnchored > 100, `only ${impedanceAnchored} impedance-anchored cases`);
  assert.ok(bmiAnchored > 100, `only ${bmiAnchored} BMI-anchored cases`);
});

// Prevents a warning being promoted to fatal (the app would hide a perfectly good
// panel) or a fatal being demoted to a warning (the app would headline a bad one).
test('INT-TRUST-19  T1 to T6 are always fatal, T7 to T11 are always warn, and warn-only results stay trusted', async () => {
  const seen = new Set();
  let fatalSeen = 0, warnSeen = 0, warnOnlyTrusted = 0;
  sweep((input, r, label) => {
    for (const f of r.flags) {
      seen.add(f.rule);
      assert.ok(FATAL_RULES.has(f.rule) || WARN_RULES.has(f.rule), `${label}: unknown rule ${f.rule}`);
      assert.strictEqual(f.severity, FATAL_RULES.has(f.rule) ? 'fatal' : 'warn',
        `${label}: ${f.rule} had severity ${f.severity}`);
      assert.strictEqual(typeof f.message, 'string');
      assert.ok(f.message.trim().length > 20, `${label}: ${f.rule} message too short`);
      assert.ok(f.message.trim().endsWith('.'), `${label}: ${f.rule} message is not a sentence`);
      if (f.severity === 'fatal') fatalSeen++; else warnSeen++;
    }
    if (isValidSubject(input) && input.impedanceOhm > 0 && r.flags.length
        && r.flags.every((f) => f.severity === 'warn')) {
      warnOnlyTrusted++;
      assert.strictEqual(r.trust.impedanceDerived, true,
        `${label}: warnings alone cleared trust`);
    }
  });
  assert.ok(fatalSeen > 100 && warnSeen > 100, `fatal ${fatalSeen}, warn ${warnSeen}`);
  assert.ok(warnOnlyTrusted > 20, `only ${warnOnlyTrusted} warn-only cases`);
  // Every documented rule is reachable from real inputs.
  for (const rule of [...FATAL_RULES, ...WARN_RULES]) {
    assert.ok(seen.has(rule), `rule ${rule} never fired anywhere on the grid`);
  }
});

// Prevents an off-by-one at the edge of the physically-possible impedance band,
// which would either reject a legitimate 150-ohm reading or accept a 149-ohm one.
test('INT-TRUST-20  the T2 band edges are inclusive at 150 and 1200 ohm', async () => {
  const subject = { weightKg: 80, heightCm: 175, age: 35, sex: 'male' };
  const t2 = (z) => BIA.estimate(Object.assign({}, subject, { impedanceOhm: z }))
    .flags.filter((f) => f.rule === 'T2');

  assert.strictEqual(t2(149.9).length, 1, '149.9 ohm should be out of band');
  assert.strictEqual(t2(149.9)[0].severity, 'fatal');
  assert.strictEqual(t2(150).length, 0, '150 ohm should be inside the band');
  assert.strictEqual(t2(1200).length, 0, '1200 ohm should be inside the band');
  assert.strictEqual(t2(1200.1).length, 1, '1200.1 ohm should be out of band');
  assert.strictEqual(t2(1200.1)[0].severity, 'fatal');

  // Just inside the fatal band, the softer engineering heuristic still speaks up.
  const at150 = BIA.estimate(Object.assign({}, subject, { impedanceOhm: 150 }));
  assert.ok(at150.flags.some((f) => f.rule === 'T9' && f.severity === 'warn'),
    JSON.stringify(at150.flags));
});

// Prevents the app having to guess which panel it is looking at. The shape is
// decided by whether an impedance arrived at all, NOT by whether it was trusted:
// a rejected impedance still fills all 24 slots.
test('INT-TRUST-21  the derived panel is 9 keys when no impedance arrived and 24 whenever one did', async () => {
  let nine = 0, twentyFour = 0, rejectedButFull = 0;
  sweep((input, r, label) => {
    if (!isValidSubject(input)) return;
    const keys = derivedKeysOf(r);
    if (input.impedanceOhm > 0) {
      twentyFour++;
      assert.strictEqual(keys.length, 24, `${label}: ${keys.length} derived keys`);
      assert.deepStrictEqual(keys.slice().sort(), ALL_DERIVED_KEYS.slice().sort(), label);
      if (!r.trust.impedanceDerived) rejectedButFull++;
    } else {
      nine++;
      assert.strictEqual(keys.length, 9, `${label}: ${keys.length} derived keys`);
      assert.deepStrictEqual(keys.slice().sort(), H.IMPEDANCE_FREE_KEYS.slice().sort(), label);
      assert.strictEqual(r.trust.impedanceDerived, false, label);
      assert.strictEqual(r.trust.impedanceFree, true, label);
    }
  });
  assert.ok(nine > 50 && twentyFour > 500, `nine ${nine}, twentyFour ${twentyFour}`);
  assert.ok(rejectedButFull > 50, `only ${rejectedButFull} rejected-but-full panels`);
});

// Prevents the BMI fallback quietly moving when the impedance is thrown away. The
// user must see the same "from BMI" figure whether or not the electrodes worked,
// otherwise the fallback looks like it was contaminated by the bad reading.
test('INT-TRUST-22  rejecting the impedance moves the anchor to BMI without changing the BMI figure', async () => {
  const subject = { weightKg: H.EXPECTED.weightKg, heightCm: 180, age: 39, sex: 'male' };
  const good = BIA.estimate(Object.assign({}, subject, { impedanceOhm: H.EXPECTED.impedanceOhm }));
  const bad = BIA.estimate(Object.assign({}, subject, { impedanceOhm: 140 }));

  assert.strictEqual(good.trust.impedanceDerived, true);
  assert.strictEqual(good.values.bodyFatRecommendedKey, 'bodyFatPercent');
  assert.strictEqual(good.values.bodyFatPercent, 36);

  assert.strictEqual(bad.trust.impedanceDerived, false);
  assert.strictEqual(bad.values.bodyFatRecommendedKey, 'bodyFatPercentBmiAnchor');
  assert.ok(bad.flags.some((f) => f.rule === 'T2' && f.severity === 'fatal'),
    JSON.stringify(bad.flags));

  // The anchor is impedance-free by construction, so it must be bit-identical.
  assert.strictEqual(good.values.bodyFatPercentBmiAnchor, 29);
  assert.strictEqual(bad.values.bodyFatPercentBmiAnchor, good.values.bodyFatPercentBmiAnchor);
  assert.strictEqual(bad.values.bmi, good.values.bmi);
  assert.strictEqual(bad.values.bmrKcal, good.values.bmrKcal);
  // The impedance figure is still computed; it is just no longer the one to show.
  assert.notStrictEqual(bad.values.bodyFatPercent, bad.values.bodyFatPercentBmiAnchor);
});

// Prevents BMI, BMR and the weight targets being suppressed by an electrode
// problem. impedanceFree is the app's licence to draw the top half of the panel,
// and it must depend only on weight, height and age.
test('INT-TRUST-23  trust.impedanceFree depends only on weight, height and age, never on the impedance', async () => {
  let ok = 0, notOk = 0;
  sweep((input, r, label) => {
    const want = isValidSubject(input);
    assert.strictEqual(r.trust.impedanceFree, want,
      `${label}: impedanceFree was ${r.trust.impedanceFree}`);
    if (want) ok++; else notOk++;
    if (!want) {
      assert.strictEqual(r.trust.impedanceDerived, false, `${label}: derived trust without free trust`);
      assert.ok(r.flags.some((f) => f.rule === 'T1' && f.severity === 'fatal'), label);
    }
  });
  assert.ok(ok > 500 && notOk > 500, `ok ${ok}, notOk ${notOk}`);
});

// Prevents: the most dangerous confusion in this payload — a host treating a
// short `derived` as "untrustworthy" and a full one as "fine". A REJECTED
// impedance still yields all twenty-four values; they are simply wrong. Only an
// ABSENT impedance shrinks the set. A UI that conflates the two will present a
// rejected body fat of 62.3% as a measurement.
test('INT-TRUST-24  key count signals presence, trust signals believability, and they are independent', async () => {
  const BIA = require(require('path').join(H.ROOT, 'bia.js'));
  // One coherent body throughout, so only the impedance varies between cases.
  const count = (z) => {
    const r = BIA.estimate({ weightKg: 75, impedanceOhm: z, heightCm: 180, age: 39, sex: 'male' });
    const keys = Object.keys(r.values)
      .filter((k) => k !== 'weightKg' && k !== 'impedanceOhm' && typeof r.values[k] !== 'object');
    return { keys: keys.length, trusted: r.trust.impedanceDerived };
  };

  const good = count(520);
  assert.strictEqual(good.keys, 24);
  assert.strictEqual(good.trusted, true, 'a plausible impedance is believed');

  const rejected = count(3115.6);                 // the value the real scale sent
  assert.strictEqual(rejected.keys, 24, 'a REJECTED impedance still produces every value');
  assert.strictEqual(rejected.trusted, false, 'but they are marked not believable');

  const absent = count(0);
  assert.strictEqual(absent.keys, 9, 'only an ABSENT impedance shrinks the set');
  assert.strictEqual(absent.trusted, false);

  assert.strictEqual(rejected.keys, good.keys,
    'the count cannot distinguish a good reading from a rejected one; only trust can');
  assert.notStrictEqual(rejected.trusted, good.trusted,
    'trust is the only signal that separates them');
});

// Prevents: the crash a host takes on `result.derived.bmi` when the scale
// reports a weight that is not a person's — a bag set down, a pet, someone
// stepping off mid-reading. A real session produced 18.45 kg with 1313.4 ohm,
// and `derived`, `units`, `confidence` and `omitted` all came back EMPTY. This
// is the only shape where even BMI is absent, and `trust.impedanceFree` is the
// only signal that says so before a key lookup throws.
test('INT-TRUST-25  a weight that is not a person produces no derived values at all', async () => {
  const BIA = require(require('path').join(H.ROOT, 'bia.js'));

  for (const [weight, what] of [[18.45, 'the weight the real scale reported'],
                                [10, 'an object'],
                                [0, 'an empty scale']]) {
    const r = BIA.estimate({ weightKg: weight, impedanceOhm: 1313.4, heightCm: 180, age: 39, sex: 'male' });
    const keys = Object.keys(r.values)
      .filter((k) => k !== 'weightKg' && k !== 'impedanceOhm' && typeof r.values[k] !== 'object');

    assert.strictEqual(keys.length, 0, `${what}: nothing is computed`);
    assert.strictEqual(r.trust.impedanceFree, false,
      `${what}: even the impedance-free figures are withheld, because the weight is not a person's`);
    assert.strictEqual(r.trust.impedanceDerived, false);
    assert.ok(r.flags.some((f) => f.rule === 'T1' && f.severity === 'fatal'),
      `${what}: T1 says why`);
    assert.ok(r.flags[0].message.length > 20,
      'and says it in a sentence a host can show the user verbatim');
  }
});

// Prevents: a host reading `derived.bmi` on the empty shape. The four shapes
// this payload can take are the whole contract for defensive rendering.
test('INT-TRUST-26  the four payload shapes are distinguishable before any key lookup', async () => {
  const BIA = require(require('path').join(H.ROOT, 'bia.js'));
  const shape = (w, z) => {
    const r = BIA.estimate({ weightKg: w, impedanceOhm: z, heightCm: 180, age: 39, sex: 'male' });
    const n = Object.keys(r.values)
      .filter((k) => k !== 'weightKg' && k !== 'impedanceOhm' && typeof r.values[k] !== 'object').length;
    return { n, free: r.trust.impedanceFree, derived: r.trust.impedanceDerived };
  };

  assert.deepStrictEqual(shape(75, 520),     { n: 24, free: true,  derived: true  }, 'person, good impedance');
  assert.deepStrictEqual(shape(75, 3115.6),  { n: 24, free: true,  derived: false }, 'person, rejected impedance');
  assert.deepStrictEqual(shape(75, 0),       { n: 9,  free: true,  derived: false }, 'person, no impedance');
  assert.deepStrictEqual(shape(18.45, 1313.4), { n: 0, free: false, derived: false }, 'not a person');

  // The two flags together identify the shape without touching `derived`.
  // free=false  -> nothing at all
  // free=true, derived=false, and a key check for presence -> 9 or 24
  assert.notStrictEqual(shape(75, 0).n, shape(18.45, 1313.4).n,
    'a missing impedance and a non-person are different outcomes and must not be conflated');
});

// Prevents: the conclusion that the maths here is wrong because it disagrees
// with the scale's own app. It does not disagree about anything the impedance
// actually determines. Given the SAME impedance, water and fat-free mass and
// body fat reproduce the app's figures to rounding, because both sides use
// Sun 2003 and the Wang 1999 hydration constant. Only three values differ, and
// each is a choice of convention. vendorMatch reports those three the way the
// scale does, so a host can show figures identical to the device.
test('INT-TRUST-27  vendorMatch reproduces the scale app, from a real reading', async () => {
  const BIA = require(require('path').join(H.ROOT, 'bia.js'));

  // The reading the Dr Trust app reported: 94.25 kg, male, 39, 5ft 11in.
  // 582 ohm is back-solved from its own total body water through Sun 2003.
  const r = BIA.estimate({ weightKg: 94.25, impedanceOhm: 582, heightCm: 180.34, age: 39, sex: 'male' });
  assert.strictEqual(r.trust.impedanceDerived, true, 'a plausible impedance is trusted');

  const close = (ours, theirs, tol, what) =>
    assert.ok(Math.abs(ours - theirs) <= tol,
      `${what}: ours ${ours}, the app ${theirs}, differ by ${Math.abs(ours - theirs).toFixed(2)} (tolerance ${tol})`);

  // What the impedance genuinely determines — these must already agree.
  close(r.values.bodyFatPercent, 37.80, 0.2, 'body fat percent');
  close(r.values.fatMassKg, 35.63, 0.2, 'fat mass');
  close(r.values.bodyWaterLitres, 42.88, 0.2, 'total body water');
  close(r.values.bodyWaterPercent, 45.50, 0.2, 'body water percent');
  close(r.values.fatFreeMassKg, 58.62, 0.2, 'fat-free mass');
  close(r.values.bmi, 29.10, 0.2, 'BMI');

  // The three that differ by convention, reported the scale's way.
  const vm = r.vendorMatch;
  assert.ok(vm, 'vendorMatch is present when the impedance is usable');
  // The three conventions that held across BOTH observed sessions.
  close(vm.bmrKcal, 1634, 3, 'vendor BMR (Katch-McArdle)');
  close(vm.boneMassKg, 3.90, 0.05, 'vendor bone mass');
  close(vm.muscleMassKg, 54.66, 0.2, 'vendor muscle mass');

  // And ours is still the published one, not quietly replaced.
  assert.notStrictEqual(r.values.bmrKcal, vm.bmrKcal, 'our BMR is still Mifflin-St Jeor');
  for (const k of ['bmrBasis', 'boneBasis', 'muscleBasis']) {
    assert.ok(typeof vm[k] === 'string' && vm[k].length > 5, `${k} says which convention it is`);
  }

  // Two fits from one reading were disproven by a second. They must be named as
  // unresolved rather than shipped as a number that looks authoritative.
  assert.ok(vm.unresolved, 'what two readings could not settle is stated');
  assert.ok(!('proteinMassKg' in vm), 'the disproven protein fit was withdrawn');
  assert.ok(!('skeletalMuscleMassKg' in vm), 'and the disproven skeletal muscle fit');
  for (const k of ['proteinMassKg', 'skeletalMuscleMassKg']) {
    assert.ok(vm.unresolved[k], `${k} is listed as unresolved`);
  }
});

// Prevents: shipping a fit that a second observation already contradicts. Two
// real sessions eighteen minutes apart give protein/fat-free of 0.21153 then
// 0.20780, and skeletal-muscle/fat-free of 0.6005 then 0.5873 — both moved far
// beyond rounding, so neither is a fixed fraction of anything.
test('INT-TRUST-29  the two disproven vendor fits stay withdrawn', async () => {
  const BIA = require(require('path').join(H.ROOT, 'bia.js'));
  const a = BIA.estimate({ weightKg: 94.25, impedanceOhm: 582, heightCm: 180.34, age: 39, sex: 'male' });
  const b = BIA.estimate({ weightKg: 96.40, impedanceOhm: 595, heightCm: 180.34, age: 39, sex: 'male' });

  // The conventions that DID hold, checked on both.
  for (const [r, bone, muscle, bmr] of [[a, 3.90, 54.66, 1634], [b, 3.90, 54.27, 1627]]) {
    assert.ok(Math.abs(r.vendorMatch.boneMassKg - bone) <= 0.05);
    assert.ok(Math.abs(r.vendorMatch.muscleMassKg - muscle) <= 0.25);
    assert.ok(Math.abs(r.vendorMatch.bmrKcal - bmr) <= 4);
  }
  // And the ones that did not are absent from both.
  for (const r of [a, b]) {
    assert.ok(!('proteinMassKg' in r.vendorMatch));
    assert.ok(!('skeletalMuscleMassKg' in r.vendorMatch));
  }
});

// Prevents: a host reading vendorMatch off an untrustworthy reading and showing
// figures that look like the scale's but are built on a rejected impedance.
test('INT-TRUST-28  vendorMatch is withheld when the impedance is not usable', async () => {
  const BIA = require(require('path').join(H.ROOT, 'bia.js'));
  const bad = BIA.estimate({ weightKg: 98.2, impedanceOhm: 1978.7, heightCm: 180, age: 39, sex: 'male' });
  assert.strictEqual(bad.trust.impedanceDerived, false, 'the reading was rejected');
  assert.ok(!bad.vendorMatch, 'so there is nothing to compare against the scale');

  const none = BIA.estimate({ weightKg: 98.2, impedanceOhm: 0, heightCm: 180, age: 39, sex: 'male' });
  assert.ok(!none.vendorMatch, 'and none at all without an impedance');
});
