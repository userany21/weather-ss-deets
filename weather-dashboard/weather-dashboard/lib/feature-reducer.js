'use strict';
/**
 * shared/feature-reducer.js  --  SOURCE OF TRUTH for point-in-time ("as of T_N") features.
 *
 * Pure module: no file or network access, no environment reads, no database client.
 * CommonJS so the Node builder can require() it directly.
 *
 * The Next app uses a byte-identical COPY at
 *   weather-dashboard/weather-dashboard/lib/feature-reducer.js
 * kept in sync with `node scripts/sync-feature-reducer.js`. A test fails when the copies differ.
 * Edit THIS file only.
 *
 * ONE code path: FeatureReducer.push() does all the computing. reduceDay() is only
 * sort + fold over push().
 *
 * Spec summary
 *   VOTE      tick with a non-empty bracket and pacing hour 8..17 (bucket N = hour - 8).
 *   ORDER     (captured_at epoch ms, collection rank linear=0 / reciprocal=1, _id string).
 *   T_N       first vote, in that order, whose bucket is N (one stream per method).
 *   SNAPSHOT  frozen when T_N is processed, includes the T_N vote, counts from bucket 0.
 *   LATE VOTE bucket lower than the highest bucket already seen: counted in running
 *             totals for later snapshots only, never creates a snapshot, adds to late_votes.
 *   NO TICK   no snapshot N: every hour-N field is null (nothing is carried forward).
 */

const FEATURE_VERSION = 2;
const NUM_HOURS = 10;
const START_HOUR = 8;
const END_HOUR = 18;
const DEFAULT_MAX_STALE_MS = 30 * 60 * 1000;
const METHODS = Object.freeze(['linear', 'reciprocal']);
const COLLECTION_RANK = Object.freeze({ linear: 0, reciprocal: 1 });
const COLLECTION_ALIASES = Object.freeze({
  'high-temp': 'linear',
  linear: 'linear',
  reciprocal: 'reciprocal',
});
const ENTRY_SOURCE = Object.freeze({
  TICK_AT_TN: 'tick_at_T_N',
  PRICES_ALL: 'prices_all_at_T_N',
  LAST_TICK: 'last_tick_before_T_N',
  NONE: 'none',
});
const TRUSTED_ENTRY_SOURCES = Object.freeze([ENTRY_SOURCE.TICK_AT_TN, ENTRY_SOURCE.PRICES_ALL]);

// ---------------------------------------------------------------------------
// Normalizing ticks into votes
// ---------------------------------------------------------------------------

/** "2:02 PM" -> { hour24, minute } or null. */
function parsePacing(pt) {
  if (typeof pt !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(pt.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = m[3].toUpperCase() === 'PM';
  if (pm && hour !== 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  return { hour24: hour, minute };
}

/** Pacing string -> bucket 0..9 (8AM..5PM) or null outside 8:00-17:59 / unparseable. */
function pacingBucket(pt) {
  const p = parsePacing(pt);
  if (!p || p.hour24 < START_HOUR || p.hour24 >= END_HOUR) return null;
  return p.hour24 - START_HOUR;
}

/** captured_at as ISO string, Date, or epoch number -> epoch ms (NaN when unusable). */
function toEpochMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  if (typeof v === 'number') return v;
  return NaN;
}

/**
 * Tick document -> { vote, reason }. vote is null when the tick must be ignored everywhere.
 * `collection` is 'linear' | 'high-temp' | 'reciprocal'.
 */
function normalizeTickDetailed(doc, collection) {
  const coll = COLLECTION_ALIASES[collection];
  if (coll === undefined) throw new Error('unknown collection: ' + collection);
  if (!doc) return { vote: null, reason: 'no_doc' };

  const bracket = doc.bracket == null ? '' : String(doc.bracket).trim();
  if (!bracket) return { vote: null, reason: 'no_bracket' };

  const p = parsePacing(doc.pacing_time);
  if (!p || p.hour24 < START_HOUR || p.hour24 >= END_HOUR) {
    return { vote: null, reason: 'outside_window_or_bad_pacing' };
  }

  const t = toEpochMs(doc.captured_at);
  if (!Number.isFinite(t)) return { vote: null, reason: 'bad_captured_at' };
  if (doc._id === undefined || doc._id === null) return { vote: null, reason: 'no_id' };

  let pricesAll = null;
  if (doc.prices_all && typeof doc.prices_all === 'object') {
    const m = new Map();
    for (const k of Object.keys(doc.prices_all)) {
      const val = doc.prices_all[k];
      if (typeof val === 'number' && Number.isFinite(val)) m.set(String(k).trim(), val);
    }
    if (m.size > 0) pricesAll = m;
  }

  return {
    vote: {
      id: String(doc._id),
      collection: coll,
      coll: COLLECTION_RANK[coll],
      t,
      hour: p.hour24 - START_HOUR,
      pacingMinutes: p.hour24 * 60 + p.minute,
      bracket,
      price:
        typeof doc.yes_price_cents === 'number' && Number.isFinite(doc.yes_price_cents)
          ? doc.yes_price_cents
          : null,
      pricesAll,
      city: doc.city,
      local_date: doc.local_date,
    },
    reason: null,
  };
}

function normalizeTick(doc, collection) {
  return normalizeTickDetailed(doc, collection).vote;
}

/** Array of tick docs from one collection -> array of votes (ignored ticks dropped). */
function votesFromTicks(docs, collection) {
  const out = [];
  for (const d of docs) {
    const v = normalizeTick(d, collection);
    if (v) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function compareVotes(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.coll !== b.coll) return a.coll < b.coll ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function sortVotes(votes) {
  return votes.slice().sort(compareVotes);
}

// ---------------------------------------------------------------------------
// Brackets
// ---------------------------------------------------------------------------

/** Low bound of a bracket title: "68-69°F" 68, "30°C" 30, "x or below" -Infinity. */
function bracketLow(title) {
  const s = String(title);
  if (/or\s+below/i.test(s)) return -Infinity;
  const range = /^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/.exec(s);
  if (range) return parseFloat(range[1]);
  const num = /-?\d+(?:\.\d+)?/.exec(s);
  return num ? parseFloat(num[0]) : Infinity;
}

function compareBrackets(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Rank order: count desc, first-vote seq asc, bracket low asc, bracket string asc. */
function compareBracketRecords(a, b) {
  if (a.count !== b.count) return b.count - a.count;
  if (a.firstSeq !== b.firstSeq) return a.firstSeq - b.firstSeq;
  if (a.low < b.low) return -1;
  if (a.low > b.low) return 1;
  return compareBrackets(a.bracket, b.bracket);
}

function isTrustedSource(source) {
  return TRUSTED_ENTRY_SOURCES.indexOf(source) !== -1;
}

/**
 * Entry price for one bracket at the T_N vote.
 *   1. the T_N vote is this bracket and has a price      -> tick_at_T_N        (trusted)
 *   2. the T_N tick carries prices_all with this bracket -> prices_all_at_T_N  (trusted)
 *   3. earlier priced vote of this bracket, age <= max   -> last_tick_before_T_N (research)
 *   4. otherwise                                         -> none
 */
function resolveEntryPrice(vote, rec, maxStaleMs) {
  if (vote.bracket === rec.bracket && vote.price !== null) {
    return { price: vote.price, source: ENTRY_SOURCE.TICK_AT_TN, ageS: 0 };
  }
  if (vote.pricesAll && vote.pricesAll.has(rec.bracket)) {
    return { price: vote.pricesAll.get(rec.bracket), source: ENTRY_SOURCE.PRICES_ALL, ageS: 0 };
  }
  if (rec.lastPrice !== null) {
    const age = vote.t - rec.lastPriceT;
    if (age >= 0 && age <= maxStaleMs) {
      return { price: rec.lastPrice, source: ENTRY_SOURCE.LAST_TICK, ageS: Math.round(age / 1000) };
    }
  }
  return { price: null, source: ENTRY_SOURCE.NONE, ageS: null };
}

/** "rising" when rank improved (smaller number), "falling" when worse, else "stable". */
function rankTrend(now, prev) {
  if (now == null || prev == null) return null;
  if (now < prev) return 'rising';
  if (now > prev) return 'falling';
  return 'stable';
}

// ---------------------------------------------------------------------------
// The reducer (the ONE code path)
// ---------------------------------------------------------------------------

class FeatureReducer {
  constructor(opts) {
    const o = opts || {};
    this.maxStaleMs = Number.isFinite(o.maxStaleMs) ? o.maxStaleMs : DEFAULT_MAX_STALE_MS;
    this.seen = new Set();
    this.seq = 0;
    this.maxBucket = -1;
    this.lateVotes = 0;
    this.orderViolations = 0;
    this.lastVote = null;
    this.brackets = new Map();
    this.snapshots = new Array(NUM_HOURS).fill(null);
    this.firstVote = null;
  }

  /**
   * Feed one vote (in sorted order). Returns true when this vote created a snapshot.
   * Duplicates (same collection + _id) and null votes are ignored.
   */
  push(vote) {
    if (!vote) return false;
    const key = vote.coll + ':' + vote.id;
    if (this.seen.has(key)) return false;
    this.seen.add(key);

    if (this.lastVote === null || compareVotes(vote, this.lastVote) >= 0) {
      this.lastVote = vote;
    } else {
      this.orderViolations += 1;
    }

    this.seq += 1;
    const late = vote.hour < this.maxBucket;
    if (late) this.lateVotes += 1;
    else this.maxBucket = vote.hour;

    let rec = this.brackets.get(vote.bracket);
    if (!rec) {
      rec = {
        bracket: vote.bracket,
        low: bracketLow(vote.bracket),
        count: 0,
        firstSeq: this.seq,
        firstPrice: vote.price,
        firstHour: vote.hour,
        lastPrice: null,
        lastPriceT: null,
      };
      this.brackets.set(vote.bracket, rec);
    }
    rec.count += 1;

    if (this.firstVote === null) {
      this.firstVote = {
        bracket: vote.bracket,
        pacing_minutes: vote.pacingMinutes,
        captured_at: new Date(vote.t).toISOString(),
        seq: this.seq,
        price: vote.price,
      };
    }

    let created = false;
    if (!late && this.snapshots[vote.hour] === null) {
      this.snapshots[vote.hour] = this._takeSnapshot(vote);
      created = true;
    }

    // Updated AFTER the snapshot: the entry price for the voting bracket is handled by
    // rule 1; every other bracket only ever looks at votes strictly before T_N.
    if (vote.price !== null) {
      rec.lastPrice = vote.price;
      rec.lastPriceT = vote.t;
    }
    return created;
  }

  _takeSnapshot(vote) {
    const recs = Array.from(this.brackets.values()).sort(compareBracketRecords);
    let total = 0;
    for (const r of recs) total += r.count;
    const top1 = recs[0].count;
    const top2 = recs.length > 1 ? recs[1].count : 0;

    const per = new Map();
    let prevCount = null;
    let prevComp = 0;
    recs.forEach((r, i) => {
      const comp = prevCount !== null && r.count === prevCount ? prevComp : i + 1;
      prevCount = r.count;
      prevComp = comp;
      const e = resolveEntryPrice(vote, r, this.maxStaleMs);
      per.set(r.bracket, {
        count: r.count,
        rank: i + 1,
        rankComp: comp,
        isLeader: r.count > 0 && r.count === top1,
        entryPrice: e.price,
        entrySource: e.source,
        entryAgeS: e.ageS,
      });
    });

    return {
      hour: vote.hour,
      ts: new Date(vote.t).toISOString(),
      seq: this.seq,
      voteBracket: vote.bracket,
      total,
      leadMargin: (top1 - top2) / total,
      brackets: per,
    };
  }

  /** Plain JSON-safe result. Does not mutate the reducer. */
  result() {
    const recs = Array.from(this.brackets.values());
    const finalRank = new Map(
      recs
        .slice()
        .sort(compareBracketRecords)
        .map((r, i) => [r.bracket, i + 1])
    );

    const rows = recs
      .slice()
      .sort((a, b) => a.firstSeq - b.firstSeq)
      .map((rec) => {
        const arr = () => new Array(NUM_HOURS).fill(null);
        const row = {
          bracket: rec.bracket,
          first_tick_price_cents: rec.firstPrice,
          first_tick_hour: rec.firstHour,
          has_price: rec.firstPrice !== null,
          snapshot_ts: arr(),
          snapshot_seq: arr(),
          snapshot_vote_bracket: arr(),
          tick_count_asof: arr(),
          rank_asof: arr(),
          rank_comp_asof: arr(),
          is_leader_asof: arr(),
          lead_margin_asof: arr(),
          total_votes_asof: arr(),
          entry_price_cents: arr(),
          entry_price_source: arr(),
          entry_price_age_s: arr(),
          rank_trend_asof: arr(),
        };
        for (let n = 0; n < NUM_HOURS; n++) {
          const snap = this.snapshots[n];
          if (!snap) continue;
          row.snapshot_ts[n] = snap.ts;
          row.snapshot_seq[n] = snap.seq;
          row.snapshot_vote_bracket[n] = snap.voteBracket;
          row.total_votes_asof[n] = snap.total;
          row.lead_margin_asof[n] = snap.leadMargin;
          const s = snap.brackets.get(rec.bracket);
          if (s) {
            row.tick_count_asof[n] = s.count;
            row.rank_asof[n] = s.rank;
            row.rank_comp_asof[n] = s.rankComp;
            row.is_leader_asof[n] = s.isLeader;
            row.entry_price_cents[n] = s.entryPrice;
            row.entry_price_source[n] = s.entrySource;
            row.entry_price_age_s[n] = s.entryAgeS;
          } else {
            row.tick_count_asof[n] = 0;
            row.is_leader_asof[n] = false;
            row.entry_price_source[n] = ENTRY_SOURCE.NONE;
          }
        }
        for (let n = 2; n < NUM_HOURS; n++) {
          row.rank_trend_asof[n] = rankTrend(row.rank_asof[n], row.rank_asof[n - 2]);
        }
        row.final_tick_count = rec.count;
        row.final_rank = finalRank.get(rec.bracket);
        return row;
      });

    return {
      feature_version: FEATURE_VERSION,
      definition_hash: DEFINITION_HASH,
      late_votes: this.lateVotes,
      order_violations: this.orderViolations,
      total_votes: this.seq,
      first_vote: this.firstVote ? Object.assign({}, this.firstVote) : null,
      snapshots: this.snapshots.map((s) =>
        s
          ? {
              hour: s.hour,
              ts: s.ts,
              seq: s.seq,
              vote_bracket: s.voteBracket,
              total_votes: s.total,
              lead_margin: s.leadMargin,
            }
          : null
      ),
      brackets: rows,
    };
  }
}

/** Batch = sort + fold over push(). No separate algorithm. */
function reduceDay(votes, opts) {
  const r = new FeatureReducer(opts);
  for (const v of sortVotes(votes)) r.push(v);
  return r.result();
}

// ---------------------------------------------------------------------------
// definition_hash: fingerprint of the algorithm (constants + source of every function).
// Non-cryptographic (two FNV-1a passes). Authoritative only when computed under plain
// Node; a minified bundle yields a different string, so the dashboard reads the hash
// that is stored on documents instead of recomputing it.
// ---------------------------------------------------------------------------

function stripSource(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function hashHex(str) {
  const a = fnv1a32(str, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a32(str, 0x9e3779b9).toString(16).padStart(8, '0');
  return a + b;
}

const HASHED_FUNCTIONS = {
  parsePacing,
  pacingBucket,
  toEpochMs,
  normalizeTickDetailed,
  normalizeTick,
  votesFromTicks,
  compareVotes,
  sortVotes,
  bracketLow,
  compareBrackets,
  compareBracketRecords,
  isTrustedSource,
  resolveEntryPrice,
  rankTrend,
  FeatureReducer,
  reduceDay,
};
const HASHED_NAMES = Object.freeze(Object.keys(HASHED_FUNCTIONS));
const UNHASHED_NAMES = Object.freeze(['stripSource', 'fnv1a32', 'hashHex', 'computeDefinitionHash']);

function computeDefinitionHash() {
  const constants = JSON.stringify({
    FEATURE_VERSION,
    NUM_HOURS,
    START_HOUR,
    END_HOUR,
    DEFAULT_MAX_STALE_MS,
    COLLECTION_RANK,
    ENTRY_SOURCE,
    TRUSTED_ENTRY_SOURCES,
    TIE_BREAK: 'count desc, firstSeq asc, low asc, bracket asc',
  });
  const parts = HASHED_NAMES.map((n) => n + '=' + stripSource(HASHED_FUNCTIONS[n].toString()));
  return hashHex(constants + '\n' + parts.join('\n'));
}

const DEFINITION_HASH = computeDefinitionHash();

module.exports = {
  FEATURE_VERSION,
  NUM_HOURS,
  START_HOUR,
  END_HOUR,
  DEFAULT_MAX_STALE_MS,
  METHODS,
  ENTRY_SOURCE,
  TRUSTED_ENTRY_SOURCES,
  DEFINITION_HASH,
  HASHED_NAMES,
  UNHASHED_NAMES,
  computeDefinitionHash,
  isTrustedSource,
  parsePacing,
  pacingBucket,
  toEpochMs,
  normalizeTick,
  normalizeTickDetailed,
  votesFromTicks,
  compareVotes,
  sortVotes,
  bracketLow,
  compareBracketRecords,
  rankTrend,
  FeatureReducer,
  reduceDay,
};
