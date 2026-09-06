# Body Scale Service — API contract

A long-lived child process that talks newline-delimited JSON over stdin and
stdout. Your Electron main process spawns it once at startup, sends `measure`
when the user presses a button, and receives live weight and a full body
composition result.

**The division of labour is fixed.** Your app supplies three facts about the
person: `age`, `heightCm`, `sex`. This service supplies everything else — the
Bluetooth connection, the weight, the impedance, and the derived body metrics.

**Your app owns the person; this service owns the device.** The profile is
required on every `measure`. The service never defaults it, never remembers it,
and never returns one. If it finds a profile in a config file left by an older
version, it deletes it. The only thing it keeps between runs is the scale's own
name and address, so the next scan is instant.

That separation is deliberate. A copy of someone's age and height held here
could outlive your app's own record and be silently wrong, and it is personal
data this process has no reason to hold.

- Protocol version: **1** (every message carries `"proto": 1`)
- Transport: stdin/stdout pipe, UTF-8, one JSON object per line, `\n` terminated
- Runtime: Node.js 18+ (the service) and Python 3.9+ with `bleak` (the radio)

---

## 1. Starting the service

```
node scale.js --serve
```

Spawn it once and keep it. It is cheap when idle: no radio is touched until a
`measure` arrives.

```js
const { spawn } = require('child_process');
const child = spawn(process.execPath, [scalePath, '--serve'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,          // no console window flashes on Windows
});
```

**stdout is the protocol and nothing else.** Every line is one JSON object.
There is no framing, no length prefix and no partial line. Human-readable logs
and diagnostics go to stderr, which you can pipe to your own log file or
ignore. Never parse stderr.

### Command-line flags

| Flag | Default | Meaning |
|---|---|---|
| `--serve` | — | Run as the JSON service. Required for this API. |
| `--name <s>` | `SSW533` | Advertised name to match, when no device is remembered. |
| `--address <s>` | — | Connect straight to this identifier, skipping the scan. |
| `--scan-timeout <s>` | `20` | Seconds to wait for the scale to advertise. |
| `--connect-timeout <s>` | `20` | Seconds to wait for the GATT link. |
| `--hold <s>` | `120` | Seconds to hold the link waiting for a stable reading. |
| `--replay <file>` | — | Replay a recorded session instead of using the radio. Use this to develop your UI with no hardware. |
| `--python <path>` | auto | Python interpreter for the Bluetooth helper. |

The environment variable `BODYSCALE_PYTHON` does the same as `--python`, and is
usually the easier knob inside a packaged app.

Per-request options on `measure` override these defaults for one measurement.
Note the names differ: the flag is `--hold`, the JSON field is `timeoutSec`.

---

## 2. Message shapes

### Every message you send

```jsonc
{
  "id":  "any string or number you choose",   // echoed on every reply; optional
  "cmd": "measure | cancel | status | forget | shutdown"
}
```

The `id` is yours. Correlate replies with it. If you omit it, replies carry
`"id": null`. Anything that is not a JSON object on one line is answered with
`BAD_REQUEST` and the service stays up.

### Every message you receive

```jsonc
{ "proto": 1, "type": "<event type>", "id": "<your id, or null>", ... }
```

Switch on `type`. Treat an unrecognised `type` as informational and ignore it;
future protocol versions may add event types without changing `proto`.

---

### Staying in step

Four rules keep your app and the service synchronised. A host that follows them
cannot drift.

1. **Correlate on `id`, never on order.** Replies may interleave. The service
   answers a cheap `status` immediately while a measurement is still running, so
   a later request can be answered first. This is legal and expected.
2. **Exactly one terminal event per request.** `measurement`, `error`, `status`,
   `forgotten`, `cancelling` and `bye` are terminal; `accepted` and `progress`
   are not. Settle your promise on the terminal event only. Every request gets
   one, and never two.
3. **One measurement at a time.** A second `measure` while one is running is
   refused with `BUSY`. The first is unaffected. Disable your button between
   `accepted` and the terminal event, or `cancel` first.
4. **`status` is the resynchronisation point.** It reports `busy` and
   `runningId`, so a host that has lost track can recover without restarting the
   service. It touches no hardware, so poll it freely.

## 3. Events

### `hello` — sent unprompted, once, immediately

Wait for this before sending anything. It tells you what this build supports,
so you can feature-detect instead of hard-coding.

```json
{
  "proto": 1,
  "type": "hello",
  "app": "bodyscale",
  "version": "1.0.0",
  "platform": "win32",
  "node": "20.11.1",
  "device": { "name": "SSW533", "address": "AA:BB:CC:DD:EE:FF", "remembered": true },
  "profile": {
    "required": true,
    "suppliedBy": "host",
    "fields": ["age", "heightCm", "sex"],
    "persisted": false
  },
  "commands": ["measure", "compute", "cancel", "status", "forget", "shutdown"],
  "errorCodes": ["BAD_REQUEST", "UNKNOWN_COMMAND", "INVALID_PROFILE", "BUSY",
                 "DEVICE_NOT_FOUND", "NO_READING", "BLUETOOTH_UNAVAILABLE",
                 "PERMISSION_DENIED", "TRANSPORT_FAILED", "CANCELLED", "INTERNAL"],
  "note": "one JSON object per line; the caller supplies age, heightCm and sex, and nothing else"
}
```

`device` is `null` until a scale has been measured once. After that the address
is remembered on disk and later measurements skip the scan, which is the
difference between connecting in about a second and waiting for a scan window.

### `accepted` — the measurement started

```json
{ "proto": 1, "type": "accepted", "id": "m1",
  "profile": { "sex": "male", "age": 39, "heightCm": 180 } }
```

The `profile` is echoed back exactly as the service resolved it, including any
default it applied. Show the user what it actually used, not what you sent.

### `progress` — live, repeated, safe to ignore

```json
{ "proto": 1, "type": "progress", "id": "m1", "phase": "settling", "weightKg": 97.95 }
```

| `phase` | Meaning | Suggested UI |
|---|---|---|
| `scanning` | Listening for the scale's advertisement. | "Looking for the scale" |
| `found` | Advertisement seen, connecting now. | "Found it" |
| `connected` | GATT link up. Carries `name` and `address`. | "Connected" |
| `ready` | Subscribed and listening. | **"Step on the scale"** |
| `settling` | A live weight is streaming. Carries `weightKg`. | Show the number, large |
| `settled` | The scale locked the reading. | Freeze the number |

`settling` arrives several times a second while the user shifts their weight.
Render `weightKg` straight to the screen. It is the same number the scale's own
display shows.

### `measurement` — the result

One per successful `measure`. This is the payload your app stores.

```jsonc
{
  "proto": 1, "type": "measurement", "id": "m1",
  "ok": true,
  "timestamp": "2026-09-04T19:10:51.789Z",
  "device":  { "name": "SSW533", "address": "AA:BB:CC:DD:EE:FF" },
  "model":   "Dr Trust SSW532",
  "profile": { "sex": "male", "age": 39, "heightCm": 180 },

  // The only two numbers that came off the scale.
  "measured": { "weightKg": 97.9, "impedanceOhm": 529.9 },

  // Everything computed from those two plus the profile.
  "derived": { "bmi": 30.2, "bodyFatPercent": 36, "muscleMassKg": 59.4, ... },
  "units":      { "bmi": "kg/m²", "bodyFatPercent": "%", ... },
  "confidence": { "bmi": "derived-literature", "boneMassKg": "derived-vendor-convention", ... },

  "bodyFatRecommended": { "key": "bodyFatPercent", "value": 36 },
  "trust":   { "impedanceFree": true, "impedanceDerived": true },
  "crossCheck": { "impedanceBased": 36, "bmiBased": 29, "gapPoints": 6.9, "oneSigma": 6.7, "twoSigma": 13.4 },
  "flags":    [ { "rule": "T8", "severity": "warn", "message": "..." } ],
  "warnings": [ "The scale sent two numbers, your weight and one impedance value. ..." ],
  "omitted":  { "visceralFatRating": "why this is not reported", ... }
}
```

The whole envelope is plain JSON: numbers and strings only, no `NaN`, no
`Infinity`, no dates as objects. It survives `structuredClone`, so you can pass
it to a renderer through `ipcMain`/`ipcRenderer` unchanged.

### `status`, `cancelling`, `forgotten`, `bye`

```json
{ "proto": 1, "type": "status", "id": 1, "busy": false, "runningId": null,
  "device": { "name": "SSW533", "address": "..." }, "platform": "win32", "version": "1.0.0" }
{ "proto": 1, "type": "cancelling", "id": "c", "cancelling": "m1" }
{ "proto": 1, "type": "forgotten", "id": "f" }
{ "proto": 1, "type": "bye", "id": "q" }
```

### `error` — a request failed

```json
{ "proto": 1, "type": "error", "id": "m1", "code": "DEVICE_NOT_FOUND",
  "message": "no scale answered; its radio sleeps when idle",
  "detail": { "outcome": "not-found", "framesSeen": 0 } }
```

`detail` carries whatever helps diagnosis and may gain fields; do not require
any of them. A `TRANSPORT_FAILED` puts the operating system's own spawn error
in `detail.spawnError`, which on Windows is usually the difference between
"Python is not installed" and something far less obvious.

An `error` carrying the `id` of a `measure` **ends** that measurement. No
`measurement` will follow. Errors never terminate the service.

---

## 4. Commands

### `measure`

```jsonc
{
  "id": "m1",
  "cmd": "measure",
  "profile": {
    "age": 39,          // required, 5–120
    "heightCm": 180,    // required, 90–250
    "sex": "male"       // optional, "male" | "female", defaults to "male"
  },

  "deviceName":    "SSW533",   // optional, overrides the remembered name
  "address":       "AA:BB:...", // optional, skips the scan entirely
  "scanTimeoutSec": 20,        // optional
  "timeoutSec":     40         // optional
}
```

The profile is validated before any radio work begins, so a bad profile costs
nothing and never leaves the scale connected.

Reply sequence on success:

```
accepted → progress × N → measurement
```

and on failure:

```
accepted → progress × N → error
```

or, for a rejected profile, `error` alone.

### `cancel`

```json
{ "id": "c", "cmd": "cancel" }
```

Stops whatever is running. You receive `cancelling` at once, then an `error`
with code `CANCELLED` carrying the **measurement's** id. Cancelling kills the
Bluetooth helper and releases the radio, so the next `measure` starts clean.
Cancel with nothing running is a `BAD_REQUEST` and is harmless.

### `status`

```json
{ "id": 1, "cmd": "status" }
```

Cheap. Poll it freely; it touches no hardware.

### `compute` — interpret a reading taken earlier

`derived` is a pure function of `measured` and the profile. A reading captured
without a profile loses nothing; it has simply not been interpreted yet.

```jsonc
{
  "id": "c1",
  "cmd": "compute",
  "measured": { "weightKg": 97.9, "impedanceOhm": 529.9 },   // required
  "profile": { "age": 39, "heightCm": 180, "sex": "male" },  // required
  "measuredAt": "2026-09-05T09:12:34.583Z",                  // optional, carried through
  "model": "Dr Trust SSW532"                                 // optional, carried through
}
```

Answered with a `measurement` envelope of exactly the same shape, carrying
`"source": "recomputed"`. **It is byte-identical to what a live measurement with
that profile would have produced**, apart from timing and provenance, so a host
needs only one renderer.

No radio is touched. It answers immediately, and works with no scale present.

`timestamp` is when it was computed; `measuredAt` is when the scale was read, if
you passed it. The two are never conflated.

### Capturing before you know the profile

The scale's radio sleeps within seconds of going idle, so the weight must be
taken the moment it settles. A person's age can be asked at leisure.

```jsonc
{ "id": "m1", "cmd": "measure", "withoutProfile": true }
```

This returns `measured` with an empty `derived`, `profileDeferred: true` and
`profile: null`. Store `measured`, ask for the age whenever suits, then send it
to `compute`.

**This is opt-in on purpose.** A `measure` with no `profile` and no
`withoutProfile` is still rejected with `INVALID_PROFILE`, because a host that
simply forgot is the commoner bug. Sending both is a `BAD_REQUEST`.

One reading can be recomputed as often as you like — to fix a typo in an age,
or to show the same weight interpreted for two different people.

### `forget`

```json
{ "id": "f", "cmd": "forget" }
```

Erases the remembered device for the current platform. The next `measure`
scans again. Use it when the user replaces their scale.

### `shutdown`

```json
{ "id": "q", "cmd": "shutdown" }
```

Replies `bye`, kills any child, exits 0. Closing stdin does the same thing, so
if your Electron app dies the service dies with it. You do not have to call
`shutdown`; it is there for a clean quit.

---

## 5. Error codes

| Code | Cause | What your app should do |
|---|---|---|
| `BAD_REQUEST` | Not JSON, not an object, or a command that needs state you do not have. | Fix the caller. This is a bug in your code. |
| `UNKNOWN_COMMAND` | No such `cmd`. | Feature-detect using `hello.commands`. |
| `INVALID_PROFILE` | `age` or `heightCm` missing or out of range, or a bad `sex`. | Show the message; it names the offending field. |
| `BUSY` | A measurement is already running. | Disable your button while `accepted` is outstanding, or `cancel` first. |
| `DEVICE_NOT_FOUND` | Nothing advertised in the scan window. | **The common one.** The scale's radio sleeps. Tell the user to step on the scale to wake it, then retry. |
| `NO_READING` | Connected, but no stable weight arrived in time. | Ask the user to stand still and retry. |
| `PERMISSION_DENIED` | The OS refused Bluetooth to this process. | See the platform notes below. Needs a settings change, not a retry. |
| `BLUETOOTH_UNAVAILABLE` | Bluetooth is switched off, or there is no adapter. | Ask the user to turn Bluetooth on. Distinct from `PERMISSION_DENIED` on purpose: sending someone to a privacy toggle that is already on is a dead end. |
| `TRANSPORT_FAILED` | The Python helper could not start. | Python or `bleak` is missing. `detail.spawnError` carries the operating system's own message, such as `spawn python ENOENT`. Show it. |
| `CANCELLED` | Your own `cancel`. | Expected. Not an error to show. |
| `INTERNAL` | Anything else. | Log `detail` and offer a retry. |

`DEVICE_NOT_FOUND` is the one you will see most, and it is usually not a fault.
A body scale powers its radio down within seconds of going idle. **The correct
flow is: user steps on the scale first, then your app sends `measure`.** Design
the button around that.

---

## 6. The measured numbers versus the derived ones

This distinction matters, because it decides what you may present as a
measurement and what you must present as an estimate.

**`measured`** — two numbers, both from the scale's own hardware.

| Field | Unit | Note |
|---|---|---|
| `weightKg` | kg | Identical to the scale's display. |
| `impedanceOhm` | Ω | Whole-body impedance at 50 kHz, foot to foot. `0` if the scale sent none. |

**`derived`** — twenty-four values computed here from those two plus the
profile. `units` and `confidence` are parallel objects with the same keys.

| Key | Unit | Basis |
|---|---|---|
| `bmi` | kg/m² | Definition. |
| `bmiCategoryWho` | — | WHO cut-offs. |
| `bmiCategoryAsiaPacific` | — | WHO Asia-Pacific cut-offs, lower thresholds. |
| `bodyFatPercentBmiAnchor` | % | Deurenberg 1991, from BMI. No impedance. |
| `bmrKcal` | kcal/day | Mifflin-St Jeor 1990. |
| `healthyWeightRangeKg` | kg | BMI 18.5–25 at this height. |
| `weightAboveHealthyRangeKg` | kg | Distance above that range. |
| `idealWeightRangeKg` | kg | BMI 22–24 at this height. |
| `bodyWaterLitres` | L | **Sun 2003**, the one impedance equation used. |
| `bodyWaterPercent` | % | Of body weight. |
| `fatFreeMassKg` | kg | Body water ÷ 0.732 (Wang 1999). |
| `fatFreeMassIndex` | kg/m² | Fat-free mass over height squared. |
| `bodyFatPercent` | % | Weight minus fat-free mass. **The impedance-based one.** |
| `fatMassKg` | kg | Same, in kilograms. |
| `muscleMassKg` | kg | Fat-free mass minus bone. Vendor convention. |
| `muscleMassPercent` | % | Of body weight. |
| `skeletalMuscleMassKg` | kg | Janssen 2000. |
| `skeletalMusclePercent` | % | Of body weight. |
| `skeletalMuscleIndex` | kg/m² | Janssen index. |
| `boneMassKg` | kg | Vendor convention, a fixed fraction of fat-free mass. |
| `proteinMassKg` | kg | Fat-free mass minus water minus bone. |
| `proteinPercent` | % | Of body weight. |
| `bodyFatGapPoints` | points | Distance between the two body fat methods. |
| `bodyFatRecommendedKey` | — | Which body fat number to show. |

`confidence` takes one of two values. `derived-literature` means a published,
peer-reviewed equation. `derived-vendor-convention` means the arithmetic every
consumer scale uses, with no clinical validation behind it. Show the second
group more quietly than the first.

### `derived` has two shapes, and both are normal

| Case | `measured.impedanceOhm` | `derived` keys | `impedanceFree` | `impedanceDerived` |
|---|---|---|---|---|
| A person, impedance passed | a number | **24** | `true` | `true` |
| A person, impedance failed | the rejected number | **24** | `true` | `false` |
| A person, no impedance | `null` | **9** | `true` | `false` |
| **Not a person on the scale** | anything | **0** | `false` | `false` |

That last row is not hypothetical. A real session produced `18.45 kg` with
`1313.4 Ω` — a bag, a pet, or someone stepping off mid-reading. Rule T1 fired,
and `derived`, `units`, `confidence` and `omitted` all came back as **empty
objects**, with `bodyFatRecommended` and `crossCheck` `null`.

**`trust.impedanceFree` is the guard for this shape.** When it is `false`, not
even weight-only figures like BMI and BMR exist, because the weight itself is
not a person's. Check it before reading anything at all:

```js
if (!m.trust.impedanceFree) {
  // Nothing was computed. m.flags explains why, in a sentence you can show.
  show(m.flags[0].message);            // "Weight is 18.45 kg, too low to be…"
  return;
}
```

**The key count and the trust flags are independent signals. Do not infer one
from the other.** A rejected impedance still produces all twenty-four values —
they are simply not to be believed. A *missing* impedance shrinks the set to
nine. And a weight that is not a person's produces **none at all**.

A host that treats "few keys" as "untrustworthy" will display a rejected body
fat of 62.3% as though it were a measurement. Branch on `trust.impedanceDerived`
for believability, and key-check for presence. They answer different questions.

**Never assume a key exists.** These nine are always present:

```
bmi  bmiCategoryWho  bmiCategoryAsiaPacific  bodyFatPercentBmiAnchor
bmrKcal  healthyWeightRangeKg  weightAboveHealthyRangeKg
idealWeightRangeKg  bodyFatRecommendedKey
```

The other fifteen — body fat, fat mass, water, muscle, skeletal muscle, bone,
protein and the FFMI — appear whenever an impedance value arrived at all, pass
or fail. When it failed, they are present and wrong, and `trust.impedanceDerived`
is the only thing that says so.

Neither shape is an error path. A user in socks or with dry skin routinely
produces one or the other: the scale may send a wild impedance, or none at all.

On the reference device both were seen minutes apart. An impedance of 3115.6 Ω
arrived and was rejected — twenty-four keys, `trust.impedanceDerived` false,
`bodyFatRecommended` switched to the BMI anchor. A later attempt sent no
impedance at all — nine keys, `measured.impedanceOhm` null.

### Which body fat to display

Use `bodyFatRecommended`. It picks between the impedance figure and the BMI
figure, and it will hand you the BMI one when the impedance failed its checks.

```js
const bf = m.bodyFatRecommended;                        // { key, value }
const fromImpedance = bf.key === 'bodyFatPercent';      // false ⇒ estimated from BMI
```

### `trust`

```json
{ "impedanceFree": true, "impedanceDerived": true }
```

`impedanceFree` covers weight, BMI and BMR — anything not touching impedance.
It is almost always true. `impedanceDerived` covers body fat, water, muscle and
protein. **When it is false, do not display those as measurements.** The
`flags` array says which rule failed and why, in plain sentences you can show
directly.

Severity is `fatal` or `warn`, and the split is clean:

| Rules | Severity | Effect |
|---|---|---|
| **T1–T6** | `fatal` | clear `trust.impedanceDerived` |
| **T7–T11** | `warn` | advisory only; trust is unaffected |

| Rule | Checks |
|---|---|
| T1 | Degenerate input: no weight, a weight too low to be a person, or a missing or unrealistic height or age. |
| T2 | Impedance outside the physically possible 150–1200 Ω band. |
| T3 | The impedance and BMI body-fat figures differ by more than two standard errors. |
| T4 | Fat-free mass index above the drug-free ceiling for this sex. |
| T5 | Body fat outside the survivable range for this sex. |
| T6 | Body water above a fraction no body carrying any fat can reach. |
| T7 | The lean-mass metabolic rate differs from Mifflin-St Jeor by over 15%. |
| T8 | The two body-fat methods differ by about one standard error. |
| T9 | Impedance outside the 250–700 Ω typical of foot-to-foot scales. An engineering heuristic, not a citation. |
| T10 | A derived value falls outside its plausible adult range. |
| T11 | Age outside 18–90, the range these equations were fitted on. |

**The invariant your UI can rely on:** if any `fatal` flag is present,
`trust.impedanceDerived` is `false`. This was checked exhaustively over 951,048
input combinations and holds without exception, so you may branch on either one.
Branch on `trust`; it is the simpler test.

### `omitted`

Six values other scale apps display that this one deliberately does not, each
with a sentence explaining why. Visceral fat and metabolic age are in here.
If your UI has slots for them, read this object rather than filling them with a
number of your own.

### Honest limits, worth putting in your UI copy

A foot-to-foot scale drives current up one leg and down the other. It measures
your legs well, your torso barely and your arms not at all. Absolute body fat
from such a device carries roughly 5 percentage points of error against a DEXA
scan. **The trend across weeks, measured at the same time of day, is
trustworthy. A single absolute number is not.** Hydration, a recent meal and a
recent shower all move impedance more than a week of real change does.

---

## 7. Windows

### What is different from macOS

| | macOS | Windows |
|---|---|---|
| Bluetooth backend | CoreBluetooth | WinRT |
| Device identifier | An opaque per-machine UUID | The MAC address |
| Config key | `address_darwin` | `address_win32` |
| Config location | `~/Library/Application Support/bodyscale/` | `%APPDATA%\bodyscale\` |
| Pairing | Implicit on connect | Implicit for BLE GATT; no PIN for this scale |
| Permission | TCC, per responsible app | A privacy toggle, per app |

Identifiers are **not portable between machines or platforms.** That is why the
config stores them under a per-platform key. Never ship a hard-coded address.

### Requirements

- **Windows 11 is the supported baseline.** bleak's own package metadata
  classifies Windows 11 only. The WinRT APIs underneath still work on Windows 10
  build 16299 and later, which is what `setup-win.ps1` checks for, but that
  combination is untested upstream. Treat Windows 10 22H2 as best effort.
- A Bluetooth 4.0+ adapter, switched on.
- Python 3.9+ with `bleak`.
- Node.js 18+, unless you run inside Electron, which supplies its own.

No manifest entry and no capability declaration are needed. `Windows.Devices.Bluetooth`
capability declarations apply to packaged MSIX apps; an NSIS-installed Win32
console child needs none.

### This scale does not need pairing

Service `0xFFB0` exposes no encrypted or authenticated characteristic, so a GATT
connect and CCCD write succeed unbonded on Windows exactly as on macOS. **Do not
tell users to pair it in Windows Settings.** If someone has already paired it and
connections now fail, "Remove device" in Settings is worth trying, but present
that as a thing to try, not a fix: it is field folklore, not documented
behaviour.

### Permission

Windows Settings → Privacy & security → Bluetooth devices. "Let desktop apps
access your Bluetooth devices" must be on. If it is off you get
`PERMISSION_DENIED`. Unlike macOS, there is no prompt: the call simply fails,
which is why the service reports it as its own error code.

Your installer cannot flip this. Detect `PERMISSION_DENIED` and link the user
to the settings page:

```js
shell.openExternal('ms-settings:privacy-bluetooth');
```

### Setup

Run `setup-win.ps1` once. It creates `.venv` beside the script and installs
`bleak` into it. The service finds `.venv\Scripts\python.exe` on its own.

```powershell
powershell -ExecutionPolicy Bypass -File setup-win.ps1
```

### Where the remembered device is stored

The scale's address is written to the per-user data directory, never beside the
script:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\bodyscale\scale-config.json` |
| macOS | `~/Library/Application Support/bodyscale/scale-config.json` |
| Linux | `$XDG_CONFIG_HOME/bodyscale/scale-config.json` |

This is not cosmetic. A packaged app lives in `Program Files` or inside a signed
`.app`, and writing there fails for a standard user and invalidates a macOS
signature. Storing it beside the script means the address is never remembered,
`hello.device` is `null` on every launch, and every first measurement pays a
full scan.

Set `BODYSCALE_CONFIG_DIR` to override the location, which is what you want if
your app already has its own data directory:

```js
env: { ...process.env, BODYSCALE_CONFIG_DIR: app.getPath('userData') }
```

A config left beside the script by an older version is still read, so nothing
is lost on upgrade.

### The transport self-test

Before the first measurement the service runs the interpreter with `--selftest`
and caches the answer. This exists for one specific Windows trap.

If Python is not installed, the name `python` **still resolves**: Windows ships
an App Execution Alias at `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`
that spawns successfully, prints *"Python was not found; run without arguments
to install from the Microsoft Store"*, and exits 9009. The spawn succeeds, so an
ENOENT check never fires. Without the self-test the measurement fails with
`NO_READING` and the user is told to stand on a scale that was never contacted.

You can run it yourself:

```bash
python ble.py --selftest
```

```json
{"t":"selftest","ok":true,"bleak":"3.0.2","python":"3.11.9","executable":"...","platform":"Windows"}
```

Exit 0 means the transport works. Anything else, and `measure` fails fast with
`TRANSPORT_FAILED` and a message naming the actual cause — the Store alias, a
missing `bleak`, or an unusable interpreter.

### Packaging into an Electron app

Three things bite, in this order.

**1. asar.** A packaged app puts your files inside `app.asar`, which is an
archive. You cannot spawn an interpreter from inside it, and Python cannot read
`ble.py` out of it. Mark the scale directory unpacked:

```jsonc
// package.json, electron-builder
"build": {
  "extraResources": [{ "from": "../bodyscale", "to": "bodyscale" }],
  "asarUnpack": ["**/bodyscale/**"]
}
```

`asarUnpack` patterns are relative to the app directory, not to `resources`, which is why the glob is `**/bodyscale/**`.

Then resolve the path at runtime, differently in development and production:

```js
const scaleDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bodyscale')
  : path.join(__dirname, '..', 'bodyscale');
```

**2. Killing the child.** `child.kill()` on Windows does not reach
grandchildren, and the Python helper is a grandchild. Killing the service
without killing Python leaves the radio held and the next run fails with
`DEVICE_NOT_FOUND`. The service handles this internally with `taskkill /T /F`,
but your app must still close the service itself:

```js
app.on('before-quit', async (event) => {
  if (!client.running || app.isQuiting) return;
  event.preventDefault();                 // let the child close first
  app.isQuiting = true;
  await client.stop({ timeoutMs: 2000 }); // sends shutdown, then ends stdin
  app.quit();
});
```

Closing stdin is the half that works. The service exits on EOF and kills its
own Python helper on the way out. Calling `kill()` alone does the opposite of
what you want here: it terminates the service before any of that runs, and the
helper survives. If you need a force-quit fallback, end stdin first, then kill.

**3. The console window.** Always pass `windowsHide: true`, or every spawn
flashes a black window in front of your user.

### Shipping Python

Bundling a Python runtime is the difference between an installer that works and
a support queue. Two options.

- **Embeddable Python.** Download the Windows embeddable package, unzip it into
  `resources/bodyscale/python/`, `pip install bleak` into it. About 25 MB. The
  service looks for `python\python.exe` there automatically.
- **Require system Python.** Smaller download, but you own the failure when the
  user has none. If you take this path, handle `TRANSPORT_FAILED` with a link
  to python.org.

Either way, `BODYSCALE_PYTHON` lets you point at an interpreter explicitly:

```js
spawn(process.execPath, [scaleJs, '--serve'], {
  env: { ...process.env, BODYSCALE_PYTHON: path.join(scaleDir, 'python', 'python.exe') },
  windowsHide: true,
});
```

### Node inside Electron

Electron's own binary is a Node runtime, so you do not need Node installed
separately. Spawn `process.execPath` with `ELECTRON_RUN_AS_NODE`:

```js
spawn(process.execPath, [scaleJs, '--serve'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true,
});
```

This is the recommended way to ship. One less dependency on the user's machine.

---

## 8. Windows troubleshooting

Each row is a symptom you can read off the wire, a command that confirms it, and
the fix. Work down the list; they are ordered by how often they bite.

**1. Python resolves to the Microsoft Store placeholder.**
*Symptom:* `TRANSPORT_FAILED` naming the Store placeholder. Before the self-test
existed this showed as `NO_READING` in well under a second.
*Confirm:* `where.exe python` — if the first hit is under
`…\AppData\Local\Microsoft\WindowsApps\`, it is the stub.
*Fix:* install Python from python.org, run `setup-win.ps1`, or ship a bundled
runtime. Setting `BODYSCALE_PYTHON` to a real interpreter also works.

**2. The desktop-app Bluetooth privacy setting is off.**
*Symptom:* `PERMISSION_DENIED` on the first scan, with `Access is denied` or
`0x80070005` on the log channel. Windows shows no prompt; it refuses silently.
*Confirm:* `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\bluetoothSync' -Name Value`
— anything other than `Allow`.
*Fix:* Settings → Privacy & security → Bluetooth devices. `shell.openExternal('ms-settings:privacy-bluetooth')` takes them there.

**3. The radio is switched off.**
*Symptom:* `BLUETOOTH_UNAVAILABLE`, with `Element not found` or `The device is
not ready` on the log channel. This is deliberately a different code from #2, so
you never send someone to a toggle that is already on.
*Confirm:* `Get-PnpDevice -Class Bluetooth | Select-Object Status,FriendlyName`
— a `Status` of `Unknown` or `Error` is the radio, not the permission.
*Fix:* turn Bluetooth on.

**4. A third-party Bluetooth stack.**
*Symptom:* `DEVICE_NOT_FOUND` every time, other BLE apps see nothing either, but
the dongle works for audio.
*Confirm:* `Get-CimInstance Win32_PnPEntity | Where-Object { $_.Service -eq 'BthLEEnum' }`
returns nothing — WinRT has no LE enumerator, so bleak cannot see anything
regardless of what Device Manager shows.
*Fix:* uninstall the vendor stack and let Windows use its own driver.

**5. An orphaned helper is holding the radio.**
*Symptom:* it worked once, then every launch reports `DEVICE_NOT_FOUND` until a
reboot.
*Confirm:* after the app has quit, `Get-Process python -ErrorAction SilentlyContinue`.
*Fix:* `Stop-Process -Force`. This is what the `before-quit` handler prevents;
it is normally only reachable by killing the app from Task Manager, which no
handler can catch.

**6. A `.venv` copied from the build machine.**
*Symptom:* on the log channel, `ignoring …\.venv\Scripts\python.exe: its
virtual environment was built on another machine`, then symptom #1.
*Confirm:* `Get-Content resources\bodyscale\.venv\pyvenv.cfg` — its `home =`
path does not exist on this machine.
*Fix:* drop `.venv/**` from `extraResources` and ship an embedded runtime instead.

**7. Antivirus quarantined a frozen transport.**
*Symptom:* it worked at install, then `TRANSPORT_FAILED` with ENOENT, and the
file is gone.
*Confirm:* Windows Security → Protection history.
*Fix:* if you freeze the helper with PyInstaller, build with `--onedir` rather
than `--onefile`, and pass `--noupx`. A single self-extracting executable and UPX
compression are both heuristics that trip scanners, and neither buys anything
when the payload already ships inside a compressed installer. Signing helps most.

**8. The scale is simply asleep.**
*Symptom:* `DEVICE_NOT_FOUND` after a full scan, no `found` progress event, and
it works on the second try.
*This is not a bug.* The radio sleeps within seconds of going idle. Design the
flow so the user steps on the scale first, then presses the button.

## 9. macOS

The service runs on macOS unchanged, with one constraint that cannot be
engineered away. macOS attributes Bluetooth permission to the *responsible*
process — the application at the root of the process tree, not the process
making the call. A Python helper spawned by a terminal inherits that terminal's
grant.

The practical consequence: **run it from Terminal.app or from your packaged
`.app`, not from inside another tool's embedded shell.** An embedded shell makes
the host application responsible, and if that application has no Bluetooth
grant the helper is killed by the OS with `Abort trap: 6` before any code runs.
The service detects this and reports `PERMISSION_DENIED`.

For a packaged Electron app on macOS, add to `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Connects to your body scale to read your weight.</string>
```

---

## 10. Developing with no hardware

```
node scale.js --serve --replay fixtures/ssw533-session.jsonl
```

Replays a real recorded SSW533 session: the same advertisement, the same live
weight frames, the same final record. Every event your app will see in
production arrives in the same order and at the same rate. Build and test your
whole UI against this, then switch to the radio by dropping the flag.

The recorded session settles at 97.9 kg with 529.9 Ω.

---

## 11. Reference: a complete session

Sent by the app, received by the app, in order:

```
← {"proto":1,"type":"hello","app":"bodyscale","version":"1.0.0","platform":"win32",...}
→ {"id":"m1","cmd":"measure","profile":{"age":39,"heightCm":180,"sex":"male"}}
← {"proto":1,"type":"accepted","id":"m1","profile":{"sex":"male","age":39,"heightCm":180}}
← {"proto":1,"type":"progress","id":"m1","phase":"scanning","message":"scanning for SSW533"}
← {"proto":1,"type":"progress","id":"m1","phase":"connected","message":"connected to SSW533"}
← {"proto":1,"type":"progress","id":"m1","phase":"ready","message":"stand on the scale"}
← {"proto":1,"type":"progress","id":"m1","phase":"settling","weightKg":69.25}
← {"proto":1,"type":"progress","id":"m1","phase":"settling","weightKg":97.95}
← {"proto":1,"type":"progress","id":"m1","phase":"settling","weightKg":97.9}
← {"proto":1,"type":"measurement","id":"m1","ok":true,"measured":{"weightKg":97.9,"impedanceOhm":529.9},...}
→ {"id":"q","cmd":"shutdown"}
← {"proto":1,"type":"bye","id":"q"}
```

A working Electron implementation of exactly this is in
[`electron-example/`](electron-example/).

### `scaleProfile` — who the scale is told it is measuring

A deferred `measure` (`withoutProfile: true`) may also carry `scaleProfile`:

```json
{ "cmd": "measure", "withoutProfile": true,
  "scaleProfile": { "sex": "male", "age": 39, "heightCm": 180 } }
```

This is **not** the profile the results are computed from, and it does not
change what comes back: `derived` is still `{}` and `profileDeferred` is still
`true`. It is written to the scale during the handshake and used for nothing
else — never stored, never echoed, never fed to the body-composition maths.

It exists because an 8-electrode scale is not a passive sensor. It decides
whether to run its impedance sweep, and what current to drive through the body,
from the identity it is given *before* anyone stands on it. Without one the
driver has to send a stand-in — 170 cm, 30 years old, male — and a scale asked
to measure body composition for a person who does not exist may reasonably
report weight alone.

So the host still owns this data and still supplies it. `scaleProfile` only
lets it supply it early enough for the scale to act on, while the profile that
drives the numbers stays deferred and editable afterwards.

Validation is the same as `profile`; a malformed one is refused with
`INVALID_PROFILE` rather than quietly replaced by the stand-in.
