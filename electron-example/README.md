# Electron integration example

A working Electron app that reads the scale. Four files do the whole job.

| File | Role |
|---|---|
| `bodyscale-client.js` | Owns the service child process. Promises and events. **Copy this into your app.** |
| `main.js` | Wires the client to IPC and to the app lifecycle. |
| `preload.js` | The sandboxed bridge. The renderer gets these calls and nothing else. |
| `renderer/index.html` | A plain UI showing live weight and the results. |

The full protocol is documented in [`../API.md`](../API.md). This directory is
the same thing as running code.

---

## Run it now, with no scale

```bash
cd electron-example
npm install
npm run start:replay
```

This replays a recorded SSW533 session: the same advertisement, the same live
weight frames, the same final record. Press **Measure** and the weight climbs
to 97.90 kg exactly as it does with the real hardware. Build your entire UI
against this before you touch a radio.

With a real scale, step on it first, then:

```bash
npm start
```

---

## The three-line version

```js
const { BodyScaleClient } = require('./bodyscale-client');

const client = new BodyScaleClient({ scaleDir: '/path/to/bodyscale' });
client.on('progress', (p) => console.log(p.phase, p.weightKg));   // live weight
await client.start();
const result = await client.measure({ age: 39, heightCm: 180, sex: 'male' });
```

`result.measured` holds the two numbers the scale sent. `result.derived` holds
twenty-four values computed from them. Your app supplied three fields and
nothing else. That is the whole contract.

---

## The client API

```js
new BodyScaleClient({
  scaleDir,           // required: directory holding scale.js, outside asar
  nodePath,           // default process.execPath (Electron itself)
  pythonPath,         // optional: a bundled interpreter
  env,                // optional: extra environment, e.g. BODYSCALE_CONFIG_DIR
  replay,             // optional: a fixture path, for development
  startTimeoutMs,     // default 10000
  onLog,              // optional: receives the service's stderr
})
```

| Method | Resolves with | Rejects with |
|---|---|---|
| `start()` | the `hello` object | `ScaleError('TRANSPORT_FAILED')` |
| `measure(profile, opts?)` | the `measurement` envelope | `ScaleError(code)` |
| `cancel()` | the `cancelling` ack | `ScaleError` |
| `status()` | the `status` object | `ScaleError` |
| `forget()` | the `forgotten` ack | `ScaleError` |
| `stop({timeoutMs})` | when the child is gone | never |

Properties: `running`, `busy`, `hello`, `child`.

Events: `progress`, one event per phase name (`connected`, `ready`,
`settling`, …), `hello`, `accepted`, `log`, `close`, `error-event`.

### Why `error-event` and not `error`

Node's `EventEmitter` throws when an `error` event has no listener. That would
turn a sleeping scale into an app crash. The client emits `error-event`
instead, so ignoring errors is safe. Errors also reject the corresponding
promise, which is where you should normally handle them.

### `ScaleError`

```js
try {
  await client.measure(profile);
} catch (err) {
  err.code;      // 'DEVICE_NOT_FOUND' | 'NO_READING' | 'PERMISSION_DENIED' | ...
  err.message;   // a sentence you can show
  err.detail;    // extra context, or null
}
```

`DEVICE_NOT_FOUND` is the one you will see most, and it is usually not a fault.
The scale's radio sleeps within seconds of going idle. **Design the flow as:
user steps on the scale, then presses the button.**

---

## Packaging for Windows

Three things break a packaged build, in the order you will meet them.

### 1. asar

A packaged Electron app is an archive. Python cannot read `ble.py` out of it,
and an interpreter cannot be spawned from inside it. Keep the scale directory
outside. `package.json` here already does this with `extraResources`.

Resolve the path differently in development and production:

```js
const SCALE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bodyscale')
  : path.join(__dirname, '..');
```

`BodyScaleClient.resolveScaleDir(app, devPath)` does exactly this.

### 2. Orphaned Python

`child.kill()` on Windows does not reach grandchildren, and the Python helper
is a grandchild. An orphan holds the Bluetooth radio, and the *next* launch
fails with `DEVICE_NOT_FOUND` for no visible reason.

The service kills its own helper with `taskkill /T /F`. Your app must still
close the service. Closing stdin is the reliable half, because it works even
when the service is wedged:

```js
app.on('before-quit', async (event) => {
  if (!client.running || app.isQuiting) return;
  event.preventDefault();
  app.isQuiting = true;
  await client.stop({ timeoutMs: 2000 });
  app.quit();
});
```

### 3. The console window

Every spawn without `windowsHide: true` flashes a black window. The client
sets it already. If you write your own spawn, do not forget it.

### Shipping Python

Bundling an interpreter is the difference between an installer that works and
a support queue.

```powershell
powershell -ExecutionPolicy Bypass -File ..\setup-win.ps1 -Embed
```

That downloads the official Windows embeddable Python into `../python/` and
installs `bleak` into it, about 25 MB. `package.json` copies it. The service
finds `python\python.exe` without being told.

To point at it explicitly:

```js
new BodyScaleClient({
  scaleDir: SCALE_DIR,
  pythonPath: path.join(SCALE_DIR, 'python', 'python.exe'),
});
```

### Point the config at your app's data directory

The service remembers the scale's address in the per-user data directory, so a
packaged app never tries to write into `Program Files` or a signed `.app`. To
keep it with the rest of your app's state instead:

```js
new BodyScaleClient({
  scaleDir: SCALE_DIR,
  env: { BODYSCALE_CONFIG_DIR: app.getPath('userData') },
});
```

If the directory cannot be written, the service says so on its log channel and
carries on. The cost is one full scan per launch, not a failure.

### You do not need Node installed

Electron's binary is a Node runtime. The client spawns `process.execPath` with
`ELECTRON_RUN_AS_NODE=1`, so a packaged app has no Node dependency at all.

### Bluetooth permission

Windows Settings → Privacy & security → Bluetooth devices → "Let desktop apps
access your Bluetooth devices". If it is off, everything fails with
`PERMISSION_DENIED`, and there is no prompt. Your installer cannot flip it.
Detect the code and open the page:

```js
shell.openExternal('ms-settings:privacy-bluetooth');
```

---

## Packaging for macOS

Add the usage string, or the OS kills the process instead of prompting:

```json
"mac": {
  "extendInfo": {
    "NSBluetoothAlwaysUsageDescription": "Connects to your body scale to read your weight."
  }
}
```

macOS attributes Bluetooth to the *responsible* process, the app at the root of
the process tree. A packaged `.app` is responsible for its own children, so
this works. Running the service from inside another tool's embedded terminal
does not, because that tool becomes responsible.

---

## What to show the user

`result.derived` has twenty-four keys. Showing all of them makes an unreadable
screen. The renderer here shows twelve and dims the ones whose `confidence` is
`derived-vendor-convention`, meaning the arithmetic every consumer scale uses
with no clinical validation behind it.

Three rules worth keeping:

1. **Use `bodyFatRecommended`.** It chooses between the impedance figure and
   the BMI figure, and hands you the BMI one when the impedance failed.
2. **Honour `trust.impedanceDerived`.** When it is false, body fat, water,
   muscle and protein are estimates from BMI, not measurements. Say so.
3. **Show `flags`.** Each carries a plain sentence written for a user. Do not
   invent your own thresholds; the service already checked eleven.

`result.omitted` lists six values other scale apps display that this one
refuses to, each with a reason. Visceral fat and metabolic age are in there. If
your design has slots for them, read that object rather than filling them in.

---

## Testing

The client is tested under plain Node, with no Electron and no radio:

```bash
cd ..
node --test test/client.test.js
```

Those tests drive the real service over a real pipe against the recorded
session, covering the measurement path, cancellation, invalid profiles,
concurrent requests and shutdown.
