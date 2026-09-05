'use strict';
/**
 * INT-SYNC — synchronisation, ordering and concurrency.
 *
 * This file is about one thing: keeping the Electron main process and
 * `scale.js --serve` in lockstep. A host writes requests down a pipe and reads
 * replies back up it. Nothing guarantees the replies arrive in the order the
 * requests went out, so the host correlates on `id`. Every test here defends
 * some part of that bargain — one terminal event per request, ids returned
 * untouched, cheap replies allowed to overtake slow ones, and a cancel that
 * settles exactly once no matter when it lands.
 *
 * Everything runs against the recorded SSW533 session, so no radio, no scale.
 */
const test = require('node:test');
const assert = require('node:assert');
const H = require('./harness');
const { BodyScaleClient } = require(H.CLIENT);

/** Ids may legally be objects or arrays, so compare structurally. */
const sameId = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every event the service sent carrying this id. */
const forId = (events, id) => events.filter((e) => sameId(e.id, id));

/** The subset of those that settle the request. */
const terminalsFor = (events, id) => forId(events, id).filter((e) => H.TERMINAL.has(e.type));

/** Index of an event in the stream, or -1. */
const indexOf = (events, pred) => events.findIndex(pred);

/** Replies to our own requests: drops `hello` and the harness's own shutdown. */
const replies = (events) => events.filter((e) => e.type !== 'hello' && e.id !== '_harness_stop');

/** Assert exactly one terminal event settled the request, and return it. */
function onlyTerminal(events, id, where) {
  const t = terminalsFor(events, id);
  assert.strictEqual(t.length, 1,
    `${where}: request ${JSON.stringify(id)} settled exactly once, got [${t.map((e) => e.type + (e.code ? '/' + e.code : '')).join(', ')}]`);
  return t[0];
}

// A host correlates on `id`. `hello` has none, because it answers nothing: it is
// the service announcing itself. If it ever arrived with an id, or arrived
// twice, or arrived after a reply, a client keying its pending map on ids would
// resolve the wrong promise and the app would show a stale or empty result.
test('INT-SYNC-01  hello arrives once, first, and carries no id to correlate on', async () => {
  const { events } = await H.serve({
    timeoutMs: 10000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'A', cmd: 'status' }); return false; }
      return ev.id === 'A';
    },
  });
  const hellos = H.byType(events, 'hello');
  assert.strictEqual(hellos.length, 1, 'exactly one hello');
  assert.strictEqual(events[0].type, 'hello', 'hello is the very first line');
  assert.strictEqual('id' in hellos[0], false, 'hello carries no id field at all');
  assert.strictEqual(hellos[0].proto, 1);
  assert.deepStrictEqual(hellos[0].commands, ['measure', 'compute', 'cancel', 'status', 'forget', 'shutdown'],
    'hello advertises exactly the five commands');
  assert.deepStrictEqual(hellos[0].errorCodes, H.ALL_ERROR_CODES,
    'hello advertises exactly the eleven error codes');
});

// A batch of requests, some nonsense, goes down the pipe in one burst. If any
// one of them were silently dropped, the Electron app would hold a promise that
// never settles and the UI would sit on a spinner for ever. If any one were
// answered twice, the second reply would resolve a promise the client had
// already deleted, or worse, settle an unrelated later request.
test('INT-SYNC-02  every request in a mixed valid and invalid batch is settled exactly once, in order', async () => {
  const sent = [
    { id: 'a', cmd: 'status' },
    { id: 'b', cmd: 'no-such-command' },
    { id: 'c', cmd: 'measure', profile: { age: 900, heightCm: 180 } },
    { id: 'd', cmd: 'forget' },
    { id: 'e', cmd: 'cancel' },
    { id: 'f', cmd: 'status' },
    { id: 'z', cmd: 'status' },
  ];
  const { events } = await H.serve({
    timeoutMs: 10000,
    onEvent: (ev, send, raw) => {
      if (ev.type === 'hello') {
        send(sent[0]);
        raw('{ this is not json');           // malformed, cannot carry an id
        send(sent[1]);
        send(sent[2]);
        send(sent[3]);
        send(sent[4]);
        raw('[1, 2, 3]');                    // valid JSON, but not an object
        send(sent[5]);
        send(sent[6]);
        return false;
      }
      return ev.id === 'z';
    },
  });

  const got = replies(events);
  assert.deepStrictEqual(
    got.map((e) => [e.id, e.type, e.code || null]),
    [
      ['a', 'status', null],
      [null, 'error', 'BAD_REQUEST'],        // the unparseable line
      ['b', 'error', 'UNKNOWN_COMMAND'],
      ['c', 'error', 'INVALID_PROFILE'],
      ['d', 'forgotten', null],
      ['e', 'error', 'BAD_REQUEST'],         // cancel with nothing running
      [null, 'error', 'BAD_REQUEST'],        // the JSON array
      ['f', 'status', null],
      ['z', 'status', null],
    ],
    'nine replies, one per line sent, in the order the lines were written');

  for (const req of sent) onlyTerminal(events, req.id, 'INT-SYNC-02');
  for (const e of got) {
    assert.strictEqual(H.TERMINAL.has(e.type), true, `${e.type} is a terminal event type`);
    assert.strictEqual(e.proto, 1, 'every reply carries proto 1');
  }
});

// `accepted` and `progress` are the live stream a person standing on the scale
// sees. If the client mistook either for the answer, measure() would resolve
// before the reading existed and the app would display "undefined kg". Equally,
// nothing may arrive for that id once the measurement has been delivered: a
// late progress event would reopen a request the app has already closed.
test('INT-SYNC-03  accepted and progress never settle a measure; exactly one measurement does, and nothing follows it', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '40' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      // Force a further round trip so a late stray event for M1 would be seen.
      if (ev.type === 'measurement' && ev.id === 'M1') { send({ id: 'AFTER', cmd: 'status' }); return false; }
      return ev.id === 'AFTER';
    },
  });

  const mine = forId(events, 'M1');
  assert.strictEqual(mine[0].type, 'accepted', 'the first event for M1 is accepted');
  assert.strictEqual(H.byType(events, 'accepted').length, 1, 'accepted is sent once');

  const progress = H.byType(events, 'progress');
  assert.ok(progress.length >= 3, `the stream carried progress, got ${progress.length}`);
  for (const p of progress) {
    assert.strictEqual(p.id, 'M1', 'progress is tagged with the measure it belongs to');
    assert.strictEqual(H.STREAMING.has(p.type), true);
    assert.strictEqual(H.TERMINAL.has(p.type), false, 'progress is not a terminal type');
  }
  assert.strictEqual(H.TERMINAL.has('accepted'), false, 'accepted is not a terminal type');

  const terminal = onlyTerminal(events, 'M1', 'INT-SYNC-03');
  assert.strictEqual(terminal.type, 'measurement');
  assert.strictEqual(terminal.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(terminal.measured.impedanceOhm, H.EXPECTED.impedanceOhm);

  assert.strictEqual(mine[mine.length - 1], terminal,
    'the measurement is the last thing ever said about M1');
});

// The headline concurrency claim: a cheap reply may overtake a slow one. A host
// that correlated on arrival order instead of on id would hand the status reply
// to the measure promise, and the Electron app would report a body composition
// of `{busy: false}`.
test('INT-SYNC-04  a status sent mid-measurement is answered before the measurement it overtook', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'M1') { send({ id: 'S1', cmd: 'status' }); return false; }
      return ev.type === 'measurement' && ev.id === 'M1';
    },
  });

  const iStatus = indexOf(events, (e) => e.type === 'status' && e.id === 'S1');
  const iMeasure = indexOf(events, (e) => e.type === 'measurement' && e.id === 'M1');
  assert.ok(iStatus > 0, 'the status was answered');
  assert.ok(iMeasure > iStatus,
    `the status reply overtook the measurement (status at ${iStatus}, measurement at ${iMeasure})`);

  const status = events[iStatus];
  assert.strictEqual(status.busy, true, 'the status told the truth: a measurement was running');
  assert.strictEqual(status.runningId, 'M1', 'and named which one');

  onlyTerminal(events, 'S1', 'INT-SYNC-04');
  onlyTerminal(events, 'M1', 'INT-SYNC-04');
});

// The reply that overtook the measurement must not steal the stream with it.
// If progress events after an interleaved status were re-tagged with the status
// id, the Electron progress bar would go dead mid-weigh-in while a person stood
// on the scale waiting for it to move.
test('INT-SYNC-05  progress keeps the measure id while another reply is interleaved', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'M1') { send({ id: 'S1', cmd: 'status' }); return false; }
      return ev.type === 'measurement' && ev.id === 'M1';
    },
  });

  const iStatus = indexOf(events, (e) => e.type === 'status' && e.id === 'S1');
  const after = events.slice(iStatus + 1).filter((e) => e.type === 'progress');
  assert.ok(after.length >= 2, `the stream continued past the interleaved status, got ${after.length} progress events`);
  for (const p of after) assert.strictEqual(p.id, 'M1', 'progress still belongs to the measurement');

  assert.strictEqual(H.byType(events, 'progress').filter((p) => p.id === 'S1').length, 0,
    'no progress was ever misattributed to the status request');
  assert.strictEqual(forId(events, 'S1').length, 1, 'the status request produced exactly one event');
});

// Ids are the host's property. The service must hand back the exact value it
// was given, whatever shape it took, and in order. A client keying a Map on the
// id it sent will silently never resolve if the service normalises, stringifies
// or reorders them.
test('INT-SYNC-06  ids round trip unchanged, including unusual but legal ones', async () => {
  const ids = [
    'r-1',
    42,
    -7,
    3.5,
    1e21,
    true,
    'ünïcødé ☃ 好',
    'x'.repeat(512),
    'spaces and "quotes" and \\backslashes\\',
    { a: 1, b: [2, 3] },
    [1, 'two', null],
  ];
  const { events } = await H.serve({
    timeoutMs: 10000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        for (const id of ids) send({ id, cmd: 'status' });
        send({ id: 'LAST', cmd: 'status' });
        return false;
      }
      return ev.id === 'LAST';
    },
  });

  const statuses = H.byType(events, 'status').filter((e) => e.id !== 'LAST');
  assert.strictEqual(statuses.length, ids.length,
    `one status reply per id sent (sent ${ids.length}, got ${statuses.length})`);
  for (let i = 0; i < ids.length; i++) {
    assert.deepStrictEqual(statuses[i].id, ids[i],
      `id ${i} came back unchanged and in order: ${JSON.stringify(ids[i])}`);
  }
});

// A host that forgets an id still deserves an answer. Dropping the request
// would leave the Electron app with no reply at all, and no way to tell a lost
// message from a slow one.
test('INT-SYNC-07  a request with no id is answered with id null rather than dropped', async () => {
  const { events } = await H.serve({
    timeoutMs: 10000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ cmd: 'status' });                    // no id at all
        send({ cmd: 'no-such-command' });           // no id, and invalid
        send({ id: 'LAST', cmd: 'status' });
        return false;
      }
      return ev.id === 'LAST';
    },
  });

  const got = replies(events);
  assert.strictEqual(got.length, 3, 'all three requests were answered');
  assert.strictEqual(got[0].type, 'status');
  assert.strictEqual(got[0].id, null, 'the missing id came back as null');
  assert.strictEqual('id' in got[0], true, 'the id field is present, not merely absent');
  assert.strictEqual(got[1].type, 'error');
  assert.strictEqual(got[1].code, 'UNKNOWN_COMMAND');
  assert.strictEqual(got[1].id, null);
  assert.strictEqual(got[2].id, 'LAST');
});

// Documented asymmetry, not an aspiration. Success replies echo a falsy id
// verbatim; error replies flatten 0, '' and false to null, because the service
// builds them with `id || null`. A host that numbers its requests from zero
// will therefore never see the failure of request 0 unless it treats a null id
// on an error as "could be mine". This test pins the real behaviour so the
// asymmetry cannot change unnoticed.
test('INT-SYNC-08  falsy ids survive on success replies but collapse to null on errors', async () => {
  const { events } = await H.serve({
    timeoutMs: 10000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 0, cmd: 'status' });
        send({ id: '', cmd: 'status' });
        send({ id: false, cmd: 'status' });
        send({ id: 0, cmd: 'no-such-command' });
        send({ id: '', cmd: 'no-such-command' });
        send({ id: false, cmd: 'no-such-command' });
        send({ id: 'LAST', cmd: 'status' });
        return false;
      }
      return ev.id === 'LAST';
    },
  });

  const got = replies(events).filter((e) => e.id !== 'LAST');
  assert.deepStrictEqual(got.map((e) => [e.type, e.id]), [
    ['status', 0],
    ['status', ''],
    ['status', false],
    ['error', null],
    ['error', null],
    ['error', null],
  ], 'success replies keep a falsy id; error replies report null');
  for (const e of got.filter((x) => x.type === 'error')) {
    assert.strictEqual(e.code, 'UNKNOWN_COMMAND');
  }
});

// Two live requests sharing an id is a host bug, but it must not be a service
// crash: the Electron app would lose the whole pipe, and with it any
// measurement in flight. It also documents the consequence — the shared id
// collects two terminal events, so the host's own Map would be corrupted.
test('INT-SYNC-09  two requests sharing one id are both answered and the service survives', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '40' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'DUP', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'DUP') {
        send({ id: 'DUP', cmd: 'measure', profile: H.PROFILE });   // refused, same id
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'DUP';
    },
  });

  const terminals = terminalsFor(events, 'DUP');
  assert.deepStrictEqual(terminals.map((e) => e.type + (e.code ? '/' + e.code : '')),
    ['error/BUSY', 'measurement'],
    'each request was settled once, so the reused id collected two terminal events');
  assert.strictEqual(terminals[1].measured.weightKg, H.EXPECTED.weightKg,
    'the first measurement still produced the real reading');
});

// Someone stands on the scale and the app fires a second measure, from a double
// click or a second window. The overlap must be refused cleanly and, crucially,
// the refusal must not disturb the reading already in progress.
test('INT-SYNC-10  an overlapping measure is refused BUSY while the first still completes normally', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'M1') { send({ id: 'M2', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' && ev.id === 'M1';
    },
  });

  const busy = onlyTerminal(events, 'M2', 'INT-SYNC-10');
  assert.strictEqual(busy.type, 'error');
  assert.strictEqual(busy.code, 'BUSY');
  assert.strictEqual(busy.message, 'a measurement is already running; cancel it first');
  assert.strictEqual(H.byType(events, 'accepted').filter((e) => e.id === 'M2').length, 0,
    'the refused measure was never accepted');

  const done = onlyTerminal(events, 'M1', 'INT-SYNC-10');
  assert.strictEqual(done.type, 'measurement');
  assert.strictEqual(done.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(done.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(Object.keys(done.derived).length, 24);

  const iBusy = indexOf(events, (e) => e.id === 'M2');
  const iDone = indexOf(events, (e) => e.type === 'measurement');
  assert.ok(iBusy < iDone, 'the refusal came back immediately, not queued behind the measurement');
});

// Validation runs before the busy check, so a second measure carrying a bad
// profile is answered INVALID_PROFILE rather than BUSY. An Electron app that
// retried only on BUSY would otherwise loop for ever on a profile it can never
// fix. The in-flight measurement must survive the rejection untouched.
test('INT-SYNC-11  a bad profile during a running measurement is refused INVALID_PROFILE, not BUSY', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'accepted' && ev.id === 'M1') {
        send({ id: 'BAD', cmd: 'measure', profile: { age: 3, heightCm: 180, sex: 'male' } });
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'M1';
    },
  });

  const bad = onlyTerminal(events, 'BAD', 'INT-SYNC-11');
  assert.strictEqual(bad.type, 'error');
  assert.strictEqual(bad.code, 'INVALID_PROFILE',
    'profile validation is checked before the busy check');
  assert.strictEqual(bad.message, 'age must be a number between 5 and 120');

  const done = onlyTerminal(events, 'M1', 'INT-SYNC-11');
  assert.strictEqual(done.type, 'measurement');
  assert.strictEqual(done.measured.weightKg, H.EXPECTED.weightKg);
});

// Someone steps off and hits Cancel. The cancel request gets its own terminal
// event, and the measurement gets a different one, addressed to the id the app
// is actually waiting on. If CANCELLED were addressed to the cancel's id, the
// measure promise would hang for ever and the app would never leave "weighing".
test('INT-SYNC-12  cancel during a measurement yields cancelling for the cancel and CANCELLED for the measurement', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'progress' && ev.phase === 'ready') { send({ id: 'C1', cmd: 'cancel' }); return false; }
      return ev.type === 'error' && ev.id === 'M1';
    },
  });

  const ack = onlyTerminal(events, 'C1', 'INT-SYNC-12');
  assert.strictEqual(ack.type, 'cancelling');
  assert.strictEqual(ack.cancelling, 'M1', 'the acknowledgement names the measurement being stopped');

  const dead = onlyTerminal(events, 'M1', 'INT-SYNC-12');
  assert.strictEqual(dead.type, 'error');
  assert.strictEqual(dead.code, 'CANCELLED');
  assert.strictEqual(dead.message, 'the measurement was cancelled');

  assert.ok(indexOf(events, (e) => e.id === 'C1') < indexOf(events, (e) => e.type === 'error' && e.id === 'M1'),
    'the cancel is acknowledged before the measurement gives up');
  assert.strictEqual(H.byType(events, 'measurement').length, 0, 'no measurement was reported');
});

// The tightest race the host can create: measure and cancel written back to
// back with no wait, arriving in the same read. Both must still settle exactly
// once. A service that processed them out of order would answer the cancel with
// "nothing is running" and then leave a measurement running that the app
// believes it stopped.
test('INT-SYNC-13  measure and cancel written back to back both settle exactly once', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'M1', cmd: 'measure', profile: H.PROFILE });
        send({ id: 'C1', cmd: 'cancel' });
        return false;
      }
      return ev.type === 'error' && ev.id === 'M1';
    },
  });

  const ack = onlyTerminal(events, 'C1', 'INT-SYNC-13');
  assert.strictEqual(ack.type, 'cancelling');
  assert.strictEqual(ack.cancelling, 'M1');

  const dead = onlyTerminal(events, 'M1', 'INT-SYNC-13');
  assert.strictEqual(dead.type, 'error');
  assert.strictEqual(dead.code, 'CANCELLED');
  assert.strictEqual(H.byType(events, 'measurement').length, 0);
});

// A cancel that loses the race to a completed reading must not produce a second
// terminal event for the measurement. Two terminals for one id is the failure
// that makes an Electron client resolve and then reject the same promise, which
// surfaces as an unhandled rejection and, in production, a crashed main process.
test('INT-SYNC-14  a cancel arriving after the reading lands does not settle the measurement twice', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '40' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'measurement' && ev.id === 'M1') { send({ id: 'C1', cmd: 'cancel' }); return false; }
      return ev.id === 'C1';
    },
  });

  const done = onlyTerminal(events, 'M1', 'INT-SYNC-14');
  assert.strictEqual(done.type, 'measurement');
  assert.strictEqual(done.measured.weightKg, H.EXPECTED.weightKg);

  const late = onlyTerminal(events, 'C1', 'INT-SYNC-14');
  assert.strictEqual(late.type, 'error');
  assert.strictEqual(late.code, 'BAD_REQUEST');
  assert.strictEqual(late.message, 'nothing is running',
    'the late cancel is refused on its own id, not charged to the measurement');
  assert.strictEqual(H.byType(events, 'cancelling').length, 0, 'nothing was cancelled');
});

// The Electron app polls status to decide whether the Measure button is
// enabled. A status that lied about `busy`, or named the wrong `runningId`,
// would either grey out a working button for ever or invite a second measure
// that is guaranteed to be refused.
test('INT-SYNC-15  status reports busy and runningId truthfully before, during and after a measurement', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'BEFORE', cmd: 'status' });
        send({ id: 'M1', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      if (ev.type === 'accepted' && ev.id === 'M1') { send({ id: 'DURING', cmd: 'status' }); return false; }
      if (ev.type === 'measurement' && ev.id === 'M1') { send({ id: 'AFTER', cmd: 'status' }); return false; }
      return ev.id === 'AFTER';
    },
  });

  const at = (id) => {
    const s = onlyTerminal(events, id, 'INT-SYNC-15');
    assert.strictEqual(s.type, 'status', `${id} was answered with a status`);
    return s;
  };
  assert.deepStrictEqual([at('BEFORE').busy, at('BEFORE').runningId], [false, null], 'idle before');
  assert.deepStrictEqual([at('DURING').busy, at('DURING').runningId], [true, 'M1'], 'busy during, naming M1');
  assert.deepStrictEqual([at('AFTER').busy, at('AFTER').runningId], [false, null], 'idle again after');
});

// After a cancel the service must be genuinely idle, not merely reporting so.
// If the cancelled run left state behind, the next weigh-in would come back
// BUSY and the app would be wedged until the user restarted it.
test('INT-SYNC-16  a measurement started after a cancel succeeds', async () => {
  const { events } = await H.serve({
    env: { REPLAY_DELAY_MS: '40' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'progress' && ev.phase === 'ready' && ev.id === 'M1') { send({ id: 'C1', cmd: 'cancel' }); return false; }
      if (ev.type === 'error' && ev.id === 'M1') {
        send({ id: 'IDLE', cmd: 'status' });
        send({ id: 'M2', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      return (ev.type === 'measurement' || ev.type === 'error') && ev.id === 'M2';
    },
  });

  assert.strictEqual(onlyTerminal(events, 'M1', 'INT-SYNC-16').code, 'CANCELLED');
  const idle = onlyTerminal(events, 'IDLE', 'INT-SYNC-16');
  assert.deepStrictEqual([idle.busy, idle.runningId], [false, null], 'idle immediately after the cancel');

  const second = onlyTerminal(events, 'M2', 'INT-SYNC-16');
  assert.strictEqual(second.type, 'measurement', 'the retry produced a reading, not another error');
  assert.strictEqual(second.measured.weightKg, H.EXPECTED.weightKg);
  assert.strictEqual(second.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
  assert.strictEqual(H.byType(events, 'accepted').length, 2, 'both measures were accepted');
});

// A burst of commands, the kind a nervous UI sends when a user clicks around.
// If the service coalesced, dropped or reordered any of them, the client's
// pending map would keep entries that never resolve and the app would leak a
// promise per lost reply.
test('INT-SYNC-17  a rapid-fire burst of thirty commands is answered in full and in order', async () => {
  const cmds = [];
  for (let i = 1; i <= 30; i++) {
    cmds.push({ id: `q${i}`, cmd: ['status', 'forget', 'cancel'][i % 3] });
  }
  const { events } = await H.serve({
    timeoutMs: 15000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { for (const c of cmds) send(c); return false; }
      return ev.id === 'q30';
    },
  });

  const got = replies(events);
  assert.strictEqual(got.length, 30, `thirty commands, thirty replies (got ${got.length})`);
  assert.deepStrictEqual(got.map((e) => e.id), cmds.map((c) => c.id), 'answered in the order sent');
  const expectedTypes = cmds.map((c) => (c.cmd === 'status' ? 'status' : c.cmd === 'forget' ? 'forgotten' : 'error'));
  assert.deepStrictEqual(got.map((e) => e.type), expectedTypes, 'each command got the reply its verb calls for');
  for (const c of cmds) onlyTerminal(events, c.id, 'INT-SYNC-17');
});

// Closing the app while someone is mid-weigh-in. `bye` must be addressed to the
// shutdown request, the process must exit cleanly, and the abandoned
// measurement must not be settled twice on the way out — a double settle here
// is exactly what takes an Electron main process down during quit.
test('INT-SYNC-18  shutdown during a measurement answers bye, settles the measure at most once, and exits cleanly', async () => {
  const { events, code } = await H.serve({
    env: { REPLAY_DELAY_MS: '60' },
    timeoutMs: 20000,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'M1', cmd: 'measure', profile: H.PROFILE }); return false; }
      if (ev.type === 'progress' && ev.phase === 'ready') { send({ id: 'X', cmd: 'shutdown' }); return false; }
      return false;                                   // let the service exit on its own
    },
  });

  assert.strictEqual(code, 0, 'the service exited cleanly');
  const bye = onlyTerminal(events, 'X', 'INT-SYNC-18');
  assert.strictEqual(bye.type, 'bye');

  const dying = terminalsFor(events, 'M1');
  assert.ok(dying.length <= 1,
    `the abandoned measurement was settled at most once, got [${dying.map((e) => e.type + '/' + e.code).join(', ')}]`);
  const iBye = indexOf(events, (e) => e.type === 'bye');
  assert.ok(dying.every((e) => events.indexOf(e) > iBye),
    'bye is answered first; anything for the abandoned measure comes after it');
  assert.strictEqual(H.byType(events, 'measurement').length, 0, 'no reading was invented on the way out');
});

// The same interleaving, seen from the Electron main process. BodyScaleClient
// keys its pending map on id, so a status awaited while a measurement runs must
// resolve with the status and leave the measure promise open. Cross-wiring here
// is what would make `await client.measure(...)` return `{busy: false}`.
test('INT-SYNC-19  the client resolves concurrent measure and status on their own ids', async () => {
  const client = new BodyScaleClient({
    scaleDir: H.ROOT,
    replay: H.FIXTURE,
    env: { BODYSCALE_CONFIG_DIR: H.tmpdir('sync19'), REPLAY_DELAY_MS: '60' },
  });
  try {
    await client.start();
    const order = [];
    const measuring = client.measure(H.PROFILE).then((r) => { order.push('measure'); return r; });

    await new Promise((resolve) => client.once('accepted', resolve));
    const status = await client.status();
    order.push('status');

    assert.strictEqual(status.type, 'status', 'status() resolved with a status, not a measurement');
    assert.strictEqual(status.busy, true);
    assert.strictEqual(client.busy, true, 'the client knows a measurement it owns is running');

    let refused = null;
    await client.measure(H.PROFILE).catch((e) => { refused = e; });
    assert.ok(refused, 'the overlapping measure rejected');
    assert.strictEqual(refused.code, 'BUSY');
    assert.strictEqual(client.busy, true, 'a BUSY rejection does not clear the flag the first measure owns');

    const result = await measuring;
    assert.deepStrictEqual(order, ['status', 'measure'], 'the status resolved first, the measure second');
    assert.strictEqual(result.type, 'measurement');
    assert.strictEqual(result.measured.weightKg, H.EXPECTED.weightKg);
    assert.strictEqual(result.measured.impedanceOhm, H.EXPECTED.impedanceOhm);
    assert.notStrictEqual(result.id, status.id, 'the two replies carried different ids');
    assert.strictEqual(client.busy, false, 'the client is idle once its own measure settles');
  } finally {
    await client.stop();
  }
});

// Cancel as the Electron app performs it. cancel() must resolve with its own
// acknowledgement while the measure promise rejects with CANCELLED, and the
// client must be usable straight afterwards. If cancel() resolved the measure
// promise instead, the app would show a reading that was never taken.
test('INT-SYNC-20  the client settles cancel and the cancelled measure separately, and measures again after', async () => {
  const client = new BodyScaleClient({
    scaleDir: H.ROOT,
    replay: H.FIXTURE,
    env: { BODYSCALE_CONFIG_DIR: H.tmpdir('sync20'), REPLAY_DELAY_MS: '60' },
  });
  try {
    await client.start();
    let rejection = null;
    const measuring = client.measure(H.PROFILE).catch((e) => { rejection = e; return null; });

    await new Promise((resolve) => client.once('ready', resolve));
    const ack = await client.cancel();
    const settled = await measuring;

    assert.strictEqual(settled, null, 'the measure promise did not resolve with a reading');
    assert.ok(rejection, 'the measure promise rejected');
    assert.strictEqual(rejection.code, 'CANCELLED');
    assert.strictEqual(rejection.name, 'ScaleError');
    assert.strictEqual(ack.type, 'cancelling', 'cancel() resolved with its own acknowledgement');
    assert.notStrictEqual(ack.id, ack.cancelling, 'the acknowledgement is addressed to the cancel, and names the measure');
    assert.strictEqual(client.busy, false, 'the client is idle after the cancel');

    const again = await client.measure(H.PROFILE);
    assert.strictEqual(again.type, 'measurement');
    assert.strictEqual(again.measured.weightKg, H.EXPECTED.weightKg);
    assert.notStrictEqual(again.id, ack.cancelling, 'the retry used a fresh id');
  } finally {
    await client.stop();
  }
});
