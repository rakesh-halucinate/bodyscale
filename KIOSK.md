# Kiosk integration

How the body-scale service and an Electron kiosk talk to each other, from the
idle screen to the printed body report.

`API.md` is the field reference: every message, every key, every error code.
This document is the *flow* — what happens in what order, who owns which input,
and which of those decisions were measured rather than assumed.

---

## 1. What each process owns

Three inputs arrive from three places and meet only at the final step.

| Input | Owner | Notes |
|---|---|---|
| Weight and impedance | **This service** | Over Bluetooth. Pushed as events; never polled. |
| Height | **Electron** | From the laser sensor on its COM port. The service never sees it. |
| Name, sex, age | **Electron** | Collected at the payment screen, after the person steps off. |
| The body report | **This service** | One `compute` call with the held reading plus those details. |

**Name never reaches the service.** There is no field for it in the protocol,
so it cannot end up in a log here. It is the app's to store.

---

## 2. One session, start to finish

The service is already running and already connected before stage 1. The kiosk
sits on its idle screen.

### Stage 1 — arm the service

The scale must already be paired; see §2a. At kiosk startup, and again after every completed reading, send one `measure`
with `withoutProfile: true`. It resolves only when somebody has been measured,
so it doubles as a standing "watch for a person".

```json
{ "id": "watch-1", "cmd": "measure", "withoutProfile": true,
  "scanTimeoutSec": 90, "timeoutSec": 600, "impedanceWaitSec": 30 }
```

No `scaleProfile`. The service supplies its own synthetic placeholder — **male,
25, 170 cm**, which is nobody — and that is all the scale needs. Send one only
if you want the scale's own display to be right for the person in front of it;
see §5.

You receive `accepted`. The app shows **"Touch here to continue"**. If
`accepted` never arrives, the scale is unreachable and the idle screen should
say so quietly rather than invite a touch.

### Stage 2 — somebody steps on

```
progress  phase: occupied   weightKg: 71.2      <- fires ONCE
progress  phase: settling   weightKg: 88.4
progress  phase: settling   weightKg: 96.1
```

`occupied` is the signal to change screen. Then a live weight roughly once a
second as the reading climbs.

**Read the height sensor here.** The person is standing still and facing
forward, which is the best moment you will get.

App shows: **"Stand straight and stay still."**

### Stage 3 — the scale runs its sweep

```
progress  phase: measuring  weightKg: 97.25  sweepState: 3
hint      code: STAY_ON_SCALE
```

The weight has locked and the scale has started its impedance program. Its own
display shows `P-1` for about ten seconds. The link is held open throughout.

App shows: **"Hold still. Keep both hands on the handle."**

This screen is not decoration. The circuit runs hand to foot, and letting go at
nine seconds returns a reading with every impedance slot empty.

### Stage 4 — the reading lands

The radio window closes, the link drops, and one `measurement` arrives:

```json
{ "type": "measurement", "id": "watch-1", "profileDeferred": true,
  "timestamp": "2026-09-07T10:32:50.660Z",
  "device": { "name": "SSW533", "address": "…" },
  "measured": {
    "weightKg": 97.25,
    "impedanceOhm": 506.1,
    "impedances": [24, 281.5, 294.2, 267.7, 276.4,
                   21.1, 249.7, 260.7, 235.3, 246]
  },
  "derived": {}, "warnings": [ … ] }
```

**Store the whole `measured` object against the session**, including all ten
raw slots. Show "done — step off". Re-arm with a fresh `measure` so the next
person is caught.

Nothing is computed yet and nothing should be displayed as a result.

Why store all ten: they are two segmental groups of five — a trunk value near
25 Ω followed by four limbs near 300 Ω. The single whole-body figure is derived
from the second group, and that derivation is inferred from the magnitudes
rather than read out of the vendor's code. If it is ever corrected, a stored
reading can be recomputed rather than retaken.

### Stage 5 — the person identifies themselves

The service is idle and already armed for the next person. Payment, then name,
sex and age. Height is already held from the laser sensor.

Minutes may pass. The reading does not expire and does not drift.

### Stage 6 — the report

```json
{ "id": "report-1", "cmd": "compute",
  "measured": { /* stored verbatim, including impedances */ },
  "measuredAt": "2026-09-07T10:32:50.660Z",
  "profile": { "sex": "male", "heightCm": 180, "age": 39 } }
```

Pure arithmetic. No Bluetooth, no waiting, and safe to call again if a detail
was mistyped.

---

## 2a. Pairing the scale, once, from an admin screen

A kiosk cannot ask a customer which Bluetooth device to use. The scale is
chosen once by whoever installs it and remembered from then on.

```json
→ { "id": "s1", "cmd": "scan", "seconds": 8 }
← { "type": "devices", "devices": [
      { "address": "BEECC6EC-…", "name": "SSW533", "rssi": -52,
        "supported": true, "model": "Dr Trust SSW532" },
      { "address": "D4:43:8A:…", "name": "Mijia Scale S800", "rssi": -74,
        "supported": false, "model": null } ] }

→ { "id": "p1", "cmd": "pair", "address": "BEECC6EC-…", "name": "SSW533" }
← { "type": "paired", "device": { "name": "SSW533", "address": "BEECC6EC-…" } }
```

`scan` connects to nothing and is safe while the kiosk is idle. It is refused
with `BUSY` if a measurement is running — both want the radio.

**Four things the admin screen should say or do:**

- **Sort by signal.** The list already arrives strongest first. The scale is
  usually the thing the operator is standing next to.
- **Show unsupported devices too.** `supported` marks what the database
  recognises, but a scale advertising under an unfamiliar name is exactly the
  case somebody is installing. Hiding it makes the screen useless for its one
  job.
- **Say that a sleeping scale does not appear.** Its radio sleeps when idle and
  it advertises in short bursts on waking. "Tap the plate and scan again" saves
  a support call.
- **Offer re-pair and forget.** `pair` again replaces the device; `forget`
  drops it and the next measurement scans by name.

The address is a CoreBluetooth UUID on macOS and a MAC address on Windows, and
on macOS it is per-machine — pairing does not transfer between Macs. Once
paired, `hello` reports it at startup as `device.remembered`, and every
measurement connects straight to it without a name scan.

---

## 3. Events

Full table in `API.md` §3. The two that exist specifically for this flow:

| Phase | Fires | Carries | Kiosk does |
|---|---|---|---|
| `occupied` | **Once**, first real weight | `weightKg` | **Change screen.** Read the height sensor. |
| `measuring` | Sweep started (`P-1`) | `weightKg`, `sweepState` | **"Hold still, both hands on the handle."** |

Both are derivable from the stream around them. They exist because deriving
them is fiddly and getting them wrong is expensive.

Treat an unknown `phase` as "still working" rather than falling through to a
blank screen.

### Hints

A `hint` carries a `code` and a `message` already phrased for a screen. Show
the message; branch on the code.

| Code | Means | Response |
|---|---|---|
| `WAKE_THE_SCALE` | Nothing found; its radio sleeps when idle | "Step on the scale to wake it." |
| `STEP_OFF_AND_ON` | Connected but no weight arriving | "Step off and back on again." |
| `HOLD_STILL` | Weight moving too much to lock | "Stand still." |
| `STAY_ON_SCALE` | Weight locked, sweep running | "Stay on — measuring body composition." |
| `SECOND_PROGRAM` | Optional second program | Only if `secondProgramWaitSec` is set. Off by default. |

---

## 4. What the profile actually changes

Measured on one real reading, holding everything else fixed.

| Field | Required | Moves body fat | If wrong |
|---|---|---|---|
| `sex` | **Yes** | **12.3 %** | Corrupts the whole panel. A term inside the equation, not a correction after it. Never default it. |
| `heightCm` | **Yes** | 4.7 % per 5 cm | Enters as height² ÷ impedance. A 5 cm slip is a 2-point body-fat error. |
| `age` | Optional | **0.0 %** | Nothing in the composition panel moves. |
| `name` | Never sent | — | No field exists. |

**Omitting `age` costs a safety net, not just two numbers.** `crossCheck`
becomes `null` and the fatal rule T3 cannot fire. That check compares the
impedance figure against a BMI-based one, and the BMI method takes age as a
term worth 16 % across an adult range — run against a guessed age it would
reject good readings and pass bad ones. A warning says the second opinion is
missing. Collect an age if the flow allows it.

What omitting it withholds, each named in `omitted` with its reason:
`bmrKcal`, `bmrAlternatesKcal`, `skeletalMuscleMassKg`, `skeletalMusclePercent`,
`skeletalMuscleIndex`, `bodyFatPercentBmiAnchor`, `bodyFatGapPoints`.

---

## 5. The handshake identity does not affect the measurement

`scaleProfile` is written to the scale before anyone stands on it, and it is
tempting to assume the sweep depends on it. It does not.

Two readings of the same person, back to back — the first telling the scale the
truth, the second telling it a 70-year-old, 140 cm woman was standing there:

```
told the truth   97.55 kg   609.2 Ω   26.7, 327.2, 333.3, 322.7, 345.3, …
told a lie       97.55 kg   604.6 Ω   26.6, 325.8, 333.3, 320.3, 345.5, …
```

Identical to the gram, 0.8 % apart on impedance — a tenth of the drift between
two honest readings hours apart.

So the kiosk needs no personal data before a measurement. Omit `scaleProfile`
entirely and the service sends its own — `male, 25, 170 cm`, deliberately
synthetic and deliberately nobody's. Collect the real details afterwards.

An earlier draft of this document used a real person's height and age as the
example placeholder. That is the kind of value that gets copied into a shipped
product and then quietly describes every customer who stands on the scale.

**The one reason to send a real profile** is if the person will also read the
scale's own screen, or if the vendor's phone app is syncing: both compute their
displayed numbers from whatever they were given. That is why the vendor app
once showed BMI 41 for a 175 cm person — it had 180 stored.

What the scale *does* require is a well-formed frame with the impedance bit
set. That is the driver's job and is not optional; it is the contents that are
free.

---

## 6. Failure, and two things that are not failure

Every failure is a typed `error` with a `code`. The kiosk should never be left
on a spinner.

| Code | Cause | Recovery |
|---|---|---|
| `DEVICE_NOT_FOUND` | Scale did not answer the scan | Re-arm. Its radio sleeps; a step on the plate wakes it. |
| `NO_READING` | Connected, nobody stood on it | Re-arm. Normal after a timeout. |
| `BLUETOOTH_UNAVAILABLE` | Adapter off or missing | Out-of-service screen. Re-arming will not help. |
| `PERMISSION_DENIED` | OS refused Bluetooth | Needs an operator. Deliberately distinct from the above. |
| `TRANSPORT_FAILED` | Helper process died | Restart the service, then re-arm. |
| `BUSY` | A measure is already running | A bug in the app: only one may be armed. Do not retry blindly. |
| `INVALID_PROFILE` | Bad sex or height, or an impossible age | The message names the field. The reading is unaffected. |
| `CANCELLED` | The app sent `cancel` | Expected. Re-arm when ready. |

### Weight but no impedance

`impedanceOhm` is `null` and the sweep did not complete — almost always a hand
off the handle. **This is not an error.** The reading is still valid for weight
and BMI, and `derived` carries nine keys instead of twenty-four. Offer to
measure again rather than discarding it.

### A repeated reading

If the same bytes arrive twice, a warning says the scale replayed a stored
record instead of measuring. Show it as a retake, not a result. The scale
uploads whatever it has stored when the record channel opens; the driver
refuses those, but a genuine duplicate is still worth surfacing.

---

## 7. Running it under Electron

Spawn `scale.js --serve` from the **main** process with
`ELECTRON_RUN_AS_NODE=1`. Keep it in `asarUnpack` — the Python helper must
exist as a real file on disk, not inside an archive. On Windows, kill the tree
with `taskkill /T /F`; the helper does not die with its parent.

One line in, one line out, both newline-delimited JSON. `stdout` is the
protocol and carries nothing else. `stderr` is human diagnostics and is safe to
log.

- **Start once** with the kiosk, not per measurement. Startup includes a
  Bluetooth scan.
- **Always keep one armed.** Re-arm inside the handler for `measurement` *and*
  for every `error`.
- **Never two at once.** The second gets `BUSY`.
- **Hold the reading in the main process**, not the renderer. A renderer reload
  must not lose a paid-for measurement.

`electron-example/` is a working main process, preload and client. Windows
setup is `setup-win.ps1`.

---

## 8. What is not computed, and why

These appear on the vendor's own app and are deliberately absent. Each is
listed in `omitted` with its reason, so a missing value can be told apart from
a bug.

- **Skeletal muscle** — across three app readings its ratio to lean mass drifts
  monotonically with a physically impossible implied slope, so it is computed
  from impedance directly and not from anything we hold. `derived` does carry a
  `skeletalMuscleMassKg` from Janssen 2000, which is published and reads about
  6 kg lower than the vendor's.
- **Metabolic age** — both published conventions failed checking.
- **Subcutaneous fat** — the convention circulating in scale SDKs has no source
  and its own worked examples are arithmetically inconsistent.
- **Body score** — no stable definition.

**Visceral fat *is* computed**, in `vendorMatch.visceralFatRating`. It was
extracted from the vendor's own binary and verified by executing that binary
against 12,939 randomised inputs with no mismatch. **It is a rating from 1 to
20, not a percentage** — a scale showing "17" means level 17, and the clamp at
20 is a ceiling rather than a measured maximum.

`vendorMatch` reproduces the vendor app's conventions and lands within 2.0 % of
it on every metric it reports. `values` uses the clinical equations. Both are
computed; which one a kiosk shows is a product decision, and showing the vendor
column is what makes the printout agree with the phone in the customer's hand.
