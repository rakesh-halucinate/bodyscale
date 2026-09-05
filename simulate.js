#!/usr/bin/env node
'use strict';
/*
 * simulate.js — rehearse the Electron flow in a terminal.
 *
 * This is not a mock. It drives the same `scale.js --serve` process over the
 * same pipe, through the same BodyScaleClient the Electron main process uses,
 * so what happens here is what will happen there.
 *
 * The flow it rehearses, which is the one the app must implement:
 *
 *     IDLE ──"Measure Me"──▶ CAPTURING ──reading──▶ HELD ──details──▶ RESULT
 *       ▲                        │                                      │
 *       └──────────────────────────────────────────────────────────────┘
 *
 * The point of the rehearsal is the HELD state. Once a reading is captured it
 * is latched: the scale can be stepped on, off and on again and nothing is
 * re-read. Only "Measure Me" starts a new capture. That is what stops a panel
 * changing under someone while they are typing their age.
 *
 *   node simulate.js                                  the real scale
 *   node simulate.js --replay fixtures/ssw533-session.jsonl    no hardware
 */
const path = require('path');
const readline = require('readline');
const { BodyScaleClient } = require('./electron-example/bodyscale-client.js');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REPLAY = argv.includes('--replay')
  ? arg('--replay', path.join(ROOT, 'fixtures', 'ssw533-session.jsonl'))
  : null;

// ---------------------------------------------------------------- presentation

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
      cyan: '\x1b[36m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' }
  : { dim: '', bold: '', off: '', cyan: '', green: '', amber: '', red: '' };

const say = (s = '') => process.stdout.write(s + '\n');
const rule = () => say(C.dim + '─'.repeat(66) + C.off);
const state = (name, detail) =>
  say(`\n${C.cyan}${C.bold}[${name}]${C.off}${detail ? ' ' + C.dim + detail + C.off : ''}`);

/** Overwrite one line in place, so a live weight does not scroll the screen. */
function live(text) {
  if (!process.stdout.isTTY) return;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(text);
}
const clearLive = () => { if (process.stdout.isTTY) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); } };

// ------------------------------------------------------------------- prompting

/*
 * Prompting has to work in two quite different situations.
 *
 * At a terminal, readline asks and waits. Driven from a script or a test, stdin
 * is a pipe that reaches EOF the moment its contents are consumed, and readline
 * closes underneath the next question. So when stdin is not a TTY the whole
 * input is read once and answers are taken from it in order, which also makes
 * this rehearsal scriptable.
 */
const INTERACTIVE = Boolean(process.stdin.isTTY);

const rl = INTERACTIVE
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;

let scripted = null;
function scriptedLines() {
  if (scripted) return scripted;
  let text = '';
  try { text = require('fs').readFileSync(0, 'utf8'); } catch (e) { text = ''; }
  scripted = text.split('\n');
  if (scripted.length && scripted[scripted.length - 1] === '') scripted.pop();
  return scripted;
}

function ask(q) {
  if (INTERACTIVE) return new Promise((r) => rl.question(q, (a) => r(a.trim())));
  const lines = scriptedLines();
  const answer = lines.length ? lines.shift() : 'q';     // run out of script: quit
  process.stdout.write(q + answer + '\n');
  return Promise.resolve(answer.trim());
}

const closeInput = () => { if (rl) rl.close(); };

/** Ask until the answer is valid, showing why a rejected answer was rejected. */
async function askValid(question, { parse, valid, hint, fallback }) {
  for (;;) {
    const raw = await ask(question);
    if (!raw && fallback !== undefined) return fallback;
    const value = parse(raw);
    if (valid(value)) return value;
    say(`  ${C.red}${hint}${C.off}`);
  }
}

// ------------------------------------------------------------------ the panel

const SHOW = [
  ['bodyFatPercent', 'Body fat'], ['fatMassKg', 'Fat mass'],
  ['muscleMassKg', 'Muscle mass'], ['skeletalMuscleMassKg', 'Skeletal muscle'],
  ['bodyWaterLitres', 'Body water'], ['bodyWaterPercent', 'Water'],
  ['boneMassKg', 'Bone mass'], ['proteinMassKg', 'Protein'],
  ['bmi', 'BMI'], ['bmrKcal', 'BMR'], ['fatFreeMassKg', 'Fat-free mass'],
  ['bmiCategoryWho', 'BMI category'],
];

function renderResult(m) {
  rule();
  say(`  ${C.bold}${m.measured.weightKg} kg${C.off}`
    + (m.measured.impedanceOhm ? `   ${C.dim}${m.measured.impedanceOhm} Ω${C.off}` : `   ${C.dim}no impedance${C.off}`));

  // Nothing at all was computed: the weight is not a person's.
  if (!m.trust.impedanceFree) {
    say('');
    for (const f of m.flags) say(`  ${C.red}${f.message}${C.off}`);
    rule();
    return;
  }

  say('');
  for (const [key, label] of SHOW) {
    if (!(key in m.derived)) continue;
    const unit = m.units[key] ? ' ' + m.units[key] : '';
    // Vendor-convention figures have no clinical validation behind them, so
    // they are dimmed rather than presented like the rest.
    const soft = m.confidence[key] === 'derived-vendor-convention';
    const value = `${m.derived[key]}${unit}`;
    say(`  ${label.padEnd(18)}${soft ? C.dim : ''}${value}${C.off}`);
  }

  if (m.bodyFatRecommended) {
    say('');
    const fromImpedance = m.bodyFatRecommended.key === 'bodyFatPercent';
    say(`  ${C.bold}${m.bodyFatRecommended.value} % body fat${C.off} `
      + C.dim + (fromImpedance ? '(from impedance)' : '(from BMI; the impedance failed its checks)') + C.off);
  }

  if (!m.trust.impedanceDerived) {
    say('');
    say(`  ${C.amber}The impedance-derived values above are not trustworthy.${C.off}`);
  }
  for (const f of m.flags.filter((x) => x.severity === 'fatal')) say(`  ${C.red}${f.message}${C.off}`);
  for (const w of m.warnings) say(`  ${C.dim}${w}${C.off}`);
  rule();
}

// -------------------------------------------------------------------- the run

async function main() {
  say('');
  say(`${C.bold}Body scale — Electron flow rehearsal${C.off}`);
  say(C.dim + 'The same service, the same client, the same protocol the app will use.' + C.off);
  if (REPLAY) say(C.amber + 'Replaying a recorded session: no Bluetooth is involved.' + C.off);
  rule();

  const client = new BodyScaleClient({ scaleDir: ROOT, replay: REPLAY });

  // Nudges are the whole reason the app can say something useful during a
  // stall, so they are surfaced here exactly as the app should surface them.
  let lastHint = null;
  client.on('hint', (h) => { lastHint = h; clearLive(); say(`  ${C.amber}>> ${h.message}${C.off}`); });

  try {
    const hello = await client.start();
    say(`  service ${hello.version}, protocol ${hello.proto}, on ${hello.platform}`);
    say(hello.device
      ? `  remembered ${hello.device.name}`
      : `  no scale remembered yet; the first scan will take longer`);
  } catch (err) {
    say(`\n  ${C.red}Could not start the service: ${err.message}${C.off}\n`);
    closeInput();
    process.exit(1);
  }

  for (;;) {
    // ---------------------------------------------------------------- IDLE
    state('IDLE', 'nothing is being read');
    say(`  ${C.dim}In the app this is the "Measure Me" button.${C.off}`);
    const go = await ask(`  ${C.bold}Press Enter to Measure Me${C.off} ${C.dim}(q to quit)${C.off} `);
    if (go.toLowerCase() === 'q') break;

    // ----------------------------------------------------------- CAPTURING
    state('CAPTURING', 'step on the scale');
    lastHint = null;
    const onProgress = (p) => {
      if (typeof p.weightKg === 'number' && p.weightKg > 0) {
        live(`  ${C.dim}reading${C.off} ${C.bold}${p.weightKg.toFixed(2)} kg${C.off}   `);
      } else if (p.message) {
        live(`  ${C.dim}${p.message}${C.off}   `);
      }
    };
    client.on('progress', onProgress);

    let captured;
    try {
      // No profile. The radio window is short; the age is not urgent.
      //
      // Generous windows on purpose. A real scan of a sleeping scale has taken
      // 8 to 14 seconds in the field, and the first run may also be waiting on
      // the macOS Bluetooth prompt. The nudge fires long before either expires,
      // so the person is told what to do rather than left watching nothing.
      captured = await client.measureWithoutProfile({
        scanTimeoutSec: Number(arg('--scan-timeout', 90)),
        timeoutSec: Number(arg('--hold', 180)),
        hintAfterSec: Number(arg('--hint-after', 8)),
        // The scale runs its impedance program after the weight locks. Hanging
        // up before it finishes is what produced weight-only readings.
        impedanceWaitSec: Number(arg('--impedance-wait', 30)),
      });
    } catch (err) {
      clearLive();
      client.off('progress', onProgress);
      say(`\n  ${C.red}${err.code}${C.off}  ${err.message}`);
      if (lastHint) say(`  ${C.dim}Last hint was: ${lastHint.message}${C.off}`);
      continue;                                  // straight back to IDLE
    }
    client.off('progress', onProgress);
    clearLive();

    // ---------------------------------------------------------------- HELD
    state('HELD', 'the reading is latched');
    say(`  weight     ${C.bold}${captured.measured.weightKg} kg${C.off}`);
    say(`  impedance  ${captured.measured.impedanceOhm === null
      ? C.dim + 'none sent' + C.off
      : captured.measured.impedanceOhm + ' Ω'}`);
    say(`  taken at   ${C.dim}${captured.timestamp}${C.off}`);
    say('');
    say(`  ${C.green}Waiting for your details before anything is computed.${C.off}`);
    say(`  ${C.dim}The scale link is already closed. Step on it as much as you like —${C.off}`);
    say(`  ${C.dim}nothing is re-read until you press Measure Me again.${C.off}`);
    say('');

    const sex = await askValid(`  Sex ${C.dim}[male]${C.off} `, {
      parse: (v) => v.toLowerCase(), fallback: 'male',
      valid: (v) => v === 'male' || v === 'female',
      hint: 'Enter male or female.',
    });
    const age = await askValid('  Age  ', {
      parse: Number, valid: (v) => Number.isFinite(v) && v >= 5 && v <= 120,
      hint: 'Enter an age between 5 and 120.',
    });
    const heightCm = await askValid('  Height in cm  ', {
      parse: Number, valid: (v) => Number.isFinite(v) && v >= 90 && v <= 250,
      hint: 'Enter a height between 90 and 250 cm.',
    });

    // ------------------------------------------------------------- RESULT
    state('COMPUTING', 'no radio, no waiting');
    try {
      const result = await client.compute(
        captured.measured, { sex, age, heightCm },
        { measuredAt: captured.timestamp, model: captured.model, device: captured.device });
      say('');
      renderResult(result);
    } catch (err) {
      say(`\n  ${C.red}${err.code}${C.off}  ${err.message}`);
    }
  }

  say('');
  await client.stop();
  closeInput();
  say(C.dim + 'stopped' + C.off);
}

main().catch((err) => {
  say(`\n${C.red}${err.stack || err.message}${C.off}`);
  closeInput();
  process.exit(1);
});
