'use strict';
/**
 * BodyScaleClient — a dependency-free wrapper around `scale.js --serve`.
 *
 * Runs in the Electron main process. It owns one long-lived child process,
 * turns the newline-JSON protocol into promises and events, and guarantees the
 * child dies with your app.
 *
 * Nothing here is Electron-specific, so it can be unit-tested under plain Node,
 * which is how it is tested.
 *
 *   const client = new BodyScaleClient({ scaleDir: '/path/to/bodyscale' });
 *   client.on('progress', (p) => console.log(p.phase, p.weightKg));
 *   await client.start();
 *   const result = await client.measure({ age: 39, heightCm: 180, sex: 'male' });
 */
const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const PROTOCOL_VERSION = 1;

/** An error carrying the service's own error code, so callers can switch on it. */
class ScaleError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'ScaleError';
    this.code = code;
    this.detail = detail || null;
  }
}

class BodyScaleClient extends EventEmitter {
  /**
   * @param {object}  opts
   * @param {string}  opts.scaleDir   Directory holding scale.js. Must be outside asar.
   * @param {string} [opts.nodePath]  Interpreter for scale.js. Defaults to this process,
   *                                  which inside Electron means Electron itself.
   * @param {string} [opts.pythonPath] Explicit Python for the Bluetooth helper.
   * @param {object} [opts.env]       Extra environment for the service. Use
   *                                  BODYSCALE_CONFIG_DIR to put the remembered
   *                                  device in your app's own data directory.
   * @param {string} [opts.replay]    Fixture path. Set this and no radio is used.
   * @param {number} [opts.startTimeoutMs=10000] How long to wait for `hello`.
   * @param {(line: string) => void} [opts.onLog] Receives the service's stderr.
   */
  constructor(opts = {}) {
    super();
    if (!opts.scaleDir) throw new Error('scaleDir is required');
    this.scaleDir = opts.scaleDir;
    this.scaleJs = path.join(opts.scaleDir, 'scale.js');
    this.nodePath = opts.nodePath || process.execPath;
    this.pythonPath = opts.pythonPath || null;
    this.env = opts.env || null;
    this.replay = opts.replay || null;
    this.startTimeoutMs = opts.startTimeoutMs || 10000;
    this.onLog = opts.onLog || null;

    this.child = null;
    this.hello = null;
    this.busy = false;

    this._seq = 0;
    this._pending = new Map();          // id -> waiter
    this._stopping = false;
  }

  get running() { return !!this.child; }

  /** Spawn the service and resolve with its `hello`. Idempotent. */
  start() {
    // Already up and announced: hand back the same hello.
    if (this.child && this.hello) return Promise.resolve(this.hello);
    // Spawned but hello has not landed yet. Returning this.hello here would
    // resolve with null, and a caller doing `hello.device` would throw. Wait.
    if (this.child) {
      return new Promise((resolve, reject) => {
        const settle = () => { this.off('hello', ok); this.off('_startFailed', no); };
        const ok = (h) => { settle(); resolve(h); };
        const no = (e) => { settle(); reject(e); };
        this.on('hello', ok);
        this.on('_startFailed', no);
      });
    }
    if (!fs.existsSync(this.scaleJs)) {
      return Promise.reject(new ScaleError('TRANSPORT_FAILED',
        `scale.js not found at ${this.scaleJs}. In a packaged app this usually means it is still inside app.asar; add it to asarUnpack.`));
    }

    const args = [this.scaleJs, '--serve'];
    if (this.replay) args.push('--replay', this.replay);

    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }, this.env || {});
    if (this.pythonPath) env.BODYSCALE_PYTHON = this.pythonPath;

    this._stopping = false;
    const child = spawn(this.nodePath, args, {
      cwd: this.scaleDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,                        // no console flash on Windows
      env,
    });
    this.child = child;

    // An unhandled 'error' on any stdio stream is an uncaught exception, which
    // in Electron kills the whole app. EPIPE and write-after-end are ordinary
    // shutdown races here, not faults.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream) stream.on('error', (err) => this.emit('log', `stdio: ${err.message}`));
    }

    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (this.onLog) this.onLog(line);
      this.emit('log', line);
    });

    child.on('error', (err) => this._die(new ScaleError('TRANSPORT_FAILED',
      `could not start the scale service: ${err.message}`)));
    child.on('close', (code) => {
      const wasStopping = this._stopping;
      // stop() may have retired it already; only clear if this is still it.
      if (this.child === child) { this.child = null; this.hello = null; }
      this.busy = false;
      this._die(new ScaleError('TRANSPORT_FAILED', `the scale service exited (code ${code})`));
      this.emit('close', code, wasStopping);
    });

    return new Promise((resolve, reject) => {
      // Exactly one of these three paths settles the promise, and each one
      // removes BOTH listeners. Leaving either registered would fire again on
      // the next start/stop cycle and leak a listener per cycle.
      const cleanup = () => {
        clearTimeout(timer);
        this.off('hello', onHello);
        this.off('_startFailed', onFail);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.stop();
        reject(new ScaleError('TRANSPORT_FAILED',
          `the scale service did not announce itself within ${this.startTimeoutMs} ms`));
      }, this.startTimeoutMs);
      const onHello = (hello) => { cleanup(); resolve(hello); };
      const onFail = (err) => { cleanup(); reject(err); };
      this.on('hello', onHello);
      this.on('_startFailed', onFail);
    });
  }

  /**
   * Take one measurement.
   *
   * The profile is the ONLY thing your app supplies. Weight, impedance and all
   * derived body metrics come back from the service.
   *
   * @param {{age:number, heightCm:number, sex?:'male'|'female'}} profile
   * @param {{timeoutSec?:number, scanTimeoutSec?:number, address?:string, deviceName?:string}} [options]
   * @returns {Promise<object>} the `measurement` envelope
   */
  measure(profile, options = {}) {
    // Only the request that was actually accepted owns the busy flag. A second
    // concurrent measure is refused with BUSY, and clearing the flag on that
    // rejection would report the machine idle while the first is still running.
    let owned = false;
    return this._request(Object.assign({ cmd: 'measure', profile }, options), {
      // A measure is answered by `measurement`, not by an echo of its own type.
      resolveOn: 'measurement',
      onAccepted: () => { owned = true; this.busy = true; },
      always: () => { if (owned) this.busy = false; },
    });
  }

  /** Stop a running measurement. Its promise rejects with code CANCELLED. */
  cancel() { return this._request({ cmd: 'cancel' }, { resolveOn: 'cancelling' }); }

  status() { return this._request({ cmd: 'status' }, { resolveOn: 'status' }); }

  /** Forget the remembered scale, so the next measure scans again. */
  forget() { return this._request({ cmd: 'forget' }, { resolveOn: 'forgotten' }); }

  /**
   * Shut the service down and wait for the process to go.
   *
   * Closing stdin is the reliable half: the service exits when its parent's
   * pipe closes, so this works even if the service is wedged.
   */
  stop({ timeoutMs = 3000 } = {}) {
    const child = this.child;
    if (!child) return Promise.resolve();

    // Retire the child immediately rather than waiting for 'close'. Otherwise
    // `running` stays true for up to timeoutMs, a caller's guard passes, and
    // the write lands on an ended stdin. That does not throw synchronously; it
    // emits asynchronously and takes the whole process down.
    this.child = null;
    this.hello = null;
    this._stopping = true;
    // Pending requests are NOT rejected here. The child's 'close' handler does
    // it, which is always reached because the timer below kills the child.
    // Rejecting eagerly would settle a promise the caller has not yet awaited,
    // and Node would report it as an unhandled rejection.

    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        // Close stdin before killing: on Windows kill() reaches the service but
        // not the Python grandchild, which would keep holding the radio.
        try { child.stdin.end(); } catch (e) { /* already closed */ }
        try { child.kill(); } catch (e) { /* already gone */ }
        resolve();
      }, timeoutMs);
      child.once('close', done);
      try {
        child.stdin.write(JSON.stringify({ id: '_stop', cmd: 'shutdown' }) + '\n');
        child.stdin.end();
      } catch (e) {
        try { child.kill(); } catch (e2) { /* already gone */ }
      }
    });
  }

  // ---------------------------------------------------------------- internals

  _request(body, { resolveOn, onAccepted, always } = {}) {
    if (!this.child) {
      return Promise.reject(new ScaleError('TRANSPORT_FAILED',
        'the scale service is not running; call start() first'));
    }
    if (!this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      return Promise.reject(new ScaleError('TRANSPORT_FAILED', 'the scale service is shutting down'));
    }
    const id = `r${++this._seq}`;
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolveOn,
        onAccepted,
        resolve: (v) => { if (always) always(); resolve(v); },
        reject:  (e) => { if (always) always(); reject(e); },
      });
      try {
        this.child.stdin.write(JSON.stringify(Object.assign({ id }, body)) + '\n');
      } catch (err) {
        this._pending.delete(id);
        if (always) always();
        reject(new ScaleError('TRANSPORT_FAILED', `could not write to the scale service: ${err.message}`));
      }
    });
  }

  _onLine(line) {
    let ev;
    try { ev = JSON.parse(line); }
    catch (e) { this.emit('log', `unparseable line from service: ${line}`); return; }

    if (ev.proto && ev.proto !== PROTOCOL_VERSION) {
      this.emit('log', `service speaks protocol ${ev.proto}, this client speaks ${PROTOCOL_VERSION}`);
    }

    if (ev.type === 'hello') {
      this.hello = ev;
      this.emit('hello', ev);
      return;
    }

    // Progress is a stream, not a reply: forward it and keep the request open.
    if (ev.type === 'progress') {
      this.emit('progress', ev);
      if (ev.phase) this.emit(ev.phase, ev);
      return;
    }

    const waiter = ev.id != null ? this._pending.get(ev.id) : null;

    if (ev.type === 'accepted') {
      if (waiter && waiter.onAccepted) waiter.onAccepted(ev);
      this.emit('accepted', ev);
      return;                                    // not the final reply
    }

    if (ev.type === 'error') {
      const err = new ScaleError(ev.code, ev.message, ev.detail);
      if (waiter) { this._pending.delete(ev.id); waiter.reject(err); }
      this.emit('error-event', err, ev);         // never 'error': that throws when unhandled
      return;
    }

    if (waiter && (!waiter.resolveOn || ev.type === waiter.resolveOn)) {
      this._pending.delete(ev.id);
      waiter.resolve(ev);
    }
    this.emit(ev.type, ev);
  }

  _die(err) {
    for (const [id, waiter] of this._pending) { this._pending.delete(id); waiter.reject(err); }
    this.emit('_startFailed', err);
  }
}

/** Resolve the scale directory in both development and a packaged app. */
BodyScaleClient.resolveScaleDir = function (app, devPath) {
  if (app && app.isPackaged) return path.join(process.resourcesPath, 'bodyscale');
  return devPath;
};

module.exports = { BodyScaleClient, ScaleError, PROTOCOL_VERSION };
