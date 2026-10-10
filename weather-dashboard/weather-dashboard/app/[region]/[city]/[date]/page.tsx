"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import useSWR from "swr";
import Card from "@/components/Card";
import TempChart, { COMPARE_COLORS, MAX_COMPARE, type CompareDay } from "@/components/TempChart";
import StatsTable from "@/components/StatsTable";
import PriceChart, { LatestUpdates, YesPriceChart, type BracketHistory } from "@/components/PriceChart";
import LocalTimesPanel from "@/components/LocalTimesPanel";
import { BarChartIcon, CloudIcon, InfoIcon, PinIcon } from "@/components/icons";
import type { EnrichedTick } from "@/lib/weather-transform";
import { fallbackBracketLabel } from "@/lib/weather-transform";
import { useWeatherStream } from "@/lib/useWeatherStream";
import { C } from "@/lib/theme";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const NO_TICKS: EnrichedTick[] = [];

function avg(nums: (number | null)[]) {
  const vals = nums.filter((n): n is number => n != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

interface DayResponse {
  city: string;
  date: string;
  unit: "F" | "C";
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
  ticks: EnrichedTick[];
  reciprocalTicks: EnrichedTick[];
}

interface PriceHistoryResponse {
  brackets: BracketHistory[];
  /** UTC offset in ms for the city's timezone on this date */
  tzOffsetMs: number;
}

interface CityStats {
  avgTicksPerDay: number | null;
  totalDays: number;
  dates: string[];
}

/** Loads one past day for the compare overlay. Returns undefined while it loads. */
function useCompareDay(city: string, date: string | undefined) {
  const isToday = date === new Date().toISOString().slice(0, 10);
  const { data } = useSWR<DayResponse>(
    date ? `/api/day/${encodeURIComponent(city)}/${date}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      refreshInterval: isToday ? 5 * 60_000 : 0,
    }
  );
  return data;
}

export default function DayPage({
  params,
}: {
  params: { region: string; city: string; date: string };
}) {
  const cityDecoded = decodeURIComponent(params.city);

  // Only today's date can still receive new ticks; past days are static.
  const isToday = params.date === new Date().toISOString().slice(0, 10);
  const key = `/api/day/${encodeURIComponent(cityDecoded)}/${params.date}`;

  const { data, isLoading, mutate } = useSWR<DayResponse>(key, fetcher, {
    // Backstop only — the real trigger is the SSE stream below.
    refreshInterval: isToday ? 5 * 60_000 : 0,
  });

  // City-level stats (avg ticks/day + full dates list) — static.
  const { data: cityStats } = useSWR<CityStats>(
    `/api/dates/${encodeURIComponent(cityDecoded)}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  // Polymarket price histories — loaded after tick data arrives.
  const { data: priceHistoryData } = useSWR<PriceHistoryResponse>(
    data
      ? `/api/prices-history/${encodeURIComponent(cityDecoded)}/${params.date}`
      : null,
    fetcher,
    { refreshInterval: isToday ? 5 * 60_000 : 0, revalidateOnFocus: false }
  );

  // Refetch the instant a new tick for this exact city/date lands.
  useWeatherStream((evt) => {
    if (isToday && evt.city === cityDecoded.toLowerCase() && evt.local_date === params.date) {
      mutate();
    }
  });

  // ── Date picker ────────────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen]);

  useEffect(() => {
    if (pickerOpen && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [pickerOpen]);

  // ── Compare days ───────────────────────────────────────────────────────────
  // Each entry keeps its color, so the color does not change when another day is removed.
  const [compare, setCompare] = useState<{ date: string; color: string }[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const compareRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!compareOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (compareRef.current && !compareRef.current.contains(e.target as Node)) {
        setCompareOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [compareOpen]);

  // One hook call for each possible slot. The number must equal MAX_COMPARE (3).
  const cmp0 = useCompareDay(cityDecoded, compare[0]?.date);
  const cmp1 = useCompareDay(cityDecoded, compare[1]?.date);
  const cmp2 = useCompareDay(cityDecoded, compare[2]?.date);

  const otherDates = (cityStats?.dates ?? []).filter((d) => d !== params.date);

  function toggleCompare(date: string) {
    setCompare((prev) => {
      if (prev.some((p) => p.date === date)) return prev.filter((p) => p.date !== date);
      if (prev.length >= MAX_COMPARE) return prev;
      const used = new Set(prev.map((p) => p.color));
      const color = COMPARE_COLORS.find((c) => !used.has(c)) ?? COMPARE_COLORS[0];
      return [...prev, { date, color }];
    });
  }

  const compareDays = useMemo<CompareDay[]>(() => {
    const loaded = [cmp0, cmp1, cmp2];
    const out: CompareDay[] = [];
    compare.forEach((c, i) => {
      const d = loaded[i];
      if (!d) return; // still loading
      out.push({
        date: c.date,
        color: c.color,
        ticks: d.ticks ?? [],
        reciprocalTicks: d.reciprocalTicks ?? [],
        winningLow: d.winningLow,
        winningHigh: d.winningHigh,
        winningBracket: d.winningBracket,
      });
    });
    return out;
  }, [compare, cmp0, cmp1, cmp2]);

  // ── Window stats ───────────────────────────────────────────────────────────
  const windowStats = useMemo(() => {
    if (!data?.ticks?.length) return null;

    // Anchor to the latest paced_at in the dataset, not Date.now().
    const anchor = Math.max(
      ...data.ticks.map((t) => t.paced_at ?? 0),
      ...(data.reciprocalTicks ?? []).map((t) => t.paced_at ?? 0)
    );

    const windows = [
      { label: "1h", ms: 60 * 60_000 },
      { label: "2h", ms: 2 * 60 * 60_000 },
      { label: "4h", ms: 4 * 60 * 60_000 },
    ];

    return windows.map(({ label, ms }) => {
      const cutoff = anchor - ms;
      const linear = data.ticks.filter((t) => (t.paced_at ?? 0) >= cutoff);
      const reciprocal = (data.reciprocalTicks ?? []).filter((t) => (t.paced_at ?? 0) >= cutoff);

      const linearAvg = avg(linear.map((t) => t.weighted_avg));
      const reciprocalAvg = avg(reciprocal.map((t) => t.weighted_avg));

      // Derive brackets independently from each collection's window average.
      const linearBracket =
        linearAvg != null ? fallbackBracketLabel(linearAvg, data.unit) : null;
      const recBracket =
        reciprocalAvg != null ? fallbackBracketLabel(reciprocalAvg, data.unit) : null;

      // Yes price: most recent tick whose bracket matches the window bracket.
      const matchingLinearTick = [...linear]
        .reverse()
        .find((t) => t.point_bracket === linearBracket);
      const lastYesPriceLinear =
        matchingLinearTick?.yes_price ?? linear.at(-1)?.yes_price ?? null;

      const matchingRecTick = [...reciprocal]
        .reverse()
        .find((t) => t.point_bracket === recBracket);
      const lastYesPriceRec = matchingRecTick?.yes_price ?? reciprocal.at(-1)?.yes_price ?? null;

      return {
        label,
        linearAvg,
        linearBracket,
        lastYesPriceLinear,
        reciprocalAvg,
        recBracket,
        lastYesPriceRec,
        tickCount: linear.length,
      };
    });
  }, [data?.ticks, data?.reciprocalTicks]);

  const hasTicks = !!data && data.ticks.length > 0;
  const reciprocalTicks = data?.reciprocalTicks ?? NO_TICKS;
  // The price section shows when either collection has ticks.
  const hasPriceTicks = !!data && (data.ticks.length > 0 || reciprocalTicks.length > 0);
  const brackets = priceHistoryData?.brackets ?? [];
  const tzOffsetMs = priceHistoryData?.tzOffsetMs ?? 0;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="min-w-0 space-y-4">
        {/* ── Row 1: forecast chart + window stats ─────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]">
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <nav className="text-sm text-[#8b92a0]">
                <Link href="/" className="hover:text-white">
                  Regions
                </Link>{" "}
                /{" "}
                <Link href={`/${params.region}`} className="capitalize hover:text-white">
                  {params.region}
                </Link>{" "}
                /{" "}
                <Link
                  href={`/${params.region}/${encodeURIComponent(cityDecoded)}`}
                  className="font-medium capitalize text-white"
                >
                  {cityDecoded}
                </Link>
              </nav>

              <div className="flex items-center gap-2 text-sm text-[#8b92a0]">
                <CloudIcon width={16} height={16} />
                <span>Forecast temp over the day</span>
                <span title="Weighted-average forecast temperature at each tick, linear vs reciprocal weighting. The green band is the winning bucket.">
                  <InfoIcon width={15} height={15} />
                </span>
              </div>
            </div>

            <h1 className="mt-4 flex items-center gap-3 text-[28px] font-semibold capitalize leading-none text-white">
              <PinIcon width={24} height={24} className="text-[#8b92a0]" />
              {cityDecoded}
            </h1>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[#8b92a0]">
              {cityStats?.avgTicksPerDay != null && (
                <span>
                  avg{" "}
                  <span className="font-semibold" style={{ color: C.cyan }}>
                    {cityStats.avgTicksPerDay.toFixed(1)}
                  </span>{" "}
                  ticks/day ({cityStats.totalDays}d)
                </span>
              )}

              {/* Date picker */}
              <div className="relative" ref={pickerRef}>
                <button
                  onClick={() => setPickerOpen((v) => !v)}
                  className="flex cursor-pointer items-center gap-2 rounded-full border border-[#1f2838] px-3 py-1 text-xs text-[#c9d0dc] transition-colors hover:border-[#2c374b]"
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                >
                  {isToday && (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: C.green }}
                      title="Updating live"
                    />
                  )}
                  {params.date}
                </button>

                {pickerOpen && (
                  <div
                    role="listbox"
                    className="absolute left-0 top-full z-50 mt-2 max-h-64 min-w-[9rem] overflow-y-auto rounded-xl border border-[#151c2b] bg-[#0a0f1a] shadow-2xl"
                  >
                    {(cityStats?.dates ?? []).length === 0 && (
                      <div className="px-3 py-2 text-sm text-[#8b92a0]">No dates</div>
                    )}
                    {(cityStats?.dates ?? []).map((d) => {
                      const isActive = d === params.date;
                      return (
                        <Link
                          key={d}
                          href={`/${params.region}/${encodeURIComponent(cityDecoded)}/${d}`}
                          role="option"
                          aria-selected={isActive}
                          ref={isActive ? activeItemRef : undefined}
                          onClick={() => setPickerOpen(false)}
                          className={[
                            "block px-3 py-1.5 text-sm transition-colors",
                            isActive
                              ? "bg-[#111a2a] font-semibold text-[#22bff0]"
                              : "text-[#c9d0dc] hover:bg-[#111a2a]",
                          ].join(" ")}
                        >
                          {d}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Compare picker */}
              <div className="relative" ref={compareRef}>
                <button
                  onClick={() => setCompareOpen((v) => !v)}
                  className="flex cursor-pointer items-center gap-2 rounded-full border border-[#1f2838] px-3 py-1 text-xs text-[#c9d0dc] transition-colors hover:border-[#2c374b]"
                  aria-haspopup="listbox"
                  aria-expanded={compareOpen}
                >
                  Compare{compare.length > 0 ? ` (${compare.length})` : ""}
                </button>

                {compareOpen && (
                  <div
                    role="listbox"
                    aria-multiselectable="true"
                    className="absolute left-0 top-full z-50 mt-2 max-h-64 min-w-[11rem] overflow-y-auto rounded-xl border border-[#151c2b] bg-[#0a0f1a] shadow-2xl"
                  >
                    {otherDates.length === 0 && (
                      <div className="px-3 py-2 text-sm text-[#8b92a0]">No other dates</div>
                    )}
                    {otherDates.map((d) => {
                      const picked = compare.find((c) => c.date === d);
                      const full = !picked && compare.length >= MAX_COMPARE;
                      return (
                        <button
                          key={d}
                          type="button"
                          role="option"
                          aria-selected={!!picked}
                          disabled={full}
                          onClick={() => toggleCompare(d)}
                          className={[
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                            picked ? "bg-[#111a2a] text-white" : "text-[#c9d0dc] hover:bg-[#111a2a]",
                            full ? "cursor-not-allowed opacity-40" : "cursor-pointer",
                          ].join(" ")}
                        >
                          <span
                            className="h-2 w-2 rounded-full border border-[#2c374b]"
                            style={picked ? { background: picked.color, borderColor: picked.color } : undefined}
                          />
                          {d}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4">
              {isLoading && <div className="text-[#8b92a0]">Loading…</div>}
              {data && !hasTicks && (
                <div className="text-[#8b92a0]">No ticks recorded for this city/date.</div>
              )}
              {data && hasTicks && (
                <TempChart
                  ticks={data.ticks}
                  reciprocalTicks={data.reciprocalTicks ?? []}
                  unit={data.unit}
                  city={cityDecoded}
                  winningLow={data.winningLow}
                  winningHigh={data.winningHigh}
                  winningBracket={data.winningBracket}
                  compareDays={compareDays}
                  onRemoveCompare={toggleCompare}
                />
              )}
            </div>
          </Card>

          <Card className="overflow-x-auto p-4">
            {data && hasTicks && (
              <StatsTable
                ticks={data.ticks}
                reciprocalTicks={data.reciprocalTicks ?? []}
                unit={data.unit}
                windowStats={windowStats ?? undefined}
                compareDays={compareDays}
              />
            )}
          </Card>
        </div>

        {/* ── Row 2: market price + latest updates ─────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2.35fr)_minmax(0,1fr)]">
          <Card className="p-5">
            <h2 className="mb-4 flex items-center gap-3 text-base font-semibold text-white">
              <BarChartIcon width={22} height={22} className="text-[#3b8bf5]" />
              Market price over the day
            </h2>
            {data && hasPriceTicks && (
              <>
                {/* When brackets is empty, PriceChart renders the Yes-price chart. */}
                {brackets.length > 0 ? (
                  <>
                    <div>
                      <div className="mb-2 text-sm text-[#8b92a0]">
                        Yes price of the forecast bracket (linear vs reciprocal)
                      </div>
                      <YesPriceChart ticks={data.ticks} reciprocalTicks={reciprocalTicks} />
                    </div>
                    <div className="mt-5 border-t border-[#151c2b] pt-4">
                      <div className="mb-2 text-sm text-[#8b92a0]">Polymarket price by bracket</div>
                      <PriceChart
                        ticks={data.ticks}
                        reciprocalTicks={reciprocalTicks}
                        bracketHistories={brackets}
                        tzOffsetMs={tzOffsetMs}
                      />
                    </div>
                  </>
                ) : (
                  <PriceChart
                    ticks={data.ticks}
                    reciprocalTicks={reciprocalTicks}
                    bracketHistories={brackets}
                    tzOffsetMs={tzOffsetMs}
                  />
                )}
              </>
            )}
          </Card>

          <Card className="p-5">
            {brackets.length > 0 ? (
              <LatestUpdates bracketHistories={brackets} tzOffsetMs={tzOffsetMs} />
            ) : (
              <div className="text-sm text-[#8b92a0]">No price updates yet.</div>
            )}
          </Card>
        </div>
      </div>

      <LocalTimesPanel />
    </div>
  );
}
