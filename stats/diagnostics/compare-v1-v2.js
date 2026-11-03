#!/usr/bin/env node
/**
 * stats/diagnostics/compare-v1-v2.js      READ-ONLY. Uses find() only. Never writes.
 *
 * Compares the legacy (end-of-hour, look-ahead) feature rows with the point-in-time (v2) rows:
 *   - per hour and per city (min n): count, win rate, average edge for "rank 1" and "leader"
 *   - how often the old rank-1 bracket equals the new rank-1 bracket
 *   - how often rank-1 at T_N is simply the bracket that just voted
 *   - how many city-day-hours have no snapshot
 *
 * Legacy rows = documents with rank_through_hour (no feature_version).
 * New rows    = documents with feature_version 2.
 * The two may live in different collections (a backup made with --backup-legacy) or in the same.
 *
 * Usage:
 *   MONGO_URI="..." node stats/diagnostics/compare-v1-v2.js --old=stats_features_legacy_YYYYMMDD \
 *        [--new=stats_features] [--method=linear] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--min-n=10] [--city=nyc]
 *
 * Variants:
 *   old           legacy row, entry = price_at_hour[N] (first priced vote of the bracket anywhere in hour N)
 *   new_strict    v2 row, entry source tick_at_T_N or prices_all_at_T_N (trusted)
 *   new_research  v2 row, also accepts last_tick_before_T_N (never pinnable)
 * Only resolved days (won is true or false) are counted. Edge = 100 - price when won, else -price.
 */
'use strict';

const R = require('../../shared/feature-reducer.js');

const NH = R.NUM_HOURS;
const DIMS = ['rank1', 'leader'];
const VARIANTS = ['old', 'new_strict', 'new_research'];

function accKey(dim, variant, N, city) {
  return `${dim}|${variant}|${N}|${city}`;
}

function summarize(a) {
  if (!a || a.n === 0) return { n: 0, win_rate: null, avg_edge: null };
  return { n: a.n, win_rate: a.wins / a.n, avg_edge: a.edge / a.n };
}

/**
 * Pure comparison. oldDocs: legacy-shaped rows. newDocs: feature_version 2 rows. One method each.
 * Returns { rollup, byCity, agreement, coverage }.
 */
function compareTables(oldDocs, newDocs, opts) {
  const minN = (opts && opts.minN) ?? 10;
  const acc = new Map();
  const cities = new Set();

  const add = (dim, variant, N, city, won, price) => {
    for (const c of [city, 'ALL']) {
      const k = accKey(dim, variant, N, c);
      let a = acc.get(k);
      if (!a) acc.set(k, (a = { n: 0, wins: 0, edge: 0 }));
      a.n += 1;
      if (won) a.wins += 1;
      a.edge += won ? 100 - price : -price;
    }
  };

  const oldByDay = new Map(); // day -> docs (legacy shape only)
  for (const d of oldDocs) {
    if (!Array.isArray(d.rank_through_hour)) continue;
    const day = `${d.city}|${d.local_date}`;
    (oldByDay.get(day) ?? oldByDay.set(day, []).get(day)).push(d);
    if (d.won !== true && d.won !== false) continue; // resolved days only
    cities.add(d.city);
    for (let N = 0; N < NH; N++) {
      const price = d.price_at_hour ? d.price_at_hour[N] : null;
      if (typeof price !== 'number') continue;
      if (d.rank_through_hour[N] === 1) add('rank1', 'old', N, d.city, d.won, price);
      if (d.is_leader_through_hour && d.is_leader_through_hour[N]) add('leader', 'old', N, d.city, d.won, price);
    }
  }

  const newByDay = new Map();
  for (const d of newDocs) {
    if (d.feature_version !== 2) continue;
    const day = `${d.city}|${d.local_date}`;
    (newByDay.get(day) ?? newByDay.set(day, []).get(day)).push(d);
    if (d.won !== true && d.won !== false) continue;
    cities.add(d.city);
    for (let N = 0; N < NH; N++) {
      const price = d.entry_price_cents ? d.entry_price_cents[N] : null;
      const src = d.entry_price_source ? d.entry_price_source[N] : null;
      if (typeof price !== 'number' || !src || src === 'none') continue;
      const strict = R.isTrustedSource(src);
      if (d.rank_asof && d.rank_asof[N] === 1) {
        add('rank1', 'new_research', N, d.city, d.won, price);
        if (strict) add('rank1', 'new_strict', N, d.city, d.won, price);
      }
      if (d.is_leader_asof && d.is_leader_asof[N] === true) {
        add('leader', 'new_research', N, d.city, d.won, price);
        if (strict) add('leader', 'new_strict', N, d.city, d.won, price);
      }
    }
  }

  const get = (dim, variant, N, city) => summarize(acc.get(accKey(dim, variant, N, city)));
  const rowFor = (dim, N, city) => {
    const r = { dim, hour: N, city };
    for (const v of VARIANTS) r[v] = get(dim, v, N, city);
    return r;
  };

  const rollup = [];
  for (const dim of DIMS) for (let N = 0; N < NH; N++) rollup.push(rowFor(dim, N, 'ALL'));

  const byCity = [];
  for (const city of [...cities].sort()) {
    for (const dim of DIMS) {
      for (let N = 0; N < NH; N++) {
        const r = rowFor(dim, N, city);
        if (Math.max(r.old.n, r.new_strict.n) >= minN) byCity.push(r);
      }
    }
  }

  // ---- agreement and coverage (all days, resolved or not) ----
  const topOf = (docs, field, N) => {
    const hit = docs.find((d) => d[field] && d[field][N] === 1);
    return hit ? hit.bracket : null;
  };
  const agreement = { rank1_same: 0, rank1_compared: 0, rank1_is_just_voted: 0, rank1_with_snapshot: 0 };
  const coverage = { city_day_hours: 0, no_snapshot: 0, by_hour: new Array(NH).fill(0), by_city: {} };

  for (const [day, docs] of newByDay) {
    const city = day.split('|')[0];
    const first = docs[0];
    const cb = (coverage.by_city[city] ??= { city_day_hours: 0, no_snapshot: 0 });
    const oldDocsForDay = oldByDay.get(day);
    for (let N = 0; N < NH; N++) {
      coverage.city_day_hours += 1;
      cb.city_day_hours += 1;
      const hasSnap = first.snapshot_ts && first.snapshot_ts[N] != null;
      if (!hasSnap) {
        coverage.no_snapshot += 1;
        coverage.by_hour[N] += 1;
        cb.no_snapshot += 1;
        continue;
      }
      const newTop = topOf(docs, 'rank_asof', N);
      if (newTop === null) continue;
      agreement.rank1_with_snapshot += 1;
      if (newTop === first.snapshot_vote_bracket[N]) agreement.rank1_is_just_voted += 1;
      if (oldDocsForDay) {
        const oldTop = topOf(oldDocsForDay, 'rank_through_hour', N);
        if (oldTop !== null) {
          agreement.rank1_compared += 1;
          if (oldTop === newTop) agreement.rank1_same += 1;
        }
      }
    }
  }

  return { rollup, byCity, agreement, coverage, minN };
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

const pct = (x) => (x === null ? '-' : (100 * x).toFixed(1) + '%');
const num = (x) => (x === null ? '-' : x.toFixed(1));
const share = (a, b) => (b ? `${(100 * a / b).toFixed(1)}% (${a}/${b})` : '-');

function flatten(r) {
  return {
    dim: r.dim, hour: r.hour, city: r.city,
    old_n: r.old.n, old_win: pct(r.old.win_rate), old_edge: num(r.old.avg_edge),
    strict_n: r.new_strict.n, strict_win: pct(r.new_strict.win_rate), strict_edge: num(r.new_strict.avg_edge),
    research_n: r.new_research.n, research_win: pct(r.new_research.win_rate), research_edge: num(r.new_research.avg_edge),
  };
}

function printReport(rep, log) {
  const out = log || console.log;
  out('\n== per hour, all cities (hour 0 = 8AM) ==');
  console.table(rep.rollup.map(flatten));
  out(`\n== per city and hour (min n = ${rep.minN}, old or new_strict) ==`);
  console.table(rep.byCity.map(flatten));
  const a = rep.agreement;
  out('\n== agreement ==');
  out('old rank-1 bracket == new rank-1 bracket:      ' + share(a.rank1_same, a.rank1_compared));
  out('rank-1 at T_N == bracket that just voted:      ' + share(a.rank1_is_just_voted, a.rank1_with_snapshot));
  out('\n== coverage ==');
  out('city-day-hours with NO snapshot:               ' + share(rep.coverage.no_snapshot, rep.coverage.city_day_hours));
  out('no-snapshot count by hour 0..9:                ' + rep.coverage.by_hour.join(' '));
  console.table(
    Object.entries(rep.coverage.by_city).map(([city, c]) => ({
      city, city_day_hours: c.city_day_hours, no_snapshot: c.no_snapshot,
      share: share(c.no_snapshot, c.city_day_hours),
    }))
  );
}

// ---------------------------------------------------------------------------
// CLI (read-only)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) throw new Error(`unexpected argument: ${x}`);
    const [k, ...rest] = x.slice(2).split('=');
    a[k] = rest.join('=');
  }
  const known = new Set(['old', 'new', 'method', 'from', 'to', 'min-n', 'city']);
  for (const k of Object.keys(a)) if (!known.has(k)) throw new Error(`unknown flag: --${k}`);
  if (!a.old) throw new Error('--old=<collection with the legacy rows> is required');
  return {
    old: a.old,
    new: a.new || 'stats_features',
    method: a.method || 'linear',
    from: a.from || null,
    to: a.to || null,
    city: a.city || null,
    minN: a['min-n'] ? parseInt(a['min-n'], 10) : 10,
  };
}

async function main(argv) {
  require('dotenv').config();
  const o = parseArgs(argv);
  if (!process.env.MONGO_URI) {
    console.error('Set the MONGO_URI environment variable first.');
    process.exit(1);
  }
  if (!['linear', 'reciprocal'].includes(o.method)) throw new Error('--method must be linear or reciprocal');
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db('weather');
    const filter = { method: o.method };
    if (o.from || o.to) filter.local_date = { ...(o.from ? { $gte: o.from } : {}), ...(o.to ? { $lte: o.to } : {}) };
    if (o.city) filter.city = o.city;
    const oldDocs = await db.collection(o.old).find(filter).toArray();      // read only
    const newDocs = await db.collection(o.new).find({ ...filter, feature_version: 2 }).toArray(); // read only
    console.log(`old rows: ${oldDocs.length}  new rows: ${newDocs.length}  method=${o.method}`);
    printReport(compareTables(oldDocs, newDocs, { minN: o.minN }));
  } finally {
    await client.close();
  }
}

module.exports = { compareTables, printReport, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}
