// lib/weather-transform.ts
//
// Direct TS port of the pandas logic in analyze_weather.py:
//   - paced_at: anchors the site's "pacing" clock string to local_date,
//     rolling into the next day whenever the clock wraps past midnight.
//   - make_bracket_labeler: buckets weighted_avg into the market's bracket
//     grid, anchored on the day's winning bracket when known.

export interface Tick {
  captured_at: string | Date;
  pacing_time: string | null;
  local_date: string; // "YYYY-MM-DD"
  city: string;
  weighted_avg: number | null;
  unit: "F" | "C";
  yes_price: number | null;
  winning_bracket: string | null;
  winning_bracket_low: number | null;
  winning_bracket_high: number | null;
}

export interface EnrichedTick extends Tick {
  /** ms since epoch, x-axis value for both charts */
  paced_at: number | null;
  /** bracket string this weighted_avg fell into at this moment, e.g. "92-93" */
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

function makeBracketLabeler(
  winningLow: number | null,
  winningHigh: number | null,
  unit: "F" | "C"
): (temp: number | null) => string | null {
  let width: number;
  let anchor: number;

  if (winningLow !== null && winningHigh !== null && Number.isFinite(winningLow) && Number.isFinite(winningHigh)) {
    width = Math.trunc(winningHigh - winningLow) + 1;
    anchor = Math.trunc(winningLow);
  } else {
    width = unit === "F" ? 2 : 1;
    anchor = 0;
  }

  return (temp) => {
    if (temp === null || Number.isNaN(temp)) return null;
    const low = anchor + width * Math.floor((temp - anchor) / width);
    return width > 1 ? `${low}-${low + width - 1}` : `${low}`;
  };
}

function modalUnit(ticks: Tick[]): "F" | "C" {
  const counts: Record<string, number> = {};
  for (const t of ticks) counts[t.unit] = (counts[t.unit] ?? 0) + 1;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as "F" | "C") ?? "F";
}

/**
 * Full pipeline equivalent to command_day() in analyze_weather.py, minus the
 * matplotlib rendering — returns enriched, sorted ticks ready for recharts.
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

  const labelBracket = makeBracketLabeler(winningLow, winningHigh, unit);

  const ticks: EnrichedTick[] = withPacedAt.map((t) => ({
    ...t,
    point_bracket: labelBracket(t.weighted_avg),
  }));

  return { ticks, winningLow, winningHigh, winningBracket, unit };
}
