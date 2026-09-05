#!/usr/bin/env node
'use strict';
/*
 * compare.js — put the scale's own figures beside ours, field by field.
 *
 * WHY THIS TOOL EXISTS, AND WHAT IT CAN AND CANNOT TELL YOU
 *
 * The SSW533 transmits exactly two numbers over Bluetooth: weight and whole-body
 * impedance. Everything on its display is computed ON THE SCALE from those two,
 * plus a profile stored in the scale or its phone app. Verified byte by byte:
 * in the 40-byte record frame, bytes 15 to 38 are all zero.
 *
 * So the scale's body composition figures cannot be read over the air. They have
 * to be typed in from its display. This tool then computes ours from the SAME
 * weight and impedance and shows both.
 *
 * That makes one comparison decisive and the rest merely informative:
 *
 *   WEIGHT MUST MATCH EXACTLY. Both sides read it from the same hardware. A
 *   mismatch means a decoding fault, and is worth chasing.
 *
 *   COMPOSITION DIFFERENCES ARE EXPECTED. The two sides use different published
 *   equations, and the scale's are undisclosed. A gap does not by itself mean
 *   either is wrong. What it can reveal is a gap so large that the two must be
 *   answering different questions, or a profile mismatch.
 *
 *   A PROFILE MISMATCH EXPLAINS EVERYTHING ELSE FIRST. If the scale's app holds
 *   a different age, height or sex from the one given here, every derived figure
 *   will differ for that reason alone, and no equation comparison is meaningful
 *   until they agree. Check that before reading anything else below.
 *
 *   node compare.js --weight 97.9 --impedance 529.9 --age 39 --height 180 --sex male \
 *                   --scale-fat-percent 32.1 --scale-fat-mass 31.4 \
 *                   --scale-water 42.8 --scale-muscle 61.2 \
 *                   --scale-protein 12.9 --scale-minerals 3.1
 *
 * Give only the fields your scale shows; the rest are simply left out.
 */
const BIA = require('./bia.js');

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i < 0 || i + 1 >= argv.length) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : argv[i + 1];
}
const has = (name) => argv.indexOf('--' + name) >= 0;

if (has('help') || has('h') || !argv.length) {
  process.stdout.write(`
Put the scale's own figures beside ours, field by field.

  Required, all from the same measurement:
    --weight <kg>        what the scale reported over Bluetooth
    --impedance <ohm>    likewise
    --age <years>        the profile used HERE
    --height <cm>
    --sex male|female

  What the scale's own display or app shows. Give whichever it shows:
    --scale-fat-percent <%>     body fat
    --scale-fat-mass <kg>       body fat mass
    --scale-water <kg or L>     total body water     (--scale-water-percent for %)
    --scale-muscle <kg>         skeletal muscle mass
    --scale-protein <kg>        protein
    --scale-minerals <kg>       bone mineral / bone mass
    --scale-weight <kg>         the weight ON ITS DISPLAY, if you can read it

  Also useful when the scale's app holds its own profile:
    --scale-age <years>  --scale-height <cm>  --scale-sex male|female

`);
  process.exit(0);
}

const weightKg = flag('weight');
const impedanceOhm = flag('impedance', 0);
const age = flag('age');
const heightCm = flag('height');
const sex = String(flag('sex', 'male')).toLowerCase();

const missing = [];
if (!Number.isFinite(weightKg)) missing.push('--weight');
if (!Number.isFinite(age)) missing.push('--age');
if (!Number.isFinite(heightCm)) missing.push('--height');
if (missing.length) {
  process.stderr.write(`\n  Need ${missing.join(', ')}. Run with --help.\n\n`);
  process.exit(2);
}

// ---------------------------------------------------------------- our figures

const ours = BIA.estimate({ weightKg, impedanceOhm, heightCm, age, sex });
const v = ours.values;

// ------------------------------------------------------------------ the table

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
      green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
  : { dim: '', bold: '', off: '', green: '', amber: '', red: '', cyan: '' };

const say = (s = '') => process.stdout.write(s + '\n');
const rule = (ch = '─') => say(C.dim + ch.repeat(76) + C.off);

/*
 * How far apart two figures have to be before the gap means something.
 *
 * These are not statistical thresholds. They are the point at which a
 * difference stops being "two reasonable equations disagree" and starts being
 * "these cannot both be describing the same body". Body fat percent is the
 * strictest because every other composition figure is derived from it.
 */
const TOLERANCE = {
  weight: 0.05,        // kg. Same hardware, same frame: it must match.
  fatPercent: 5,       // points. Foot-to-foot BIA carries about this much error.
  mass: 4,             // kg, for fat, muscle, water.
  small: 1.2,          // kg, for protein and minerals, which are small numbers.
};

const rows = [];
function row(label, scaleValue, ourValue, unit, tolerance, note) {
  if (!Number.isFinite(scaleValue) && !Number.isFinite(ourValue)) return;
  rows.push({ label, scaleValue, ourValue, unit, tolerance, note });
}

const scaleWater = flag('scale-water');
const scaleWaterPct = flag('scale-water-percent');

row('Weight', flag('scale-weight'), weightKg, 'kg', TOLERANCE.weight,
    'both read this from the same frame');
row('Body fat', flag('scale-fat-percent'), v.bodyFatPercent, '%', TOLERANCE.fatPercent,
    'Sun 2003 here; the scale uses its own');
row('Body fat mass', flag('scale-fat-mass'), v.fatMassKg, 'kg', TOLERANCE.mass,
    'follows directly from the percentage');
row('Body water', scaleWater, v.bodyWaterLitres, 'L', TOLERANCE.mass,
    'Sun 2003 total body water');
row('Body water', scaleWaterPct, v.bodyWaterPercent, '%', TOLERANCE.fatPercent,
    'the same value as a share of weight');
row('Skeletal muscle', flag('scale-muscle'), v.skeletalMuscleMassKg, 'kg', TOLERANCE.mass,
    'Janssen 2000 here');
row('Protein', flag('scale-protein'), v.proteinMassKg, 'kg', TOLERANCE.small,
    'vendor convention on both sides, and they differ');
row('Bone mineral', flag('scale-minerals'), v.boneMassKg, 'kg', TOLERANCE.small,
    'vendor convention on both sides, and they differ');

say('');
say(`${C.bold}Scale versus this tool${C.off}`);
say(C.dim + `From one measurement: ${weightKg} kg, ${impedanceOhm || 'no'} ${impedanceOhm ? 'Ω' : 'impedance'}` + C.off);
rule();

// ---------------------------------------------------------- profile agreement

const scaleAge = flag('scale-age');
const scaleHeight = flag('scale-height');
const scaleSex = has('scale-sex') ? String(flag('scale-sex')).toLowerCase() : null;
const profileGiven = Number.isFinite(scaleAge) || Number.isFinite(scaleHeight) || scaleSex;
const profileDiffers = (Number.isFinite(scaleAge) && scaleAge !== age)
  || (Number.isFinite(scaleHeight) && scaleHeight !== heightCm)
  || (scaleSex && scaleSex !== sex);

if (profileGiven) {
  say(`  ${C.bold}Profile${C.off}`);
  const p = (label, a, b) => {
    if (a === undefined || a === null || (typeof a === 'number' && !Number.isFinite(a))) return;
    const same = a === b;
    say(`    ${label.padEnd(10)} scale ${String(a).padEnd(8)} here ${String(b).padEnd(8)} `
      + (same ? C.green + 'same' + C.off : C.red + 'DIFFERENT' + C.off));
  };
  p('age', Number.isFinite(scaleAge) ? scaleAge : null, age);
  p('height', Number.isFinite(scaleHeight) ? scaleHeight : null, heightCm);
  p('sex', scaleSex, sex);
  say('');
  if (profileDiffers) {
    say(`  ${C.red}${C.bold}Stop here.${C.off} The two sides are describing different people.`);
    say(`  ${C.dim}Every figure below differs for that reason alone. Make the profiles`);
    say(`  match before comparing anything else.${C.off}`);
    say('');
  }
  rule();
}

// -------------------------------------------------------------- side by side

if (!rows.length) {
  say(`  ${C.amber}No scale figures were given, so there is nothing to compare.${C.off}`);
  say(`  ${C.dim}Read them off the scale's display or its app and pass them in.`);
  say(`  Run with --help to see the flags.${C.off}`);
  say('');
  process.exit(0);
}

say(`  ${'Field'.padEnd(17)}${'Scale'.padStart(9)}${'Here'.padStart(11)}${'Diff'.padStart(10)}   Verdict`);
rule('╌');

let decisiveFailure = false;
let notable = 0;

for (const r of rows) {
  const bothKnown = Number.isFinite(r.scaleValue) && Number.isFinite(r.ourValue);
  const scaleTxt = Number.isFinite(r.scaleValue) ? `${r.scaleValue}` : '—';
  const ourTxt = Number.isFinite(r.ourValue) ? `${r.ourValue}` : '—';

  let diffTxt = '';
  let verdict = C.dim + 'not given' + C.off;

  if (bothKnown) {
    const d = r.ourValue - r.scaleValue;
    diffTxt = (d >= 0 ? '+' : '') + d.toFixed(2);
    const within = Math.abs(d) <= r.tolerance;
    if (r.label === 'Weight') {
      // The one comparison that is not a matter of opinion.
      verdict = within ? C.green + 'match' + C.off
        : C.red + C.bold + 'MISMATCH — decoding fault' + C.off;
      if (!within) decisiveFailure = true;
    } else if (within) {
      verdict = C.green + 'close' + C.off;
    } else {
      verdict = C.amber + 'differs' + C.off;
      notable++;
    }
  }

  say(`  ${r.label.padEnd(17)}${scaleTxt.padStart(9)}${ourTxt.padStart(11)}${diffTxt.padStart(10)}   ${verdict}`);
  say(`  ${C.dim}${''.padEnd(17)}${r.note}${C.off}`);
}

rule();

// ------------------------------------------------------------------ the verdict

say('');
say(`  ${C.bold}What this tells you${C.off}`);
say('');

if (decisiveFailure) {
  say(`  ${C.red}The weights disagree.${C.off} Both sides read that number from the same`);
  say(`  Bluetooth frame, so they cannot legitimately differ. That is a decoding`);
  say(`  fault and is worth chasing. Everything below it is meaningless until it`);
  say(`  is fixed.`);
  say('');
} else if (rows.some((r) => r.label === 'Weight' && Number.isFinite(r.scaleValue))) {
  say(`  ${C.green}The weights match.${C.off} The frame is being decoded correctly, so any`);
  say(`  differences below are equations, not a bug in reading the scale.`);
  say('');
}

if (!ours.trust.impedanceFree) {
  say(`  ${C.red}Nothing was computed here at all${C.off} — the weight is not a person's.`);
  for (const f of ours.flags) say(`    ${f.message}`);
  say('');
} else if (!ours.trust.impedanceDerived) {
  say(`  ${C.amber}Our impedance-derived figures failed their own checks${C.off}, so they are`);
  say(`  not trustworthy in absolute terms and this comparison is weak:`);
  for (const f of ours.flags.filter((x) => x.severity === 'fatal')) say(`    ${f.message}`);
  say('');
}

if (notable) {
  say(`  ${notable} composition figure${notable === 1 ? '' : 's'} differ by more than the tolerance above.`);
} else if (rows.length > 1) {
  say(`  Every composition figure is within tolerance of the scale's own.`);
}
say('');
say(`  ${C.dim}Both sides start from the same two numbers and apply different equations.`);
say(`  Ours are published and cited — Sun 2003 for water, Janssen 2000 for skeletal`);
say(`  muscle, Wang 1999 for the hydration constant. The scale's are undisclosed,`);
say(`  and protein and bone are vendor convention on both sides with no clinical`);
say(`  validation behind either. A difference does not make either one wrong.`);
say('');
say(`  What a foot-to-foot scale can actually support is the TREND, measured the`);
say(`  same way at the same time of day. Neither column is a body-composition`);
say(`  scan, and disagreement between them is the honest signal that says so.${C.off}`);
say('');
