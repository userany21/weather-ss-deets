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
  });
}

export default function TempChart({
  ticks,
  unit,
  winningLow,
  winningHigh,
  winningBracket,
}: {
  ticks: EnrichedTick[];
  unit: "F" | "C";
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
}) {
  const data = ticks
    .filter((t) => t.paced_at !== null && t.weighted_avg !== null)
    .map((t) => ({ paced_at: t.paced_at as number, weighted_avg: t.weighted_avg as number }));

  return (
    <div className="h-72 w-full">
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
            dataKey="weighted_avg"
            name="Weighted avg temp"
            stroke="#d9534f"
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
