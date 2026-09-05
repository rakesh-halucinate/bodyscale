#!/usr/bin/env node
'use strict';
/**
 * Runs the whole test plan and prints a traceability report.
 *
 * Unit tests prove the pieces. The integration suite proves the contract an
 * Electron host actually depends on, and every one of its cases carries a
 * stable id (INT-<AREA>-<NN>) so a result can be traced back to the clause it
 * verifies.
 *
 *   node test/run-plan.js              run everything
 *   node test/run-plan.js --integration only the integration suite
 *   node test/run-plan.js --json       machine-readable summary on stdout
 *
 * Exit code is 0 only if every test passed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UNIT_DIR = __dirname;
const INT_DIR = path.join(__dirname, 'integration');

const args = process.argv.slice(2);
const ONLY_INTEGRATION = args.includes('--integration');
const AS_JSON = args.includes('--json');

const AREAS = {
  HS: 'Handshake, lifecycle and process management',
  MEAS: 'The measurement path end to end',
  PROF: 'Profile ownership and validation',
  ERR: 'Every error code, provoked deliberately',
  SYNC: 'Synchronisation, ordering and concurrency',
  PROG: 'The live progress stream',
  TRUST: 'Derived data, trust and both payload shapes',
  CLI: 'The BodyScaleClient wrapper',
  ELEC: 'The Electron main process and preload bridge',
  PLAT: 'Platform portability behaviours',
  DEFER: 'Capturing a reading before the profile is known',
  ROB: 'Robustness against malformed input',
};

const listTests = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dir, f)).sort()
  : []);

const unitFiles = ONLY_INTEGRATION ? [] : listTests(UNIT_DIR);
const intFiles = listTests(INT_DIR);
const files = [...unitFiles, ...intFiles];

if (!files.length) {
  process.stderr.write('no test files found\n');
  process.exit(1);
}

// TAP is the only reporter with a stable, parseable shape across Node versions.
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files],
                      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tap = `${run.stdout || ''}`;

/** Parse the TAP stream into { name, ok } records, skipping file-level rollups. */
function parseTap(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(ok|not ok)\s+\d+\s+-\s+(.*)$/);
    if (!m) continue;
    let name = m[2].trim();
    if (/^#/.test(name)) continue;
    // A file-level rollup is named after the file, not a test.
    if (/\.test\.js$/.test(name)) continue;
    if (/# SKIP/i.test(name)) continue;
    name = name.replace(/\s+#\s*(time=|todo|skip).*$/i, '').trim();
    results.push({ name, ok: m[1] === 'ok' });
  }
  return results;
}

const results = parseTap(tap);
const failed = results.filter((r) => !r.ok);

const ID = /^(INT-([A-Z]+)-(\d+))\s+(.*)$/;
const traced = [];
const untraced = [];
for (const r of results) {
  const m = r.name.match(ID);
  if (m) traced.push({ id: m[1], area: m[2], num: Number(m[3]), title: m[4], ok: r.ok });
  else untraced.push(r);
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    integration: traced.length,
    unit: untraced.length,
    areas: Object.fromEntries(Object.keys(AREAS).map((a) => {
      const rows = traced.filter((t) => t.area === a);
      return [a, { total: rows.length, failed: rows.filter((r) => !r.ok).length }];
    })),
    failures: failed.map((f) => f.name),
  }, null, 2) + '\n');
  process.exit(failed.length ? 1 : 0);
}

const out = (s) => process.stdout.write(s + '\n');
const bar = '─'.repeat(74);

out('');
out(`  TEST PLAN EXECUTION`);
out(`  ${bar}`);
out(`  ${files.length} files, ${results.length} cases`);
out('');

// Integration coverage, by area, with every case id.
if (traced.length) {
  out('  INTEGRATION SUITE');
  out(`  ${bar}`);
  for (const [key, title] of Object.entries(AREAS)) {
    const rows = traced.filter((t) => t.area === key).sort((a, b) => a.num - b.num);
    if (!rows.length) continue;
    const bad = rows.filter((r) => !r.ok).length;
    const mark = bad ? 'FAIL' : ' ok ';
    out('');
    out(`  [${mark}] INT-${key}  ${title}`);
    out(`         ${rows.length} cases, ${rows.length - bad} passed`);
    // Contiguity matters: a gap means a case was dropped without anyone noticing.
    const nums = rows.map((r) => r.num);
    const gaps = [];
    for (let i = 1; i <= Math.max(...nums); i++) if (!nums.includes(i)) gaps.push(i);
    if (gaps.length) out(`         numbering gaps at ${gaps.join(', ')}`);
    for (const r of rows.filter((x) => !x.ok)) out(`         FAILED  ${r.id}  ${r.title}`);
  }
  out('');
}

out('  UNIT AND REGRESSION SUITE');
out(`  ${bar}`);
const unitFailed = untraced.filter((r) => !r.ok);
out(`  ${untraced.length} cases, ${untraced.length - unitFailed.length} passed`);
for (const r of unitFailed) out(`  FAILED  ${r.name}`);
out('');

out(`  ${bar}`);
if (failed.length) {
  out(`  RESULT: ${failed.length} of ${results.length} FAILED`);
} else {
  out(`  RESULT: all ${results.length} passed`);
}
out(`  ${bar}`);
out('');

process.exit(failed.length ? 1 : 0);
