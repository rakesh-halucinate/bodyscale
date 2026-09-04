#!/usr/bin/env node
/*
 * replay.js — stand in for ble.py.
 *
 * Emits a recorded session on stdout with the same JSON-line protocol the real
 * transport uses, so the whole decode and reporting pipeline can be exercised
 * with no Bluetooth and no hardware.
 */
'use strict';
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: replay.js <session.jsonl>'); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const delay = Number(process.env.REPLAY_DELAY_MS || 20);
// The parent kills us as soon as it has a measurement, so a closed pipe is the
// normal ending, not an error.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
process.on('SIGTERM', () => process.exit(0));

let i = 0;
(function tick() {
  if (i >= lines.length) { setTimeout(() => process.exit(0), 50); return; }
  if (!process.stdout.writable) return process.exit(0);
  process.stdout.write(lines[i++] + '\n');
  setTimeout(tick, delay);
})();
