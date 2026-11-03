/**
 * stats/build-feature-table.js   (feature_version 2: point-in-time "as of T_N" features)
 *
 * Builds the `stats_features` collection: one document per (city, local_date, bracket, method).
 * All feature logic lives in ../shared/feature-reducer.js (the same code the live scan uses).
 * This file is only I/O: fetch ticks, fold them through the reducer, write the documents.
 *
 * Methods produced:  linear (high-temp)  and  reciprocal.   NOT combined (see reducer notes:
 * the two votes of one scrape arrive in a random order and ticks have no scrape id).
 *
 * SAFE BY DEFAULT: with no flag this is a DRY RUN. It reads, prints counts, and writes nothing.
 *
 * Usage:
 *   MONGO_URI="..." node stats/build-feature-table.js                  # dry run, last 7 days (+1 day margin)
 *   MONGO_URI="..." node stats/build-feature-table.js --days=30        # dry run, wider window
 *   MONGO_URI="..." node stats/build-feature-table.js --force          # dry run, all history
 *   MONGO_URI="..." node stats/build-feature-table.js --force --apply --backup-legacy=stats_features_legacy_YYYYMMDD
 *   MONGO_URI="..." node stats/build-feature-table.js --days=7 --apply # incremental write
 *
 * Flags:
 *   --dry-run                  default. Print counts only.
 *   --apply                    write to the output collection.
 *   --force                    all history (otherwise --days=N, default 7, plus one safety day).
 *   --city=NAME                restrict to one city.
 *   --out=COLLECTION           output collection (default stats_features). Never a tick collection.
 *   --backup-legacy=NAME       before the first overwrite, copy every non-v2 document of the output
 *                              collection into the NEW collection NAME ($out). Aborts if NAME exists.
 *   --allow-overwrite-legacy   overwrite legacy documents WITHOUT a backup (not recommended).
 *
 * Guards:
 *   - Incremental runs (no --force) refuse unless v2 documents already exist and every one of
 *     them has the current definition_hash.
 *   - A --force --apply refuses to overwrite legacy (non-v2) documents unless a backup or the
 *     explicit allow flag is given.
 *   - Nothing here ever writes to `high-temp` or `reciprocal`, and nothing is ever deleted.
 *
 * Ordering: ticks are sorted in JavaScript by (captured_at epoch ms, collection rank, _id), never
 * by a Mongo sort, because captured_at may be an ISO string or a Date.
 * Day window: local_date is not UTC, so the incremental cutoff has one extra safety day.
 */

'use strict';

const R = require('../shared/feature-reducer.js');

const BATCH_SIZE = 500;
const DEFAULT_OUT = 'stats_features';
const TICK_COLLECTIONS = [
  { collection: 'high-temp', method: 'linear' },
  { collection: 'reciprocal', method: 'reciprocal' },
];
const PROTECTED_COLLECTIONS = new Set(['high-temp', 'reciprocal']);
const KNOWN_FLAGS = new Set([
  'dry-run', 'apply', 'force', 'days', 'city', 'out', 'backup-legacy', 'allow-overwrite-legacy',
]);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const [k, ...rest] = a.slice(2).split('=');
    if (!KNOWN_FLAGS.has(k)) throw new Error(`unknown flag: --${k}`);
    args[k] = rest.length ? rest.join('=') : true;
  }
  for (const flag of ['dry-run', 'apply', 'force', 'allow-overwrite-legacy']) {
    if (args[flag] !== undefined && args[flag] !== true) throw new Error(`--${flag} takes no value`);
  }
  const apply = args.apply === true;
  if (apply && args['dry-run'] === true) throw new Error('--apply and --dry-run are mutually exclusive');

  const force = args.force === true;
  let days = null;
  if (!force) {
    days = args.days === undefined ? 7 : parseInt(args.days, 10);
    if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
  }

  const out = typeof args.out === 'string' ? args.out : DEFAULT_OUT;
  if (!/^[A-Za-z0-9_.-]+$/.test(out)) throw new Error(`invalid --out collection name: ${out}`);
  if (PROTECTED_COLLECTIONS.has(out)) throw new Error(`--out may never be a tick collection (${out})`);

  const backupLegacy = typeof args['backup-legacy'] === 'string' ? args['backup-legacy'] : null;
  if (backupLegacy !== null) {
    if (!/^[A-Za-z0-9_.-]+$/.test(backupLegacy)) throw new Error(`invalid --backup-legacy name: ${backupLegacy}`);
    if (PROTECTED_COLLECTIONS.has(backupLegacy) || backupLegacy === out) {
      throw new Error('--backup-legacy must be a new collection');
    }
  }

  return {
    apply,
    force,
    days,
    city: typeof args.city === 'string' ? args.city : null,
    out,
    backupLegacy,
    allowOverwriteLegacy: args['allow-overwrite-legacy'] === true,
  };
}

/** Cutoff for local_date: `days` ago in UTC, minus one extra day because local_date is not UTC. */
function dateFromForDays(days, now) {
  if (days === null || days === undefined) return null;
  const d = new Date(now || Date.now());
  d.setUTCDate(d.getUTCDate() - days - 1);
  return d.toISOString().slice(0, 10);
}

function normBracket(b) {
  if (b === null || b === undefined) return null;
  const s = String(b).trim();
  return s === '' ? null : s;
}

function incrementalGuard(state, currentHash) {
  if (state.v2Count === 0) {
    return {
      ok: false,
      reason: 'no feature_version 2 documents exist yet; run once with --force (all history) first',
    };
  }
  const others = state.hashes.map(String).filter((h) => h !== currentHash);
  if (others.length > 0) {
    return {
      ok: false,
      reason:
        `existing v2 documents have a different definition_hash (${others.join(', ')}; ` +
        `current ${currentHash}); rebuild with --force`,
    };
  }
  return { ok: true };
}

function legacyGuard(state) {
  if (state.legacyCount === 0) return { ok: true, action: 'none' };
  if (state.backupLegacy) return { ok: true, action: 'backup', name: state.backupLegacy };
  if (state.allowOverwriteLegacy) return { ok: true, action: 'overwrite_without_backup' };
  return {
    ok: false,
    reason:
      `${state.legacyCount} legacy (non-v2) documents would be overwritten and cannot be restored. ` +
      'Re-run with --backup-legacy=<new collection name> (recommended) or --allow-overwrite-legacy.',
  };
}

function edgeFor(resolved, hasPrice, won, price) {
  if (!(resolved && hasPrice && won !== null)) return null;
  return won ? 100 - price : -price;
}

/** Ticks of one collection -> votes, counting why ticks were ignored. */
function toVotes(docs, collection, stats) {
  const votes = [];
  for (const d of docs) {
    stats.ticks += 1;
    if (!d || !d.city || !d.local_date) {
      stats.ignored.no_city_or_date = (stats.ignored.no_city_or_date || 0) + 1;
      continue;
    }
    const { vote, reason } = R.normalizeTickDetailed(d, collection);
    if (!vote) {
      stats.ignored[reason] = (stats.ignored[reason] || 0) + 1;
      continue;
    }
    votes.push(vote);
  }
  return votes;
}

function newStats() {
  return { ticks: 0, ignored: {}, votes: 0, days: 0, docs: 0, lateVotes: 0, snapshotsByHour: new Array(R.NUM_HOURS).fill(0) };
}

/**
 * One method: tick docs of its collection -> feature documents (one per day x bracket).
 * `winners` maps "city|local_date" -> winning bracket title.
 */
function buildDocsForMethod({ docs, collection, method, winners, computedAt, stats }) {
  const st = stats || newStats();
  const votes = toVotes(docs, collection, st);
  st.votes += votes.length;

  const byDay = new Map();
  for (const v of votes) {
    const key = `${v.city}|${v.local_date}`;
    let list = byDay.get(key);
    if (!list) byDay.set(key, (list = []));
    list.push(v);
  }

  const out = [];
  for (const [key, dayVotes] of byDay) {
    const res = R.reduceDay(dayVotes);
    st.days += 1;
    st.lateVotes += res.late_votes;
    res.snapshots.forEach((s, n) => { if (s) st.snapshotsByHour[n] += 1; });

    const winner = winners.get(key) ?? null;
    const resolved = winner !== null;
    const city = dayVotes[0].city;
    const local_date = dayVotes[0].local_date;

    for (const b of res.brackets) {
      const won = resolved ? b.bracket === winner : null;
      out.push({
        city,
        local_date,
        bracket: b.bracket,
        method,
        feature_version: res.feature_version,
        definition_hash: res.definition_hash,
        late_votes: res.late_votes,
        // first-tick dimensions (price, first_tick_hour) read these
        first_tick_price_cents: b.first_tick_price_cents,
        first_tick_hour: b.first_tick_hour,
        has_price: b.has_price,
        // point-in-time arrays, length 10, null when there is no snapshot for that hour
        snapshot_ts: b.snapshot_ts,
        snapshot_seq: b.snapshot_seq,
        snapshot_vote_bracket: b.snapshot_vote_bracket,
        tick_count_asof: b.tick_count_asof,
        rank_asof: b.rank_asof,
        rank_comp_asof: b.rank_comp_asof,
        is_leader_asof: b.is_leader_asof,
        lead_margin_asof: b.lead_margin_asof,
        total_votes_asof: b.total_votes_asof,
        entry_price_cents: b.entry_price_cents,
        entry_price_source: b.entry_price_source,
        entry_price_age_s: b.entry_price_age_s,
        rank_trend_asof: b.rank_trend_asof,
        // outcome / end-of-day fields (not pinnable)
        final_tick_count: b.final_tick_count,
        final_rank: b.final_rank,
        resolved,
        won,
        edge_cents: edgeFor(resolved, b.has_price, won, b.first_tick_price_cents),
        computed_at: computedAt,
      });
    }
  }
  st.docs += out.length;
  return out;
}

// ---------------------------------------------------------------------------
// Database helpers (only used by main; never run by the tests)
// ---------------------------------------------------------------------------

async function fetchTicks(col, dateFrom, city) {
  const match = { bracket: { $ne: null, $exists: true } };
  if (city) match.city = city;
  if (dateFrom) match.local_date = { $gte: dateFrom };
  return col
    .find(match, {
      projection: {
        city: 1, local_date: 1, bracket: 1, pacing_time: 1, captured_at: 1,
        yes_price_cents: 1, prices_all: 1,
      },
    })
    .toArray();
}

/**
 * winning_bracket per "city|date". Sorted before $first so the pick is deterministic, and every
 * distinct value is collected so a day with more than one winner can be reported.
 */
async function fetchWinners(col, label, dateFrom, city, into, warnings) {
  const match = { winning_bracket: { $ne: null, $exists: true } };
  if (city) match.city = city;
  if (dateFrom) match.local_date = { $gte: dateFrom };
  const rows = await col
    .aggregate(
      [
        { $match: match },
        { $sort: { captured_at: 1, _id: 1 } },
        {
          $group: {
            _id: { city: '$city', local_date: '$local_date' },
            winning_bracket: { $first: '$winning_bracket' },
            all: { $addToSet: '$winning_bracket' },
          },
        },
      ],
      { allowDiskUse: true }
    )
    .toArray();
  for (const r of rows) {
    const key = `${r._id.city}|${r._id.local_date}`;
    const distinct = [...new Set(r.all.map(normBracket).filter(Boolean))];
    if (distinct.length > 1) {
      warnings.push(`WARNING ${label} ${key}: more than one winning_bracket value: ${distinct.join(' | ')}`);
    }
    const w = normBracket(r.winning_bracket);
    if (w === null) continue;
    if (into.has(key) && into.get(key) !== w) {
      warnings.push(`WARNING ${key}: winner differs between collections (${into.get(key)} vs ${w} in ${label}); keeping the first`);
      continue;
    }
    if (!into.has(key)) into.set(key, w);
  }
}

async function readGuardState(outCol) {
  const [v2Count, hashes, legacyCount] = await Promise.all([
    outCol.countDocuments({ feature_version: 2 }),
    outCol.distinct('definition_hash', { feature_version: 2 }),
    outCol.countDocuments({ feature_version: { $ne: 2 } }),
  ]);
  return { v2Count, hashes, legacyCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  require('dotenv').config();
  const opts = parseArgs(argv);
  if (!process.env.MONGO_URI) {
    console.error('Set the MONGO_URI environment variable first.');
    process.exit(1);
  }
  const { MongoClient } = require('mongodb');

  const dateFrom = opts.force ? null : dateFromForDays(opts.days);
  console.log(`Mode: ${opts.apply ? 'APPLY (writes to ' + opts.out + ')' : 'DRY RUN (no writes)'}`);
  console.log(
    opts.force
      ? 'Window: full history (--force)'
      : `Window: incremental --days=${opts.days}, local_date >= ${dateFrom} (includes one safety day)`
  );
  console.log(`Output collection: ${opts.out}`);
  console.log(`feature_version=${R.FEATURE_VERSION} definition_hash=${R.DEFINITION_HASH}`);
  if (opts.city) console.log(`City filter: ${opts.city}`);

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db('weather');
    const outCol = db.collection(opts.out);

    const guardState = await readGuardState(outCol);
    console.log(
      `Output collection now: ${guardState.v2Count} v2 docs, ${guardState.legacyCount} legacy (non-v2) docs, ` +
      `v2 hashes: [${guardState.hashes.join(', ')}]`
    );

    if (!opts.force) {
      const g = incrementalGuard(guardState, R.DEFINITION_HASH);
      if (!g.ok && opts.apply) {
        console.error(`REFUSING incremental run: ${g.reason}`);
        process.exitCode = 1;
        return;
      }
      if (!g.ok) console.log(`NOTE: a real incremental --apply would be REFUSED: ${g.reason}`);
    }

    const warnings = [];
    const winners = new Map();
    for (const t of TICK_COLLECTIONS) {
      await fetchWinners(db.collection(t.collection), t.collection, dateFrom, opts.city, winners, warnings);
    }
    console.log(`Resolved city-dates: ${winners.size.toLocaleString()}`);
    warnings.forEach((w) => console.warn(w));

    const computedAt = new Date();
    const allDocs = [];
    for (const t of TICK_COLLECTIONS) {
      const ticks = await fetchTicks(db.collection(t.collection), dateFrom, opts.city);
      const stats = newStats();
      const docs = buildDocsForMethod({ docs: ticks, collection: t.collection, method: t.method, winners, computedAt, stats });
      console.log(
        `\n[${t.method}] ticks=${stats.ticks.toLocaleString()} votes=${stats.votes.toLocaleString()} ` +
        `city-days=${stats.days.toLocaleString()} feature docs=${stats.docs.toLocaleString()} late_votes=${stats.lateVotes}`
      );
      console.log(`  ignored ticks: ${JSON.stringify(stats.ignored)}`);
      console.log(`  city-days with a snapshot, by hour 0..9: ${stats.snapshotsByHour.join(' ')}`);
      allDocs.push(...docs);
    }

    if (!opts.apply) {
      const lg = legacyGuard({ legacyCount: guardState.legacyCount, backupLegacy: opts.backupLegacy, allowOverwriteLegacy: opts.allowOverwriteLegacy });
      console.log(`\nDRY RUN: would write ${allDocs.length.toLocaleString()} documents to ${opts.out}. Nothing was written.`);
      if (opts.force && !lg.ok) console.log(`Note: a real --force --apply would currently be refused: ${lg.reason}`);
      if (opts.force && lg.ok && lg.action === 'backup') console.log(`A real run would first back up legacy docs into new collection ${lg.name}.`);
      return;
    }

    // ---- APPLY ----
    if (opts.force) {
      const lg = legacyGuard({ legacyCount: guardState.legacyCount, backupLegacy: opts.backupLegacy, allowOverwriteLegacy: opts.allowOverwriteLegacy });
      if (!lg.ok) {
        console.error(`REFUSING to write: ${lg.reason}`);
        process.exitCode = 1;
        return;
      }
      if (lg.action === 'backup') {
        const exists = await db.listCollections({ name: lg.name }, { nameOnly: true }).hasNext();
        if (exists) {
          console.error(`REFUSING to write: backup collection ${lg.name} already exists`);
          process.exitCode = 1;
          return;
        }
        await outCol.aggregate([{ $match: { feature_version: { $ne: 2 } } }, { $out: lg.name }]).toArray();
        const copied = await db.collection(lg.name).countDocuments({});
        console.log(`Backed up ${copied} legacy docs into ${lg.name}`);
        if (copied !== guardState.legacyCount) {
          console.error(`REFUSING to write: backup has ${copied} docs, expected ${guardState.legacyCount}`);
          process.exitCode = 1;
          return;
        }
      }
    }

    await outCol.createIndex(
      { city: 1, local_date: 1, bracket: 1, method: 1 },
      { unique: true, name: 'city_date_bracket_method_unique' }
    );
    await outCol.createIndex({ method: 1, city: 1, local_date: 1 }, { name: 'method_city_date' });
    await outCol.createIndex({ local_date: 1 }, { name: 'local_date' });
    console.log('Indexes ensured on ' + opts.out);

    for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
      const batch = allDocs.slice(i, i + BATCH_SIZE);
      await outCol.bulkWrite(
        batch.map((doc) => ({
          replaceOne: {
            filter: { city: doc.city, local_date: doc.local_date, bracket: doc.bracket, method: doc.method },
            replacement: doc,
            upsert: true,
          },
        })),
        { ordered: false }
      );
      process.stdout.write(`  upserted ${Math.min(i + BATCH_SIZE, allDocs.length)}/${allDocs.length}\r`);
    }
    console.log(`\nComplete. Wrote ${allDocs.length.toLocaleString()} documents. computed_at: ${computedAt.toISOString()}`);
  } finally {
    await client.close();
  }
}

module.exports = {
  parseArgs,
  dateFromForDays,
  incrementalGuard,
  legacyGuard,
  edgeFor,
  newStats,
  toVotes,
  buildDocsForMethod,
  PROTECTED_COLLECTIONS,
  TICK_COLLECTIONS,
  DEFAULT_OUT,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}
