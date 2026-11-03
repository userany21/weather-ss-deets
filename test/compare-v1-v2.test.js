'use strict';
// Synthetic test for the pure comparison in stats/diagnostics/compare-v1-v2.js. No database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareTables, parseArgs } = require('../stats/diagnostics/compare-v1-v2.js');

const arr = (fill = null) => new Array(10).fill(fill);
const at = (n, v, base = arr()) => { const a = base.slice(); a[n] = v; return a; };
const A = '68-69°F';
const B = '70-71°F';

function oldDoc(city, date, bracket, { rank, price, leader, won }) {
  return {
    city, local_date: date, bracket, method: 'linear', won, resolved: won !== null,
    rank_through_hour: at(4, rank, arr(3)),
    is_leader_through_hour: at(4, leader, arr(false)),
    price_at_hour: at(4, price),
  };
}
function newDoc(city, date, bracket, { rank, leader, price, source, won, voted }) {
  const snap = at(4, '2026-11-02T20:02:00.000Z');
  return {
    feature_version: 2, city, local_date: date, bracket, method: 'linear', won, resolved: won !== null,
    snapshot_ts: snap, snapshot_vote_bracket: at(4, voted),
    rank_asof: at(4, rank), is_leader_asof: at(4, leader),
    entry_price_cents: at(4, price), entry_price_source: at(4, source),
  };
}

test('compareTables: old vs strict vs research, agreement, coverage', () => {
  const D1 = '2026-11-01';
  const D2 = '2026-11-02';
  const oldDocs = [
    // day 1: old rank-1 = A (priced 30, won)
    oldDoc('nyc', D1, A, { rank: 1, price: 30, leader: true, won: true }),
    oldDoc('nyc', D1, B, { rank: 2, price: 60, leader: false, won: false }),
    // day 2: old rank-1 = A (priced 20, lost)
    oldDoc('nyc', D2, A, { rank: 1, price: 20, leader: true, won: false }),
    oldDoc('nyc', D2, B, { rank: 2, price: 70, leader: false, won: true }),
  ];
  const newDocs = [
    // day 1: new rank-1 = B but only from a stale last tick (research only); B lost
    newDoc('nyc', D1, A, { rank: 2, leader: false, price: 55, source: 'tick_at_T_N', won: true, voted: B }),
    newDoc('nyc', D1, B, { rank: 1, leader: true, price: 45, source: 'last_tick_before_T_N', won: false, voted: B }),
    // day 2: new rank-1 = A, trusted price 40, lost. (A is also the bracket that just voted)
    newDoc('nyc', D2, A, { rank: 1, leader: true, price: 40, source: 'prices_all_at_T_N', won: false, voted: A }),
    newDoc('nyc', D2, B, { rank: 2, leader: false, price: null, source: 'none', won: true, voted: A }),
  ];
  const rep = compareTables(oldDocs, newDocs, { minN: 1 });

  const h4 = (dim) => rep.rollup.find((r) => r.dim === dim && r.hour === 4);
  const r1 = h4('rank1');
  assert.deepEqual([r1.old.n, r1.old.win_rate, r1.old.avg_edge], [2, 0.5, ((100 - 30) + -20) / 2]);
  assert.deepEqual([r1.new_strict.n, r1.new_strict.win_rate, r1.new_strict.avg_edge], [1, 0, -40]);
  assert.deepEqual([r1.new_research.n, r1.new_research.win_rate, r1.new_research.avg_edge], [2, 0, -42.5]);

  const l4 = h4('leader');
  assert.equal(l4.old.n, 2);
  assert.equal(l4.new_strict.n, 1, 'the untrusted leader is excluded from strict');
  assert.equal(l4.new_research.n, 2);

  const other = rep.rollup.find((r) => r.dim === 'rank1' && r.hour === 0);
  assert.equal(other.old.n, 0);
  assert.equal(other.old.win_rate, null);

  assert.ok(rep.byCity.some((r) => r.city === 'nyc' && r.hour === 4 && r.dim === 'rank1'));

  // day 1: old top A vs new top B differ; day 2: both A
  assert.deepEqual([rep.agreement.rank1_same, rep.agreement.rank1_compared], [1, 2]);
  // day 1 top B voted B (yes); day 2 top A voted A (yes)
  assert.deepEqual([rep.agreement.rank1_is_just_voted, rep.agreement.rank1_with_snapshot], [2, 2]);
  // 2 city-days x 10 hours, snapshot only at hour 4
  assert.equal(rep.coverage.city_day_hours, 20);
  assert.equal(rep.coverage.no_snapshot, 18);
  assert.equal(rep.coverage.by_hour[4], 0);
  assert.equal(rep.coverage.by_hour[3], 2);
});

test('compareTables: byCity respects the minimum n; unresolved days are not counted', () => {
  const oldDocs = [oldDoc('nyc', '2026-11-01', A, { rank: 1, price: 30, leader: true, won: null })];
  const rep = compareTables(oldDocs, [], { minN: 10 });
  assert.equal(rep.byCity.length, 0);
  assert.equal(rep.rollup.find((r) => r.dim === 'rank1' && r.hour === 4).old.n, 0);
});

test('compare script CLI parsing: --old is required and flags are validated', () => {
  assert.throws(() => parseArgs([]), /--old/);
  assert.throws(() => parseArgs(['--old=x', '--bogus=1']), /unknown flag/);
  const o = parseArgs(['--old=bk', '--method=reciprocal', '--min-n=5']);
  assert.deepEqual([o.old, o.new, o.method, o.minN], ['bk', 'stats_features', 'reciprocal', 5]);
});
