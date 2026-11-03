'use strict';
// Fails when the dashboard's copy of the reducer drifts from shared/feature-reducer.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'shared', 'feature-reducer.js');
const DST_DIR = path.join(ROOT, 'weather-dashboard', 'weather-dashboard', 'lib');
const DST = path.join(DST_DIR, 'feature-reducer.js');
const DTS = path.join(DST_DIR, 'feature-reducer.d.ts');
const norm = (s) => s.replace(/\r\n/g, '\n');

test('dashboard copy of feature-reducer.js is identical to shared/feature-reducer.js', () => {
  assert.ok(fs.existsSync(DST), 'copy missing: run  node scripts/sync-feature-reducer.js');
  assert.equal(
    norm(fs.readFileSync(DST, 'utf8')),
    norm(fs.readFileSync(SRC, 'utf8')),
    'copy differs from source: run  node scripts/sync-feature-reducer.js'
  );
});

test('the copy loads and reports the same version and definition_hash', () => {
  const a = require(SRC);
  const b = require(DST);
  assert.equal(b.FEATURE_VERSION, a.FEATURE_VERSION);
  assert.equal(b.DEFINITION_HASH, a.DEFINITION_HASH);
});

test('feature-reducer.d.ts declares every runtime export', () => {
  const dts = fs.readFileSync(DTS, 'utf8');
  for (const name of Object.keys(require(SRC))) {
    assert.match(dts, new RegExp(`export (?:const|function|class) ${name}\\b`), `d.ts is missing "${name}"`);
  }
});
