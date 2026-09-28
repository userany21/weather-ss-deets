"use client";

import { useState, useMemo, useCallback, type ReactNode } from "react";
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
// Scanner types
// ---------------------------------------------------------------------------

interface PinnedCriteria {
  /** Composite bucket key, e.g. "lm:4:moderate|rt:4:rising" */
  key: string;
  /** Human-readable label */
  label: string;
  /** Snapshot of activeDims at pin time */
  dims: ActiveDim[];
  /** Snapshot of method filter at pin time */
  method: string;
}

interface ScanMatch {
  city: string;
  bracket: string;
  local_date: string;
  local_time: string;
  tick_count: number;
  lead_margin_pct: number | null;
  rank_now: number | null;
  rank_prev: number | null;
}

interface ScanResponse {
  scanned_at: string;
  criteria_label: string;
  criteria_key: string;
  method: string;
  cities_scanned: string[];
  match_count: number;
  matches: ScanMatch[];
  error?: string;
}

// ---------------------------------------------------------------------------
// "Latest updates" card types
// ---------------------------------------------------------------------------

interface LatestUpdate {
  bracket: string;
  price: number;
  updated: string;
  tone: "blue" | "red" | "green";
}

// TODO: placeholder rows. Swap for a real feed (SWR fetch) once there's an
// endpoint for it, then pass it to <LatestUpdatesCard />.
const LATEST_UPDATES: LatestUpdate[] = [
  { bracket: "71 or below", price: 0.14, updated: "1:51 PM", tone: "blue" },
  { bracket: "72-73",        price: 0.14, updated: "1:52 PM", tone: "red"  },
  { bracket: "74-75",        price: 0.14, updated: "1:52 PM", tone: "green" },
];

// ---------------------------------------------------------------------------
// Constants / statics
// ---------------------------------------------------------------------------

const ALL_CITIES = CITIES.map((c) => c.city);
// Longest first so "hong kong" wins over any shorter prefix match
const CITY_NAMES_BY_LENGTH = [...ALL_CITIES].sort((a, b) => b.length - a.length);
const ALL_REGIONS = ["asia", "europe", "america"] as const;
const DEFAULT_COLLAPSED_REGIONS = ["europe", "america"];

const HOURS = ["8AM", "9AM", "10AM", "11AM", "12PM", "1PM", "2PM", "3PM", "4PM", "5PM"];
const REMOVE_VALUE = "__remove__";

// Max buckets shown in chart (label overlap gets bad beyond this)
const MAX_CHART_BUCKETS = 30;

// Palette
const C = {
  edge:    "#22d38a",
  winrate: "#38a3f5",
  grid:    "#15223a",
  zero:    "#2b3b58",
  axis:    "#8a97b1",
  good:    "#2ee08a",
  bad:     "#ff5566",
  link:    "#38a3f5",
};
const DOT_COLORS = ["#2b9cff", "#8b7cf6", "#2ed3a5", "#ff8a3d", "#f5c542", "#ff5c8a", "#5ce1e6"];

// Shared class strings
const CARD  = "rounded-xl border border-[#16233a] bg-[#0a1322] p-4";
const LABEL_BASE = "text-[11px] font-semibold uppercase tracking-[0.08em]";
const FIELD =
  "h-9 w-full rounded-lg border border-[#1c2b45] bg-[#0b1626] text-sm text-white outline-none focus:border-[#38a3f5]/70";
const PILL =
  "relative inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#1c2b45] bg-[#0d182a] px-3 text-sm text-white";
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-[#1c2b45] bg-[#0b1626] px-2.5 py-1 text-[11px] transition-colors";
const SCROLL =
  "[scrollbar-width:thin] [scrollbar-color:#1f2f4a_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#1f2f4a]";

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** Serialise ActiveDim[] to the "by" URL param format, e.g. "lead_margin:4,rank_trend:4" */
function dimsToByParam(dims: ActiveDim[]): string {
  return dims
    .map((d) => {
      const entries = Object.entries(d.config);
      return entries.length ? `${d.id}:${entries[0][1]}` : d.id;
    })
    .join(",");
}

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
  if (dims.length > 0) params.set("by", dimsToByParam(dims));
  if (cities.length > 0) params.set("city", cities.join(","));
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo)   params.set("dateTo",   dateTo);
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
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "desc"
      ? (bv as number) - (av as number)
      : (av as number) - (bv as number);
  });
}

function defaultConfig(meta: DimMeta): Record<string, number> {
  return meta.configSchema
    ? { [meta.configSchema.key]: meta.configSchema.default }
    : {};
}

/** Display text for a dimension config option (hour index → "10AM", else cents). */
function fmtConfigOption(key: string, o: number): string {
  return key === "n" ? (HOURS[o] ?? `H${o}`) : `${o}¢`;
}

const isLocationDim = (s: string) => /^(city|region)$/i.test(s);

/** Splits a leading city name off a bucket label so it can be colour-coded. */
function splitBucketLabel(label: string): { city: string | null; rest: string } {
  const lower = label.toLowerCase();
  const city = CITY_NAMES_BY_LENGTH.find((c) => lower.startsWith(c.toLowerCase()));
  if (!city) return { city: null, rest: label };
  return { city, rest: label.slice(city.length).replace(/^[\s|·,:→>×/-]+/, "") };
}

function cityColor(city: string): string {
  return DOT_COLORS[Math.max(0, ALL_CITIES.indexOf(city)) % DOT_COLORS.length];
}

const truncateLabel = (v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v);

// ---------------------------------------------------------------------------
// Icons (inline SVGs — no extra dependency)
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function Svg({
  children,
  className = "h-4 w-4",
  fill = "none",
}: {
  children: ReactNode;
  className?: string;
  fill?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ChevronDown  = ({ className = "h-3.5 w-3.5" }: IconProps) => (
  <Svg className={className}><path d="m6 9 6 6 6-6" /></Svg>
);
const ChevronRight = ({ className = "h-3.5 w-3.5" }: IconProps) => (
  <Svg className={className}><path d="m9 6 6 6-6 6" /></Svg>
);
const PlusIcon     = ({ className = "h-4 w-4" }: IconProps) => (
  <Svg className={className}><path d="M12 5v14M5 12h14" /></Svg>
);
const PinIcon      = ({ className = "h-3.5 w-3.5" }: IconProps) => (
  <Svg className={className}>
    <path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10Z" />
    <circle cx="12" cy="11" r="2" />
  </Svg>
);
const SearchIcon   = ({ className = "h-3.5 w-3.5" }: IconProps) => (
  <Svg className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
);
const CalendarIcon = ({ className = "h-3.5 w-3.5" }: IconProps) => (
  <Svg className={className}>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M8 3v4M16 3v4M4 10h16" />
  </Svg>
);
const ArrowRight   = ({ className = "h-3 w-3" }: IconProps) => (
  <Svg className={className}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
);
const TrendIcon    = ({ className = "h-9 w-9" }: IconProps) => (
  <Svg className={className}><path d="M4 4v16h16" /><path d="m8 15 4-4 3 3 5-6" /></Svg>
);
const BarsIcon     = ({ className = "h-5 w-5" }: IconProps) => (
  <Svg className={className}><path d="M6 20V10M12 20V4M18 20v-7" /></Svg>
);
const ChartBoxIcon = ({ className = "h-5 w-5" }: IconProps) => (
  <Svg className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 15 3-3 3 2 4-5" />
  </Svg>
);
const BoltIcon     = ({ className = "h-5 w-5" }: IconProps) => (
  <Svg className={className} fill="currentColor">
    <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Custom Recharts tooltip styled to match the dark theme. */
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
    <div className="rounded-lg border border-[#1c2b45] bg-[#0a1322] px-3 py-2 text-sm shadow-lg">
      <div className="mb-1 max-w-56 truncate text-xs text-[#8a97b1]">{label}</div>
      {payload.map(
        (p: { name: string; value: number; fill: string }, i: number) => (
          <div key={i} style={{ color: p.fill }} className="font-mono">
            {p.name}: {metric === "edge" ? fmtEdge(p.value) : fmtPct(p.value)}
          </div>
        )
      )}
    </div>
  );
}

/** Sort indicator shown in table headers. */
function SortArrow({
  col,
  sortCol,
  sortDir,
}: {
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
}) {
  if (col !== sortCol)
    return <span className="ml-1 text-[10px] text-[#5f6c86]">⇅</span>;
  return (
    <ChevronDown
      className={`ml-1 inline h-3 w-3 align-middle ${sortDir === "asc" ? "rotate-180" : ""}`}
    />
  );
}

function DateField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <CalendarIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a97b1]" />
      <input
        type="date"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${FIELD} pl-8 pr-1 text-xs [color-scheme:dark] [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0`}
      />
    </div>
  );
}

function LatestUpdatesCard({ updates }: { updates: LatestUpdate[] }) {
  const tone: Record<LatestUpdate["tone"], string> = {
    blue:  "text-[#38a3f5]",
    red:   "text-[#ff5566]",
    green: "text-[#2ee08a]",
  };
  return (
    <div className={CARD}>
      <div className="mb-3 flex items-center gap-2.5">
        <BoltIcon className="h-5 w-5 text-[#38a3f5]" />
        <h2 className="text-[15px] font-semibold text-white">Latest updates</h2>
        {/* TODO: point at the real "all updates" route */}
        <Link
          href="#"
          className="ml-auto inline-flex items-center gap-1 text-xs text-[#38a3f5] hover:underline"
        >
          View all <ArrowRight />
        </Link>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-xs text-[#8a97b1]">
            <th className="px-3 py-2 text-left font-normal">Bracket</th>
            <th className="px-3 py-2 text-left font-normal">Price</th>
            <th className="px-3 py-2 text-left font-normal">Last updated</th>
          </tr>
        </thead>
        <tbody>
          {updates.map((u) => (
            <tr key={u.bracket} className="border-t border-[#121d31]">
              <td className={`px-3 py-2.5 font-medium ${tone[u.tone]}`}>{u.bracket}</td>
              <td className="px-3 py-2.5 tabular-nums text-white">{u.price.toFixed(2)}</td>
              <td className="px-3 py-2.5 text-xs text-[#8a97b1]">{u.updated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function StatsExplorerPage() {
  // ---- Dimension state ----
  const [activeDims, setActiveDims] = useState<ActiveDim[]>([]);

  // ---- Filter state ----
  const [selectedCities, setSelectedCities]   = useState<string[]>([]);
  const [citySearch, setCitySearch]            = useState("");
  const [collapsedRegions, setCollapsedRegions] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED_REGIONS)
  );
  const [dateFrom, setDateFrom]       = useState("");
  const [dateTo, setDateTo]           = useState("");
  const [method, setMethod]           = useState("combined");
  const [minCount, setMinCount]       = useState(10);
  const [resolvedOnly, setResolvedOnly] = useState(true);

  // ---- Display state — default to avg_edge per user requirement ----
  const [metric, setMetric]     = useState<Metric>("edge");
  const [sortCol, setSortCol]   = useState<SortCol>("avg_edge_cents");
  const [sortDir, setSortDir]   = useState<SortDir>("desc");

  // ---- Live scanner state ----
  const [pinnedCriteria, setPinnedCriteria] = useState<PinnedCriteria[]>([]);
  const [scanResults, setScanResults]       = useState<Record<string, ScanResponse>>({});
  const [isScanning, setIsScanning]         = useState(false);
  const [lastScanTime, setLastScanTime]     = useState<string | null>(null);

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

  const registry: DimMeta[]    = data?.dimension_registry ?? [];
  const activeDimIds            = useMemo(() => new Set(activeDims.map((d) => d.id)), [activeDims]);
  const availableDims           = registry.filter((d) => !activeDimIds.has(d.id));

  // ---- Dimension picker handlers ----
  const addDim = useCallback(
    (id: string) => {
      const meta = registry.find((d) => d.id === id);
      if (!meta || activeDimIds.has(id)) return;
      setActiveDims((prev) => [...prev, { id, config: defaultConfig(meta) }]);
    },
    [registry, activeDimIds]
  );

  const replaceDim = useCallback(
    (idx: number, id: string) => {
      const meta = registry.find((d) => d.id === id);
      if (!meta || activeDimIds.has(id)) return;
      setActiveDims((prev) =>
        prev.map((d, i) => (i === idx ? { id, config: defaultConfig(meta) } : d))
      );
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

  const toggleRegion = useCallback((region: string) => {
    setCollapsedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  }, []);

  const cityQuery  = citySearch.trim().toLowerCase();
  const regionGroups = useMemo(
    () =>
      ALL_REGIONS.map((region) => ({
        region,
        cities: CITIES.filter(
          (c) =>
            c.region === region &&
            (!cityQuery || c.city.toLowerCase().includes(cityQuery))
        ),
      })).filter((g) => g.cities.length > 0),
    [cityQuery]
  );

  // ---- Table sort ----
  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  // ---- Scanner handlers ----
  const pinRow = useCallback(
    (b: Bucket) => {
      setPinnedCriteria((prev) => {
        if (prev.some((p) => p.key === b.key)) return prev;
        return [
          ...prev,
          { key: b.key, label: b.label, dims: [...activeDims], method },
        ];
      });
    },
    [activeDims, method]
  );

  const unpinRow = useCallback((key: string) => {
    setPinnedCriteria((prev) => prev.filter((p) => p.key !== key));
    setScanResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const runScan = useCallback(async () => {
    if (pinnedCriteria.length === 0) return;
    setIsScanning(true);
    try {
      const citiesToScan =
        selectedCities.length > 0 ? selectedCities : ALL_CITIES;
      const results = await Promise.all(
        pinnedCriteria.map(async (criteria) => {
          const params = new URLSearchParams();
          params.set("by",          dimsToByParam(criteria.dims));
          params.set("criteriaKey", criteria.key);
          params.set("cities",      citiesToScan.join(","));
          params.set("method",      criteria.method);
          const res  = await fetch(`/api/scan?${params.toString()}`);
          const json: ScanResponse = await res.json();
          return [criteria.key, json] as [string, ScanResponse];
        })
      );
      setScanResults(Object.fromEntries(results));
      setLastScanTime(new Date().toLocaleTimeString());
    } catch {
      // errors are shown per-criteria via ScanResponse.error
    } finally {
      setIsScanning(false);
    }
  }, [pinnedCriteria, selectedCities]);

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

  const bucketCount    = data?.buckets.length ?? 0;
  const hasBuckets     = bucketCount > 0;
  const noDimsSelected = activeDims.length === 0;
  const noData         = !isLoading && !noDimsSelected && !hasBuckets;

  const chartCaption = [
    `${bucketCount.toLocaleString()} bucket${bucketCount !== 1 ? "s" : ""}`,
    chartBuckets.length < bucketCount ? `showing top ${chartBuckets.length}` : null,
    `${(data?.total_rows ?? 0).toLocaleString()} rows`,
    data?.computed_at
      ? `feature table ${new Date(data.computed_at).toLocaleDateString()}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-[1400px]">
      {/* Breadcrumb + title */}
      <div className="mb-2 text-[13px] text-[#8a97b1]">
        <Link href="/" className="hover:text-white">
          Regions
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-[#c5d0e6]">Stats Explorer</span>
      </div>
      <div className="mb-6 flex items-center gap-3">
        <TrendIcon className="h-9 w-9 shrink-0 text-[#38a3f5]" />
        <div>
          <h1 className="text-2xl font-semibold leading-tight text-white">Stats Explorer</h1>
          <p className="text-[13px] text-[#8a97b1]">
            Analyze historical and forecasted market data across regions, cities, and timeframes.
          </p>
        </div>
      </div>

      {/* ================================================================
          Controls row
      ================================================================ */}
      <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_16.5rem_14.5rem]">

        {/* ---- Dimensions + quick ranges ---- */}
        <div className={`${CARD} flex flex-col gap-5 md:flex-row md:gap-0`}>
          <div className="md:w-[19rem] md:shrink-0 md:border-r md:border-[#16233a] md:pr-5">
            <div className={`${LABEL_BASE} mb-3 text-[#a9b6d0]`}>Dimensions</div>

            {noDimsSelected && (
              <p className="mb-3 text-sm text-[#8a97b1]">
                No dimensions selected. Add one to start slicing.
              </p>
            )}

            <div className="mb-4 flex flex-wrap gap-2">
              {activeDims.map((d, i) => {
                const meta      = registry.find((r) => r.id === d.id);
                const label     = meta?.label ?? d.id;
                const schema    = meta?.configSchema;
                const cfgValue  = schema ? (d.config[schema.key] ?? schema.default) : 0;
                return (
                  <div key={d.id} className="inline-flex items-center gap-1.5">
                    {/* Label pill — invisible select swaps or removes the dim */}
                    <label className={`${PILL} cursor-pointer`}>
                      {isLocationDim(label) && (
                        <PinIcon className="h-3.5 w-3.5 text-[#8a97b1]" />
                      )}
                      <span>{label}</span>
                      <ChevronDown className="h-3.5 w-3.5 text-[#8a97b1]" />
                      <select
                        aria-label={`Change ${label}`}
                        value={d.id}
                        onChange={(e) =>
                          e.target.value === REMOVE_VALUE
                            ? removeDim(i)
                            : replaceDim(i, e.target.value)
                        }
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      >
                        <option value={d.id}>{label}</option>
                        {availableDims.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                        <option value={REMOVE_VALUE}>Remove</option>
                      </select>
                    </label>

                    {/* Per-dimension config pill */}
                    {schema &&
                      (schema.type === "select" ? (
                        <label className={`${PILL} cursor-pointer`}>
                          <span>{fmtConfigOption(schema.key, cfgValue)}</span>
                          <ChevronDown className="h-3.5 w-3.5 text-[#8a97b1]" />
                          <select
                            aria-label={`${label} setting`}
                            value={cfgValue}
                            onChange={(e) =>
                              updateDimConfig(i, schema.key, Number(e.target.value))
                            }
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                          >
                            {schema.options?.map((o) => (
                              <option key={o} value={o}>
                                {fmtConfigOption(schema.key, o)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <input
                          type="number"
                          aria-label={`${label} setting`}
                          value={cfgValue}
                          onChange={(e) =>
                            updateDimConfig(i, schema.key, Number(e.target.value))
                          }
                          className={`${PILL} w-20 outline-none focus:border-[#38a3f5]/70`}
                        />
                      ))}
                  </div>
                );
              })}
            </div>

            <label
              className={`relative inline-flex items-center gap-2.5 text-sm text-[#a9b6d0] ${
                availableDims.length === 0
                  ? "cursor-not-allowed opacity-40"
                  : "cursor-pointer hover:text-white"
              }`}
            >
              <span className="grid h-8 w-8 place-items-center rounded-full border border-[#1c2b45] bg-[#0d182a]">
                <PlusIcon />
              </span>
              Add dimension
              <select
                aria-label="Add dimension"
                value=""
                disabled={availableDims.length === 0}
                onChange={(e) => e.target.value && addDim(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              >
                <option value="" disabled>
                  Add dimension
                </option>
                {availableDims.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Quick ranges */}
          <div className="min-w-0 flex-1 md:pl-5">
            <div className={`${LABEL_BASE} mb-3 text-[#8a97b1]`}>Quick ranges</div>
            <div className="flex flex-wrap gap-x-2 gap-y-2.5">
              {registry.length === 0 ? (
                <span className="text-xs text-[#8a97b1]">Loading…</span>
              ) : (
                registry.map((dim) => {
                  const active = activeDimIds.has(dim.id);
                  return (
                    <button
                      key={dim.id}
                      onClick={() => addDim(dim.id)}
                      disabled={active}
                      className={`${CHIP} ${
                        active
                          ? "cursor-not-allowed text-[#8a97b1] opacity-40"
                          : "cursor-pointer text-[#b4c1da] hover:border-[#38a3f5]/60 hover:text-white"
                      }`}
                    >
                      {isLocationDim(dim.label) ? (
                        <PinIcon className="h-3 w-3" />
                      ) : (
                        <span className="text-[#8a97b1]">+</span>
                      )}
                      {dim.label}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ---- Global filters ---- */}
        <div className={CARD}>
          <div className={`${LABEL_BASE} mb-3 text-[#a9b6d0]`}>Filters</div>

          <div className="space-y-3">
            {/* Method */}
            <div>
              <label className="mb-1 block text-xs text-[#8a97b1]">Method</label>
              <div className="relative">
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className={`${FIELD} appearance-none px-3 pr-8`}
                >
                  <option value="all">All methods</option>
                  <option value="combined">Combined</option>
                  <option value="linear">Linear</option>
                  <option value="reciprocal">Reciprocal</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a97b1]" />
              </div>
            </div>

            {/* Date range */}
            <div>
              <label className="mb-1 block text-xs text-[#8a97b1]">Date range</label>
              <div className="flex items-center gap-1.5">
                <DateField value={dateFrom} onChange={setDateFrom} label="From date" />
                <ArrowRight className="h-3 w-3 shrink-0 text-[#5f6c86]" />
                <DateField value={dateTo}   onChange={setDateTo}   label="To date" />
              </div>
            </div>

            {/* Min sample size */}
            <div>
              <label className="mb-1 block text-xs text-[#8a97b1]">Min sample / bucket</label>
              <input
                type="number"
                min={0}
                value={minCount}
                onChange={(e) => setMinCount(Math.max(0, parseInt(e.target.value) || 0))}
                className={`${FIELD} px-3`}
              />
            </div>

            {/* Resolved only */}
            <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-[#c5d0e6]">
              <input
                type="checkbox"
                checked={resolvedOnly}
                onChange={(e) => setResolvedOnly(e.target.checked)}
                className="h-4 w-4 rounded accent-[#22c98a]"
              />
              Resolved markets only
            </label>
          </div>
        </div>

        {/* ---- City multi-select ---- */}
        <div className={`${CARD} flex min-h-0 flex-col lg:max-h-[16.25rem]`}>
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <span className={`${LABEL_BASE} text-[#a9b6d0]`}>Cities</span>
            {selectedCities.length > 0 && (
              <button
                onClick={() => setSelectedCities([])}
                className="text-xs text-[#38a3f5] hover:underline"
              >
                clear all
              </button>
            )}
          </div>

          <div className="relative mb-2 shrink-0">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a97b1]" />
            <input
              type="text"
              value={citySearch}
              onChange={(e) => setCitySearch(e.target.value)}
              placeholder="Search cities..."
              aria-label="Search cities"
              className={`${FIELD} h-8 pl-8 pr-2 text-xs placeholder:text-[#5f6c86]`}
            />
          </div>

          <div className={`-mr-1 min-h-0 flex-1 overflow-y-auto pr-2 ${SCROLL}`}>
            {regionGroups.length === 0 && (
              <div className="py-2 text-xs text-[#5f6c86]">No cities match.</div>
            )}
            {regionGroups.map(({ region, cities }) => {
              // Searching always expands so matches are visible
              const open = cityQuery !== "" || !collapsedRegions.has(region);
              return (
                <div key={region} className="mb-1">
                  <button
                    onClick={() => toggleRegion(region)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between py-1 text-xs capitalize text-[#8a97b1] hover:text-white"
                  >
                    {region}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                  {open &&
                    cities.map((c) => (
                      <label
                        key={c.city}
                        className="flex cursor-pointer items-center gap-2.5 py-1 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedCities.includes(c.city)}
                          onChange={() => toggleCity(c.city)}
                          className="h-4 w-4 shrink-0 rounded accent-[#22c98a]"
                        />
                        <span
                          className={`capitalize ${
                            selectedCities.includes(c.city)
                              ? "text-white"
                              : "text-[#8a97b1]"
                          }`}
                        >
                          {c.city}
                        </span>
                      </label>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ================================================================
          Chart + Table area
      ================================================================ */}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-4">
          <div className={`${CARD} h-72 animate-pulse`} />
          <div className={`${CARD} h-48 animate-pulse`} />
        </div>
      )}

      {/* No dimensions prompt */}
      {!isLoading && noDimsSelected && (
        <div className="mt-12 text-center text-sm text-[#8a97b1]">
          Add at least one dimension above to start exploring.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && noData && (
        <div className={`${CARD} mt-4 py-14 text-center`}>
          <div className="text-[#8a97b1]">No buckets meet the minimum sample size.</div>
          <div className="mt-1 text-xs text-[#8a97b1]">
            Try a wider date range, lower minimum, or fewer dimensions.
          </div>
          {(data?.total_rows ?? 0) > 0 && (
            <div className="mt-2 text-xs text-[#8a97b1]">
              ({data!.total_rows.toLocaleString()} rows matched filters before bucketing)
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {!isLoading && data?.error && (
        <div className={`${CARD} mt-4 border-[#ff5566]/40 py-8 text-center`}>
          <div className="text-sm text-[#ff5566]">{data.error}</div>
        </div>
      )}

      {/* Results */}
      {!isLoading && hasBuckets && (
        <div className="space-y-5">
          {/* ---- Bar chart ---- */}
          <div className={`${CARD} px-5 pb-3 pt-4`}>
            <div className="mb-3 flex items-center gap-3">
              <BarsIcon className="h-5 w-5 shrink-0 text-[#38a3f5]" />
              <h2 className="text-[15px] font-semibold text-white">Market price over the day</h2>
              <span className="hidden truncate text-xs text-[#5f6c86] lg:inline">
                {chartCaption}
              </span>

              {/* Metric toggle — Avg Edge is the default */}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setMetric("edge")}
                  className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                    metric === "edge"
                      ? "bg-[#0f6f5a] text-white"
                      : "text-[#8a97b1] hover:text-white"
                  }`}
                >
                  Avg Edge
                </button>
                <button
                  onClick={() => setMetric("winrate")}
                  className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                    metric === "winrate"
                      ? "bg-[#12507f] text-white"
                      : "text-[#8a97b1] hover:text-white"
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
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis
                    dataKey="label"
                    height={78}
                    interval={0}
                    angle={-40}
                    textAnchor="end"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: C.axis, fontSize: 11 }}
                    tickFormatter={truncateLabel}
                  />
                  <YAxis
                    width={44}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: C.axis, fontSize: 11 }}
                    tickFormatter={yFmt}
                  />
                  <Tooltip
                    content={<ChartTooltip metric={metric} />}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  {/* Zero reference line matters for edge (can be negative) */}
                  <ReferenceLine y={0} stroke={C.zero} />
                  {metric === "edge" && (
                    <Bar
                      dataKey="avg_edge_cents"
                      name="Avg Edge (¢)"
                      fill={C.edge}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={40}
                      isAnimationActive={false}
                    />
                  )}
                  {metric === "winrate" && (
                    <Bar
                      dataKey="win_rate"
                      name="Win Rate"
                      fill={C.winrate}
                      radius={[3, 3, 0, 0]}
                      maxBarSize={40}
                      isAnimationActive={false}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ---- Results table + latest updates side-by-side ---- */}
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_23.5rem]">
            <div className={`${CARD} overflow-x-auto px-5`}>
              <div className="mb-2 flex items-center gap-3">
                <ChartBoxIcon className="h-5 w-5 shrink-0 text-[#38a3f5]" />
                <h2 className="text-[15px] font-semibold text-white">Market price details</h2>
              </div>

              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-xs text-[#8a97b1]">
                    <th className="px-3 py-2 text-left font-normal">Bucket</th>
                    <th
                      className="cursor-pointer whitespace-nowrap px-3 py-2 text-right font-normal hover:text-white"
                      onClick={() => handleSort("count")}
                    >
                      Count
                      <SortArrow col="count" sortCol={sortCol} sortDir={sortDir} />
                    </th>
                    <th
                      className="cursor-pointer whitespace-nowrap px-3 py-2 text-right font-normal hover:text-white"
                      onClick={() => handleSort("resolved")}
                    >
                      Resolved
                      <SortArrow col="resolved" sortCol={sortCol} sortDir={sortDir} />
                    </th>
                    {/* Avg Edge is primary — comes first per user requirement */}
                    <th
                      className="cursor-pointer whitespace-nowrap px-3 py-2 text-right font-normal hover:text-white"
                      onClick={() => handleSort("avg_edge_cents")}
                    >
                      Avg Edge
                      <SortArrow col="avg_edge_cents" sortCol={sortCol} sortDir={sortDir} />
                    </th>
                    <th
                      className="cursor-pointer whitespace-nowrap px-3 py-2 text-right font-normal hover:text-white"
                      onClick={() => handleSort("win_rate")}
                    >
                      Win Rate
                      <SortArrow col="win_rate" sortCol={sortCol} sortDir={sortDir} />
                    </th>
                    <th className="w-8" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {sortedBuckets.map((b, idx) => {
                    const edgePositive = b.avg_edge_cents != null && b.avg_edge_cents > 0;
                    const edgeNegative = b.avg_edge_cents != null && b.avg_edge_cents < 0;
                    const isPinned     = pinnedCriteria.some((p) => p.key === b.key);
                    const { city, rest } = splitBucketLabel(b.label);
                    const dot          = city
                      ? cityColor(city)
                      : DOT_COLORS[idx % DOT_COLORS.length];
                    return (
                      // Clicking a row pins/unpins it for the live scanner
                      <tr
                        key={b.key}
                        onClick={() => (isPinned ? unpinRow(b.key) : pinRow(b))}
                        title={isPinned ? "Remove from scanner" : "Pin for live scan"}
                        className="cursor-pointer border-t border-[#121d31] transition-colors hover:bg-white/[0.03]"
                      >
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-3">
                            <span
                              className={`h-3 w-3 shrink-0 rounded-full ${
                                isPinned
                                  ? "ring-2 ring-white/80 ring-offset-2 ring-offset-[#0a1322]"
                                  : ""
                              }`}
                              style={{ background: dot }}
                            />
                            {city ? (
                              <>
                                <span
                                  className="text-sm font-medium capitalize"
                                  style={{ color: dot }}
                                >
                                  {city}
                                </span>
                                <span className="text-[#5f6c86]">→</span>
                                <span className="text-xs text-[#8a97b1]">{rest}</span>
                              </>
                            ) : (
                              <span className="text-xs text-[#c5d0e6]">{b.label}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-white">
                          {b.count.toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-[#c5d0e6]">
                          {b.resolved.toLocaleString()}
                        </td>
                        <td
                          className="px-3 py-2.5 text-right font-medium tabular-nums"
                          style={{
                            color: edgePositive ? C.good : edgeNegative ? C.bad : C.axis,
                          }}
                        >
                          {fmtEdge(b.avg_edge_cents)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-[#38b6ff]">
                          {fmtPct(b.win_rate)}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <button
                            type="button"
                            aria-pressed={isPinned}
                            aria-label={isPinned ? "Remove from scanner" : "Pin for live scan"}
                            className="inline-flex align-middle"
                          >
                            {isPinned ? (
                              <span className="text-[#22d38a]">◉</span>
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-[#5f6c86]" />
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <LatestUpdatesCard updates={LATEST_UPDATES} />
          </div>

          {/* ---- Live Opportunity Scanner panel ---- */}
          {pinnedCriteria.length > 0 && (
            <div className={CARD}>
              {/* Header */}
              <div className="mb-3 flex items-center justify-between">
                <div className={`${LABEL_BASE} text-[#a9b6d0]`}>Live Opportunity Scanner</div>
                <div className="flex items-center gap-3">
                  {lastScanTime && (
                    <span className="text-xs text-[#8a97b1]">Last scan: {lastScanTime}</span>
                  )}
                  <button
                    onClick={runScan}
                    disabled={isScanning}
                    className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${
                      isScanning
                        ? "cursor-not-allowed border-[#1c2b45] text-[#8a97b1]"
                        : "border-[#22c98a] text-[#22d38a] hover:bg-[#22c98a]/10"
                    }`}
                  >
                    {isScanning ? "Scanning…" : "▶ Scan Now"}
                  </button>
                </div>
              </div>

              {/* Pinned criteria chips */}
              <div className="mb-4 flex flex-wrap gap-2">
                {pinnedCriteria.map((c) => (
                  <div
                    key={c.key}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#22c98a]/40 bg-[#22c98a]/10 px-2 py-1 text-xs"
                  >
                    <span className="capitalize text-[#8a97b1]">{c.method}:</span>
                    <span className="font-mono text-white">{c.label}</span>
                    <button
                      onClick={() => unpinRow(c.key)}
                      className="ml-1 leading-none text-[#8a97b1] hover:text-white"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {/* Help text when scan hasn't run yet */}
              {Object.keys(scanResults).length === 0 && !isScanning && (
                <div className="text-xs text-[#8a97b1]">
                  {selectedCities.length > 0
                    ? `Will scan ${selectedCities.length} selected ${
                        selectedCities.length === 1 ? "city" : "cities"
                      }. Click ▶ Scan Now to check today's live data.`
                    : `Will scan all cities. Select specific cities in the panel above to narrow scope.`}
                </div>
              )}

              {/* Results per criteria */}
              <div className="space-y-5">
                {pinnedCriteria.map((c) => {
                  const result = scanResults[c.key];
                  if (!result) return null;

                  if (result.error) {
                    return (
                      <div key={c.key} className="text-xs text-[#ff5566]">
                        Error scanning {c.label}: {result.error}
                      </div>
                    );
                  }

                  return (
                    <div key={c.key}>
                      {/* Per-criteria sub-header */}
                      <div className="mb-2 flex items-center gap-2">
                        <span
                          className={`font-mono text-xs font-semibold ${
                            result.match_count > 0 ? "text-[#22d38a]" : "text-[#8a97b1]"
                          }`}
                        >
                          {result.match_count} match{result.match_count !== 1 ? "es" : ""}
                        </span>
                        <span className="text-xs text-[#8a97b1]">
                          · {result.cities_scanned.length} cities scanned
                        </span>
                        <span className="text-xs text-[#8a97b1]">
                          · {new Date(result.scanned_at).toLocaleTimeString()}
                        </span>
                      </div>

                      {result.matches.length === 0 ? (
                        <div className="text-xs text-[#8a97b1]">
                          No cities match this criteria right now.
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {result.matches.map((m) => {
                            const trendArrow =
                              m.rank_now != null && m.rank_prev != null
                                ? m.rank_now < m.rank_prev
                                  ? "↑"
                                  : m.rank_now > m.rank_prev
                                  ? "↓"
                                  : "→"
                                : null;
                            return (
                              <div
                                key={`${m.city}|${m.bracket}`}
                                className="min-w-36 rounded-lg border border-[#22c98a]/30 bg-[#22c98a]/10 px-3 py-2 text-xs"
                              >
                                <div className="font-semibold capitalize text-white">{m.city}</div>
                                <div className="font-mono text-[#38a3f5]">{m.bracket}</div>
                                <div className="mt-1 text-[#8a97b1]">
                                  {m.local_time} · {m.tick_count}T
                                </div>
                                {m.lead_margin_pct != null && (
                                  <div className="text-[#22d38a]">
                                    Margin: {m.lead_margin_pct.toFixed(1)}%
                                  </div>
                                )}
                                {m.rank_now != null &&
                                  m.rank_prev != null &&
                                  trendArrow && (
                                    <div className="text-[#38a3f5]">
                                      Rank {m.rank_prev}→{m.rank_now} {trendArrow}
                                    </div>
                                  )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
