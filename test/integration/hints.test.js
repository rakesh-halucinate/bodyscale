'use strict';
/**
 * INT-HINT — nudges: telling the user what only they can fix.
 *
 * Two stalls are nobody's fault but physics. A scan that finds nothing means
 * the scale's radio has gone to sleep and needs standing on. A link that is up
 * and subscribed but silent means the scale is sitting on a stale reading and
 * needs a step off and back on. Both look identical to a spinner, so the
 * service names which one it is and the host can put a sentence on screen
 * instead of leaving somebody watching nothing happen.
 *
 * A nudge is ADVICE, not a step in the measurement. It has its own event type,
 * it never ends a measurement, and it never changes the outcome. Everything
 * here checks both halves: that the advice arrives, and that it stays advice.
 * The service documents three things that silence it — an advertisement, a
 * live weight, the measurement finishing — and there is a case for each.
 *
 * Driven through the real `scale.js --serve` over a real pipe, plus one case on
 * the one-shot CLI. The radio is replaced by one-off replay fixtures, and
 * REPLAY_HOLD_MS makes the stand-in transport stay connected and silent after
 * the recording runs out, which is exactly how a real scale behaves while it
 * holds an old reading. No hardware.
 *
 * TIMING. `timeoutSec` and `--hold` have no effect under --replay: scale.js
 * only forwards them in the argv it builds for ble.py, and the replay branch
 * spawns replay.js instead. Every case here is therefore bounded by
 * REPLAY_HOLD_MS, or by REPLAY_DELAY_MS x lines for a fixture that ends with
 * `t:end`. Nothing waits on a harness timeout. Where a nudge has to land before
 * some later event, the fixture is spaced so the gap is at least half a nudge
 * interval, and the assertions count nudges and compare orderings rather than
 * measuring milliseconds.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const H = require('./harness');
const { BodyScaleClient } = require(H.CLIENT);

/** Last-resort ceiling. The slowest case here settles in about 8 s. */
const T = { timeout: 25000 };

/** The two codes the service documents, and nothing else. */
const CODES = ['WAKE_THE_SCALE', 'STEP_OFF_AND_ON'];

/** The six progress phases (grep for `emit({ phase:` in scale.js). */
const KNOWN_PHASES = ['scanning', 'found', 'connected', 'ready', 'settling', 'settled'];

const FFB0 = '0000ffb0-0000-1000-8000-00805f9b34fb';
const FFB2 = '0000ffb2-0000-1000-8000-00805f9b34fb';
const FFB3 = '0000ffb3-0000-1000-8000-00805f9b34fb';

/* ------------------------------------------------------------- fixtures ---- */

const SCANNING = { t: 'log', level: 'info', msg: 'scanning for SSW533' };
const DEVICE = { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' };
const SERVICES = { t: 'services', items: [{ service: FFB0, char: FFB2, props: ['notify'] }] };
const READY = { t: 'ready' };
/** Worded as ble.py words it, because that wording is what arms and clears. */
const ADVERT = { t: 'log', level: 'info',
  msg: 'advertisement from SSW533 after 2412 ms (matched by name, rssi -61)' };
/** Transport chatter that is neither a scan nor an advertisement: pure padding. */
const CHATTER = { t: 'log', level: 'info', msg: 'still listening' };
/** The same, for the scan: a line that arms nothing and clears nothing. */
const NO_MATCH = { t: 'log', level: 'debug', msg: 'no match yet' };
/** A 0xFFB2 live-weight frame: status 0x01 (settling), 69.25 kg. */
const WEIGHT_FRAME = { t: 'frame', uuid: FFB2, hex: '3e 00 07 00 a2 01 00 01 0e 82 00 14' };
/** The 0xFFB3 weight record, subtype 0x00: 97.9 kg, no impedance. */
const RECORD_FRAME = { t: 'frame', uuid: FFB3,
  hex: '30 00 23 00 a7 00 00 00 00 25 01 7e 6c 00 0a 00 00 00 00 00 00 00 00 00 '
     + '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 08' };
/** Subtype 0x01: the impedances, summing to 529.9 ohm. */
const IMPEDANCE_FRAME = { t: 'frame', uuid: FFB3, hex: '31 00 23 00 a7 00 00 14 b3 00 01 7e 6c 00 0a 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 11 00 00 00 00 0a' };

/**
 * Connected, subscribed, and then nothing. The recording deliberately carries
 * no `end`, so REPLAY_HOLD_MS decides how long the silence lasts.
 */
const connectedButSilent = (tag) => H.fixture(tag, [SCANNING, DEVICE, SERVICES, READY]);

/**
 * A scan that never sees an advertisement and gives up.
 *
 * The padding is what makes the scan take time. Spacing two lines far apart
 * would do it too, but the stand-in transport then sits on the pipe long after
 * the answer has been given, and the case takes twice as long for nothing.
 */
const neverAdvertised = (tag, pad) => H.fixture(tag,
  [SCANNING, ...Array(pad).fill(NO_MATCH), { t: 'end', reason: 'not-found' }]);

/**
 * A scan that stalls, is answered by an advertisement, and then goes quiet
 * again without ever connecting.
 *
 * At 700 ms a line the advertisement lands at 3.5 s — half a nudge interval
 * away from the 3 s nudge, so neither can race the other into the stream — and
 * 2.1 s of silence follows it, which is room for two nudges that must not come.
 */
const advertisedThenQuiet = (tag) => H.fixture(tag, [
  SCANNING, NO_MATCH, NO_MATCH, NO_MATCH, NO_MATCH,
  ADVERT,
  NO_MATCH, NO_MATCH, { t: 'end', reason: 'not-found' },
]);

/**
 * A link that comes up, stalls long enough to nudge, and then delivers a whole
 * reading in one frame. The record frame carries weight AND impedance, so the
 * measurement completes the moment it lands instead of waiting out a hold.
 */
const slowButGood = (tag) => H.fixture(tag,
  [SCANNING, DEVICE, SERVICES, READY, CHATTER, CHATTER, RECORD_FRAME, IMPEDANCE_FRAME]);

/* -------------------------------------------------------------- driving ---- */

/** Run one measurement over a chosen fixture and sort the stream out. */
function run({ replay, env = {}, options = {}, id = 'm1', timeoutMs = 20000 }) {
  return H.serve({
    replay,
    env,
    timeoutMs,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send(Object.assign({ id, cmd: 'measure', profile: H.PROFILE }, options));
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === id;
    },
  }).then(({ events }) => ({
    events,
    hints: H.byType(events, 'hint'),
    progress: H.byType(events, 'progress'),
    hello: H.first(events, 'hello'),
    terminal: events.find((e) => (e.type === 'measurement' || e.type === 'error') && e.id === id),
  }));
}

/**
 * Stall on a live but silent link for `holdMs`, nudging every `hintAfterSec`.
 *
 * The measurement ends when the stand-in transport finally exits, so holdMs is
 * the whole bound on the case: nothing here waits on a harness timeout.
 */
const stalled = (tag, { holdMs = 3000, ...options } = {}) =>
  run({ replay: connectedButSilent(tag), env: { REPLAY_HOLD_MS: String(holdMs) }, options });

/** Stall in the scan for `pad` lines of 700 ms, then report not-found. */
const scanning = (tag, { pad = 4, ...options } = {}) =>
  run({ replay: neverAdvertised(tag, pad), env: { REPLAY_DELAY_MS: '700' }, options });

/** Stall on a live link, then take a complete reading 3.6 s in. */
const stalledThenRead = (tag, options) =>
  run({ replay: slowButGood(tag), env: { REPLAY_DELAY_MS: '600' }, options });

/** Everything a measurement envelope carries except the clock reading. */
const withoutTimestamp = (m) => { const { timestamp, ...rest } = m; return rest; };

/** Bound a promise that has no bound of its own, without holding the loop open. */
function settleWithin(promise, ms, what) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/** Run the one-shot CLI to completion, killing it if it will not finish. */
function cli(args, { env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [H.SCALE, ...args], {
      cwd: H.ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env,
        { BODYSCALE_CONFIG_DIR: H.configDir('hintcli') }, env),
    });
    let stdout = '', stderr = '', settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(
      new Error(`the CLI did not finish within ${timeoutMs} ms`))), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));
  });
}

/* ------------------------------------------------------ the stall itself ---- */

// Prevents: somebody standing on a scale that is holding yesterday's reading,
// watching a spinner that will never move, with the app saying nothing about
// the one action — step off, step back on — that would fix it.
test('INT-HINT-01  a link that is up but silent nudges STEP_OFF_AND_ON', T, async () => {
  const r = await stalled('hint01', { hintAfterSec: 1, holdMs: 3000 });
  assert.ok(r.progress.some((p) => p.phase === 'ready'), 'the link really did come up');
  assert.ok(r.hints.length >= 2, `expected repeated nudges, got ${r.hints.length}`);
  for (const h of r.hints) assert.strictEqual(h.code, 'STEP_OFF_AND_ON', 'every nudge names the stall');
  assert.strictEqual(r.hints[0].message, 'Step off the scale and step back on.');
});

// Prevents: a scan finding nothing and the app blaming itself, when the scale
// is simply asleep and one footstep would wake it.
test('INT-HINT-02  a scan that finds nothing nudges WAKE_THE_SCALE', T, async () => {
  const r = await scanning('hint02', { hintAfterSec: 1 });
  assert.ok(r.progress.some((p) => p.phase === 'scanning'), 'the scan really did start');
  assert.ok(!r.progress.some((p) => p.phase === 'connected'), 'and nothing ever answered it');
  assert.ok(r.hints.length >= 2, `expected repeated nudges, got ${r.hints.length}`);
  for (const h of r.hints) assert.strictEqual(h.code, 'WAKE_THE_SCALE');
  assert.strictEqual(r.hints[0].message, 'Step on the scale to wake it, then wait a moment.');
});

/* ---------------------------------------------------------- the envelope ---- */

// Prevents: a renderer reading `hint.code` or `hint.afterMs` and getting
// undefined, so the panel shows an empty banner or "undefined ms".
test('INT-HINT-03  every hint carries the whole documented envelope, and nothing else', T, async () => {
  const r = await stalled('hint03', { hintAfterSec: 1, holdMs: 3000 });
  assert.ok(r.hints.length >= 2, 'nudges arrived to inspect');
  const KEYS = ['afterMs', 'code', 'count', 'id', 'message', 'proto', 'type'];
  for (const h of r.hints) {
    assert.deepStrictEqual(Object.keys(h).sort(), KEYS, 'the exact hint envelope');
    H.assertShape(assert, h, {
      proto: 'number', type: 'string', id: 'string', code: 'string',
      message: 'string', count: 'number', afterMs: 'number',
    }, 'hint');
    assert.strictEqual(h.proto, 1, 'hint.proto');
    assert.strictEqual(h.type, 'hint', 'hint.type');
    assert.ok(CODES.includes(h.code), `hint.code ${h.code} is one of the two documented codes`);
    assert.ok(Number.isInteger(h.count) && h.count >= 1, `hint.count ${h.count} is a positive integer`);
    assert.ok(Number.isFinite(h.afterMs) && h.afterMs > 0, `hint.afterMs ${h.afterMs}`);
  }
});

// Prevents: a banner showing a machine code like STEP_OFF_AND_ON to a person,
// because the message it was meant to show was blank or was not a sentence.
test('INT-HINT-04  the message is a plain instruction a UI can show verbatim', T, async () => {
  const [silent, scan] = await Promise.all([
    stalled('hint04a', { hintAfterSec: 1, holdMs: 3000 }),
    scanning('hint04b', { hintAfterSec: 1 }),
  ]);
  assert.ok(silent.hints.length >= 1 && scan.hints.length >= 1, 'both stalls nudged');
  const messages = [silent.hints[0].message, scan.hints[0].message];
  for (const m of messages) {
    assert.strictEqual(typeof m, 'string');
    assert.ok(m.trim().length >= 10, `a real instruction, got ${JSON.stringify(m)}`);
    assert.match(m, /^[A-Z]/, 'starts like a sentence');
    assert.match(m, /\.$/, 'ends like a sentence');
    // Both codes are underscored, so this also rules out the code itself
    // having been shipped as the message.
    assert.ok(!/_/.test(m), `no machine code leaked into the text: ${JSON.stringify(m)}`);
  }
  assert.notStrictEqual(messages[0], messages[1], 'the two stalls read differently');
});

// Prevents: a "still waiting" banner that never changes, so nobody can tell
// whether the app is still trying or has quietly given up.
test('INT-HINT-05  count increments 1, 2, 3 and afterMs grows with it', T, async () => {
  const r = await stalled('hint05', { hintAfterSec: 1, holdMs: 4500 });
  assert.ok(r.hints.length >= 3, `expected at least three nudges, got ${r.hints.length}`);
  r.hints.forEach((h, i) => {
    assert.strictEqual(h.count, i + 1, `nudge ${i} counts ${i + 1}`);
    assert.strictEqual(h.afterMs, (i + 1) * 1000, 'afterMs is how long the stall has lasted');
  });
  for (let i = 1; i < r.hints.length; i++) {
    assert.ok(r.hints[i].afterMs > r.hints[i - 1].afterMs, 'afterMs strictly grows');
  }
});

// Prevents: a host switching on `progress.phase` and hitting an unknown value,
// or a progress bar advancing to a "hint" step that is not a step at all.
test('INT-HINT-06  a hint is its own event type, never a seventh progress phase', T, async () => {
  const r = await stalled('hint06', { hintAfterSec: 1, holdMs: 3000 });
  assert.ok(r.hints.length >= 2, 'nudges arrived');
  assert.ok(r.progress.length >= 3, 'and so did a real progress stream');
  for (const h of r.hints) assert.ok(!('phase' in h), 'a hint carries no phase');
  for (const p of r.progress) {
    assert.strictEqual(p.type, 'progress');
    assert.ok(KNOWN_PHASES.includes(p.phase), `progress phase ${p.phase} is a known one`);
    assert.ok(!CODES.includes(p.phase), 'no hint code masquerading as a phase');
    assert.ok(!('code' in p), 'and no hint code smuggled onto a progress event');
    assert.ok(!('count' in p) && !('afterMs' in p),
      'nor the nudge counter, which is what a merged event would leak');
  }
  assert.ok(r.hello.events.includes('hint') && r.hello.events.includes('progress'),
    'hello lists both, so a host can tell them apart before it sees either');
});

// Prevents: two windows measuring two people, and one person's nudge appearing
// over the other's panel because the advice arrived untagged.
test('INT-HINT-07  a hint echoes the id of the measurement it belongs to', T, async () => {
  const named = await stalled('hint07a', { hintAfterSec: 1, holdMs: 3000 });
  assert.ok(named.hints.length >= 2, 'nudges arrived');
  for (const h of named.hints) assert.strictEqual(h.id, 'm1', 'the request id is echoed');

  // A host that correlates with === must get its number back as a number.
  const numeric = await run({
    replay: connectedButSilent('hint07b'),
    env: { REPLAY_HOLD_MS: '3000' },
    options: { hintAfterSec: 1 },
    id: 7,
  });
  assert.ok(numeric.hints.length >= 2, 'the numeric-id run nudged too');
  for (const h of numeric.hints) assert.strictEqual(h.id, 7, 'not stringified');
  assert.strictEqual(numeric.terminal.id, 7, 'and the terminal event agrees');
});

/* ------------------------------------------------------------- advisory ---- */

// Prevents: a nudge quietly becoming the answer — the panel showing "step off
// and on" forever because the measurement it belonged to never ended.
test('INT-HINT-08  a nudged silent link still fails exactly as an unnudged one', T, async () => {
  const [nudged, quiet] = await Promise.all([
    stalled('hint08a', { hintAfterSec: 1, holdMs: 3000 }),
    stalled('hint08b', { hintAfterSec: 30, holdMs: 3000 }),
  ]);
  assert.ok(nudged.hints.length >= 2, 'one run was nudged');
  assert.strictEqual(quiet.hints.length, 0, 'and the other was not');
  assert.strictEqual(nudged.terminal.type, 'error');
  assert.strictEqual(nudged.terminal.code, 'NO_READING');
  assert.deepStrictEqual(nudged.terminal, quiet.terminal,
    'the outcome is byte-for-byte what it would have been with no nudging at all');
});

// Prevents: the same, for the other stall — a scan that found nothing must
// still report DEVICE_NOT_FOUND, not be swallowed by the advice about it.
test('INT-HINT-09  a nudged failed scan still fails exactly as an unnudged one', T, async () => {
  const [nudged, quiet] = await Promise.all([
    scanning('hint09a', { hintAfterSec: 1 }),
    scanning('hint09b', { hintAfterSec: 30 }),
  ]);
  assert.ok(nudged.hints.length >= 2, 'one run was nudged');
  assert.strictEqual(quiet.hints.length, 0, 'and the other was not');
  assert.strictEqual(nudged.terminal.type, 'error');
  assert.strictEqual(nudged.terminal.code, 'DEVICE_NOT_FOUND');
  assert.deepStrictEqual(nudged.terminal, quiet.terminal, 'identical outcome');
});

// Prevents: the harder half of "advisory" — a reading that was nudged for
// coming back different from one that was not, so somebody's body fat depends
// on how long they dithered before stepping on.
test('INT-HINT-10  a nudged reading measures exactly the same as an unnudged one', T, async () => {
  const [nudged, quiet] = await Promise.all([
    stalledThenRead('hint10a', { hintAfterSec: 1 }),
    stalledThenRead('hint10b', { hintAfterSec: 30 }),
  ]);
  assert.ok(nudged.hints.length >= 2, `one run was nudged, got ${nudged.hints.length}`);
  assert.strictEqual(quiet.hints.length, 0, 'and the other was not');
  assert.strictEqual(nudged.terminal.type, 'measurement', 'the nudged run still produced a reading');
  assert.strictEqual(nudged.terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(nudged.terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  for (const r of [nudged, quiet]) {
    assert.strictEqual(typeof r.terminal.timestamp, 'string',
      'both carry a timestamp, which is the only field allowed to differ');
  }
  assert.deepStrictEqual(withoutTimestamp(nudged.terminal), withoutTimestamp(quiet.terminal),
    'every derived figure is identical whether or not the person was nudged');
});

// Prevents: a stale nudge from a finished measurement landing on the next one's
// panel — "step off and on" appearing over a result that is already on screen.
test('INT-HINT-11  nudging stops at the terminal event and never resumes', T, async () => {
  const { events } = await H.serve({
    replay: connectedButSilent('hint11'),
    env: { REPLAY_HOLD_MS: '3000' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'm1', cmd: 'measure', profile: H.PROFILE, hintAfterSec: 1 });
        return false;
      }
      // A second measurement keeps the service alive and nudging for another
      // three seconds, which is the only way to prove the first one went quiet.
      if (ev.type === 'error' && ev.id === 'm1') {
        send({ id: 'm2', cmd: 'measure', profile: H.PROFILE, hintAfterSec: 1 });
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'm2';
    },
  });

  const endOfFirst = events.findIndex((e) => e.type === 'error' && e.id === 'm1');
  const endOfSecond = events.findIndex((e) => e.type === 'error' && e.id === 'm2');
  assert.ok(endOfFirst >= 0 && endOfSecond > endOfFirst, 'both measurements ended');
  assert.strictEqual(events.filter((e) => H.TERMINAL.has(e.type) && e.id === 'm1').length, 1,
    'the first measurement has exactly one terminal event');

  const strays = events.filter((e, i) => e.type === 'hint' && e.id === 'm1' && i > endOfFirst);
  assert.deepStrictEqual(strays, [], 'no nudge outlives the measurement it belonged to');
  assert.ok(events.filter((e) => e.type === 'hint' && e.id === 'm1').length >= 2, 'it really was nudging');
  const second = events.filter((e) => e.type === 'hint' && e.id === 'm2');
  assert.ok(second.length >= 2, 'and the next measurement nudges on its own');
  assert.strictEqual(second[0].count, 1, 'with the counter starting over, not carried across');
});

// Prevents: somebody giving up and pressing Cancel, and the app carrying on
// telling them to step off and step back on for a measurement that is over.
test('INT-HINT-12  cancelling a stalled measurement silences the nudging with it', T, async () => {
  let seen = 0;
  // The six-second hold is the backstop: if cancel does nothing the run still
  // ends on its own, and the CANCELLED assertion below is what fails.
  //
  // A second measurement follows the cancellation for the same reason as in
  // INT-HINT-11: the service would otherwise be shut down within milliseconds
  // of the cancel, and a timer that had been left running would never get the
  // chance to tick. It asks not to be nudged itself, so every nudge in the
  // window after the cancel belongs to the measurement that was abandoned.
  const { events } = await H.serve({
    replay: connectedButSilent('hint12'),
    env: { REPLAY_HOLD_MS: '6000' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'm1', cmd: 'measure', profile: H.PROFILE, hintAfterSec: 1 });
        return false;
      }
      if (ev.type === 'hint' && ev.id === 'm1' && ++seen === 2) send({ id: 'c1', cmd: 'cancel' });
      if (ev.type === 'error' && ev.id === 'm1') {
        send({ id: 'm2', cmd: 'measure', profile: H.PROFILE, hintAfterSec: 30 });
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'm2';
    },
  });

  const cancelAt = events.findIndex((e) => e.type === 'cancelling');
  const endOfSecond = events.findIndex((e) => e.type === 'error' && e.id === 'm2');
  assert.ok(cancelAt > 0, 'the cancel was accepted');
  assert.ok(endOfSecond > cancelAt, 'and the service went on running afterwards');

  const before = events.filter((e, i) => e.type === 'hint' && i < cancelAt);
  const after = events.filter((e, i) => e.type === 'hint' && i > cancelAt);
  assert.ok(before.length >= 2, `it was nudging when cancelled, got ${before.length}`);
  assert.deepStrictEqual(after, [], 'and said nothing more once the person gave up');

  const terminal = events.find((e) => e.type === 'error' && e.id === 'm1');
  assert.strictEqual(terminal.code, 'CANCELLED', 'the outcome is the cancellation, not the advice');
});

// Prevents: the whole point. A hint reaching a host that treats any tagged
// event as the reply would resolve `measure()` with advice instead of a
// reading, and the app would render a body panel with no body in it.
test('INT-HINT-13  a host promise keyed on the id is not settled by a hint', T, async () => {
  const client = new BodyScaleClient({
    scaleDir: H.ROOT,
    replay: connectedButSilent('hint13'),
    env: { BODYSCALE_CONFIG_DIR: H.configDir('hint13cfg'), REPLAY_HOLD_MS: '3000' },
  });
  try {
    const hints = [];
    let settled = false;
    let pendingWhenNudged = null;
    client.on('hint', (h) => {
      hints.push(h);
      if (pendingWhenNudged === null) pendingWhenNudged = !settled;
    });

    await client.start();
    // The replay child exits after three seconds, so this settles on its own.
    // The bound exists so a wedged service fails the test instead of leaving a
    // child process behind when node:test gives up on it.
    const outcome = await settleWithin(
      client.measure(H.PROFILE, { hintAfterSec: 1 }).then(
        (value) => { settled = true; return { resolved: value }; },
        (err) => { settled = true; return err; }),
      15000, 'measure()');

    assert.ok(hints.length >= 2, `the client saw the nudges, got ${hints.length}`);
    assert.strictEqual(pendingWhenNudged, true, 'the measure promise was still pending when nudged');
    assert.ok(!outcome.resolved, `it did not resolve with advice: ${JSON.stringify(outcome.resolved)}`);
    assert.strictEqual(outcome.name, 'ScaleError');
    assert.strictEqual(outcome.code, 'NO_READING', 'it settled on the real outcome');
    assert.strictEqual(client.busy, false, 'and the client is idle again');
  } finally {
    await client.stop();
  }
});

/* --------------------------------------------------------- when it stops ---- */

// Prevents: a scale that is working perfectly being second-guessed — "step off
// and step back on" flashing up while the weight is already climbing.
test('INT-HINT-14  a healthy session never nudges, however long it goes on', T, async () => {
  // Stretched to 200 ms a line so the session lasts well over a nudge interval.
  // At the recorded 20 ms it finishes inside 300 ms, and "no nudges" would be
  // true only because nothing had time to nudge.
  const started = Date.now();
  const r = await run({ replay: H.FIXTURE, env: { REPLAY_DELAY_MS: '200' }, options: { hintAfterSec: 1 } });
  const elapsed = Date.now() - started;

  assert.strictEqual(r.terminal.type, 'measurement', 'the recorded session succeeds');
  assert.strictEqual(r.terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.ok(r.progress.some((p) => p.phase === 'ready'),
    'it passed through ready, so the nudge timer was armed');
  assert.ok(r.progress.filter((p) => p.phase === 'settling' || p.phase === 'settled').length >= 5,
    'and the weight kept arriving frame after frame');
  assert.ok(elapsed > 1500,
    `the session outlasted the one-second nudge interval several times over, took ${elapsed} ms`);
  assert.deepStrictEqual(r.hints, [], 'and not one nudge was emitted');
});

// Prevents: the nudge nagging over a live number — someone told to step off
// and on while the app is already showing their weight settling.
test('INT-HINT-15  live weight stops the nudging instead of nagging alongside it', T, async () => {
  const r = await run({
    replay: H.fixture('hint15', [SCANNING, DEVICE, SERVICES, READY,
      CHATTER, CHATTER, CHATTER, CHATTER, CHATTER, CHATTER, WEIGHT_FRAME]),
    // The link goes quiet 1.5 s in and the frame lands at 5 s, so two nudges
    // have room to fire first. REPLAY_HOLD_MS then holds the link open and
    // silent for another 2.7 s, long enough for two more to have fired.
    env: { REPLAY_DELAY_MS: '500', REPLAY_HOLD_MS: '2200' },
    options: { hintAfterSec: 1 },
  });

  const firstWeightAt = r.events.findIndex((e) => e.type === 'progress' && 'weightKg' in e);
  assert.ok(firstWeightAt >= 0, 'a live weight arrived');
  assert.strictEqual(r.events[firstWeightAt].weightKg, 69.25);
  const before = r.events.filter((e, i) => e.type === 'hint' && i < firstWeightAt);
  const after = r.events.filter((e, i) => e.type === 'hint' && i > firstWeightAt);
  assert.ok(before.length >= 2, `it nudged while nothing was happening, got ${before.length}`);
  assert.deepStrictEqual(after, [], 'and said nothing more once the weight started arriving');
  assert.strictEqual(r.terminal.type, 'measurement', 'the reading still completes');
});

// Prevents: "step on the scale to wake it" still on screen after the scale has
// answered the scan, which reads as though the app never heard it.
test('INT-HINT-16  an advertisement stops the wake nudge on the spot', T, async () => {
  const r = await run({
    replay: advertisedThenQuiet('hint16'),
    env: { REPLAY_DELAY_MS: '700' },
    options: { hintAfterSec: 1 },
  });
  const foundAt = r.events.findIndex((e) => e.type === 'progress' && e.phase === 'found');
  assert.ok(foundAt >= 0, 'the scan was answered by an advertisement');
  const before = r.events.filter((e, i) => e.type === 'hint' && i < foundAt);
  const after = r.events.filter((e, i) => e.type === 'hint' && i > foundAt);
  assert.ok(before.length >= 2, `it nudged while the scan found nothing, got ${before.length}`);
  for (const h of before) assert.strictEqual(h.code, 'WAKE_THE_SCALE');
  assert.deepStrictEqual(after, [],
    'and stopped telling the person to wake a scale that had plainly answered');
  assert.strictEqual(r.terminal.code, 'DEVICE_NOT_FOUND',
    'the connect still failing afterwards is reported as itself');
});

// Prevents: the app still saying "step on the scale to wake it" after the scale
// has connected — the advice has to follow whichever stall is current.
test('INT-HINT-17  the nudge follows the stall, and the counter restarts with it', T, async () => {
  const r = await run({
    replay: connectedButSilent('hint17'),
    // 900 ms a line: long enough for the scan to nudge before the link comes up.
    env: { REPLAY_DELAY_MS: '900', REPLAY_HOLD_MS: '2600' },
    options: { hintAfterSec: 1 },
  });
  const codes = r.hints.map((h) => h.code);
  assert.ok(codes.length >= 3, `expected both stalls to nudge, got ${codes.join(', ')}`);
  assert.strictEqual(codes[0], 'WAKE_THE_SCALE', 'the scan stall comes first');
  assert.strictEqual(codes[codes.length - 1], 'STEP_OFF_AND_ON', 'the silent-link stall replaces it');

  const switchAt = codes.indexOf('STEP_OFF_AND_ON');
  assert.ok(switchAt > 0, 'the advice changed partway through');
  assert.ok(codes.slice(switchAt).every((c) => c === 'STEP_OFF_AND_ON'),
    `the old advice never returns: ${codes.join(', ')}`);
  assert.strictEqual(r.hints[switchAt].count, 1, 'the new stall counts from one');
  assert.strictEqual(r.hints[switchAt].afterMs, 1000, 'and times from one');
  // Holds for any number of wake nudges: they are the only ones before the
  // switch, and they are numbered from one.
  assert.strictEqual(r.hints[switchAt - 1].count, switchAt, 'the old one had counted up to the switch');
});

/* ------------------------------------------------------------ the timing ---- */

// Prevents: a host asking to be left alone for longer and being nagged at the
// old rate anyway, because hintAfterSec was accepted and then ignored.
test('INT-HINT-18  hintAfterSec is honoured: a longer setting nudges less', T, async () => {
  const [fast, slow] = await Promise.all([
    stalled('hint18a', { hintAfterSec: 1, holdMs: 4500 }),
    stalled('hint18b', { hintAfterSec: 3, holdMs: 4500 }),
  ]);
  // Counts over one fixed window, not wall-clock instants: the assertion has to
  // survive a loaded CI box, and "fewer nudges" is the property that matters.
  assert.ok(fast.hints.length >= 3, `the fast setting nudged repeatedly, got ${fast.hints.length}`);
  assert.strictEqual(slow.hints.length, 1, 'the slow setting got exactly one nudge in the same window');
  assert.strictEqual(fast.hints[0].afterMs, 1000, 'and afterMs reports the setting it was given');
  assert.strictEqual(slow.hints[0].afterMs, 3000);
  assert.deepStrictEqual(fast.terminal, slow.terminal, 'the outcome is unaffected either way');
});

// Prevents: a three-second hiccup on a healthy scale being interrupted by
// advice nobody needed, because the default was far shorter than documented.
test('INT-HINT-19  the default is eight seconds, so a short stall nudges nobody', T, async () => {
  const r = await stalled('hint19', { holdMs: 3000 });
  assert.ok(r.progress.some((p) => p.phase === 'ready'), 'the link came up and then went quiet');
  assert.deepStrictEqual(r.hints, [], 'three seconds of silence is not yet worth a nudge');
  assert.strictEqual(r.terminal.code, 'NO_READING', 'and the stall still ends properly');
  assert.strictEqual(r.hello.hints.defaultAfterSec, 8, 'which is the eight seconds hello advertises');
});

// Prevents: a host passing a sub-second value — by config, by a stray unit
// conversion — and drowning its own renderer in banners.
test('INT-HINT-20  hintAfterSec is floored at one second, so nothing can flood', T, async () => {
  const r = await stalled('hint20', { hintAfterSec: 0.05, holdMs: 3000 });
  assert.ok(r.hints.length >= 1, 'it still nudges');
  assert.ok(r.hints.length <= 4, `at most one a second, got ${r.hints.length} in three`);
  for (const h of r.hints) {
    assert.strictEqual(h.afterMs, h.count * 1000, 'the floor is reported, not the value asked for');
  }
});

// Prevents: a negative or zero hintAfterSec — a subtraction gone wrong, a
// config field left blank — taking the service down or flooding the renderer.
// Pins what the code does, not what it ought to do: zero is read as "unset" and
// silently becomes the eight-second default, so there is no documented way for
// a host to ask for no nudges at all. Worth knowing before relying on one.
test('INT-HINT-21  an out-of-range hintAfterSec floors or defaults, never obeys literally', T, async () => {
  const [negative, zero] = await Promise.all([
    stalled('hint21a', { hintAfterSec: -5, holdMs: 3000 }),
    stalled('hint21b', { hintAfterSec: 0, holdMs: 3000 }),
  ]);
  assert.ok(negative.hints.length >= 2 && negative.hints.length <= 4,
    `a negative setting lands on the one-second floor, got ${negative.hints.length} in three`);
  for (const h of negative.hints) {
    assert.strictEqual(h.code, 'STEP_OFF_AND_ON');
    assert.strictEqual(h.afterMs, h.count * 1000, 'reported as the floor, not as the value asked for');
  }
  assert.deepStrictEqual(zero.hints, [],
    'zero is read as unset and falls back to eight seconds, which three seconds never reaches');
  assert.strictEqual(negative.terminal.code, 'NO_READING', 'neither value changes the outcome');
  assert.deepStrictEqual(negative.terminal, zero.terminal);
});

/* ----------------------------------------------------------- the contract ---- */

// Prevents: `scale.js --replay ... | jq` breaking the day nudging was added,
// because the advice for the person went out on the channel carrying the JSON.
test('INT-HINT-22  in the one-shot CLI a nudge goes to stderr, never into the JSON', T, async () => {
  const { stdout, stderr } = await cli(
    ['--replay', connectedButSilent('hint22'), '--hint-after', '1',
     '--sex', 'male', '--age', '39', '--height', '180'],
    { env: { REPLAY_HOLD_MS: '3000' } });

  const nudges = stderr.match(/>> Step off the scale and step back on\./g) || [];
  assert.ok(nudges.length >= 2, `the person was nudged on stderr, got ${nudges.length}`);

  const lines = stdout.trim().split('\n').filter((l) => l.trim());
  assert.strictEqual(lines.length, 1, `stdout is exactly one JSON line, got ${lines.length}`);
  const body = JSON.parse(lines[0]);            // throws, and fails the test, if it is not JSON
  assert.strictEqual(body.ok, false, 'the silent link is still reported as a failed reading');
  assert.strictEqual(body.error, 'no-reading');
  for (const needle of ['STEP_OFF_AND_ON', 'WAKE_THE_SCALE', 'Step off the scale', '"hint"']) {
    assert.ok(!stdout.includes(needle), `stdout carries no trace of ${needle}`);
  }
});

// Prevents: a host written against `hello` never learning that hints exist, and
// dropping every one of them as an unknown event type.
test('INT-HINT-23  hello advertises the hint contract', T, async () => {
  const r = await run({ replay: H.FIXTURE, options: {} });
  const hello = r.hello;
  assert.ok(hello, 'hello arrived');
  assert.deepStrictEqual(hello.events,
    ['hello', 'accepted', 'progress', 'hint', 'measurement',
     'status', 'cancelling', 'forgotten', 'bye', 'error'],
    'all ten event types, hint among them');

  H.assertShape(assert, hello.hints, {
    codes: 'array', defaultAfterSec: 'number', note: 'string',
  }, 'hello.hints');
  assert.deepStrictEqual(hello.hints.codes, CODES, 'the two documented codes, in order');
  assert.strictEqual(hello.hints.defaultAfterSec, 8);
  assert.ok(hello.hints.note.length > 20, 'the note says what a hint is');
  assert.match(hello.hints.note, /[Aa]dvisory/, 'and that it is advisory');
  assert.match(hello.hints.note, /never ends a measurement/, 'and that it never ends a measurement');
});
