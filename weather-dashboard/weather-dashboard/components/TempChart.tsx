"use client";

import { useState } from "react";
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

// ── Full-day schedules ──────────────────────────────────────────────────────
// All times are minutes since local midnight. paced_at stores the wall clock
// as if it were UTC, so (paced_at % DAY_MS) is already the local wall clock.
//
// A real tick "claims" a slot when it lands between
//   slot + winStart  and  slot + winEnd   (inclusive, in minutes).
// A claimed slot is drawn at the tick's real time. An unclaimed future slot is
// drawn at its nominal time as an empty x-axis point.

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;
const MAX_LABELS = 40; // above this, full-day mode shows every Nth label

interface Schedule {
  start: number; // first slot
  end: number; // last slot
  every: number; // minutes between slots
  winStart: number; // window opens this many minutes after the slot
  winEnd: number; // window closes this many minutes after the slot
}

const US: Schedule = { start: 8 * 60, end: 17 * 60 + 45, every: 15, winStart: 0, winEnd: 13 };
const ASIA_30: Schedule = { start: 8 * 60 + 30, end: 17 * 60 + 30, every: 30, winStart: 0, winEnd: 25 };
const EUROPE: Schedule = { start: 8 * 60 + 20, end: 17 * 60 + 50, every: 30, winStart: 0, winEnd: 25 };
const AMSTERDAM: Schedule = { start: 8 * 60 + 25, end: 17 * 60 + 55, every: 30, winStart: 0, winEnd: 25 };
const SHENZHEN: Schedule = { start: 9 * 60, end: 17 * 60, every: 60, winStart: 0, winEnd: 30 };
// Hong Kong data lands about 10 min after the slot, so the window is shifted.
const HONG_KONG: Schedule = { start: 8 * 60 + 10, end: 17 * 60 + 50, every: 10, winStart: 5, winEnd: 15 };

// Keys are lowercase. Both display labels and poller slugs are listed.
const CITY_SCHEDULE: Record<string, Schedule> = {
  "san francisco": US,
  sanfrancisco: US,
  seattle: US,
  "los angeles": US,
  losangeles: US,
  nyc: US,
  "new york": US,
  laguardia: US,
  atlanta: US,
  miami: US,

  beijing: ASIA_30,
  shanghai: ASIA_30,
  tokyo: ASIA_30,
  seoul: ASIA_30,
  singapore: ASIA_30,
  shenzhen: SHENZHEN,
  "hong kong": HONG_KONG,
  hongkong: HONG_KONG,
  hongkongobs: HONG_KONG,

  london: EUROPE,
  munich: EUROPE,
  milan: EUROPE,
  madrid: EUROPE,
  paris: EUROPE,
  parislb: EUROPE,
  amsterdam: AMSTERDAM,
};

function getSchedule(city: string | undefined, unit: "F" | "C"): Schedule | null {
  const key = (city ?? "").trim().toLowerCase();
  // Unknown Fahrenheit city: treat it as a US city. Unknown Celsius city: no toggle.
  return CITY_SCHEDULE[key] ?? (unit === "F" ? US : null);
}

/**
 * Returns the x-axis tick positions for the full-day view.
 *   - every real tick keeps its real time
 *   - every future slot with no tick yet is added at its slot time
 *   - a slot whose window already closed (missed tick) is NOT added back
 */
function buildFullDayTicks(realXs: number[], sched: Schedule): number[] {
  if (realXs.length === 0) return realXs;

  const dayBase = Math.floor(realXs[0] / DAY_MS) * DAY_MS;
  const slots: number[] = [];
  for (let m = sched.start; m <= sched.end; m += sched.every) {
    slots.push(dayBase + m * MIN_MS);
  }

  const lastReal = realXs[realXs.length - 1];

  // Each real tick (oldest first) claims the earliest free slot whose window holds it.
  const claimed = new Set<number>();
  for (const t of realXs) {
    const idx = slots.findIndex(
      (s, i) =>
        !claimed.has(i) &&
        t >= s + sched.winStart * MIN_MS &&
        t <= s + sched.winEnd * MIN_MS
    );
    if (idx !== -1) claimed.add(idx);
  }

  const out = new Set<number>(realXs);
  slots.forEach((s, i) => {
    if (claimed.has(i)) return;
    if (s + sched.winEnd * MIN_MS <= lastReal) return; // window closed, do not backfill
    out.add(Math.max(s, lastReal)); // never draw a placeholder left of the last real tick
  });

  return [...out].sort((a, b) => a - b);
}

export default function TempChart({
  ticks,
  reciprocalTicks,
  unit,
  winningLow,
  winningHigh,
  winningBracket,
  city,
}: {
  ticks: EnrichedTick[];
  reciprocalTicks: EnrichedTick[];
  unit: "F" | "C";
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
  /** City name from the route. Falls back to ticks[0].city when omitted. */
  city?: string;
}) {
  const [fullDay, setFullDay] = useState(false);

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
  const realXs = [...new Set(data.map((d) => d.paced_at))].sort((a, b) => a - b);

  // Full-day mode only changes the x-axis ticks and domain. `data` holds real
  // ticks only, so the lines, y-axis range and tooltip stay the same.
  const schedule = getSchedule(city ?? ticks[0]?.city, unit);
  const showFullDay = fullDay && schedule !== null;
  const xTicks = showFullDay && schedule ? buildFullDayTicks(realXs, schedule) : realXs;
  const labelStep = showFullDay ? Math.max(1, Math.ceil(xTicks.length / MAX_LABELS)) : 1;
  const xDomain: ["dataMin", "dataMax"] | [number, number] =
    showFullDay && xTicks.length > 0
      ? [xTicks[0], xTicks[xTicks.length - 1]]
      : ["dataMin", "dataMax"];

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
              domain={xDomain}
              ticks={xTicks}
              interval={0}
              tickFormatter={(v: number, i: number) => (i % labelStep === 0 ? formatClock(v) : "")}
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

      {/* Left-aligned legend under the chart, full-day toggle on the right */}
      <div className="mt-3 flex items-center gap-6 pl-2 pr-2 text-xs">
        <span className="flex items-center gap-2" style={{ color: C.red }}>
          <span className="h-2 w-2 rounded-full" style={{ background: C.red }} />
          Linear (weighted avg)
        </span>
        <span className="flex items-center gap-2" style={{ color: C.cyan }}>
          <span className="h-2 w-2 rounded-full" style={{ background: C.cyan }} />
          Reciprocal (weighted avg)
        </span>

        {schedule && (
          <button
            type="button"
            role="switch"
            aria-checked={fullDay}
            onClick={() => setFullDay((v) => !v)}
            title="Show the whole day on the x-axis. Empty slots mark ticks that have not come in yet."
            className="ml-auto flex cursor-pointer items-center gap-2 rounded-full border border-[#1f2838] px-3 py-1 text-[#c9d0dc] transition-colors hover:border-[#2c374b]"
          >
            <span
              className="relative h-3.5 w-6 rounded-full transition-colors"
              style={{ background: fullDay ? C.green : C.axis }}
            >
              <span
                className="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all"
                style={{ left: fullDay ? 12 : 2 }}
              />
            </span>
            Full day
          </button>
        )}
      </div>
    </div>
  );
}