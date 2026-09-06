'use strict';
/**
 * INT-PROG — the live progress stream.
 *
 * This is the number a person watches while standing on the scale, and the cue
 * that tells them to step on in the first place. Everything here is driven
 * through the real `scale.js --serve` process over a real pipe, with the radio
 * replaced by the recorded Dr Trust SSW533 session. No hardware, no mocks.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const H = require('./harness');

/** The six phases scale.js can emit (grep for `emit({ phase:` in scale.js). */
const KNOWN_PHASES = ['scanning', 'found', 'connected', 'ready', 'settling', 'settled'];

/** The device the recorded session connects to, as recorded. */
const RECORDED_ADDRESS = 'BEECC6EC-BD30-3EAC-B148-4833628A8A58';

/** Every live weight the recorded session streams, in order. Deterministic. */
/*
 * The live weights the recording streams, in order.
 *
 * 97.9 appears once. It used to appear twice, because the recording held two
 * record frames: a weight one and a separate "subtype 0x01 impedance" frame
 * that repeated the held weight. That second frame was fabricated — under the
 * protocol's real grammar its fragment index is 1 while it repeats a command
 * only a fragment 0 carries — and the scale sends exactly one record, with the
 * weight and the impedances together in it.
 */
const RECORDED_WEIGHTS = [69.25, 90, 94.5, 98.65, 97.95, 98.25, 97.9];

const FFB2 = '0000ffb2-0000-1000-8000-00805f9b34fb';
const FFB3 = '0000ffb3-0000-1000-8000-00805f9b34fb';
/**
 * The 0xFFB3 weight record, subtype 0x00: 97.9 kg. It carries NO impedance —
 * the bytes once read as one are the low half of a device timestamp.
 */
const RECORD_FRAME = '30 00 23 00 a7 00 00 00 00 25 01 7e 6c 00 0a 00 00 00 00 00 00 00 00 00 00 '
  + '00 00 00 00 00 00 00 00 00 00 00 00 00 00 08';
/** The single 0xA7 record: 97.9 kg and ten impedance slots summing to 529.9 ohm. */
const IMPEDANCE_FRAME = '31 00 23 00 a7 00 00 14 b3 00 01 7e 6c 00 0a 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 11 00 00 00 00 0a';
/** A 0xFFB2 live-weight frame: status 0x01 (settling), 69.25 kg. */
const SETTLING_FRAME = '3e 00 07 00 a2 01 00 01 0e 82 00 14';

/** Run one measurement under a caller-chosen request id. */
function measureAs(id, opts = {}) {
  return H.serve({
    replay: opts.replay,
    env: opts.env || {},
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id, cmd: 'measure', profile: H.PROFILE }); return false; }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === id;
    },
  });
}

const indexOfType = (events, type) => events.findIndex((e) => e.type === type);
const weightEvents = (events) => H.byType(events, 'progress').filter((e) => 'weightKg' in e);

// Prevents: the Electron app showing one person's live weight under another
// request, because the stream arrived untagged. Without the echoed id the
// renderer cannot tell which measurement a number belongs to.
test('INT-PROG-01  every progress event carries proto 1 and echoes the request id', async () => {
  const { events } = await measureAs('live-42');
  const progress = H.byType(events, 'progress');
  assert.ok(progress.length >= 5, `expected a real stream, got ${progress.length} events`);
  for (const p of progress) {
    assert.strictEqual(p.proto, 1, 'progress.proto');
    assert.strictEqual(p.type, 'progress');
    assert.strictEqual(p.id, 'live-42', `progress id, phase ${p.phase}`);
    assert.strictEqual(typeof p.phase, 'string', 'progress.phase');
    assert.strictEqual(typeof p.message, 'string', 'progress.message');
  }
});

// Prevents: a host that correlates on `===` breaking when it sends a numeric id
// and gets a string back, so every live weight is dropped on the floor.
test('INT-PROG-02  a numeric request id comes back as the same number, not stringified', async () => {
  const { events } = await measureAs(7);
  const progress = H.byType(events, 'progress');
  assert.ok(progress.length >= 5, 'a stream arrived');
  for (const p of progress) assert.strictEqual(p.id, 7, `progress id for phase ${p.phase}`);
  assert.strictEqual(H.first(events, 'measurement').id, 7, 'the terminal event agrees');
});

// Prevents: the progress bar starting before the request was even accepted, or
// a stray weight arriving after the result is on screen and overwriting it.
test('INT-PROG-03  progress arrives strictly between accepted and the terminal event', async () => {
  const { events } = await measureAs('W1');
  const acceptedAt = indexOfType(events, 'accepted');
  const terminalAt = indexOfType(events, 'measurement');
  assert.ok(acceptedAt >= 0, 'accepted was emitted');
  assert.ok(terminalAt >= 0, 'measurement was emitted');
  const progressIdx = events.map((e, i) => (e.type === 'progress' ? i : -1)).filter((i) => i >= 0);
  assert.ok(progressIdx.length >= 5, 'a stream arrived');
  for (const i of progressIdx) {
    assert.ok(i > acceptedAt, `progress at ${i} is after accepted at ${acceptedAt}`);
    assert.ok(i < terminalAt, `progress at ${i} is before the terminal event at ${terminalAt}`);
  }
});

// Prevents: the UI hitting an unknown phase string and falling through to a
// blank screen, or silently ignoring a phase it was never told about.
test('INT-PROG-04  every emitted phase is one of the six known phases', async () => {
  const { events } = await measureAs('W2');
  const phases = H.byType(events, 'progress').map((p) => p.phase);
  assert.ok(phases.length >= 5, 'a stream arrived');
  for (const phase of phases) {
    assert.ok(KNOWN_PHASES.includes(phase), `"${phase}" is a known phase`);
  }
  assert.deepStrictEqual(
    [...new Set(phases)], ['connected', 'ready', 'settling'],
    'the recorded session walks connected then ready then settling',
  );
});

// Prevents: the big live number rendering as "null kg", "undefined" or NaN
// while somebody is standing on the scale watching it.
test('INT-PROG-05  every settling event carries a finite positive weightKg', async () => {
  const { events } = await measureAs('W3');
  const settling = H.byType(events, 'progress').filter((p) => p.phase === 'settling');
  assert.strictEqual(settling.length, 7,
    'seven weight frames plus the impedance frame, which streams the held weight again');
  for (const p of settling) {
    assert.strictEqual(typeof p.weightKg, 'number', `weightKg type for "${p.message}"`);
    assert.ok(Number.isFinite(p.weightKg), `weightKg is finite: ${p.weightKg}`);
    assert.ok(p.weightKg > 0, `weightKg is positive: ${p.weightKg}`);
    assert.strictEqual(p.message, `${p.weightKg} kg`, 'the message restates the weight');
  }
});

// Prevents: a frozen number. If only one weight ever streams the user sees a
// dead readout for the whole measurement and assumes the scale hung.
test('INT-PROG-06  several distinct live weights stream during one measurement', async () => {
  const { events } = await measureAs('W4');
  const weights = weightEvents(events).map((p) => p.weightKg);
  assert.deepStrictEqual(weights, RECORDED_WEIGHTS, 'the recorded live weight sequence');
  assert.strictEqual(new Set(weights).size, 7,
    'seven distinct weights; the impedance frame repeats the last one');
});

// Prevents: the live number ending on a value the result panel then contradicts,
// which reads to the user as the scale changing its mind at the last moment.
test('INT-PROG-07  the final live weight equals measured.weightKg', async () => {
  const { events } = await measureAs('W5');
  const weights = weightEvents(events);
  const measurement = H.first(events, 'measurement');
  assert.strictEqual(measurement.measured.weightKg, H.EXPECTED.weightKg, 'the recorded result');
  assert.strictEqual(
    weights[weights.length - 1].weightKg, measurement.measured.weightKg,
    'the last streamed weight is the weight that was reported',
  );
});

// Prevents: "Connected to undefined" in the UI, and the app remembering a
// different address than the one it just told the user it connected to.
test('INT-PROG-08  the connected phase carries the device name and address', async () => {
  const { events } = await measureAs('W6');
  const connected = H.byType(events, 'progress').filter((p) => p.phase === 'connected');
  assert.strictEqual(connected.length, 1, 'connected is emitted exactly once');
  const c = connected[0];
  H.assertShape(assert, c, { message: 'string', device: 'object', driver: 'string' }, 'connected');
  assert.strictEqual(c.device.name, H.EXPECTED.name, 'device name');
  assert.strictEqual(c.device.address, RECORDED_ADDRESS, 'device address');
  assert.strictEqual(c.message, `connected to ${H.EXPECTED.name}`, 'human message');
  assert.strictEqual(c.driver, 'drtrust', 'the selected driver is named');
  const measurement = H.first(events, 'measurement');
  assert.deepStrictEqual(
    measurement.device, c.device,
    'the device shown live is the device the result is attributed to',
  );
});

// Prevents: the user never being told to stand on the scale, so they wait for a
// prompt that never comes and the measurement times out.
test('INT-PROG-09  a ready phase is emitted once, before any live weight', async () => {
  const { events } = await measureAs('W7');
  const progress = H.byType(events, 'progress');
  const readyAt = progress.findIndex((p) => p.phase === 'ready');
  assert.ok(readyAt >= 0, 'a ready phase was emitted');
  assert.strictEqual(progress.filter((p) => p.phase === 'ready').length, 1, 'exactly one ready');
  assert.strictEqual(progress[readyAt].message, 'stand on the scale', 'the cue text');
  const firstWeightAt = progress.findIndex((p) => 'weightKg' in p);
  assert.ok(firstWeightAt > readyAt, 'ready precedes the first live weight');
});

// Prevents: a progress bar that appears before the service has agreed to
// measure, so a rejected request still looks like it is running.
test('INT-PROG-10  no progress is emitted before accepted, even after other commands', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'S0', cmd: 'status' }); return false; }
      if (ev.type === 'status') { send({ id: 'F0', cmd: 'forget' }); return false; }
      if (ev.type === 'forgotten') { send({ id: 'M9', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement';
    },
  });
  const acceptedAt = indexOfType(events, 'accepted');
  assert.ok(acceptedAt > 0, 'accepted came after the earlier replies');
  const before = events.slice(0, acceptedAt).filter((e) => e.type === 'progress');
  assert.deepStrictEqual(before, [], 'nothing streamed before accepted');
  assert.ok(H.byType(events, 'progress').length >= 5, 'and the stream did start afterwards');
});

// Prevents: a measurement rejected for a bad profile still driving the live
// readout, leaving a spinner running for a request that will never complete.
test('INT-PROG-11  a request rejected outright emits no progress at all', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'BAD', cmd: 'measure', profile: { age: 2, heightCm: 180, sex: 'male' } });
        return false;
      }
      // Give the service a clear window to misbehave in before shutting down.
      if (ev.type === 'error' && ev.id === 'BAD') { setTimeout(() => send({ id: 'S1', cmd: 'status' }), 400); return false; }
      return ev.type === 'status';
    },
  });
  const err = H.first(events, 'error');
  assert.strictEqual(err.code, 'INVALID_PROFILE', 'the request was rejected');
  assert.deepStrictEqual(H.byType(events, 'progress'), [], 'no progress for a rejected request');
  assert.ok(H.first(events, 'accepted') === undefined, 'and it was never accepted');
});

// Prevents: a second measurement rejected as BUSY hijacking the readout of the
// one actually in progress, so the person on the scale sees it stall.
test('INT-PROG-12  a BUSY rejection streams nothing while the running request keeps streaming', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted') { send({ id: 'M2', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' && ev.id === 'M1';
    },
  });
  const busy = events.find((e) => e.type === 'error' && e.id === 'M2');
  assert.ok(busy, 'the overlapping request was answered');
  assert.strictEqual(busy.code, 'BUSY', 'with BUSY');
  const progress = H.byType(events, 'progress');
  assert.deepStrictEqual(progress.filter((p) => p.id === 'M2'), [], 'nothing streamed under M2');
  assert.ok(progress.length >= 5, 'and M1 kept streaming');
  for (const p of progress) assert.strictEqual(p.id, 'M1', 'every live weight belongs to M1');
});

// Prevents: an IPC crash. Electron sends every progress payload to the renderer
// through the structured clone algorithm; one uncloneable value and the whole
// live readout dies with "An object could not be cloned".
test('INT-PROG-13  progress payloads survive structuredClone unchanged', async () => {
  const { events } = await measureAs('W8');
  const progress = H.byType(events, 'progress');
  assert.ok(progress.length >= 5, 'a stream arrived');
  for (const p of progress) {
    const copy = structuredClone(p);
    assert.deepStrictEqual(copy, p, `phase ${p.phase} survives the clone`);
    assert.notStrictEqual(copy, p, 'and it really was copied');
  }
  const connected = progress.find((p) => p.phase === 'connected');
  assert.notStrictEqual(
    structuredClone(connected).device, connected.device,
    'the nested device object is cloned too, not shared',
  );
});

// Prevents: dead air during the scan. Without scanning and found the user waits
// on a blank screen for up to eight seconds with no sign anything is happening.
test('INT-PROG-14  scanning and found phases are emitted while the radio searches', async () => {
  const replay = H.fixture('prog-scan', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'log', level: 'info', msg: 'advertisement from SSW533 after 120 ms (matched by name, rssi -60)' },
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'log', level: 'info', msg: 'connected in 112 ms' },
    { t: 'ready' },
    { t: 'frame', uuid: FFB2, hex: SETTLING_FRAME },
    { t: 'frame', uuid: FFB3, hex: RECORD_FRAME },
    { t: 'end', reason: 'finished' },
  ]);
  const { events } = await measureAs('W9', { replay });
  const progress = H.byType(events, 'progress');
  assert.deepStrictEqual(
    progress.map((p) => p.phase),
    ['scanning', 'found', 'connected', 'ready', 'settling', 'settling'],
    'the full phase walk from an idle radio to a reading',
  );
  assert.strictEqual(progress[0].message, 'scanning for SSW533', 'scanning carries the log text');
  assert.match(progress[1].message, /advertisement from SSW533/, 'found carries the log text');
  assert.strictEqual(progress[2].device.address, 'AA:BB:CC:DD:EE:FF', 'connected carries the address');
});

// Prevents: a late frame overwriting the finished result. The user sees their
// body composition, then the number jumps back to a mid-measurement weight.
test('INT-PROG-15  no progress is emitted after the terminal event, even if frames keep arriving', async () => {
  const recorded = fs.readFileSync(H.FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const endAt = recorded.findIndex((e) => e.t === 'end');
  assert.ok(endAt > 0, 'the recorded session ends with an end event');
  const trailing = [
    { t: 'frame', uuid: FFB2, hex: SETTLING_FRAME },
    { t: 'frame', uuid: FFB2, hex: '3f 00 07 00 a2 01 00 01 5f 90 00 13' },
  ];
  const replay = H.fixture('prog-trailing', [
    ...recorded.slice(0, endAt), ...trailing, ...recorded.slice(endAt),
  ]);
  const { events } = await H.serve({
    replay,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'X1', cmd: 'measure', profile: H.PROFILE }); return false; }
      // Hold the process open long past the trailing frames before finishing.
      if (ev.type === 'measurement') { setTimeout(() => send({ id: 'S9', cmd: 'status' }), 500); return false; }
      return ev.type === 'status';
    },
  });
  const terminalAt = indexOfType(events, 'measurement');
  assert.ok(terminalAt >= 0, 'the measurement was reported');
  const after = events.slice(terminalAt + 1).filter((e) => e.type === 'progress');
  assert.deepStrictEqual(after, [], 'the stream is silent once the result is out');
  assert.strictEqual(
    H.first(events, 'measurement').measured.weightKg, H.EXPECTED.weightKg,
    'and the trailing frames did not change the result',
  );
});

// Prevents: the live number carrying on after the user hit Cancel, so the
// dialog they dismissed keeps ticking behind the cancelled state.
test('INT-PROG-16  cancelling stops the stream: nothing arrives after CANCELLED', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },              // widen the window so cancel lands mid-stream
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'progress' && ev.phase === 'settling') { send({ id: 'C1', cmd: 'cancel' }); return false; }
      if (ev.type === 'error' && ev.id === 'M1') { setTimeout(() => send({ id: 'S9', cmd: 'status' }), 500); return false; }
      return ev.type === 'status';
    },
  });
  const err = events.find((e) => e.type === 'error' && e.id === 'M1');
  assert.ok(err, 'the measurement was settled');
  assert.strictEqual(err.code, 'CANCELLED', 'as cancelled');
  const before = events.slice(0, events.indexOf(err)).filter((e) => e.type === 'progress');
  assert.ok(before.some((p) => p.phase === 'settling'), 'weights were streaming when cancel landed');
  const after = events.slice(events.indexOf(err) + 1).filter((e) => e.type === 'progress');
  assert.deepStrictEqual(after, [], 'and none arrived afterwards');
});

// Prevents: a phantom weight when no scale ever answered. The user would see a
// number appear and then a "no scale found" error contradicting it.
test('INT-PROG-17  a measurement that never finds a device streams no weight', async () => {
  const replay = H.fixture('prog-notfound', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'end', reason: 'not-found', detail: 'no match in 8 s' },
  ]);
  const { events } = await measureAs('NF', { replay });
  const err = events.find((e) => e.type === 'error' && e.id === 'NF');
  assert.ok(err, 'the request was settled');
  assert.strictEqual(err.code, 'DEVICE_NOT_FOUND', 'with DEVICE_NOT_FOUND');
  const progress = H.byType(events, 'progress');
  assert.deepStrictEqual(progress.map((p) => p.phase), ['scanning'], 'only the scan was reported');
  assert.deepStrictEqual(weightEvents(events), [], 'no weight was ever streamed');
});

// Prevents: "0 kg" flashing on screen before anyone steps on, which looks like
// a broken scale rather than one waiting for a person.
test('INT-PROG-18  an idle frame with nobody on the scale streams no weight', async () => {
  const replay = H.fixture('prog-idle', [
    { t: 'device', name: 'SSW533', address: 'AA:BB' },
    { t: 'ready' },
    { t: 'frame', uuid: FFB2, hex: '3e 00 07 00 a2 01 00 00 00 00 00 14' },  // 0 g, nobody on it
    { t: 'frame', uuid: FFB2, hex: SETTLING_FRAME },                          // 69.25 kg
    { t: 'frame', uuid: FFB3, hex: RECORD_FRAME },
    { t: 'end', reason: 'finished' },
  ]);
  const { events } = await measureAs('ID', { replay });
  const weights = weightEvents(events).map((p) => p.weightKg);
  assert.deepStrictEqual(weights, [69.25, 97.9], 'the zero reading was not streamed');
  assert.ok(!weights.includes(0), 'no zero weight reached the host');
});

// Prevents: never being able to say "hold still, that's your weight". The
// settled phase is the only signal that the scale has locked the reading.
test('INT-PROG-19  a locked reading is streamed as the settled phase', async () => {
  const replay = H.fixture('prog-settled', [
    { t: 'device', name: 'SSW533', address: 'AA:BB' },
    { t: 'ready' },
    { t: 'frame', uuid: FFB2, hex: SETTLING_FRAME },                          // status 0x01, settling
    { t: 'frame', uuid: FFB2, hex: '44 00 07 00 a2 00 00 01 7f ca 00 0d' },   // status 0x00, locked
    { t: 'frame', uuid: FFB3, hex: RECORD_FRAME },
    { t: 'end', reason: 'finished' },
  ]);
  const { events } = await measureAs('SD', { replay });
  const progress = H.byType(events, 'progress');
  assert.deepStrictEqual(
    progress.map((p) => p.phase),
    ['connected', 'ready', 'settling', 'settled', 'settled'],
    'the stream flips to settled once the scale locks',
  );
  const settled = progress.filter((p) => p.phase === 'settled');
  assert.strictEqual(settled[0].weightKg, 98.25, 'the locked weight');
  assert.strictEqual(settled[0].impedanceOhm, null, 'impedance had not arrived yet');
});

// Prevents: the UI announcing a body-composition reading before the impedance
// frame exists, or losing it once it does.
test('INT-PROG-20  impedanceOhm is null until it arrives, then numeric on the last event', async () => {
  const { events } = await measureAs('IM');
  const weights = weightEvents(events);
  // Seven. The impedance no longer arrives in a frame of its own: the scale
  // sends one record carrying the weight and every impedance slot together,
  // so the last weight event is the one that carries it.
  assert.strictEqual(weights.length, 7, 'six live weights plus the record');
  for (const p of weights.slice(0, 6)) {
    assert.strictEqual(p.impedanceOhm, null, `impedance is null at ${p.weightKg} kg`);
  }
  const last = weights[weights.length - 1];
  assert.strictEqual(last.impedanceOhm, H.EXPECTED.impedanceOhm, 'the last event carries impedance');
  assert.strictEqual(
    H.first(events, 'measurement').measured.impedanceOhm, last.impedanceOhm,
    'and it is the impedance the result was computed from',
  );
});

// Prevents: the second weigh-in of the evening painting its numbers into the
// first person's still-open panel, because the streams were not kept apart.
test('INT-PROG-21  two sequential measurements each stream under their own id only', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'A', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'measurement' && ev.id === 'A') { send({ id: 'B', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' && ev.id === 'B';
    },
  });
  const firstDone = events.findIndex((e) => e.type === 'measurement' && e.id === 'A');
  assert.ok(firstDone > 0, 'the first measurement finished');
  const before = events.slice(0, firstDone).filter((e) => e.type === 'progress');
  const after = events.slice(firstDone).filter((e) => e.type === 'progress');
  assert.ok(before.length >= 5 && after.length >= 5, 'both runs streamed');
  for (const p of before) assert.strictEqual(p.id, 'A', 'first run is tagged A');
  for (const p of after) assert.strictEqual(p.id, 'B', 'second run is tagged B');
  assert.deepStrictEqual(
    after.filter((p) => 'weightKg' in p).map((p) => p.weightKg), RECORDED_WEIGHTS,
    'the second run streams the same recorded weights, not a continuation of the first',
  );
});

// Prevents: a host mistaking a progress line for the answer and resolving the
// measure promise early with a half-finished weight and no body composition.
test('INT-PROG-22  progress is never mistakable for a terminal reply', async () => {
  const { events } = await measureAs('TR');
  const progress = H.byType(events, 'progress');
  assert.ok(progress.length >= 5, 'a stream arrived');
  assert.ok(H.STREAMING.has('progress'), 'progress is classed as streaming');
  assert.ok(!H.TERMINAL.has('progress'), 'and not as terminal');
  for (const p of progress) {
    for (const key of ['ok', 'code', 'measured', 'derived', 'trust', 'units', 'flags']) {
      assert.ok(!(key in p), `a progress event carries no "${key}" field (phase ${p.phase})`);
    }
  }
  const settling = events.filter((e) => H.TERMINAL.has(e.type) && e.id === 'TR');
  assert.strictEqual(settling.length, 1, 'exactly one terminal event settled the request');
  assert.strictEqual(settling[0].type, 'measurement', 'and it was the measurement');
});

// Prevents: the number moving after the scale has said it is done. The 0xFFB2
// stream does not stop when a reading locks — the scale keeps repeating frames,
// and a shift of stance while its impedance program runs will send a different
// weight. Without this the displayed figure creeps after settling, and the
// recorded result is whatever happened to arrive last rather than what the
// scale locked.
test('INT-PROG-23  a locked weight is frozen and later drift is ignored', async () => {
  const f = H.fixture('freeze', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'services', items: [{ service: '0000ffb0-0000-1000-8000-00805f9b34fb',
      char: '0000ffb2-0000-1000-8000-00805f9b34fb', props: ['notify'] }] },
    { t: 'ready' },
    // status 0x01 = settling, status 0x00 = final.
    { t: 'frame', uuid: FFB2, hex: '01 00 07 00 a2 01 00 01 78 f4 00 10' },  // 96.5 settling
    { t: 'frame', uuid: FFB2, hex: '02 00 07 00 a2 00 00 01 78 f4 00 0f' },  // 96.5 LOCKED
    { t: 'frame', uuid: FFB2, hex: '03 00 07 00 a2 00 00 01 6f f8 00 0b' },  // 94.2 drift
    { t: 'frame', uuid: FFB2, hex: '04 00 07 00 a2 00 00 01 8d 12 00 03' },  // 101.6 drift
  ]);

  const { events, stderr } = await H.serve({
    replay: f,
    env: { REPLAY_HOLD_MS: '1500' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'F', cmd: 'measure', profile: H.PROFILE }); return false; }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'F';
    },
  });

  const m = events.find((e) => e.type === 'measurement');
  assert.ok(m, `expected a measurement, saw [${events.map((e) => e.type).join(', ')}]`);
  assert.strictEqual(m.measured.weightKg, 96.5, 'the result is what the scale locked');

  const streamed = H.byType(events, 'progress')
    .filter((p) => typeof p.weightKg === 'number').map((p) => p.weightKg);
  assert.ok(streamed.length >= 2, 'weights did stream');
  assert.deepStrictEqual([...new Set(streamed)], [96.5],
    'and every one of them is the locked value, never the drift');
  assert.match(stderr, /ignoring 94\.2 kg/, 'the ignored drift is reported, not silently dropped');
});

// Prevents: hanging up before the scale has measured. Its impedance program
// runs AFTER the weight locks — the display shows P-1 and holds about ten
// seconds — and the client used to give up five seconds in. From the user's
// side that looks like "the Bluetooth disconnects as soon as it has the
// weight", and it guaranteed a weight-only reading no decode fix could rescue.
test('INT-PROG-24  the link is held open while the scale measures impedance', async () => {
  const IMPEDANCE = '31 00 23 00 a7 00 00 14 b3 00 01 7e 6c 00 0a 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 12 02 11 00 00 00 00 0a'
    + ' 00'.repeat(27) + ' 02';
  const f = H.fixture('late-impedance', [
    { t: 'log', level: 'info', msg: 'scanning for SSW533' },
    { t: 'device', name: 'SSW533', address: 'AA:BB:CC:DD:EE:FF' },
    { t: 'services', items: [{ service: '0000ffb0-0000-1000-8000-00805f9b34fb',
      char: FFB3, props: ['indicate'] }] },
    { t: 'ready' },
    { t: 'frame', uuid: FFB2, hex: '01 00 07 00 a2 01 00 01 78 90 00 0c' },  // settling
    { t: 'frame', uuid: FFB2, hex: '02 00 07 00 a2 00 00 01 78 90 00 0c' },  // LOCKED
    // Seven seconds of silence, which is where the old five-second grace fired.
    ...Array(7).fill({ t: 'log', level: 'info', msg: 'measuring' }),
    { t: 'frame', uuid: FFB3, hex: IMPEDANCE },
  ]);

  const { events } = await H.serve({
    replay: f,
    timeoutMs: 30000,
    env: { REPLAY_DELAY_MS: '1000' },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'W', cmd: 'measure', profile: H.PROFILE }); return false; }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'W';
    },
  });

  const m = events.find((e) => e.type === 'measurement');
  assert.ok(m, `expected a measurement, saw [${events.map((e) => e.type).join(', ')}]`);
  assert.strictEqual(m.measured.impedanceOhm, 529.9,
    'the impedance arrived seven seconds after the lock and was still collected');
  assert.strictEqual(Object.keys(m.derived).length, 24);
  assert.strictEqual(m.trust.impedanceDerived, true);

  const hint = H.byType(events, 'hint').find((h) => h.code === 'STAY_ON_SCALE');
  assert.ok(hint, 'and the user is told to stay onrather than left watching nothing');
  assert.match(hint.message, /stay on the scale/i);
});
