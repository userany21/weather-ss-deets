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
 *   method      "linear"|"reciprocal"|"combined"  (default "combined")
 *
 * Response:
 *   {
 *     scanned_at: string,
 *     criteria_label: string,
 *     criteria_key: string,
 *     method: string,
 *     cities_scanned: string[],
 *     match_count: number,
 *     matches: [{
 *       city, bracket, local_date, local_time,
 *       tick_count, lead_margin_pct, rank_now, rank_prev
 *     }]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { getLiveFeatures } from "@/lib/live-features";
import {
  DIMENSION_REGISTRY_MAP,
  type DimensionSpec,
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

  const method = (sp.get("method") ?? "combined") as
    | "linear"
    | "reciprocal"
    | "combined";

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

  // Infer criteria hour from any dimension that uses "n" config
  // (used to extract display signals — lead margin %, rank trend)
  let criteriaHour = 4; // default to 12PM
  for (const { def, config } of dimDefs) {
    if (def.configSchema?.key === "n" && typeof config.n === "number") {
      criteriaHour = Math.min(Math.max(Math.round(config.n), 0), 9);
      break;
    }
  }
  const prevHour = Math.max(0, criteriaHour - 2); // 2-hour lookback (matches rank_trend)

  // Fetch live feature rows for today
  let liveRows;
  try {
    liveRows = await getLiveFeatures({ cities: citiesToScan, method });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to fetch live data: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 }
    );
  }

  // Match rows against criteria
  const matches: Array<{
    city: string;
    bracket: string;
    local_date: string;
    local_time: string;
    tick_count: number;
    lead_margin_pct: number | null;
    rank_now: number | null;
    rank_prev: number | null;
  }> = [];

  for (const row of liveRows) {
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
      tick_count: tickCount,
      lead_margin_pct,
      rank_now,
      rank_prev,
    });
  }

  // Build human-readable criteria label
  const criteria_label = dimDefs
    .map((d, i) => d.def.bucketLabel(targetParts[i], d.config))
    .join(" × ");

  return NextResponse.json({
    scanned_at: new Date().toISOString(),
    criteria_label,
    criteria_key: criteriaKey,
    method,
    cities_scanned: citiesToScan,
    match_count: matches.length,
    matches,
  });
}
