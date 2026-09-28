"use client";

import type { EnrichedTick } from "@/lib/weather-transform";
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

const num = (v: number | null) => (v != null ? v.toFixed(3) : "—");

export default function StatsTable({
  ticks,
  reciprocalTicks,
  unit,
  windowStats,
}: {
  ticks: EnrichedTick[];
  reciprocalTicks: EnrichedTick[];
  unit: "F" | "C";
  windowStats?: WindowStat[];
}) {
  const linearCounts = countByBracket(ticks);
  const reciprocalCounts = countByBracket(reciprocalTicks);
  const brackets = [...new Set([...linearCounts.keys(), ...reciprocalCounts.keys()])].sort(
    (a, b) => parseInt(a) - parseInt(b)
  );

  // Bracket hits (left) and window stats (right) share rows, like the mock.
  const rowCount = Math.max(brackets.length, windowStats?.length ?? 0);
  if (rowCount === 0) return null;

  const th = "px-2 pb-3 align-bottom font-normal leading-tight";

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
        {Array.from({ length: rowCount }, (_, i) => {
          const b = brackets[i];
          const w = windowStats?.[i];
          return (
            <tr key={i} className="border-t border-[#151c2b]">
              <td className="px-2 py-3.5 text-[#c9d0dc]">{b ? fmtBracket(b, unit) : ""}</td>
              <td className="px-2 py-3.5 text-center" style={{ color: C.cyan }}>
                {b ? reciprocalCounts.get(b) ?? 0 : ""}
              </td>
              <td className="px-2 py-3.5 text-center" style={{ color: C.red }}>
                {b ? linearCounts.get(b) ?? 0 : ""}
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
        })}
      </tbody>
    </table>
  );
}
