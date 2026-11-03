#!/usr/bin/env node
/**
 * scripts/sync-feature-reducer.js
 *
 * Copies shared/feature-reducer.js (source of truth) to the Next app's lib/ folder so the
 * dashboard can deploy on its own. Touches no database.
 *
 *   node scripts/sync-feature-reducer.js           copy source -> dashboard copy
 *   node scripts/sync-feature-reducer.js --check   only compare; exit 1 when they differ
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'shared', 'feature-reducer.js');
const DST = path.join(
  __dirname, '..', 'weather-dashboard', 'weather-dashboard', 'lib', 'feature-reducer.js'
);

const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
const src = fs.readFileSync(SRC);
const same = fs.existsSync(DST) && norm(fs.readFileSync(DST)) === norm(src);

if (process.argv.includes('--check')) {
  if (same) { console.log('feature-reducer copy is in sync.'); process.exit(0); }
  console.error('feature-reducer copy is OUT OF SYNC. Run: node scripts/sync-feature-reducer.js');
  process.exit(1);
}

if (same) { console.log('Already in sync; nothing to do.'); process.exit(0); }
fs.copyFileSync(SRC, DST);
console.log('Copied shared/feature-reducer.js -> ' + path.relative(process.cwd(), DST));
