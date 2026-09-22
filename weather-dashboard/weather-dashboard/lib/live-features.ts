/**
 * lib/live-features.ts
 *
 * Computes FeatureRow-equivalent signals for today's in-progress city data
 * directly from the raw high-temp and reciprocal collections — without needing
 * the pre-computed stats_features batch.
 *
 * This is a TypeScript port of the core logic in stats/build-feature-table.js,
 * run on-demand against today's live ticks.
 */

import { getDb } from "./mongodb";
import { CITIES, getCityConfig } from "./cities-config";
import type { FeatureRow } from "./stats-aggregator";

const NUM_HOUR_BUCKETS = 10; // hour0=8AM … hour9=5PM

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawTick {
  city: string;
  local_date: string;
  bracket: string | null;
  pacing_time: string | null;
  captured_at: string | Date;
  yes_price_cents?: number | null;
}

interface BracketAccum {
  ticksPerHour: number[];
  firstTick: {
    captured_at: string;
    pacing_time: string | null;
    yes_price_cents: number | null;
  } | null;
  firstPricePerHour: (number | null)[];
  firstCapturedAtPerHour: (string | null)[];
}

// ---------------------------------------------------------------------------
// Helpers (mirrors build-feature-table.js)
// ---------------------------------------------------------------------------

function pacingTimeToBucket(pt: string | null): number | null {
  if (!pt) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(pt.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const meridiem = m[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour < 8 || hour >= 18) return null;
  return hour - 8;
}

function capAt(doc: RawTick): string {
  return typeof doc.captured_at === "string"
    ? doc.captured_at
    : (doc.captured_at as Date).toISOString();
}

/** Build per-bracket accumulator map from raw tick docs. */
function buildBracketData(
  docs: RawTick[]
): Map<string, Map<string, BracketAccum>> {
  // Outer key: "city|local_date", inner key: bracket string
  const data = new Map<string, Map<string, BracketAccum>>();

  for (const doc of docs) {
    if (!doc.bracket) continue;
    const cdKey = `${doc.city}|${doc.local_date}`;
    if (!data.has(cdKey)) data.set(cdKey, new Map());
    const brs = data.get(cdKey)!;

    if (!brs.has(doc.bracket)) {
      brs.set(doc.bracket, {
        ticksPerHour: new Array(NUM_HOUR_BUCKETS).fill(0),
        firstTick: null,
        firstPricePerHour: new Array(NUM_HOUR_BUCKETS).fill(null),
        firstCapturedAtPerHour: new Array(NUM_HOUR_BUCKETS).fill(null),
      });
    }
    const br = brs.get(doc.bracket)!;

    const bucket = pacingTimeToBucket(doc.pacing_time);
    if (bucket !== null) {
      br.ticksPerHour[bucket]++;
      const ca = capAt(doc);
      if (
        typeof doc.yes_price_cents === "number" &&
        (br.firstCapturedAtPerHour[bucket] === null ||
          ca < br.firstCapturedAtPerHour[bucket]!)
      ) {
        br.firstCapturedAtPerHour[bucket] = ca;
        br.firstPricePerHour[bucket] = doc.yes_price_cents;
      }
    }

    const ca = capAt(doc);
    if (!br.firstTick || ca < br.firstTick.captured_at) {
      br.firstTick = {
        captured_at: ca,
        pacing_time: doc.pacing_time,
        yes_price_cents:
          typeof doc.yes_price_cents === "number" ? doc.yes_price_cents : null,
      };
    }
  }

  return data;
}

/** Deep-merge two bracket data maps — sums tick counts, keeps earlier prices. */
function mergeBracketData(
  mapA: Map<string, Map<string, BracketAccum>>,
  mapB: Map<string, Map<string, BracketAccum>>
): Map<string, Map<string, BracketAccum>> {
  const merged = new Map<string, Map<string, BracketAccum>>();

  // Deep-copy A into merged
  for (const [cdKey, brsA] of mapA) {
    const brs = new Map<string, BracketAccum>();
    for (const [b, brA] of brsA) {
      brs.set(b, {
        ticksPerHour: [...brA.ticksPerHour],
        firstTick: brA.firstTick,
        firstPricePerHour: [...brA.firstPricePerHour],
        firstCapturedAtPerHour: [...brA.firstCapturedAtPerHour],
      });
    }
    merged.set(cdKey, brs);
  }

  // Merge B into merged
  for (const [cdKey, brsB] of mapB) {
    if (!merged.has(cdKey)) {
      const brs = new Map<string, BracketAccum>();
      for (const [b, brB] of brsB) {
        brs.set(b, {
          ticksPerHour: [...brB.ticksPerHour],
          firstTick: brB.firstTick,
          firstPricePerHour: [...brB.firstPricePerHour],
          firstCapturedAtPerHour: [...brB.firstCapturedAtPerHour],
        });
      }
      merged.set(cdKey, brs);
      continue;
    }
    const brsM = merged.get(cdKey)!;
    for (const [b, brB] of brsB) {
      if (!brsM.has(b)) {
        brsM.set(b, {
          ticksPerHour: [...brB.ticksPerHour],
          firstTick: brB.firstTick,
          firstPricePerHour: [...brB.firstPricePerHour],
          firstCapturedAtPerHour: [...brB.firstCapturedAtPerHour],
        });
      } else {
        const brM = brsM.get(b)!;
        for (let i = 0; i < NUM_HOUR_BUCKETS; i++) {
          brM.ticksPerHour[i] += brB.ticksPerHour[i];
          if (
            brB.firstCapturedAtPerHour[i] !== null &&
            (brM.firstCapturedAtPerHour[i] === null ||
              brB.firstCapturedAtPerHour[i]! < brM.firstCapturedAtPerHour[i]!)
          ) {
            brM.firstCapturedAtPerHour[i] = brB.firstCapturedAtPerHour[i];
            brM.firstPricePerHour[i] = brB.firstPricePerHour[i];
          }
        }
        if (
          brB.firstTick &&
          (!brM.firstTick ||
            brB.firstTick.captured_at < brM.firstTick.captured_at)
        ) {
          brM.firstTick = brB.firstTick;
        }
      }
    }
  }

  return merged;
}

/**
 * Compute FeatureRow-shaped objects from a bracket data map.
 * resolved/won/edge_cents are always null (today is in-progress).
 */
function buildFeatureRows(
  bracketData: Map<string, Map<string, BracketAccum>>,
  method: "linear" | "reciprocal" | "combined"
): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const now = new Date();

  for (const [cdKey, brackets] of bracketData) {
    const pipeIdx = cdKey.indexOf("|");
    const city = cdKey.slice(0, pipeIdx);
    const local_date = cdKey.slice(pipeIdx + 1);

    const bracketsArr = [...brackets.entries()]; // [bracket, BracketAccum][]

    // Cumulative tick counts per bracket per hour bucket
    const cumByBracket = new Map<string, number[]>();
    for (const [bracket, br] of bracketsArr) {
      const cum = new Array(NUM_HOUR_BUCKETS).fill(0);
      let running = 0;
      for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
        running += br.ticksPerHour[n];
        cum[n] = running;
      }
      cumByBracket.set(bracket, cum);
    }

    // Sort all brackets by cumulative count at each hour
    const rankAtHour: Array<Array<[string, number]>> = [];
    for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
      const sorted = bracketsArr
        .map(([b]) => [b, cumByBracket.get(b)![n]] as [string, number])
        .sort((a, b) => b[1] - a[1]);
      rankAtHour.push(sorted);
    }

    // Lead margin per hour — city-day level signal
    const lead_margin_through_hour = new Array<number>(NUM_HOUR_BUCKETS).fill(0);
    for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
      const sorted = rankAtHour[n];
      const totalTicks = sorted.reduce((s, [, c]) => s + c, 0);
      if (totalTicks === 0) continue;
      const rank1Count = sorted[0][1];
      const rank2Count = sorted.length > 1 ? sorted[1][1] : 0;
      lead_margin_through_hour[n] = (rank1Count - rank2Count) / totalTicks;
    }

    // Per-bracket signals
    for (const [bracket, br] of bracketsArr) {
      const cum = cumByBracket.get(bracket)!;

      const rank_through_hour: (number | null)[] = new Array(NUM_HOUR_BUCKETS).fill(null);
      const is_leader_through_hour: boolean[] = new Array(NUM_HOUR_BUCKETS).fill(false);

      for (let n = 0; n < NUM_HOUR_BUCKETS; n++) {
        const sorted = rankAtHour[n];
        const myCount = cum[n];
        let rank = 1;
        for (const [b] of sorted) {
          if (b === bracket) {
            rank_through_hour[n] = rank;
            break;
          }
          rank++;
        }
        const maxCount = sorted.length > 0 ? sorted[0][1] : 0;
        is_leader_through_hour[n] = myCount > 0 && myCount === maxCount;
      }

      const ft = br.firstTick;
      const first_tick_price_cents = ft?.yes_price_cents ?? null;
      const first_tick_hour = ft?.pacing_time
        ? pacingTimeToBucket(ft.pacing_time)
        : null;
      const has_price = typeof first_tick_price_cents === "number";

      rows.push({
        city,
        local_date,
        bracket,
        method,
        first_tick_price_cents,
        first_tick_hour,
        has_price,
        tick_count_through_hour: cum,
        rank_through_hour,
        is_leader_through_hour,
        price_at_hour: br.firstPricePerHour,
        lead_margin_through_hour,
        final_tick_count: cum[NUM_HOUR_BUCKETS - 1],
        final_rank: rank_through_hour[NUM_HOUR_BUCKETS - 1],
        resolved: false,
        won: null,
        edge_cents: null,
        computed_at: now,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LiveFeatureOptions {
  cities: string[];
  /** Defaults to "combined" */
  method?: "linear" | "reciprocal" | "combined";
}

/**
 * Fetch today's in-progress feature rows for the given cities.
 * Uses each city's IANA timezone to determine "today's" local date.
 * Returns one FeatureRow per (city, bracket) for the requested method.
 */
export async function getLiveFeatures(
  opts: LiveFeatureOptions
): Promise<FeatureRow[]> {
  const { method = "combined" } = opts;
  const cities =
    opts.cities.length > 0 ? opts.cities : CITIES.map((c) => c.city);

  const db = await getDb();
  const linearCol = db.collection("high-temp");
  const reciprocalCol = db.collection("reciprocal");

  // Determine today's local date per city using IANA timezone
  const cityDates = new Map<string, string>();
  for (const city of cities) {
    const cfg = getCityConfig(city);
    const tz = cfg?.timezone ?? "UTC";
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz }); // en-CA → YYYY-MM-DD
    cityDates.set(city, fmt.format(new Date()));
  }

  // Single query for all (city, localDate) pairs
  const cityDateFilter = cities.map((c) => ({
    city: c,
    local_date: cityDates.get(c)!,
  }));

  const baseMatch = {
    $or: cityDateFilter,
    bracket: { $ne: null, $exists: true },
  };

  const projection = {
    city: 1,
    local_date: 1,
    bracket: 1,
    pacing_time: 1,
    captured_at: 1,
    yes_price_cents: 1,
  };

  const [linearDocs, reciprocalDocs] = await Promise.all([
    method !== "reciprocal"
      ? linearCol
          .find(baseMatch, { projection })
          .sort({ captured_at: 1 })
          .toArray()
      : Promise.resolve([]),
    method !== "linear"
      ? reciprocalCol
          .find(baseMatch, { projection })
          .sort({ captured_at: 1 })
          .toArray()
      : Promise.resolve([]),
  ]);

  const linearData = buildBracketData(linearDocs as unknown as RawTick[]);
  const reciprocalData = buildBracketData(
    reciprocalDocs as unknown as RawTick[]
  );

  let bracketData: Map<string, Map<string, BracketAccum>>;
  if (method === "linear") {
    bracketData = linearData;
  } else if (method === "reciprocal") {
    bracketData = reciprocalData;
  } else {
    bracketData = mergeBracketData(linearData, reciprocalData);
  }

  return buildFeatureRows(bracketData, method);
}
