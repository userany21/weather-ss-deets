/**
 * lib/stats-aggregator.ts
 *
 * Registry-driven analytics aggregator for the Stats Explorer page.
 *
 * Adding a new dimension:
 *   1. Implement DimensionDef (bucket + bucketLabel functions + optional configSchema).
 *   2. Push it onto DIMENSION_REGISTRY.
 *   3. Done — the API and UI pick it up automatically with zero other changes.
 */

import { getDb } from "./mongodb";
import { CITIES } from "./cities-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureRow {
  city: string;
  local_date: string;
  bracket: string;
  method: "linear" | "reciprocal" | "combined";
  first_tick_price_cents: number | null;
  first_tick_hour: number | null;
  has_price: boolean;
  tick_count_through_hour: number[];   // length 10, index = hourN bucket
  rank_through_hour: (number | null)[]; // length 10, sequential 1-indexed rank
  is_leader_through_hour: boolean[];   // length 10, true when tied for rank 1
  /** First yes_price_cents seen within each hour bucket for this bracket (null = no tick that hour) */
  price_at_hour?: (number | null)[];
  /** (rank1_ticks − rank2_ticks) / total_ticks per hour — city-day level signal */
  lead_margin_through_hour?: number[];
  final_tick_count: number;
  final_rank: number | null;
  resolved: boolean;
  won: boolean | null;
  edge_cents: number | null;
  computed_at: Date;
}

export interface DimensionConfigSchema {
  key: string;
  type: "number" | "select";
  options?: number[];
  default: number;
}

/**
 * Every dimension in the registry must implement this interface.
 * `bucket` returns a stable string key for the bucket this row falls into,
 * or null to exclude the row from bucketing (e.g. when has_price is false).
 * `bucketLabel` turns that key into a human-readable label for the UI.
 */
export interface DimensionDef {
  id: string;
  label: string;
  /**
   * When the information behind this dimension becomes known:
   *   "hour"       – at hour N (config.n): you can only enter at hour N or later
   *   "end_of_day" – only after the day ends: no valid entry time exists
   *   (omitted)    – known at or before the first tick of the day
   */
  timing?: "hour" | "end_of_day";
  configSchema?: DimensionConfigSchema;
  bucket(row: FeatureRow, config: Record<string, number>): string | null;
  bucketLabel(key: string, config: Record<string, number>): string;
}

export interface DimensionSpec {
  id: string;
  config: Record<string, number>;
}

export interface StatsFilters {
  cities?: string[];
  regions?: string[];
  dateFrom?: string;
  dateTo?: string;
  methods?: string[];
  minCount?: number;
  resolvedOnly?: boolean;
}

export interface BucketResult {
  key: string;
  label: string;
  count: number;
  resolved: number;
  win_rate: number | null;
  avg_edge_cents: number | null;
}

/** One raw `stats_features` doc, flattened for the drill-down sub-table. */
export interface DrillRow {
  local_date: string;
  bracket: string;
  method: string;
  first_tick_price_cents: number | null;
  /** Price used for the edge: the entry price at the same moment as the filters. */
  entry_price_cents: number | null;
  /** e.g. "1PM price" or "first-tick price" */
  entry_label: string;
  won: boolean | null;
  /** Edge at the entry price above (not at the first-tick price). */
  edge_cents: number | null;
  final_rank: number | null;
  resolved: boolean;
  winning_bracket: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cityRegionMap = new Map(CITIES.map((c) => [c.city, c.region as string]));

const HOUR_LABELS = ["8AM", "9AM", "10AM", "11AM", "12PM", "1PM", "2PM", "3PM", "4PM", "5PM"];

function clampHour(n: number): number {
  return Math.min(Math.max(Math.round(n), 0), 9);
}

function clampRank(rank: number): string {
  return rank >= 4 ? "4+" : String(rank);
}

// ---------------------------------------------------------------------------
// Dimension Registry
// ---------------------------------------------------------------------------

export const DIMENSION_REGISTRY: DimensionDef[] = [
  // ------------------------------------------------------------------
  // price: first_tick_price_cents bucketed by configurable width (¢)
  // ------------------------------------------------------------------
  {
    id: "price",
    label: "First-Tick Price",
    configSchema: {
      key: "width",
      type: "select",
      options: [10, 20, 25, 50],
      default: 20,
    },
    bucket(row, { width = 20 }) {
      if (!row.has_price || row.first_tick_price_cents == null) return null;
      const lo = Math.floor(row.first_tick_price_cents / width) * width;
      const hi = lo + width - 1;
      return `price:${lo}:${hi}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      return `${parts[1]}–${parts[2]}¢`;
    },
  },

  // ------------------------------------------------------------------
  // leader: is_leader_through_hour[N] — configurable hour window N
  // ------------------------------------------------------------------
  {
    id: "leader",
    label: "Hour-N Leader",
    timing: "hour",
    configSchema: {
      key: "n",
      type: "select",
      options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      default: 0,
    },
    bucket(row, { n = 0 }) {
      const idx = clampHour(n);
      const val = row.is_leader_through_hour[idx] ? "true" : "false";
      return `leader:${idx}:${val}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      const idx = Number(parts[1]);
      const isLeader = parts[2] === "true";
      return `Leader @${HOUR_LABELS[idx] ?? `H${idx}`}: ${isLeader ? "Yes" : "No"}`;
    },
  },

  // ------------------------------------------------------------------
  // city: the city field verbatim
  // ------------------------------------------------------------------
  {
    id: "city",
    label: "City",
    bucket(row) {
      return `city:${row.city}`;
    },
    bucketLabel(key) {
      const city = key.slice("city:".length);
      return city.replace(/\b\w/g, (c) => c.toUpperCase());
    },
  },

  // ------------------------------------------------------------------
  // method: linear / reciprocal / combined
  // ------------------------------------------------------------------
  {
    id: "method",
    label: "Method",
    bucket(row) {
      return `method:${row.method}`;
    },
    bucketLabel(key) {
      const m = key.slice("method:".length);
      return m.charAt(0).toUpperCase() + m.slice(1);
    },
  },

  // ------------------------------------------------------------------
  // final_rank: rank at end of full day, clamped to 1/2/3/4+
  // ------------------------------------------------------------------
  {
    id: "final_rank",
    label: "Final Rank",
    timing: "end_of_day",
    bucket(row) {
      if (row.final_rank == null) return null;
      return `final_rank:${clampRank(row.final_rank)}`;
    },
    bucketLabel(key) {
      const r = key.slice("final_rank:".length);
      return `Final Rank ${r}`;
    },
  },

  // ------------------------------------------------------------------
  // first_tick_hour: which clock hour the first tick landed in (0-9)
  // ------------------------------------------------------------------
  {
    id: "first_tick_hour",
    label: "First-Tick Hour",
    bucket(row) {
      if (row.first_tick_hour == null) return null;
      const label = HOUR_LABELS[row.first_tick_hour] ?? `H${row.first_tick_hour}`;
      return `ft_hour:${row.first_tick_hour}:${label}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      return `First tick @${parts[2] ?? key}`;
    },
  },

  // ------------------------------------------------------------------
  // day_of_week: derived from local_date (UTC Sunday=0..Saturday=6)
  // ------------------------------------------------------------------
  {
    id: "day_of_week",
    label: "Day of Week",
    bucket(row) {
      // Parse date as UTC noon to avoid DST edge cases
      const d = new Date(row.local_date + "T12:00:00Z");
      const dow = d.getUTCDay();
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `dow:${dow}:${names[dow]}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      return parts[2] ?? key;
    },
  },

  // ------------------------------------------------------------------
  // region: derived from city via CITIES config
  // ------------------------------------------------------------------
  {
    id: "region",
    label: "Region",
    bucket(row) {
      const region = cityRegionMap.get(row.city) ?? "unknown";
      return `region:${region}`;
    },
    bucketLabel(key) {
      const r = key.slice("region:".length);
      return r.charAt(0).toUpperCase() + r.slice(1);
    },
  },

  // ------------------------------------------------------------------
  // rank_at_hour: rank_through_hour[N] clamped to 1/2/3/4+, configurable N
  // ------------------------------------------------------------------
  {
    id: "rank_at_hour",
    label: "Rank at Hour-N",
    timing: "hour",
    configSchema: {
      key: "n",
      type: "select",
      options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      default: 0,
    },
    bucket(row, { n = 0 }) {
      const idx = clampHour(n);
      const rank = row.rank_through_hour[idx];
      if (rank == null) return null;
      return `rank_h:${idx}:${clampRank(rank)}`;
    },
    bucketLabel(key, { n = 0 }) {
      const parts = key.split(":");
      const idx = Number(parts[1]);
      const r = parts[2];
      return `Rank ${r} @${HOUR_LABELS[idx] ?? `H${idx}`}`;
    },
  },

  // ------------------------------------------------------------------
  // price_at_hour: first yes_price_cents seen in hour bucket N, 20¢ wide buckets
  // ------------------------------------------------------------------
  {
    id: "price_at_hour",
    label: "Price at Hour-N",
    timing: "hour",
    configSchema: {
      key: "n",
      type: "select",
      options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      default: 2,
    },
    bucket(row, { n = 2 }) {
      const idx = clampHour(n);
      const price = (row.price_at_hour ?? [])[idx] ?? null;
      if (price == null) return null;
      const width = 20;
      const lo = Math.floor(price / width) * width;
      const hi = lo + width - 1;
      return `pah:${idx}:${lo}:${hi}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      const idx = Number(parts[1]);
      return `Price@${HOUR_LABELS[idx] ?? `H${idx}`}: ${parts[2]}–${parts[3]}¢`;
    },
  },

  // ------------------------------------------------------------------
  // lead_margin: normalised (rank1_ticks - rank2_ticks) / total_ticks at hour N
  // Tiered: tight (<15%), moderate (15-40%), decisive (>40%)
  // ------------------------------------------------------------------
  {
    id: "lead_margin",
    label: "Lead Margin at Hour-N",
    timing: "hour",
    configSchema: {
      key: "n",
      type: "select",
      options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      default: 1,
    },
    bucket(row, { n = 1 }) {
      const idx = clampHour(n);
      const margin = (row.lead_margin_through_hour ?? [])[idx] ?? null;
      // Exclude rows with no ticks at all by hour N
      if (margin == null || row.tick_count_through_hour[idx] === 0) return null;
      const tier =
        margin < 0.15 ? "tight" :
        margin < 0.40 ? "moderate" :
        "decisive";
      return `lm:${idx}:${tier}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      const idx = Number(parts[1]);
      const tier = parts[2];
      const label =
        tier === "tight"    ? "Tight (<15%)"       :
        tier === "moderate" ? "Moderate (15–40%)"  :
                              "Decisive (>40%)";
      return `Lead Margin@${HOUR_LABELS[idx] ?? `H${idx}`}: ${label}`;
    },
  },

  // ------------------------------------------------------------------
  // rank_trend: direction of rank change between hour N-2 and hour N
  // rising = improved rank (lower number), falling = worsened, stable = same
  // Options start at 2 so there's always a prior window to compare against
  // ------------------------------------------------------------------
  {
    id: "rank_trend",
    label: "Rank Trend at Hour-N",
    timing: "hour",
    configSchema: {
      key: "n",
      type: "select",
      options: [2, 3, 4, 5, 6, 7, 8, 9],
      default: 3,
    },
    bucket(row, { n = 3 }) {
      const idx = clampHour(n);
      const prevIdx = Math.max(0, idx - 2);
      if (idx === prevIdx) return null; // guard: shouldn't happen given options start at 2
      const nowRank = row.rank_through_hour[idx];
      const prevRank = row.rank_through_hour[prevIdx];
      if (nowRank == null || prevRank == null) return null;
      const trend =
        nowRank < prevRank ? "rising"  :
        nowRank > prevRank ? "falling" :
        "stable";
      return `rt:${idx}:${trend}`;
    },
    bucketLabel(key) {
      const parts = key.split(":");
      const idx = Number(parts[1]);
      const trend = parts[2];
      const arrow =
        trend === "rising"  ? "↑" :
        trend === "falling" ? "↓" : "→";
      return `Rank Trend@${HOUR_LABELS[idx] ?? `H${idx}`}: ${arrow} ${trend.charAt(0).toUpperCase() + trend.slice(1)}`;
    },
  },

  // ------------------------------------------------------------------
  // final_tick_count: total ticks for this bracket across the full day
  // Bucketed into sparse/present/strong/dominant
  // ------------------------------------------------------------------
  {
    id: "final_tick_count",
    label: "Final Tick Count",
    timing: "end_of_day",
    bucket(row) {
      const c = row.final_tick_count;
      if (!c) return null;
      const range =
        c <= 3  ? "1–3"  :
        c <= 8  ? "4–8"  :
        c <= 16 ? "9–16" :
        "17+";
      return `ftc:${range}`;
    },
    bucketLabel(key) {
      const range = key.slice("ftc:".length);
      return `Final Ticks: ${range}`;
    },
  },
];

export const DIMENSION_REGISTRY_MAP = new Map(
  DIMENSION_REGISTRY.map((d) => [d.id, d])
);

/**
 * Serializable registry metadata (no functions) — included in every API response
 * so the frontend can build its dimension picker without a separate round-trip.
 */
export function serializeRegistry() {
  return DIMENSION_REGISTRY.map((d) => ({
    id: d.id,
    label: d.label,
    timing: d.timing ?? null,
    configSchema: d.configSchema ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Entry rule — price and edge from the SAME moment as the filters
// ---------------------------------------------------------------------------

export type Entry =
  | { kind: "first_tick" }
  | { kind: "hour"; n: number }
  | { kind: "none" }; // a filter uses end-of-day data: no tradeable entry exists

/**
 * You can only buy at or after the latest moment any filter needs.
 *   - any end-of-day dimension → no entry (edge is not defined)
 *   - any hour-N dimension     → hour max(N)
 *   - otherwise                → first tick of the day
 * The Live Scanner calls this same function, so scan and backtest cannot drift.
 */
export function resolveEntry(dimensions: DimensionSpec[]): Entry {
  let hour = -1;
  for (const spec of dimensions) {
    const def = DIMENSION_REGISTRY_MAP.get(spec.id);
    if (!def?.timing) continue;
    if (def.timing === "end_of_day") return { kind: "none" };
    const key = def.configSchema?.key ?? "n";
    const n = spec.config[key] ?? def.configSchema?.default ?? 0;
    hour = Math.max(hour, clampHour(n));
  }
  return hour >= 0 ? { kind: "hour", n: hour } : { kind: "first_tick" };
}

export function entryLabel(entry: Entry): string {
  if (entry.kind === "hour") return `${HOUR_LABELS[entry.n] ?? `H${entry.n}`} price`;
  if (entry.kind === "first_tick") return "first-tick price";
  return "none (end-of-day filter)";
}

function edgeFor(row: FeatureRow, price: number | null): number | null {
  if (price == null || !row.resolved || row.won == null) return null;
  return row.won ? 100 - price : -price;
}

/** Entry price + edge for one row under the given entry rule. */
export function entryFor(
  row: FeatureRow,
  entry: Entry
): { price: number | null; edge: number | null } {
  let price: number | null = null;
  if (entry.kind === "hour") {
    price = row.price_at_hour?.[entry.n] ?? null;
  } else if (entry.kind === "first_tick") {
    price = row.has_price ? row.first_tick_price_cents : null;
  } else {
    return { price: null, edge: null };
  }
  return { price, edge: edgeFor(row, price) };
}

// ---------------------------------------------------------------------------
// First-prediction filter
// ---------------------------------------------------------------------------
//
// `stats_features` holds one doc per (city, local_date, bracket, method), and each
// doc's first_tick_price_cents is that BRACKET's own first tick. When the model
// changes its mind during the day, the new bracket gets its own "first tick" and
// shows up as a second row for the same city-day.
//
// The intended grain is ONE row per (city, local_date, method): the bracket from the
// city's FIRST prediction of the day. We enforce that here on read, straight from the
// raw tick collections, so no stats_features data has to change.
//
//   - "First" = earliest parsed pacing_time of the city-day (tie → earlier captured_at).
//   - It must land inside the city's first-tick window below. If it doesn't (e.g. the
//     8:30 AM tick was missed and the earliest is 9:00 AM) the city-day is dropped.
//   - combined only counts when the linear (high-temp) and reciprocal first predictions
//     are valid AND land on the same bracket.
//   - The stored bracket is trusted as-is (n8n already rounds weighted_avg).
//
// Applied ONLY when a first-tick dimension is selected (First-Tick Price / First-Tick
// Hour), since those are the dimensions whose meaning depends on "the first prediction".
// Every other dimension (Rank at Hour-N, Leader, etc.) still sees every bracket row,
// exactly as before.
// Flip FIRST_PREDICTION_ONLY to false to turn the filter off entirely.
const FIRST_PREDICTION_ONLY = true;
const FIRST_TICK_DIMENSION_IDS = new Set(["price", "first_tick_hour"]);

const hm = (h: number, m: number): number => h * 60 + m;

/**
 * Per-city window [start, end] (minutes since local midnight) in which the day's
 * first prediction must land. Keys are normalised city names (lowercase, letters
 * only), so "hong kong", "hong-kong" and "Hong_Kong" all resolve to "hongkong".
 */
const FIRST_TICK_WINDOWS: Record<string, [number, number]> = {
  // Asia
  tokyo: [hm(8, 30), hm(8, 30)],
  shenzhen: [hm(9, 0), hm(9, 0)],
  seoul: [hm(8, 30), hm(8, 30)],
  beijing: [hm(8, 30), hm(8, 30)],
  shanghai: [hm(8, 30), hm(8, 30)],
  hongkong: [hm(8, 10), hm(8, 10)],
  singapore: [hm(8, 30), hm(8, 30)],
  // Europe
  london: [hm(8, 20), hm(8, 20)],
  munich: [hm(8, 20), hm(8, 20)],
  milan: [hm(8, 20), hm(8, 20)],
  amsterdam: [hm(8, 25), hm(8, 25)],
  madrid: [hm(8, 30), hm(8, 30)],
  paris: [hm(8, 30), hm(8, 30)],
  // US (first prediction varies 8:15-8:25 AM)
  sanfrancisco: [hm(8, 15), hm(8, 25)],
  seattle: [hm(8, 15), hm(8, 25)],
  losangeles: [hm(8, 15), hm(8, 25)],
  nyc: [hm(8, 15), hm(8, 25)],
  newyork: [hm(8, 15), hm(8, 25)],
  newyorkcity: [hm(8, 15), hm(8, 25)],
  atlanta: [hm(8, 15), hm(8, 25)],
  miami: [hm(8, 15), hm(8, 25)],
};

interface RawTickLite {
  city: string;
  local_date: string;
  bracket: string | null;
  pacing_time: string | null;
  captured_at: string | Date | null;
}

interface FirstPrediction {
  bracket: string;
  minutes: number;
  captured_at: string;
}

function normCityKey(city: string): string {
  return String(city ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** "8:30 AM" → minutes since local midnight. Never compare pacing_time as a string. */
function pacingTimeToMinutes(pt: string | null): number | null {
  if (!pt) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(pt).trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const meridiem = m[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function capKey(v: string | Date | null): string {
  if (v == null) return "";
  return typeof v === "string" ? v : v instanceof Date ? v.toISOString() : String(v);
}

async function fetchRawTicks(collectionName: string): Promise<RawTickLite[]> {
  const db = await getDb();
  return (await db
    .collection(collectionName)
    .find(
      { bracket: { $ne: null, $exists: true } },
      {
        projection: {
          city: 1,
          local_date: 1,
          bracket: 1,
          pacing_time: 1,
          captured_at: 1,
        },
      }
    )
    .toArray()) as unknown as RawTickLite[];
}

/** Each city-day's earliest tick (by parsed pacing_time) that falls inside the city's window. */
function firstPredictionsInWindow(ticks: RawTickLite[]): Map<string, FirstPrediction> {
  const earliest = new Map<string, FirstPrediction>();
  for (const t of ticks) {
    if (t.bracket == null) continue;
    const bracket = String(t.bracket).trim();
    if (!bracket) continue;
    const minutes = pacingTimeToMinutes(t.pacing_time);
    if (minutes === null) continue;

    const key = `${t.city}|${t.local_date}`;
    const ca = capKey(t.captured_at);
    const cur = earliest.get(key);
    if (
      !cur ||
      minutes < cur.minutes ||
      (minutes === cur.minutes && ca < cur.captured_at)
    ) {
      earliest.set(key, { bracket, minutes, captured_at: ca });
    }
  }

  // The earliest tick of the day must be inside the city's window, else skip the day.
  const valid = new Map<string, FirstPrediction>();
  for (const [key, fp] of earliest) {
    const city = key.slice(0, key.indexOf("|"));
    const win = FIRST_TICK_WINDOWS[normCityKey(city)];
    if (!win) continue; // unknown city
    if (fp.minutes < win[0] || fp.minutes > win[1]) continue; // missed / out of window
    valid.set(key, fp);
  }
  return valid;
}

/**
 * Builds the set of allowed row keys "city|date|method|bracket" — exactly one per
 * valid city-day and method.
 */
async function computeAllowedFirstPredictionKeys(): Promise<Set<string>> {
  const [linearTicks, reciprocalTicks] = await Promise.all([
    fetchRawTicks("high-temp"),
    fetchRawTicks("reciprocal"),
  ]);

  const linear = firstPredictionsInWindow(linearTicks);
  const reciprocal = firstPredictionsInWindow(reciprocalTicks);

  const allowed = new Set<string>();
  for (const [cdKey, fp] of linear) {
    allowed.add(`${cdKey}|linear|${fp.bracket}`);
  }
  for (const [cdKey, fp] of reciprocal) {
    allowed.add(`${cdKey}|reciprocal|${fp.bracket}`);
  }
  // combined: both methods valid AND same bracket
  for (const [cdKey, lf] of linear) {
    const rf = reciprocal.get(cdKey);
    if (rf && rf.bracket === lf.bracket) {
      allowed.add(`${cdKey}|combined|${lf.bracket}`);
    }
  }
  return allowed;
}

// Cached so a stats-page load doesn't rescan the raw tick collections every time.
const FIRST_PRED_TTL_MS = 5 * 60 * 1000;
let firstPredCache: { at: number; allowed: Set<string> } | null = null;
let firstPredInflight: Promise<Set<string>> | null = null;

async function getAllowedFirstPredictionKeys(): Promise<Set<string>> {
  const now = Date.now();
  if (firstPredCache && now - firstPredCache.at < FIRST_PRED_TTL_MS) {
    return firstPredCache.allowed;
  }
  if (!firstPredInflight) {
    firstPredInflight = computeAllowedFirstPredictionKeys()
      .then((allowed) => {
        firstPredCache = { at: Date.now(), allowed };
        return allowed;
      })
      .finally(() => {
        firstPredInflight = null;
      });
  }
  try {
    return await firstPredInflight;
  } catch (err) {
    // Prefer slightly stale data over failing the whole page.
    if (firstPredCache) return firstPredCache.allowed;
    throw err;
  }
}

function rowKey(row: FeatureRow): string {
  return `${row.city}|${row.local_date}|${row.method}|${String(row.bracket).trim()}`;
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/** Builds the shared Mongo match object from StatsFilters — used by both
 * `aggregate()` and `getRowsForBucket()` so the two can never drift apart. */
function buildMongoMatch(filters: StatsFilters): Record<string, unknown> {
  const match: Record<string, unknown> = {};

  if (filters.cities?.length) {
    match.city = { $in: filters.cities };
  } else if (filters.regions?.length) {
    const citiesInRegions = CITIES.filter((c) =>
      filters.regions!.includes(c.region)
    ).map((c) => c.city);
    if (citiesInRegions.length) match.city = { $in: citiesInRegions };
  }

  if (filters.dateFrom || filters.dateTo) {
    const dateFilter: Record<string, string> = {};
    if (filters.dateFrom) dateFilter.$gte = filters.dateFrom;
    if (filters.dateTo) dateFilter.$lte = filters.dateTo;
    match.local_date = dateFilter;
  }

  if (filters.methods?.length) {
    match.method = { $in: filters.methods };
  }

  if (filters.resolvedOnly) {
    match.resolved = true;
  }

  return match;
}

/**
 * Loads the candidate `stats_features` rows for a filter set. When a first-tick
 * dimension is selected, keeps only the first-prediction row of each city-day/method.
 * Shared by `aggregate()` and `getRowsForBucket()` so the table and the drill-down
 * always see the same rows.
 */
async function loadFeatureRows(
  match: Record<string, unknown>,
  dimensions: DimensionSpec[]
): Promise<FeatureRow[]> {
  const db = await getDb();
  const col = db.collection<FeatureRow>("stats_features");
  const rows = (await col.find(match).toArray()) as unknown as FeatureRow[];
  if (!FIRST_PREDICTION_ONLY) return rows;
  if (!dimensions.some((d) => FIRST_TICK_DIMENSION_IDS.has(d.id))) return rows;

  const allowed = await getAllowedFirstPredictionKeys();
  return rows.filter((r) => allowed.has(rowKey(r)));
}

export async function aggregate(
  filters: StatsFilters,
  dimensions: DimensionSpec[]
): Promise<{
  buckets: BucketResult[];
  totalRows: number;
  computedAt: Date | null;
}> {
  const db = await getDb();
  const col = db.collection<FeatureRow>("stats_features");

  const match = buildMongoMatch(filters);

  const rows = await loadFeatureRows(match, dimensions);
  const totalRows = rows.length;

  // Latest computed_at across all docs in this collection (not filter-scoped)
  const latestDoc = await col.findOne(
    {},
    { sort: { computed_at: -1 }, projection: { computed_at: 1 } }
  );
  const computedAt = (latestDoc as unknown as { computed_at?: Date } | null)
    ?.computed_at ?? null;

  if (dimensions.length === 0 || rows.length === 0) {
    return { buckets: [], totalRows, computedAt };
  }

  // Resolve all dimension defs up front
  const dimDefs = dimensions.map((spec) => {
    const def = DIMENSION_REGISTRY_MAP.get(spec.id);
    if (!def) throw new Error(`Unknown dimension: "${spec.id}"`);
    return { def, config: spec.config };
  });

  const entry = resolveEntry(dimensions);

  // Group rows into buckets
  const bucketMap = new Map<
    string,
    { count: number; wins: number; resolved: number; edgeSum: number; edgeCount: number }
  >();

  for (const row of rows) {
    const parts: string[] = [];
    let exclude = false;
    for (const { def, config } of dimDefs) {
      const b = def.bucket(row, config);
      if (b === null) {
        exclude = true;
        break;
      }
      parts.push(b);
    }
    if (exclude) continue;

    // Entry price + edge come from the SAME moment as the filters (see resolveEntry).
    // A row with no entry price could not have been bought, so it is skipped:
    // Count, Win Rate and Avg Edge all use the same rows.
    const { price: entryPrice, edge: entryEdge } = entryFor(row, entry);
    if (entry.kind !== "none" && entryPrice == null) continue;

    const key = parts.join("|");
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { count: 0, wins: 0, resolved: 0, edgeSum: 0, edgeCount: 0 });
    }
    const s = bucketMap.get(key)!;
    s.count++;
    if (row.resolved) {
      s.resolved++;
      if (row.won) s.wins++;
    }
    if (entryEdge !== null) {
      s.edgeSum += entryEdge;
      s.edgeCount++;
    }
  }

  // Build result rows, applying minCount filter
  const minCount = filters.minCount ?? 0;
  const buckets: BucketResult[] = [];

  for (const [key, stats] of bucketMap) {
    if (stats.count < minCount) continue;
    const parts = key.split("|");
    const labelParts = parts.map((p, i) =>
      dimDefs[i].def.bucketLabel(p, dimDefs[i].config)
    );
    buckets.push({
      key,
      label: labelParts.join(" × "),
      count: stats.count,
      resolved: stats.resolved,
      win_rate: stats.resolved > 0 ? stats.wins / stats.resolved : null,
      avg_edge_cents: stats.edgeCount > 0 ? stats.edgeSum / stats.edgeCount : null,
    });
  }

  // Default sort: avg_edge_cents descending (nulls last), then win_rate descending
  buckets.sort((a, b) => {
    if (a.avg_edge_cents !== null && b.avg_edge_cents !== null) {
      return b.avg_edge_cents - a.avg_edge_cents;
    }
    if (a.avg_edge_cents !== null) return -1;
    if (b.avg_edge_cents !== null) return 1;
    if (a.win_rate !== null && b.win_rate !== null) return b.win_rate - a.win_rate;
    return 0;
  });

  return { buckets, totalRows, computedAt };
}

// ---------------------------------------------------------------------------
// Drill-down — raw rows behind a single bucket
// ---------------------------------------------------------------------------

/**
 * Given the same filters + dimensions used to build a bucket, plus that
 * bucket's composite `key` (pipe-separated, one part per dimension, in the
 * same order as `dimensions`), returns every raw `stats_features` doc that
 * was folded into it. Runs each candidate row through the exact same
 * `bucket()` functions the aggregator used, so the drill-down can never
 * drift from what the table counted.
 */
export async function getRowsForBucket(
  filters: StatsFilters,
  dimensions: DimensionSpec[],
  bucketKey: string
): Promise<{ rows: DrillRow[]; bucketLabel: string }> {
  if (dimensions.length === 0) {
    throw new Error("No dimensions specified");
  }

  const targetParts = bucketKey.split("|");
  if (targetParts.length !== dimensions.length) {
    throw new Error(
      `bucketKey has ${targetParts.length} part(s) but ${dimensions.length} dimension(s) specified`
    );
  }

  const db = await getDb();
  const col = db.collection<FeatureRow>("stats_features");

  const match = buildMongoMatch(filters);
  const rows = await loadFeatureRows(match, dimensions);

  // Resolve all dimension defs up front
  const dimDefs = dimensions.map((spec) => {
    const def = DIMENSION_REGISTRY_MAP.get(spec.id);
    if (!def) throw new Error(`Unknown dimension: "${spec.id}"`);
    return { def, config: spec.config };
  });

  const entry = resolveEntry(dimensions);

  // Keep only rows whose composite bucket key matches the target exactly
  const matched: FeatureRow[] = [];
  for (const row of rows) {
    let isMatch = true;
    for (let i = 0; i < dimDefs.length; i++) {
      const part = dimDefs[i].def.bucket(row, dimDefs[i].config);
      if (part !== targetParts[i]) {
        isMatch = false;
        break;
      }
    }
    // Same rule as aggregate(): no entry price = not tradeable = not in the bucket
    if (isMatch && (entry.kind === "none" || entryFor(row, entry).price != null)) {
      matched.push(row);
    }
  }

  // Resolve winning_bracket per (city, local_date, method) with a single
  // secondary query rather than one lookup per row.
  // NOTE: this deliberately queries stats_features directly (NOT through the
  // first-prediction filter): the winning bracket's doc is usually a different
  // bracket than the first-predicted one, and we still need it for the
  // "Winning Bracket" column on losing days.
  const cities = new Set<string>();
  const dates = new Set<string>();
  const methods = new Set<FeatureRow["method"]>();
  for (const row of matched) {
    cities.add(row.city);
    dates.add(row.local_date);
    methods.add(row.method);
  }

  const winnerMap = new Map<string, string>();
  if (matched.length > 0) {
    const winnerDocs = (await col
      .find(
        {
          city: { $in: [...cities] },
          local_date: { $in: [...dates] },
          method: { $in: [...methods] },
          won: true,
        },
        {
          projection: { city: 1, local_date: 1, method: 1, bracket: 1 },
        }
      )
      .toArray()) as unknown as Pick<
      FeatureRow,
      "city" | "local_date" | "method" | "bracket"
    >[];

    for (const doc of winnerDocs) {
      winnerMap.set(`${doc.city}|${doc.local_date}|${doc.method}`, doc.bracket);
    }
  }

  const entryText = entryLabel(entry);
  const drillRows: DrillRow[] = matched.map((row) => {
    const { price, edge } = entryFor(row, entry);
    return {
      local_date: row.local_date,
      bracket: row.bracket,
      method: row.method,
      first_tick_price_cents: row.first_tick_price_cents,
      entry_price_cents: price,
      entry_label: entryText,
      won: row.won,
      edge_cents: edge,
      final_rank: row.final_rank,
      resolved: row.resolved,
      winning_bracket:
        winnerMap.get(`${row.city}|${row.local_date}|${row.method}`) ?? null,
    };
  });

  // Most recent first
  drillRows.sort((a, b) => {
    if (a.local_date !== b.local_date) {
      return a.local_date < b.local_date ? 1 : -1;
    }
    return a.bracket.localeCompare(b.bracket);
  });

  const bucketLabel = dimDefs
    .map((d, i) => d.def.bucketLabel(targetParts[i], d.config))
    .join(" × ");

  return { rows: drillRows, bucketLabel };
}