"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import type { EnrichedTick } from "@/lib/weather-transform";

function formatClock(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function BracketLabel(props: any) {
  const { x, y, value } = props;
  if (!value) return null;
  return (
    <text
      x={x}
      y={y - 8}
      textAnchor="middle"
      fontSize={9}
      fill="#8b92a0"
      transform={`rotate(-90 ${x} ${y - 8})`}
    >
      {value}
    </text>
  );
}

export default function PriceChart({ ticks }: { ticks: EnrichedTick[] }) {
  const data = ticks
    .filter((t) => t.paced_at !== null && t.yes_price !== null)
    .map((t) => ({
      paced_at: t.paced_at as number,
      price_cents: (t.yes_price as number) * 100,
      point_bracket: t.point_bracket,
    }));

  // Vertical dashed lines wherever the labeled bracket switches from the previous tick.
  const switchTimes: number[] = [];
  let prevBracket: string | null = null;
  for (const d of data) {
    if (prevBracket !== null && d.point_bracket !== prevBracket) {
      switchTimes.push(d.paced_at);
    }
    prevBracket = d.point_bracket ?? prevBracket;
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#22262d" />
          <XAxis
            dataKey="paced_at"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatClock}
            stroke="#8b92a0"
            fontSize={12}
          />
          <YAxis domain={[0, 100]} stroke="#8b92a0" fontSize={12} label={{ value: "Yes price (cents)", angle: -90, position: "insideLeft", fill: "#8b92a0" }} />
          <Tooltip
            labelFormatter={(v) => formatClock(v as number)}
            contentStyle={{ background: "#14171c", border: "1px solid #22262d" }}
          />
          {switchTimes.map((t) => (
            <ReferenceLine key={t} x={t} stroke="#666" strokeDasharray="4 4" strokeOpacity={0.5} />
          ))}
          <Line
            type="monotone"
            dataKey="price_cents"
            name="Yes price"
            stroke="#4a90d9"
            dot={{ r: 2 }}
            isAnimationActive={false}
          >
            <LabelList dataKey="point_bracket" content={BracketLabel} />
          </Line>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
