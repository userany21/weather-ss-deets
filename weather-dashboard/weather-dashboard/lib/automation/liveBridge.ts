import { getLiveFeatures } from "@/lib/live-features";
import {
  DIMENSION_REGISTRY_MAP,
  resolveEntry,
  dedupeBets,
  type DimensionDef,
  type DimensionSpec,
  type FeatureRow,
} from "@/lib/stats-aggregator";

/**
 * liveBridge.ts: which brackets match a saved rule right now.
 *
 * This is app/api/scan/route.ts with ONE change: the entry-price skip is removed.
 * /api/scan drops any row that has no entry price. For "Rank 1 before 12PM" the entry price is the first
 * 12PM tick. That tick does not exist yet at the 11AM closing tick, so /api/scan returns nothing at the moment
 * the order must go out. The match itself (rank, lead margin, and so on) is already known at that time.
 *
 * Keep this file in step with app/api/scan/route.ts. The pieces below are copied from it:
 *   CONFIG_KEY_MAP, FIRST_TICK_DIMENSION_IDS, parseDimensions, the method choice, resolveEntry, the loader call,
 *   the bucket() match loop and dedupeBets.
 *
 * Rank, leader, lead-margin and rank-trend read the hour BEFORE their label. So ticks that arrive after the
 * closing tick do not change the answer. The worker calls this only after the closing tick is stored and fresh.
 */

const CONFIG_KEY_MAP: Record<string, string> = {
  leader: "n",
  rank_at_hour: "n",
  price: "width",
  price_at_hour: "n",
  lead_margin: "n",
  rank_trend: "n",
};

// Same ids as FIRST_TICK_DIMENSION_IDS in app/api/scan/route.ts.
const FIRST_TICK_DIMENSION_IDS = new Set(["price", "first_tick_hour"]);

const ALL_METHODS = ["linear", "reciprocal", "combined"] as const;
type ScanMethod = (typeof ALL_METHODS)[number];
const isMethod = (v: string): v is ScanMethod => (ALL_METHODS as readonly string[]).includes(v);

export interface BridgeArgs {
  /** Same text /api/scan takes in `by`, for example "rank_at_hour:4". */
  by: string;
  /** Pipe-joined bucket keys, for example "rank_h:4:1". */
  criteriaKey: string;
  /** "combined" | "linear" | "reciprocal" | "all". */
  method: string;
  /** Lowercase city key, for example "seoul". */
  city: string;
  /** City-local date the worker is evaluating, YYYY-MM-DD. Rows for any other date are ignored. */
  localDate: string;
}

export interface BridgeMatch {
  bracket: string;
  method: string;
  methods?: string[];
}

function parseDimensions(byParam: string): DimensionSpec[] {
  if (!byParam.trim()) return [];
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
      const def = DIMENSION_REGISTRY_MAP.get(id);
      if (def?.configSchema && !(def.configSchema.key in config)) {
        config[def.configSchema.key] = def.configSchema.default;
      }
      return { id, config };
    });
}

export async function evaluateRule(args: BridgeArgs): Promise<BridgeMatch[]> {
  const dimensions = parseDimensions(args.by);
  if (dimensions.length === 0) throw new Error("rule has no dimensions");

  const targetParts = args.criteriaKey.split("|");
  if (targetParts.length !== dimensions.length) {
    throw new Error(`criteriaKey has ${targetParts.length} parts but ${dimensions.length} dimension(s) were given`);
  }

  const city = args.city.trim().toLowerCase();

  // Which methods to scan: same choice as /api/scan.
  const methodParam = args.method.trim().toLowerCase();
  const methodIdx = dimensions.findIndex((d) => d.id === "method");
  const keyMethod = methodIdx !== -1 ? targetParts[methodIdx].replace("method:", "") : null;
  let methodsToScan: ScanMethod[];
  if (keyMethod !== null && isMethod(keyMethod)) methodsToScan = [keyMethod];
  else if (methodParam === "all") methodsToScan = [...ALL_METHODS];
  else methodsToScan = [isMethod(methodParam) ? methodParam : "combined"];

  const dimDefs: Array<{ def: DimensionDef; config: Record<string, number> }> = dimensions.map((spec) => {
    const def = DIMENSION_REGISTRY_MAP.get(spec.id);
    if (!def) throw new Error(`Unknown dimension: "${spec.id}"`);
    return { def, config: spec.config };
  });

  // Same entry rule as the Stats table. An end-of-day filter can never be traded.
  const entry = resolveEntry(dimensions);
  if (entry.kind === "none") throw new Error("not tradeable in live: a filter uses end-of-day data");

  const firstPredictionOnly = dimensions.some((d) => FIRST_TICK_DIMENSION_IDS.has(d.id));

  const scanned: Array<{ method: ScanMethod; rows: FeatureRow[] }> = await Promise.all(
    methodsToScan.map(async (m) => ({
      method: m,
      rows: await getLiveFeatures({ cities: [city], method: m, firstPredictionOnly }),
    })),
  );

  const matches: Array<{ city: string; bracket: string; local_date: string; method: ScanMethod }> = [];
  for (const { method: rowMethod, rows } of scanned) {
    for (const row of rows) {
      if (row.local_date !== args.localDate) continue;

      let matched = true;
      for (let i = 0; i < dimDefs.length; i++) {
        const bucketKey = dimDefs[i].def.bucket(row, dimDefs[i].config);
        if (bucketKey !== targetParts[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      // /api/scan skips the row here when it has no entry price. We do NOT: see the header.
      matches.push({ city: row.city, bracket: row.bracket, local_date: row.local_date, method: rowMethod });
    }
  }

  // One bet per city + date + bracket, as in /api/scan.
  return dedupeBets(matches, (m) => m, true).map(({ item, methods }) => ({
    bracket: item.bracket,
    method: item.method,
    methods,
  }));
}
