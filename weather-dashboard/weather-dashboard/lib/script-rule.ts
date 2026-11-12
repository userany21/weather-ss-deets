import { DIMENSION_REGISTRY_MAP, HOUR_LABELS, type DimensionSpec } from "@/lib/stats-aggregator";

/**
 * Turns a rule string printed by combo_search_fast.py into the pieces the app stores
 * and matches: `by` (same text /api/scan and automation_rules.by_param use), `criteriaKey`
 * (the pipe-joined bucket keys) and the dimension specs.
 *
 *   "first_tick_hour=8AM | lead_margin:7=moderate"
 *     by          = "first_tick_hour,lead_margin:7"
 *     criteriaKey = "ft_hour:0:8AM|lm:7:moderate"
 *
 * Only dimensions a bot can trade are supported. final_rank and final_tick_count throw.
 */

const CONFIG_KEY: Record<string, string> = {
  leader: "n",
  rank_at_hour: "n",
  price: "width",
  price_at_hour: "n",
  lead_margin: "n",
  rank_trend: "n",
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function priceRange(value: string): [string, string] {
  const m = /^(\d+)-(\d+)c$/.exec(value);
  if (!m) throw new Error(`bad price bucket: "${value}"`);
  return [m[1], m[2]];
}

export function parseScriptRule(text: string): {
  by: string;
  criteriaKey: string;
  dimensions: DimensionSpec[];
} {
  const by: string[] = [];
  const keys: string[] = [];
  const dimensions: DimensionSpec[] = [];

  for (const raw of text.split("|")) {
    const term = raw.trim();
    if (!term) continue;
    const eq = term.indexOf("=");
    if (eq < 0) throw new Error(`bad term (no "="): "${term}"`);
    const byId = term.slice(0, eq).trim();
    const value = term.slice(eq + 1).trim();
    const [id, cfg] = byId.split(":");
    if (!DIMENSION_REGISTRY_MAP.has(id)) throw new Error(`unknown dimension: "${id}"`);
    const n = cfg === undefined ? NaN : Number(cfg);

    let key: string;
    switch (id) {
      case "city":
        key = `city:${value}`;
        break;
      case "method":
        key = `method:${value}`;
        break;
      case "day_of_week": {
        const i = DOW.indexOf(value);
        if (i < 0) throw new Error(`bad day: "${value}"`);
        key = `dow:${i}:${value}`;
        break;
      }
      case "first_tick_hour": {
        const i = HOUR_LABELS.indexOf(value);
        if (i < 0) throw new Error(`bad hour: "${value}"`);
        key = `ft_hour:${i}:${value}`;
        break;
      }
      case "price": {
        const [lo, hi] = priceRange(value);
        key = `price:${lo}:${hi}`;
        break;
      }
      case "price_at_hour": {
        const [lo, hi] = priceRange(value);
        key = `pah:${n}:${lo}:${hi}`;
        break;
      }
      case "leader":
        key = `leader:${n}:${value === "Yes"}`;
        break;
      case "rank_at_hour":
        key = `rank_h:${n}:${value}`;
        break;
      case "lead_margin":
        key = `lm:${n}:${value}`;
        break;
      case "rank_trend":
        key = `rt:${n}:${value}`;
        break;
      default:
        throw new Error(`dimension not supported for trading: "${id}"`);
    }

    const cfgKey = CONFIG_KEY[id];
    const config: Record<string, number> = {};
    if (cfgKey && Number.isFinite(n)) config[cfgKey] = n;
    const def = DIMENSION_REGISTRY_MAP.get(id);
    if (def?.configSchema && !(def.configSchema.key in config)) {
      config[def.configSchema.key] = def.configSchema.default;
    }
    by.push(byId);
    keys.push(key);
    dimensions.push({ id, config });
  }

  if (dimensions.length === 0) throw new Error("rule has no terms");
  return { by: by.join(","), criteriaKey: keys.join("|"), dimensions };
}
