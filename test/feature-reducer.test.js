'use strict';
// Synthetic-data tests for shared/feature-reducer.js. No database, no network.
// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../shared/feature-reducer.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const BASE = Date.parse('2026-11-02T16:00:00.000Z');
const iso = (min) => new Date(BASE + min * 60000).toISOString();
const clock = (h, m) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
const A = '68-69°F';
const B = '70-71°F';
const C = '66-67°F';
const X = '72-73°F';
const Y = '74-75°F';
const Z = '64-65°F';
let auto = 0;

/** tick doc: minutes after BASE for captured_at, pacing clock h:m (24h in), bracket, price. */
function doc(min, h, m, bracket, price, extra = {}) {
  return {
    _id: `t${++auto}`,
    city: 'nyc',
    local_date: '2026-11-02',
    pacing_time: clock(h, m),
    bracket,
    yes_price_cents: price,
    captured_at: iso(min),
    ...extra,
  };
}
const votes = (docs, coll = 'linear') => R.votesFromTicks(docs, coll);
const run = (docs, opts) => R.reduceDay(votes(docs), opts);
const row = (res, b) => res.brackets.find((x) => x.bracket === b);

const ASOF_FIELDS = [
  'snapshot_ts', 'snapshot_seq', 'snapshot_vote_bracket', 'tick_count_asof', 'rank_asof',
  'rank_comp_asof', 'is_leader_asof', 'lead_margin_asof', 'total_votes_asof',
  'entry_price_cents', 'entry_price_source', 'entry_price_age_s', 'rank_trend_asof',
];

/** Everything an "as of hour n" consumer can see. Brackets with 0 votes at n are omitted. */
function viewAt(res, n) {
  const out = { snap: res.snapshots[n], brackets: {} };
  for (const b of res.brackets) {
    if ((b.tick_count_asof[n] ?? 0) > 0) {
      const o = {};
      for (const f of ASOF_FIELDS) o[f] = b[f][n];
      out.brackets[b.bracket] = o;
    }
  }
  return out;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const BR = [Z, C, A, B, X];
/** Random but deterministic day: missing hours, ties, null prices, prices_all, late votes. */
function genDocs(seed) {
  const rnd = rng(seed);
  const docs = [];
  for (let h = 8; h < 18; h++) {
    if (rnd() < 0.15) continue; // an hour with no tick
    const k = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < k; i++) {
      const min = Math.floor(rnd() * 60);
      const lateShift = rnd() < 0.12 ? 1 + Math.floor(rnd() * 2) : 0;
      const extra = { _id: `g${seed}-${h}-${i}` };
      if (rnd() < 0.2) {
        extra.prices_all = Object.fromEntries(
          BR.filter(() => rnd() < 0.6).map((b) => [b, 1 + Math.floor(rnd() * 98)])
        );
      }
      docs.push({
        city: 'nyc',
        local_date: '2026-11-02',
        pacing_time: clock(Math.max(0, h - lateShift), min), // pacing hour can lag arrival
        bracket: BR[Math.floor(rnd() * BR.length)],
        yes_price_cents: rnd() < 0.15 ? null : 1 + Math.floor(rnd() * 98),
        captured_at: iso((h - 8) * 60 + min),
        ...extra,
      });
    }
  }
  return docs;
}

/** Independent definition of "which vote creates snapshot N" (index in sorted votes). */
function creatorIndexes(sorted) {
  const idx = new Array(R.NUM_HOURS).fill(-1);
  const seen = new Set();
  let max = -1;
  sorted.forEach((v, i) => {
    const k = `${v.coll}:${v.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    const late = v.hour < max;
    if (!late) max = v.hour;
    if (!late && idx[v.hour] === -1) idx[v.hour] = i;
  });
  return idx;
}

// ---------------------------------------------------------------------------
// a. truncation: THE no-leak test
// ---------------------------------------------------------------------------
test('a. truncation: cutting the stream right after T_N leaves snapshots 0..N unchanged', () => {
  let checked = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const sorted = R.sortVotes(votes(genDocs(seed)));
    const full = R.reduceDay(sorted);
    const idx = creatorIndexes(sorted);
    for (let N = 0; N < R.NUM_HOURS; N++) {
      if (idx[N] === -1) {
        assert.equal(full.snapshots[N], null, `seed ${seed}: no T_${N} so no snapshot`);
        continue;
      }
      const cut = R.reduceDay(sorted.slice(0, idx[N] + 1));
      for (let n = 0; n <= N; n++) {
        assert.deepEqual(viewAt(cut, n), viewAt(full, n), `seed ${seed} cut@T_${N} view ${n}`);
      }
      // Stronger: REWRITE the whole future (other brackets, prices, price maps).
      const future = sorted.map((v, i) =>
        i <= idx[N] ? v : { ...v, bracket: 'ZZ-ZZ°F', price: 99, pricesAll: new Map([[A, 1]]) }
      );
      const mutated = R.reduceDay(future);
      for (let n = 0; n <= N; n++) {
        assert.deepEqual(viewAt(mutated, n), viewAt(full, n), `seed ${seed} mutated future view ${n}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 300, `expected many (seed,N) checks, got ${checked}`);
});

// ---------------------------------------------------------------------------
// b / c / d
// ---------------------------------------------------------------------------
test('b. permutation: shuffling the input does not change the output', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const vs = votes(genDocs(seed));
    const base = R.reduceDay(vs);
    for (let k = 1; k <= 4; k++) {
      assert.deepEqual(R.reduceDay(shuffle(vs, rng(seed * 100 + k))), base, `seed ${seed} shuffle ${k}`);
    }
  }
});

test('c. duplicate: re-inserting the same vote (same collection + _id) changes nothing', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const vs = votes(genDocs(seed));
    const base = R.reduceDay(vs);
    const rnd = rng(seed + 999);
    const withDups = vs.slice();
    for (let i = 0; i < Math.max(3, vs.length >> 1); i++) {
      const v = vs[Math.floor(rnd() * vs.length)];
      withDups.splice(Math.floor(rnd() * (withDups.length + 1)), 0, { ...v });
    }
    assert.deepEqual(R.reduceDay(withDups), base, `seed ${seed}`);
  }
  // same _id in the OTHER collection is a different vote
  const d = doc(0, 8, 0, A, 40, { _id: 'same' });
  const both = [...votes([d], 'linear'), ...votes([d], 'reciprocal')];
  assert.equal(R.reduceDay(both).total_votes, 2);
});

test('d. incremental replay equals the batch result, and snapshots are frozen as they appear', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const sorted = R.sortVotes(votes(genDocs(seed)));
    const batch = R.reduceDay(sorted);
    const r = new R.FeatureReducer();
    let created = 0;
    for (const v of sorted) {
      const before = r.snapshots.filter(Boolean).length;
      const made = r.push(v);
      const after = r.snapshots.filter(Boolean).length;
      assert.equal(made, after === before + 1, `seed ${seed}: push() return value`);
      if (made) {
        created++;
        const hour = r.snapshots.findIndex((s, i) => s && viewAt(batch, i).snap === null);
        assert.equal(hour, -1, 'every snapshot made live must exist in the batch result');
        const n = v.hour;
        assert.deepEqual(viewAt(r.result(), n), viewAt(batch, n), `seed ${seed}: live view ${n} == batch`);
      }
    }
    assert.deepEqual(r.result(), batch, `seed ${seed}: incremental == batch`);
    assert.equal(created, batch.snapshots.filter(Boolean).length);
  }
});

// ---------------------------------------------------------------------------
// e. ties
// ---------------------------------------------------------------------------
test('e. ties: order is count desc, first-vote seq asc, low asc, string asc; stable', () => {
  const docs = [
    doc(0, 8, 0, A, 40),
    doc(10, 8, 10, B, 30),
    doc(60, 9, 0, C, 20),   // T_1: A, B, C all 1 vote
    doc(120, 10, 0, C, 25), // T_2: C=2
  ];
  const res = run(docs);

  const v0 = viewAt(res, 0).brackets;
  assert.equal(v0[A].rank_asof, 1);
  assert.equal(v0[B], undefined, 'B has no vote at snapshot 0 (omitted)');

  const v1 = viewAt(res, 1).brackets;
  assert.deepEqual([v1[A].rank_asof, v1[B].rank_asof, v1[C].rank_asof], [1, 2, 3]);
  assert.deepEqual([v1[A].rank_comp_asof, v1[B].rank_comp_asof, v1[C].rank_comp_asof], [1, 1, 1]);
  assert.deepEqual([v1[A].is_leader_asof, v1[B].is_leader_asof, v1[C].is_leader_asof], [true, true, true]);
  assert.equal(res.snapshots[1].lead_margin, 0);

  const v2 = viewAt(res, 2).brackets;
  assert.deepEqual([v2[C].rank_asof, v2[A].rank_asof, v2[B].rank_asof], [1, 2, 3]);
  assert.deepEqual([v2[C].rank_comp_asof, v2[A].rank_comp_asof, v2[B].rank_comp_asof], [1, 2, 2]);
  assert.deepEqual([v2[C].is_leader_asof, v2[A].is_leader_asof, v2[B].is_leader_asof], [true, false, false]);
  assert.equal(res.snapshots[2].lead_margin, (2 - 1) / 4);

  assert.deepEqual(run(docs), res, 'stable across runs');
  assert.deepEqual(R.reduceDay(shuffle(votes(docs), rng(5))), res, 'stable across input order');

  // comparator tail rules (only reachable directly: firstSeq is unique per bracket)
  const rec = (count, firstSeq, low, bracket) => ({ count, firstSeq, low, bracket });
  assert.ok(R.compareBracketRecords(rec(2, 9, 70, 'b'), rec(1, 1, 60, 'a')) < 0, 'count desc');
  assert.ok(R.compareBracketRecords(rec(1, 1, 70, 'b'), rec(1, 2, 60, 'a')) < 0, 'first seq asc');
  assert.ok(R.compareBracketRecords(rec(1, 1, 60, 'b'), rec(1, 1, 70, 'a')) < 0, 'low asc');
  assert.ok(R.compareBracketRecords(rec(1, 1, -Infinity, 'z'), rec(1, 1, 5, 'a')) < 0, 'tail low first');
  assert.ok(R.compareBracketRecords(rec(1, 1, 60, 'a'), rec(1, 1, 60, 'b')) < 0, 'string asc');
  assert.equal(R.compareBracketRecords(rec(1, 1, 60, 'a'), rec(1, 1, 60, 'a')), 0);
});

// ---------------------------------------------------------------------------
// f. missing hour
// ---------------------------------------------------------------------------
test('f. missing hour: no snapshot, every hour-N field null, nothing carried forward', () => {
  const res = run([
    doc(0, 8, 0, A, 40),    // bucket 0
    doc(60, 9, 0, B, 30),   // bucket 1
    doc(180, 11, 0, A, 42), // bucket 3  (bucket 2 has no tick)
  ]);
  assert.equal(res.snapshots[2], null);
  for (const r of res.brackets) {
    for (const f of ASOF_FIELDS) assert.equal(r[f][2], null, `${r.bracket}.${f}[2]`);
  }
  assert.equal(res.snapshots[3].total_votes, 3, 'running totals still count earlier hours');
  assert.equal(row(res, A).tick_count_asof[3], 2);
  assert.equal(row(res, A).rank_trend_asof[3], 'stable', 'n=3 compares with n=1 (both exist)');
  assert.equal(row(res, A).rank_trend_asof[4], null, 'no snapshot 4 at all');
});

// ---------------------------------------------------------------------------
// g. late votes
// ---------------------------------------------------------------------------
test('g. late vote: counted forward only, never makes a snapshot, late_votes correct', () => {
  const docs = [
    doc(0, 9, 0, A, 40),    // bucket 1
    doc(10, 11, 0, B, 30),  // bucket 3
    doc(20, 10, 30, C, 20), // bucket 2 arrives after bucket 3 -> LATE
    doc(30, 12, 0, A, 41),  // bucket 4
  ];
  const res = run(docs);
  assert.equal(res.late_votes, 1);
  assert.equal(res.snapshots[2], null, 'a late vote cannot create its own hour snapshot');
  assert.equal(res.snapshots[3].total_votes, 2, 'snapshot 3 was frozen before the late vote');
  assert.equal(row(res, C).tick_count_asof[3], 0);
  assert.equal(res.snapshots[4].total_votes, 4, 'snapshot 4 includes the late vote');
  assert.equal(row(res, C).tick_count_asof[4], 1);
  assert.equal(row(res, C).rank_asof[4], 3);

  const two = run([...docs, doc(40, 9, 15, B, 31)]); // another late one (bucket 1 after 4)
  assert.equal(two.late_votes, 2);
  assert.equal(two.snapshots[4].total_votes, 4, 'frozen snapshot 4 ignores the vote arriving after it');
  assert.equal(two.total_votes, 5);
});

// ---------------------------------------------------------------------------
// h. zero-count bracket and rank trend
// ---------------------------------------------------------------------------
test('h. zero-count bracket: rank null; rank trend null when an earlier snapshot is missing', () => {
  const res = run([
    doc(0, 8, 0, A, 40),     // bucket 0
    doc(60, 9, 0, A, 41),    // bucket 1
    doc(120, 10, 0, B, 30),  // bucket 2: B votes for the first time
    doc(180, 11, 0, B, 31),  // bucket 3
    doc(240, 12, 0, B, 32),  // bucket 4
  ]);
  const b = row(res, B);
  assert.equal(b.tick_count_asof[0], 0);
  assert.equal(b.rank_asof[0], null, 'B had no votes at snapshot 0');
  assert.equal(b.rank_comp_asof[0], null);
  assert.equal(b.is_leader_asof[0], false);
  assert.equal(b.entry_price_cents[0], null);
  assert.equal(b.entry_price_source[0], 'none');
  assert.equal(b.rank_asof[1], null);

  assert.equal(b.rank_trend_asof[2], null, 'rank at n=2 exists but rank at n=0 is null');
  assert.equal(b.rank_trend_asof[3], null, 'rank at n=1 is null');
  assert.equal(b.rank_trend_asof[4], 'rising', 'rank 1 at n=4 vs rank 2 at n=2');
  const a = row(res, A);
  assert.equal(a.rank_trend_asof[2], 'stable');
  assert.equal(a.rank_trend_asof[4], 'falling');
  assert.equal(a.rank_trend_asof[0], null);
  assert.equal(a.rank_trend_asof[1], null);
});

// ---------------------------------------------------------------------------
// i. entry price, all four cases
// ---------------------------------------------------------------------------
test('i1. entry: the T_N vote is this bracket and priced -> tick_at_T_N (trusted)', () => {
  const res = run([doc(50, 8, 50, Y, 20), doc(70, 9, 10, X, 40)]);
  const x = row(res, X);
  assert.equal(x.entry_price_cents[1], 40);
  assert.equal(x.entry_price_source[1], 'tick_at_T_N');
  assert.equal(x.entry_price_age_s[1], 0);
  assert.ok(R.isTrustedSource(x.entry_price_source[1]));
});

test('i2. entry: prices_all supplies a bracket that did not vote at T_N (trusted)', () => {
  const res = run([
    doc(0, 8, 0, Y, 20),
    doc(70, 9, 10, X, 40, { prices_all: { [Y]: 25, [X]: 41, [Z]: 30 } }),
  ]);
  const y = row(res, Y);
  assert.equal(y.entry_price_cents[1], 25, 'prices_all beats the older last-tick price (20)');
  assert.equal(y.entry_price_source[1], 'prices_all_at_T_N');
  assert.equal(row(res, X).entry_price_cents[1], 40, 'the vote\'s own price beats prices_all');
  assert.equal(row(res, X).entry_price_source[1], 'tick_at_T_N');
  assert.equal(row(res, Z), undefined, 'prices_all does not create brackets');

  const noOwnPrice = run([doc(70, 9, 10, X, null, { prices_all: { [X]: 41 } })]);
  assert.equal(row(noOwnPrice, X).entry_price_cents[1], 41);
  assert.equal(row(noOwnPrice, X).entry_price_source[1], 'prices_all_at_T_N');
  assert.ok(R.isTrustedSource('prices_all_at_T_N'));
});

test('i3. entry: last priced vote of the bracket within maxStaleMs (research only)', () => {
  const at = (min) => run([doc(min, 8, 50, Y, 20), doc(70, 9, 10, X, 40)]);
  const y = row(at(50), Y); // 20 minutes old
  assert.equal(y.entry_price_cents[1], 20);
  assert.equal(y.entry_price_source[1], 'last_tick_before_T_N');
  assert.equal(y.entry_price_age_s[1], 1200);
  assert.equal(R.isTrustedSource('last_tick_before_T_N'), false);

  assert.equal(row(at(40), Y).entry_price_age_s[1], 1800, 'exactly 30 minutes is still allowed');
  assert.equal(row(at(40), Y).entry_price_source[1], 'last_tick_before_T_N');
  const stale = row(at(39), Y); // 31 minutes
  assert.equal(stale.entry_price_cents[1], null);
  assert.equal(stale.entry_price_source[1], 'none');
  assert.equal(stale.entry_price_age_s[1], null);

  const tight = row(run([doc(50, 8, 50, Y, 20), doc(70, 9, 10, X, 40)], { maxStaleMs: 5 * 60000 }), Y);
  assert.equal(tight.entry_price_source[1], 'none', 'maxStaleMs option is honoured');

  // voting bracket with NO price at T_N falls back to its own earlier priced vote
  const fallback = row(run([doc(50, 8, 50, X, 33), doc(70, 9, 10, X, null)]), X);
  assert.equal(fallback.entry_price_cents[1], 33);
  assert.equal(fallback.entry_price_source[1], 'last_tick_before_T_N');
  assert.equal(fallback.entry_price_age_s[1], 1200);
});

test('i4. entry: no price anywhere -> null and source none', () => {
  const res = run([doc(0, 8, 0, Y, null), doc(70, 9, 10, X, 40)]);
  const y = row(res, Y);
  assert.equal(y.entry_price_cents[1], null);
  assert.equal(y.entry_price_source[1], 'none');
  assert.equal(y.entry_price_age_s[1], null);
  assert.equal(R.isTrustedSource('none'), false);
  assert.equal(R.isTrustedSource(null), false);
});

test('i5. entry: a later price never leaks back into an earlier snapshot', () => {
  const early = run([doc(0, 8, 0, Y, null), doc(70, 9, 10, X, 40)]);
  const later = run([doc(0, 8, 0, Y, null), doc(70, 9, 10, X, 40), doc(80, 9, 20, Y, 77)]);
  assert.deepEqual(viewAt(later, 1), viewAt(early, 1));
  assert.equal(row(later, Y).entry_price_cents[1], null);
});

// ---------------------------------------------------------------------------
// j. captured_at string vs Date
// ---------------------------------------------------------------------------
test('j. captured_at as ISO string, as Date, or mixed gives the identical result', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const docs = genDocs(seed);
    const asString = R.reduceDay(votes(docs));
    const asDate = R.reduceDay(votes(docs.map((d) => ({ ...d, captured_at: new Date(d.captured_at) }))));
    const mixed = R.reduceDay(
      votes(docs.map((d, i) => (i % 2 ? { ...d, captured_at: new Date(d.captured_at) } : d)))
    );
    assert.deepEqual(asDate, asString, `seed ${seed} Date`);
    assert.deepEqual(mixed, asString, `seed ${seed} mixed`);
  }
  assert.equal(R.toEpochMs(new Date('2026-11-02T22:02:00.000Z')), R.toEpochMs('2026-11-02T22:02:00.000Z'));
});

// ---------------------------------------------------------------------------
// k. ignored ticks
// ---------------------------------------------------------------------------
test('k. null brackets and votes outside 8:00-17:59 are ignored everywhere', () => {
  const good = [doc(0, 8, 0, A, 40), doc(60, 9, 0, B, 30), doc(120, 10, 0, A, 41)];
  const junk = [
    doc(-30, 8, 0, null, 50),                       // null bracket
    doc(-20, 8, 0, '', 50),                         // empty
    doc(-10, 8, 0, '   ', 50),                      // whitespace
    { ...doc(-5, 8, 0, A, 50), bracket: undefined },
    { ...doc(-40, 7, 59, Y, 99), pacing_time: '7:59 AM' },
    { ...doc(200, 18, 0, Y, 99), pacing_time: '6:00 PM' },
    { ...doc(201, 12, 0, Y, 99), pacing_time: '12:00 AM' },
    { ...doc(202, 12, 0, Y, 99), pacing_time: 'garbage' },
    { ...doc(203, 12, 0, Y, 99), pacing_time: null },
    { ...doc(204, 12, 0, Y, 99), captured_at: 'not a date' },
    { ...doc(205, 12, 0, Y, 99), _id: undefined },
  ];
  assert.equal(votes(junk).length, 0, 'every junk tick is dropped');
  const base = run(good);
  const mixed = run([...junk, ...good]);
  assert.deepEqual(mixed, base);
  assert.equal(mixed.total_votes, 3);
  assert.equal(mixed.first_vote.bracket, A, 'first-tick fields ignore dropped ticks too');
  assert.equal(mixed.first_vote.captured_at, iso(0));
  assert.equal(row(mixed, Y), undefined);

  assert.equal(R.normalizeTickDetailed(junk[0], 'linear').reason, 'no_bracket');
  assert.equal(R.normalizeTickDetailed(junk[4], 'linear').reason, 'outside_window_or_bad_pacing');
  assert.equal(R.normalizeTickDetailed(junk[9], 'linear').reason, 'bad_captured_at');
  assert.equal(R.normalizeTickDetailed(junk[10], 'linear').reason, 'no_id');
  assert.throws(() => R.normalizeTick(good[0], 'combined'), /unknown collection/);
  assert.equal(R.pacingBucket('7:59 AM'), null);
  assert.equal(R.pacingBucket('8:00 AM'), 0);
  assert.equal(R.pacingBucket('5:59 PM'), 9);
  assert.equal(R.pacingBucket('6:00 PM'), null);
  assert.equal(R.pacingBucket('12:30 PM'), 4);
  assert.equal(R.pacingBucket('12:30 AM'), null);
});

// ---------------------------------------------------------------------------
// extras: first-tick fields, order guard, brackets, hash guards
// ---------------------------------------------------------------------------
test('first-tick fields come from the same sorted vote stream', () => {
  const res = run([doc(0, 8, 20, A, 41), doc(30, 8, 50, B, null), doc(90, 9, 20, B, 35)]);
  assert.equal(res.first_vote.bracket, A);
  assert.equal(res.first_vote.pacing_minutes, 8 * 60 + 20);
  assert.equal(res.first_vote.price, 41);
  assert.equal(row(res, A).first_tick_price_cents, 41);
  assert.equal(row(res, A).has_price, true);
  assert.equal(row(res, B).first_tick_price_cents, null, 'first B vote had no price');
  assert.equal(row(res, B).has_price, false);
  assert.equal(row(res, B).first_tick_hour, 0);
});

test('unsorted pushes are counted as order violations (live guard)', () => {
  const [v1, v2] = R.sortVotes(votes([doc(0, 8, 0, A, 40), doc(10, 8, 5, B, 30)]));
  const r = new R.FeatureReducer();
  r.push(v2);
  r.push(v1);
  assert.equal(r.orderViolations, 1);
  assert.equal(r.result().order_violations, 1);
  const ok = new R.FeatureReducer();
  ok.push(v1);
  ok.push(v2);
  assert.equal(ok.orderViolations, 0);
});

test('reciprocal and linear are separate streams; collection rank breaks timestamp ties', () => {
  const t = iso(0);
  const lin = votes([{ ...doc(0, 8, 0, A, 40), _id: 'z', captured_at: t }], 'high-temp');
  const rec = votes([{ ...doc(0, 8, 0, B, 40), _id: 'a', captured_at: t }], 'reciprocal');
  const sorted = R.sortVotes([...rec, ...lin]);
  assert.deepEqual(sorted.map((v) => v.collection), ['linear', 'reciprocal'], 'linear=0 before reciprocal=1');
  assert.deepEqual(R.METHODS, ['linear', 'reciprocal']);
});

test('bracketLow parses the title forms', () => {
  assert.equal(R.bracketLow('68-69°F'), 68);
  assert.equal(R.bracketLow('30°C'), 30);
  assert.equal(R.bracketLow('90°F or higher'), 90);
  assert.equal(R.bracketLow('30°C or below'), -Infinity);
  assert.equal(R.bracketLow('-3°C'), -3);
  assert.equal(R.bracketLow('-5--3°C'), -5);
  assert.equal(R.bracketLow('???'), Infinity);
});

test('FEATURE_VERSION and definition_hash', () => {
  assert.equal(R.FEATURE_VERSION, 2);
  assert.match(R.DEFINITION_HASH, /^[0-9a-f]{16}$/);
  assert.equal(R.computeDefinitionHash(), R.DEFINITION_HASH);
  const res = run([doc(0, 8, 0, A, 40)]);
  assert.equal(res.feature_version, 2);
  assert.equal(res.definition_hash, R.DEFINITION_HASH);
});

test('hash covers every top-level function/class, and the module has no I/O', () => {
  const file = path.join(__dirname, '..', 'shared', 'feature-reducer.js');
  const src = fs.readFileSync(file, 'utf8');
  const names = [
    ...[...src.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^class\s+(\w+)/gm)].map((m) => m[1]),
  ].sort();
  assert.deepEqual(names, [...R.HASHED_NAMES, ...R.UNHASHED_NAMES].sort(),
    'every top-level function/class must be listed as hashed or deliberately unhashed');

  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  for (const bad of [/\brequire\s*\(/, /\bimport\b/, /process\.env/, /\bprocess\b/, /\bfs\b/, /mongodb/i, /\bfetch\s*\(/]) {
    assert.doesNotMatch(code, bad, `module must stay pure: ${bad}`);
  }
});
