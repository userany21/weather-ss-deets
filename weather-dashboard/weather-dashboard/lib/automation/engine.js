'use strict';

/**
 * engine.js: pure decision logic for weather auto-buy.
 *
 * No Mongo, no Supabase, no fetch, no file I/O. Same standard as shared/feature-reducer.js.
 * It is plain CommonJS on purpose, so `node --test lib/automation/` runs with no new tooling.
 * Types live in engine.d.ts.
 *
 * THE CLOCK (applies to every rule)
 *   Hour bucket N = hour24 - 8. Bucket 0 is the 8AM hour, bucket 9 is the 5PM hour.
 *   A rule decides on exactly one bucket, called the decision bucket:
 *     rank_at_hour, leader, lead_margin, rank_trend  read the hour BEFORE their label -> bucket n - 1
 *     price_at_hour                                  reads the price inside hour n     -> bucket n
 *   If a pin mixes dimensions, the decision bucket is the latest of them.
 *   The order is sent on the CLOSING TICK of the decision bucket: the last tick in that
 *   clock hour at or after the city's nominal closing minute. Not 9AM. Not 10AM. Not the next hour's first tick.
 *   "Rank 1 before 12PM" is rank_at_hour n=4 -> bucket 3 -> the last 11AM tick at or after the close.
 *
 *   Closing minute = offset + floor((59 - offset) / cadence) * cadence
 *     15 min, offset 0   -> :45        (US cities, nominal)
 *     10 min, offset 0   -> :50        (Hong Kong)
 *     30 min, offset 0   -> :30        (Beijing, Shanghai, Tokyo, Seoul, Singapore, Madrid, Paris)
 *     30 min, offset 20  -> :50        (London, Munich, Milan)
 *     30 min, offset 25  -> :55        (Amsterdam)
 *     60 min, offset 0   -> :00        (Shenzhen)
 *   Hong Kong close is :50.
 *   US nominal close is :45. Real labels are :47 to :53, matched as "last tick at or after :45".
 *   Seoul never prints :45. Waiting for it means Seoul never fires.
 *
 *   Rules with no hour-timed dimension decide on the city's first valid prediction (FIRST_TICK_WINDOW).
 *   Rules with an end-of-day dimension (final_rank, final_tick_count) are never tradeable.
 */

const crypto = require('node:crypto');

const FIRST_HOUR24 = 8; // bucket 0
const LAST_HOUR24 = 17; // bucket 9

/** IANA zone plus tick cadence and offset (minutes) per city. Offsets come from the poll scripts. */
const CITY_SCHEDULE = Object.freeze({
  'san francisco': { tz: 'America/Los_Angeles', cadence: 15, offset: 0 },
  seattle: { tz: 'America/Los_Angeles', cadence: 15, offset: 0 },
  'los angeles': { tz: 'America/Los_Angeles', cadence: 15, offset: 0 },
  nyc: { tz: 'America/New_York', cadence: 15, offset: 0 },
  atlanta: { tz: 'America/New_York', cadence: 15, offset: 0 },
  miami: { tz: 'America/New_York', cadence: 15, offset: 0 },
  'hong kong': { tz: 'Asia/Hong_Kong', cadence: 10, offset: 0 },
  shenzhen: { tz: 'Asia/Shanghai', cadence: 60, offset: 0 },
  beijing: { tz: 'Asia/Shanghai', cadence: 30, offset: 0 },
  shanghai: { tz: 'Asia/Shanghai', cadence: 30, offset: 0 },
  tokyo: { tz: 'Asia/Tokyo', cadence: 30, offset: 0 },
  seoul: { tz: 'Asia/Seoul', cadence: 30, offset: 0 },
  singapore: { tz: 'Asia/Singapore', cadence: 30, offset: 0 },
  london: { tz: 'Europe/London', cadence: 30, offset: 20 },
  munich: { tz: 'Europe/Berlin', cadence: 30, offset: 20 },
  milan: { tz: 'Europe/Rome', cadence: 30, offset: 20 },
  amsterdam: { tz: 'Europe/Amsterdam', cadence: 30, offset: 25 },
  madrid: { tz: 'Europe/Madrid', cadence: 30, offset: 0 },
  paris: { tz: 'Europe/Paris', cadence: 30, offset: 0 },
});

/**
 * Minute-of-day window [lo, hi] of each city's FIRST VALID PREDICTION.
 * Copied from FIRST_TICK_WINDOWS in lib/live-features.ts (hm(h, m) = h * 60 + m).
 * A rule with no hour-timed dimension fires on the tick whose pacing_time is inside this window.
 * Example: Shenzhen ticks at 8:00 but its first valid prediction is the 9:00 tick.
 */
const FIRST_TICK_WINDOW = Object.freeze({
  tokyo: [510, 510],
  shenzhen: [540, 540],
  seoul: [510, 510],
  beijing: [510, 510],
  shanghai: [510, 510],
  'hong kong': [490, 490],
  singapore: [510, 510],
  london: [500, 500],
  munich: [500, 500],
  milan: [500, 500],
  amsterdam: [505, 505],
  madrid: [510, 510],
  paris: [510, 510],
  'san francisco': [495, 505],
  seattle: [495, 505],
  'los angeles': [495, 505],
  nyc: [495, 505],
  atlanta: [495, 505],
  miami: [495, 505],
});

/** Registry defaults from lib/stats-aggregator.ts. /api/scan fills these in when `by` has no number. */
const DEFAULT_N = Object.freeze({
  leader: 1,
  rank_at_hour: 1,
  price_at_hour: 2,
  lead_margin: 1,
  rank_trend: 4,
});

const KNOWN_DIM_IDS = new Set([
  'price',
  'leader',
  'city',
  'method',
  'final_rank',
  'first_tick_hour',
  'day_of_week',
  'region',
  'rank_at_hour',
  'price_at_hour',
  'lead_margin',
  'rank_trend',
  'final_tick_count',
]);
const END_OF_DAY_DIMS = new Set(['final_rank', 'final_tick_count']);
const ASOF_DIMS = new Set(['rank_at_hour', 'leader', 'lead_margin', 'rank_trend']);
const IN_HOUR_DIMS = new Set(['price_at_hour']);

// ---------------------------------------------------------------------------------------------
// cities and the clock
// ---------------------------------------------------------------------------------------------

function cityKey(city) {
  return String(city == null ? '' : city).trim().toLowerCase();
}

function scheduleFor(city) {
  const k = cityKey(city);
  return Object.prototype.hasOwnProperty.call(CITY_SCHEDULE, k) ? CITY_SCHEDULE[k] : null;
}

/** Minute-of-hour of the last scheduled tick in any clock hour. Null for an unknown city. */
function closingMinute(city) {
  const s = scheduleFor(city);
  if (!s) return null;
  return s.offset + Math.floor((59 - s.offset) / s.cadence) * s.cadence;
}

/** Every scheduled minute-of-hour for a city, ascending. */
function ticksInHour(city) {
  const s = scheduleFor(city);
  if (!s) return [];
  const out = [];
  for (let m = s.offset; m < 60; m += s.cadence) out.push(m);
  return out;
}

/** US labels move by a few minutes, so an exact match cannot work. */
function pickClosingTicks(items, hour24, minMinute) {
  const kept = [];
  for (const item of items) {
    if (item.p.hour24 === hour24 && item.p.minute >= minMinute) kept.push(item);
  }
  if (kept.length === 0) return [];
  let highest = kept[0].p.minute;
  for (const item of kept) {
    if (item.p.minute > highest) highest = item.p.minute;
  }
  return kept.filter((item) => item.p.minute === highest);
}

/** "11:30 AM" -> { hour24: 11, minute: 30 }. Null when it does not parse. */
function parsePacingTime(label) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s*$/.exec(String(label == null ? '' : label));
  if (!m) return null;
  const h12 = Number(m[1]);
  const minute = Number(m[2]);
  if (h12 < 1 || h12 > 12 || minute > 59) return null;
  const pm = m[3].toLowerCase() === 'p';
  return { hour24: (h12 % 12) + (pm ? 12 : 0), minute };
}

function formatLabel(hour24, minute) {
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

/** Wall-clock parts of an instant in an IANA zone. */
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

// ---------------------------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------------------------

/** "rank_at_hour:4,city" -> [{ id, arg, n }]. Throws on an unknown dimension. */
function parseBy(by) {
  const specs = [];
  for (const raw of String(by == null ? '' : by).split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const i = part.indexOf(':');
    const id = (i < 0 ? part : part.slice(0, i)).trim();
    const arg = i < 0 ? null : part.slice(i + 1).trim();
    if (!KNOWN_DIM_IDS.has(id)) throw new Error(`unknown dimension "${id}"`);
    let n = null;
    if (arg !== null && arg !== '' && Number.isFinite(parseFloat(arg))) n = parseFloat(arg);
    else if (Object.prototype.hasOwnProperty.call(DEFAULT_N, id)) n = DEFAULT_N[id];
    specs.push({ id, arg, n });
  }
  if (specs.length === 0) throw new Error('rule has no dimensions');
  return specs;
}

/**
 * Decide when a rule may fire.
 *   { kind: 'closing', bucket }  fire on the closing tick of that hour bucket
 *   { kind: 'first_tick' }       fire on the city-day's first tick
 *   { kind: 'never', reason }    never tradeable
 */
function classifyBy(specs) {
  for (const s of specs) {
    if (END_OF_DAY_DIMS.has(s.id)) return { kind: 'never', reason: `${s.id} is only known at end of day` };
  }
  let bucket = -1;
  for (const s of specs) {
    let b;
    if (ASOF_DIMS.has(s.id)) {
      if (s.n === null || !Number.isInteger(s.n) || s.n < 1 || s.n > 9) return { kind: 'never', reason: `${s.id} needs an hour between 1 and 9` };
      b = s.n - 1;
    } else if (IN_HOUR_DIMS.has(s.id)) {
      if (s.n === null || !Number.isInteger(s.n) || s.n < 0 || s.n > 9) return { kind: 'never', reason: `${s.id} needs an hour between 0 and 9` };
      b = s.n;
    } else {
      continue;
    }
    if (b > bucket) bucket = b;
  }
  if (bucket >= 0) return { kind: 'closing', bucket };
  return { kind: 'first_tick' };
}

// ---------------------------------------------------------------------------------------------
// gate: is it time to evaluate this rule for this city?
// ---------------------------------------------------------------------------------------------

/**
 * Pure timing gate. `ticks` are today's city-local ticks from either tick collection.
 * Pass `ticks: []` for a cheap "is the window open at all" pre-check: it returns 'missing' when the
 * window is open and the signal tick has not been looked up yet.
 *
 * States:
 *   not_yet   it is before the closing tick's label time
 *   expired   the grace window after the label time has passed
 *   missing   inside the window, but the signal tick is not stored
 *   stale     the signal tick exists but is older than maxSignalAgeMin
 *   ready     evaluate the rule now
 *   never / unknown_city
 *
 * The signal tick is matched on its pacing_time label, not on captured_at. A tick labelled
 * 11:30 AM that was written at 11:36 is still Seoul's closing tick.
 */
function gate(args) {
  const { cls, city, now, ticks } = args;
  const maxSignalAgeMin = args.maxSignalAgeMin == null ? 12 : args.maxSignalAgeMin;
  const closeGraceMin = args.closeGraceMin == null ? 20 : args.closeGraceMin;
  const firstTickGraceMin = args.firstTickGraceMin == null ? 20 : args.firstTickGraceMin;

  const sched = scheduleFor(city);
  if (!sched) return { state: 'unknown_city', localDate: null };
  const nowMs = new Date(now).getTime();
  const lp = localParts(new Date(nowMs), sched.tz);
  const nowMin = lp.hour * 60 + lp.minute;

  let startMin;
  let graceMin;
  if (cls.kind === 'closing') {
    startMin = (cls.bucket + FIRST_HOUR24) * 60 + closingMinute(city);
    graceMin = closeGraceMin;
  } else if (cls.kind === 'first_tick') {
    const w = FIRST_TICK_WINDOW[cityKey(city)];
    startMin = w[0];
    graceMin = w[1] - w[0] + firstTickGraceMin;
  } else {
    return { state: 'never', localDate: lp.date };
  }

  if (nowMin < startMin) return { state: 'not_yet', localDate: lp.date };
  if (nowMin > startMin + graceMin) return { state: 'expired', localDate: lp.date };

  const parsed = [];
  for (const t of ticks || []) {
    const p = parsePacingTime(t.pacing_time);
    if (!p || p.hour24 < FIRST_HOUR24 || p.hour24 > LAST_HOUR24) continue;
    const cap = new Date(t.captured_at).getTime();
    if (!Number.isFinite(cap)) continue;
    parsed.push({ p, cap });
  }

  let target;
  if (cls.kind === 'closing') {
    const h = cls.bucket + FIRST_HOUR24;
    const m = closingMinute(city);
    target = pickClosingTicks(parsed, h, m);
  } else {
    const w = FIRST_TICK_WINDOW[cityKey(city)];
    let first = null;
    for (const x of parsed) {
      const key = x.p.hour24 * 60 + x.p.minute;
      if (key < w[0] || key > w[1]) continue;
      if (first === null || key < first) first = key;
    }
    target = first === null ? [] : parsed.filter((x) => x.p.hour24 * 60 + x.p.minute === first);
  }
  if (target.length === 0) return { state: 'missing', localDate: lp.date };

  const capturedAt = Math.max(...target.map((x) => x.cap));
  const ageMin = Math.max(0, (nowMs - capturedAt) / 60000);
  const label = formatLabel(target[0].p.hour24, target[0].p.minute);
  if (ageMin > maxSignalAgeMin) return { state: 'stale', localDate: lp.date, label, ageMin };
  return { state: 'ready', localDate: lp.date, label, capturedAt, ageMin };
}

// ---------------------------------------------------------------------------------------------
// buy planning
// ---------------------------------------------------------------------------------------------

/** Deterministic id: one rule buys at most one market-day-bracket once. 32 hex chars. */
function intentIdFor(parts) {
  const raw = [parts.ruleId, cityKey(parts.city), parts.localDate, String(parts.bracket).trim()].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Cents the matched bracket showed on the signal tick, or null when that tick did not price it.
 * Looks at tick docs from either collection whose pacing_time equals `label`.
 */
function signalPriceFor(args) {
  const want = String(args.bracket).trim();
  const wantTime = parsePacingTime(args.label);
  if (!wantTime) return null;
  for (const t of args.tickDocs || []) {
    if (String(t.bracket == null ? '' : t.bracket).trim() !== want) continue;
    const p = parsePacingTime(t.pacing_time);
    if (!p || p.hour24 !== wantTime.hour24 || p.minute !== wantTime.minute) continue;
    let cents = NaN;
    if (t.yes_price_cents != null && Number.isFinite(Number(t.yes_price_cents))) cents = Number(t.yes_price_cents);
    else if (t.yes_price != null && Number.isFinite(Number(t.yes_price))) cents = Number(t.yes_price) * 100;
    if (Number.isFinite(cents) && cents > 0 && cents < 100) return Math.round(cents * 100) / 100;
  }
  return null;
}

/**
 * Turn scanner matches into buys. One bet per city + date + bracket.
 * A rule that matches more than maxBuys brackets is too broad: it buys nothing rather than an arbitrary subset.
 */
function planBuys(args) {
  const maxBuys = args.maxBuys == null ? 3 : args.maxBuys;
  const seen = new Set();
  const uniq = [];
  for (const m of args.matches || []) {
    const bracket = String(m.bracket == null ? '' : m.bracket).trim();
    if (!bracket || seen.has(bracket)) continue;
    seen.add(bracket);
    uniq.push({ bracket, method: m.method == null ? null : String(m.method) });
  }
  if (uniq.length === 0) return { buys: [], reason: 'no_match', count: 0 };
  if (uniq.length > maxBuys) return { buys: [], reason: 'too_broad', count: uniq.length };
  return {
    count: uniq.length,
    buys: uniq.map((u) => ({
      bracket: u.bracket,
      method: u.method,
      intentId: intentIdFor({ ruleId: args.ruleId, city: args.city, localDate: args.localDate, bracket: u.bracket }),
      signalPriceCents: signalPriceFor({ bracket: u.bracket, label: args.label, tickDocs: args.tickDocs }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------------------------

/** Bracket equality is trimmed string equality against winning_bracket. */
function outcomeWon(bracket, winningBracket) {
  return String(bracket == null ? '' : bracket).trim() === String(winningBracket == null ? '' : winningBracket).trim();
}

/** A win pays $1 per share. A loss pays nothing. Fees are ignored. */
function pnlFor(args) {
  const v = args.won ? args.shares * 1 - args.spentUsd : -args.spentUsd;
  return Math.round(v * 10000) / 10000;
}

module.exports = {
  CITY_SCHEDULE,
  FIRST_TICK_WINDOW,
  DEFAULT_N,
  KNOWN_DIM_IDS,
  FIRST_HOUR24,
  LAST_HOUR24,
  cityKey,
  scheduleFor,
  closingMinute,
  ticksInHour,
  pickClosingTicks,
  parsePacingTime,
  formatLabel,
  localParts,
  parseBy,
  classifyBy,
  gate,
  intentIdFor,
  signalPriceFor,
  planBuys,
  outcomeWon,
  pnlFor,
};
