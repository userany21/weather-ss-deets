"use client";

import { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { EnrichedTick } from "@/lib/weather-transform";
import { ChevronIcon, ClipboardIcon } from "@/components/icons";
import { C } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Types (mirrors BracketResult from the API route)
// ---------------------------------------------------------------------------

export interface BracketHistory {
  label: string; // e.g. "68-69"
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
 * Binary search over a time-ordered history (t = unix seconds) to find the
 * entry closest to `targetMs`. History is sorted ascending by the CLOB API.
 */
function findClosest(
  history: { t: number; p: number }[],
  targetMs: number
): { t: number; p: number } {
  let lo = 0;
  let hi = history.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].t * 1000 < targetMs) lo = mid + 1;
    else hi = mid;
  }

  if (lo === 0) return history[0];
  const before = history[lo - 1];
  const after = history[lo];
  return targetMs - before.t * 1000 <= after.t * 1000 - targetMs ? before : after;
}

/**
 * For each tick with a paced_at + point_bracket, find the closest timestamp in
 * that bracket's price history. paced_at stores local time as fake UTC, so it
 * is shifted by `tzOffsetMs` to real UTC before comparing.
 * Returns a Map keyed by `"<bracketLabel>__<t_ms>"`.
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

    const realPacedAt = tick.paced_at - tzOffsetMs;
    const best = findClosest(history, realPacedAt);
    snapMap.set(`${tick.point_bracket}__${best.t * 1000}`, tick.point_bracket);
  }

  return snapMap;
}

// ---------------------------------------------------------------------------
// Custom tooltip — top 4 brackets by price at hover time
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Top4Tooltip({ active, payload, label, tzOffsetMs }: any) {
  if (!active || !payload?.length) return null;

  const top4 = [...payload]
    .filter((p) => p.value != null)
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);

  if (top4.length === 0) return null;

  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 13,
        minWidth: 140,
      }}
    >
      <div style={{ color: C.sub, marginBottom: 6, fontSize: 12 }}>
        {formatClock(label, tzOffsetMs)}
      </div>
      {top4.map((p) => (
        <div
          key={p.dataKey}
          style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}
        >
          <span style={{ color: p.color, fontWeight: 600 }}>{p.dataKey}</span>
          <span style={{ color: C.text, fontFamily: "monospace" }}>
            {(p.value as number).toFixed(1)}¢
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom dot — visible dot + rotated label ONLY at snap points
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSnapDot(bracketLabel: string, color: string, snapMap: Map<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function SnapDot(props: any) {
    const { cx, cy, payload } = props;
    const key = `${bracketLabel}__${payload?.t_ms}`;
    if (!snapMap.has(key)) {
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

// Shared axis styling
const axisProps = {
  stroke: C.sub,
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: C.axis },
} as const;

// ---------------------------------------------------------------------------
// Fallback chart (no price history yet) — linear and reciprocal lines
// ---------------------------------------------------------------------------

// Stable empty array. This keeps the useMemo dependencies the same between renders.
const EMPTY_TICKS: EnrichedTick[] = [];

interface YesPoint {
  t_ms: number;
  cents: number;
  bracket: string | null;
}

interface YesRow {
  t_ms: number;
  linear?: number;
  reciprocal?: number;
  linearBracket?: string | null;
  reciprocalBracket?: string | null;
}

/** Keep ticks that have paced_at and yes_price. Convert yes_price (0–1) to cents. */
function toYesPoints(ticks: EnrichedTick[]): YesPoint[] {
  return ticks
    .filter((t) => t.paced_at != null && t.yes_price != null)
    .map((t) => ({
      t_ms: t.paced_at as number,
      cents: (t.yes_price as number) * 100,
      bracket: t.point_bracket ?? null,
    }))
    .sort((a, b) => a.t_ms - b.t_ms);
}

/** Times at which point_bracket changes inside one series. */
function toSwitchTimes(points: YesPoint[]): number[] {
  const out: number[] = [];
  let prev: string | null = null;
  for (const p of points) {
    if (p.bracket === null) continue;
    if (prev !== null && p.bracket !== prev) out.push(p.t_ms);
    prev = p.bracket;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function YesTooltip({ active, payload, showReciprocal }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as YesRow;

  const lines = [
    { name: "Linear", color: C.red, value: row.linear, bracket: row.linearBracket },
    ...(showReciprocal
      ? [{ name: "Reciprocal", color: C.cyan, value: row.reciprocal, bracket: row.reciprocalBracket }]
      : []),
  ];

  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 13,
        minWidth: 170,
      }}
    >
      <div style={{ color: C.sub, marginBottom: 6, fontSize: 12 }}>{formatClock(row.t_ms)}</div>
      {lines.map((l) => (
        <div
          key={l.name}
          style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}
        >
          <span style={{ color: l.color, fontWeight: 600 }}>{l.name}</span>
          <span style={{ color: C.text, fontFamily: "monospace" }}>
            {l.value !== undefined ? `${l.value.toFixed(1)}¢` : "—"}
            {l.value !== undefined && l.bracket ? ` · ${l.bracket}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export function YesPriceChart({
  ticks,
  reciprocalTicks = EMPTY_TICKS,
}: {
  ticks: EnrichedTick[];
  reciprocalTicks?: EnrichedTick[];
}) {
  const { data, linearSwitches, reciprocalSwitches, hasReciprocal } = useMemo(() => {
    const lin = toYesPoints(ticks);
    const rec = toYesPoints(reciprocalTicks);

    // Join both series on paced_at. A side with no tick at that time stays undefined.
    const rows = new Map<number, YesRow>();
    for (const p of lin) {
      const row = rows.get(p.t_ms) ?? { t_ms: p.t_ms };
      row.linear = p.cents;
      row.linearBracket = p.bracket;
      rows.set(p.t_ms, row);
    }
    for (const p of rec) {
      const row = rows.get(p.t_ms) ?? { t_ms: p.t_ms };
      row.reciprocal = p.cents;
      row.reciprocalBracket = p.bracket;
      rows.set(p.t_ms, row);
    }

    return {
      data: [...rows.values()].sort((a, b) => a.t_ms - b.t_ms),
      linearSwitches: toSwitchTimes(lin),
      reciprocalSwitches: toSwitchTimes(rec),
      hasReciprocal: rec.length > 0,
    };
  }, [ticks, reciprocalTicks]);

  return (
    <div className="h-[13rem] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="t_ms"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => formatClock(v)}
            {...axisProps}
          />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} width={32} {...axisProps} />
          <Legend verticalAlign="top" height={20} iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
          <Tooltip content={(props) => <YesTooltip {...props} showReciprocal={hasReciprocal} />} />
          {linearSwitches.map((t) => (
            <ReferenceLine
              key={`l-${t}`}
              x={t}
              stroke={C.red}
              strokeDasharray="4 4"
              strokeOpacity={0.35}
            />
          ))}
          {reciprocalSwitches.map((t) => (
            <ReferenceLine
              key={`r-${t}`}
              x={t}
              stroke={C.cyan}
              strokeDasharray="4 4"
              strokeOpacity={0.35}
            />
          ))}
          <Line
            type="monotone"
            dataKey="linear"
            name="Linear"
            stroke={C.red}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
            connectNulls
          />
          {hasReciprocal && (
            <Line
              type="monotone"
              dataKey="reciprocal"
              name="Reciprocal"
              stroke={C.cyan}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls
            />
          )}
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
  reciprocalTicks = EMPTY_TICKS,
  bracketHistories,
  tzOffsetMs = 0,
}: {
  ticks: EnrichedTick[];
  /** Used only by the Yes-price fallback chart. Optional. */
  reciprocalTicks?: EnrichedTick[];
  bracketHistories: BracketHistory[];
  /** UTC offset in ms for the city's timezone (e.g. PDT = -25200000). Used
   *  to align paced_at (local-time-as-UTC) with real-UTC price history. */
  tzOffsetMs?: number;
}) {
  if (bracketHistories.length === 0) {
    return <YesPriceChart ticks={ticks} reciprocalTicks={reciprocalTicks} />;
  }
  return <FullChart ticks={ticks} bracketHistories={bracketHistories} tzOffsetMs={tzOffsetMs} />;
}

// ---------------------------------------------------------------------------
// Full chart — one gradient area per bracket + snapped annotation dots
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

  const formatClockLocal = useMemo(
    () => (ms: number) => formatClock(ms, tzOffsetMs),
    [tzOffsetMs]
  );

  // Unified time axis: every unique t_ms across all bracket histories
  const allTms = useMemo(() => {
    const set = new Set<number>();
    for (const b of bracketHistories) for (const h of b.history) set.add(h.t * 1000);
    return [...set].sort((a, b) => a - b);
  }, [bracketHistories]);

  // bracketLabel -> Map<t_ms, price_cents>
  const priceLookup = useMemo(() => {
    const outer = new Map<string, Map<number, number>>();
    for (const b of bracketHistories) {
      const inner = new Map<number, number>();
      for (const h of b.history) inner.set(h.t * 1000, h.p * 100);
      outer.set(b.label, inner);
    }
    return outer;
  }, [bracketHistories]);

  // One row per timestamp, one column per bracket
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

  const snapDots = useMemo(
    () =>
      Object.fromEntries(
        bracketHistories.map((b) => [b.label, makeSnapDot(b.label, b.color, snapMap)])
      ),
    [bracketHistories, snapMap]
  );

  return (
    <div className="h-[13rem] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 0 }}>
          <defs>
            {bracketHistories.map((b, i) => (
              <linearGradient key={b.label} id={`pg-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={b.color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={b.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="t_ms"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatClockLocal}
            {...axisProps}
          />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} width={32} {...axisProps} />
          <Tooltip content={(props) => <Top4Tooltip {...props} tzOffsetMs={tzOffsetMs} />} />
          {bracketHistories.map((b, i) => (
            <Area
              key={b.label}
              type="monotone"
              dataKey={b.label}
              stroke={b.color}
              strokeWidth={1.5}
              fill={`url(#pg-${i})`}
              dot={snapDots[b.label]}
              activeDot={{ r: 10 }}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Latest updates" card content — last price + time per bracket
// ---------------------------------------------------------------------------

export function LatestUpdates({
  bracketHistories,
  tzOffsetMs = 0,
}: {
  bracketHistories: BracketHistory[];
  tzOffsetMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(
    () =>
      bracketHistories.map((b) => {
        const last = b.history[b.history.length - 1];
        return {
          label: b.label,
          color: b.color,
          price: last ? last.p : null, // 0–1
          t_ms: last ? last.t * 1000 : null,
        };
      }),
    [bracketHistories]
  );

  const shown = expanded ? rows : rows.slice(0, 3);
  const canToggle = rows.length > 3;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ClipboardIcon width={22} height={22} className="text-[#8b92a0]" />
          <h2 className="text-base font-semibold text-white">Latest updates</h2>
        </div>
        {canToggle && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Show fewer brackets" : "Show all brackets"}
            className="text-[#8b92a0] transition-colors hover:text-white"
          >
            <ChevronIcon dir={expanded ? "down" : "right"} width={18} height={18} />
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-[1.4fr_1fr_1fr] px-1 pb-3 text-xs text-[#8b92a0]">
        <span>Bracket</span>
        <span>Price</span>
        <span className="text-right">Last updated</span>
      </div>

      {shown.map(({ label, color, price, t_ms }) => (
        <div
          key={label}
          className="grid grid-cols-[1.4fr_1fr_1fr] items-center border-t border-[#151c2b] px-1 py-3.5 text-sm"
        >
          <span className="font-medium" style={{ color }}>
            {label}
          </span>
          <span className="font-mono text-white">
            {price !== null ? price.toFixed(2) : "—"}
          </span>
          <span className="text-right font-mono text-xs text-[#8b92a0]">
            {t_ms !== null ? formatClock(t_ms, tzOffsetMs) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}
