'use strict';
// Synthetic tests for the pure parts of stats/build-feature-table.js. No database, no network.
// The module must be requirable without MONGO_URI, without mongodb installed, and without side effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../shared/feature-reducer.js');
const B = require('../stats/build-feature-table.js');

const BASE = Date.parse('2026-11-02T16:00:00.000Z');
const iso = (min) => new Date(BASE + min * 60000).toISOString();
const clock = (h, m) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
const A = '68-69°F';
const Bk = '70-71°F';
let n = 0;
const tick = (min, h, m, bracket, price, extra = {}) => ({
  _id: `x${++n}`, city: 'nyc', local_date: '2026-11-02', pacing_time: clock(h, m),
  bracket, yes_price_cents: price, captured_at: iso(min), ...extra,
});
const NOW = new Date('2026-11-02T20:00:00.000Z');

test('module has no side effects and builds only linear and reciprocal', () => {
  assert.equal(typeof B.buildDocsForMethod, 'function');
  assert.deepEqual(B.TICK_COLLECTIONS.map((t) => t.method), ['linear', 'reciprocal']);
  assert.deepEqual(B.TICK_COLLECTIONS.map((t) => t.collection), ['high-temp', 'reciprocal']);
});

test('parseArgs: dry run is the default; apply is explicit', () => {
  const d = B.parseArgs([]);
  assert.equal(d.apply, false);
  assert.equal(d.force, false);
  assert.equal(d.days, 7);
  assert.equal(d.out, 'stats_features');
  assert.equal(B.parseArgs(['--apply']).apply, true);
  assert.equal(B.parseArgs(['--dry-run']).apply, false);
  assert.equal(B.parseArgs(['--force']).days, null);
  assert.equal(B.parseArgs(['--days=30']).days, 30);
  assert.equal(B.parseArgs(['--city=tokyo']).city, 'tokyo');
  assert.equal(B.parseArgs(['--out=stats_features_test']).out, 'stats_features_test');
});

test('parseArgs: refuses dangerous or malformed input', () => {
  assert.throws(() => B.parseArgs(['--apply', '--dry-run']), /mutually exclusive/);
  assert.throws(() => B.parseArgs(['--aply']), /unknown flag/);
  assert.throws(() => B.parseArgs(['--apply=1']), /takes no value/);
  assert.throws(() => B.parseArgs(['--days=0']), /positive integer/);
  assert.throws(() => B.parseArgs(['--days=abc']), /positive integer/);
  assert.throws(() => B.parseArgs(['--out=high-temp']), /tick collection/);
  assert.throws(() => B.parseArgs(['--out=reciprocal']), /tick collection/);
  assert.throws(() => B.parseArgs(['--out=bad name']), /invalid --out/);
  assert.throws(() => B.parseArgs(['--backup-legacy=stats_features']), /new collection/);
  assert.throws(() => B.parseArgs(['--backup-legacy=high-temp']), /new collection/);
  assert.throws(() => B.parseArgs(['stats_features']), /unexpected argument/);
});

test('dateFromForDays adds a one-day safety margin (local_date is not UTC)', () => {
  assert.equal(B.dateFromForDays(7, NOW), '2026-10-25');
  assert.equal(B.dateFromForDays(1, NOW), '2026-10-31');
  assert.equal(B.dateFromForDays(null, NOW), null);
});

test('incrementalGuard: needs v2 docs and an identical definition_hash', () => {
  const h = R.DEFINITION_HASH;
  assert.equal(B.incrementalGuard({ v2Count: 0, hashes: [] }, h).ok, false);
  assert.match(B.incrementalGuard({ v2Count: 0, hashes: [] }, h).reason, /--force/);
  assert.equal(B.incrementalGuard({ v2Count: 5, hashes: [h] }, h).ok, true);
  const bad = B.incrementalGuard({ v2Count: 5, hashes: [h, 'deadbeefdeadbeef'] }, h);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /deadbeefdeadbeef/);
});

test('legacyGuard: legacy docs are never overwritten silently', () => {
  assert.deepEqual(B.legacyGuard({ legacyCount: 0 }), { ok: true, action: 'none' });
  const refused = B.legacyGuard({ legacyCount: 12, backupLegacy: null, allowOverwriteLegacy: false });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /--backup-legacy/);
  assert.deepEqual(B.legacyGuard({ legacyCount: 12, backupLegacy: 'bk' }), { ok: true, action: 'backup', name: 'bk' });
  assert.equal(B.legacyGuard({ legacyCount: 12, allowOverwriteLegacy: true }).action, 'overwrite_without_backup');
});

test('buildDocsForMethod: v2 document shape, edge and outcome fields', () => {
  const ticks = [
    tick(0, 8, 20, A, 41),
    tick(10, 8, 40, Bk, 30),
    tick(60, 9, 20, A, 45),
    tick(120, 10, 20, Bk, 33),
  ];
  const winners = new Map([['nyc|2026-11-02', A]]);
  const computedAt = new Date('2026-11-03T00:00:00.000Z');
  const stats = B.newStats();
  const docs = B.buildDocsForMethod({ docs: ticks, collection: 'high-temp', method: 'linear', winners, computedAt, stats });

  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.bracket).sort(), [A, Bk]);
  const a = docs.find((d) => d.bracket === A);
  assert.equal(a.method, 'linear');
  assert.equal(a.city, 'nyc');
  assert.equal(a.local_date, '2026-11-02');
  assert.equal(a.feature_version, 2);
  assert.equal(a.definition_hash, R.DEFINITION_HASH);
  assert.equal(a.late_votes, 0);
  for (const f of [
    'snapshot_ts', 'snapshot_seq', 'snapshot_vote_bracket', 'tick_count_asof', 'rank_asof', 'rank_comp_asof',
    'is_leader_asof', 'lead_margin_asof', 'total_votes_asof', 'entry_price_cents', 'entry_price_source',
    'entry_price_age_s', 'rank_trend_asof',
  ]) {
    assert.equal(a[f].length, 10, f);
  }
  assert.equal(a.first_tick_price_cents, 41);
  assert.equal(a.first_tick_hour, 0);
  assert.equal(a.has_price, true);
  assert.equal(a.final_tick_count, 2);
  assert.equal(a.final_rank, 1);
  assert.equal(a.resolved, true);
  assert.equal(a.won, true);
  assert.equal(a.edge_cents, 100 - 41);
  assert.equal(a.computed_at, computedAt);
  assert.equal(a.rank_asof[1], 1, 'A has 2 votes at T_1, B has 1');
  assert.equal(a.entry_price_source[1], 'tick_at_T_N');
  assert.equal(a.entry_price_cents[1], 45);

  const b = docs.find((d) => d.bracket === Bk);
  assert.equal(b.won, false);
  assert.equal(b.edge_cents, -30);
  assert.equal(b.snapshot_ts[3], null, 'no tick in hour 3 -> null');
  assert.equal(b.entry_price_source[3], null);

  // legacy-only fields are gone
  for (const gone of ['tick_count_through_hour', 'rank_through_hour', 'is_leader_through_hour', 'price_at_hour', 'lead_margin_through_hour']) {
    assert.equal(gone in a, false, gone);
  }
  assert.equal(stats.days, 1);
  assert.equal(stats.docs, 2);
  assert.equal(stats.snapshotsByHour[0], 1);
  assert.equal(stats.snapshotsByHour[3], 0);
});

test('buildDocsForMethod: unresolved day has resolved=false, won=null, edge=null', () => {
  const docs = B.buildDocsForMethod({
    docs: [tick(0, 8, 20, A, 41)], collection: 'reciprocal', method: 'reciprocal',
    winners: new Map(), computedAt: new Date(0), stats: B.newStats(),
  });
  assert.equal(docs[0].method, 'reciprocal');
  assert.equal(docs[0].resolved, false);
  assert.equal(docs[0].won, null);
  assert.equal(docs[0].edge_cents, null);
});

test('buildDocsForMethod: ignored ticks are counted by reason and never reach a document', () => {
  const stats = B.newStats();
  const good = [tick(0, 8, 20, A, 41)];
  const junk = [
    tick(1, 8, 20, null, 50),
    tick(2, 8, 20, '', 50),
    { ...tick(3, 7, 59, A, 50), pacing_time: '7:59 AM' },
    { ...tick(4, 18, 0, A, 50), pacing_time: '6:00 PM' },
    { ...tick(5, 8, 20, A, 50), city: undefined },
    { ...tick(6, 8, 20, A, 50), local_date: undefined },
    { ...tick(7, 8, 20, A, 50), captured_at: 'nope' },
  ];
  const docs = B.buildDocsForMethod({ docs: [...junk, ...good], collection: 'high-temp', method: 'linear', winners: new Map(), computedAt: new Date(0), stats });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].final_tick_count, 1);
  assert.equal(stats.ticks, 8);
  assert.equal(stats.votes, 1);
  assert.deepEqual(stats.ignored, {
    no_bracket: 2, outside_window_or_bad_pacing: 2, no_city_or_date: 2, bad_captured_at: 1,
  });
});

test('buildDocsForMethod: input order and Date/string captured_at do not change the output', () => {
  const ticks = [
    tick(0, 8, 20, A, 41), tick(10, 8, 40, Bk, 30), tick(60, 9, 20, A, 45),
    tick(90, 9, 50, Bk, null, { prices_all: { [A]: 44, [Bk]: 31 } }), tick(130, 10, 30, A, 46),
  ];
  const run = (docs) => B.buildDocsForMethod({ docs, collection: 'high-temp', method: 'linear', winners: new Map([['nyc|2026-11-02', Bk]]), computedAt: new Date(0), stats: B.newStats() });
  const base = run(ticks);
  assert.deepEqual(run([...ticks].reverse()), base);
  assert.deepEqual(run(ticks.map((t, i) => (i % 2 ? { ...t, captured_at: new Date(t.captured_at) } : t))), base);
  const bk = base.find((d) => d.bracket === Bk);
  assert.equal(bk.entry_price_source[1], 'none', 'T_1 is the A vote; B was last priced 50 minutes earlier (> 30 min)');
  assert.equal(base.find((d) => d.bracket === A).entry_price_source[1], 'tick_at_T_N');
});

test('buildDocsForMethod: prices_all on the T_N tick prices brackets that did not vote', () => {
  const docs = B.buildDocsForMethod({
    docs: [
      tick(0, 8, 20, A, 41),
      tick(60, 9, 20, Bk, null, { prices_all: { [A]: 44, [Bk]: 31 } }),
    ],
    collection: 'high-temp', method: 'linear', winners: new Map(), computedAt: new Date(0), stats: B.newStats(),
  });
  const a = docs.find((d) => d.bracket === A);
  const b = docs.find((d) => d.bracket === Bk);
  assert.deepEqual([a.entry_price_cents[1], a.entry_price_source[1]], [44, 'prices_all_at_T_N']);
  assert.deepEqual([b.entry_price_cents[1], b.entry_price_source[1]], [31, 'prices_all_at_T_N']);
  assert.equal(b.first_tick_price_cents, null, 'first-tick price still comes from the vote itself');
});

test('edgeFor', () => {
  assert.equal(B.edgeFor(true, true, true, 40), 60);
  assert.equal(B.edgeFor(true, true, false, 40), -40);
  assert.equal(B.edgeFor(false, true, null, 40), null);
  assert.equal(B.edgeFor(true, false, true, null), null);
});
