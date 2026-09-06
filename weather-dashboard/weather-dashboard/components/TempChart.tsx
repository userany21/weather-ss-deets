"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import type { EnrichedTick } from "@/lib/weather-transform";

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

export default function TempChart({
  ticks,
  reciprocalTicks,
  unit,
  winningLow,
  winningHigh,
  winningBracket,
}: {
  ticks: EnrichedTick[];
  reciprocalTicks: EnrichedTick[];
  unit: "F" | "C";
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
}) {
  // Build linear data points keyed by paced_at
  const linearPoints = ticks
    .filter((t) => t.paced_at !== null && t.weighted_avg !== null)
    .map((t) => ({ paced_at: t.paced_at as number, linear: t.weighted_avg as number }));

  // Build a lookup for reciprocal values by paced_at so both lines share the same x-axis
  const reciprocalMap = new Map(
    reciprocalTicks
      .filter((t) => t.paced_at !== null && t.weighted_avg !== null)
      .map((t) => [t.paced_at as number, t.weighted_avg as number])
  );

  // Merge: every linear point gets its matching reciprocal value (null = gap)
  const data = linearPoints.map((d) => ({
    ...d,
    reciprocal: reciprocalMap.get(d.paced_at) ?? null,
  }));

  // If we have reciprocal-only points that don't appear in linear, append them
  const linearSet = new Set(linearPoints.map((d) => d.paced_at));
  for (const [paced_at, val] of reciprocalMap) {
    if (!linearSet.has(paced_at)) {
      data.push({ paced_at, linear: null as unknown as number, reciprocal: val });
    }
  }
  data.sort((a, b) => a.paced_at - b.paced_at);

  // Count bracket hits per dataset
  function countByBracket(ts: EnrichedTick[]) {
    const counts = new Map<string, number>();
    for (const t of ts) {
      if (!t.point_bracket) continue;
      counts.set(t.point_bracket, (counts.get(t.point_bracket) ?? 0) + 1);
    }
    return counts;
  }

  const linearCounts = countByBracket(ticks);
  const reciprocalCounts = countByBracket(reciprocalTicks);
  const allBrackets = [...new Set([...linearCounts.keys(), ...reciprocalCounts.keys()])]
    .sort((a, b) => parseInt(a) - parseInt(b));

  return (
    <div className="flex gap-4 w-full">
      <div className="h-[32rem] flex-1 min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#22262d" />
          <XAxis
            dataKey="paced_at"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatClock}
            stroke="#8b92a0"
            fontSize={12}
          />
          <YAxis
            stroke="#8b92a0"
            fontSize={12}
            domain={([dataMin, dataMax]: [number, number]) => [
              Math.floor(dataMin - 3),
              Math.ceil(dataMax + 3),
            ]}
            label={{ value: `Weighted avg temp (${unit})`, angle: -90, position: "insideLeft", fill: "#8b92a0" }}
          />
          <Tooltip
            labelFormatter={(v) => formatClock(v as number)}
            contentStyle={{ background: "#14171c", border: "1px solid #22262d" }}
          />
          {winningLow !== null && winningHigh !== null && (
            <ReferenceArea
              y1={winningLow}
              y2={winningHigh}
              fill="#5cb85c"
              fillOpacity={0.2}
              label={{ value: `Winning bracket: ${winningBracket}`, fill: "#5cb85c", fontSize: 11 }}
            />
          )}
          <Legend />
          <Line
            type="monotone"
            dataKey="linear"
            name="Linear (weighted avg)"
            stroke="#d9534f"
            dot={{ r: 2 }}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="reciprocal"
            name="Reciprocal (weighted avg)"
            stroke="#5bc0de"
            dot={{ r: 2 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
      </div>

      {/* Bracket hit tracker */}
      <div className="shrink-0 self-start pt-6">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="px-2 py-1 text-right text-[#8b92a0]">bracket</th>
              <th className="px-2 py-1 text-[#5bc0de]">rec</th>
              <th className="px-2 py-1 text-[#d9534f]">linear</th>
            </tr>
          </thead>
          <tbody>
            {allBrackets.map((b) => (
              <tr key={b} className="border-t border-[#22262d]">
                <td className="px-2 py-1 text-right text-[#8b92a0]">{b}</td>
                <td className="px-2 py-1 text-center text-[#5bc0de]">
                  {reciprocalCounts.get(b) ?? 0}
                </td>
                <td className="px-2 py-1 text-center text-[#d9534f]">
                  {linearCounts.get(b) ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
