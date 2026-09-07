#!/usr/bin/env node
'use strict';
/*
 * handshake.js — does the identity we hand the scale change what it measures?
 *
 * The scale is told a profile before anyone stands on it, and the panel is
 * computed from a profile afterwards. Those are two different things, and it
 * has never been established whether the first one matters.
 *
 * It was blamed once, wrongly: a run that failed with a placeholder identity
 * was actually failing because the driver was accepting the scale's history
 * upload as a measurement. That bug is fixed, so the question is open and
 * answerable.
 *
 * Two readings:
 *
 *   A  handshake with the truth        -> compute with the truth
 *   B  handshake with a deliberate lie -> compute with the truth
 *
 * Both are computed from the same real profile, so the ONLY difference between
 * them is what the scale was told. If the raw weight and impedances match, the
 * handshake identity is cosmetic to the measurement and only affects what the
 * scale shows on its own display. If they differ, it is load-bearing.
 *
 *   node handshake.js
 *   node handshake.js --sex female --age 34 --height 165
 */
const path = require('path');
const readline = require('readline');
const { BodyScaleClient } = require('./electron-example/bodyscale-client.js');
const BIA = require('./bia.js');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/** Who is really on the scale. Both readings are computed against this. */
const TRUTH = {
  sex: String(arg('--sex', 'male')).toLowerCase(),
  age: Number(arg('--age', 39)),
  heightCm: Number(arg('--height', 180)),
};

/*
 * A deliberate lie, chosen to be as far from the truth as the protocol allows
 * without being rejected: the other sex, a very different age, a very
 * different height. If the handshake identity has any influence at all, this
 * is the shape that would reveal it.
 */
const LIE = { sex: TRUTH.sex === 'male' ? 'female' : 'male', age: 70, heightCm: 140 };

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
      cyan: '\x1b[36m', amber: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m' }
  : { dim: '', bold: '', off: '', cyan: '', amber: '', red: '', green: '' };
const say = (s = '') => process.stdout.write(s + '\n');
const rule = (n = 78) => say(C.dim + '─'.repeat(n) + C.off);

const rl = process.stdin.isTTY
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;
const ask = (q) => (rl
  ? new Promise((r) => rl.question(q, (a) => r(a.trim())))
  : Promise.resolve(''));

/** One capture, with a stated handshake identity. */
async function capture(label, handshake) {
  say('');
  rule();
  say(`  ${C.bold}${label}${C.off}`);
  say(`  ${C.dim}telling the scale: ${handshake.sex}, ${handshake.age}y, ${handshake.heightCm} cm${C.off}`);
  rule();
  await ask(`  ${C.bold}Press Enter, then step on and hold the handle until P-1 clears.${C.off} `);

  const client = new BodyScaleClient({ scaleDir: ROOT });
  client.on('hint', (h) => say(`  ${C.amber}>> ${h.message}${C.off}`));
  client.on('log', (line) => {
    const s = String(line).trim();
    if (/sweep|stored record|live record|impedance slot/i.test(s)) say(`  ${C.dim}· ${s}${C.off}`);
  });

  await client.start();
  let m;
  try {
    m = await client.measureWithoutProfile({
      scanTimeoutSec: 90, timeoutSec: 180, hintAfterSec: 8,
      impedanceWaitSec: 30, scaleProfile: handshake,
    });
  } finally {
    await client.stop();
  }
  return m;
}

/** The rows worth printing for a reading. */
const ROWS = [
  ['bodyFatPercent', 'Body fat', '%'], ['fatMassKg', 'Fat mass', 'kg'],
  ['fatFreeMassKg', 'Fat-free mass', 'kg'], ['muscleMassKg', 'Muscle mass', 'kg'],
  ['skeletalMuscleMassKg', 'Skeletal muscle', 'kg'],
  ['bodyWaterLitres', 'Body water', 'L'], ['bodyWaterPercent', 'Water rate', '%'],
  ['boneMassKg', 'Bone mass', 'kg'], ['proteinMassKg', 'Protein', 'kg'],
  ['bmi', 'BMI', ''], ['bmrKcal', 'BMR', 'kcal'],
];

function interpret(m) {
  return BIA.estimate({
    weightKg: m.measured.weightKg, impedanceOhm: m.measured.impedanceOhm,
    heightCm: TRUTH.heightCm, age: TRUTH.age, sex: TRUTH.sex,
  });
}

function showRaw(label, m) {
  const x = m.measured;
  say(`  ${C.bold}${label}${C.off}`);
  say(`    weight       ${x.weightKg} kg`);
  say(`    impedance    ${x.impedanceOhm === null ? C.dim + 'none' + C.off : `${x.impedanceOhm} Ω`}`);
  if (Array.isArray(x.impedances) && x.impedances.length) {
    say(`    slots        ${C.dim}${x.impedances.join(', ')}${C.off}`);
  }
}

async function main() {
  say('');
  say(`${C.bold}Does the handshake identity change the measurement?${C.off}`);
  say(C.dim + 'Two readings. Both computed from the SAME real profile — '
    + `${TRUTH.sex}, ${TRUTH.age}y, ${TRUTH.heightCm} cm — so the only` + C.off);
  say(C.dim + 'difference between them is what the scale was told beforehand.' + C.off);
  say('');
  say(`  ${C.amber}Take them back to back, within a minute or two.${C.off}`);
  say(`  ${C.dim}Impedance drifts with hydration and contact: the same person measured hours`);
  say(`  apart has read 506 and 591 Ω here, a 6-point swing in body fat. Readings far`);
  say(`  apart in time cannot answer this question.${C.off}`);

  const A = await capture('READING A — handshake tells the truth', TRUTH);
  const B = await capture('READING B — handshake tells a lie', LIE);

  say('');
  rule();
  say(`  ${C.bold}What the scale sent${C.off}`);
  say('');
  showRaw('A, told the truth', A);
  say('');
  showRaw('B, told a lie', B);

  // ---------------------------------------------------------------- the verdict
  const a = A.measured;
  const b = B.measured;
  say('');
  rule();
  say(`  ${C.bold}The answer${C.off}`);
  say('');

  if (a.impedanceOhm === null || b.impedanceOhm === null) {
    say(`  ${C.amber}One of the readings has no impedance, so this cannot be answered.${C.off}`);
    say(`  ${C.dim}Both need a completed sweep. Run it again.${C.off}`);
  } else {
    const dz = Math.abs(a.impedanceOhm - b.impedanceOhm);
    const pz = (dz / Math.min(a.impedanceOhm, b.impedanceOhm)) * 100;
    const dw = Math.abs(a.weightKg - b.weightKg);
    say(`    weight differs by     ${dw.toFixed(2)} kg`);
    say(`    impedance differs by  ${dz.toFixed(1)} Ω  (${pz.toFixed(1)} %)`);
    say('');
    /*
     * The threshold is the drift already seen between two honest readings of
     * the same person on the same evening: about 17%. A difference smaller
     * than that proves nothing either way, and saying otherwise would be
     * reading a result into noise.
     */
    if (pz < 5) {
      say(`  ${C.green}The handshake identity did not change the measurement.${C.off}`);
      say(`  ${C.dim}A ${pz.toFixed(1)}% impedance difference is well inside the drift between two`);
      say(`  honest readings, so the scale measured the same body both times. What it is`);
      say(`  told affects its own display, not what it sends. A first-time user does not`);
      say(`  need to be asked anything before standing on it.${C.off}`);
    } else if (pz > 15) {
      say(`  ${C.red}The handshake identity DID change the measurement.${C.off}`);
      say(`  ${C.dim}${pz.toFixed(1)}% is beyond ordinary drift. The profile is load-bearing and`);
      say(`  must be real before the sweep, not merely well formed.${C.off}`);
    } else {
      say(`  ${C.amber}Inconclusive.${C.off}`);
      say(`  ${C.dim}${pz.toFixed(1)}% sits inside the drift two honest readings of the same person`);
      say(`  show, so it cannot be attributed to the handshake. Run it again, and if it`);
      say(`  keeps landing here, alternate A B A B to separate drift from effect.${C.off}`);
    }
  }

  // ------------------------------------------------------- both panels in full
  for (const [label, m] of [['A, told the truth', A], ['B, told a lie', B]]) {
    if (m.measured.impedanceOhm === null) continue;
    const r = interpret(m);
    say('');
    rule();
    say(`  ${C.bold}${label}${C.off}  ${C.dim}computed as ${TRUTH.sex}, ${TRUTH.age}y, ${TRUTH.heightCm} cm${C.off}`);
    say('');
    for (const [key, lab, unit] of ROWS) {
      const v = r.values[key];
      if (v === undefined) continue;
      say(`    ${lab.padEnd(18)}${v}${unit ? ' ' + unit : ''}`);
    }
    const vm = r.vendorMatch;
    if (vm && typeof vm.visceralFatRating === 'number') {
      say(`    ${'Visceral fat'.padEnd(18)}${vm.visceralFatRating}`);
    }
    for (const f of r.flags) say(`    ${C.dim}${f.severity} ${f.rule}: ${f.message}${C.off}`);
  }

  say('');
  if (rl) rl.close();
}

main().catch((err) => {
  say(`\n${C.red}${err.stack || err.message}${C.off}`);
  if (rl) rl.close();
  process.exit(1);
});
