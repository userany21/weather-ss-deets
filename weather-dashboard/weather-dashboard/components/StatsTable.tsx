"use client";

import { Fragment } from "react";
import { fallbackBracketLabel, type EnrichedTick } from "@/lib/weather-transform";
import type { CompareDay } from "@/components/TempChart";
import { C } from "@/lib/theme";

export interface WindowStat {
  label: string;
  linearAvg: number | null;
  linearBracket: string | null;
  lastYesPriceLinear: number | null;
  reciprocalAvg: number | null;
  recBracket: string | null;
  lastYesPriceRec: number | null;
  tickCount: number;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const COLS = 9;

const WINDOWS = [
  { label: "1h", ms: HOUR_MS },
  { label: "2h", ms: 2 * HOUR_MS },
  { label: "4h", ms: 4 * HOUR_MS },
];

function avg(nums: (number | null)[]) {
  const vals = nums.filter((n): n is number => n != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/**
 * Window stats for one day. Mirrors the `windowStats` memo in the day page.
 * `anchor` (ms) is the end of every window.
 */
function computeWindowStats(
  linearTicks: EnrichedTick[],
  recTicks: EnrichedTick[],
  unit: "F" | "C",
  anchor: number
): WindowStat[] {
  return WINDOWS.map(({ label, ms }) => {
    const cutoff = anchor - ms;
    const linear = linearTicks.filter((t) => (t.paced_at ?? 0) >= cutoff);
    const reciprocal = recTicks.filter((t) => (t.paced_at ?? 0) >= cutoff);

    const linearAvg = avg(linear.map((t) => t.weighted_avg));
    const reciprocalAvg = avg(reciprocal.map((t) => t.weighted_avg));

    const linearBracket = linearAvg != null ? fallbackBracketLabel(linearAvg, unit) : null;
    const recBracket = reciprocalAvg != null ? fallbackBracketLabel(reciprocalAvg, unit) : null;

    const matchingLinearTick = [...linear].reverse().find((t) => t.point_bracket === linearBracket);
    const lastYesPriceLinear = matchingLinearTick?.yes_price ?? linear.at(-1)?.yes_price ?? null;

    const matchingRecTick = [...reciprocal].reverse().find((t) => t.point_bracket === recBracket);
    const lastYesPriceRec = matchingRecTick?.yes_price ?? reciprocal.at(-1)?.yes_price ?? null;

    return {
      label,
      linearAvg,
      linearBracket,
      lastYesPriceLinear,
      reciprocalAvg,
      recBracket,
      lastYesPriceRec,
      tickCount: linear.length,
    };
  });
}

function countByBracket(ts: EnrichedTick[]) {
  const counts = new Map<string, number>();
  for (const t of ts) {
    if (!t.point_bracket) continue;
    counts.set(t.point_bracket, (counts.get(t.point_bracket) ?? 0) + 1);
  }
  return counts;
}

// "78-79" -> "78-79°F"; open-ended labels ("71 or below") are left alone.
function fmtBracket(b: string, unit: "F" | "C") {
  return /^\d+-\d+$/.test(b) ? `${b}°${unit}` : b;
}

function fmtClock(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

/** "2026-10-06" -> "10/06" */
const shortDate = (date: string) => date.slice(5).replace("-", "/");

const num = (v: number | null) => (v != null ? v.toFixed(3) : "—");

// Bracket hits (left) and window stats (right) share rows, like the mock.
interface DayRows {
  linearCounts: Map<string, number>;
  reciprocalCounts: Map<string, number>;
  brackets: string[];
  windowStats: WindowStat[] | undefined;
  rowCount: number;
}

function buildDayRows(
  linearTicks: EnrichedTick[],
  recTicks: EnrichedTick[],
  windowStats?: WindowStat[]
): DayRows {
  const linearCounts = countByBracket(linearTicks);
  const reciprocalCounts = countByBracket(recTicks);
  const brackets = [...new Set([...linearCounts.keys(), ...reciprocalCounts.keys()])].sort(
    (a, b) => parseInt(a) - parseInt(b)
  );
  const rowCount = Math.max(brackets.length, windowStats?.length ?? 0);
  return { linearCounts, reciprocalCounts, brackets, windowStats, rowCount };
}

export default function StatsTable({
  ticks,
  reciprocalTicks,
  unit,
  windowStats,
  compareDays = [],
}: {
  ticks: EnrichedTick[];
  reciprocalTicks: EnrichedTick[];
  unit: "F" | "C";
  windowStats?: WindowStat[];
  /** Past days to show below the main rows. */
  compareDays?: CompareDay[];
}) {
  const main = buildDayRows(ticks, reciprocalTicks, windowStats);
  if (main.rowCount === 0) return null;

  // Cutoff: the time of day of the latest tick of the main day.
  const mainAnchor = Math.max(
    0,
    ...ticks.map((t) => t.paced_at ?? 0),
    ...reciprocalTicks.map((t) => t.paced_at ?? 0)
  );
  const clock = mainAnchor - Math.floor(mainAnchor / DAY_MS) * DAY_MS;

  // Each compared day keeps only the ticks up to the same time of day.
  const sections = compareDays.map((cd) => {
    const anchor = Date.parse(`${cd.date}T00:00:00Z`) + clock;
    const lin = cd.ticks.filter((t) => t.paced_at !== null && t.paced_at <= anchor);
    const rec = cd.reciprocalTicks.filter((t) => t.paced_at !== null && t.paced_at <= anchor);
    return {
      cd,
      anchor,
      rows: buildDayRows(lin, rec, computeWindowStats(lin, rec, unit, anchor)),
    };
  });

  const th = "px-2 pb-3 align-bottom font-normal leading-tight";

  const renderRows = (prefix: string, d: DayRows, accent?: string) =>
    Array.from({ length: d.rowCount }, (_, i) => {
      const b = d.brackets[i];
      const w = d.windowStats?.[i];
      return (
        <tr key={`${prefix}-${i}`} className="border-t border-[#151c2b]">
          <td
            className="px-2 py-3.5 text-[#c9d0dc]"
            style={accent ? { boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
          >
            {b ? fmtBracket(b, unit) : ""}
          </td>
          <td className="px-2 py-3.5 text-center" style={{ color: C.cyan }}>
            {b ? d.reciprocalCounts.get(b) ?? 0 : ""}
          </td>
          <td className="px-2 py-3.5 text-center" style={{ color: C.red }}>
            {b ? d.linearCounts.get(b) ?? 0 : ""}
          </td>
          {w ? (
            <>
              <td className="px-2 py-3.5 text-[#8b92a0]">{w.label}</td>
              <td className="px-2 py-3.5 text-right" style={{ color: C.red }}>
                {num(w.linearAvg)}
              </td>
              <td
                className="px-2 py-3.5 text-right"
                style={{ color: C.red }}
                title={w.linearBracket ?? undefined}
              >
                {num(w.lastYesPriceLinear)}
              </td>
              <td className="px-2 py-3.5 text-right" style={{ color: C.cyan }}>
                {num(w.reciprocalAvg)}
              </td>
              <td
                className="px-2 py-3.5 text-right"
                style={{ color: C.cyan }}
                title={w.recBracket ?? undefined}
              >
                {num(w.lastYesPriceRec)}
              </td>
              <td className="px-2 py-3.5 text-right text-white">{w.tickCount}</td>
            </>
          ) : (
            <td colSpan={6} />
          )}
        </tr>
      );
    });

  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-[#8b92a0]">
          <th className={`${th} text-left`}>bracket</th>
          <th className={`${th} text-center`}>rec</th>
          <th className={`${th} text-center`}>linear</th>
          <th className={`${th} text-left`}>window</th>
          <th className={`${th} text-right`}>linear avg</th>
          <th className={`${th} text-right`}>bracket price L</th>
          <th className={`${th} text-right`}>rec avg</th>
          <th className={`${th} text-right`}>bracket price R</th>
          <th className={`${th} text-right`}>ticks</th>
        </tr>
      </thead>
      <tbody>
        {renderRows("main", main)}

        {sections.map(({ cd, anchor, rows }) => (
          <Fragment key={cd.date}>
            <tr className="border-t border-[#151c2b]">
              <td colSpan={COLS} className="px-2 pb-1 pt-4">
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full"
                  style={{ background: cd.color }}
                />
                <span style={{ color: cd.color }}>{shortDate(cd.date)}</span>
                {cd.winningBracket && (
                  <span className="ml-3 text-[#8b92a0]">
                    winning {fmtBracket(cd.winningBracket, unit)}
                  </span>
                )}
                <span className="ml-3 text-[#8b92a0]">through {fmtClock(anchor)}</span>
              </td>
            </tr>
            {rows.rowCount === 0 ? (
              <tr>
                <td colSpan={COLS} className="px-2 pb-3 text-[#8b92a0]">
                  No ticks by this time of day
                </td>
              </tr>
            ) : (
              renderRows(cd.date, rows, cd.color)
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
