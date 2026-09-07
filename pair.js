#!/usr/bin/env node
'use strict';
/*
 * pair.js — the admin pairing screen, as a terminal program.
 *
 * A kiosk cannot ask a customer which Bluetooth device to use, so the scale is
 * chosen once by whoever installs it. This is that step, driving the same
 * `scan` and `pair` commands an Electron admin panel will use, so the flow can
 * be checked against real hardware before any UI exists.
 */
const readline = require('readline');
const { BodyScaleClient } = require('./electron-example/bodyscale-client.js');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const secArg = argv.indexOf('--seconds');
const SECONDS = secArg >= 0 && argv[secArg + 1] ? Number(argv[secArg + 1]) : 8;

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m',
      cyan: '\x1b[36m', amber: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m' }
  : { dim: '', bold: '', off: '', cyan: '', amber: '', red: '', green: '' };
const say = (s = '') => process.stdout.write(s + '\n');

const rl = process.stdin.isTTY
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;
const ask = (q) => (rl
  ? new Promise((r) => rl.question(q, (a) => r(a.trim())))
  : Promise.resolve('q'));

async function main() {
  const client = new BodyScaleClient({ scaleDir: ROOT });
  client.on('log', (line) => {
    const s = String(line).trim();
    if (/scanning/i.test(s)) say(`  ${C.dim}· ${s}${C.off}`);
  });

  const hello = await client.start();
  say('');
  say(hello.device
    ? `  currently paired: ${C.bold}${hello.device.name || 'unnamed'}${C.off} `
      + `${C.dim}${hello.device.address}${C.off}`
    : `  ${C.dim}nothing paired yet${C.off}`);

  for (;;) {
    say('');
    const go = await ask(`  ${C.bold}Enter to scan${C.off} `
      + `${C.dim}(f to forget the paired device, q to quit)${C.off} `);
    if (go.toLowerCase() === 'q') break;

    if (go.toLowerCase() === 'f') {
      await client.forget();
      say(`  ${C.amber}forgotten. The next measurement will scan by name.${C.off}`);
      continue;
    }

    say(`  ${C.dim}scanning for ${SECONDS} s…${C.off}`);
    let res;
    try {
      res = await client.scan(SECONDS);
    } catch (err) {
      say(`  ${C.red}${err.code || 'ERROR'}${C.off}  ${err.message}`);
      continue;
    }

    const devices = res.devices || [];
    if (!devices.length) {
      say(`  ${C.amber}Nothing is advertising.${C.off}`);
      say(`  ${C.dim}The scale's radio sleeps when idle. Tap the plate and scan again.${C.off}`);
      continue;
    }

    say('');
    devices.forEach((d, i) => {
      const mark = d.supported ? `${C.green}✓${C.off}` : ' ';
      const model = d.model ? `${C.dim} — ${d.model}${C.off}` : '';
      say(`  ${mark} ${String(i + 1).padStart(2)}. ${(d.name || '(unnamed)').padEnd(26)}`
        + `${C.dim}${String(d.address).padEnd(40)}${C.off}`
        + `${C.dim}${d.rssi === null ? '' : `rssi ${d.rssi}`}${C.off}${model}`);
    });
    say(`  ${C.dim}✓ marks a model with a driver. The others are shown because a scale`);
    say(`  advertising under an unfamiliar name is exactly what you may be installing.${C.off}`);

    const pick = await ask(`\n  ${C.bold}Number to pair${C.off} ${C.dim}(Enter to rescan)${C.off} `);
    const n = Number(pick);
    if (!Number.isInteger(n) || n < 1 || n > devices.length) continue;

    const chosen = devices[n - 1];
    const paired = await client.pair(chosen.address, chosen.name || undefined);
    say('');
    say(`  ${C.green}paired${C.off} ${C.bold}${paired.device.name || 'unnamed'}${C.off} `
      + `${C.dim}${paired.device.address}${C.off}`);
    say(`  ${C.dim}Every measurement from now on connects straight to it.${C.off}`);
    break;
  }

  await client.stop();
  if (rl) rl.close();
  say('');
}

main().catch((err) => {
  say(`\n${C.red}${err.stack || err.message}${C.off}`);
  if (rl) rl.close();
  process.exit(1);
});
