"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { EnrichedTick } from "@/lib/weather-transform";

// ---------------------------------------------------------------------------
// Types (mirrors BracketResult from the API route)
// ---------------------------------------------------------------------------

export interface BracketHistory {
  label: string;   // e.g. "68-69"
  low: number;
  color: string;
  history: { t: number; p: number }[]; // t = unix seconds, p = 0–1
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a millisecond timestamp as a clock string.
 * `tzOffsetMs` shifts real UTC → local time before formatting.
 *   e.g. PDT offset = -25200000 → "11:46 PM UTC" becomes "4:46 PM"
 * Defaults to 0 (UTC) for the fallback chart whose paced_at values already
 * store local time expressed as UTC.
 */
function formatClock(ms: number, tzOffsetMs = 0) {
  return new Date(ms + tzOffsetMs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

/**
 * Binary search over a time-ordered history array to find the entry whose
 * `t` (unix seconds) is closest to `targetMs` (milliseconds).
 *
 * O(log n) vs the previous O(n) linear scan. History is guaranteed sorted
 * ascending by t because the CLOB API always returns it that way.
 */
function findClosest(
  history: { t: number; p: number }[],
  targetMs: number
): { t: number; p: number } {
  let lo = 0;
  let hi = history.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1; // fast integer divide by 2
    if (history[mid].t * 1000 < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is the first entry >= targetMs; compare with lo-1 to find the true closest
  if (lo === 0) return history[0];
  const before = history[lo - 1];
  const after  = history[lo];
  return targetMs - before.t * 1000 <= after.t * 1000 - targetMs ? before : after;
}

/**
 * For each EnrichedTick with a paced_at + point_bracket, find the closest
 * timestamp in that bracket's price history and record it.
 *
 * `tzOffsetMs` is the UTC offset for the city's timezone on this date
 * (e.g. PDT = -25200000). It is used to convert `paced_at` (which stores
 * local time treated as UTC) into a real UTC millisecond timestamp before
 * comparing against Polymarket's price history (which uses real UTC).
 *
 *   paced_at stores "8:15 AM" as Date.UTC(date, 8, 15) — fake UTC
 *   real UTC for 8:15 AM PDT = paced_at - tzOffsetMs  (add 7h for PDT)
 *
 * Returns a Map keyed by  `"<bracketLabel>__<t_ms>"`  whose value is the
 * bracket label string (used by the custom dot renderer to decide whether
 * to show a labeled dot at that position).
 */
function buildSnapMap(
  ticks: EnrichedTick[],
  bracketHistories: BracketHistory[],
  tzOffsetMs: number
): Map<string, string> {
  const histMap = new Map<string, { t: number; p: number }[]>();
  for (const b of bracketHistories) histMap.set(b.label, b.history);

  const snapMap = new Map<string, string>();

  for (const tick of ticks) {
    if (tick.paced_at === null || !tick.point_bracket) continue;
    const history = histMap.get(tick.point_bracket);
    if (!history?.length) continue;

    // Convert fake-UTC paced_at → real UTC ms
    const realPacedAt = tick.paced_at - tzOffsetMs;

    // Binary search — O(log n) instead of the previous O(n) linear scan
    const best = findClosest(history, realPacedAt);

    // Only overwrite if this tick's bracket is the same (last tick wins for
    // duplicate snaps on the same timestamp — rare edge case).
    snapMap.set(`${tick.point_bracket}__${best.t * 1000}`, tick.point_bracket);
  }

  return snapMap;
}

// ---------------------------------------------------------------------------
// Custom dot — renders a visible dot + rotated label ONLY at snap points,
// invisible otherwise (r=0 circle so recharts still lays out correctly).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSnapDot(bracketLabel: string, color: string, snapMap: Map<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function SnapDot(props: any) {
    const { cx, cy, payload } = props;
    const key = `${bracketLabel}__${payload?.t_ms}`;
    if (!snapMap.has(key)) {
      // Invisible — still need a valid SVG element so recharts doesn't break
      return <circle r={0} cx={cx} cy={cy} key={key} />;
    }
    return (
      <g key={key}>
        <circle cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={1} />
        <text
          x={cx}
          y={cy - 12}
          textAnchor="middle"
          fontSize={9}
          fill={color}
          transform={`rotate(-90 ${cx} ${cy - 12})`}
        >
          {bracketLabel}
        </text>
      </g>
    );
  };
}

// ---------------------------------------------------------------------------
// Fallback chart (no price history yet — mirrors original behaviour)
// ---------------------------------------------------------------------------

function FallbackChart({ ticks }: { ticks: EnrichedTick[] }) {
  // Memoised so filter+map+loop don't re-run on every parent render when
  // `ticks` hasn't actually changed.
  const { data, switchTimes } = useMemo(() => {
    const data = ticks
      .filter((t) => t.paced_at !== null && t.yes_price !== null)
      .map((t) => ({
        t_ms: t.paced_at as number,
        price_cents: (t.yes_price as number) * 100,
        point_bracket: t.point_bracket,
      }));

    // Dashed vertical lines at bracket-switch moments
    const switchTimes: number[] = [];
    let prev: string | null = null;
    for (const d of data) {
      if (prev !== null && d.point_bracket !== prev) switchTimes.push(d.t_ms);
      prev = d.point_bracket ?? prev;
    }
    return { data, switchTimes };
  }, [ticks]);

  return (
    <div className="h-[32rem] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#22262d" />
          <XAxis
            dataKey="t_ms"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatClock}
            stroke="#8b92a0"
            fontSize={12}
          />
          <YAxis
            domain={[0, 100]}
            stroke="#8b92a0"
            fontSize={12}
            label={{ value: "Yes price (cents)", angle: -90, position: "insideLeft", fill: "#8b92a0" }}
          />
          <Tooltip
            labelFormatter={(v: number) => formatClock(v)}
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
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PriceChart({
  ticks,
  bracketHistories,
  tzOffsetMs = 0,
}: {
  ticks: EnrichedTick[];
  bracketHistories: BracketHistory[];
  /** UTC offset in ms for the city's timezone (e.g. PDT = -25200000). Used
   *  to align paced_at (local-time-as-UTC) with real-UTC price history. */
  tzOffsetMs?: number;
}) {
  // Show the simple fallback until price histories are available
  if (bracketHistories.length === 0) {
    return <FallbackChart ticks={ticks} />;
  }

  return <FullChart ticks={ticks} bracketHistories={bracketHistories} tzOffsetMs={tzOffsetMs} />;
}

// ---------------------------------------------------------------------------
// Full chart — all bracket lines + snapped annotation dots
// ---------------------------------------------------------------------------

function FullChart({
  ticks,
  bracketHistories,
  tzOffsetMs,
}: {
  ticks: EnrichedTick[];
  bracketHistories: BracketHistory[];
  tzOffsetMs: number;
}) {
  const snapMap = useMemo(
    () => buildSnapMap(ticks, bracketHistories, tzOffsetMs),
    [ticks, bracketHistories, tzOffsetMs]
  );

  // Local-time clock formatter — shifts real UTC timestamps by the city's
  // UTC offset so labels display in the city's local time (not UTC).
  const formatClockLocal = useMemo(
    () => (ms: number) => formatClock(ms, tzOffsetMs),
    [tzOffsetMs]
  );

  // Unified time axis: collect every unique t_ms across all bracket histories
  const allTms = useMemo(() => {
    const set = new Set<number>();
    for (const b of bracketHistories)
      for (const h of b.history) set.add(h.t * 1000);
    return [...set].sort((a, b) => a - b);
  }, [bracketHistories]);

  // Fast price lookup: bracketLabel -> Map<t_ms, price_cents>
  const priceLookup = useMemo(() => {
    const outer = new Map<string, Map<number, number>>();
    for (const b of bracketHistories) {
      const inner = new Map<number, number>();
      for (const h of b.history) inner.set(h.t * 1000, h.p * 100);
      outer.set(b.label, inner);
    }
    return outer;
  }, [bracketHistories]);

  // Unified data array — one row per timestamp, one column per bracket
  type Row = { t_ms: number } & Record<string, number | undefined>;
  const data: Row[] = useMemo(
    () =>
      allTms.map((t_ms: number) => {
        const row: Row = { t_ms };
        for (const b of bracketHistories) {
          const v = priceLookup.get(b.label)?.get(t_ms);
          if (v !== undefined) row[b.label] = v;
        }
        return row;
      }),
    [allTms, bracketHistories, priceLookup]
  );

  // Pre-build snap-dot renderers (stable references per bracket+snapMap combo)
  const snapDots = useMemo(
    () =>
      Object.fromEntries(
        bracketHistories.map((b) => [
          b.label,
          makeSnapDot(b.label, b.color, snapMap),
        ])
      ),
    [bracketHistories, snapMap]
  );

  // Last recorded price + timestamp per bracket
  const lastPrices = useMemo(
    () =>
      bracketHistories.map((b) => {
        const last = b.history[b.history.length - 1];
        return {
          label: b.label,
          color: b.color,
          price: last ? last.p * 100 : null,
          t_ms: last ? last.t * 1000 : null,
        };
      }),
    [bracketHistories]
  );

  return (
    <div className="flex gap-4 items-start w-full">
      <div className="h-[32rem] flex-1 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#22262d" />
            <XAxis
              dataKey="t_ms"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={formatClockLocal}
              stroke="#8b92a0"
              fontSize={12}
            />
            <YAxis
              domain={[0, 100]}
              stroke="#8b92a0"
              fontSize={12}
              label={{ value: "Yes price (cents)", angle: -90, position: "insideLeft", fill: "#8b92a0" }}
            />
            <Tooltip
              labelFormatter={(v: number) => formatClockLocal(v)}
              contentStyle={{ background: "#14171c", border: "1px solid #22262d" }}
              formatter={(v: number, name: string) => [`${v.toFixed(1)}¢`, name]}
            />
            <Legend
              wrapperStyle={{ fontSize: 10, color: "#8b92a0", paddingTop: 4 }}
            />
            {bracketHistories.map((b) => (
              <Line
                key={b.label}
                type="monotone"
                dataKey={b.label}
                stroke={b.color}
                strokeWidth={1.5}
                dot={snapDots[b.label]}
                activeDot={{ r: 10 }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Last-price summary table */}
      <div className="shrink-0 pt-8 text-lg text-gray-300">
        <table className="border-collapse">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="pr-6 pb-3">Bracket</th>
              <th className="pr-6 pb-3">Price</th>
              <th className="pb-3">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {lastPrices.map(({ label, color, price, t_ms }) => (
              <tr key={label} className="border-t border-gray-800">
                <td className="pr-6 py-1.5 font-medium" style={{ color }}>{label}</td>
                <td className="pr-6 py-1.5 font-mono">
                  {price !== null ? `${price.toFixed(1)}¢` : "—"}
                </td>
                <td className="py-1.5 text-gray-500 font-mono">
                  {t_ms !== null ? formatClockLocal(t_ms) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
