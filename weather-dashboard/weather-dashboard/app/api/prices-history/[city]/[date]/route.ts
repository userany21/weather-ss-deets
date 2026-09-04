import { NextResponse } from "next/server";
import { getCityConfig } from "@/lib/cities-config";

// ---------------------------------------------------------------------------
// Helpers — mirrors the slug-building logic in backfill-winning-outcomes.js
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function buildEventSlug(city: string, isoDate: string): string {
  const citySlug = city.toLowerCase().replace(/\s+/g, "-");
  const [year, month, day] = isoDate.split("-").map(Number);
  return `highest-temperature-in-${citySlug}-on-${MONTH_NAMES[month - 1]}-${day}-${year}`;
}

/**
 * Strips the degree+unit suffix from a groupItemTitle:
 *   "68-69°F"         -> "68-69"
 *   "90°F or higher"  -> "90 or higher"
 *   "30°C or below"   -> "30 or below"
 */
function stripUnit(title: string): string {
  return title.replace(/°[FC]/gi, "").trim();
}

/** Returns the numeric lower bound of a stripped bracket label. */
function parseLow(stripped: string): number {
  if (stripped.toLowerCase().includes("or below")) return -Infinity;
  const m = stripped.match(/^(-?\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// 16-color palette — enough for all bracket markets on a single weather event
const BRACKET_COLORS = [
  "#4a90d9", "#e74c3c", "#2ecc71", "#f39c12",
  "#9b59b6", "#1abc9c", "#e67e22", "#3498db",
  "#c0392b", "#27ae60", "#8e44ad", "#d35400",
  "#f1c40f", "#16a085", "#2980b9", "#e91e63",
];

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Returns the UTC offset in milliseconds for a given IANA timezone on a
 * given ISO date (e.g. "2026-09-03"). Positive = east of UTC (e.g. Asia/Tokyo
 * = +9h = +32400000). Negative = west of UTC (e.g. America/Los_Angeles in PDT
 * = -7h = -25200000).
 *
 * Uses noon UTC on the date as the reference point — safe for any timezone
 * because noon UTC is never within DST transition hours.
 */
function getTzOffsetMs(isoDate: string, timezone: string): number {
  const noonUtc = new Date(`${isoDate}T12:00:00Z`);

  // Format noon UTC in the target timezone to find the local hour
  const localHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(noonUtc),
    10
  );

  // offset = local - UTC  →  localHour - 12 (hours), converted to ms
  // e.g. Tokyo: local 21 - UTC 12 = +9h; LA PDT: local 5 - UTC 12 = -7h
  return (localHour - 12) * 60 * 60 * 1000;
}

/**
 * Converts a local-time hour on an ISO date into a real UTC unix timestamp
 * (seconds), given the timezone's offset on that date.
 */
function localHourToUtcSeconds(isoDate: string, hour: number, tzOffsetMs: number): number {
  // "isoDate T hour:00:00 Z" is treated as UTC; subtract the offset to get
  // the real UTC instant that corresponds to `hour` o'clock local time.
  const fakeUtcMs = new Date(`${isoDate}T${String(hour).padStart(2, "0")}:00:00Z`).getTime();
  return Math.floor((fakeUtcMs - tzOffsetMs) / 1000);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

// Revalidate every 5 min — short enough to pick up live changes today,
// cheap enough for historical days (they never change after market close).
export const revalidate = 300;

export interface BracketHistoryEntry {
  t: number; // unix seconds (real UTC)
  p: number; // 0–1 float
}

export interface BracketResult {
  label: string;   // e.g. "68-69"  (unit stripped)
  low: number;     // numeric lower bound, -Infinity for "or below" tail
  color: string;
  history: BracketHistoryEntry[];
}

export async function GET(
  _req: Request,
  { params }: { params: { city: string; date: string } }
) {
  const city = decodeURIComponent(params.city).toLowerCase();
  const date = params.date;

  // ------------------------------------------------------------------
  // 0. Resolve timezone for this city
  // ------------------------------------------------------------------
  const cityConfig = getCityConfig(city);
  const timezone = cityConfig?.timezone ?? "UTC";
  const tzOffsetMs = getTzOffsetMs(date, timezone);

  // Real UTC window covering 8am–6pm local time on this date
  const startTs = localHourToUtcSeconds(date, 8, tzOffsetMs);
  const endTs   = localHourToUtcSeconds(date, 18, tzOffsetMs);

  const slug = buildEventSlug(city, date);

  // ------------------------------------------------------------------
  // 1. Fetch event metadata from gamma API → get all bracket markets
  // ------------------------------------------------------------------
  let event: Record<string, unknown>;
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/events/slug/${slug}`,
      { next: { revalidate } }
    );
    if (!res.ok) {
      console.warn(`[prices-history] gamma API ${res.status} for slug "${slug}"`);
      return NextResponse.json({ brackets: [], tzOffsetMs });
    }
    const json = await res.json();
    event = Array.isArray(json) ? json[0] : json;
  } catch (err) {
    console.error("[prices-history] gamma fetch failed:", err);
    return NextResponse.json({ brackets: [], tzOffsetMs });
  }

  if (!event?.markets || !Array.isArray(event.markets) || event.markets.length === 0) {
    return NextResponse.json({ brackets: [], tzOffsetMs });
  }

  // ------------------------------------------------------------------
  // 2. Extract Yes token IDs for each bracket market
  // ------------------------------------------------------------------
  type BracketMeta = { label: string; low: number; yesTokenId: string };
  const bracketMetas: BracketMeta[] = [];

  for (const market of event.markets as Record<string, unknown>[]) {
    try {
      const outcomes = JSON.parse(market.outcomes as string) as string[];
      const tokenIds = JSON.parse(market.clobTokenIds as string) as string[];
      const yesIdx = outcomes.indexOf("Yes");
      if (yesIdx === -1 || !tokenIds[yesIdx]) continue;

      const label = stripUnit(market.groupItemTitle as string);
      bracketMetas.push({
        label,
        low: parseLow(label),
        yesTokenId: tokenIds[yesIdx],
      });
    } catch {
      // Malformed market entry — skip
      continue;
    }
  }

  if (bracketMetas.length === 0) {
    return NextResponse.json({ brackets: [], tzOffsetMs });
  }

  // Sort ascending by lower bound (tail "or below" sorts first, "or higher" last)
  bracketMetas.sort((a, b) => {
    if (a.low === -Infinity) return -1;
    if (b.low === -Infinity) return 1;
    return a.low - b.low;
  });

  // ------------------------------------------------------------------
  // 3. Fetch price histories from CLOB API in parallel
  //    Scoped to 8am–6pm local via startTs/endTs
  // ------------------------------------------------------------------
  const histories = await Promise.all(
    bracketMetas.map(async (bm) => {
      try {
        const url =
          `https://clob.polymarket.com/prices-history` +
          `?market=${bm.yesTokenId}` +
          `&interval=1d` +
          `&fidelity=1` +
          `&startTs=${startTs}` +
          `&endTs=${endTs}`;
        const res = await fetch(url, { next: { revalidate } });
        if (!res.ok) return { ...bm, history: [] as BracketHistoryEntry[] };
        const data = await res.json();
        // Filter to the 8am–6pm local window. The CLOB API's interval=1d
        // ignores startTs/endTs and always returns the full UTC day, so we
        // trim here after the fact.
        const history = ((data.history ?? []) as BracketHistoryEntry[]).filter(
          (h) => h.t >= startTs && h.t <= endTs
        );
        return { ...bm, history };
      } catch {
        return { ...bm, history: [] as BracketHistoryEntry[] };
      }
    })
  );

  // ------------------------------------------------------------------
  // 4. Assign colors and return (include tzOffsetMs for snap alignment)
  // ------------------------------------------------------------------
  const brackets: BracketResult[] = histories.map((h, i) => ({
    label: h.label,
    low: h.low,
    color: BRACKET_COLORS[i % BRACKET_COLORS.length],
    history: h.history,
  }));

  return NextResponse.json({ brackets, tzOffsetMs });
}
