#!/usr/bin/env node
'use strict';
/**
 * Extracts the test inventory: every case, its id, its title, and the comment
 * above it saying what failure it prevents.
 *
 * This is what makes the suite a test *plan* rather than a pile of tests. The
 * specification quotes it, so it cannot drift from the code.
 *
 *   node test/inventory.js            human-readable
 *   node test/inventory.js --json     structured, for the spec document
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'integration');
const AS_JSON = process.argv.includes('--json');

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
  ROB: 'Robustness against malformed input',
};

/**
 * Pull out `test('INT-XXX-NN  title'` and the comment block directly above it.
 * A regex is enough here: these files are machine-written to one house style,
 * and a parser would be more code than the job needs.
 */
function parseFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const cases = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:await\s+)?test\(\s*(['"`])(INT-([A-Z]+)-(\d+))\s+(.+?)\1/);
    if (!m) continue;

    // Walk back over the contiguous // comment block, skipping blank lines.
    const comment = [];
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) { if (comment.length) break; continue; }
      if (line.startsWith('//')) { comment.unshift(line.replace(/^\/\/\s?/, '')); continue; }
      break;
    }

    cases.push({
      id: m[2],
      area: m[3],
      num: Number(m[4]),
      title: m[5].trim(),
      prevents: comment.join(' ').trim() || null,
      file: path.basename(file),
      line: i + 1,
    });
  }
  return cases;
}

const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort()
  : [];
const all = files.flatMap((f) => parseFile(path.join(DIR, f)));

const byArea = {};
for (const c of all) (byArea[c.area] ||= []).push(c);
for (const rows of Object.values(byArea)) rows.sort((a, b) => a.num - b.num);

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    total: all.length,
    areas: Object.keys(AREAS).map((key) => ({
      key,
      title: AREAS[key],
      count: (byArea[key] || []).length,
      cases: (byArea[key] || []).map(({ id, title, prevents, file, line }) => ({ id, title, prevents, file, line })),
    })).filter((a) => a.count > 0),
    undocumented: all.filter((c) => !c.prevents).map((c) => c.id),
  }, null, 2) + '\n');
  process.exit(0);
}

const out = (s) => process.stdout.write(s + '\n');
out('');
out(`  INTEGRATION TEST INVENTORY — ${all.length} cases across ${Object.keys(byArea).length} areas`);
out('  ' + '─'.repeat(76));
for (const key of Object.keys(AREAS)) {
  const rows = byArea[key];
  if (!rows) continue;
  out('');
  out(`  INT-${key}  ${AREAS[key]}  (${rows.length})`);
  for (const c of rows) {
    out(`    ${c.id.padEnd(13)} ${c.title}`);
    if (c.prevents) out(`    ${''.padEnd(13)} └─ ${c.prevents.slice(0, 100)}`);
  }
}
const missing = all.filter((c) => !c.prevents);
out('');
if (missing.length) out(`  ${missing.length} case(s) have no "what this prevents" comment: ${missing.map((c) => c.id).join(', ')}`);
else out('  every case documents the failure it prevents');
out('');
