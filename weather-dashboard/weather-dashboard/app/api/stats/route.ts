import { NextRequest, NextResponse } from "next/server";
import {
  aggregate,
  serializeRegistry,
  DIMENSION_REGISTRY_MAP,
  type DimensionSpec,
  type StatsFilters,
} from "@/lib/stats-aggregator";

/**
 * GET /api/stats
 *
 * Query parameters:
 *   by          Comma-separated dimension specs: id or id:configValue
 *               e.g. "leader:0,price:20"
 *               Config value is mapped to the dimension's configSchema.key.
 *               Mappings: leader→n, rank_at_hour→n, price→width (others ignored)
 *   city        Comma-separated city allowlist, lowercase  e.g. "tokyo,seoul"
 *   region      Comma-separated regions  e.g. "america,asia"
 *   dateFrom    YYYY-MM-DD  (inclusive)
 *   dateTo      YYYY-MM-DD  (inclusive)
 *   method      "linear"|"reciprocal"|"combined"  (comma-sep for multiple)
 *   minCount    Integer; buckets with fewer rows are omitted (default 0)
 *   resolvedOnly "1" — exclude unresolved market rows entirely
 *
 * Response:
 *   {
 *     dimensions: string[],
 *     filters: object,
 *     buckets: [{ key, label, count, resolved, win_rate, avg_edge_cents }],
 *     total_rows: number,
 *     dimension_registry: [{ id, label, configSchema }],
 *     computed_at: string | null,
 *   }
 *
 * Buckets are sorted by avg_edge_cents descending (nulls last),
 * with win_rate as the tiebreaker. The UI can re-sort client-side.
 */

// Maps dimension id → the configSchema key for the single numeric config value
// passed via the URL e.g. "leader:0" → { n: 0 }
const CONFIG_KEY_MAP: Record<string, string> = {
  leader: "n",
  rank_at_hour: "n",
  price: "width",
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

  const filters: StatsFilters = {
    cities: parseCSV(sp.get("city")),
    regions: parseCSV(sp.get("region")),
    dateFrom: sp.get("dateFrom") ?? undefined,
    dateTo: sp.get("dateTo") ?? undefined,
    methods: parseCSV(sp.get("method")),
    minCount: sp.has("minCount") ? Math.max(0, parseInt(sp.get("minCount")!, 10) || 0) : 0,
    resolvedOnly: sp.get("resolvedOnly") === "1",
  };

  try {
    const { buckets, totalRows, computedAt } = await aggregate(filters, dimensions);

    return NextResponse.json({
      dimensions: dimensions.map((d) => {
        const configEntries = Object.entries(d.config);
        return configEntries.length
          ? `${d.id}:${configEntries[0][1]}`
          : d.id;
      }),
      filters: {
        cities: filters.cities,
        regions: filters.regions,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        methods: filters.methods,
        minCount: filters.minCount,
        resolvedOnly: filters.resolvedOnly,
      },
      buckets,
      total_rows: totalRows,
      dimension_registry: serializeRegistry(),
      computed_at: computedAt?.toISOString() ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
