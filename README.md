# Bluetooth body scale reader

Reads weight and impedance from a Bluetooth LE body scale and prints JSON, so the
values can be fed straight into another application.

Two front ends over the same tested decoders:

- **`scale.js`**, a terminal tool. No browser, no device chooser, JSON on stdout.
  This is the one to use for integration.
- **`index.html`**, a browser page, kept because it is useful for protocol work.

Verified against a Dr Trust SSW533. The scale sends exactly two numbers, weight
and one impedance value. Everything else on the panel is computed here, and every
figure is labelled with how much it is worth.

## Terminal tool

This is the one to use for feeding another app. No browser, so no device chooser,
and the output is JSON on stdout.

```bash
cd /path/to/bodyscale
./setup-mac.sh          # once
```

Then, **from Terminal** or by double-clicking `run.command`:

```bash
node scale.js --sex male --age 39 --height 180
```

Your details are remembered after the first run, so later runs are just:

```bash
node scale.js
```

| Flag | Effect |
|---|---|
| `--quiet` | one line of JSON on stdout, nothing else, for piping |
| `--watch` | loop: keep measuring until Ctrl+C |
| `--raw` | also print every decoded frame |
| `--replay` | decode a recorded session, no Bluetooth at all |
| `--forget` | drop the saved device and rescan by name |
| `--name` | device name, default SSW533 |

## Testing it repeatedly

Double-clicking `run.command` loops by default, so you can weigh yourself over and
over without restarting anything. Step on for a reading, step off, step on again
for the next one.

```bash
node scale.js --watch
```

| Flag | Effect |
|---|---|
| `--interval <s>` | pause between attempts, default 3 |
| `--max <n>` | stop after n measurements |
| `--max-attempts <n>` | stop after n tries, whatever they produced |
| `--repeats` | report a held reading again instead of skipping it |

The scale keeps repeating its last locked reading until someone stands on it
again, so an identical weight and impedance pair is the previous measurement
rather than a new one. The loop recognises that and says so instead of emitting
the same numbers twice. `--repeats` turns that off.

## Attaching without a delay

The transport runs one scan that matches on address **or** name and connects the
moment either hits. Trying the address first and only then falling back to a name
scan wastes a whole advertising burst, and this scale advertises in short bursts
when it wakes.

Scanning also stops before the connect attempt begins, because an active scan
keeps the radio busy and competes with the connection. The log reports both
timings, so a delay is visible rather than guessed at:

```
advertisement from SSW533 after 340 ms (matched by address, rssi -52)
connected in 180 ms
```

Piping into another app:

```bash
node scale.js --quiet 2>/dev/null | your-app
```

The payload carries `measured` with the two numbers the scale actually sent,
`derived` with everything computed from them, plus `units`, `confidence`, `trust`,
`flags` and `warnings` so the receiving app can decide what to believe.

## It must be run from Terminal, and here is why

macOS attributes a Bluetooth request to the **responsible application** for the
process tree, not to the process making the request. From Terminal that is
Terminal, and macOS shows a normal permission prompt the first time.

Launched from inside another app, the request is attributed to that app. If that
app has no Bluetooth entitlement, macOS does not return an error. It kills the
process with `Abort trap: 6` and writes a crash report reading:

```
Termination Reason: Namespace TCC
This app has crashed because it attempted to access privacy-sensitive data
without a usage description.
```

That is why the tool exists as `run.command`. `scale.js` recognises this exact
signal and prints an explanation instead of leaving you with an abort trap.

`setup-mac.sh` also handles a second layer of the same rule. A framework Python
runs from its own `Python.app`, whose `Info.plist` declares no Bluetooth usage,
so the setup script adds the key and re-signs the bundle. It is idempotent, and
worth re-running after `brew upgrade python@3.11` replaces that bundle.

## Proving it without hardware

The BLE transport and the decoding are separate processes talking newline JSON,
so the whole decode and reporting path can be replayed from a recorded session:

```bash
node scale.js --replay fixtures/ssw533-session.jsonl --sex male --age 39 --height 180
```

That fixture is a genuine capture. Replaying it reproduces the measurement the
hardware gave:

| Value | Result |
|---|---|
| Weight | 97.9 kg |
| Impedance | 529.9 ohm |
| Body fat | 36 %, from impedance, passing its checks |

```bash
node --test 'test/*.test.js'
```

193 tests, no dependencies beyond bleak for the transport. Nineteen drive the CLI
end to end through that fixture, including loop mode and duplicate suppression.
Another sixty-five drive the JSON service, its Electron client and the Electron main
process itself over a real pipe, so the whole integration path is covered
without a scale, a radio, or Electron installed.

## Using it from another app

`scale.js --serve` runs as a long-lived service speaking newline-delimited JSON
over stdin and stdout. Your app spawns it once, sends `measure`, and receives
live weight followed by a full result.

```bash
node scale.js --serve
```

```
← {"proto":1,"type":"hello","app":"bodyscale","version":"1.0.0","platform":"win32",...}
→ {"id":"m1","cmd":"measure","profile":{"age":39,"heightCm":180,"sex":"male"}}
← {"proto":1,"type":"accepted","id":"m1",...}
← {"proto":1,"type":"progress","id":"m1","phase":"ready","message":"stand on the scale"}
← {"proto":1,"type":"progress","id":"m1","phase":"settling","weightKg":97.95}
← {"proto":1,"type":"measurement","id":"m1","ok":true,"measured":{"weightKg":97.9,"impedanceOhm":529.9},...}
```

The division of labour is fixed. Your app supplies three facts about the person,
`age`, `heightCm` and `sex`. This service supplies the connection, the weight,
the impedance and all twenty-four derived body metrics.

- **[`API.md`](API.md)** is the full contract: every command, every event, every
  error code, the meaning and unit of each derived value, and the Windows and
  macOS platform notes.
- **[`electron-example/`](electron-example/)** is a working Electron app.
  `bodyscale-client.js` there is a drop-in wrapper that turns the protocol into
  promises and events.

Develop against the recorded session and you need no hardware at all:

```bash
node scale.js --serve --replay fixtures/ssw533-session.jsonl
```

## Windows

The service runs on Windows through the same Python transport, which uses WinRT
there instead of CoreBluetooth. Set it up once:

```powershell
powershell -ExecutionPolicy Bypass -File setup-win.ps1
```

Add `-Embed` to also download a private Python runtime to ship with your app.

Three Windows details decide whether a packaged build works, and all three are
covered in [`API.md`](API.md): the scale directory must sit outside `app.asar`,
the Python helper is a grandchild that `child.kill()` does not reach, and every
spawn needs `windowsHide: true`. Bluetooth identifiers also differ per platform,
so the remembered address is stored under `address_win32` rather than
`address_darwin`, and is never portable between machines.

## Files

| File | Role |
|---|---|
| `scale.js` | the CLI: spawns the transport, decodes, prints JSON |
| `ble.py` | BLE transport, bleak, emits JSON lines |
| `replay.js` | stands in for the transport, replays a recording |
| `setup-mac.sh` | builds the Bluetooth host bundle, adds the usage description |
| `run.command` | double-click to measure, from Terminal so permission works |
| `bcs.js` | Bluetooth SIG standard parsers |
| `drivers.js` | per-scale connection drivers, including the Dr Trust protocol |
| `scales-db.js` | device database, 60+ models mapped to protocol families |
| `bia.js` | body composition from weight and impedance |
| `index.html` | the browser version, still works, needs the Chrome flags |
| `API.md` | the JSON service contract, for porting and integration |
| `electron-example/` | a working Electron app plus a reusable client |
| `setup-win.ps1` | Windows setup: virtualenv, bleak, permission check |

## Browser version

Still present and still works. It needs two Chrome flags to avoid the device
chooser, which the terminal tool does not need at all:

```
chrome://flags/#enable-experimental-web-platform-features
chrome://flags/#enable-web-bluetooth-new-permissions-backend
```

`start.command` serves it at `http://localhost:8777`, because Chrome attaches a
Bluetooth permission to an origin and a `file://` page has none that persists.

## How much each number is worth

A hundred verification agents checked every formula against its primary source. That pass changed
the implementation in three ways worth knowing about.

**Kyle 2001 was removed.** It is the lowest-error fat-free-mass equation published, and the first
version of this code used it. It also requires *reactance*, which this scale never transmits.
Synthesising one moves the answer by about five percentage points of body fat, so the equation is
gone and the omission is documented.

**One impedance equation, not five.** Total body water from Sun 2003 is now the only place
impedance enters. Fat-free mass, fat mass, body fat, muscle and protein are algebraic consequences
of it. That means those six numbers carry exactly one bit of impedance information between them, so
no check comparing two of them has any power. The checks that survived compare impedance-derived
values against impedance-free ones, which is the only comparison that can fail informatively.

**Metabolic rate is now Mifflin-St Jeor.** It uses no impedance, which is precisely why it is the
default on this hardware. Katch-McArdle is theoretically better and is shown, but it depends on
lean mass and so inherits the same doubt.

Four metrics that consumer scales display are deliberately absent, each with its reason on the
panel. Visceral fat rating is the clearest case: a foot-to-foot current path runs leg to pelvis to
leg and largely bypasses the abdominal viscera, so every vendor number for it is a function of
weight, height, age and sex, containing no impedance information at all.

## Why a body fat figure sometimes carries a warning

The panel computes body fat twice and compares them. The threshold is derived, not invented:
Deurenberg has a standard error of 4.1 points, and the Sun water equation contributes about 5.3
points at this body weight, giving 6.7 points combined. Warn at one standard error, refuse at two.

| Reading | Impedance | BMI method | Gap | Verdict |
|---|---|---|---|---|
| Poor foot contact | 8.9 % | 29.3 % | 20.3 | refused, falls back to the BMI figure |
| A good measurement | 36.0 % | 29.0 % | 6.9 | accepted, with a note |

A second check catches the same failure without using any body fat equation: fat-free mass index
has a drug-free ceiling near 25 for men. The bad reading gives 27.7. Two structurally independent
checks agreeing is what makes the verdict trustworthy.

When either fires, the impedance half of the panel is dimmed and labelled, the BMI figure is
promoted, and the weight and BMI rows are untouched because they never involved impedance.

## Advanced

Collapsed by default, because you do not need it for a measurement.

- **Live monitor mode** holds the link open and reconnects whenever it drops. This is the old
  behaviour, kept for protocol work.
- **Timeouts** for the connect window, the measurement window, the retry gap and individual GATT
  calls.
- **Extra service UUIDs** for a scale whose vendor service is not in the database. Web Bluetooth
  hides any service you did not ask for.
- **Standard BCS spec version**, 1.0 or 1.0.1. It changes labels only, for the reason below.
- **User Data Service** buttons for standard scales that need a consent handshake.
- **Raw write** for poking an unknown scale by hand.
- **Full log** of every frame in hex, with repeats collapsed, plus a JSON export.
- **Parser test** that decodes any hex string you paste, with sample packets.

## Licensing and credit

The device database and the vendor protocol details were researched from
[openScale](https://github.com/oliexdev/openScale) by olie.xdev and contributors, which has done
the reverse engineering the whole ecosystem depends on.

**openScale is GPL-3.0 and none of its source code is copied into this project.** Copying it would
place this project under GPL-3.0 too. What is reproduced is factual interface data: UUID numbers,
advertised device names, frame offsets and checksum rules. Every decoder here is independently
written JavaScript. If you would rather use openScale's actual implementations, license this
project under GPL-3.0 and port them deliberately.

The BIA equations in `bia.js` are from published literature: Kyle et al. 2001 for fat-free mass,
Kushner and Schoeller 1986 for total body water, Janssen et al. 2000 for skeletal muscle mass, and
Cunningham 1980 for basal metabolic rate.

## BCS 1.0 vs 1.0.1

Both specification pages were downloaded and diffed. Ignoring legal boilerplate, v1.0.1 (adopted
2024-06-11, errata 16256, 16257, 18743, 18955, 23312, 22309) changes only three things:

1. Body Composition Feature gains an optional Indicate property, required when the device supports
   bonding and the feature value can change over its lifetime.
2. The Core Specification requirement moves from 4.0 to 4.2.
3. The BR/EDR SDP record drops the GATT start and end handle parameters.

The flags field, every measurement field, all units and resolutions, the 0xFFFF measurement
unsuccessful value, the 0xFF unknown user value and the multiple-packet rules are unchanged.
A 1.0 packet and a 1.0.1 packet are byte-for-byte identical, which is why the version selector
cannot change any decoded number.
