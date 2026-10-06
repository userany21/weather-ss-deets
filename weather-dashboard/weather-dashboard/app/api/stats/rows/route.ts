import { NextRequest, NextResponse } from "next/server";
import {
  getRowsForBucket,
  DIMENSION_REGISTRY_MAP,
  type DimensionSpec,
  type StatsFilters,
} from "@/lib/stats-aggregator";

/**
 * GET /api/stats/rows
 *
 * Drill-down endpoint for a single Market price details bucket. Returns
 * every raw `stats_features` doc that was folded into that bucket, so the
 * UI can show the underlying rows (date, bracket, price, W/L, edge, etc.)
 * without ever drifting from what /api/stats counted.
 *
 * Query parameters (mirrors /api/stats, minus minCount):
 *   by          Comma-separated dimension specs: id or id:configValue
 *               e.g. "city,price:10,first_tick_hour"
 *   bucketKey   Required. The composite bucket key from the /api/stats row,
 *               e.g. "city:munich|price:60:69|ft_hour:0:8AM"
 *   city        Comma-separated city allowlist, lowercase
 *   region      Comma-separated regions
 *   dateFrom    YYYY-MM-DD (inclusive)
 *   dateTo      YYYY-MM-DD (inclusive)
 *   method      "linear"|"reciprocal"|"combined" (comma-sep for multiple)
 *   resolvedOnly "1" — exclude unresolved market rows entirely
 *   dedupe      "0" — show raw rows (default: one row per city+date+bracket)
 *
 * Response:
 *   {
 *     rows: [{
 *       local_date, bracket, method, first_tick_price_cents,
 *       won, edge_cents, final_rank, resolved, winning_bracket,
 *       methods, dup_count
 *     }],
 *     bucket_label: string,
 *     bucket_key: string,
 *   }
 */

// Maps dimension id → the configSchema key for the single numeric config value
// passed via the URL e.g. "leader:0" → { n: 0 }  (mirrors /api/stats route)
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

      // Fill in defaults from the registry for any unset config keys
      const def = DIMENSION_REGISTRY_MAP.get(id);
      if (def?.configSchema && !(def.configSchema.key in config)) {
        config[def.configSchema.key] = def.configSchema.default;
      }

      return { id, config };
    });
}

function parseCSV(param: string | null): string[] | undefined {
  if (!param?.trim()) return undefined;
  const items = param
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

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

  const bucketKey = sp.get("bucketKey");
  if (!bucketKey) {
    return NextResponse.json(
      { error: "Missing 'bucketKey' param" },
      { status: 400 }
    );
  }

  const filters: StatsFilters = {
    cities: parseCSV(sp.get("city")),
    regions: parseCSV(sp.get("region")),
    dateFrom: sp.get("dateFrom") ?? undefined,
    dateTo: sp.get("dateTo") ?? undefined,
    methods: parseCSV(sp.get("method")),
    resolvedOnly: sp.get("resolvedOnly") === "1",
    dedupe: sp.get("dedupe") !== "0",
  };

  try {
    const { rows, bucketLabel } = await getRowsForBucket(
      filters,
      dimensions,
      bucketKey
    );

    return NextResponse.json({
      rows,
      bucket_label: bucketLabel,
      bucket_key: bucketKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
