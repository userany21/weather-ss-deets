/**
 * GET /api/scan
 *
 * Scans today's live tick data for cities whose current signals match a
 * pinned Stats Explorer row (a specific dimension bucket combination).
 *
 * Query params:
 *   by          Same format as /api/stats — comma-separated dimension specs
 *               e.g. "lead_margin:4,rank_trend:4"
 *   criteriaKey The composite bucket key from the Stats row being matched,
 *               e.g. "lm:4:moderate|rt:4:rising"  (pipe-separated parts)
 *   cities      Comma-separated city list (optional — defaults to all cities)
 *   method      "linear"|"reciprocal"|"combined"|"all"  (default "combined")
 *   dedupe      "0" — show raw matches (default: one match per city+date+bracket)
 *
 * Which methods are scanned:
 *   1. The criteria has a Method part (e.g. "method:linear")  → that method only.
 *   2. method=all (the "All methods" filter)                  → linear, reciprocal
 *      AND combined are all scanned, and the matches are merged into one list.
 *   3. Otherwise                                              → the method in the URL.
 *
 * Response:
 *   {
 *     scanned_at: string,
 *     criteria_label: string,
 *     criteria_key: string,
 *     method: string,               // "all" when more than one method was scanned
 *     methods_scanned: string[],
 *     cities_scanned: string[],
 *     match_count: number,
 *     matches: [{
 *       city, bracket, local_date, local_time, method,
 *       tick_count, lead_margin_pct, rank_now, rank_prev
 *     }]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getLiveFeatures } from "@/lib/live-features";
import {
  DIMENSION_REGISTRY_MAP,
  HOUR_LABELS,
  resolveEntry,
  entryFor,
  entryLabel,
  dedupeBets,
  decisionSlot,
  liveSource,
  loadBetRowsForDay,
  rowsMatching,
  scoreMatchedRows,
  type DimensionSpec,
  type FeatureRow,
} from "@/lib/stats-aggregator";
import { CITIES, getCityConfig } from "@/lib/cities-config";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers (mirrors /api/stats route)
// ---------------------------------------------------------------------------

const CONFIG_KEY_MAP: Record<string, string> = {
  leader: "n",
  rank_at_hour: "n",
  price: "width",
  price_at_hour: "n",
  lead_margin: "n",
  rank_trend: "n",
};

// Same ids as FIRST_TICK_DIMENSION_IDS in lib/stats-aggregator.ts.
// When one of these is in the scan, only the FIRST prediction of the day counts.
const FIRST_TICK_DIMENSION_IDS = new Set(["price", "first_tick_hour"]);

// The three real methods. "all" is NOT a method — it means "scan all three".
const ALL_METHODS = ["linear", "reciprocal", "combined"] as const;
type ScanMethod = (typeof ALL_METHODS)[number];
const isMethod = (v: string): v is ScanMethod =>
  (ALL_METHODS as readonly string[]).includes(v);

interface ScanMatch {
  city: string;
  bracket: string;
  local_date: string;
  local_time: string;
  method: ScanMethod;
  /** Every method that matched this exact bet (after dedupe). */
  methods: ScanMethod[];
  entry_price_cents: number | null;
  entry_label: string;
  tick_count: number;
  lead_margin_pct: number | null;
  rank_now: number | null;
  rank_prev: number | null;
}

function parseDimensions(byParam: string | null): DimensionSpec[] {
  if (!byParam?.trim()) return [];
  return byParam
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const colonIdx = raw.indexOf(":");
      const id = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
      const configValStr = colonIdx === -1 ? null : raw.slice(colonIdx + 1);
      const config: Record<string, number> = {};
      if (configValStr !== null) {
        const num = parseFloat(configValStr);
        if (!isNaN(num)) {
          const key = CONFIG_KEY_MAP[id];
          if (key) config[key] = num;
        }
      }
      // Fill defaults for any unset config keys
      const def = DIMENSION_REGISTRY_MAP.get(id);
      if (def?.configSchema && !(def.configSchema.key in config)) {
        config[def.configSchema.key] = def.configSchema.default;
      }
      return { id, config };
    });
}

function parseCSV(param: string | null): string[] {
  if (!param?.trim()) return [];
  return param
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // Parse + validate params
  let dimensions: DimensionSpec[];
  try {
    dimensions = parseDimensions(sp.get("by"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bad 'by' parameter" },
      { status: 400 }
    );
  }

  if (dimensions.length === 0) {
    return NextResponse.json(
      { error: "Missing 'by' param — specify at least one dimension" },
      { status: 400 }
    );
  }

  const criteriaKey = sp.get("criteriaKey");
  if (!criteriaKey) {
    return NextResponse.json(
      { error: "Missing 'criteriaKey' param" },
      { status: 400 }
    );
  }

  const targetParts = criteriaKey.split("|");
  if (targetParts.length !== dimensions.length) {
    return NextResponse.json(
      {
        error: `criteriaKey has ${targetParts.length} parts but ${dimensions.length} dimension(s) specified`,
      },
      { status: 400 }
    );
  }

  const rawCities = parseCSV(sp.get("cities") ?? sp.get("city"));
  const citiesToScan =
    rawCities.length > 0 ? rawCities : CITIES.map((c) => c.city);

  // ---- Decide which method(s) to scan ----
  const methodParam = (sp.get("method") ?? "combined").trim().toLowerCase();

  const methodIdx = dimensions.findIndex((d) => d.id === "method");
  const keyMethod =
    methodIdx !== -1 ? targetParts[methodIdx].replace("method:", "") : null;

  let methodsToScan: ScanMethod[];
  if (keyMethod !== null && isMethod(keyMethod)) {
    // The pinned row has a Method part — it decides.
    methodsToScan = [keyMethod];
  } else if (methodParam === "all") {
    // "All methods" — scan every method and merge the matches.
    methodsToScan = [...ALL_METHODS];
  } else {
    methodsToScan = [isMethod(methodParam) ? methodParam : "combined"];
  }

  // Resolve dimension defs (throws if unknown id)
  let dimDefs: Array<{
    def: ReturnType<typeof DIMENSION_REGISTRY_MAP.get> & object;
    config: Record<string, number>;
  }>;
  try {
    dimDefs = dimensions.map((spec) => {
      const def = DIMENSION_REGISTRY_MAP.get(spec.id);
      if (!def) throw new Error(`Unknown dimension: "${spec.id}"`);
      return { def, config: spec.config };
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dimension error" },
      { status: 400 }
    );
  }

  // LIVE_SOURCE=bet_features: same table and same scoring as the Stats page and the bot.
  if (liveSource() === "bet_features") {
    return scanFromBets({
      dimensions,
      targetParts,
      criteriaKey,
      citiesToScan,
      methodsToScan,
      dedupe: sp.get("dedupe") !== "0",
    });
  }

  // Entry rule — the SAME function the Stats table uses, so scan and backtest
  // cannot drift. Entry hour = latest hour used by any filter.
  const entry = resolveEntry(dimensions);
  if (entry.kind === "none") {
    return NextResponse.json(
      {
        error:
          "not tradeable in live: a filter uses end-of-day data (Final Rank / Final Tick Count)",
      },
      { status: 400 }
    );
  }
  const entryText = entryLabel(entry);
  // Hour used for the display signals (lead margin %, rank trend)
  const entryHour = entry.kind === "hour" ? entry.n : 5;
  // Signals use data through the END of the hour before the entry hour (matches the registry)
  const criteriaHour = Math.max(0, entryHour - 1);
  const prevHour = Math.max(0, criteriaHour - 2); // 2-hour lookback (matches rank_trend)

  // First-tick dimensions only make sense for the FIRST prediction of the day
  const firstPredictionOnly = dimensions.some((d) =>
    FIRST_TICK_DIMENSION_IDS.has(d.id)
  );

  // Fetch live feature rows for today — one call per method, in parallel
  let scanned: Array<{ method: ScanMethod; rows: FeatureRow[] }>;
  try {
    scanned = await Promise.all(
      methodsToScan.map(async (m) => ({
        method: m,
        rows: await getLiveFeatures({
          cities: citiesToScan,
          method: m,
          firstPredictionOnly,
        }),
      }))
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to fetch live data: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }

  // Match rows against criteria — every method's rows go into ONE merged list
  const matches: ScanMatch[] = [];

  for (const { method: rowMethod, rows } of scanned) {
    for (const row of rows) {
      // Check all dimension bucket keys against target
      let matched = true;
      for (let i = 0; i < dimDefs.length; i++) {
        const bucketKey = dimDefs[i].def.bucket(row, dimDefs[i].config);
        if (bucketKey !== targetParts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      // Entry price at the same moment as the filters. No price = could not buy it,
      // so it is not a match (same rule as the Stats table).
      const { price: entryPrice } = entryFor(row, entry);
      if (entryPrice == null) continue;

      // Local time for this city
      const cfg = getCityConfig(row.city);
      const tz = cfg?.timezone ?? "UTC";
      const timeFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const localTime = timeFmt.format(new Date()).replace(/^24:/, "00:");

      // Extract display signals
      const tickCount = row.tick_count_through_hour[criteriaHour] ?? 0;
      const leadMarginRaw = row.lead_margin_through_hour?.[criteriaHour] ?? null;
      const lead_margin_pct =
        tickCount > 0 && leadMarginRaw !== null
          ? Math.round(leadMarginRaw * 1000) / 10
          : null;
      const rank_now = row.rank_through_hour[criteriaHour] ?? null;
      const rank_prev = row.rank_through_hour[prevHour] ?? null;

      matches.push({
        city: row.city,
        bracket: row.bracket,
        local_date: row.local_date,
        local_time: localTime,
        method: rowMethod,
        methods: [rowMethod],
        entry_price_cents: entryPrice,
        entry_label: entryText,
        tick_count: tickCount,
        lead_margin_pct,
        rank_now,
        rank_prev,
      });
    }
  }

  // Same bet from several methods (same city + date + bracket) = ONE opportunity.
  // Representative: combined > linear > reciprocal. ?dedupe=0 shows raw matches.
  const dedupe = sp.get("dedupe") !== "0";
  const uniqueMatches: ScanMatch[] = dedupeBets(matches, (m) => m, dedupe).map(
    ({ item, methods }) => ({ ...item, methods: methods as ScanMethod[] })
  );

  // Tidy order: city, then bracket
  uniqueMatches.sort(
    (a, b) => a.city.localeCompare(b.city) || a.bracket.localeCompare(b.bracket)
  );

  // Build human-readable criteria label
  const criteria_label = dimDefs
    .map((d, i) => d.def.bucketLabel(targetParts[i], d.config))
    .join(" × ");

  return NextResponse.json({
    scanned_at: new Date().toISOString(),
    criteria_label,
    criteria_key: criteriaKey,
    method: methodsToScan.length > 1 ? "all" : methodsToScan[0],
    methods_scanned: methodsToScan,
    cities_scanned: citiesToScan,
    match_count: uniqueMatches.length,
    matches: uniqueMatches,
  });
}

// ---------------------------------------------------------------------------
// bet_features source (LIVE_SOURCE=bet_features)
// ---------------------------------------------------------------------------
// Same table, same scoring and same stale rule as lib/automation/liveBridge.ts.
// A match shows only after the closing tick of the decision hour is in the table.

const MAX_BUILD_AGE_MS = (() => {
  const v = Number(process.env.AUTOMATION_MAX_BUILD_AGE_MIN);
  return (Number.isFinite(v) && v > 0 ? v : 10) * 60_000;
})();

type BetDay = { rows: FeatureRow[]; oldestBuiltAtMs: number | null };

function localDateIn(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function scanFromBets(args: {
  dimensions: DimensionSpec[];
  targetParts: string[];
  criteriaKey: string;
  citiesToScan: string[];
  methodsToScan: ScanMethod[];
  dedupe: boolean;
}) {
  const { dimensions, targetParts, criteriaKey, citiesToScan, methodsToScan, dedupe } = args;

  const d = decisionSlot(dimensions);
  if (d.kind === "none") {
    return NextResponse.json(
      {
        error:
          "not tradeable in live: a filter uses end-of-day data (Final Rank / Final Tick Count)",
      },
      { status: 400 }
    );
  }
  if (d.kind === "first_tick") {
    return NextResponse.json(
      {
        error:
          "not tradeable in live: the rule has no hour filter, so the bot has no closing tick to buy at",
      },
      { status: 400 }
    );
  }
  const slot = d.slot;
  const prevSlot = Math.max(0, slot - 2); // 2-hour lookback (matches rank_trend)
  const entryText = `${HOUR_LABELS[slot] ?? `H${slot}`} close`;

  let loaded: BetDay[];
  try {
    loaded = await Promise.all(
      citiesToScan.map((city) =>
        loadBetRowsForDay(
          city,
          localDateIn(getCityConfig(city)?.timezone ?? "UTC"),
          methodsToScan
        )
      )
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to fetch live data: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }

  // Oldest computed_at of all rows that were read. A row with no usable computed_at counts as stale.
  let oldest: number | null = null;
  let unknownAge = false;
  for (const l of loaded) {
    if (l.rows.length === 0) continue;
    if (l.oldestBuiltAtMs === null) unknownAge = true;
    else if (oldest === null || l.oldestBuiltAtMs < oldest) oldest = l.oldestBuiltAtMs;
  }
  const builderStale =
    unknownAge || (oldest !== null && Date.now() - oldest > MAX_BUILD_AGE_MS);

  const allRows = loaded.flatMap((l) => l.rows);
  const bets = scoreMatchedRows(
    rowsMatching(allRows, dimensions, targetParts),
    dimensions,
    { requireResolved: false, dedupe }
  );

  const matches: ScanMatch[] = bets.map(({ row, price, methods }) => {
    const tz = getCityConfig(row.city)?.timezone ?? "UTC";
    const localTime = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    })
      .format(new Date())
      .replace(/^24:/, "00:");
    const tickCount = row.tick_count_through_hour[slot] ?? 0;
    const leadMarginRaw = row.lead_margin_through_hour?.[slot] ?? null;
    return {
      city: row.city,
      bracket: row.bracket,
      local_date: row.local_date,
      local_time: localTime,
      method: row.method as ScanMethod,
      methods: methods as ScanMethod[],
      entry_price_cents: price,
      entry_label: entryText,
      tick_count: tickCount,
      lead_margin_pct:
        tickCount > 0 && leadMarginRaw !== null
          ? Math.round(leadMarginRaw * 1000) / 10
          : null,
      rank_now: row.rank_through_hour[slot] ?? null,
      rank_prev: row.rank_through_hour[prevSlot] ?? null,
    };
  });

  matches.sort(
    (a, b) => a.city.localeCompare(b.city) || a.bracket.localeCompare(b.bracket)
  );

  const criteria_label = dimensions
    .map((spec, i) => {
      const def = DIMENSION_REGISTRY_MAP.get(spec.id);
      return def ? def.bucketLabel(targetParts[i], spec.config) : targetParts[i];
    })
    .join(" × ");

  return NextResponse.json({
    scanned_at: new Date().toISOString(),
    source: "bet_features",
    criteria_label,
    criteria_key: criteriaKey,
    method: methodsToScan.length > 1 ? "all" : methodsToScan[0],
    methods_scanned: methodsToScan,
    cities_scanned: citiesToScan,
    match_count: matches.length,
    matches,
    builder_oldest_computed_at: oldest === null ? null : new Date(oldest).toISOString(),
    builder_stale: builderStale,
  });
}
