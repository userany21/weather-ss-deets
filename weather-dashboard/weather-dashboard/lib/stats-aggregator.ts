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
    configSchema: d.configSchema ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

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

  // Build Mongo match from filters
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

  const rows = (await col.find(match).toArray()) as unknown as FeatureRow[];
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
    if (row.edge_cents !== null) {
      s.edgeSum += row.edge_cents;
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
