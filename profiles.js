#!/usr/bin/env node
'use strict';
/*
 * profiles.js — take one reading, interpret it as several different people.
 *
 * The whole point of the deferred design is that a measurement and its
 * interpretation are separate things. The scale contributes exactly two
 * numbers, weight and impedance; everything else on a body-composition panel
 * is computed from those plus a profile. So the same reading can be run
 * against any number of profiles without anyone standing on the scale again,
 * and the differences that appear are attributable entirely to the profile.
 *
 * That makes this a useful check on how much each field actually matters —
 * which is a question worth answering with numbers rather than opinion.
 *
 *   node profiles.js                                  the real scale
 *   node profiles.js --replay                         a recorded session
 *   node profiles.js --replay fixtures/xyz.jsonl
 */
const path = require('path');
const { BodyScaleClient } = require('./electron-example/bodyscale-client.js');
const BIA = require('./bia.js');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const REPLAY = argv.includes('--replay')
  ? arg('--replay', path.join(ROOT, 'fixtures', 'ssw533-session.jsonl'))
  : null;

/** Height is held constant so every difference below is sex or age. */
const HEIGHT_CM = Number(arg('--height', 180));

/*
 * Nothing is written to the scale. The service supplies its own synthetic
 * placeholder — male, 25, 170 cm, which is nobody — and that is what a kiosk
 * does too. It reaches none of the maths below.
 */

const PROFILES = [
  { label: 'male 39   (default)', sex: 'male', age: 39 },
  { label: 'female 39', sex: 'female', age: 39 },
  { label: 'female 30', sex: 'female', age: 30 },
  { label: 'female 20', sex: 'female', age: 20 },
  { label: 'male 10', sex: 'male', age: 10 },
  { label: 'female 60', sex: 'female', age: 60 },
];

/** The rows worth comparing, in the order a panel shows them. */
const ROWS = [
  ['bodyFatPercent', 'Body fat', '%'],
  ['fatMassKg', 'Fat mass', 'kg'],
  ['fatFreeMassKg', 'Fat-free mass', 'kg'],
  ['muscleMassKg', 'Muscle mass', 'kg'],
  ['skeletalMuscleMassKg', 'Skeletal muscle', 'kg'],
  ['bodyWaterLitres', 'Body water', 'L'],
  ['bodyWaterPercent', 'Water rate', '%'],
  ['boneMassKg', 'Bone mass', 'kg'],
  ['proteinMassKg', 'Protein', 'kg'],
  ['bmi', 'BMI', ''],
  ['bmrKcal', 'BMR', 'kcal'],
];

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
      cyan: '\x1b[36m', amber: '\x1b[33m', red: '\x1b[31m' }
  : { dim: '', bold: '', off: '', cyan: '', amber: '', red: '' };
const say = (s = '') => process.stdout.write(s + '\n');
const rule = (n = 96) => say(C.dim + '─'.repeat(n) + C.off);

async function main() {
  say('');
  say(`${C.bold}One reading, ${PROFILES.length} interpretations${C.off}`);
  say(C.dim + `height held at ${HEIGHT_CM} cm throughout, so every difference below is `
    + 'sex or age' + C.off);
  if (REPLAY) say(C.amber + 'Replaying a recorded session: no Bluetooth is involved.' + C.off);
  rule();

  const client = new BodyScaleClient({ scaleDir: ROOT, replay: REPLAY });
  client.on('hint', (h) => say(`  ${C.amber}>> ${h.message}${C.off}`));
  client.on('log', (line) => {
    const s = String(line).trim();
    // The lines that say whether the scale actually measured.
    if (/sweep|stored record|live record|impedance slot/i.test(s)) say(`  ${C.dim}· ${s}${C.off}`);
  });

  let hello;
  try {
    hello = await client.start();
  } catch (err) {
    say(`\n  ${C.red}Could not start the service: ${err.message}${C.off}\n`);
    process.exit(1);
  }
  say(`  service ${hello.version}, protocol ${hello.proto}, on ${hello.platform}`);
  say(hello.device ? `  remembered ${hello.device.name}` : '  no scale remembered yet');
  say('');
  say(`  ${C.bold}Step on the scale and hold the handle until P-1 clears.${C.off}`);
  say('');

  let captured;
  try {
    captured = await client.measureWithoutProfile({
      scanTimeoutSec: Number(arg('--scan-timeout', 90)),
      timeoutSec: Number(arg('--hold', 180)),
      hintAfterSec: Number(arg('--hint-after', 8)),
      impedanceWaitSec: Number(arg('--impedance-wait', 30)),
    });
  } catch (err) {
    say(`\n  ${C.red}${err.code}${C.off}  ${err.message}\n`);
    await client.stop();
    process.exit(1);
  }
  await client.stop();

  // ---------------------------------------------------------- what the scale sent
  const m = captured.measured;
  say('');
  rule();
  say(`  ${C.bold}What the device sent${C.off}`);
  say(`    device        ${captured.device ? captured.device.name : 'unknown'}`
    + `${captured.model ? ` (${captured.model})` : ''}`);
  say(`    taken at      ${captured.timestamp}`);
  say(`    weight        ${C.bold}${m.weightKg} kg${C.off}`);
  say(`    impedance     ${m.impedanceOhm === null ? C.dim + 'none' + C.off : `${m.impedanceOhm} Ω`}`);
  if (Array.isArray(m.impedances) && m.impedances.length >= 5) {
    const seg = (g) => `trunk ${g[0]} Ω,  limbs ${g.slice(1).join(', ')} Ω`;
    say(`    segments      ${C.dim}${seg(m.impedances.slice(0, 5))}${C.off}`);
    if (m.impedances.length >= 10) {
      say(`                  ${C.dim}${seg(m.impedances.slice(5, 10))}${C.off}`);
    }
  }
  say(`    told the scale ${C.dim}nothing — the service sent its own placeholder,`
    + ` which reaches none of the figures below${C.off}`);
  rule();

  if (!m.impedanceOhm) {
    say('');
    say(`  ${C.amber}No impedance arrived, so there is nothing to interpret six ways.${C.off}`);
    say(`  ${C.dim}The scale weighed but did not run its sweep. Step off, let the display`);
    say(`  clear, and try again holding the handle with both hands throughout.${C.off}`);
    say('');
    return;
  }

  // -------------------------------------------------------- the interpretations
  const results = PROFILES.map((p) => ({
    p,
    r: BIA.estimate({
      weightKg: m.weightKg, impedanceOhm: m.impedanceOhm,
      heightCm: HEIGHT_CM, age: p.age, sex: p.sex,
    }),
  }));

  const LW = Math.max(...ROWS.map(([, l]) => l.length)) + 2;
  const CW = Math.max(...PROFILES.map((p) => p.label.length)) + 2;

  say('');
  say(`  ${C.bold}The same reading, computed six ways${C.off}`);
  say('');
  say(`  ${''.padEnd(LW)}${PROFILES.map((p) => C.cyan + p.label.padEnd(CW) + C.off).join('')}`);

  for (const [key, label, unit] of ROWS) {
    const cells = results.map(({ r }) => {
      const v = r.values[key];
      return v === undefined || v === null
        ? `${C.dim}${'—'.padEnd(CW)}${C.off}`
        : `${v}${unit ? ' ' + unit : ''}`.padEnd(CW);
    });
    say(`  ${label.padEnd(LW)}${cells.join('')}`);
  }

  // Spread: how far apart the interpretations are, which is the whole question.
  say('');
  say(`  ${C.bold}How much the profile changes each figure${C.off}`);
  say(`  ${C.dim}against the default, male 39${C.off}`);
  say('');
  const base = results[0].r.values;
  for (const [key, label, unit] of ROWS) {
    if (typeof base[key] !== 'number') continue;
    const others = results.slice(1)
      .map(({ r }) => r.values[key]).filter((v) => typeof v === 'number');
    if (!others.length) continue;
    const lo = Math.min(...others, base[key]);
    const hi = Math.max(...others, base[key]);
    const swing = base[key] === 0 ? 0 : ((hi - lo) / Math.abs(base[key])) * 100;
    const bar = '█'.repeat(Math.min(40, Math.round(swing / 2)));
    const colour = swing >= 10 ? C.red : swing >= 3 ? C.amber : C.dim;
    say(`  ${label.padEnd(LW)}${`${lo}–${hi}${unit ? ' ' + unit : ''}`.padEnd(20)}`
      + `${colour}${swing.toFixed(1)} %${C.off}  ${colour}${bar}${C.off}`);
  }

  /*
   * Every flag, not just the fatal ones.
   *
   * The first version of this printed only fatal flags, which hid the most
   * interesting thing a profile can tell you: T11 fires at warn level when an
   * age falls outside the range these adult equations were fitted on, and for
   * a ten-year-old that is the single most important line on the page. A
   * warning that is filtered out is the same as no warning.
   */
  say('');
  say(`  ${C.bold}What each profile flags${C.off}`);
  for (const { p, r } of results) {
    const flags = r.flags || [];
    const missing = ROWS.filter(([k]) => r.values[k] === undefined).map(([, l]) => l);
    if (!flags.length && !missing.length) {
      say(`  ${p.label.padEnd(CW)}${C.dim}nothing flagged${C.off}`);
      continue;
    }
    say(`  ${C.amber}${p.label}${C.off}`);
    for (const f of flags) {
      const mark = f.severity === 'fatal' ? `${C.red}fatal${C.off}` : `${C.dim}warn ${C.off}`;
      say(`    ${mark} ${C.dim}${f.rule}  ${f.message}${C.off}`);
    }
    if (missing.length) say(`    ${C.dim}      not computed: ${missing.join(', ')}${C.off}`);
    if (!r.trust.impedanceDerived) {
      say(`    ${C.red}      the impedance-derived half of this column is not trustworthy${C.off}`);
    }
  }
  say('');
}

main().catch((err) => {
  say(`\n${C.red}${err.stack || err.message}${C.off}`);
  process.exit(1);
});
