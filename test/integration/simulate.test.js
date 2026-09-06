'use strict';
// INT-SIM — the rehearsal: capture, hold, compute.
//
// simulate.js is the reference implementation of the flow the Electron app has
// to get right, and it is not a mock: it drives the real `scale.js --serve`
// through the real BodyScaleClient over the real pipe.
//
//     IDLE --"Measure Me"--> CAPTURING --reading--> HELD --details--> RESULT
//       ^                                                              |
//       +--------------------------------------------------------------+
//
// The state that earns the whole design is HELD. Once a reading is captured it
// is LATCHED: the scale may be stepped on, off and on again and nothing is
// re-read, because the service only reads when it is asked to. That is what
// stops a panel changing under someone while they are typing their age.
//
// Every run here passes --replay, so no radio is touched, and every run points
// BODYSCALE_CONFIG_DIR at a scratch directory, so the developer's own
// remembered scale is neither read nor written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./harness');

const SIMULATE = path.join(H.ROOT, 'simulate.js');

/** One full pass: Measure Me, sex, age, height, then quit. */
const FULL = ['', 'male', '39', '180', 'q'];

/** The two nudges, verbatim, as the service words them. */
const WAKE = 'Step on the scale to wake it, then wait a moment.';
const STEP_OFF = 'Step off the scale and step back on.';

/**
 * Run simulate.js with scripted answers on stdin and collect its transcript.
 *
 * simulate.js reads the whole of stdin once when stdin is not a TTY and takes
 * answers from it in order, so the script is written and the pipe closed
 * immediately. The wait is bounded and the child is killed if it overruns: a
 * hung rehearsal must fail as a hang, not as a silent pass.
 *
 * @param {object}   opts
 * @param {string[]} opts.script      one answer per prompt, in order
 * @param {string}   [opts.fixture]   replay fixture; the recorded session by default
 * @param {object}   [opts.env]       extra environment
 * @param {string}   [opts.configDir] reuse a scratch config dir across runs
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, signal:string|null, configDir:string}>}
 */
/*
 * The rehearsal now opens by asking who the scale is measuring, because that
 * identity goes into the handshake before anyone steps on. Every script would
 * otherwise have to carry the same three answers, and a test that forgot them
 * would fail somewhere far from the cause, so the harness supplies them.
 * Pass `identity` to override, or `identity: []` to script them by hand.
 */
const WHO = ['male', '39', '180'];

function run({ script, fixture = null, env = {}, configDir = null, timeoutMs = 15000,
              identity = WHO }) {
  script = identity.concat(script);
  const dir = configDir || H.configDir('sim');
  const argv = [SIMULATE, '--replay'];
  if (fixture) argv.push(fixture);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: H.ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: dir }, env),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    // Killing simulate.js closes the service's stdin, and `scale.js --serve`
    // exits when that happens, so an overrun leaves nothing behind.
    const timer = setTimeout(() => finish(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      reject(new Error(`simulate.js did not finish within ${timeoutMs} ms.\n--- stdout so far ---\n${stdout}`));
    }), timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    // The rehearsal quits as soon as it reads 'q', which can close the pipe
    // under a write still in flight. That is an ordinary ending, not a fault.
    // It cannot hide a failure: a script that never arrives leaves the run
    // stuck at IDLE, and every test below asserts on the states it reached.
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code, signal) =>
      finish(() => resolve({ stdout, stderr, code, signal, configDir: dir })));

    child.stdin.end(script.map((line) => line + '\n').join(''));
  });
}

/** The state banners, in the order they were printed. */
const states = (out) => (out.match(/^\[[A-Z]+\]/gm) || []).map((s) => s.slice(1, -1));

/** Every nudge the rehearsal put on screen, in order, without its `>> ` marker. */
const nudges = (out) => (out.match(/^ {2}>> (.+)$/gm) || []).map((s) => s.slice(5));

/** Quote a sentence so it can be matched literally. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The failure the rehearsal reported, as a code and a sentence.
 * Anchored on the service's own list of codes so a panel row such as
 * `BMI               30.2 kg/m²` can never be mistaken for one.
 */
function failure(out) {
  const m = out.match(new RegExp(`^ {2}(${H.ALL_ERROR_CODES.join('|')}) {2}(.+)$`, 'm'));
  return m ? { code: m[1], message: m[2] } : null;
}

/** The transcript from a banner onwards. */
function from(out, marker) {
  const i = out.indexOf(marker);
  assert.ok(i >= 0, `the transcript contains ${marker}`);
  return out.slice(i);
}

/** One labelled row of the computed panel; labels are padded to 18 columns. */
function row(panel, label) {
  const m = panel.match(new RegExp(`^\\s+${label} {2,}(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * The same, but the row must exist.
 *
 * row() returning null for two runs would make them compare equal, so every
 * comparison of one panel against another goes through this instead.
 */
function mustRow(panel, label) {
  const v = row(panel, label);
  assert.ok(v !== null, `the panel has a ${label} row`);
  return v;
}

/** The panel's headline body-fat figure, as printed. */
const fatOf = (r) => mustRow(from(r.stdout, '[COMPUTING]'), 'Body fat');

// Prevents: an app built to the wrong flow — computing while the scale is still
// connected, or skipping the hold — because the rehearsal never pinned the
// states down. The order is the contract the Electron app implements.
test('INT-SIM-01  a full pass walks IDLE, CAPTURING, HELD, COMPUTING and returns to IDLE', async () => {
  const r = await run({ script: FULL });
  assert.deepStrictEqual(states(r.stdout),
    ['IDLE', 'CAPTURING', 'HELD', 'COMPUTING', 'IDLE'],
    'each state is entered once, in order, and the loop comes back to IDLE');
  assert.strictEqual(r.code, 0, 'and the run ends cleanly');
  assert.match(r.stdout, /stopped\n$/, 'saying so');
});

// Prevents: a HELD panel that shows a stale or invented reading. These are the
// two numbers the hardware actually sent; everything later is derived from them.
test('INT-SIM-02  HELD reports the captured weight and impedance', async () => {
  const r = await run({ script: FULL });
  const held = from(r.stdout, '[HELD]');

  const weight = held.match(/^\s+weight\s+([0-9.]+) kg$/m);
  assert.ok(weight, 'the HELD block prints a weight in kilograms');
  assert.strictEqual(Number(weight[1]), H.EXPECTED.weightKg);

  const impedance = held.match(/^\s+impedance\s+([0-9.]+) Ω$/m);
  assert.ok(impedance, 'and an impedance in ohms');
  assert.strictEqual(Number(impedance[1]), H.EXPECTED.impedanceOhm);

  assert.match(held, /^\s+taken at\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z$/m,
    'and when it was taken, so the reading can be dated later');
});

// Prevents: someone reading the HELD panel as a finished result, or fearing
// that stepping back on the scale will overwrite it while they type their age.
test('INT-SIM-03  HELD says nothing is computed yet and that the reading is latched', async () => {
  const r = await run({ script: FULL });
  const held = from(r.stdout, '[HELD]');

  assert.match(held, /Waiting for your details before anything is computed\./);
  assert.match(held, /The scale link is already closed\./);
  assert.match(held, /nothing is re-read until you press Measure Me again\./);

  const askedAt = held.indexOf('  Sex ');
  assert.ok(askedAt > 0, 'the details are asked for after the hold, not before it');
  const beforeDetails = held.slice(0, askedAt);
  assert.ok(!/Body fat|BMI|Muscle mass/.test(beforeDetails),
    'and nothing is interpreted while they are still being asked for');
});

// Prevents: a naked number on screen. "36" is not a body fat figure until it
// carries its unit, and a BMI without kg/m² is indistinguishable from a weight.
test('INT-SIM-04  the computed panel shows body fat, muscle mass and BMI with their units', async () => {
  const r = await run({ script: FULL });
  const panel = from(r.stdout, '[COMPUTING]');

  const fat = panel.match(/^\s+Body fat {2,}([0-9.]+) %$/m);
  const muscle = panel.match(/^\s+Muscle mass {2,}([0-9.]+) kg$/m);
  const bmi = panel.match(/^\s+BMI {2,}([0-9.]+) kg\/m²$/m);
  assert.ok(fat, 'body fat is a percentage');
  assert.ok(muscle, 'muscle mass is in kilograms');
  assert.ok(bmi, 'BMI is in kg/m²');

  assert.ok(Number(fat[1]) > 5 && Number(fat[1]) < 60, `body fat ${fat[1]} % is plausible`);
  assert.ok(Number(muscle[1]) > 10 && Number(muscle[1]) < H.EXPECTED.weightKg,
    `muscle mass ${muscle[1]} kg is part of the body, not more than all of it`);
  // 97.9 kg at 180 cm is 30.2, and BMI is arithmetic, not estimation.
  assert.ok(Math.abs(Number(bmi[1]) - 30.2) < 0.1,
    `BMI ${bmi[1]} matches the weight and height that were entered`);

  assert.match(panel, /^\s+BMR {2,}\d+ kcal\/day$/m, 'and BMR carries its unit too');
});

// Prevents: a body fat figure of unknown provenance. One comes from a measured
// impedance, the other is a guess anchored on BMI, and they are not the same
// claim — presenting them identically would overstate the second.
test('INT-SIM-05  the recommended body fat line says it came from impedance', async () => {
  const r = await run({ script: FULL });
  const panel = from(r.stdout, '[COMPUTING]');

  const rec = panel.match(/^\s+([0-9.]+) % body fat \(from impedance\)$/m);
  assert.ok(rec, 'the headline figure names impedance as its source');
  assert.strictEqual(`${rec[1]} %`, mustRow(panel, 'Body fat'),
    'and it is the impedance-derived figure, not some other number');
  assert.ok(!/from BMI/.test(panel), 'the BMI-anchored wording is not shown as well');
});

// Prevents: a BMI-anchored estimate silently presented as a measurement when
// the scale sent no impedance — the reading a person is most likely to get by
// standing on the scale in socks.
test('INT-SIM-06  with no impedance the recommended line names BMI instead', async () => {
  const r = await run({ script: FULL, fixture: H.fixtureWithoutImpedance('sim-noimp') });
  const held = from(r.stdout, '[HELD]');
  assert.match(held, /^\s+impedance\s+none sent$/m, 'HELD says plainly that none arrived');

  const panel = from(r.stdout, '[COMPUTING]');
  assert.match(panel, /no impedance/, 'and so does the panel');
  assert.match(panel, /^\s+([0-9.]+) % body fat \(from BMI; the impedance failed its checks\)$/m);

  // Not one impedance-derived row is invented to fill the gap.
  for (const label of ['Body fat', 'Fat mass', 'Muscle mass', 'Skeletal muscle',
                       'Body water', 'Water', 'Bone mass', 'Protein', 'Fat-free mass']) {
    assert.strictEqual(row(panel, label), null, `no ${label} row without an impedance`);
  }
  assert.match(panel, /^\s+BMI {2,}[0-9.]+ kg\/m²$/m, 'BMI still stands: it needs no impedance');
  assert.match(panel, /^\s+BMR {2,}\d+ kcal\/day$/m, 'and so does BMR');
  assert.strictEqual(r.code, 0);
});

// Prevents: a rejected answer that leaves the person guessing what was wanted,
// or a rejection that abandons the reading instead of asking again.
test('INT-SIM-07  an invalid sex is rejected by name, and the latched reading survives it', async () => {
  const r = await run({ script: ['', 'nope', 'male', '39', '180', 'q'] });
  assert.match(r.stdout, /Enter male or female\./, 'the rejection names what is accepted');
  assert.strictEqual((r.stdout.match(/Enter male or female\./g) || []).length, 1,
    'once, for the one bad answer');
  assert.deepStrictEqual(states(r.stdout), ['IDLE', 'CAPTURING', 'HELD', 'COMPUTING', 'IDLE'],
    'and the pass finishes: a typo does not send anyone back to the scale');

  const panel = from(r.stdout, '[COMPUTING]');
  assert.match(panel, /% body fat/);
  const shown = panel.match(/^\s+([0-9.]+) kg {2,}([0-9.]+) Ω$/m);
  assert.ok(shown, 'the panel restates the pair it worked from');
  assert.strictEqual(Number(shown[1]), H.EXPECTED.weightKg,
    'which is still the reading captured before the typo, not a fresh one');
  assert.strictEqual(r.code, 0);
});

// Prevents: an out-of-range age being quietly accepted and silently poisoning
// every derived figure, or a rejection that does not say what the range is.
test('INT-SIM-08  an invalid age is rejected with its range, and is not used', async () => {
  const [rejected, clean] = await Promise.all([
    run({ script: ['', 'male', '3', '39', '180', 'q'] }),
    run({ script: FULL }),
  ]);
  assert.match(rejected.stdout, /Enter an age between 5 and 120\./);
  assert.deepStrictEqual(states(rejected.stdout),
    ['IDLE', 'CAPTURING', 'HELD', 'COMPUTING', 'IDLE']);

  const LABELS = ['Body fat', 'Muscle mass', 'BMR'];
  // mustRow, not row: two panels that both printed nothing would otherwise
  // compare equal and this test would pass with an empty screen.
  const shape = (r) => {
    const panel = from(r.stdout, '[COMPUTING]');
    return LABELS.map((l) => `${l}=${mustRow(panel, l)}`).join(' ');
  };
  const rejectedShape = shape(rejected);
  assert.match(rejectedShape, /BMR=\d+ kcal\/day/, 'the panel really was computed');
  assert.strictEqual(rejectedShape, shape(clean),
    'the answer that was rejected contributed nothing; only the accepted 39 did');
  assert.strictEqual(rejected.code, 0);
});

// Prevents: a mistyped height sailing through. Height squares into BMI, so a
// wrong one is not a small error — it changes the category a person is told.
test('INT-SIM-09  an invalid height is rejected with its range, and is not used', async () => {
  const r = await run({ script: ['', 'male', '39', '999', '180', 'q'] });
  assert.match(r.stdout, /Enter a height between 90 and 250 cm\./);
  assert.deepStrictEqual(states(r.stdout), ['IDLE', 'CAPTURING', 'HELD', 'COMPUTING', 'IDLE']);

  const bmi = Number(mustRow(from(r.stdout, '[COMPUTING]'), 'BMI').replace(' kg/m²', ''));
  // 999 cm would have given a BMI near 1. The accepted 180 cm gives 30.2.
  assert.ok(Math.abs(bmi - 30.2) < 0.1, `BMI ${bmi} is the one for 180 cm, not for 999`);
  assert.strictEqual(r.code, 0);
});

// Prevents: a prompt that advertises a default it does not actually apply, so
// pressing Enter produces either a rejection or somebody else's numbers.
test('INT-SIM-10  an empty sex takes the stated default', async () => {
  const [blank, male, female] = await Promise.all([
    run({ script: ['', '', '39', '180', 'q'] }),
    run({ script: FULL }),
    run({ script: ['', 'female', '39', '180', 'q'] }),
  ]);
  assert.match(blank.stdout, /Sex \[male\]/, 'the prompt states its default');
  assert.strictEqual(fatOf(blank), fatOf(male),
    'and an empty answer is read as exactly that default');
  assert.notStrictEqual(fatOf(male), fatOf(female),
    'sex genuinely changes the result, so the match above is not a coincidence');
  assert.strictEqual(blank.code, 0);
});

// Prevents: a rehearsal that cannot be left — hanging on a closed stdin, or
// exiting non-zero so a scripted check reports a failure that did not happen.
test('INT-SIM-11  q at the IDLE prompt exits cleanly and says it stopped', async () => {
  const r = await run({ script: ['q'] });
  assert.deepStrictEqual(states(r.stdout), ['IDLE'], 'nothing was ever captured');
  assert.ok(!/CAPTURING|HELD|COMPUTING/.test(r.stdout));
  assert.match(r.stdout, /stopped\n$/);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.signal, null, 'it exited on its own, it was not killed');
});

// THE point of the design. If a capture could start on its own, a panel would
// change under someone mid-sentence. Only Measure Me reads, and it reads once.
test('INT-SIM-12  two passes capture exactly twice, in the exact expected order', async () => {
  const r = await run({ script: ['', 'male', '39', '180', '', 'female', '30', '165', 'q'] });
  assert.deepStrictEqual(states(r.stdout), [
    'IDLE', 'CAPTURING', 'HELD', 'COMPUTING',
    'IDLE', 'CAPTURING', 'HELD', 'COMPUTING',
    'IDLE',
  ], 'no capture appears between a HELD and the next Measure Me');
  assert.strictEqual((r.stdout.match(/\[CAPTURING\]/g) || []).length, 2,
    'one capture per press, no more');
  assert.strictEqual((r.stdout.match(/\[HELD\]/g) || []).length, 2);
  assert.strictEqual(r.code, 0);
});

// Prevents: the reading drifting between the hold and the panel — a different
// weight computed from the one the person was shown and agreed to.
test('INT-SIM-13  the panel computes the very reading that was latched', async () => {
  const r = await run({ script: FULL });
  const held = from(r.stdout, '[HELD]');
  const latchedWeight = held.match(/^\s+weight\s+([0-9.]+) kg$/m);
  const latchedImpedance = held.match(/^\s+impedance\s+([0-9.]+) Ω$/m);
  assert.ok(latchedWeight && latchedImpedance, 'HELD printed the pair it latched');

  const panel = from(r.stdout, '[COMPUTING]');
  const shown = panel.match(/^\s+([0-9.]+) kg {2,}([0-9.]+) Ω$/m);
  assert.ok(shown, 'the panel restates the pair it worked from');
  assert.strictEqual(shown[1], latchedWeight[1], 'the same weight, unchanged');
  assert.strictEqual(shown[2], latchedImpedance[1], 'and the same impedance');
});

// Prevents: a rehearsal being mistaken for a live reading. Numbers that came
// off a recording must never be filed as somebody's actual measurement. Also
// prevents escape codes reaching a piped transcript, which is what a script or
// a log would capture.
test('INT-SIM-14  the run announces that it is replaying, names the service, and stays plain text', async () => {
  const r = await run({ script: ['q'] });
  assert.match(r.stdout, /Body scale — Electron flow rehearsal/);
  assert.match(r.stdout, /Replaying a recorded session: no Bluetooth is involved\./);
  assert.match(r.stdout, /^\s+service \S+, protocol 1, on \S+$/m,
    'and reports the real service it handshook with');
  assert.match(r.stdout, /no scale remembered yet/,
    'reading its remembered device from the scratch config, which is empty');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\x1b\[/.test(r.stdout), 'no ANSI escape survives into a piped transcript');
  assert.strictEqual(r.code, 0);
});

// Prevents: a stack trace on screen instead of a sentence. A failure a person
// can fix must read as advice; internals leaking makes it read as a crash.
test('INT-SIM-15  a failure is a code and a sentence, and no stack trace ever reaches stdout', async () => {
  const notFound = H.fixture('sim-notfound', [{ t: 'end', reason: 'not-found' }]);
  const [ok, bad] = await Promise.all([
    run({ script: FULL }),
    run({ script: ['', 'q'], fixture: notFound }),
  ]);

  assert.deepStrictEqual(failure(bad.stdout),
    { code: 'DEVICE_NOT_FOUND', message: 'no scale answered; its radio sleeps when idle' },
    'the code and the sentence are both on screen');
  assert.deepStrictEqual(states(bad.stdout), ['IDLE', 'CAPTURING', 'IDLE'],
    'a failure computes nothing and goes back to IDLE');
  assert.strictEqual(failure(ok.stdout), null, 'and a good run reports no failure at all');

  for (const [name, r] of [['the happy path', ok], ['the failure path', bad]]) {
    assert.strictEqual(r.code, 0, `${name} exits 0 on a scripted run ending in q`);
    assert.ok(!/^\s+at .+ \(.+\)$/m.test(r.stdout), `${name} prints no stack frame`);
    assert.ok(!/node:internal|Error: .*\n\s+at /.test(r.stdout), `${name} leaks no internals`);
    assert.strictEqual(r.stderr, '', `${name} spills nothing on stderr either`);
  }
});

// Prevents: the rehearsal reading or overwriting the developer's real remembered
// scale, and prevents a profile being written to disk — the host owns age,
// height and sex, and this service must never remember them.
test('INT-SIM-16  the remembered scale lands in the config directory it was given', async () => {
  const dir = H.configDir('sim-cfg');
  const firstRun = await run({ script: FULL, configDir: dir });
  assert.match(firstRun.stdout, /no scale remembered yet/, 'the scratch directory started empty');

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.strictEqual(saved.name, H.EXPECTED.name, 'the scale it met was written there');
  assert.ok(!('profile' in saved), 'and no age, height or sex went to disk with it');

  const secondRun = await run({ script: FULL, configDir: dir });
  assert.match(secondRun.stdout, new RegExp(`remembered ${H.EXPECTED.name}`),
    'so the next run starts from what it remembered, not from the repository');
  assert.strictEqual(secondRun.code, 0);
});

/*
 * The two slow cases are last, so the sixteen fast ones report first.
 *
 * simulate.js calls measureWithoutProfile() with no options, so it cannot pass
 * hintAfterSec and the first nudge lands at the service's eight-second default.
 * Both tests therefore have to outlast that; both bound their own wait, and
 * both assert ordering and presence rather than any millisecond.
 */

// Prevents: the worst stall in the product — connected, subscribed, and
// silent — showing as an endless spinner. The person is the only one who can
// fix it, so the service must name STEP_OFF_AND_ON, and the advice must not
// change what the measurement then does.
test('INT-SIM-17  a connected-but-silent scale is nudged to step off and on, and still fails the same way', async () => {
  const stalled = () => H.fixture('sim-stall', [
    { t: 'log', level: 'info', msg: 'replaying a stalled session' },
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'services', items: [{
      service: '0000ffb0-0000-1000-8000-00805f9b34fb',
      char: '0000ffb2-0000-1000-8000-00805f9b34fb',
      props: ['notify'],
    }] },
    { t: 'ready' },
    // No frames and no end: the link stays up, holding a stale reading, which
    // is the condition the nudge exists for. REPLAY_HOLD_MS keeps it there.
  ]);

  // Two identical stalls, one held long enough to be nudged and one not. The
  // control is what proves the nudge is advisory: it changes the screen and
  // nothing else.
  const [nudged, quiet] = await Promise.all([
    run({ script: ['', 'q'], fixture: stalled(), timeoutMs: 20000,
          env: { REPLAY_HOLD_MS: '12000' } }),            // the nudge lands at 8 s
    run({ script: ['', 'q'], fixture: stalled(), timeoutMs: 15000,
          env: { REPLAY_HOLD_MS: '1000' } }),             // over well before then
  ]);

  assert.ok(nudges(nudged.stdout).length >= 1, 'the stall is named rather than left as a spinner');
  assert.deepStrictEqual([...new Set(nudges(nudged.stdout))], [STEP_OFF],
    'and it is named as the stall it actually is');
  assert.ok(!nudged.stdout.includes(WAKE), 'not as the other one, which would send the person to a scale they are stood on');

  const nudgeAt = nudged.stdout.indexOf(`>> ${STEP_OFF}`);
  const failAt = nudged.stdout.indexOf('NO_READING');
  assert.ok(nudgeAt >= 0 && failAt > nudgeAt,
    'the advice came first, while there was still time to act on it');
  assert.match(nudged.stdout, new RegExp(`Last hint was: ${esc(STEP_OFF)}`),
    'and it is repeated with the failure, so it is still on screen afterwards');

  assert.deepStrictEqual(nudges(quiet.stdout), [],
    'a stall that ends before eight seconds nags nobody');
  assert.deepStrictEqual(failure(nudged.stdout),
    { code: 'NO_READING', message: 'connected but no reading arrived' });
  assert.deepStrictEqual(failure(nudged.stdout), failure(quiet.stdout),
    'a nudge is advice: it never changes the outcome');
  assert.deepStrictEqual(states(nudged.stdout), states(quiet.stdout));
  assert.deepStrictEqual(states(nudged.stdout), ['IDLE', 'CAPTURING', 'IDLE'],
    'a failure computes nothing and goes back to IDLE');
  assert.strictEqual(nudged.code, 0, 'a stall is not a crash');
  assert.strictEqual(quiet.code, 0);
});

// Prevents: the other stall — a scan that finds nothing — being nudged with the
// wrong advice, or with none. The scale's radio is asleep and only a foot wakes
// it, which is a different instruction from stepping off a scale you are on.
test('INT-SIM-18  a scan that finds nothing is nudged to wake the scale, and still fails the same way', async () => {
  // One second per line: the scan is nudged at eight, and gives up at eleven.
  // The padding lines match neither /scanning/ nor /advertisement/, so they
  // neither restart nor clear the nudge — they only keep the recording running.
  const searching = [{ t: 'log', level: 'info', msg: 'scanning for SSW533' }];
  for (let i = 0; i < 10; i++) searching.push({ t: 'log', level: 'info', msg: 'still nothing' });
  searching.push({ t: 'end', reason: 'not-found' });

  const [nudged, instant] = await Promise.all([
    run({ script: ['', 'q'], fixture: H.fixture('sim-scan', searching), timeoutMs: 20000,
          env: { REPLAY_DELAY_MS: '1000' } }),
    run({ script: ['', 'q'], fixture: H.fixture('sim-scan-fast', [{ t: 'end', reason: 'not-found' }]),
          timeoutMs: 15000 }),
  ]);

  assert.ok(nudges(nudged.stdout).length >= 1, 'a fruitless scan says what to do about it');
  assert.deepStrictEqual([...new Set(nudges(nudged.stdout))], [WAKE],
    'and it is the wake-the-scale advice, not the step-off-and-on one');
  assert.ok(!nudged.stdout.includes(STEP_OFF), 'the service says which stall this is');

  const nudgeAt = nudged.stdout.indexOf(`>> ${WAKE}`);
  const failAt = nudged.stdout.indexOf('DEVICE_NOT_FOUND');
  assert.ok(nudgeAt >= 0 && failAt > nudgeAt, 'the advice came before the giving up');
  assert.match(nudged.stdout, new RegExp(`Last hint was: ${esc(WAKE)}`));

  assert.deepStrictEqual(nudges(instant.stdout), [],
    'a scan that fails at once nags nobody');
  assert.deepStrictEqual(failure(nudged.stdout),
    { code: 'DEVICE_NOT_FOUND', message: 'no scale answered; its radio sleeps when idle' });
  assert.deepStrictEqual(failure(nudged.stdout), failure(instant.stdout),
    'a nudge is advice: it never changes the outcome');
  assert.deepStrictEqual(states(nudged.stdout), ['IDLE', 'CAPTURING', 'IDLE']);
  assert.strictEqual(nudged.code, 0);
  assert.strictEqual(instant.code, 0);
});
