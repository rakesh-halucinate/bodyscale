'use strict';
// INT-PROF — Profile ownership and validation.
//
// The division of responsibility is the whole point of this integration: the
// Electron app owns the person, this service owns the device. The app sends
// age, heightCm and sex with every measurement; the service supplies the
// weight, the impedance and every derived figure, and keeps no record of who
// was standing on the scale.
//
// These cases pin that boundary down from both sides — that the service
// refuses to proceed without the profile, and that it never quietly supplies
// one of its own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('./harness');

/** Send one measure and return the first terminal event for it. */
function attempt(profile, { env = {}, id = 'P' } = {}) {
  return H.serve({
    env,
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id, cmd: 'measure', profile }); return false; }
      return (ev.type === 'error' || ev.type === 'measurement') && ev.id === id;
    },
  }).then(({ events }) => ({
    events,
    terminal: events.find((e) => (e.type === 'error' || e.type === 'measurement') && e.id === id),
    accepted: events.find((e) => e.type === 'accepted'),
  }));
}

// --- the contract, declared -------------------------------------------------

// Prevents: a host shipping without sending the profile because it assumed the
// service remembered the user, and only discovering at runtime that every
// measurement is rejected.
test('INT-PROF-01  the handshake declares that the host owns the profile', async () => {
  const { events } = await H.serve({ onEvent: (ev) => ev.type === 'hello' });
  const hello = H.first(events, 'hello');
  assert.ok(hello.profile, 'hello carries a profile block');
  assert.strictEqual(hello.profile.required, true);
  assert.strictEqual(hello.profile.suppliedBy, 'host');
  assert.strictEqual(hello.profile.persisted, false);
  assert.deepStrictEqual(hello.profile.fields, ['age', 'heightCm', 'sex']);
});

// --- required fields --------------------------------------------------------

// Prevents: a measurement running to completion on a default age the user never
// gave, producing a body composition panel that looks authoritative and is not.
test('INT-PROF-02  a measure with no profile at all is rejected', async () => {
  const r = await attempt(undefined);
  assert.strictEqual(r.terminal.type, 'error');
  assert.strictEqual(r.terminal.code, 'INVALID_PROFILE');
  assert.match(r.terminal.message, /profile/i);
});

// Prevents: the same, for a host that sends the key but leaves it empty.
test('INT-PROF-03  a null profile and an array profile are both rejected', async () => {
  for (const bad of [null, [], [39, 180]]) {
    const r = await attempt(bad);
    assert.strictEqual(r.terminal.type, 'error', `rejected ${JSON.stringify(bad)}`);
    assert.strictEqual(r.terminal.code, 'INVALID_PROFILE');
  }
});

// Prevents: BMR and the body-fat cross-check being computed from a missing age,
// which silently becomes NaN and poisons every figure downstream.
test('INT-PROF-04  age is required and the message names it', async () => {
  const r = await attempt({ heightCm: 180, sex: 'male' });
  assert.strictEqual(r.terminal.code, 'INVALID_PROFILE');
  assert.match(r.terminal.message, /age/, `message names the field: ${r.terminal.message}`);
});

// Prevents: BMI and every height-normalised index being wrong without warning.
test('INT-PROF-05  heightCm is required and the message names it', async () => {
  const r = await attempt({ age: 39, sex: 'male' });
  assert.strictEqual(r.terminal.code, 'INVALID_PROFILE');
  assert.match(r.terminal.message, /height/i, `message names the field: ${r.terminal.message}`);
});

// --- ranges, on both sides of each boundary ---------------------------------

// Prevents: a mistyped age of 3 or 300 being accepted and driving equations
// that were fitted on adults, with no indication anything is wrong.
test('INT-PROF-06  age is accepted at 5 and 120 and refused at 4 and 121', async () => {
  for (const age of [5, 120]) {
    const r = await attempt({ age, heightCm: 180, sex: 'male' });
    assert.strictEqual(r.terminal.type, 'measurement', `age ${age} accepted`);
  }
  for (const age of [4, 121]) {
    const r = await attempt({ age, heightCm: 180, sex: 'male' });
    assert.strictEqual(r.terminal.code, 'INVALID_PROFILE', `age ${age} refused`);
  }
});

// Prevents: a height entered in metres (1.8) or inches (71) sailing through and
// producing a BMI out by a factor of thousands.
test('INT-PROF-07  heightCm is accepted at 90 and 250 and refused at 89 and 251', async () => {
  for (const heightCm of [90, 250]) {
    const r = await attempt({ age: 39, heightCm, sex: 'male' });
    assert.strictEqual(r.terminal.type, 'measurement', `height ${heightCm} accepted`);
  }
  for (const heightCm of [89, 251, 1.8, 71]) {
    const r = await attempt({ age: 39, heightCm, sex: 'male' });
    assert.strictEqual(r.terminal.code, 'INVALID_PROFILE', `height ${heightCm} refused`);
  }
});

// Prevents: a form field arriving as text and being coerced to NaN somewhere
// deep in the maths rather than refused at the door.
test('INT-PROF-08  non-numeric age and height are refused', async () => {
  const bad = [
    { age: 'thirty-nine', heightCm: 180 },
    { age: 39, heightCm: 'tall' },
    { age: null, heightCm: 180 },
    { age: 39, heightCm: null },
    { age: {}, heightCm: 180 },
    { age: 'NaN', heightCm: 180 },
    { age: 'Infinity', heightCm: 180 },
  ];
  for (const profile of bad) {
    const r = await attempt(profile);
    assert.strictEqual(r.terminal.code, 'INVALID_PROFILE', `refused ${JSON.stringify(profile)}`);
  }
});

// --- sex --------------------------------------------------------------------

// Prevents: an unexpected value being treated as one sex or the other silently,
// when the body-fat and lean-mass equations differ substantially between them.
test('INT-PROF-09  sex accepts only male or female', async () => {
  for (const sex of ['male', 'female', 'MALE', 'Female']) {
    const r = await attempt({ age: 39, heightCm: 180, sex });
    assert.strictEqual(r.terminal.type, 'measurement', `${sex} accepted`);
  }
  for (const sex of ['other', 'm', 'f', 'unknown', 1]) {
    const r = await attempt({ age: 39, heightCm: 180, sex });
    assert.strictEqual(r.terminal.code, 'INVALID_PROFILE', `${JSON.stringify(sex)} refused`);
  }
});

// Prevents: a host that omits sex not realising an assumption was made for it,
// and presenting a female user's result computed with male coefficients.
test('INT-PROF-10  sex defaults to male and the reply says so', async () => {
  const r = await attempt({ age: 39, heightCm: 180 });
  assert.strictEqual(r.terminal.type, 'measurement');
  assert.strictEqual(r.accepted.profile.sex, 'male', 'the assumption is stated in accepted');
  assert.strictEqual(r.terminal.profile.sex, 'male', 'and again in the result');
});

// --- rejection costs nothing ------------------------------------------------

// Prevents: a bad profile leaving the scale connected and the radio held, so
// the next attempt fails for a reason unrelated to the real mistake.
test('INT-PROF-11  a rejected profile starts no radio work at all', async () => {
  const r = await attempt({ age: 2, heightCm: 180 });
  assert.strictEqual(r.terminal.code, 'INVALID_PROFILE');
  assert.strictEqual(r.accepted, undefined, 'nothing was accepted');
  assert.deepStrictEqual(H.byType(r.events, 'progress'), [], 'no progress, so no connection was attempted');
});

// Prevents: one mistyped age wedging the service for the rest of the session.
test('INT-PROF-12  the service still works after a rejected profile', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'bad', cmd: 'measure', profile: { age: 2 } }); return false; }
      if (ev.type === 'error' && ev.id === 'bad') {
        send({ id: 'good', cmd: 'measure', profile: H.PROFILE });
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'good';
    },
  });
  const m = events.find((e) => e.type === 'measurement' && e.id === 'good');
  assert.ok(m, 'the next measurement succeeded');
  assert.strictEqual(m.measured.weightKg, H.EXPECTED.weightKg);
});

// --- the service keeps nothing ----------------------------------------------

// Prevents: the user's age and height sitting in a file on disk that the app
// never wrote and cannot see, outliving the record the app itself holds.
test('INT-PROF-13  a completed measurement writes no profile to disk', async () => {
  const dir = H.tmpdir('prof-write');
  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  assert.ok(H.first(events, 'measurement'), 'the measurement succeeded');

  const file = path.join(dir, 'scale-config.json');
  assert.ok(fs.existsSync(file), 'a config was written for the device');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('profile' in cfg), `no profile was stored, got keys: ${Object.keys(cfg).join(', ')}`);
  assert.ok(cfg[`address_${process.platform}`], 'but the device identity was remembered');
});

// Prevents: the service quietly adopting a stored profile instead of the one
// the host sent. It must read the request and only the request — a config left
// by the terminal tool describes a different person as far as the host knows.
//
// It must also not DELETE that profile, which an earlier version did: the
// terminal tool owns it, and removing it reset a user's age and height to
// fallback defaults without a word. INT-PROF-21 covers that side.
test('INT-PROF-14  a stored profile is ignored in favour of the one sent', async () => {
  const dir = H.tmpdir('prof-inherit');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({
    name: 'SSW533',
    profile: { sex: 'female', age: 44, heightCm: 162 },
    [`address_${process.platform}`]: 'PREVIOUSLY-KNOWN',
  }));

  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  assert.ok(H.first(events, 'measurement'), 'the measurement succeeded');

  const m = H.first(events, 'measurement');
  assert.deepStrictEqual(m.profile, { sex: 'male', age: 39, heightCm: 180 },
    'the measurement used the profile from the request, not the one on disk');

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.deepStrictEqual(cfg.profile, { sex: 'female', age: 44, heightCm: 162 },
    'and left the stored one untouched, because the terminal tool owns it');
  assert.ok(cfg[`address_${process.platform}`], 'the device identity was remembered');
});

// Prevents: the worst version of this — the service silently measuring against
// a stale stored profile when the host forgot to send one, so the app displays
// someone else's body composition.
test('INT-PROF-15  a stored profile is never used to fill in a missing one', async () => {
  const dir = H.tmpdir('prof-nodefault');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({
    name: 'SSW533',
    profile: { sex: 'female', age: 44, heightCm: 162 },
  }));
  const r = await attempt(undefined, { env: { BODYSCALE_CONFIG_DIR: dir } });
  assert.strictEqual(r.terminal.code, 'INVALID_PROFILE', 'refused rather than substituting');
  assert.strictEqual(r.accepted, undefined, 'and nothing was accepted');
});

// --- the profile genuinely drives the result --------------------------------

// Prevents: a host believing the profile matters when it is in fact ignored,
// which would make every user's panel identical.
test('INT-PROF-16  identical frames with two profiles give the same weight and different metrics', async () => {
  const [a, b] = await Promise.all([
    H.measureOnce({ profile: { age: 39, heightCm: 180, sex: 'male' } }),
    H.measureOnce({ profile: { age: 25, heightCm: 165, sex: 'female' } }),
  ]);
  assert.strictEqual(a.terminal.type, 'measurement');
  assert.strictEqual(b.terminal.type, 'measurement');

  assert.deepStrictEqual(a.terminal.measured, b.terminal.measured,
    'the scale reading does not depend on who the app says is standing on it');

  assert.notStrictEqual(a.terminal.derived.bmi, b.terminal.derived.bmi, 'height changes BMI');
  assert.notStrictEqual(a.terminal.derived.bmrKcal, b.terminal.derived.bmrKcal, 'age changes BMR');
  assert.notStrictEqual(a.terminal.derived.bodyFatPercent, b.terminal.derived.bodyFatPercent,
    'sex changes body fat');
});

// Prevents: a host mapping results to the wrong person, because it could not
// tell from the reply which profile produced it.
test('INT-PROF-17  the result echoes back exactly the three fields, normalised', async () => {
  const r = await H.measureOnce({ profile: { age: 44, heightCm: 162, sex: 'FEMALE' } });
  assert.deepStrictEqual(r.terminal.profile, { sex: 'female', age: 44, heightCm: 162 },
    'lower-cased, and carrying nothing but the three fields');
});

// Prevents: an app sending its whole user record and the extra fields either
// being rejected or, worse, silently stored.
test('INT-PROF-18  unknown profile fields are ignored, not rejected or kept', async () => {
  const dir = H.tmpdir('prof-extra');
  const r = await H.measureOnce({
    profile: { age: 39, heightCm: 180, sex: 'male', name: 'Test User', email: 'a@b.c', weightGoalKg: 80 },
    env: { BODYSCALE_CONFIG_DIR: dir },
  });
  assert.strictEqual(r.terminal.type, 'measurement', 'the extra fields did not cause a rejection');
  assert.deepStrictEqual(r.terminal.profile, { sex: 'male', age: 39, heightCm: 180 },
    'and only the three known fields came back');

  const file = path.join(dir, 'scale-config.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.ok(!/Test User|a@b\.c/.test(raw), 'nothing the host sent about the person was written to disk');
});

// Prevents: a numeric string from an HTML input being refused when the intent
// is unambiguous, or accepted inconsistently between the two fields.
test('INT-PROF-19  numeric strings are handled the same way for age and height', async () => {
  const r = await attempt({ age: '39', heightCm: '180', sex: 'male' });
  // Number('39') is 39, so the service accepts these. Pinning the behaviour so
  // a future tightening is a deliberate decision rather than a silent change.
  assert.strictEqual(r.terminal.type, 'measurement',
    'numeric strings are coerced, not refused');
  assert.deepStrictEqual(r.terminal.profile, { sex: 'male', age: 39, heightCm: 180 },
    'and they come back as real numbers, so the host never has to re-parse');
});

// Prevents: a second measurement inheriting the first one's profile, so a
// household sharing a scale sees one person's figures for everyone.
test('INT-PROF-20  each measurement uses only the profile sent with it', async () => {
  const { events } = await H.serve({
    onEvent: (ev, send) => {
      if (ev.type === 'hello') {
        send({ id: 'one', cmd: 'measure', profile: { age: 39, heightCm: 180, sex: 'male' } });
        return false;
      }
      if (ev.type === 'measurement' && ev.id === 'one') {
        send({ id: 'two', cmd: 'measure', profile: { age: 25, heightCm: 165, sex: 'female' } });
        return false;
      }
      return ev.type === 'measurement' && ev.id === 'two';
    },
  });
  const one = events.find((e) => e.type === 'measurement' && e.id === 'one');
  const two = events.find((e) => e.type === 'measurement' && e.id === 'two');
  assert.ok(one && two, 'both measurements completed on one service instance');
  assert.deepStrictEqual(one.profile, { sex: 'male', age: 39, heightCm: 180 });
  assert.deepStrictEqual(two.profile, { sex: 'female', age: 25, heightCm: 165 });
  assert.notStrictEqual(one.derived.bmi, two.derived.bmi, 'and the second used its own height');
});

// --- the CLI's own profile, which the service must not disturb ---------------

const { execFileSync } = require('child_process');

/** Run the terminal tool against the recorded session in an isolated config. */
function cli(args, dir) {
  return execFileSync(process.execPath, [H.SCALE, '--replay', H.FIXTURE, ...args], {
    cwd: H.ROOT, encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: dir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** stderr carries the commentary; execFileSync only returns stdout. */
function cliStderr(args, dir) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [H.SCALE, '--replay', H.FIXTURE, ...args], {
    cwd: H.ROOT, encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { BODYSCALE_CONFIG_DIR: dir }),
  });
  return r.stderr || '';
}

// Prevents: the exact regression seen in the field. Service mode used to DELETE
// the stored profile, so the next terminal run found none, fell back to 30 and
// 170, and reported body composition for a person who does not exist — with
// nothing on screen to say the age and height were invented.
test('INT-PROF-21  a service-mode measurement leaves the terminal tool profile intact', async () => {
  const dir = H.tmpdir('prof-coexist');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({
    name: 'SSW533',
    profile: { sex: 'female', age: 44, heightCm: 162 },
    [`address_${process.platform}`]: 'KNOWN',
  }));

  const { events } = await H.serve({
    env: { BODYSCALE_CONFIG_DIR: dir },
    onEvent: (ev, send) => {
      if (ev.type === 'hello') { send({ id: 'm', cmd: 'measure', profile: H.PROFILE }); return false; }
      return ev.type === 'measurement' || ev.type === 'error';
    },
  });
  const m = H.first(events, 'measurement');
  assert.ok(m, 'the service measurement succeeded');
  assert.deepStrictEqual(m.profile, { sex: 'male', age: 39, heightCm: 180 },
    'and used the profile the HOST sent, not the stored one');

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.deepStrictEqual(cfg.profile, { sex: 'female', age: 44, heightCm: 162 },
    "the terminal tool's own profile was left exactly as it was");
});

// Prevents: a guess hardening into a setting. Writing an invented age back to
// disk makes it indistinguishable from one the user chose, so every later run
// inherits it silently and looks deliberate.
test('INT-PROF-22  an invented profile is never written to disk', async () => {
  const dir = H.tmpdir('prof-guess');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({ name: 'SSW533' }));

  cli(['--quiet'], dir);

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.ok(!cfg.profile, `no profile was persisted, got ${JSON.stringify(cfg.profile)}`);
});

// Prevents: the silent version of the same failure. If the tool must guess, it
// has to say so loudly enough that the user fixes it, because every derived
// figure below is computed for the wrong person.
test('INT-PROF-23  a guessed profile is announced, not applied quietly', async () => {
  const dir = H.tmpdir('prof-warn');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({ name: 'SSW533' }));

  const stderr = cliStderr([], dir);
  assert.match(stderr, /never given/i, 'it says a value was missing');
  assert.match(stderr, /wrong person/i, 'and what that costs');
  assert.match(stderr, /--age/, 'and how to fix it');
});

// Prevents: the opposite failure — nagging a user who HAS set their profile.
test('INT-PROF-24  a profile the user supplied is remembered and never warned about', async () => {
  const dir = H.tmpdir('prof-known');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({ name: 'SSW533' }));

  const first = cliStderr(['--sex', 'female', '--age', '44', '--height', '162'], dir);
  assert.doesNotMatch(first, /never given/i, 'a supplied profile draws no warning');

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'scale-config.json'), 'utf8'));
  assert.deepStrictEqual(cfg.profile, { sex: 'female', age: 44, heightCm: 162 },
    'and it is remembered, so later runs need no flags');

  const second = cliStderr([], dir);
  assert.doesNotMatch(second, /never given/i, 'nor does the run that reads it back');
  assert.match(second, /44y, 162cm/, 'which uses the remembered values');
});

// Prevents: the migration reaching back into the project directory when a
// caller explicitly asked for an isolated config, which is how twenty-one
// concurrent test files started sharing one developer's stored profile.
test('INT-PROF-25  the legacy migration respects an explicit config directory', async () => {
  const dir = H.tmpdir('prof-isolated');
  fs.writeFileSync(path.join(dir, 'scale-config.json'), JSON.stringify({ name: 'SSW533' }));

  const stderr = cliStderr([], dir);
  // The project has a .scale-config.json beside the script carrying a profile.
  // An isolated run must not adopt it.
  assert.match(stderr, /never given/i,
    'an isolated run found no profile, rather than borrowing the one beside the script');
});
