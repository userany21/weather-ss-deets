"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { EnrichedTick } from "@/lib/weather-transform";
import { C } from "@/lib/theme";

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
  // Linear data points keyed by paced_at
  const linearPoints = ticks
    .filter((t) => t.paced_at !== null && t.weighted_avg !== null)
    .map((t) => ({ paced_at: t.paced_at as number, linear: t.weighted_avg as number }));

  // Reciprocal lookup so both lines share the same x-axis
  const reciprocalMap = new Map(
    reciprocalTicks
      .filter((t) => t.paced_at !== null && t.weighted_avg !== null)
      .map((t) => [t.paced_at as number, t.weighted_avg as number])
  );

  // Every linear point gets its matching reciprocal value (null = gap)
  const data = linearPoints.map((d) => ({
    ...d,
    reciprocal: reciprocalMap.get(d.paced_at) ?? null,
  }));

  // Reciprocal-only points that don't appear in linear
  const linearSet = new Set(linearPoints.map((d) => d.paced_at));
  for (const [paced_at, val] of reciprocalMap) {
    if (!linearSet.has(paced_at)) {
      data.push({ paced_at, linear: null as unknown as number, reciprocal: val });
    }
  }
  data.sort((a, b) => a.paced_at - b.paced_at);

  // One X-axis tick per distinct pacing time
  const xTicks = [...new Set(data.map((d) => d.paced_at))].sort((a, b) => a - b);

  const hasBand = winningLow !== null && winningHigh !== null;
  const bracketText = winningBracket
    ? /^\d+-\d+$/.test(winningBracket)
      ? `${winningBracket}°${unit}`
      : winningBracket
    : "";

  return (
    <div>
      <div className="h-[19rem] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
            <XAxis
              dataKey="paced_at"
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={xTicks}
              interval={0}
              tickFormatter={formatClock}
              stroke={C.sub}
              fontSize={10}
              tickLine={false}
              axisLine={{ stroke: C.axis }}
              angle={-40}
              textAnchor="end"
              height={55}
            />
            <YAxis
              stroke={C.sub}
              fontSize={11}
              width={32}
              tickLine={false}
              axisLine={{ stroke: C.axis }}
              domain={([dataMin, dataMax]: [number, number]) => [
                Math.floor(dataMin - 1),
                Math.ceil(dataMax + 1),
              ]}
            />
            <Tooltip
              labelFormatter={(v) => formatClock(v as number)}
              contentStyle={{
                background: C.panel,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
              }}
            />
            {hasBand && (
              <ReferenceArea
                y1={winningLow as number}
                y2={winningHigh as number}
                fill={C.green}
                fillOpacity={0.16}
                stroke="none"
                label={{
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content: (p: any) => (
                    <text
                      x={p.viewBox.x + p.viewBox.width * 0.32}
                      y={p.viewBox.y + 16}
                      fill={C.green}
                      fontSize={11}
                    >
                      Winning bucket {bracketText}
                    </text>
                  ),
                }}
              />
            )}
            {hasBand && (
              <ReferenceLine
                y={((winningLow as number) + (winningHigh as number)) / 2}
                stroke={C.green}
                strokeOpacity={0.6}
                strokeDasharray="4 4"
              />
            )}
            <Line
              type="monotone"
              dataKey="linear"
              name="Linear (weighted avg)"
              stroke={C.red}
              strokeWidth={1.5}
              dot={{ r: 2.5, fill: C.red, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="reciprocal"
              name="Reciprocal (weighted avg)"
              stroke={C.cyan}
              strokeWidth={1.5}
              dot={{ r: 2.5, fill: C.cyan, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Left-aligned legend under the chart */}
      <div className="mt-3 flex items-center gap-6 pl-2 text-xs">
        <span className="flex items-center gap-2" style={{ color: C.red }}>
          <span className="h-2 w-2 rounded-full" style={{ background: C.red }} />
          Linear (weighted avg)
        </span>
        <span className="flex items-center gap-2" style={{ color: C.cyan }}>
          <span className="h-2 w-2 rounded-full" style={{ background: C.cyan }} />
          Reciprocal (weighted avg)
        </span>
      </div>
    </div>
  );
}
