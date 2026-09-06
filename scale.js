#!/usr/bin/env node
/*
 * scale.js — read a Bluetooth LE body scale from the terminal and print JSON.
 *
 * No browser, so no device chooser. That dialog is a browser security feature;
 * a local process addresses the scale by name, learns its address on the first
 * run, and connects straight to it every time after that.
 *
 *   node scale.js                 measure once, print JSON, exit
 *   node scale.js --watch         keep measuring until interrupted
 *   node scale.js --quiet         JSON only on stdout, progress on stderr
 *   node scale.js --raw           also print every decoded frame
 *   node scale.js --forget        drop the saved device and rescan by name
 *
 * Profile, needed to turn weight and impedance into body composition:
 *   node scale.js --sex male --age 39 --height 180
 * Saved after the first run, so later runs need no flags.
 *
 * Decoding is the same code the browser version uses, covered by the test suite.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const BCS = require('./bcs.js');
const ScalesDB = require('./scales-db.js');
const BIA = require('./bia.js');
const Drivers = require('./drivers.js');

const ROOT = __dirname;
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
  catch (e) { return '0.0.0'; }
})();
const IS_WINDOWS = process.platform === 'win32';

/*
 * The config must not live in the install directory.
 *
 * A packaged app puts this code under resources/, which is inside Program Files
 * on Windows and inside a signed .app on macOS. Writing there fails for a
 * standard user, and on macOS it invalidates the bundle signature. So the
 * remembered device goes in the per-user data directory, and an existing config
 * beside the script is still read, so nothing is lost on upgrade.
 */
function userConfigDir() {
  if (process.env.BODYSCALE_CONFIG_DIR) return process.env.BODYSCALE_CONFIG_DIR;
  const home = os.homedir();
  if (IS_WINDOWS) return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'bodyscale');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'bodyscale');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'bodyscale');
}
const CONFIG = path.join(userConfigDir(), 'scale-config.json');
const LEGACY_CONFIG = path.join(ROOT, '.scale-config.json');

/*
 * Finding the interpreter differs by platform, and not cosmetically.
 *
 * macOS kills any process that touches CoreBluetooth from a bundle with no
 * Bluetooth usage description, so the transport must run through the bundle
 * setup-mac.sh builds rather than a bare interpreter.
 *
 * Windows has no such rule. A normal venv interpreter is fine, and bleak's WinRT
 * backend needs nothing declared for a console application.
 */
/*
 * A virtual environment is not relocatable. Its pyvenv.cfg records an absolute
 * `home =` pointing at the base interpreter on the machine that built it, and
 * the venv is useless anywhere else. A build that ships both .venv and an
 * embedded runtime would otherwise prefer the broken one and fail at measure
 * time rather than at start, so check before trusting it.
 */
function venvIsUsable(venvDir) {
  try {
    const cfg = fs.readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf8');
    const home = (cfg.match(/^\s*home\s*=\s*(.+)$/m) || [])[1];
    if (!home) return true;                 // no home recorded; give it a chance
    return fs.existsSync(home.trim());
  } catch (e) {
    return true;                            // no pyvenv.cfg to judge by
  }
}

function findPython() {
  if (process.env.BODYSCALE_PYTHON) return process.env.BODYSCALE_PYTHON;
  const venv = path.join(ROOT, '.venv');
  const candidates = IS_WINDOWS
    ? [{ exe: path.join(venv, 'Scripts', 'python.exe'), venv },
       { exe: path.join(ROOT, 'python', 'python.exe') }]   // an embedded runtime, if one is shipped
    : [{ exe: path.join(ROOT, 'blehost') },                // the bundle that declares the usage description
       { exe: path.join(venv, 'bin', 'python'), venv }];
  for (const c of candidates) {
    if (!fs.existsSync(c.exe)) continue;
    if (c.venv && !venvIsUsable(c.venv)) {
      // note() is not initialised yet: this runs while the module is still
      // loading. stderr is never the data channel, so writing there is safe.
      process.stderr.write(`ignoring ${c.exe}: its virtual environment was built on another machine\n`);
      continue;
    }
    return c.exe;
  }
  return IS_WINDOWS ? 'python' : 'python3';
}
const PYTHON = findPython();

/*
 * Device identifiers are not portable. macOS gives a CoreBluetooth UUID that is
 * specific to that Mac; Windows gives a Bluetooth MAC address. A config carried
 * between machines must therefore key the saved address by platform, or the
 * saved value silently never matches and every run falls back to a name scan.
 */
const ADDRESS_KEY = `address_${process.platform}`;

/*
 * Prove the transport works before promising the user anything.
 *
 * On Windows this is not paranoia. If Python is not installed, the name
 * "python" still resolves: Windows ships an App Execution Alias at
 * %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe which spawns successfully,
 * prints "Python was not found; run without arguments to install from the
 * Microsoft Store", and exits non-zero. The spawn succeeds, so an ENOENT check
 * never fires, and the measurement fails with "no reading arrived" — telling
 * the user to stand on a scale that was never contacted.
 *
 * The result is cached: the answer cannot change while the process runs.
 */
let TRANSPORT_CHECK = null;
function selfTestTransport(exe) {
  if (TRANSPORT_CHECK && TRANSPORT_CHECK.exe === exe) return TRANSPORT_CHECK;
  const r = spawnSync(exe, [path.join(ROOT, 'ble.py'), '--selftest'],
                      { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  let check;
  if (r.error) {
    check = { ok: false, reason: 'spawn-failed', message: r.error.message };
  } else if (/Microsoft Store|was not found; run without arguments/i.test(out) || r.status === 9009) {
    check = { ok: false, reason: 'store-alias',
              message: `"${exe}" is the Microsoft Store placeholder, not a Python installation. `
                     + 'Install Python from python.org, run setup-win.ps1, or point BODYSCALE_PYTHON '
                     + 'at a real interpreter.' };
  } else if (r.status !== 0) {
    let detail = (out.match(/"error":"([^"]+)"/) || [])[1] || out.trim().split('\n')[0] || `exit ${r.status}`;
    check = { ok: false, reason: 'bleak-missing',
              message: `the Bluetooth helper cannot run: ${detail}. Run setup-mac.sh, or setup-win.ps1 on Windows.` };
  } else {
    let info = {};
    try { info = JSON.parse((out.match(/^\{.*"selftest".*\}$/m) || ['{}'])[0]); } catch (e) { /* not fatal */ }
    check = { ok: true, bleak: info.bleak || 'unknown', python: info.python || 'unknown' };
  }
  check.exe = exe;
  TRANSPORT_CHECK = check;
  return check;
}

// ---------- arguments ----------
function parseArgs(argv) {
  const a = { watch: false, quiet: false, raw: false, forget: false, name: 'SSW533',
              scanTimeout: 20, connectTimeout: 20, hold: 120 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], next = () => argv[++i];
    if (k === '--watch') a.watch = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--raw') a.raw = true;
    else if (k === '--forget') a.forget = true;
    else if (k === '--name') a.name = next();
    else if (k === '--address') a.address = next();
    else if (k === '--sex') a.sex = next();
    else if (k === '--age') a.age = Number(next());
    else if (k === '--height') a.heightCm = Number(next());
    else if (k === '--scan-timeout') a.scanTimeout = Number(next());
    else if (k === '--connect-timeout') a.connectTimeout = Number(next());
    else if (k === '--hold') a.hold = Number(next());
    else if (k === '--replay') a.replay = next() || path.join(ROOT, 'fixtures', 'ssw533-session.jsonl');
    else if (k === '--interval') a.interval = Number(next());
    else if (k === '--repeats') a.allowRepeats = true;
    else if (k === '--max') a.max = Number(next());
    else if (k === '--max-attempts') a.maxAttempts = Number(next());
    else if (k === '--serve') a.serve = true;
    else if (k === '--python') a.python = next();
    else if (k === '--hint-after') a.hintAfterSec = Number(next());
    else if (k === '--impedance-wait') a.impedanceWaitSec = Number(next());
    else if (k === '-h' || k === '--help') a.help = true;
    else { console.error(`unknown option: ${k}`); a.help = true; a.badOption = true; }
  }
  return a;
}

const HELP = `read a Bluetooth LE body scale and print JSON

  node scale.js                     measure once
  node scale.js --watch             keep measuring
  node scale.js --quiet             JSON only on stdout
  node scale.js --raw               also print each decoded frame
  node scale.js --forget            forget the saved device, rescan by name
  node scale.js --replay            decode a captured session, no Bluetooth

Service mode, for an Electron or other host application:
  node scale.js --serve             newline-delimited JSON on stdin and stdout

Rehearse the Electron flow in a terminal:
  node simulate.js                  capture, hold the reading, then enter details
  node simulate.js --replay         the same, with no hardware

Loop mode:
  node scale.js --watch             measure over and over until Ctrl+C
  --interval <s>    pause between attempts, default 3
  --repeats         report a held reading again instead of skipping it
  --max <n>         stop after n measurements
  --max-attempts <n>  stop after n tries, whether or not they produced a reading

  --name <n>        device name to look for (default SSW533)
  --address <a>     connect straight to this address
  --sex male|female
  --age <years>
  --height <cm>
  --scan-timeout <s>     default 20
  --connect-timeout <s>  default 20
  --hold <s>             give up waiting for a reading, default 120
  --python <path>        interpreter for the Bluetooth helper
                         (or set BODYSCALE_PYTHON)
  --hint-after <s>       nudge the user after this long with nothing, default 8
  --impedance-wait <s>   stay connected this long after the weight locks, while
                         the scale runs its own impedance program, default 30

The profile is remembered in .scale-config.json after the first run.`;

// ---------- config ----------
const readConfig = () => {
  let c = null;
  for (const file of [CONFIG, LEGACY_CONFIG]) {           // new location wins
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')); break; } catch (e) { /* try the next */ }
  }
  if (!c || typeof c !== 'object') c = {};
  // The per-user config may have been created by a run that never knew the
  // profile, while the older file beside the script still holds the real one.
  // Adopt it rather than leaving the user silently measured as someone else.
  //
  // Only when using the DEFAULT location. A caller that named a config
  // directory — a test, or a host with its own data directory — asked for
  // isolation, and reaching back to the script directory would break it.
  if (!c.profile && !process.env.BODYSCALE_CONFIG_DIR) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
      if (legacy && legacy.profile) c.profile = legacy.profile;
    } catch (e) { /* no legacy file, or unreadable */ }
  }
  // Earlier versions stored one address with no platform key. Adopt it only on
  // macOS, where it was written; a CoreBluetooth UUID means nothing elsewhere.
  if (c.address && !c[ADDRESS_KEY] && process.platform === 'darwin') {
    c[ADDRESS_KEY] = c.address;
    delete c.address;                    // migrated, so the old key can go
  }
  // On any other platform the legacy key is left untouched. Deleting it here
  // would erase the Mac's remembered device the first time the same config was
  // read on Windows.
  return c;
};
const writeConfig = (c) => {
  try {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n');
  } catch (e) {
    // Visible even in service mode, where this used to fail silently and cost
    // a full scan on every launch.
    note(`could not save config to ${CONFIG}: ${e.message}`);
    note('the device will not be remembered, so each measurement will scan first');
  }
};

/*
 * QUIET silences the human commentary on the terminal. It must NOT silence
 * service mode: there, stdout carries the protocol and stderr is the only
 * diagnostic channel the host has. Silencing it hid the transport's own error
 * lines, which are the only thing that names why a connection failed.
 */
let QUIET = false;
let LOG_ALWAYS = false;
const note = (msg) => { if (!QUIET || LOG_ALWAYS) process.stderr.write(msg + '\n'); };

// ---------- one measurement ----------
function measureOnce(opts) {
  return new Promise((resolve) => {
    /** Subscriptions awaiting the transport's confirmation, by UUID prefix. */
    const pendingSubs = new Map();
    const args = ['--scan-timeout', String(opts.scanTimeout), '--connect-timeout', String(opts.connectTimeout),
                  '--hold', String(opts.hold)];
    if (opts.name) args.push('--name', opts.name);
    if (opts.address) args.push('--address', opts.address);
    // The record channel only, to begin with. The weight stream is added once
    // the scale announces its session, which is the order the vendor app uses.
    args.push('--chars', 'ffb3');

    // Prove the transport can run before starting anything. A transport that
    // cannot work must fail as a transport problem, not as a scale that would
    // not answer, and nothing should be spawned to find that out.
    if (!opts.replay) {
      const check = selfTestTransport(opts.python || PYTHON);
      if (!check.ok) {
        note(check.message);
        return resolve({ reason: check.reason, outcome: 'spawn-failed',
                         capture: { weight: null, impedance: null, finalSeen: false, frames: 0, settled: false },
                         device: null, identified: null, spawnError: check.message });
      }
      note(`transport ok: python ${check.python}, bleak ${check.bleak}`);
    }

    const py = opts.replay
      ? spawn(process.execPath, [path.join(ROOT, 'replay.js'), opts.replay], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
      : spawn(opts.python || PYTHON, [path.join(ROOT, 'ble.py'), ...args],
              { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    /*
     * A write to a transport that has stopped reading raises EPIPE
     * ASYNCHRONOUSLY, as an 'error' event on the stream. With no listener that
     * is an uncaught exception and the whole service dies, and no try/catch
     * around the write can prevent it. The transport exiting mid-handshake is
     * an ordinary race, not a fault.
     */
    if (py.stdin) py.stdin.on('error', (e) => note(`  transport stdin: ${e.message}`));

    const rl = readline.createInterface({ input: py.stdout });

    const emit = opts.onEvent || (() => {});

    /*
     * Nudges.
     *
     * Two stalls are the user's to fix, not the software's. A scan that finds
     * nothing means the scale's radio is asleep and needs standing on. A link
     * that is up but silent means the scale is holding an old reading and needs
     * a step off and back on. Both look identical to a spinner, so the service
     * says which it is, and the host can put a sentence on screen instead of
     * leaving someone watching nothing happen.
     *
     * Advisory only: a nudge never ends a measurement and never changes its
     * outcome. Hosts that ignore the event are unaffected.
     */
    const hintAfterMs = Math.max(1000, Number(opts.hintAfterSec || 8) * 1000);
    let hintTimer = null;
    let hintCount = 0;
    const stopHints = () => { if (hintTimer) { clearInterval(hintTimer); hintTimer = null; } };
    const armHint = (code, message) => {
      if (finished) return;              // nothing left to advise anyone about
      stopHints();
      hintCount = 0;
      hintTimer = setInterval(() => {
        hintCount++;
        emit({ _hint: true, code, message, count: hintCount, afterMs: hintAfterMs * hintCount });
      }, hintAfterMs);
      if (hintTimer.unref) hintTimer.unref();
    };
    if (opts.registerChild) opts.registerChild(py);

    const capture = { weight: null, impedance: null, impedancePlausible: false,
                      waitedForProgram: false, finalSeen: false, frames: 0, settled: false };
    let device = null, identified = null, driver = null, ctx = null, grace = null, finished = false;
    let spawnError = null;                     // set when the interpreter itself will not start

    const finish = (reason, outcome) => {
      if (finished) return;
      finished = true;
      stopHints();
      if (grace) clearTimeout(grace);
      try { py.stdin.end(); } catch (e) { /* already closed */ }
      setTimeout(() => killChild(py), 400);
      resolve({ reason, outcome, capture, device, identified,
                spawnError: spawnError ? spawnError.message : null });
    };

    const complete = (why) => {
      if (capture.settled) return;
      capture.settled = true;
      note(`captured (${why})`);
      finish('captured', 'ok');
    };

    const feed = (values) => {
      if (!values || capture.settled) return;
      capture.frames++;
      /*
       * Freeze the weight the moment the scale says it is final.
       *
       * The 0xFFB2 stream does not stop when the reading locks: the scale keeps
       * repeating frames, and a shift of stance while the impedance program
       * runs moves the number after it was supposed to have settled. The status
       * byte is the scale's own statement that it is done, so it is taken as
       * final and nothing later is allowed to change it.
       *
       * A NEW measurement clears finalSeen, so this only freezes within one.
       */
      if (values.weight > 0 && !capture.finalSeen) capture.weight = values.weight;
      else if (values.weight > 0 && capture.finalSeen && values.weight !== capture.weight) {
        note(`  ignoring ${values.weight} kg: the scale already locked ${capture.weight} kg`);
      }
      // Set AFTER the weight above, so the frame that carries the lock is
      // allowed to deliver the value it is locking. Only later frames freeze.
      if (values.state === 'final') capture.finalSeen = true;
      /*
       * The scale sends a record frame the moment weight settles, and again
       * after its own impedance program has run — the one the display calls
       * P1, which holds for about ten seconds. The first frame carries a
       * placeholder rather than a measurement.
       *
       * Observed on real hardware. A completed program gives bytes [5][6] of
       * zero and a resistance inside the physical band: 00 00 14 b3, 529.9 Ω.
       * A frame sent before it finishes gives non-zero there and a value far
       * outside it: 6a 9b ff f7, which decodes to 6552.7 Ω. 0xfff7 is eight
       * below 0xffff and is a not-measured sentinel, not a resistance.
       *
       * Taking the first frame and disconnecting is what produced every
       * implausible impedance in this project. So a value outside the band is
       * recorded but does NOT finish the measurement: the link stays open for
       * the real one, and the hold timeout still bounds the wait.
       */
      const PLAUSIBLE_MIN = 150;
      const PLAUSIBLE_MAX = 1200;
      if (values.impedanceOhm > 0) {
        const z = values.impedanceOhm;
        capture.impedance = z;
        capture.impedancePlausible = z >= PLAUSIBLE_MIN && z <= PLAUSIBLE_MAX;
        if (!capture.impedancePlausible && !capture.waitedForProgram) {
          capture.waitedForProgram = true;
          note(`  impedance ${z} Ω is outside the physical band; the scale's own program`);
          note('  has not finished. Stand still — waiting for the real reading.');
          emit({ _hint: true, code: 'HOLD_STILL', count: 1, afterMs: 0,
                 message: 'Stand still. The scale is still measuring.' });
        }
      }

      if (capture.weight > 0) {
        note(`  reading ${capture.weight} kg${capture.impedance ? `, ${capture.impedance} ohm` : ''}`
             + `${capture.finalSeen ? ' (settled)' : ' (settling)'}`);
        stopHints();
        emit({ phase: capture.finalSeen ? 'settled' : 'settling', weightKg: capture.weight,
               impedanceOhm: capture.impedance, message: `${capture.weight} kg` });
      }
      // Only a plausible impedance ends the measurement. An implausible one is
      // the placeholder the scale sends before its program has run.
      if (capture.weight > 0 && capture.impedance > 0 && capture.impedancePlausible) {
        return complete('weight and impedance');
      }
      if (capture.finalSeen && capture.weight > 0 && !grace) {
        /*
         * Stay connected while the scale measures impedance.
         *
         * Five seconds was far too short. The scale starts its own program
         * AFTER the weight locks — the display shows P-1 and holds about ten
         * seconds — so hanging up five seconds in guarantees a weight-only
         * reading and looks, from the user's side, like "the Bluetooth
         * disconnects as soon as it has the weight". Which is exactly what it
         * was doing.
         *
         * The vendor app simply stays connected. So does this now, and it says
         * why, because standing still on a scale with nothing on screen is
         * indistinguishable from a hang.
         */
        const waitMs = Math.max(1000, Number(opts.impedanceWaitSec || 30) * 1000);
        note(`  weight locked. Staying connected for up to ${Math.round(waitMs / 1000)} s`);
        note('  while the scale measures impedance. Stay on it and hold the handle.');
        emit({ _hint: true, code: 'STAY_ON_SCALE', count: 1, afterMs: 0,
               message: 'Weight recorded. Stay on the scale and hold the handle '
                      + 'while it measures body composition.' });
        grace = setTimeout(() => complete('weight settled, no impedance arrived'), waitMs);
      }
    };

    const makeCtx = () => ({
      log: (msg, level) => { if (level !== 'info' || opts.raw) note('  ' + msg); },
      profile: () => opts.profile,
      scalesDb: ScalesDB,
      state: {},
      now: () => Date.now(),
      hex: BCS.hex,
      // ble.py already subscribes to everything notifiable, so there is nothing
      // for a driver to turn on here.
      /*
       * Wait for the subscription to actually exist.
       *
       * This used to resolve the moment the command was written to the pipe,
       * so `await ctx.subscribe(...)` meant nothing and the driver wrote its
       * first command before either notification was live:
       *
       *     -> subscribing to 0xffb3
       *     -> wrote user profile ...        <- here
       *     subscribed to 0000ffb3-...       <- but live only here
       *
       * The vendor SDK enables 0xFFB3, waits, enables 0xFFB2, waits, and only
       * then writes. Talking to a scale before it can answer is not that, and
       * a reply we are not yet listening for is a reply we lose.
       */
      subscribe: (svc, chr) => {
        if (opts.replay) return Promise.resolve(true);
        const uuid = `0000${chr.toString(16).padStart(4, '0')}`;
        if (!py.stdin || py.stdin.destroyed || py.stdin.writableEnded) return Promise.resolve(false);
        return new Promise((resolve) => {
          let settled = false;
          const finish = (ok) => { if (!settled) { settled = true; pendingSubs.delete(uuid); resolve(ok); } };
          pendingSubs.set(uuid, finish);
          // A scale that never confirms must not hang the measurement; the
          // caller carries on and the frames either arrive or they do not.
          setTimeout(() => {
            if (!settled) note(`  subscription to 0x${chr.toString(16)} was never confirmed`);
            finish(false);
          }, 4000).unref?.();
          try {
            py.stdin.write(JSON.stringify({ cmd: 'subscribe', char: uuid }) + '\n');
            note(`  -> subscribing to 0x${chr.toString(16)}`);
          } catch (e) { finish(false); }
        });
      },
      subscribeAll: async () => {},
      /*
       * Put a packet on the wire.
       *
       * This used to be a stub that logged "this firmware needs no handshake"
       * and dropped the packet. That assumption was wrong: the phone app writes
       * a session acknowledgement and the user profile here, and only then does
       * the scale run its extended impedance program — P1 on the display,
       * holding about ten seconds, then L1. Without the write it takes a quick
       * preliminary reading instead, which is where the implausible impedance
       * values were coming from.
       */
      write: async (svc, chr, bytes, what) => {
        if (opts.replay) return false;             // a recording cannot be written to
        const uuid = `0000${chr.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        if (!py.stdin || py.stdin.destroyed || py.stdin.writableEnded) {
          note(`  cannot write ${what}: the transport is no longer listening`);
          return false;
        }
        try {
          py.stdin.write(JSON.stringify({ cmd: 'write', char: uuid, hex, what }) + '\n');
          note(`  -> wrote ${what} to 0x${chr.toString(16)} (${bytes.length} bytes)`);
          return true;
        } catch (e) {
          note(`  write of ${what} failed: ${e.message}`);
          return false;
        }
      },
    });

    rl.on('line', (line) => {
      /*
       * The transport is killed 400 ms after a measurement finishes, and it
       * keeps talking in that window. Without this guard a stray line emits
       * progress AFTER the terminal event and, worse, re-arms a nudge that
       * nothing can ever clear: stopHints() runs only from feed(), which
       * returns early once settled, and finish(), which returns early once
       * finished. The result was an interval firing forever.
       */
      if (finished) return;

      let ev;
      try { ev = JSON.parse(line); } catch (e) { return; }
      if (ev.t === 'log') {
        note(`  ${ev.msg}`);
        // "subscribed to 0000ffb3-0000-1000-8000-00805f9b34fb", or the failure
        // the transport reports when notifications were already running.
        const sub = /(?:^|\s)(?:subscribed to|could not subscribe to)\s+(\S+)/.exec(ev.msg);
        if (sub) {
          const key = sub[1].slice(0, 8);
          const waiter = pendingSubs.get(key);
          // Already-started notifications are a success for our purposes: the
          // characteristic is live, which is all the driver is waiting on.
          if (waiter) waiter(!/could not subscribe/.test(ev.msg)
            || /already started/i.test(ev.msg));
        }
        if (/scanning/i.test(ev.msg)) {
          emit({ phase: 'scanning', message: ev.msg });
          armHint('WAKE_THE_SCALE', 'Step on the scale to wake it, then wait a moment.');
        } else if (/advertisement/i.test(ev.msg)) {
          emit({ phase: 'found', message: ev.msg });
          stopHints();                       // it answered; nothing to nudge about
        }
        return;
      }
      if (ev.t === 'device') {
        device = { name: ev.name, address: ev.address };
        identified = ScalesDB.identify(ev.name, []);
        driver = Drivers.select(identified);
        ctx = makeCtx();
        note(`device ${ev.name} at ${ev.address}`);
        note(`driver ${driver.label}`);
        emit({ phase: 'connected', message: `connected to ${ev.name}`,
               device: { name: ev.name, address: ev.address }, driver: driver.id });
        Promise.resolve(driver.init(ctx)).catch((e) => note(`driver init failed: ${e.message}`));
        return;
      }
      if (ev.t === 'services') {
        const uuids = ev.items.map((i) => i.char);
        identified = ScalesDB.identify(device && device.name, ev.items.map((i) => i.service));
        if (opts.raw) ev.items.forEach((i) => note(`  ${i.service} / ${i.char} [${i.props.join(',')}]`));
        else note(`${uuids.length} characteristic(s)`);
        return;
      }
      if (ev.t === 'ready') {
        note('ready — stand on the scale');
        emit({ phase: 'ready', message: 'stand on the scale' });
        // Connected and listening, but the scale may be sitting on a stale
        // reading it will not resend until it is disturbed.
        armHint('STEP_OFF_AND_ON', 'Step off the scale and step back on.');
        return;
      }
      if (ev.t === 'frame') {
        // hexToBytes throws on odd-length input. A malformed frame must not be
        // able to take down a service whose contract is that errors never do.
        let bytes;
        try { bytes = BCS.hexToBytes(ev.hex); }
        catch (e) { note(`skipping malformed frame ${ev.uuid}: ${e.message}`); return; }
        const u16 = BCS.uuid16(ev.uuid);
        if (opts.raw) note(`  frame ${ev.uuid} ${ev.hex}`);
        if (driver && driver.onFrame) {
          let r = null;
          try { r = driver.onFrame(u16, bytes, ctx); }
          catch (e) { note(`  decode error: ${e.message}`); }
          if (r === Drivers.SUPPRESS) return;
          if (r) {
            if (opts.raw) note(`  ${r.characteristic}: ${JSON.stringify(r.values)}`);
            feed(r.values);
            return;
          }
        }
        const parsed = BCS.parseByUuid(ev.uuid, bytes);
        if (parsed && (u16 === 0x2a9c || u16 === 0x2a9d)) feed(parsed.values);
        return;
      }
      if (ev.t === 'end') {
        if (capture.weight > 0 && !capture.settled) return complete('link ended, using the best reading');
        if (ev.detail) note(`transport: ${ev.detail}`);
        const outcome = ev.reason === 'not-found' ? 'not-found'
                      : ev.reason === 'permission-denied' ? 'tcc-denied'
                      : ev.reason === 'bluetooth-unavailable' ? 'bluetooth-unavailable'
                      : 'no-reading';
        finish(ev.reason, outcome);
      }
    });

    py.on('error', (e) => {
    // The outcome, not just the reason, must say this was a spawn failure:
    // OUTCOME_TO_ERROR keys on the outcome, and a generic 'error' there
    // becomes INTERNAL and tells the user to stand on the scale.
    note(`could not start the transport: ${e.message}`);
    spawnError = e;
    finish('spawn-failed', 'spawn-failed');
  });
    py.on('close', (code, signal) => {
      if (finished) return;
      // SIGABRT with nothing decoded is the signature of macOS refusing
      // Bluetooth to this process tree, which it enforces by killing the child.
      if ((signal === 'SIGABRT' || code === 134) && capture.frames === 0) {
        return finish('tcc-denied', 'tcc-denied');
      }
      // Timed out or the link dropped. Report what there is, including an
      // implausible impedance: the trust rules describe it honestly, and a
      // weight-only result is still useful.
      finish('exited', capture.weight > 0 ? 'ok' : 'no-reading');
    });
  });
}

/*
 * Windows has no real SIGTERM. Node emulates kill() by terminating the process
 * handle, which does not reach grandchildren, so a Python child that has spawned
 * anything of its own can survive. taskkill /T covers the tree.
 */
function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  const portable = () => { try { child.kill('SIGTERM'); } catch (e) { /* already gone */ } };
  if (IS_WINDOWS) {
    // kill() does not reach grandchildren on Windows, and the Python helper is
    // one. An orphan keeps holding the radio, so taskkill /T is the real fix.
    let killer;
    try {
      killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'],
                     { stdio: 'ignore', windowsHide: true });
    } catch (e) { return portable(); }
    // spawn reports a missing taskkill asynchronously, on an emitter with no
    // listener. Unhandled, that is an uncaught exception in the cleanup path.
    killer.on('error', () => portable());
    killer.on('exit', (code) => { if (code !== 0) portable(); });
    return;
  }
  portable();
}

// ---------- output ----------
function buildResult(res, profile, extra) {
  const cap = res.capture;
  const bia = BIA.estimate({ weightKg: cap.weight, impedanceOhm: cap.impedance || 0,
                             heightCm: profile.heightCm, age: profile.age, sex: profile.sex });
  const derived = {}, units = {}, confidence = {};
  for (const [k, v] of Object.entries(bia.values)) {
    if (k === 'weightKg' || k === 'impedanceOhm' || typeof v === 'object') continue;
    derived[k] = v;
    const m = bia.meta[k] || {};
    units[k] = m.unit || '';
    confidence[k] = m.confidence || '';
  }
  return Object.assign({
    ok: true,
    source: 'scale',                  // 'scale' when read live, 'recomputed' otherwise
    timestamp: new Date().toISOString(),
    device: res.device,
    model: res.identified ? res.identified.model : null,
    measured: { weightKg: cap.weight, impedanceOhm: cap.impedance },
    derived,
    units,
    confidence,
    trust: bia.trust,
    bodyFatRecommended: bia.values.bodyFatRecommendedKey
      ? { key: bia.values.bodyFatRecommendedKey, value: bia.values[bia.values.bodyFatRecommendedKey] }
      : null,
    crossCheck: bia.crossCheck || null,
    // What the scale's own app would report for the three values where the two
    // conventions differ. Null when impedance was not usable.
    vendorMatch: bia.vendorMatch || null,
    flags: bia.flags || [],
    warnings: bia.warnings || [],
    omitted: bia.omitted || {},
    profile,
  }, extra || {});
}

function printHuman(r) {
  const w = r.measured;
  process.stderr.write('\n');
  process.stderr.write(`  ${w.weightKg} kg` + (w.impedanceOhm ? `   ${w.impedanceOhm} ohm` : '   (no impedance)') + '\n');
  if (r.bodyFatRecommended) {
    process.stderr.write(`  ${r.bodyFatRecommended.value} % body fat`
      + (r.bodyFatRecommended.key === 'bodyFatPercent' ? ' (from impedance)' : ' (from BMI; impedance failed its checks)') + '\n');
  }
  const fatal = r.flags.filter((f) => f.severity === 'fatal');
  if (fatal.length) process.stderr.write(`  impedance values NOT trustworthy: ${fatal.map((f) => f.rule).join(', ')}\n`);
  process.stderr.write('\n');
}

// ---------- service mode ----------
/*
 * A long-lived process speaking newline-delimited JSON, which is what an Electron
 * main process should drive.
 *
 * Chosen over one spawn per measurement because a person is standing on a scale
 * while this runs: the caller needs live progress and a working cancel, and a
 * single long-lived child dies with the app instead of leaking a process per
 * attempt. Chosen over a local HTTP server because a pipe needs no port, cannot
 * be reached by anything else on the machine, and terminates with the parent.
 *
 * Every line this writes to stdout is one JSON object. Nothing else is ever
 * written to stdout, so the caller can parse line by line without a framing
 * scheme. Human-readable noise goes to stderr.
 */
const PROTOCOL_VERSION = 1;

const ERRORS = {
  BAD_REQUEST: 'the request was not valid JSON, or was missing a required field',
  UNKNOWN_COMMAND: 'no such command',
  INVALID_PROFILE: 'age and heightCm are required and must be realistic',
  BUSY: 'a measurement is already running; cancel it first',
  DEVICE_NOT_FOUND: 'no scale answered; its radio sleeps when idle',
  NO_READING: 'connected but no reading arrived',
  BLUETOOTH_UNAVAILABLE: IS_WINDOWS
    ? 'Bluetooth is switched off, or no adapter is available. Turn Bluetooth on in Settings, '
      + 'then Bluetooth and devices.'
    : 'Bluetooth is switched off, or no adapter is available',
  PERMISSION_DENIED: IS_WINDOWS
    ? 'Windows refused Bluetooth to this application. Turn on "Let desktop apps access your '
      + 'Bluetooth devices" in Settings, Privacy and security, Bluetooth devices.'
    : 'the operating system refused Bluetooth to this process',
  TRANSPORT_FAILED: 'the Bluetooth helper could not be started',
  CANCELLED: 'the measurement was cancelled',
  INTERNAL: 'unexpected failure',
};

const OUTCOME_TO_ERROR = {
  'not-found': 'DEVICE_NOT_FOUND',
  'bluetooth-unavailable': 'BLUETOOTH_UNAVAILABLE',
  'no-reading': 'NO_READING',
  'tcc-denied': 'PERMISSION_DENIED',
  'spawn-failed': 'TRANSPORT_FAILED',
  error: 'INTERNAL',
};

/*
 * Validate a `measured` pair a host is handing back for recomputation.
 *
 * The scale contributes exactly two numbers, so a reading can be captured now
 * and interpreted later. That is not a workaround: the radio window is short,
 * while a person's age can be asked at leisure.
 */
function validateMeasured(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'measured is required, as an object';
  const w = Number(m.weightKg);
  if (!Number.isFinite(w) || w <= 0) return 'measured.weightKg must be a positive number';
  if (w > 500) return 'measured.weightKg is above 500, which no scale reports for a person';
  if (m.impedanceOhm !== undefined && m.impedanceOhm !== null) {
    const z = Number(m.impedanceOhm);
    if (!Number.isFinite(z) || z < 0) return 'measured.impedanceOhm must be a number, or null';
  }
  return null;
}

function validateProfile(p) {
  if (!p || typeof p !== 'object') return 'profile is required';
  const age = Number(p.age), h = Number(p.heightCm);
  if (!Number.isFinite(age) || age < 5 || age > 120) return 'age must be a number between 5 and 120';
  if (!Number.isFinite(h) || h < 90 || h > 250) return 'heightCm must be a number between 90 and 250';
  const sex = String(p.sex || '').toLowerCase();
  if (sex && sex !== 'male' && sex !== 'female') return "sex must be 'male' or 'female'";
  return null;
}

async function serve(a) {
  QUIET = true;                                   // stdout belongs to the protocol
  LOG_ALWAYS = true;                              // but stderr stays open for diagnosis
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const fail = (id, code, message, detail) =>
    out({ proto: PROTOCOL_VERSION, type: 'error', id: id || null, code,
          message: message || ERRORS[code] || code, detail: detail || null });

  let cfg = readConfig();
  let running = null;                             // { id, child, cancelled }

  out({
    proto: PROTOCOL_VERSION, type: 'hello',
    app: 'bodyscale', version: PKG_VERSION,
    platform: process.platform, node: process.versions.node,
    device: cfg[ADDRESS_KEY] ? { name: cfg.name || null, address: cfg[ADDRESS_KEY], remembered: true } : null,
    commands: ['measure', 'compute', 'cancel', 'status', 'forget', 'shutdown'],
    errorCodes: Object.keys(ERRORS),
    events: ['hello', 'accepted', 'progress', 'hint', 'measurement',
             'status', 'cancelling', 'forgotten', 'bye', 'error'],
    hints: {
      codes: ['WAKE_THE_SCALE', 'STEP_OFF_AND_ON'],
      defaultAfterSec: 8,
      note: 'Advisory only. A hint never ends a measurement; it names the one thing '
          + 'the person can do to unstick it, and repeats until they do.',
    },
    profile: {
      required: true,
      suppliedBy: 'host',
      fields: ['age', 'heightCm', 'sex'],
      persisted: false,
      deferrable: true,
      note: 'The host supplies age, heightCm and sex on every measure. This service never '
          + 'stores them, never defaults them, and never returns a remembered profile. '
          + 'A measure may set withoutProfile: true to capture weight and impedance now '
          + 'and interpret them later with the compute command.',
    },
    note: 'one JSON object per line; the caller supplies age, heightCm and sex, and nothing else',
  });

  const rl = readline.createInterface({ input: process.stdin });

  const doMeasure = async (req) => {
    /*
     * A profile is required unless the host explicitly defers it.
     *
     * `withoutProfile: true` is opt-in on purpose. A host that simply forgot to
     * send a profile is still caught with INVALID_PROFILE, which is the common
     * bug; deferring is a deliberate choice, and it has to look like one.
     *
     * Deferring is genuinely useful: the scale's radio sleeps within seconds,
     * so the weight must be captured the moment it settles, while a person's
     * age can be asked at leisure. Send the reading back later with `compute`.
     */
    const deferred = req.withoutProfile === true;
    if (!deferred) {
      const bad = validateProfile(req.profile);
      if (bad) return fail(req.id, 'INVALID_PROFILE', bad);
    } else if (req.profile !== undefined && req.profile !== null) {
      return fail(req.id, 'BAD_REQUEST',
        'send either a profile or withoutProfile: true, not both');
    }

    /*
     * `scaleProfile` is who the SCALE is told it is measuring.
     *
     * These are two different things and conflating them cost us a lot of
     * failed measurements. `profile` is what the derived values are computed
     * from, and deferring it is deliberate: the host owns that data and can
     * collect it at leisure after the reading is latched.
     *
     * But an 8-electrode scale is not a passive sensor. It decides whether to
     * run its impedance sweep, and what current to drive, from the identity it
     * is given during the handshake — before anyone has stood on it. With no
     * identity it gets a stand-in (170 cm, 30, male), and a stand-in is a
     * plausible reason for it to decline the sweep and report weight alone.
     *
     * So a deferred request may still carry `scaleProfile`. It is written to
     * the scale and used for nothing else: it never reaches the BIA maths, is
     * never stored, and never appears in a result. The host still owns the
     * data and still supplies it; it just supplies it early enough to matter.
     */
    let scaleProfile = null;
    if (deferred && req.scaleProfile) {
      const bad = validateProfile(req.scaleProfile);
      if (bad) return fail(req.id, 'INVALID_PROFILE', `scaleProfile: ${bad}`);
      scaleProfile = {
        sex: String(req.scaleProfile.sex || 'male').toLowerCase(),
        age: Number(req.scaleProfile.age),
        heightCm: Number(req.scaleProfile.heightCm),
      };
    }
    if (running) return fail(req.id, 'BUSY');

    // The deferred placeholder is never reported. It exists only so the frame
    // decoding, which needs no profile, has something well formed to carry.
    const profile = deferred ? scaleProfile : {
      sex: String(req.profile.sex || 'male').toLowerCase(),
      age: Number(req.profile.age),
      heightCm: Number(req.profile.heightCm),
    };
    const opts = {
      // Per-request first, then the process default, exactly as scanTimeout
      // does below. Without the fallback --hint-after was parsed and discarded.
      hintAfterSec: Number(req.hintAfterSec) || a.hintAfterSec,
      impedanceWaitSec: Number(req.impedanceWaitSec) || a.impedanceWaitSec,
      name: req.deviceName || cfg.name || a.name,
      address: req.address || cfg[ADDRESS_KEY],
      profile: profile || { sex: 'male', age: 30, heightCm: 170 },
      raw: false, replay: a.replay, python: a.python,
      scanTimeout: Number(req.scanTimeoutSec) || a.scanTimeout,
      connectTimeout: a.connectTimeout,
      hold: Number(req.timeoutSec) || a.hold,
      onEvent: (e) => {
        // A nudge is advice for the person, not a step in the measurement, so
        // it gets its own type rather than a seventh progress phase. Hosts that
        // ignore unknown types are unaffected.
        if (e._hint) {
          const { _hint, ...hint } = e;
          return out(Object.assign({ proto: PROTOCOL_VERSION, type: 'hint', id: req.id }, hint));
        }
        return out(Object.assign({ proto: PROTOCOL_VERSION, type: 'progress', id: req.id }, e));
      },
      registerChild: (child) => { if (running) running.child = child; },
    };

    running = { id: req.id, child: null, cancelled: false };
    out({ proto: PROTOCOL_VERSION, type: 'accepted', id: req.id,
          profile: profile, profileDeferred: deferred });

    let res;
    try { res = await measureOnce(opts); }
    catch (e) { running = null; return fail(req.id, 'INTERNAL', e.message); }

    const wasCancelled = running && running.cancelled;
    running = null;
    if (wasCancelled) return fail(req.id, 'CANCELLED');

    if (res.device && res.device.address) {
      cfg[ADDRESS_KEY] = res.device.address;
      cfg.name = res.device.name;
      // The device identity is remembered, so the next scan is instant. The
      // profile is NOT written here: in service mode the host owns age, height
      // and sex and sends them with every request.
      //
      // An existing profile is left alone rather than deleted. It belongs to
      // the terminal tool, which is a different surface with a real need to
      // remember it. Deleting it here silently reset a CLI user's age and
      // height to the fallback defaults, and every derived figure with them.
      writeConfig(cfg);
    }
    if (res.outcome === 'ok' && res.capture.weight > 0) {
      const body = deferred
        ? {
          ok: true,
          source: 'scale',
          profileDeferred: true,
          timestamp: new Date().toISOString(),
          device: res.device,
          model: res.identified ? res.identified.model : null,
          measured: { weightKg: res.capture.weight, impedanceOhm: res.capture.impedance },
          derived: {}, units: {}, confidence: {}, omitted: {},
          trust: { impedanceFree: false, impedanceDerived: false },
          bodyFatRecommended: null, crossCheck: null, flags: [],
          warnings: ['No profile was given, so nothing was interpreted. Send this '
                   + 'measured pair back with the compute command once you have the '
                   + 'age, height and sex.'],
          profile: null,
        }
        : buildResult(res, profile);
      out(Object.assign({ proto: PROTOCOL_VERSION, type: 'measurement', id: req.id }, body));
    } else {
      fail(req.id, OUTCOME_TO_ERROR[res.outcome] || 'INTERNAL', res.spawnError || null,
           { outcome: res.outcome, framesSeen: res.capture ? res.capture.frames : 0,
             spawnError: res.spawnError || null });
    }
  };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let req;
    try { req = JSON.parse(text); } catch (e) { return fail(null, 'BAD_REQUEST', 'not valid JSON'); }
    // An array is typeof 'object', so it has to be excluded explicitly.
    if (!req || typeof req !== 'object' || Array.isArray(req)) return fail(null, 'BAD_REQUEST', 'expected a JSON object');
    const id = req.id === undefined ? null : req.id;

    switch (req.cmd) {
      case 'measure':
        doMeasure(Object.assign({}, req, { id }));
        return;

      /*
       * Interpret a reading that was taken earlier.
       *
       * `derived` is a pure function of `measured` and the profile, so a
       * measurement captured without an age loses nothing — it simply has not
       * been interpreted yet. Hand the same two numbers back with a complete
       * profile and the full panel comes out, identical to what a live
       * measurement with that profile would have produced.
       *
       * No radio, no device, no waiting. It is arithmetic.
       */
      case 'compute': {
        const badMeasured = validateMeasured(req.measured);
        if (badMeasured) return fail(id, 'BAD_REQUEST', badMeasured);
        const badProfile = validateProfile(req.profile);
        if (badProfile) return fail(id, 'INVALID_PROFILE', badProfile);

        const profile = {
          sex: String(req.profile.sex || 'male').toLowerCase(),
          age: Number(req.profile.age),
          heightCm: Number(req.profile.heightCm),
        };
        const capture = {
          weight: Number(req.measured.weightKg),
          impedance: req.measured.impedanceOhm == null ? null : Number(req.measured.impedanceOhm),
        };
        const body = buildResult(
          { capture, device: req.device || null, identified: req.model ? { model: req.model } : null },
          profile,
          {
            source: 'recomputed',
            // When the reading was taken, if the host kept it. The `timestamp`
            // field stays the moment of computation, so the two are never
            // confused.
            measuredAt: typeof req.measuredAt === 'string' ? req.measuredAt : null,
          });
        out(Object.assign({ proto: PROTOCOL_VERSION, type: 'measurement', id }, body));
        return;
      }
      case 'cancel':
        if (!running) return fail(id, 'BAD_REQUEST', 'nothing is running');
        running.cancelled = true;
        killChild(running.child);
        out({ proto: PROTOCOL_VERSION, type: 'cancelling', id, cancelling: running.id });
        return;
      case 'status':
        out({ proto: PROTOCOL_VERSION, type: 'status', id,
              busy: !!running, runningId: running ? running.id : null,
              device: cfg[ADDRESS_KEY] ? { name: cfg.name || null, address: cfg[ADDRESS_KEY] } : null,
              platform: process.platform, version: PKG_VERSION });
        return;
      case 'forget':
        delete cfg[ADDRESS_KEY];
        writeConfig(cfg);
        out({ proto: PROTOCOL_VERSION, type: 'forgotten', id });
        return;
      case 'shutdown':
        out({ proto: PROTOCOL_VERSION, type: 'bye', id });
        if (running) killChild(running.child);
        setTimeout(() => process.exit(0), 30);
        return;
      default:
        return fail(id, 'UNKNOWN_COMMAND', `no such command: ${String(req.cmd)}`);
    }
  });

  // The parent closing the pipe, or dying, must take this process with it.
  rl.on('close', () => { if (running) killChild(running.child); process.exit(0); });
  process.on('SIGINT', () => { if (running) killChild(running.child); process.exit(0); });
  process.on('SIGTERM', () => { if (running) killChild(running.child); process.exit(0); });

  return new Promise(() => {});                   // run until stdin closes
}

// ---------- main ----------
async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    // Help goes to stdout only when it was actually asked for. A rejected
    // option writes to stderr and exits non-zero, so a host driving --serve
    // sees a failure instead of help text mixed into its JSON stream.
    if (a.badOption) { process.stderr.write(HELP + '\n'); return 2; }
    console.log(HELP);
    return 0;
  }
  if (a.serve) return serve(a);
  QUIET = a.quiet;

  let cfg = readConfig();
  if (a.forget) { cfg = { profile: cfg.profile, name: cfg.name }; delete cfg[ADDRESS_KEY]; writeConfig(cfg); note('forgot the saved device'); }

  // Track where each field came from. A guessed age or height must never be
  // written back to disk: doing so turns "nobody told me" into "you are 30 and
  // 170 cm" permanently, and every later run inherits it looking deliberate.
  const stored = cfg.profile || {};
  const knownAge = Number.isFinite(a.age) || Number.isFinite(stored.age);
  const knownHeight = Number.isFinite(a.heightCm) || Number.isFinite(stored.heightCm);
  const profile = {
    sex: a.sex || stored.sex || 'male',
    age: Number.isFinite(a.age) ? a.age : (Number.isFinite(stored.age) ? stored.age : 30),
    heightCm: Number.isFinite(a.heightCm) ? a.heightCm
      : (Number.isFinite(stored.heightCm) ? stored.heightCm : 170),
  };
  const profileIsGuessed = !knownAge || !knownHeight;
  const opts = {
    name: a.name, address: a.address || cfg[ADDRESS_KEY], profile, raw: a.raw, replay: a.replay,
    scanTimeout: a.scanTimeout, connectTimeout: a.connectTimeout, hold: a.hold, python: a.python,
    hintAfterSec: a.hintAfterSec,
    impedanceWaitSec: a.impedanceWaitSec,
    onEvent: (e) => { if (e._hint) note(`  >> ${e.message}`); },
  };
  if (opts.replay) note(`replaying ${opts.replay} (no Bluetooth involved)`);
  note(`profile: ${profile.sex}, ${profile.age}y, ${profile.heightCm}cm`
       + (opts.address ? `   saved address ${opts.address}` : `   scanning for "${opts.name}"`));
  if (profileIsGuessed) {
    note('');
    note(`  !! ${!knownAge ? 'Age' : 'Height'} was never given, so a default is being used.`);
    note('     Body composition will be computed for the wrong person.');
    note('     Set it once and it is remembered:');
    note('       node scale.js --sex male --age 39 --height 180');
    note('');
  }
  if (opts.address && !opts.replay) note(`(identifier is ${process.platform === 'darwin' ? 'a CoreBluetooth UUID, specific to this Mac' : 'a Bluetooth MAC address'})`);

  const interval = Number.isFinite(a.interval) ? a.interval : 3;
  let exitCode = 0, taken = 0, attempts = 0, last = null, stopping = false;

  if (a.watch) {
    note('\nLoop mode. Step on the scale for a reading, step off, step on again for the next one.');
    note('Press Ctrl+C to stop.\n');
    process.on('SIGINT', () => {
      stopping = true;
      note(`\nStopped after ${taken} measurement(s).`);
      process.exit(0);
    });
  }

  for (;;) {
    attempts++;
    if (a.watch) note(`\n${'='.repeat(56)}\n  attempt ${attempts}${taken ? `   (${taken} measurement(s) so far)` : ''}\n${'='.repeat(56)}`);
    const res = await measureOnce(opts);
    if (stopping) break;

    if (res.device && res.device.address) {
      cfg[ADDRESS_KEY] = res.device.address; cfg.name = res.device.name;
      // Only a profile the user actually supplied is remembered. Persisting a
      // guess makes it indistinguishable from a real setting on the next run.
      if (!profileIsGuessed) cfg.profile = profile;
      writeConfig(cfg);
      opts.address = res.device.address;
    }

    if (res.outcome === 'ok' && res.capture.weight > 0) {
      const cap = res.capture;
      // The scale repeats its last locked reading until someone stands on it
      // again, so an identical pair is the previous measurement, not a new one.
      const same = last && last.weight === cap.weight && last.impedance === cap.impedance;
      if (a.watch && same && !a.allowRepeats) {
        note(`same reading as last time (${cap.weight} kg). The scale is still holding it.`);
        note('Step off, wait for it to blank, then step on again.');
      } else {
        const out = buildResult(res, profile);
        out.measurementNumber = taken + 1;
        process.stdout.write(JSON.stringify(out, null, a.quiet ? 0 : 2) + '\n');
        if (!a.quiet) printHuman(out);
        last = { weight: cap.weight, impedance: cap.impedance };
        taken++;
        exitCode = 0;
      }
    } else {
      const why = res.outcome === 'tcc-denied'
        ? (IS_WINDOWS
          ? 'Windows refused Bluetooth to this application. Open Settings, then Privacy & security, then '
            + 'Bluetooth devices, and turn on "Let desktop apps access your Bluetooth devices". '
            + 'Check that Bluetooth itself is switched on while you are there.'
          : 'macOS refused Bluetooth to this process and killed it. That happens when the app responsible for this '
            + 'process tree has no Bluetooth permission. Run this from Terminal instead, or double-click run.command, '
            + 'and accept the Bluetooth prompt the first time.')
        : res.outcome === 'bluetooth-unavailable'
        ? (IS_WINDOWS
          ? 'Bluetooth appears to be switched off, or no adapter is available. Turn Bluetooth on in Settings, '
            + 'then Bluetooth and devices, and try again.'
          : 'Bluetooth appears to be switched off, or no adapter is available. Turn Bluetooth on and try again.')
        : res.outcome === 'not-found'
        ? `no device named "${opts.name}" answered. Its radio sleeps when idle, so step on the scale to wake it.`
        : res.outcome === 'spawn-failed'
        ? (res.spawnError
          || 'the Bluetooth helper could not be started, so nothing was tried. Python or the bleak package is missing. '
             + 'Run setup-mac.sh, or setup-win.ps1 on Windows, or set BODYSCALE_PYTHON to a working interpreter.')
        : 'connected but no reading arrived. Stand on the scale with bare feet on the metal pads.';
      if (!a.watch) {
        process.stdout.write(JSON.stringify({ ok: false, error: res.outcome, reason: why,
                                              timestamp: new Date().toISOString() }) + '\n');
      }
      note(why);
      exitCode = 1;
      // A permission refusal will not fix itself by retrying.
      if (res.outcome === 'tcc-denied') break;
    }

    if (!a.watch) break;
    if (Number.isFinite(a.max) && taken >= a.max) { note(`\nReached ${a.max} measurement(s). Stopping.`); break; }
    // A scale that keeps repeating one held reading would otherwise loop for
    // ever, which is right in front of a person and wrong in a script.
    if (Number.isFinite(a.maxAttempts) && attempts >= a.maxAttempts) {
      note(`\nReached ${a.maxAttempts} attempt(s). Stopping.`);
      break;
    }
    if (interval > 0) await new Promise((r) => setTimeout(r, interval * 1000));
  }

  if (a.watch && taken) note(`\nDone. ${taken} measurement(s) taken.`);
  return a.watch && taken > 0 ? 0 : exitCode;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: 'crash', reason: e.message }) + '\n');
    process.exit(1);
  });
}
module.exports = { parseArgs, buildResult, validateProfile, PROTOCOL_VERSION, ERRORS, OUTCOME_TO_ERROR };
