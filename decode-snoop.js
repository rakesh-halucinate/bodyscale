#!/usr/bin/env node
'use strict';
/*
 * decode-snoop.js — pull the scale conversation out of an Android HCI snoop log.
 *
 * WHY THIS EXISTS
 *
 * The phone app makes this scale run its impedance program and we cannot. We
 * have matched its handshake byte for byte against the openScale SSW532
 * handler, matched its subscription order, and stopped hanging up early. The
 * scale still sends weight only. So the app is doing something we have not
 * found by reading other people's code, and the way to find it is to watch it.
 *
 * Android records every HCI packet to a file when "Bluetooth HCI snoop log" is
 * enabled in Developer options. This reads that file and prints the ATT writes
 * and notifications for the scale, in order, with timing — which is exactly the
 * list of things the app does that we do not.
 *
 *   node decode-snoop.js btsnoop_hci.log
 *   node decode-snoop.js btsnoop_hci.log --all      every handle, not just ours
 *
 * The format is btsnoop v1: a 16-byte file header, then per packet a 24-byte
 * record header (big-endian) followed by the packet itself.
 */
const fs = require('fs');

const file = process.argv[2];
const ALL = process.argv.includes('--all');
if (!file) {
  process.stderr.write(`
  usage: node decode-snoop.js <btsnoop_hci.log> [--all]

  To capture one on Android:
    1. Settings, About phone, tap Build number seven times.
    2. Settings, System, Developer options.
    3. Turn ON "Enable Bluetooth HCI snoop log". Some phones need
       Bluetooth toggled off and on, or a reboot, before it takes effect.
    4. Open the scale's app and take ONE complete measurement, standing on
       the scale and holding the handle until the app shows body composition.
    5. Settings, System, Developer options, "Bug report" — or pull the file
       directly with adb:
         adb bugreport bug.zip        then look inside for btsnoop_hci.log
         adb pull /sdcard/btsnoop_hci.log
       The path varies: /data/misc/bluetooth/logs/btsnoop_hci.log on many
       builds, /sdcard/btsnoop_hci.log on others.
    6. Turn the snoop log OFF again afterwards. It records everything
       Bluetooth on the phone, so do not leave it running and do not share
       a capture containing anything else you mind being read.

`);
  process.exit(2);
}

const buf = fs.readFileSync(file);
if (buf.length < 16 || buf.toString('latin1', 0, 8) !== 'btsnoop\0') {
  process.stderr.write(`\n  ${file} is not a btsnoop file.\n`
    + '  If you have a bug report zip, the log is inside it, often under\n'
    + '  FS/data/misc/bluetooth/logs/.\n\n');
  process.exit(2);
}

/* ------------------------------------------------------------------ parsing */

const packets = [];
let off = 16;
while (off + 24 <= buf.length) {
  const origLen = buf.readUInt32BE(off);
  const inclLen = buf.readUInt32BE(off + 4);
  const flags = buf.readUInt32BE(off + 8);
  // Timestamp is microseconds since year 0 in btsnoop; only deltas matter here.
  const tsHi = buf.readUInt32BE(off + 16);
  const tsLo = buf.readUInt32BE(off + 20);
  const us = tsHi * 4294967296 + tsLo;
  const start = off + 24;
  if (inclLen === 0 || start + inclLen > buf.length) break;
  packets.push({ data: buf.subarray(start, start + inclLen), flags, us, origLen });
  off = start + inclLen;
}

/*
 * ATT lives inside L2CAP inside an HCI ACL packet.
 *
 *   HCI ACL   [0]=0x02 type, [1..2]=handle+flags, [3..4]=length
 *   L2CAP     [0..1]=length, [2..3]=CID. ATT is CID 0x0004.
 *   ATT       [0]=opcode, then opcode-specific.
 *
 * Only the opcodes that carry payload to or from a characteristic matter:
 *   0x12 write request      handle + value
 *   0x52 write command      handle + value
 *   0x1B notification       handle + value
 *   0x1D indication         handle + value
 *   0x0A read request       handle
 *   0x0B read response      value
 */
const OPCODES = {
  0x12: 'WRITE_REQ', 0x52: 'WRITE_CMD', 0x1b: 'NOTIFY', 0x1d: 'INDICATE',
  0x0a: 'READ_REQ', 0x0b: 'READ_RSP', 0x13: 'WRITE_RSP', 0x1e: 'CONFIRM',
};

const events = [];
for (const p of packets) {
  const d = p.data;
  if (d.length < 9 || d[0] !== 0x02) continue;            // HCI ACL only
  const l2capLen = d.readUInt16LE(5);
  const cid = d.readUInt16LE(7);
  if (cid !== 0x0004) continue;                            // ATT only
  const att = d.subarray(9, 9 + l2capLen);
  if (!att.length) continue;
  const op = att[0];
  const name = OPCODES[op];
  if (!name) continue;
  const sent = (p.flags & 0x01) === 0;                     // direction bit
  let handle = null;
  let value = Buffer.alloc(0);
  if (op === 0x12 || op === 0x52 || op === 0x1b || op === 0x1d) {
    if (att.length < 3) continue;
    handle = att.readUInt16LE(1);
    value = att.subarray(3);
  } else if (op === 0x0a) {
    handle = att.readUInt16LE(1);
  } else if (op === 0x0b) {
    value = att.subarray(1);
  }
  events.push({ us: p.us, op: name, sent, handle, value });
}

if (!events.length) {
  process.stderr.write('\n  No ATT traffic found. Was the snoop log on while the app ran?\n\n');
  process.exit(1);
}

/* ------------------------------------------------------- finding the scale */

/*
 * Handles are assigned per connection, so the scale's handles are not known in
 * advance. They are found by their traffic instead: the weight stream sends
 * many 12-byte notifications, and the record channel sends 34 to 41-byte ones.
 * The command handle is whichever handle the phone WRITES 20-byte packets to.
 */
const byHandle = new Map();
for (const e of events) {
  if (e.handle == null) continue;
  const h = byHandle.get(e.handle) || { notif: 0, writes: 0, sizes: new Set() };
  if (e.op === 'NOTIFY' || e.op === 'INDICATE') h.notif++;
  if (e.op === 'WRITE_REQ' || e.op === 'WRITE_CMD') h.writes++;
  if (e.value.length) h.sizes.add(e.value.length);
  byHandle.set(e.handle, h);
}

const looksLikeScale = (h, s) =>
  // The live weight stream: many small frames.
  (s.notif > 5 && s.sizes.has(12))
  // The record channel. A single one of these counts, because the impedance
  // frame may be the only one in the whole capture and it is the entire point
  // of looking — a threshold here would filter out exactly what we came for.
  || [41, 40, 34, 33].some((n) => s.sizes.has(n))
  // The command channel: whatever the phone writes 20-byte packets to.
  || (s.writes > 0 && s.sizes.has(20));

const scaleHandles = new Set(
  [...byHandle.entries()].filter(([h, s]) => looksLikeScale(h, s)).map(([h]) => h));

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m', cyan: '\x1b[36m', amber: '\x1b[33m' }
  : { dim: '', bold: '', off: '', cyan: '', amber: '' };
const say = (s = '') => process.stdout.write(s + '\n');

say('');
say(`${C.bold}Handles seen${C.off}`);
for (const [h, s] of [...byHandle.entries()].sort((a, b) => b[1].notif - a[1].notif)) {
  const mark = scaleHandles.has(h) ? `${C.cyan}<- looks like the scale${C.off}` : '';
  say(`  0x${h.toString(16).padStart(4, '0')}  ${String(s.notif).padStart(4)} notifications  `
    + `${String(s.writes).padStart(3)} writes  sizes ${[...s.sizes].sort((a, b) => a - b).join(',')}  ${mark}`);
}

const shown = events.filter((e) => ALL || e.handle == null || scaleHandles.has(e.handle));
const t0 = shown.length ? shown[0].us : 0;

say('');
say(`${C.bold}Conversation${C.off}   ${C.dim}(-> phone to scale, <- scale to phone)${C.off}`);
say('');

for (const e of shown) {
  const t = ((e.us - t0) / 1e6).toFixed(3).padStart(9);
  const dir = e.sent ? '->' : '<-';
  const h = e.handle == null ? '    ' : `0x${e.handle.toString(16).padStart(4, '0')}`;
  const hex = [...e.value].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const isWrite = e.op === 'WRITE_REQ' || e.op === 'WRITE_CMD';
  const flag = isWrite ? `${C.amber}${C.bold}` : '';
  say(`  ${t}s ${dir} ${h} ${flag}${e.op.padEnd(10)}${C.off} ${hex}`);
}

/* ------------------------------------------------------------ what to copy */

const writes = shown.filter((e) => e.op === 'WRITE_REQ' || e.op === 'WRITE_CMD');
say('');
say(`${C.bold}Everything the app wrote, in order${C.off}`);
say(`${C.dim}This is the list to compare against our three packets. Anything here`);
say(`that we do not send is a candidate for what starts the impedance program.${C.off}`);
say('');
if (!writes.length) {
  say('  Nothing was written. Then the trigger is not a write, and the difference');
  say('  is in timing, subscription, or something outside ATT.');
} else {
  writes.forEach((w, i) => {
    const hex = [...w.value].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    say(`  ${String(i + 1).padStart(2)}. +${((w.us - t0) / 1e6).toFixed(3)}s  `
      + `handle 0x${w.handle.toString(16).padStart(4, '0')}  ${hex}`);
  });
}
say('');
