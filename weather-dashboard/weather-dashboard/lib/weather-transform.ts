// lib/weather-transform.ts
//
// Tick → EnrichedTick pipeline.
//   - paced_at: anchors the site's "pacing" clock string to local_date,
//     rolling into the next day whenever the clock wraps past midnight.
//   - point_bracket: preferred source is the bracket field stored on each doc
//     by the n8n workflow at insert time (exact Polymarket market title).
//     For backfilled docs (bracket === null) the same rounding rule n8n uses
//     is applied to weighted_avg — floor unless decimal ≥ 0.8, then ceil —
//     so bucket assignment is consistent regardless of when winning_bracket_low
//     / winning_bracket_high were backfilled.

export interface Tick {
  captured_at: string | Date;
  pacing_time: string | null;
  local_date: string; // "YYYY-MM-DD"
  city: string;
  weighted_avg: number | null;
  unit: "F" | "C";
  /** Polymarket market groupItemTitle stored by n8n at insert time; null for backfilled docs. */
  bracket: string | null;
  yes_price: number | null;
  winning_bracket: string | null;
  winning_bracket_low: number | null;
  winning_bracket_high: number | null;
}

export interface EnrichedTick extends Tick {
  /** ms since epoch, x-axis value for both charts */
  paced_at: number | null;
  /** bracket string this weighted_avg fell into at this moment, e.g. "92-93°F" */
  point_bracket: string | null;
}

/** Parses "1:30 PM" -> { hour24, minute }. Returns null if unparseable. */
function parsePacingTime(raw: string): { hour24: number; minute: number } | null {
  const m = raw.trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const meridiem = m[3];
  if (hour === 12) hour = 0;
  if (meridiem === "PM") hour += 12;
  return { hour24: hour, minute };
}

/**
 * Builds paced_at (ms epoch) for every tick, anchored to local_date, rolling
 * into subsequent days whenever minutes-since-midnight drops by more than
 * 12h from the previous tick (mirrors the pandas `day_offset` cumsum trick).
 */
function attachPacedAt(ticks: Tick[]): (Tick & { paced_at: number | null; _mins: number | null })[] {
  const base = Date.parse(ticks[0]?.local_date + "T00:00:00Z");
  let dayOffset = 0;
  let prevMins: number | null = null;

  return ticks.map((t) => {
    if (!t.pacing_time) return { ...t, paced_at: null, _mins: null };
    const parsed = parsePacingTime(t.pacing_time);
    if (!parsed) return { ...t, paced_at: null, _mins: null };

    const mins = parsed.hour24 * 60 + parsed.minute;
    if (prevMins !== null && mins - prevMins < -12 * 60) {
      dayOffset += 1;
    }
    prevMins = mins;

    const dayBase = Date.parse(t.local_date + "T00:00:00Z");
    const paced_at = dayBase + dayOffset * 24 * 60 * 60 * 1000 + mins * 60 * 1000;
    return { ...t, paced_at, _mins: mins };
  });
}

/**
 * Fallback bracket label for backfilled docs (bracket === null).
 *
 * Replicates the exact rounding rule used by the n8n workflow's
 * "Code in JavaScript2" and "Code in JavaScript6" nodes:
 *   floor the value; if the decimal part is ≥ 0.8, round up instead.
 * Then formats the resulting integer into a label that matches the style
 * Polymarket uses for that unit:
 *   Celsius  → single-degree  e.g. "26°C"
 *   Fahrenheit → two-degree   e.g. "90-91°F"  (low always on an even boundary)
 */
export function fallbackBracketLabel(weightedAvg: number, unit: "F" | "C"): string {
  const floor = Math.floor(weightedAvg);
  const decimal = weightedAvg - floor;
  const rounded = decimal >= 0.8 ? floor + 1 : floor;

  if (unit === "C") {
    return `${rounded}°C`;
  }
  // Fahrenheit brackets are 2°F wide, anchored at even integers.
  const low = Math.floor(rounded / 2) * 2;
  return `${low}-${low + 1}°F`;
}

function modalUnit(ticks: Tick[]): "F" | "C" {
  const counts: Record<string, number> = {};
  for (const t of ticks) counts[t.unit] = (counts[t.unit] ?? 0) + 1;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as "F" | "C") ?? "F";
}

/**
 * Full pipeline — returns enriched, sorted ticks ready for recharts.
 *
 * point_bracket priority per tick:
 *   1. tick.bracket  — stored by n8n at insert time; exact Polymarket market
 *      title, assigned with the same ≥0.8-decimal rule used at write time.
 *   2. fallbackBracketLabel(weighted_avg, unit)  — for backfilled docs only
 *      (bracket === null); applies the identical n8n rounding rule so the
 *      bucket assignment is stable regardless of winning_bracket_low/high.
 */
export function enrichDay(rawTicks: Tick[]): {
  ticks: EnrichedTick[];
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
  unit: "F" | "C";
} {
  const sorted = [...rawTicks].sort(
    (a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
  );

  const withPacedAt = attachPacedAt(sorted)
    .filter((t) => t.paced_at !== null)
    .sort((a, b) => (a.paced_at! - b.paced_at!));

  const lastNonNull = <K extends keyof Tick>(key: K) => {
    for (let i = withPacedAt.length - 1; i >= 0; i--) {
      const v = withPacedAt[i][key];
      if (v !== null && v !== undefined) return v as Tick[K];
    }
    return null;
  };

  const winningLow = (lastNonNull("winning_bracket_low") as number | null) ?? null;
  const winningHigh = (lastNonNull("winning_bracket_high") as number | null) ?? null;
  const winningBracket = (lastNonNull("winning_bracket") as string | null) ?? null;
  const unit = modalUnit(sorted);

  const ticks: EnrichedTick[] = withPacedAt.map((t) => {
    // Use the bracket stored at insert time when available; compute the
    // equivalent n8n-rule label only for backfilled docs where it is absent.
    let point_bracket: string | null = null;
    if (t.bracket != null) {
      point_bracket = t.bracket;
    } else if (t.weighted_avg != null) {
      point_bracket = fallbackBracketLabel(t.weighted_avg, t.unit);
    }
    return { ...t, point_bracket };
  });

  return { ticks, winningLow, winningHigh, winningBracket, unit };
}
