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

/*
 * Every session is written to a file as well as the screen.
 *
 * Diagnosing this scale has meant repeatedly asking the user to copy terminal
 * output back by hand, which is tedious for them and loses exactly the detail
 * that matters when it gets truncated. The log costs nothing and means a run
 * can be read after the fact.
 */
const LOG_DIR = require('path').join(__dirname, 'logs');
let LOG_FILE = null;
try {
  require('fs').mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  LOG_FILE = require('path').join(LOG_DIR, `session-${stamp}.log`);
} catch (e) { LOG_FILE = null; }

const strip = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
function record(text) {
  if (!LOG_FILE) return;
  try { require('fs').appendFileSync(LOG_FILE, strip(text) + '\n'); } catch (e) { LOG_FILE = null; }
}

const say = (s = '') => { record(s); process.stdout.write(s + '\n'); };
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

/*
 * Everything, in a sensible order — not a curated subset.
 *
 * This list used to hold twelve rows, and anything computed but unlisted was
 * invisible. Someone comparing the terminal against the phone could not tell
 * whether a missing number was not computed, not sent by the scale, or simply
 * not printed, which are three very different problems. Any derived key not
 * named here is still printed, after these, under its own name.
 */
const SHOW = [
  ['bodyFatPercent', 'Body fat'], ['fatMassKg', 'Fat mass'],
  ['fatFreeMassKg', 'Fat-free mass'], ['fatFreeMassIndex', 'Fat-free mass index'],
  ['muscleMassKg', 'Muscle mass'], ['muscleMassPercent', 'Muscle rate'],
  ['skeletalMuscleMassKg', 'Skeletal muscle'], ['skeletalMusclePercent', 'Skeletal muscle rate'],
  ['skeletalMuscleIndex', 'Skeletal muscle index'],
  ['bodyWaterLitres', 'Body water'], ['bodyWaterPercent', 'Water rate'],
  ['boneMassKg', 'Bone mass'],
  ['proteinMassKg', 'Protein'], ['proteinPercent', 'Protein rate'],
  ['bmi', 'BMI'], ['bmiCategoryWho', 'BMI category'],
  ['bmiCategoryAsiaPacific', 'BMI category (Asia-Pacific)'],
  ['bmrKcal', 'BMR'], ['visceralFatRating', 'Visceral fat'],
  ['idealWeightRangeKg', 'Ideal weight'], ['healthyWeightRangeKg', 'Healthy range'],
  ['weightAboveHealthyRangeKg', 'Above healthy range'],
  ['bodyFatPercentBmiAnchor', 'Body fat (BMI method)'],
  ['bodyFatGapPoints', 'Gap between methods'],
];

function renderResult(m) {
  rule();
  say(`  ${C.bold}${m.measured.weightKg} kg${C.off}`
    + (m.measured.impedanceOhm ? `   ${C.dim}${m.measured.impedanceOhm} Ω${C.off}` : `   ${C.dim}no impedance${C.off}`));

  /*
   * Show every impedance the scale sent, not just the figure derived from
   * them. How ten slots become one whole-body number is inferred from their
   * magnitudes rather than read out of the vendor code, so the raw set has to
   * be visible for anyone to check it against the app's own reading.
   */
  const slots = m.measured.impedances;
  if (Array.isArray(slots) && slots.length >= 5) {
    const seg = (g) => `trunk ${g[0]} Ω   limbs ${g.slice(1).join(', ')} Ω`;
    say('');
    say(`  ${C.dim}measured segments${C.off}`);
    say(`  ${C.dim}  ${seg(slots.slice(0, 5))}${C.off}`);
    if (slots.length >= 10) say(`  ${C.dim}  ${seg(slots.slice(5, 10))}${C.off}`);
    say(`  ${C.dim}  whole body ${m.measured.impedanceOhm} Ω = one arm + trunk + one leg${C.off}`);
  }

  // Nothing at all was computed: the weight is not a person's.
  if (!m.trust.impedanceFree) {
    say('');
    for (const f of m.flags) say(`  ${C.red}${f.message}${C.off}`);
    rule();
    return;
  }

  /*
   * Two columns, because there are genuinely two answers.
   *
   * The left is the clinical one: Mifflin-St Jeor for BMR, Janssen 2000 for
   * skeletal muscle, published and fitted against reference methods. The right
   * is what the vendor's own app shows for the same reading, which uses
   * different conventions — Katch-McArdle from lean mass, muscle as fat-free
   * mass minus their bone figure.
   *
   * Neither is wrong. They answer different questions, and showing only the
   * first made the panel look broken to anyone holding the phone app next to
   * it: BMR differed by 290 kcal and bone by two thirds of a kilo, for no
   * reason the screen explained.
   */
  const vm = m.vendorMatch || {};
  const hasVendor = Object.keys(vm).some((k) => typeof vm[k] === 'number');
  const W = Math.max(18, ...SHOW.filter(([k]) => k in m.derived || typeof vm[k] === 'number')
    .map(([, l]) => l.length)) + 2;

  /*
   * The scale's own figure leads.
   *
   * This used to lead with the clinical equations — Mifflin-St Jeor for BMR,
   * Janssen for skeletal muscle — and tuck the vendor's convention in a side
   * column. That is the wrong way round for anyone holding the phone next to
   * the terminal: the number they are checking against was in the second
   * column, and the first looked simply wrong, by 17% on BMR.
   *
   * So where the vendor convention is known, it is the number. The clinical
   * one is still shown beside it when the two genuinely differ, because they
   * answer different questions and the difference is the interesting part.
   */
  say('');
  if (hasVendor) say(`  ${C.dim}${''.padEnd(W)}${'your scale'.padEnd(15)}clinical${C.off}`);
  for (const [key, label] of SHOW) {
    const mine = m.derived[key];
    const theirs = vm[key];
    const has = (v) => v !== undefined && v !== null;
    if (!has(mine) && !has(theirs)) continue;

    const unit = m.units[key] ? ' ' + m.units[key] : '';
    const primary = has(theirs) ? theirs : mine;
    const differs = has(theirs) && has(mine) && String(theirs) !== String(mine);
    const soft = !has(theirs) && m.confidence[key] === 'derived-vendor-convention';

    say(`  ${label.padEnd(W)}${soft ? C.dim : ''}${`${primary}${unit}`.padEnd(15)}${C.off}`
      + (differs ? `${C.dim}${mine}${unit}${C.off}` : ''));
  }

  // Anything computed but not named above, so nothing is silently withheld.
  const named = new Set(SHOW.map(([k]) => k));
  const extra = Object.keys(m.derived).filter((k) => !named.has(k)
    && !['weightKg', 'impedanceOhm', 'bodyFatRecommendedKey'].includes(k));
  for (const key of extra) {
    const unit = m.units[key] ? ' ' + m.units[key] : '';
    say(`  ${C.dim}${key.padEnd(W)}${m.derived[key]}${unit}${C.off}`);
  }

  if (hasVendor) {
    say('');
    say(`  ${C.dim}The first column is what your scale shows: Katch-McArdle for BMR,`);
    say(`  ${C.dim}fat-free mass minus bone for muscle, protein as the four-compartment`);
    say(`  ${C.dim}remainder. The second is the clinical equation, where it differs.${C.off}`);
  }

  /*
   * What the phone shows and this does not, named with the reason.
   *
   * A value that is absent because no defensible formula exists looks exactly
   * like a value that is absent because of a bug. Printing the reason is the
   * only thing that tells them apart, and it is the difference between "your
   * program is broken" and "nobody knows how to compute this honestly".
   */
  if (m.omitted && Object.keys(m.omitted).length) {
    say('');
    say(`  ${C.amber}Shown by the phone app, not computed here${C.off}`);
    for (const [key, why] of Object.entries(m.omitted)) {
      say(`  ${C.dim}${key}${C.off}`);
      const wrapped = String(why).replace(/(.{1,68})(\s|$)/g, '$1\n').trim().split('\n');
      for (const line of wrapped) say(`  ${C.dim}    ${line}${C.off}`);
    }
  }
  // What the app shows and this cannot yet reproduce, named rather than absent.
  const pending = (m.vendorMatch && m.vendorMatch.unresolved) || {};
  for (const [k, why] of Object.entries(pending)) {
    say(`  ${C.amber}${k}: ${why}${C.off}`);
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
  if (LOG_FILE) say(C.dim + 'saving this session to ' + require('path').relative(ROOT, LOG_FILE) + C.off);
  rule();

  const client = new BodyScaleClient({ scaleDir: ROOT, replay: REPLAY });

  // Nudges are the whole reason the app can say something useful during a
  // stall, so they are surfaced here exactly as the app should surface them.
  let lastHint = null;
  client.on('hint', (h) => { lastHint = h; clearLive(); say(`  ${C.amber}>> ${h.message}${C.off}`); });

  /*
   * The link diary.
   *
   * Four runs against the real scale told us nothing about why it never starts
   * its impedance program, because the part that would say so goes to stderr
   * and was never shown here. That matters more than it sounds: the driver
   * gives up silently when no session id arrives —
   *
   *     if (st.session === null) return;      // drivers.js, sendProfile
   *
   * — so "the scale ignored our handshake" and "we never sent one" look
   * identical from this screen. They are opposite faults with opposite fixes,
   * and guessing between them is what cost those four runs.
   *
   * So the lines that decide it are shown: the session frame, each write, and
   * any write the transport could not deliver. --verbose shows everything.
   */
  const DIARY = /session|wrote|write .*fail|cannot write|subscrib|impedance|record channel|Dr Trust|error/i;
  const VERBOSE = argv.includes('--verbose');
  client.on('log', (line) => {
    const s = String(line).replace(/\s+$/, '');
    if (!s.trim()) return;
    if (VERBOSE || DIARY.test(s)) { clearLive(); say(`  ${C.dim}· ${s.trim()}${C.off}`); }
  });

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

  /*
   * Who the scale is told it is measuring, remembered between runs.
   *
   * This went through two wrong designs before this one. Asking up front, every
   * time, made someone fill in a form before they could stand on a scale. Then
   * sending a pure placeholder — 170 cm, 30 years — stopped the sweep running
   * at all: the scale replayed its stored record instead of measuring, giving
   * back a reading identical to the previous one down to the weight.
   *
   * So the identity is real but asked for at most once. It is written to the
   * scale during the handshake, and updated from whatever is entered after a
   * reading, which is where the details belong. The measurement itself is still
   * deferred: nothing is computed until the details are given.
   */
  const WHO_FILE = require('path').join(ROOT, 'logs', 'profile.json');
  const readWho = () => {
    try {
      const w = JSON.parse(require('fs').readFileSync(WHO_FILE, 'utf8'));
      if (w && w.sex && w.age > 0 && w.heightCm > 0) return w;
    } catch (e) { /* first run, or unreadable */ }
    return null;
  };
  const saveWho = (w) => {
    try {
      require('fs').mkdirSync(require('path').dirname(WHO_FILE), { recursive: true });
      require('fs').writeFileSync(WHO_FILE, JSON.stringify(w, null, 2) + '\n');
    } catch (e) { /* not being able to remember is not worth failing over */ }
  };

  let who = readWho();
  if (who) {
    say('');
    say(`  ${C.dim}measuring ${who.heightCm} cm, ${who.age}y, ${who.sex} `
      + `— remembered, and sent to the scale before you step on${C.off}`);
  } else {
    say('');
    say(`  ${C.bold}Who is the scale measuring?${C.off}`);
    say(`  ${C.dim}Asked once. The scale needs a real identity during the handshake or it${C.off}`);
    say(`  ${C.dim}replays its last record instead of measuring. Remembered from here on.${C.off}`);
    who = {
      sex: await askValid(`  Sex ${C.dim}[male]${C.off} `, {
        parse: (v) => v.toLowerCase(), fallback: 'male',
        valid: (v) => v === 'male' || v === 'female', hint: 'Enter male or female.',
      }),
      age: await askValid('  Age  ', {
        parse: Number, valid: (v) => Number.isFinite(v) && v >= 5 && v <= 120,
        hint: 'Enter an age between 5 and 120.',
      }),
      heightCm: await askValid('  Height in cm  ', {
        parse: Number, valid: (v) => Number.isFinite(v) && v >= 90 && v <= 250,
        hint: 'Enter a height between 90 and 250 cm.',
      }),
    };
    saveWho(who);
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
        // Off unless asked for: the scale runs a second program after the
        // body-composition sweep, and what it produces is not yet known.
        secondProgramWaitSec: Number(arg('--second-program', 0)),
        // Written to the scale during the handshake, and used for nothing
        // else: the reading stays deferred until details are entered below.
        scaleProfile: who,
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

    const sex = await askValid(`  Sex ${C.dim}[${who.sex}]${C.off} `, {
      parse: (v) => v.toLowerCase(), fallback: who.sex,
      valid: (v) => v === 'male' || v === 'female',
      hint: 'Enter male or female.',
    });
    const age = await askValid(`  Age ${C.dim}[${who.age}]${C.off} `, {
      parse: Number, fallback: who.age,
      valid: (v) => Number.isFinite(v) && v >= 5 && v <= 120,
      hint: 'Enter an age between 5 and 120.',
    });
    const heightCm = await askValid(`  Height in cm ${C.dim}[${who.heightCm}]${C.off} `, {
      parse: Number, fallback: who.heightCm,
      valid: (v) => Number.isFinite(v) && v >= 90 && v <= 250,
      hint: 'Enter a height between 90 and 250 cm.',
    });

    // ------------------------------------------------------------- RESULT
    // What was just entered is who the scale measures next time.
    who = { sex, age, heightCm };
    saveWho(who);

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
