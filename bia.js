/*
 * bia.js — body composition from the two numbers a BIA scale actually sends.
 *
 * The scale transmits weight and one whole-body impedance. Everything else a
 * consumer app displays is computed. This file computes it, and is explicit
 * about how much each number is worth.
 *
 * ONE IMPEDANCE PRIMITIVE
 * -----------------------
 * Total body water (Sun 2003) is the only impedance equation here. Fat-free
 * mass, fat mass, body fat percent, muscle and protein are algebraic
 * consequences of it. That is deliberate: chaining several independently fitted
 * regressions multiplies transcription risk and creates an illusion of
 * corroboration. It follows that TBW, FFM, FM, body fat, muscle and protein
 * carry exactly one bit of impedance information between them, so no check that
 * compares two of them to each other has any diagnostic power.
 *
 * Kyle 2001 is the best adult fat-free-mass equation in the literature, but it
 * requires REACTANCE, which this hardware does not transmit. It is deliberately
 * not implemented; synthesising a reactance moves the answer by about five
 * percentage points of body fat, which is worse than not answering.
 *
 * Sources, checked coefficient by coefficient:
 *   Total body water   Sun SS et al. 2003, Am J Clin Nutr 77:331-40
 *   Hydration of FFM   0.732, Wang Z et al. 1999, Am J Clin Nutr 69:833-41
 *   Body fat from BMI  Deurenberg P et al. 1991, Br J Nutr 65:105-14
 *   Skeletal muscle    Janssen I et al. 2000, J Appl Physiol 89:465-71
 *   Basal metabolism   Mifflin MD, St Jeor ST et al. 1990, Am J Clin Nutr 51:241-7
 *                      Roza & Shizgal 1984; Harris & Benedict 1919; Schofield 1985
 *   Ideal weight       Devine 1974; Robinson 1983; Miller 1983; Hamwi 1964
 *   Bone mass          NOT literature. Reverse-engineered vendor convention, via openScale.
 *
 * THE FOOT-TO-FOOT PROBLEM
 * ------------------------
 * These equations were fitted on hand-to-foot resistance. A platform scale
 * measures foot to foot, which reads roughly 100 to 200 ohm lower on the same
 * person, inflating lean mass and collapsing the fat estimate. Two structurally
 * independent checks catch it, and the result is marked untrustworthy rather
 * than presented quietly. No default correction is shipped, because the
 * conversion ratio is subject-specific and does not survive checking. The
 * impedanceOffsetOhm option exists for someone who has a paired DXA or
 * hand-to-foot reading to calibrate against, and only for them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BIA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const round = (v, d) => { const p = Math.pow(10, d === undefined ? 1 : d); return Math.round(v * p) / p; };
  const HYDRATION_OF_FFM = 0.732;

  // Plausible adult ranges. Used to flag, never to silently clip.
  const RANGES = {
    bodyFatPercent:        { male: [5, 50],    female: [12, 55] },
    bodyWaterPercent:      { male: [45, 65],   female: [40, 60] },
    fatFreeMassIndex:      { male: [16, 25],   female: [13, 22] },
    muscleMassPercent:     { male: [60, 90],   female: [55, 85] },
    skeletalMuscleMassKg:  { male: [20, 45],   female: [13, 32] },
    skeletalMusclePercent: { male: [30, 48],   female: [24, 42] },
    skeletalMuscleIndex:   { male: [8.5, 13],  female: [6, 11] },
    boneMassKg:            { male: [2.3, 4.5], female: [1.6, 3.6] },
    proteinPercent:        { male: [14, 22],   female: [12, 20] },
    bmrKcal:               { male: [1000, 3500], female: [800, 3000] },
  };

  // Boundaries are [lo, hi). Comparing against 24.9 misclassifies a BMI of 24.95.
  const WHO_BANDS = [
    [0, 16, 'severe thinness'], [16, 17, 'moderate thinness'], [17, 18.5, 'mild thinness'],
    [18.5, 25, 'normal'], [25, 30, 'overweight'], [30, 35, 'obese class I'],
    [35, 40, 'obese class II'], [40, Infinity, 'obese class III'],
  ];
  // Asia-Pacific cut-offs. Widely used and correct as listed, but the common
  // attribution to a 2004 WHO consultation has been challenged, so they are
  // named for the region rather than credited to WHO.
  const ASIA_PACIFIC_BANDS = [
    [0, 18.5, 'underweight'], [18.5, 23, 'normal'], [23, 25, 'overweight'],
    [25, 30, 'obese class I'], [30, Infinity, 'obese class II'],
  ];
  const band = (bands, v) => { for (const [lo, hi, label] of bands) if (v >= lo && v < hi) return label; return 'unknown'; };

  function schofieldBmr(W, A, male) {          // Schofield 1985, the FAO/WHO/UNU standard
    if (male) {
      if (A < 3) return 59.512 * W - 30.4;
      if (A < 10) return 22.706 * W + 504.3;
      if (A < 18) return 17.686 * W + 658.2;
      if (A < 30) return 15.057 * W + 692.2;
      if (A < 60) return 11.472 * W + 873.1;
      return 11.711 * W + 587.7;
    }
    if (A < 3) return 58.317 * W - 31.1;
    if (A < 10) return 20.315 * W + 485.9;
    if (A < 18) return 13.384 * W + 692.6;
    if (A < 30) return 14.818 * W + 486.6;
    if (A < 60) return 8.126 * W + 845.6;
    return 9.082 * W + 658.5;
  }

  /* Metrics on real consumer panels that are deliberately not computed. Printing
     an invented number is worse than printing nothing, so the reason ships too. */
  const OMITTED = {
    visceralFatRating: 'No peer-reviewed formula exists, and vendor implementations differ by about a factor of two. '
      + 'A foot-to-foot current path runs leg to pelvis to leg and largely bypasses the abdominal viscera, so every '
      + 'vendor visceral fat number is a function of weight, height, age and sex only. It contains no impedance information.',
    metabolicAgeYears: 'Both published conventions failed checking. The body-fat-band method is unreproducible from its '
      + 'source, and the BMI-regression method saturates its own clamps across the whole realistic input range, so it '
      + 'returns a constant while looking like a measurement.',
    bodyScore: 'Composite index with no stable definition and a disputed transcription.',
    subcutaneousFatPercent: 'The convention circulating in scale SDKs has no source, and its own published worked '
      + 'examples are arithmetically inconsistent.',
    bodyWaterPercentOfFfm: 'Identically 73.2 by construction, because fat-free mass is derived from body water. '
      + 'It is a constant wearing a measurement’s clothes.',
    fatFreeMassKyle2001: 'The lowest-error adult equation available, but it requires reactance, which this scale does '
      + 'not transmit. Never implement it with a synthesised reactance.',
  };

  function estimate(p, options) {
    const o = options || {};
    const out = {
      inputs: Object.assign({}, p), values: {}, meta: {}, warnings: [], flags: [],
      trust: { impedanceFree: false, impedanceDerived: false }, omitted: {},
    };
    const put = (key, value, unit, confidence, note) => {
      out.values[key] = value;
      out.meta[key] = { unit: unit || '', confidence, note: note || '' };
    };
    const flag = (id, severity, message) => {
      out.flags.push({ rule: id, severity, message });
      if (severity === 'fatal') out.warnings.push(message);
    };

    const W = Number(p.weightKg);
    const heightCm = Number(p.heightCm), age = Number(p.age);
    const male = String(p.sex).toLowerCase() === 'male';
    const S = male ? 1 : 0;
    const sexKey = male ? 'male' : 'female';
    const Zraw = Number(p.impedanceOhm);
    const Z = Zraw > 0 ? Zraw + (o.impedanceOffsetOhm || 0) : 0;

    // --- T1, degenerate inputs ---
    if (!(W > 0)) { flag('T1', 'fatal', 'No weight, so nothing can be computed.'); return out; }
    put('weightKg', round(W, 2), 'kg', 'measured', 'sent by the scale');
    if (Z > 0) put('impedanceOhm', round(Zraw, 1), 'Ω', 'measured',
      o.impedanceOffsetOhm ? `raw reading; ${o.impedanceOffsetOhm} Ω calibration offset applied` : 'sent by the scale');

    if (W < 20) {
      flag('T1', 'fatal', `Weight is ${round(W, 2)} kg, too low to be a person standing on the scale. Nothing else computed.`);
      out.skipped = true; return out;
    }
    if (!(heightCm > 0) || !(age > 0) || heightCm < 90 || heightCm > 250 || age < 5 || age > 120) {
      flag('T1', 'fatal', 'Height and age are needed, and must be realistic. Fill in the profile.');
      return out;
    }

    const Hm = heightCm / 100;
    const bmi = W / (Hm * Hm);
    out.trust.impedanceFree = true;

    // --- A. headline, no impedance anywhere below this line until section C ---
    put('bmi', round(bmi, 1), 'kg/m²', 'derived-literature', 'weight over height squared; exact arithmetic, no fitting error');
    put('bmiCategoryWho', band(WHO_BANDS, bmi), '', 'derived-literature', 'WHO international bands');
    put('bmiCategoryAsiaPacific', band(ASIA_PACIFIC_BANDS, bmi), '', 'derived-literature',
      'Asia-Pacific cut-offs; the same body gets a different verdict from the international bands');

    // --- B. body fat the impedance-free way, always present ---
    const deurenberg = age < 16
      ? 1.51 * bmi - 0.70 * age - 3.6 * S + 1.4
      : 1.20 * bmi + 0.23 * age - 10.8 * S - 5.4;
    put('bodyFatPercentBmiAnchor', round(clamp(deurenberg, 0, 75), 1), '%', 'derived-literature',
      'Deurenberg 1991, standard error 4.1 points; uses no impedance at all, which is the point of it');

    // --- E. metabolism, impedance-free primary ---
    const mifflin = 10 * W + 6.25 * heightCm - 5 * age + (male ? 5 : -161);
    put('bmrKcal', Math.round(mifflin), 'kcal/day', 'derived-literature',
      'Mifflin-St Jeor 1990; primary because it never touches impedance');
    const alternates = {
      mifflinStJeor: Math.round(mifflin),
      harrisBenedictRevised: Math.round(male
        ? 88.362 + 13.397 * W + 4.799 * heightCm - 5.677 * age
        : 447.593 + 9.247 * W + 3.098 * heightCm - 4.330 * age),
      schofield: Math.round(schofieldBmr(W, age, male)),
    };

    // --- F. weight targets ---
    const lo = 18.5 * Hm * Hm, hi = 25.0 * Hm * Hm;
    put('healthyWeightRangeKg', `${round(lo, 1)} – ${round(hi, 1)}`, 'kg', 'derived-literature', 'the weight giving a BMI of 18.5 to 25 at your height');
    put('weightAboveHealthyRangeKg', round(Math.max(0, W - hi), 1), 'kg', 'derived-literature', '');
    const x = heightCm / 2.54 - 60;
    const ibw = [male ? 50 + 2.30 * x : 45.5 + 2.30 * x, male ? 52 + 1.90 * x : 49.0 + 1.70 * x,
                 male ? 56.2 + 1.41 * x : 53.1 + 1.36 * x, male ? 48 + 2.70 * x : 45.5 + 2.20 * x];
    put('idealWeightRangeKg', `${round(Math.min.apply(null, ibw), 1)} – ${round(Math.max.apply(null, ibw), 1)}`, 'kg',
      'derived-literature', 'spread of Devine, Robinson, Miller and Hamwi; none was designed to define a healthy weight, so read the spread rather than a single figure');

    if (age < 18 || age > 90) flag('T11', 'warn', `Age ${age} is outside the range these adult equations were fitted on.`);

    // --- C. the impedance block ---
    if (!(Z > 0)) {
      out.noImpedance = true;
      out.warnings.push('No impedance was measured, so body composition is unavailable. Stand with bare feet on the metal pads.');
      Object.assign(out.omitted, OMITTED);
      out.values.bodyFatRecommendedKey = 'bodyFatPercentBmiAnchor';
      Object.assign(out.values, { bmrAlternatesKcal: alternates });
      return out;
    }
    out.trust.impedanceDerived = true;
    if (Z < 150 || Z > 1200) {
      flag('T2', 'fatal', `Impedance of ${round(Z, 1)} Ω is outside the physically possible 150 to 1200 Ω band.`);
      out.trust.impedanceDerived = false;
    } else if (Z < 250 || Z > 700) {
      flag('T9', 'warn', `Impedance of ${round(Z, 1)} Ω is outside the 250 to 700 Ω band typical of foot-to-foot scales. This band is an engineering heuristic, not a citation.`);
    }

    const h2r = (heightCm * heightCm) / Z;
    const tbwL = male ? 1.203 + 0.449 * h2r + 0.176 * W : 3.747 + 0.450 * h2r + 0.113 * W;
    const ffm = tbwL / HYDRATION_OF_FFM;
    const fatPct = ((W - ffm) / W) * 100;
    const fatKg = W - ffm;
    const ffmi = ffm / (Hm * Hm);
    const smm = 0.401 * h2r + 3.825 * S - 0.071 * age + 5.102;

    // Bone mass: reverse-engineered vendor convention, not literature. BIA cannot
    // sense bone mineral. Two discontinuities in the vendor code are stripped,
    // because both are artefacts and the second makes the metric non-monotone.
    const lbmCoef = 9.058 * Hm * Hm + 0.32 * W + 12.226 - 0.0068 * Z - 0.0542 * age;
    const boneKg = clamp(0.05158 * lbmCoef - (male ? 0.18016894 : 0.245691014), 0.5, 8);
    const muscleKg = ffm - boneKg;
    const proteinKg = ffm - tbwL - boneKg;

    put('bodyWaterLitres', round(tbwL, 2), 'L', 'derived-literature', 'Sun 2003, the single impedance equation used here');
    put('bodyWaterPercent', round((tbwL / W) * 100, 1), '%', 'derived-literature', '');
    put('fatFreeMassKg', round(ffm, 2), 'kg', 'derived-literature', 'body water divided by 0.732');
    put('fatFreeMassIndex', round(ffmi, 1), 'kg/m²', 'derived-literature', 'lean mass for your height; the most useful sanity check on the panel');
    put('bodyFatPercent', round(fatPct, 1), '%', 'derived-literature', 'from fat-free mass, by difference');
    put('fatMassKg', round(fatKg, 2), 'kg', 'derived-literature', 'weight minus fat-free mass, an identity');
    put('muscleMassKg', round(muscleKg, 2), 'kg', 'derived-vendor-convention', 'lean soft tissue, what most scales label muscle mass');
    put('muscleMassPercent', round((muscleKg / W) * 100, 1), '%', 'derived-vendor-convention', '');
    put('skeletalMuscleMassKg', round(smm, 2), 'kg', 'derived-literature', 'Janssen 2000; a different and much smaller quantity than muscle mass above');
    put('skeletalMusclePercent', round((smm / W) * 100, 1), '%', 'derived-literature', '');
    put('skeletalMuscleIndex', round(smm / (Hm * Hm), 1), 'kg/m²', 'derived-literature', '');
    put('boneMassKg', round(boneKg, 2), 'kg', 'derived-vendor-convention', 'vendor convention; impedance cannot sense bone mineral');
    put('proteinMassKg', round(proteinKg, 2), 'kg', 'derived-vendor-convention', 'lean mass minus water minus bone; a fixed multiple of body water, so it is not independent evidence');
    put('proteinPercent', round((proteinKg / W) * 100, 1), '%', 'derived-vendor-convention', '');

    alternates.katchMcArdle = Math.round(370 + 21.6 * ffm);
    put('bmrAlternatesKcal', alternates, 'kcal/day', 'derived-literature',
      'Katch-McArdle is the best of these when lean mass is real, and therefore the worst on this hardware');

    // --- checks with actual power ---
    const gap = Math.abs(fatPct - deurenberg);
    // Combined standard error in quadrature, from this subject's own weight.
    const ffmSee = (3.8 / HYDRATION_OF_FFM) / W * 100;
    const combinedSee = Math.sqrt(4.1 * 4.1 + ffmSee * ffmSee);
    put('bodyFatGapPoints', round(gap, 1), 'points', 'derived-literature',
      `difference between the impedance and BMI methods; one standard error is ${round(combinedSee, 1)}`);
    out.crossCheck = { impedanceBased: round(fatPct, 1), bmiBased: round(deurenberg, 1), gapPoints: round(gap, 1),
                       oneSigma: round(combinedSee, 1), twoSigma: round(2 * combinedSee, 1) };

    if (gap > 2 * combinedSee) {
      flag('T3', 'fatal', `Impedance gives ${round(fatPct, 1)}% body fat while the BMI method gives ${round(deurenberg, 1)}%. `
        + `A ${round(gap, 1)} point gap is beyond two standard errors, so the impedance figure is not usable.`);
      out.trust.impedanceDerived = false;
    } else if (gap > combinedSee) {
      flag('T8', 'warn', `The two body fat methods differ by ${round(gap, 1)} points, a little over one standard error.`);
    }
    const ffmiCeiling = male ? 25.0 : 22.0;
    if (ffmi > ffmiCeiling) {
      flag('T4', 'fatal', `Fat-free mass index of ${round(ffmi, 1)} exceeds the drug-free ceiling of about ${ffmiCeiling} for an adult ${sexKey}. `
        + 'This check uses no body fat equation at all, only lean mass and height.');
      out.trust.impedanceDerived = false;
    }
    const [bfLo, bfHi] = male ? [4, 60] : [10, 65];
    if (fatPct < bfLo || fatPct > bfHi) {
      flag('T5', 'fatal', `Body fat of ${round(fatPct, 1)}% is outside the survivable ${bfLo} to ${bfHi} for an adult ${sexKey}.`);
      out.trust.impedanceDerived = false;
    }
    const waterCeiling = male ? 65 : 60;
    if ((tbwL / W) * 100 > waterCeiling) {
      flag('T6', 'fatal', `Body water of ${round((tbwL / W) * 100, 1)}% exceeds ${waterCeiling}%, which a body with any fat at all cannot reach.`);
      out.trust.impedanceDerived = false;
    }
    if (Math.abs(alternates.katchMcArdle - mifflin) / mifflin > 0.15) {
      flag('T7', 'warn', `The lean-mass metabolic rate differs from Mifflin-St Jeor by more than 15%. This restates the lean mass error in calories; it is corroboration, not a second opinion.`);
    }
    for (const [key, byS] of Object.entries(RANGES)) {
      const v = out.values[key];
      if (typeof v !== 'number') continue;
      const [rlo, rhi] = byS[sexKey];
      if (v < rlo || v > rhi) flag('T10', 'warn', `${LABELS[key] || key} of ${v} is outside the plausible ${rlo} to ${rhi} for an adult ${sexKey}.`);
    }

    /*
     * What the scale's own app would say, from the same two numbers.
     *
     * Reverse-engineered from a real Dr Trust reading: 94.25 kg, 39, 180.34 cm,
     * male, its app reporting 37.80% fat, 42.88 kg water, 58.62 kg fat-free.
     * Its water and fat-free mass reproduce Sun 2003 and the Wang 1999
     * hydration constant exactly, which is what this code already uses — so the
     * two agree on the values that carry the impedance, to within rounding.
     *
     * Three differ, and each is a choice of convention rather than a mistake:
     *
     *   BMR              it uses Katch-McArdle off lean mass; this uses
     *                    Mifflin-St Jeor off weight, height and age.
     *   Skeletal muscle  it uses a flat 60% of fat-free mass; this uses
     *                    Janssen 2000, which is a fitted equation.
     *   Bone             a different fraction of fat-free mass. Both are
     *                    arbitrary, neither has clinical validation.
     *
     * These are reported ALONGSIDE, never instead. Katch-McArdle is a published
     * equation and legitimate; the other two are vendor conventions and are
     * labelled as such. A host that wants to show figures matching the scale's
     * own display can, without this file quietly becoming less rigorous.
     */
    if (out.trust.impedanceDerived) {
      const vendorBone = ffm * 0.0665;
      const vendorMuscle = ffm - vendorBone;
      out.vendorMatch = {
        note: "This scale's own app, as far as it has been reproduced from real "
            + 'readings. Provided so a host can show figures identical to the device. '
            + 'These are the vendor\u2019s conventions, not the published equations in '
            + '`values`, and never a substitute for them. Confirmed against two '
            + 'sessions; see `unresolved` for what two sessions could not settle.',

        // Everything the impedance genuinely determines. Both sides use Sun 2003
        // and the Wang 1999 hydration constant, so these already agree; they are
        // repeated here only so the block is a complete panel a UI can render.
        weightKg: round(W, 2),
        bodyFatPercent: round(fatPct, 1),
        fatMassKg: round(W - ffm, 2),
        bodyWaterLitres: round(tbwL, 2),
        bodyWaterPercent: round((tbwL / W) * 100, 1),
        fatFreeMassKg: round(ffm, 2),
        bmi: round(bmi, 1),

        // The values where the two conventions genuinely part company.
        bmrKcal: round(370 + 21.6 * ffm, 0),
        bmrBasis: 'Katch-McArdle, from lean mass. `values.bmrKcal` uses Mifflin-St Jeor.',
        boneMassKg: round(vendorBone, 2),
        boneBasis: '6.65% of fat-free mass. Arbitrary on both sides.',
        muscleMassKg: round(vendorMuscle, 2),
        muscleMassPercent: round((vendorMuscle / W) * 100, 1),
        muscleBasis: 'fat-free mass minus their bone figure.',
        idealWeightKg: round(22 * Hm * Hm, 1),
        idealWeightBasis: 'BMI 22 at this height, as a single figure rather than a range.',

        /*
         * Protein, from the four-compartment model rather than a fitted ratio.
         *
         * Fat-free mass is water plus protein plus mineral, so protein is what
         * is left once the other two are taken out. Using this block's OWN
         * water and bone figures keeps it internally consistent:
         *
         *   57.88 - 42.37 - 3.85 = 11.66 kg   against the app's 11.90, -2.0%
         *
         * This was previously listed as unresolved because a fixed fraction of
         * fat-free mass had been ruled out by two readings. That was the right
         * conclusion about the wrong hypothesis: it is not a ratio at all, it
         * is a remainder, and the ratio drifted precisely because water and
         * bone move differently from lean mass.
         *
         * The residual 2% is real. The app's own numbers close on 3.52 kg of
         * mineral while it reports 3.90 kg of bone — about 11% apart — so its
         * "bone mass" is not the mineral term in its own model. Which of the
         * two feeds its protein figure is not recoverable from three readings.
         */
        proteinMassKg: round(ffm - tbwL - vendorBone, 2),
        proteinBasis: 'fat-free mass minus water minus bone, the four-compartment '
                    + 'remainder. Reads about 2% low against the app, whose bone and '
                    + 'mineral terms differ by 11%.',

        /*
         * Fitted to one reading, then DISPROVEN by a second.
         *
         * Session A gave protein 12.40 kg on 58.62 kg of fat-free mass, and
         * skeletal muscle 35.20 kg. Session B, eighteen minutes later, gave
         * 12.10 kg on 58.23 kg, and 34.20 kg. Neither ratio held:
         *
         *   protein / fat-free          0.21153 -> 0.20780
         *   skeletal muscle / fat-free  0.6005  -> 0.5873
         *
         * Both moved far more than rounding allows, so neither is a fixed
         * fraction of fat-free mass, of weight, or of muscle mass. Two points
         * are enough to rule those out and not enough to say what is true, so
         * these are reported as unresolved rather than shipped as a number that
         * would look authoritative and be wrong.
         */
        /*
         * A third reading arrived and settled one of these two.
         *
         * Skeletal muscle over fat-free mass across three app readings:
         *
         *   58.62 -> 35.20   0.6005
         *   58.23 -> 34.20   0.5873
         *   57.97 -> 33.60   0.5796
         *
         * Monotonic and far outside rounding, so it is not a fixed fraction of
         * fat-free mass. Fitting the 0.58 that suits the newest reading would
         * be 3.4% wrong on the oldest. The implied slope, 2.46 kg of skeletal
         * muscle per kg of lean mass, is physically impossible, which says the
         * quantity is computed from impedance directly rather than derived from
         * anything in this block.
         */
        unresolved: {
          skeletalMuscleMassKg: 'Not a fixed fraction of fat-free mass, weight or muscle '
                              + 'mass: the ratio drifts monotonically across three readings '
                              + 'with an impossible implied slope, so it is computed from '
                              + 'impedance directly. `values.skeletalMuscleMassKg` uses '
                              + 'Janssen 2000, which is published and reads about 6 kg lower.',
        },

        /*
         * The app shows these; they cannot be recovered from one reading, and
         * `omitted` explains separately why this code does not compute them at
         * all. Both facts are true and neither replaces the other.
         */
        notRecovered: {
          visceralFatPercent: 'one equation, several unknowns',
          subcutaneousFatPercent: 'one equation, several unknowns',
          metabolicAgeYears: 'one equation, several unknowns',
          bodyScore: 'one equation, several unknowns',
        },

        /*
         * Worth knowing before trusting the vendor column: the app's own figures
         * do not add up. Water plus protein plus bone came to 59.18 kg against a
         * stated fat-free mass of 58.62 kg, so its protein and bone are computed
         * independently rather than as parts of one partition.
         */
        selfConsistency: 'The app\u2019s water, protein and bone sum to about 0.56 kg more '
                       + 'than its own fat-free mass, so those three are independent '
                       + 'conventions rather than a partition of it.',
      };
    }

    out.values.bodyFatRecommendedKey = out.trust.impedanceDerived ? 'bodyFatPercent' : 'bodyFatPercentBmiAnchor';
    out.unreliable = !out.trust.impedanceDerived;
    Object.assign(out.omitted, OMITTED);
    if (out.unreliable) {
      out.warnings.push('The impedance-derived half of this panel is not trustworthy in absolute terms. A gap this wide means the '
        + 'reading is foot-to-foot, while these equations were fitted on hand-to-foot resistance that runs 100 to 200 Ω higher. '
        + 'The direction and size of change over time, measured the same way each morning, is the part worth trusting.');
    }
    out.warnings.push('The scale sent two numbers, your weight and one impedance value. Everything else was estimated from them.');
    return out;
  }

  const LABELS = {
    weightKg: 'Weight', impedanceOhm: 'Impedance', bmi: 'BMI',
    bmiCategoryWho: 'BMI category, international', bmiCategoryAsiaPacific: 'BMI category, Asia-Pacific',
    bodyFatPercent: 'Body fat, from impedance', bodyFatPercentBmiAnchor: 'Body fat, from BMI',
    bodyFatGapPoints: 'Disagreement between the two', fatMassKg: 'Fat mass',
    fatFreeMassKg: 'Fat-free mass', fatFreeMassIndex: 'Fat-free mass index',
    muscleMassKg: 'Muscle mass, lean soft tissue', muscleMassPercent: 'Muscle mass',
    skeletalMuscleMassKg: 'Skeletal muscle', skeletalMusclePercent: 'Skeletal muscle',
    skeletalMuscleIndex: 'Skeletal muscle index',
    bodyWaterLitres: 'Body water', bodyWaterPercent: 'Body water',
    boneMassKg: 'Bone mass', proteinMassKg: 'Protein', proteinPercent: 'Protein',
    bmrKcal: 'Basal metabolic rate', healthyWeightRangeKg: 'Healthy weight range',
    weightAboveHealthyRangeKg: 'Above the healthy range', idealWeightRangeKg: 'Ideal weight, four methods',
  };

  const GROUPS = [
    { title: 'Measured by the scale', impedance: false, keys: ['weightKg', 'impedanceOhm'] },
    { title: 'Weight status, no impedance involved', impedance: false,
      keys: ['bmi', 'bmiCategoryWho', 'bmiCategoryAsiaPacific', 'healthyWeightRangeKg', 'weightAboveHealthyRangeKg', 'idealWeightRangeKg'] },
    { title: 'Body fat, computed two independent ways', impedance: false,
      keys: ['bodyFatPercentBmiAnchor', 'bodyFatPercent', 'bodyFatGapPoints', 'fatMassKg'] },
    { title: 'Lean tissue', impedance: true,
      keys: ['fatFreeMassKg', 'fatFreeMassIndex', 'muscleMassKg', 'muscleMassPercent', 'skeletalMuscleMassKg', 'skeletalMusclePercent', 'skeletalMuscleIndex'] },
    { title: 'Water, bone and protein', impedance: true,
      keys: ['bodyWaterLitres', 'bodyWaterPercent', 'boneMassKg', 'proteinMassKg', 'proteinPercent'] },
    { title: 'Metabolism', impedance: false, keys: ['bmrKcal'] },
  ];

  return { estimate, GROUPS, LABELS, RANGES, OMITTED, WHO_BANDS, ASIA_PACIFIC_BANDS, HYDRATION_OF_FFM, schofieldBmr };
});
