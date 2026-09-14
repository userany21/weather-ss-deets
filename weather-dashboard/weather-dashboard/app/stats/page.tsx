"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from "recharts";
import { CITIES } from "@/lib/cities-config";

// ---------------------------------------------------------------------------
// API response types (mirrors what /api/stats returns)
// ---------------------------------------------------------------------------

interface DimConfigSchema {
  key: string;
  type: "number" | "select";
  options?: number[];
  default: number;
}
interface DimMeta {
  id: string;
  label: string;
  configSchema: DimConfigSchema | null;
}
interface Bucket {
  key: string;
  label: string;
  count: number;
  resolved: number;
  win_rate: number | null;
  avg_edge_cents: number | null;
}
interface StatsResponse {
  dimensions: string[];
  filters: Record<string, unknown>;
  buckets: Bucket[];
  total_rows: number;
  dimension_registry: DimMeta[];
  computed_at: string | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Local state types
// ---------------------------------------------------------------------------

interface ActiveDim {
  id: string;
  config: Record<string, number>;
}

type Metric = "edge" | "winrate";
type SortCol = "avg_edge_cents" | "win_rate" | "count" | "resolved";
type SortDir = "desc" | "asc";

// ---------------------------------------------------------------------------
// Constants / statics
// ---------------------------------------------------------------------------

const ALL_CITIES = CITIES.map((c) => c.city);
const ALL_REGIONS = ["america", "asia", "europe"] as const;

// Colors from the app's existing Tailwind theme tokens
const COLOR_EDGE = "#5cb85c";    // good
const COLOR_WINRATE = "#4a90d9"; // price

// Max buckets shown in chart (label overlap gets bad beyond this)
const MAX_CHART_BUCKETS = 30;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function buildApiUrl(
  dims: ActiveDim[],
  cities: string[],
  dateFrom: string,
  dateTo: string,
  method: string,
  minCount: number,
  resolvedOnly: boolean
): string {
  const params = new URLSearchParams();

  if (dims.length > 0) {
    params.set(
      "by",
      dims
        .map((d) => {
          const entries = Object.entries(d.config);
          return entries.length ? `${d.id}:${entries[0][1]}` : d.id;
        })
        .join(",")
    );
  }

  if (cities.length > 0) params.set("city", cities.join(","));
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (method && method !== "all") params.set("method", method);
  if (minCount > 0) params.set("minCount", String(minCount));
  if (resolvedOnly) params.set("resolvedOnly", "1");

  return `/api/stats?${params.toString()}`;
}

function fmtEdge(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}¢`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function sortBuckets(buckets: Bucket[], col: SortCol, dir: SortDir): Bucket[] {
  return [...buckets].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    // Nulls always last regardless of sort direction
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "desc"
      ? (bv as number) - (av as number)
      : (av as number) - (bv as number);
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Custom Recharts tooltip styled to match the app's dark theme. */
function ChartTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: string;
  metric: Metric;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-panel border border-border rounded px-3 py-2 text-sm shadow-lg">
      <div className="text-subtext text-xs mb-1 max-w-48 truncate">{label}</div>
      {payload.map(
        (p: { name: string; value: number; fill: string }, i: number) => (
          <div key={i} style={{ color: p.fill }} className="font-mono">
            {p.name}:{" "}
            {metric === "edge" ? fmtEdge(p.value) : fmtPct(p.value)}
          </div>
        )
      )}
    </div>
  );
}

/** Sort indicator arrow shown in table headers. */
function SortArrow({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol; sortDir: SortDir }) {
  if (col !== sortCol) return <span className="text-subtext ml-0.5 text-xs">⇅</span>;
  return <span className="ml-0.5 text-xs">{sortDir === "desc" ? "↓" : "↑"}</span>;
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function StatsExplorerPage() {
  // ---- Dimension state ----
  const [activeDims, setActiveDims] = useState<ActiveDim[]>([]);

  // ---- Filter state ----
  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [method, setMethod] = useState("combined");
  const [minCount, setMinCount] = useState(10);
  const [resolvedOnly, setResolvedOnly] = useState(true);

  // ---- Display state — default to avg_edge per user requirement ----
  const [metric, setMetric] = useState<Metric>("edge");
  const [sortCol, setSortCol] = useState<SortCol>("avg_edge_cents");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ---- SWR data fetch ----
  const apiUrl = useMemo(
    () =>
      buildApiUrl(
        activeDims,
        selectedCities,
        dateFrom,
        dateTo,
        method,
        minCount,
        resolvedOnly
      ),
    [activeDims, selectedCities, dateFrom, dateTo, method, minCount, resolvedOnly]
  );

  const { data, isLoading } = useSWR<StatsResponse>(apiUrl, fetcher, {
    revalidateOnFocus: false,
  });

  const registry: DimMeta[] = data?.dimension_registry ?? [];
  const activeDimIds = useMemo(() => new Set(activeDims.map((d) => d.id)), [activeDims]);

  // ---- Dimension picker handlers ----
  const addDim = useCallback(
    (id: string) => {
      const meta = registry.find((d) => d.id === id);
      if (!meta || activeDimIds.has(id)) return;
      const config: Record<string, number> = {};
      if (meta.configSchema) config[meta.configSchema.key] = meta.configSchema.default;
      setActiveDims((prev) => [...prev, { id, config }]);
    },
    [registry, activeDimIds]
  );

  const removeDim = useCallback((idx: number) => {
    setActiveDims((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateDimConfig = useCallback((idx: number, key: string, val: number) => {
    setActiveDims((prev) =>
      prev.map((d, i) =>
        i === idx ? { ...d, config: { ...d.config, [key]: val } } : d
      )
    );
  }, []);

  // ---- City multi-select ----
  const toggleCity = useCallback((city: string) => {
    setSelectedCities((prev) =>
      prev.includes(city) ? prev.filter((c) => c !== city) : [...prev, city]
    );
  }, []);

  // ---- Table sort ----
  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  // ---- Derived display data ----
  const sortedBuckets = useMemo(
    () => sortBuckets(data?.buckets ?? [], sortCol, sortDir),
    [data?.buckets, sortCol, sortDir]
  );

  // Chart always uses the API's default sort (avg_edge desc); cap at MAX_CHART_BUCKETS
  const chartBuckets = (data?.buckets ?? []).slice(0, MAX_CHART_BUCKETS);

  // Y-axis formatter depends on active metric
  const yFmt = (v: number) =>
    metric === "edge" ? `${v.toFixed(0)}¢` : `${(v * 100).toFixed(0)}%`;

  const bucketCount = data?.buckets.length ?? 0;
  const hasBuckets = bucketCount > 0;
  const noDimsSelected = activeDims.length === 0;
  const noData = !isLoading && !noDimsSelected && !hasBuckets;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-[1400px]">
      {/* Breadcrumb */}
      <div className="text-subtext text-sm mb-2">
        <Link href="/">Regions</Link> / Stats Explorer
      </div>
      <h1 className="text-xl font-semibold mb-6">Stats Explorer</h1>

      {/* ================================================================
          Controls row
      ================================================================ */}
      <div className="flex flex-wrap gap-4 mb-6">

        {/* ---- Dimension picker ---- */}
        <div className="card flex-1 min-w-72">
          <div className="text-subtext text-xs uppercase tracking-wide mb-2">
            Dimensions
          </div>

          {/* Active dimensions */}
          {activeDims.length === 0 ? (
            <div className="text-subtext text-sm mb-3">
              No dimensions selected — add one below to start slicing.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2 mb-3">
              {activeDims.map((d, i) => {
                const meta = registry.find((r) => r.id === d.id);
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 border border-price/40 bg-price/10 rounded px-2 py-1 text-sm"
                  >
                    <span className="text-text">{meta?.label ?? d.id}</span>

                    {/* Per-dimension config control */}
                    {meta?.configSchema &&
                      (meta.configSchema.type === "select" ? (
                        <select
                          value={d.config[meta.configSchema.key] ?? meta.configSchema.default}
                          onChange={(e) =>
                            updateDimConfig(i, meta.configSchema!.key, Number(e.target.value))
                          }
                          className="bg-panel border border-border rounded px-1 py-0 text-xs text-text"
                        >
                          {meta.configSchema.options?.map((o) => (
                            <option key={o} value={o}>
                              {meta.configSchema!.key === "n"
                                ? ["8AM","9AM","10AM","11AM","12PM","1PM","2PM","3PM","4PM","5PM"][o] ?? `H${o}`
                                : `${o}¢`}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="number"
                          value={d.config[meta.configSchema.key] ?? meta.configSchema.default}
                          onChange={(e) =>
                            updateDimConfig(i, meta.configSchema!.key, Number(e.target.value))
                          }
                          className="bg-panel border border-border rounded px-1 w-14 text-xs text-text"
                        />
                      ))}

                    <button
                      onClick={() => removeDim(i)}
                      className="text-subtext hover:text-text transition-colors leading-none"
                      aria-label={`Remove ${meta?.label ?? d.id}`}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Available dimensions to add */}
          <div className="text-subtext text-xs mb-1.5">Add dimension:</div>
          <div className="flex flex-wrap gap-1.5">
            {registry.length === 0 ? (
              <span className="text-subtext text-xs">Loading…</span>
            ) : (
              registry.map((dim) => (
                <button
                  key={dim.id}
                  onClick={() => addDim(dim.id)}
                  disabled={activeDimIds.has(dim.id)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    activeDimIds.has(dim.id)
                      ? "border-border text-subtext opacity-40 cursor-not-allowed"
                      : "border-price text-price hover:bg-price/10 cursor-pointer"
                  }`}
                >
                  + {dim.label}
                </button>
              ))
            )}
          </div>
        </div>

        {/* ---- Global filters ---- */}
        <div className="card min-w-60">
          <div className="text-subtext text-xs uppercase tracking-wide mb-2">
            Filters
          </div>

          {/* Method */}
          <div className="mb-3">
            <label className="text-subtext text-xs block mb-1">Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="bg-panel border border-border rounded px-2 py-1 text-sm text-text w-full"
            >
              <option value="all">All methods</option>
              <option value="combined">Combined</option>
              <option value="linear">Linear</option>
              <option value="reciprocal">Reciprocal</option>
            </select>
          </div>

          {/* Date range */}
          <div className="mb-3">
            <label className="text-subtext text-xs block mb-1">Date range</label>
            <div className="flex gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                placeholder="From"
                className="bg-panel border border-border rounded px-2 py-1 text-sm text-text flex-1 min-w-0"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                placeholder="To"
                className="bg-panel border border-border rounded px-2 py-1 text-sm text-text flex-1 min-w-0"
              />
            </div>
          </div>

          {/* Min sample size */}
          <div className="mb-3">
            <label className="text-subtext text-xs block mb-1">
              Min sample / bucket
            </label>
            <input
              type="number"
              min={0}
              value={minCount}
              onChange={(e) =>
                setMinCount(Math.max(0, parseInt(e.target.value) || 0))
              }
              className="bg-panel border border-border rounded px-2 py-1 text-sm text-text w-full"
            />
          </div>

          {/* Resolved only */}
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={resolvedOnly}
              onChange={(e) => setResolvedOnly(e.target.checked)}
              className="accent-good"
            />
            <span className="text-text">Resolved markets only</span>
          </label>
        </div>

        {/* ---- City multi-select ---- */}
        <div className="card min-w-48 flex flex-col" style={{ maxHeight: "18rem" }}>
          <div className="text-subtext text-xs uppercase tracking-wide mb-2 flex justify-between items-center shrink-0">
            <span>Cities</span>
            {selectedCities.length > 0 && (
              <button
                onClick={() => setSelectedCities([])}
                className="text-price text-xs hover:underline"
              >
                clear all
              </button>
            )}
          </div>
          {/* Region group headers */}
          <div className="overflow-y-auto flex-1 pr-1">
            {ALL_REGIONS.map((region) => (
              <div key={region} className="mb-2">
                <div className="text-subtext text-xs capitalize mb-0.5">{region}</div>
                {CITIES.filter((c) => c.region === region).map((c) => (
                  <label
                    key={c.city}
                    className="flex items-center gap-2 text-sm cursor-pointer py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCities.includes(c.city)}
                      onChange={() => toggleCity(c.city)}
                      className="accent-good shrink-0"
                    />
                    <span
                      className={`capitalize ${
                        selectedCities.includes(c.city)
                          ? "text-text"
                          : "text-subtext"
                      }`}
                    >
                      {c.city}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ================================================================
          Chart + Table area
      ================================================================ */}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-4">
          <div className="card h-72 animate-pulse" />
          <div className="card h-48 animate-pulse" />
        </div>
      )}

      {/* No dimensions prompt */}
      {!isLoading && noDimsSelected && (
        <div className="text-subtext mt-12 text-center text-sm">
          Add at least one dimension above to start exploring.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && noData && (
        <div className="card mt-4 text-center py-14">
          <div className="text-subtext">
            No buckets meet the minimum sample size.
          </div>
          <div className="text-subtext text-xs mt-1">
            Try a wider date range, lower minimum, or fewer dimensions.
          </div>
          {(data?.total_rows ?? 0) > 0 && (
            <div className="text-subtext text-xs mt-2">
              ({(data!.total_rows).toLocaleString()} rows matched filters before bucketing)
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {!isLoading && data?.error && (
        <div className="card mt-4 text-center py-8 border-temp/40">
          <div className="text-temp text-sm">{data.error}</div>
        </div>
      )}

      {/* Results */}
      {!isLoading && hasBuckets && (
        <div className="space-y-6">

          {/* ---- Bar chart ---- */}
          <div className="card">
            {/* Chart header: meta + metric toggle */}
            <div className="flex items-center justify-between mb-4">
              <div className="text-subtext text-xs">
                {bucketCount.toLocaleString()} bucket
                {bucketCount !== 1 ? "s" : ""}
                {chartBuckets.length < bucketCount &&
                  ` · showing top ${chartBuckets.length}`}
                {" · "}
                {(data?.total_rows ?? 0).toLocaleString()} rows
                {data?.computed_at && (
                  <span className="ml-2">
                    · feature table{" "}
                    {new Date(data.computed_at).toLocaleDateString()}
                  </span>
                )}
              </div>

              {/* Metric toggle — Avg Edge is the default */}
              <div className="flex gap-1">
                <button
                  onClick={() => setMetric("edge")}
                  className={`px-3 py-1 text-xs rounded border transition-colors ${
                    metric === "edge"
                      ? "border-good bg-good/20 text-good"
                      : "border-border text-subtext hover:text-text"
                  }`}
                >
                  Avg Edge
                </button>
                <button
                  onClick={() => setMetric("winrate")}
                  className={`px-3 py-1 text-xs rounded border transition-colors ${
                    metric === "winrate"
                      ? "border-price bg-price/20 text-price"
                      : "border-border text-subtext hover:text-text"
                  }`}
                >
                  Win Rate
                </button>
              </div>
            </div>

            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartBuckets}
                  margin={{ top: 4, right: 16, left: 8, bottom: 64 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#22262d" />
                  <XAxis
                    dataKey="label"
                    stroke="#8b92a0"
                    fontSize={11}
                    angle={-40}
                    textAnchor="end"
                    interval={0}
                    tick={{ fill: "#8b92a0" }}
                  />
                  <YAxis
                    stroke="#8b92a0"
                    fontSize={11}
                    tickFormatter={yFmt}
                    tick={{ fill: "#8b92a0" }}
                  />
                  <Tooltip
                    content={<ChartTooltip metric={metric} />}
                    cursor={{ fill: "#22262d" }}
                  />
                  {/* Zero reference line is important for edge (can be negative) */}
                  <ReferenceLine y={0} stroke="#8b92a0" strokeDasharray="3 3" />
                  {metric === "edge" && (
                    <Bar
                      dataKey="avg_edge_cents"
                      name="Avg Edge (¢)"
                      fill={COLOR_EDGE}
                      radius={[2, 2, 0, 0]}
                      isAnimationActive={false}
                    />
                  )}
                  {metric === "winrate" && (
                    <Bar
                      dataKey="win_rate"
                      name="Win Rate"
                      fill={COLOR_WINRATE}
                      radius={[2, 2, 0, 0]}
                      isAnimationActive={false}
                    />
                  )}
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: "#8b92a0", paddingTop: 8 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ---- Results table ---- */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2 text-subtext font-normal">
                    Bucket
                  </th>
                  <th
                    className="text-right px-3 py-2 text-subtext font-normal cursor-pointer hover:text-text"
                    onClick={() => handleSort("count")}
                  >
                    Count
                    <SortArrow col="count" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  <th
                    className="text-right px-3 py-2 text-subtext font-normal cursor-pointer hover:text-text"
                    onClick={() => handleSort("resolved")}
                  >
                    Resolved
                    <SortArrow col="resolved" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  {/* Avg Edge is primary — comes first in table per user requirement */}
                  <th
                    className="text-right px-3 py-2 font-normal cursor-pointer hover:text-text"
                    style={{ color: COLOR_EDGE }}
                    onClick={() => handleSort("avg_edge_cents")}
                  >
                    Avg Edge
                    <SortArrow col="avg_edge_cents" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                  {/* Win Rate is the secondary column */}
                  <th
                    className="text-right px-3 py-2 font-normal cursor-pointer hover:text-text"
                    style={{ color: COLOR_WINRATE }}
                    onClick={() => handleSort("win_rate")}
                  >
                    Win Rate
                    <SortArrow col="win_rate" sortCol={sortCol} sortDir={sortDir} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedBuckets.map((b) => {
                  const edgePositive =
                    b.avg_edge_cents != null && b.avg_edge_cents > 0;
                  const edgeNegative =
                    b.avg_edge_cents != null && b.avg_edge_cents < 0;
                  return (
                    <tr
                      key={b.key}
                      className="border-t border-border hover:bg-panel/60 transition-colors"
                    >
                      <td className="px-3 py-2 text-text font-mono text-xs">
                        {b.label}
                      </td>
                      <td className="px-3 py-2 text-right text-subtext">
                        {b.count.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-subtext">
                        {b.resolved.toLocaleString()}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${
                          edgePositive
                            ? "text-good"
                            : edgeNegative
                            ? "text-temp"
                            : "text-subtext"
                        }`}
                      >
                        {fmtEdge(b.avg_edge_cents)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-price">
                        {fmtPct(b.win_rate)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
